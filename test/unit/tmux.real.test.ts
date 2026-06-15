import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TmuxService, isolatedArgs, type ExecResult } from "../../src/tmux/TmuxService.js";
import { ControlModeClient, type DeadMapEntry } from "../../src/tmux/ControlModeClient.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

/**
 * Integration against a REAL tmux server on a throwaway socket. Skipped when tmux
 * is absent (CI safety) — everywhere else this is the strongest validation we have
 * that the arg construction actually drives tmux correctly.
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", env: tmuxChildEnv() });
    return true;
  } catch {
    return false;
  }
}

const SOCKET = `tachyon-test-${process.pid}`;

// Mirror production isolation (-f /dev/null): keep the dev's ~/.tmux.conf
// plugins (resurrect/continuum) from touching the test server's sessions.
function realExecutor(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("tmux", isolatedArgs(args), { encoding: "utf8", env: tmuxChildEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// kill-server stops the server but does NOT remove the -L socket file — it lingers
// in $TMUX_TMPDIR/tmux-<uid>/ as a 0-byte stale socket. Each run uses a fresh
// pid-based socket name, so without this the files pile up indefinitely in /tmp.
// Tear down both: kill the server, then unlink the socket file.
function tmuxSocketPath(name: string): string {
  const base = process.env.TMUX_TMPDIR && process.env.TMUX_TMPDIR.length > 0 ? process.env.TMUX_TMPDIR : "/tmp";
  return path.join(base, `tmux-${process.getuid?.() ?? 0}`, name);
}
function killSocket(name: string): void {
  try {
    execFileSync("tmux", ["-L", name, "kill-server"], { stdio: "pipe", env: tmuxChildEnv() });
  } catch {
    /* server already gone */
  }
  try {
    fs.rmSync(tmuxSocketPath(name), { force: true });
  } catch {
    /* socket file already gone */
  }
}

describe.skipIf(!tmuxAvailable())("TmuxService against real tmux", () => {
  const tmux = new TmuxService(realExecutor, SOCKET);

  beforeAll(async () => {
    // Keepalive session: prevents the server from exit-empty-ing between tests
    // (kill-last-session -> server teardown -> next spawn races the shutdown).
    await tmux.newSession({ name: "tachyon-keepalive", cmd: "sh" });
  });

  afterAll(() => {
    killSocket(SOCKET);
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
    // Poll until the dead-pane status settles — a fixed sleep flakes on a loaded CI
    // runner (pane_dead_status not yet populated when we read).
    let state: { dead: boolean; exitCode?: number } | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      state = (await tmux.sessionStates("tachyon-itest-")).get("tachyon-itest-crasher");
      if (state?.dead && state.exitCode !== undefined) break;
    }
    expect(await tmux.hasSession("tachyon-itest-crasher")).toBe(true); // session survives
    expect(state).toEqual({ dead: true, exitCode: 7 });

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

  it("serverSnapshot reports live and dead panes with pid + exit code (inspector data layer)", async () => {
    await tmux.newSession({ name: "tachyon-itest-snap-live", cmd: "sh" });
    await tmux.newSession({ name: "tachyon-itest-snap-dead", cmd: "sh -c 'exit 5'" });
    await sleep(300);
    const snap = await tmux.serverSnapshot("tachyon-itest-snap-");
    const live = snap.find((r) => r.session === "tachyon-itest-snap-live");
    const dead = snap.find((r) => r.session === "tachyon-itest-snap-dead");
    expect(live?.dead).toBe(false);
    expect(live?.pid).toBeGreaterThan(0);
    expect(dead?.dead).toBe(true);
    expect(dead?.exitCode).toBe(5);
    await tmux.killSession("tachyon-itest-snap-live");
    await tmux.killSession("tachyon-itest-snap-dead");
  });
});

describe.skipIf(!tmuxAvailable())("tmux server isolation (-f /dev/null)", () => {
  // Proves the fix for resurrect/continuum leakage: a server started config-less
  // never picks up the user's ~/.tmux.conf, so their plugins/hooks stay off our
  // socket. Control = the same start WITHOUT isolation, which does load it.
  // Distinct sockets per case: a kill-server teardown racing the next new-session
  // on the same socket throws "server exited unexpectedly" (the shutdown race
  // TmuxService.newSession retries past). Separate sockets sidestep it entirely.
  const CTL_SOCKET = `tachyon-iso-ctl-${process.pid}`;
  const ISO_SOCKET = `tachyon-iso-${process.pid}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-home-"));

  beforeAll(() => {
    fs.writeFileSync(path.join(home, ".tmux.conf"), 'set -g status-left "SENTINEL-CONF"\n');
  });
  afterAll(() => {
    killSocket(CTL_SOCKET);
    killSocket(ISO_SOCKET);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile("tmux", args, { encoding: "utf8", env: tmuxChildEnv({ ...process.env, HOME: home }) }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      });
    });

  it("without isolation, the planted ~/.tmux.conf IS loaded (control)", async () => {
    await run(["-L", CTL_SOCKET, "new-session", "-d", "-s", "x", "tail -f /dev/null"]);
    expect(await run(["-L", CTL_SOCKET, "show-options", "-g", "status-left"])).toContain("SENTINEL-CONF");
  });

  it("with isolatedArgs (-f /dev/null), the user config is ignored", async () => {
    await run(isolatedArgs(["-L", ISO_SOCKET, "new-session", "-d", "-s", "x", "tail -f /dev/null"]));
    expect(await run(isolatedArgs(["-L", ISO_SOCKET, "show-options", "-g", "status-left"]))).not.toContain("SENTINEL-CONF");
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
    killSocket(CM_SOCKET);
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
    // Load-bearing: the subscription FIRES on death within budget — that's the
    // event that triggers lifecycle.tick(). The exit code in the dead-map is
    // best-effort: nested `#{P:#{?pane_dead,D#{pane_dead_status}}}` loops render
    // the status only on newer tmux (3.6 yes; the CI runner's 3.4 marks dead but
    // leaves the code empty). The code the LifecycleMonitor actually uses comes
    // from the list-panes path (sessionStates), not this subscription — so the
    // engine is unaffected. Assert the code only when this tmux provides it.
    expect(entry?.dead).toBe(true);
    if (entry?.exitCode !== undefined) {
      expect(entry.exitCode).toBe(9);
    } else {
      // eslint-disable-next-line no-console
      console.log("[F20] this tmux didn't render pane_dead_status in the subscription loop — lifecycle still reads it via list-panes");
    }
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
