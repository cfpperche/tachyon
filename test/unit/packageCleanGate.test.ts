import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let assertPackageTreeClean: (cwd?: string) => void;
let assertStableBuildSource: (cwd?: string) => { channel: string; commit: string; treeSha: string };
let assertStableEngineManifest: (manifest: unknown, source: { commit: string; treeSha: string }) => unknown;
let resolveEngineReleaseChannel: (env?: NodeJS.ProcessEnv) => string;

beforeAll(async () => {
  ({ assertPackageTreeClean } = await import("../../scripts/package-clean-gate.mjs"));
  // @ts-expect-error -- owned ESM script intentionally has no CommonJS declaration file.
  ({ assertStableBuildSource, assertStableEngineManifest, resolveEngineReleaseChannel } = await import("../../scripts/engine-release-channel.mjs"));
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-package-clean-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "package-gate@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Package Gate"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), "*.vsix\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
  return root;
}

describe("package clean gate", () => {
  it("accepts a clean tree and ignores only declared package outputs", () => {
    const root = repository();
    expect(() => assertPackageTreeClean(root)).not.toThrow();

    fs.writeFileSync(path.join(root, "candidate.vsix"), "artifact");
    expect(() => assertPackageTreeClean(root)).not.toThrow();
  });

  it("refuses untracked source files", () => {
    const root = repository();
    fs.writeFileSync(path.join(root, "new-source.ts"), "export {};\n");

    expect(() => assertPackageTreeClean(root)).toThrow(/dirty source tree[\s\S]*new-source\.ts/);
  });

  it("refuses tracked changes before a VSIX can be produced", () => {
    const root = repository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty\n");

    expect(() => assertPackageTreeClean(root)).toThrow(/dirty source tree[\s\S]*tracked\.txt/);
  });

  it("fails closed when git cannot verify the source tree", () => {
    const missing = path.join(os.tmpdir(), `tachyon-missing-${process.pid}-${Date.now()}`);
    expect(() => assertPackageTreeClean(missing)).toThrow(/source tree could not be verified/);
  });

  it("defaults ordinary builds to dev and refuses unknown channel labels", () => {
    expect(resolveEngineReleaseChannel({})).toBe("dev");
    expect(resolveEngineReleaseChannel({ TACHYON_ENGINE_CHANNEL: "stable" })).toBe("stable");
    expect(() => resolveEngineReleaseChannel({ TACHYON_ENGINE_CHANNEL: "candidate" })).toThrow(/stable or dev/);
  });

  it("accepts stable only at exact clean primary main", () => {
    const root = repository();
    const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const expectedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    expect(assertStableBuildSource(root)).toMatchObject({
      channel: "stable",
      commit: expectedCommit,
      treeSha: expectedTree,
    });
  });

  it("refuses stable on a feature branch or when cached origin/main differs", () => {
    const branchRoot = repository();
    execFileSync("git", ["switch", "-qc", "feature"], { cwd: branchRoot });
    expect(() => assertStableBuildSource(branchRoot)).toThrow(/branch 'feature'.*requires main/);

    const driftRoot = repository();
    fs.writeFileSync(path.join(driftRoot, "tracked.txt"), "new main\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: driftRoot });
    execFileSync("git", ["commit", "-qm", "local main ahead"], { cwd: driftRoot });
    expect(() => assertStableBuildSource(driftRoot)).toThrow(/HEAD, local main, and cached origin\/main differ/);
  });

  it("refuses stable from a linked worktree even at the main commit", () => {
    const root = repository();
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-package-linked-"));
    fs.rmSync(linked, { recursive: true, force: true });
    roots.push(linked);
    execFileSync("git", ["worktree", "add", "-q", "--detach", linked, "main"], { cwd: root });
    expect(() => assertStableBuildSource(linked)).toThrow(/linked worktree/);
  });

  it("packages only an exact stable manifest from the gated source", () => {
    const source = { commit: "a".repeat(40), treeSha: "b".repeat(40) };
    const exact = { channel: "stable", build: source };
    expect(assertStableEngineManifest(exact, source)).toBe(exact);
    expect(() => assertStableEngineManifest({ ...exact, channel: "dev" }, source)).toThrow(/requires stable/);
    expect(() => assertStableEngineManifest({ build: source }, source)).toThrow(/requires stable/);
    expect(() => assertStableEngineManifest(
      { channel: "stable", build: { ...source, treeSha: "c".repeat(40) } },
      source,
    )).toThrow(/stale engine manifest/);
  });
});
