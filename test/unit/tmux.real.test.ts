import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import { ControlModeClient, type DeadMapEntry } from "../../src/tmux/ControlModeClient.js";

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

describe.skipIf(!tmuxAvailable())("ControlModeClient against real tmux (F20 engine)", () => {
  const CM_SOCKET = `tachyon-cm-${process.pid}`;
  const deadMaps: Array<{ at: number; map: Map<string, DeadMapEntry> }> = [];
  let sessionsChanged = 0;
  const client = new ControlModeClient({
    wsHash: "cmtest01",
    socket: CM_SOCKET,
    fallbackExec: (args) => realExecutor(args),
    onDeadMapChanged: (map) => deadMaps.push({ at: Date.now(), map }),
    onSessionsChanged: () => sessionsChanged++,
  });
  const tmux = new TmuxService(client.makeExecutor(), CM_SOCKET);

  beforeAll(async () => {
    await client.start();
    for (let i = 0; i < 40 && !client.isUp; i++) await sleep(50);
    expect(client.isUp).toBe(true);
  }, 15000);

  afterAll(async () => {
    await client.dispose();
    try {
      execFileSync("tmux", ["-L", CM_SOCKET, "kill-server"], { stdio: "pipe" });
    } catch {
      /* server already gone */
    }
  });

  it("drives the full TmuxService surface through the channel (zero subprocesses)", async () => {
    await tmux.newSession({ name: "cm-shell", cmd: "sh", cwd: "/tmp", env: { CM_VAR: "rode-the-pipe" } });
    expect(await tmux.hasSession("cm-shell")).toBe(true);

    await tmux.sendKeys("cm-shell", 'echo "got $CM_VAR in $(pwd)"', true);
    await sleep(300);
    const captured = await tmux.capturePane("cm-shell");
    expect(captured).toContain("got rode-the-pipe in /tmp");

    // nasty quoting end-to-end: literal text with quotes/$/; survives exactly
    await tmux.sendKeys("cm-shell", `echo 'single' "double" $HOME ; true`, true);
    await sleep(300);
    expect(await tmux.capturePane("cm-shell")).toContain("echo 'single'");

    // semantic errors reject like the subprocess path
    await expect(tmux.capturePane("cm-ghost")).rejects.toThrow(/can't find/);
  });

  it("dead-map subscription fires on pane death with the exit code (~1s budget)", async () => {
    await tmux.newSession({ name: "cm-dier", cmd: "sh" });
    await sleep(400);
    deadMaps.length = 0;
    const killedAt = Date.now();
    await tmux.sendKeys("cm-dier", "exit 9", true);
    let entry: DeadMapEntry | undefined;
    for (let i = 0; i < 60 && !entry?.dead; i++) {
      await sleep(100);
      entry = deadMaps[deadMaps.length - 1]?.map.get("cm-dier");
    }
    expect(entry).toEqual({ dead: true, exitCode: 9 });
    const latency = deadMaps[deadMaps.length - 1].at - killedAt;
    // eslint-disable-next-line no-console
    console.log(`[F20] dead-map latency: ${latency}ms`);
    expect(latency).toBeLessThan(2500); // event-driven, well under the old 3s tick floor
  });

  it("%sessions-changed fires on kill-session", async () => {
    const before = sessionsChanged;
    await tmux.newSession({ name: "cm-victim", cmd: "sh" });
    await tmux.killSession("cm-victim");
    for (let i = 0; i < 30 && sessionsChanged === before; i++) await sleep(100);
    expect(sessionsChanged).toBeGreaterThan(before);
  });
});
