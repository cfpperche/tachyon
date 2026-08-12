import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadPlugin, previewInstall, applyInstall, applyContribution } from "../../src/plugins/engine.js";
import { gatherGitHookState } from "../../src/plugins/gitHookState.js";
import { GitHookStore } from "../../src/plugins/gitHookRegistry.js";

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(prefix = "tachyon-ghcommit-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
  fs.writeFileSync(path.join(dir, "seed"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
  return dir;
}

/** A git-hook plugin whose pre-commit leaf records its name to $GH_MARKER then exits `code`. */
function makePlugin(name: string, code: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-plugin-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "gh", runtimes: ["claude"], gitHooks: { "pre-commit": { leaf: "githooks/h.sh" } } }));
  fs.mkdirSync(path.join(dir, "githooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "githooks/h.sh"), `#!/bin/sh\n[ -n "\${GH_MARKER:-}" ] && printf '%s\\n' "${name}" >> "$GH_MARKER"\nexit ${code}\n`);
  return dir;
}

async function install(ws: string, pluginDir: string) {
  const { plugin } = loadPlugin(pluginDir);
  const target = new Set(plugin!.manifest.runtimes);
  const gitState = await gatherGitHookState(ws, plugin!.gitHooks.map((g) => g.event));
  const result = await applyInstall(plugin!, previewInstall(plugin!, ws, target, gitState), ws, target, { mcpConfirmed: true, gitHookConfirmed: true });
  if (result.installed) for (const hook of plugin!.gitHooks) await applyContribution(plugin!.manifest.name, { kind: "git-hook", name: hook.event }, ws);
  return result;
}

/** Stage a unique change and attempt a commit; return {ok, marker lines}. */
function commit(ws: string, opts: { noVerify?: boolean; marker?: string } = {}): { ok: boolean; marks: string[] } {
  const f = path.join(ws, `f-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, "data\n");
  execFileSync("git", ["add", "-A"], { cwd: ws, env: ENV });
  const args = ["commit", "-qm", "change", ...(opts.noVerify ? ["--no-verify"] : [])];
  const env = { ...ENV, ...(opts.marker ? { GH_MARKER: opts.marker } : {}) };
  try {
    execFileSync("git", args, { cwd: ws, env, stdio: "ignore" });
    return { ok: true, marks: marks(opts.marker) };
  } catch {
    return { ok: false, marks: marks(opts.marker) };
  }
}
const marks = (m?: string) => (m && fs.existsSync(m) ? fs.readFileSync(m, "utf8").split("\n").filter(Boolean) : []);

describe.skipIf(!gitOk())("git-hook — live git commit (spec 264 task 10)", () => {
  it("a passing leaf lets the commit through and runs; a blocking leaf aborts it", async () => {
    const ok = makeRepo();
    await install(ok, makePlugin("pass", 0));
    const r1 = commit(ok, { marker: path.join(ok, "m1") });
    expect(r1.ok).toBe(true);
    expect(r1.marks).toEqual(["pass"]); // the leaf actually ran on commit

    const blk = makeRepo();
    await install(blk, makePlugin("block", 1));
    expect(commit(blk).ok).toBe(false); // non-zero leaf blocks the commit
  });

  it("chains a pre-existing prior hook (both run), and --no-verify bypasses the gate", async () => {
    const ws = makeRepo();
    fs.writeFileSync(path.join(ws, ".git/hooks/pre-commit"), `#!/bin/sh\n[ -n "\${GH_MARKER:-}" ] && printf 'prior\\n' >> "$GH_MARKER"\nexit 0\n`, { mode: 0o755 });
    await install(ws, makePlugin("leaf", 0));
    const r = commit(ws, { marker: path.join(ws, "m") });
    expect(r.ok).toBe(true);
    expect(r.marks).toEqual(["prior", "leaf"]); // prior user hook first, then the plugin leaf

    // a blocking plugin is bypassed by --no-verify (documented as a user bypass, not prevented)
    const ws2 = makeRepo();
    await install(ws2, makePlugin("block", 1));
    expect(commit(ws2).ok).toBe(false);
    expect(commit(ws2, { noVerify: true }).ok).toBe(true);
  });

  it("two plugins both run on a single commit (run-all)", async () => {
    const ws = makeRepo();
    await install(ws, makePlugin("aaa", 0));
    await install(ws, makePlugin("bbb", 0));
    const r = commit(ws, { marker: path.join(ws, "m") });
    expect(r.ok).toBe(true);
    expect(r.marks.sort()).toEqual(["aaa", "bbb"]);
  });

  it("works when the repo path contains a space", async () => {
    const ws = makeRepo("tachyon gh commit ");
    await install(ws, makePlugin("pass", 0));
    expect(commit(ws, { marker: path.join(ws, "m") }).ok).toBe(true);
  });

  it("fail-closed: a tampered execution manifest blocks the commit", async () => {
    const ws = makeRepo();
    await install(ws, makePlugin("pass", 0));
    fs.appendFileSync(path.join(new GitHookStore(ws).dir(), "pre-commit.run"), "leaves/injected\n"); // break integrity
    expect(commit(ws).ok).toBe(false);
  });
});
