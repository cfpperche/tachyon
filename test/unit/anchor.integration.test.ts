import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TmuxService, isolatedArgs, socketPath, type ExecResult } from "../../src/tmux/TmuxService.js";
import { buildRoleDoc, roleReminder } from "../../src/roles/templates.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

/**
 * spec 216 (Part C) — live smoke of the re-anchor INJECT path against real tmux: write the
 * durable role doc, type the reminder into the pane (sendKeys), and confirm it lands. Mirrors
 * what Workspace.reanchor does, minus the VS Code shell. Skipped when tmux is absent.
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", env: tmuxChildEnv() });
    return true;
  } catch {
    return false;
  }
}

const SOCKET = `tachyon-anchor-${process.pid}`;
function realExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", isolatedArgs(args), { encoding: "utf8", env: tmuxChildEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve({ stdout, stderr });
    });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const run = tmuxAvailable() ? describe : describe.skip;

run("re-anchor inject — real tmux (spec 216)", () => {
  const tmux = new TmuxService(realExecutor, SOCKET);
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-anchor-"));
  });
  afterAll(async () => {
    // MUST scope kill-server to the isolated test socket. A bare `kill-server` (no -L) targets the
    // server $TMUX points at — which, when tests run from inside a Tachyon pane, is the PRODUCTION
    // `-L tachyon` server, killing the user's live agents (codex contamination audit, 2026-06-15).
    try { await realExecutor(["-L", SOCKET, "kill-server"]); } catch { /* already gone */ }
    try { fs.rmSync(socketPath(SOCKET), { force: true }); } catch { /* socket already gone */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes .tachyon/roles/<agent>.md and types the reminder into the pane", async () => {
    const agent = "rev";
    const session = `t-${agent}`;
    await tmux.newSession({ name: session, cmd: "cat", cwd: dir }); // `cat` echoes typed input back

    // mirror Workspace.reanchor: write the durable doc, then inject the reminder
    const rel = path.join(".tachyon", "roles", `${agent}.md`);
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buildRoleDoc(agent, "reviewer", "focus on the parser"), "utf8");
    const reminder = roleReminder("reviewer", rel);
    await tmux.sendKeys(session, reminder, true);
    await sleep(300);

    // the doc exists with the contract
    expect(fs.readFileSync(abs, "utf8")).toMatch(/review for quality/);
    // the reminder text reached the pane (cat echoed it)
    const pane = await tmux.capturePane(session);
    expect(pane).toContain("Re-anchor");
    expect(pane).toContain(rel);

    await tmux.killSession(session);
  });
});
