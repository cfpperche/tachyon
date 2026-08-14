import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
import { loadPlugin, previewInstall, applyInstall, applyContribution } from "../../apps/vscode-extension/src/plugins/engine.js";
import { gatherGitHookState } from "../../apps/vscode-extension/src/plugins/gitHookState.js";
import { gatherToolPlan } from "../../apps/vscode-extension/src/plugins/toolPlan.js";
import { resolveHostPlatform } from "../../apps/vscode-extension/src/plugins/toolPlatform.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

function gitOk(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const kp = tlsKeypair();
const host = resolveHostPlatform();
const HOST_KEY = host.ok ? host.keys[0] : null;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// the provisioned "guard" tool: answers --version (smoke), else blocks a commit whose staged diff has BLOCKME.
const GUARD = Buffer.from('#!/bin/sh\nif [ "$1" = "--version" ]; then echo "guard 1.0.0"; exit 0; fi\nif git diff --cached -U0 | grep -q BLOCKME; then echo "blocked" >&2; exit 1; fi\nexit 0\n');
const GUARD_SHA = sha(GUARD);

describe.skipIf(!gitOk() || !kp || !HOST_KEY)("CAPSTONE — provisioned tool drives a real git pre-commit hook (spec 265)", () => {
  let server: https.Server;
  let base: string;
  let bundle: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = https.createServer({ key: kp!.key, cert: kp!.cert }, (_req, res) => {
      res.writeHead(200);
      res.end(GUARD);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    bundle = path.join(os.tmpdir(), `tach-capstone-${process.pid}.cjs`);
    esbuild.buildSync({ entryPoints: ["apps/vscode-extension/src/toolLauncherEntry.ts"], bundle: true, outfile: bundle, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(bundle, { force: true });
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-cap-ws-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
    fs.writeFileSync(path.join(dir, "seed"), "x\n");
    execFileSync("git", ["add", "seed"], { cwd: dir, env: ENV });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
    fs.writeFileSync(path.join(dir, ".gitignore"), ".tachyon/\n");
    return dir;
  }

  function makePlugin(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-cap-plug-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "tachyon-plugin.json"),
      JSON.stringify({
        name: "cg", version: "1.0.0", description: "commit guard",
        gitHooks: { "pre-commit": { argv: ["${tool:guard}"] } },
        tools: { guard: { version: "1.0.0", platforms: { [HOST_KEY as string]: { url: `${base}/guard`, sha256: GUARD_SHA } } } },
      }),
    );
    return dir;
  }

  async function install(ws: string, pluginDir: string) {
    const { plugin } = loadPlugin(pluginDir);
    const target = new Set(plugin!.manifest.runtimes);
    const gitState = await gatherGitHookState(ws, plugin!.gitHooks.map((g) => g.event));
    const toolPlan = await gatherToolPlan(plugin!);
    const preview = previewInstall(plugin!, ws, target, gitState, toolPlan);
    const result = await applyInstall(plugin!, preview, ws, target, { gitHookConfirmed: true, toolConfirmed: true, launcherBundlePath: bundle, toolTlsCa: kp!.cert });
    if (result.installed) await applyContribution(plugin!.manifest.name, { kind: "git-hook", name: "pre-commit" }, ws);
    return result;
  }

  function stageAndCommit(ws: string, fileContent: string): boolean {
    fs.writeFileSync(path.join(ws, `f-${crypto.randomBytes(3).toString("hex")}.txt`), fileContent);
    execFileSync("git", ["add", "-A"], { cwd: ws, env: ENV });
    try {
      execFileSync("git", ["commit", "-qm", "change"], { cwd: ws, env: ENV, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  it("installs, provisions the tool, and the git-hook runs it: clean commit passes, BLOCKME is rejected", async () => {
    const ws = makeRepo();
    const res = await install(ws, makePlugin());
    expect(res.errors).toEqual([]);
    expect(res.installed).toBe(true);

    // the provisioned guard binary is live + content-addressed
    expect(fs.existsSync(path.join(ws, ".tachyon/bin/guard", GUARD_SHA, "guard"))).toBe(true);

    // a clean commit: the hook runs the launcher -> guard -> allows.
    expect(stageAndCommit(ws, "clean data\n")).toBe(true);

    // a commit whose staged diff contains BLOCKME: guard exits non-zero -> the commit is rejected.
    expect(stageAndCommit(ws, "this has BLOCKME in it\n")).toBe(false);
  });
});
