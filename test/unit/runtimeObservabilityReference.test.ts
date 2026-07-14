import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/runtime-observability-reference.mjs");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Tachyon Test",
  GIT_AUTHOR_EMAIL: "tachyon@example.invalid",
  GIT_COMMITTER_NAME: "Tachyon Test",
  GIT_COMMITTER_EMAIL: "tachyon@example.invalid",
};

interface RadarFixture {
  workspace: string;
  upstream: string;
  manifest: string;
  baseline: string;
}

let root = "";
let fixture: RadarFixture;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

function write(rootPath: string, relative: string, contents: string): void {
  const target = path.join(rootPath, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function buildFixture(): RadarFixture {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-observability-radar-"));
  const workspace = path.join(root, "workspace");
  const upstream = path.join(root, "codexbar");
  fs.mkdirSync(workspace);
  fs.mkdirSync(upstream);
  git(workspace, ["init", "-q"]);
  git(upstream, ["init", "-q"]);
  git(upstream, ["remote", "add", "origin", "https://github.com/steipete/CodexBar.git"]);

  const watchedPath = "Sources/CodexBarCore/Providers/Codex/quota.json";
  write(upstream, watchedPath, "{\"usedPercent\":25}\n");
  git(upstream, ["add", watchedPath]);
  git(upstream, ["commit", "-qm", "baseline"]);
  git(upstream, ["tag", "-a", "v0.43.0", "-m", "baseline"]);
  const baseline = git(upstream, ["rev-parse", "v0.43.0^{commit}"]);
  const annotatedTagObject = git(upstream, ["rev-parse", "refs/tags/v0.43.0"]);

  const fixturePath = "test/fixtures/runtime-observability-reference.json";
  const fixtureContents = "{\"synthetic\":true}\n";
  write(workspace, fixturePath, fixtureContents);
  const sha256 = crypto.createHash("sha256").update(fixtureContents).digest("hex");
  const manifestPath = "docs/research/runtime-observability-reference.json";
  write(workspace, manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    purpose: "development-reference-only",
    productionDependency: false,
    upstream: {
      repository: "https://github.com/steipete/CodexBar",
      tag: "v0.43.0",
      annotatedTagObject,
      commit: baseline,
      license: "MIT",
    },
    providers: ["codex", "claude"],
    fixturePins: [{ path: fixturePath, sha256 }],
    watchedPaths: [watchedPath],
  }, null, 2)}\n`);

  write(upstream, watchedPath, "{\"usedPercent\":50}\n");
  git(upstream, ["add", watchedPath]);
  git(upstream, ["commit", "-qm", "candidate"]);
  return { workspace, upstream, manifest: manifestPath, baseline };
}

function run(args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: gitEnv,
    timeout: 10_000,
  });
}

beforeEach(() => {
  fixture = buildFixture();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("RuntimeObservability upstream reference radar", () => {
  it("validates the pinned non-shipping manifest and fixtures without requiring an upstream checkout", () => {
    const result = run(["--manifest", fixture.manifest]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("runtime-observability reference OK: v0.43.0");
    expect(result.stdout).toContain("No upstream checkout inspected");
  });

  it("reports a clean baseline and flags watched provider changes", () => {
    const clean = run([
      "--manifest", fixture.manifest,
      "--repo", fixture.upstream,
      "--candidate", fixture.baseline,
    ]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("runtime-observability radar clean");

    const changed = run(["--manifest", fixture.manifest, "--repo", fixture.upstream]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("1 relevant upstream path(s) changed");
    expect(changed.stderr).toContain("Sources/CodexBarCore/Providers/Codex/quota.json");
  });

  it("fails closed when a pinned fixture changes or a candidate ref is unsafe", () => {
    write(fixture.workspace, "test/fixtures/runtime-observability-reference.json", "{\"synthetic\":false}\n");
    const tampered = run(["--manifest", fixture.manifest]);
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toContain("fixture hash mismatch");

    write(fixture.workspace, "test/fixtures/runtime-observability-reference.json", "{\"synthetic\":true}\n");
    const unsafeRef = run([
      "--manifest", fixture.manifest,
      "--repo", fixture.upstream,
      "--candidate", "HEAD..origin/main",
    ]);
    expect(unsafeRef.status).toBe(2);
    expect(unsafeRef.stderr).toContain("candidate must be a bounded git ref");
  });

  it("rejects a watched path that does not exist in the pinned baseline", () => {
    const manifestPath = path.join(fixture.workspace, fixture.manifest);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.watchedPaths = ["Sources/CodexBarCore/Providers/Claude/missing.json"];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(["--manifest", fixture.manifest, "--repo", fixture.upstream]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unable to inspect watched baseline path");
  });

  it("rejects fixture paths that escape the workspace through a symlinked parent", () => {
    const external = path.join(root, "external");
    write(external, "pin.json", "{\"outside\":true}\n");
    fs.mkdirSync(path.join(fixture.workspace, "test"), { recursive: true });
    fs.symlinkSync(external, path.join(fixture.workspace, "test", "escaped"), "dir");

    const manifestPath = path.join(fixture.workspace, fixture.manifest);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.fixturePins = [{
      path: "test/escaped/pin.json",
      sha256: crypto.createHash("sha256").update("{\"outside\":true}\n").digest("hex"),
    }];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = run(["--manifest", fixture.manifest]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("fixture path escapes the workspace through a symlink");
  });
});
