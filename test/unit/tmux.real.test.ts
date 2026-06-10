import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";

/**
 * Integration against a REAL tmux server on a throwaway socket. Skipped when tmux
 * is absent (CI safety) — everywhere else this is the strongest validation we have
 * that the arg construction actually drives tmux correctly.
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const SOCKET = `tachyon-test-${process.pid}`;

function realExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!tmuxAvailable())("TmuxService against real tmux", () => {
  const tmux = new TmuxService(realExecutor, SOCKET);

  beforeAll(async () => {
    // Keepalive session: prevents the server from exit-empty-ing between tests
    // (kill-last-session -> server teardown -> next spawn races the shutdown).
    await tmux.newSession({ name: "tachyon-keepalive", cmd: "sh" });
  });

  afterAll(() => {
    try {
      execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "pipe" });
    } catch {
      // server already gone
    }
  });

  it("full session lifecycle: spawn, list, capture, send, kill", async () => {
    expect(await tmux.hasSession("tachyon-itest-shell")).toBe(false);

    await tmux.newSession({
      name: "tachyon-itest-shell",
      cmd: "sh",
      cwd: "/tmp",
      env: { TACHYON_TEST_VAR: "from-tachyon" },
    });
    expect(await tmux.hasSession("tachyon-itest-shell")).toBe(true);
    expect(await tmux.listSessions("tachyon-itest-")).toEqual(["tachyon-itest-shell"]);

    // -e env propagation + cwd
    await tmux.sendKeys("tachyon-itest-shell", 'echo "var=$TACHYON_TEST_VAR pwd=$(pwd)"', true);
    await sleep(300);
    const output = await tmux.capturePane("tachyon-itest-shell");
    expect(output).toContain("var=from-tachyon");
    expect(output).toContain("pwd=/tmp");

    // literal (-l) text must not be interpreted as keys/flags
    await tmux.sendKeys("tachyon-itest-shell", "echo -n 'C-m -l --'", true);
    await sleep(300);
    expect(await tmux.capturePane("tachyon-itest-shell")).toContain("C-m -l --");

    await tmux.killSession("tachyon-itest-shell");
    expect(await tmux.hasSession("tachyon-itest-shell")).toBe(false);
  });

  it("session survives with no client attached (the VSCode-restart persistence primitive)", async () => {
    await tmux.newSession({ name: "tachyon-itest-survivor", cmd: "sh" });
    await tmux.sendKeys("tachyon-itest-survivor", "MARKER=alive; echo started-$MARKER", true);
    await sleep(300);
    // No attach ever happened — the session runs headless and retains state.
    expect(await tmux.capturePane("tachyon-itest-survivor")).toContain("started-alive");
    await tmux.killSession("tachyon-itest-survivor");
  });

  it("a dying process leaves a dead pane with its exit code (remain-on-exit)", async () => {
    // The command exits immediately — the atomic start-server/set-option/new-session
    // invocation must still capture it as a dead pane, not a vanished session.
    await tmux.newSession({ name: "tachyon-itest-crasher", cmd: "sh -c 'exit 7'" });
    await sleep(400);
    expect(await tmux.hasSession("tachyon-itest-crasher")).toBe(true); // session survives
    const states = await tmux.sessionStates("tachyon-itest-");
    expect(states.get("tachyon-itest-crasher")).toEqual({ dead: true, exitCode: 7 });

    // postmortem pane is still readable, and dismiss works
    await tmux.capturePane("tachyon-itest-crasher");
    await tmux.killSession("tachyon-itest-crasher");
    expect(await tmux.hasSession("tachyon-itest-crasher")).toBe(false);
  });

  it("alive sessions report dead:false in sessionStates", async () => {
    await tmux.newSession({ name: "tachyon-itest-alive", cmd: "sh" });
    const states = await tmux.sessionStates("tachyon-itest-");
    expect(states.get("tachyon-itest-alive")).toEqual({ dead: false, exitCode: undefined });
    await tmux.killSession("tachyon-itest-alive");
  });

  it("capture with scrollback reach (-S) returns history beyond the visible pane", async () => {
    await tmux.newSession({ name: "tachyon-itest-scroll", cmd: "sh" });
    await tmux.sendKeys("tachyon-itest-scroll", "i=1; while [ $i -le 100 ]; do echo line-$i; i=$((i+1)); done", true);
    await sleep(1000);
    const deep = await tmux.capturePane("tachyon-itest-scroll", 500);
    expect(deep).toContain("line-1\n");
    expect(deep).toContain("line-100");
    await tmux.killSession("tachyon-itest-scroll");
  });
});
