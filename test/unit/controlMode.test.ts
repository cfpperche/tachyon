import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ControlModeClient,
  tmuxQuote,
  lineSafe,
  parseDeadMap,
  parseActivityMap,
  DEADMAP_SUBSCRIPTION,
  ACTIVITY_SUBSCRIPTION,
} from "../../src/tmux/ControlModeClient.js";
import { TmuxError, type ExecResult } from "../../src/tmux/TmuxService.js";

/** A scripted control-mode client process: stdin lines are recorded, stdout is ours to feed. */
function fakeProc() {
  const proc = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter;
  const stdout = new PassThrough();
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (d) => written.push(...d.toString().split("\n").filter(Boolean)));
  Object.assign(proc, { stdout, stdin, stderr: new PassThrough(), kill: vi.fn(() => proc.emit("exit", 0)) });
  return { proc, stdout, written };
}

function makeClient(overrides: Partial<ConstructorParameters<typeof ControlModeClient>[0]> = {}) {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const fallbackCalls: string[][] = [];
  const events = {
    deadMaps: [] as Array<Map<string, { dead: boolean; exitCode?: number }>>,
    activityMaps: [] as Array<Map<string, number>>,
    sessions: 0,
    states: [] as boolean[],
  };
  const client = new ControlModeClient({
    wsHash: "abc12345",
    socket: "tachyon",
    spawnClient: () => {
      const p = fakeProc();
      procs.push(p);
      return p.proc;
    },
    fallbackExec: (args): Promise<ExecResult> => {
      fallbackCalls.push(args);
      return Promise.resolve({ stdout: "fallback\n", stderr: "" });
    },
    onDeadMapChanged: (m) => events.deadMaps.push(m),
    onActivityMapChanged: (m) => events.activityMaps.push(m),
    onSessionsChanged: () => events.sessions++,
    onStateChange: (up) => events.states.push(up),
    backoffMs: [1],
    ...overrides,
  });
  return { client, procs, fallbackCalls, events };
}

const guard = (p: ReturnType<typeof fakeProc>) => p.stdout.write("%begin 100 1 0\n%end 100 1 0\n");
/** Drain the two post-guard subscription replies (dead-map + activity). */
const ackSubs = (p: ReturnType<typeof fakeProc>) =>
  p.stdout.write("%begin 100 2 0\n%end 100 2 0\n%begin 100 3 0\n%end 100 3 0\n");
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("tmuxQuote / lineSafe", () => {
  it("quotes exactly what the line protocol needs", () => {
    expect(tmuxQuote("plain-arg")).toBe("plain-arg");
    expect(tmuxQuote("")).toBe("''");
    expect(tmuxQuote(";")).toBe(";"); // separator must stay bare
    expect(tmuxQuote("with space")).toBe("'with space'");
    expect(tmuxQuote("a'b")).toBe("'a'\\''b'");
    expect(tmuxQuote('say "hi" $HOME')).toBe("'say \"hi\" $HOME'");
  });

  it("lineSafe rejects newlines (cannot ride a line protocol)", () => {
    expect(lineSafe(["ok", "also ok"])).toBe(true);
    expect(lineSafe(["bad\nline"])).toBe(false);
    expect(lineSafe(["bad\rline"])).toBe(false);
  });
});

describe("parseDeadMap", () => {
  it("parses alive/dead segments with exit codes (spiked format)", () => {
    const map = parseDeadMap("ctl=A|tachyon-x-claude=D7|tachyon-x-shell=A|");
    expect(map.get("tachyon-x-claude")).toEqual({ dead: true, exitCode: 7 });
    expect(map.get("tachyon-x-shell")).toEqual({ dead: false, exitCode: undefined });
    expect(map.has("")).toBe(false);
  });

  it("multi-pane sessions: any dead pane marks the session dead", () => {
    expect(parseDeadMap("multi=AD0A|").get("multi")).toEqual({ dead: true, exitCode: 0 });
  });
});

describe("parseActivityMap", () => {
  it("parses session=timestamp segments (t-4ecf9a)", () => {
    const map = parseActivityMap("ctl=1710000000|tachyon-x-claude=1710000042|tachyon-x-shell=1710000100|");
    expect(map.get("tachyon-x-claude")).toBe(1710000042);
    expect(map.get("tachyon-x-shell")).toBe(1710000100);
    expect(map.has("")).toBe(false);
  });

  it("skips non-numeric timestamps", () => {
    expect(parseActivityMap("bad=notanumber|ok=99|").get("ok")).toBe(99);
    expect(parseActivityMap("bad=notanumber|ok=99|").has("bad")).toBe(false);
  });
});

describe("ControlModeClient", () => {
  it("guard block marks ready, then subscribes to dead-map and activity", async () => {
    const { client, procs, events } = makeClient();
    await client.start();
    expect(client.isUp).toBe(false);
    guard(procs[0]);
    await tick();
    expect(client.isUp).toBe(true);
    expect(events.states).toEqual([true]);
    expect(procs[0].written[0]).toContain(`refresh-client -B '${DEADMAP_SUBSCRIPTION}::`);
    expect(procs[0].written[1]).toContain(`refresh-client -B '${ACTIVITY_SUBSCRIPTION}::`);
  });

  it("executor routes through the channel with FIFO framing; semantic errors reject", async () => {
    const { client, procs } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    ackSubs(procs[0]); // both subscription replies

    const exec = client.makeExecutor();
    const a = exec(["-L", "tachyon", "display-message", "-p", "one"]);
    const b = exec(["-L", "tachyon", "has-session", "-t", "=ghost"]);
    await tick();
    expect(procs[0].written.slice(2)).toEqual(["display-message -p one", "has-session -t =ghost"]);
    procs[0].stdout.write("%begin 100 4 0\none\n%end 100 4 0\n");
    procs[0].stdout.write("%begin 100 5 0\ncan't find session: ghost\n%error 100 5 0\n");
    expect((await a).stdout).toBe("one\n");
    await expect(b).rejects.toThrow(TmuxError);
    await expect(b).rejects.toThrow("can't find session");
  });

  it("frame body may contain %-prefixed pane content (tag matching)", async () => {
    const { client, procs } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    ackSubs(procs[0]);
    const exec = client.makeExecutor();
    const reply = exec(["-L", "tachyon", "capture-pane", "-p", "-t", "=x:"]);
    await tick();
    procs[0].stdout.write("%begin 100 4 0\n%end of file reached\nnormal line\n%end 100 4 0\n");
    expect((await reply).stdout).toBe("%end of file reached\nnormal line\n");
  });

  it("falls back: client down, foreign socket, newline args, empty cmd", async () => {
    const { client, procs, fallbackCalls } = makeClient();
    const exec = client.makeExecutor();
    await exec(["-L", "tachyon", "list-sessions"]); // down -> fallback
    await client.start();
    guard(procs[0]);
    await tick();
    ackSubs(procs[0]);
    await exec(["-L", "other-socket", "list-sessions"]); // not ours -> fallback
    await exec(["-L", "tachyon", "send-keys", "-l", "two\nlines"]); // newline -> fallback
    // 3 routed fallbacks + the anchor new-session from start() itself
    expect(fallbackCalls.filter((c) => !c.includes("new-session"))).toHaveLength(3);
    expect(procs[0].written).toHaveLength(2); // only the two subscriptions rode the channel
  });

  it("dead-map, activity-map, and sessions-changed notifications dispatch", async () => {
    const { client, procs, events } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write(`%subscription-changed ${DEADMAP_SUBSCRIPTION} $0 - - - : a=A|b=D3|\n`);
    procs[0].stdout.write(`%subscription-changed ${ACTIVITY_SUBSCRIPTION} $0 - - - : a=100|b=200|\n`);
    procs[0].stdout.write("%sessions-changed\n");
    await tick();
    expect(events.deadMaps).toHaveLength(1);
    expect(events.deadMaps[0].get("b")).toEqual({ dead: true, exitCode: 3 });
    expect(events.activityMaps).toHaveLength(1);
    expect(events.activityMaps[0].get("b")).toBe(200);
    expect(events.sessions).toBe(1);
  });

  it("client death: pending rejected as transport (executor retries on fallback), reconnect + resubscribe", async () => {
    const { client, procs, fallbackCalls, events } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    ackSubs(procs[0]);

    const exec = client.makeExecutor();
    const inFlight = exec(["-L", "tachyon", "list-sessions", "-F", "#{session_name}"]);
    await tick();
    procs[0].proc.emit("exit", 1);
    expect((await inFlight).stdout).toBe("fallback\n"); // transparent retry
    expect(fallbackCalls.some((c) => c.includes("list-sessions"))).toBe(true);
    expect(events.states).toEqual([true, false]);

    await new Promise((r) => setTimeout(r, 10)); // backoffMs: [1]
    expect(procs).toHaveLength(2); // respawned
    guard(procs[1]);
    await tick();
    expect(events.states).toEqual([true, false, true]);
    expect(procs[1].written[0]).toContain("refresh-client -B"); // resubscribed
    expect(procs[1].written[1]).toContain(ACTIVITY_SUBSCRIPTION);
  });

  it("dispose stops reconnecting and kills the anchor", async () => {
    const { client, procs, fallbackCalls } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    await client.dispose();
    expect(fallbackCalls.some((c) => c.includes("kill-session") && c.includes(`=tachyon-ctl-abc12345`))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(procs).toHaveLength(1); // no respawn after dispose
  });
});
