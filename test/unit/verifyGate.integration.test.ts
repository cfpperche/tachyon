import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeManager } from "../../src/worktree/WorktreeManager.js";
import { RunbookRunner } from "../../src/commands/RunbookRunner.js";
import { verifySteps, verifyStale, type VerifyState } from "../../src/worktree/verify.js";
import { TmuxService, isolatedArgs, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

/**
 * spec 214 (C3) — LIVE smoke of the verify-gate EXECUTION path against REAL git + REAL tmux
 * (skipped when tmux is absent, like tmux.real.test.ts). This is the headless equivalent of
 * Task 9: it drives the exact composition Workspace.runVerify uses — verifySteps() →
 * RunbookRunner.runSteps(`_verify-<agent>`, steps, worktreePath) — so a real command runs INSIDE
 * a real git worktree and the recorded VerifyState + staleness are exercised end-to-end. The only
 * parts NOT covered here are the VS Code badge pixels and the MCP transport (E2E in bridge.test).
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", env: tmuxChildEnv() });
    return true;
  } catch {
    return false;
  }
}

const SOCKET = `tachyon-verify-${process.pid}`;

function realExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", isolatedArgs(args), { encoding: "utf8", env: tmuxChildEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

function killSocket(name: string): void {
  try {
    execFileSync("tmux", ["-L", name, "kill-server"], { stdio: "pipe", env: tmuxChildEnv() });
  } catch {
    /* already gone */
  }
  const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0 ? process.env.TMUX_TMPDIR : "/tmp";
  try {
    fs.rmSync(path.join(base, `tmux-${process.getuid?.() ?? 0}`, name), { force: true });
  } catch {
    /* already gone */
  }
}

const verifyLabel = (agent: string): string => `_verify-${agent}`; // mirrors Workspace.VERIFY_LABEL_PREFIX

describe.skipIf(!tmuxAvailable())("verify-gate live smoke — real git worktree + real tmux (spec 214)", () => {
  const dirs: string[] = [];
  let repo: string;
  let base: string;
  let wtMgr: WorktreeManager;
  let tmux: TmuxService;

  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

  // commands: `ok` passes, `bad` fails; `mark` proves cwd+env threading (the #4 review fix).
  const config = {
    commands: {
      ok: { cmd: "true" },
      bad: { cmd: "false" },
      mark: { cmd: `sh -c 'printf "%s|%s" "$PWD" "$VFLAG" > vmark.txt'`, env: { VFLAG: "envok" } },
    },
    runbooks: { ship: { steps: ["ok", "ok"] } },
  } as unknown as TachyonConfig;

  const runner = () =>
    new RunbookRunner({ tmux, wsHash: "vh", workspaceRoot: repo, getConfig: () => config, stepPollMs: 100 });

  // The exact composition Workspace.runVerify performs (minus the vscode toast/ledger I/O).
  async function runVerify(agent: string, wtPath: string, verify: string): Promise<VerifyState> {
    const { headRef } = await wtMgr.headState(wtPath);
    const steps = verifySteps(verify, config.commands, config.runbooks);
    const job = await runner().runSteps(verifyLabel(agent), steps, wtPath);
    return { command: verify, passed: job.outcome === "passed", atCommit: headRef, ranAt: "t" };
  }

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "vg-repo-"));
    base = fs.mkdtempSync(path.join(os.tmpdir(), "vg-base-"));
    dirs.push(repo, base);
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.dev"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
    tmux = new TmuxService(realExecutor, SOCKET);
    await tmux.newSession({ name: "tachyon-keepalive", cmd: "sh" }); // keep the server alive between runs
    wtMgr = new WorktreeManager({ workspaceRoot: repo, wsHash: "vh", getSettings: () => ({ worktree: { base } }) });
  });

  afterAll(() => {
    killSocket(SOCKET);
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("PASS: a passing gate runs in the worktree → passed, fresh (not stale)", async () => {
    const { record } = await wtMgr.ensure({ agent: "passer", branch: "tachyon/passer" });
    const state = await runVerify("passer", record.path, "ok");
    expect(state.passed).toBe(true);
    expect(state.atCommit).toMatch(/^[0-9a-f]{40}$/);
    const { headRef, dirty } = await wtMgr.headState(record.path);
    expect(verifyStale(state, headRef, dirty)).toBe(false); // clean + same commit → fresh
  });

  it("FAIL: a failing gate → not passed", async () => {
    const { record } = await wtMgr.ensure({ agent: "failer", branch: "tachyon/failer" });
    const state = await runVerify("failer", record.path, "bad");
    expect(state.passed).toBe(false);
  });

  it("a referenced command's cwd (the worktree) + env reach the real process (#4 fix)", async () => {
    const { record } = await wtMgr.ensure({ agent: "marker", branch: "tachyon/marker" });
    const state = await runVerify("marker", record.path, "mark");
    expect(state.passed).toBe(true);
    const written = fs.readFileSync(path.join(record.path, "vmark.txt"), "utf8");
    expect(written).toBe(`${record.path}|envok`); // PWD == the worktree, env VFLAG delivered
  });

  it("STALE: committing in the worktree after a green moves HEAD past the verified commit", async () => {
    const { record } = await wtMgr.ensure({ agent: "stale", branch: "tachyon/stale" });
    const state = await runVerify("stale", record.path, "ok");
    expect(state.passed).toBe(true);
    // a real commit advances HEAD → the recorded verdict is now stale
    fs.writeFileSync(path.join(record.path, "more.txt"), "x\n");
    git(["add", "-A"], record.path);
    git(["commit", "-m", "more work"], record.path);
    const { headRef, dirty } = await wtMgr.headState(record.path);
    expect(headRef).not.toBe(state.atCommit);
    expect(verifyStale(state, headRef, dirty)).toBe(true);
  });

  it("a runbook-name gate runs all its steps in the worktree", async () => {
    const { record } = await wtMgr.ensure({ agent: "rb", branch: "tachyon/rb" });
    const state = await runVerify("rb", record.path, "ship"); // ship = [ok, ok]
    expect(state.passed).toBe(true);
    expect(verifySteps("ship", config.commands, config.runbooks)).toEqual(["ok", "ok"]); // runbook expanded
  });
});
