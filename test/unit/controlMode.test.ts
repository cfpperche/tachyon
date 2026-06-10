import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ControlModeClient,
  TransportError,
  tmuxQuote,
  lineSafe,
  parseDeadMap,
  DEADMAP_SUBSCRIPTION,
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
  const events = { deadMaps: [] as Array<Map<string, { dead: boolean; exitCode?: number }>>, sessions: 0, states: [] as boolean[] };
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
    onSessionsChanged: () => events.sessions++,
    onStateChange: (up) => events.states.push(up),
    backoffMs: [1],
    ...overrides,
  });
  return { client, procs, fallbackCalls, events };
}

const guard = (p: ReturnType<typeof fakeProc>) => p.stdout.write("%begin 100 1 0\n%end 100 1 0\n");
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

describe("ControlModeClient", () => {
  it("guard block marks ready, then subscribes to the dead map", async () => {
    const { client, procs, events } = makeClient();
    await client.start();
    expect(client.isUp).toBe(false);
    guard(procs[0]);
    await tick();
    expect(client.isUp).toBe(true);
    expect(events.states).toEqual([true]);
    expect(procs[0].written[0]).toContain(`refresh-client -B '${DEADMAP_SUBSCRIPTION}::`);
  });

  it("executor routes through the channel with FIFO framing; semantic errors reject", async () => {
    const { client, procs } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write("%begin 100 2 0\n%end 100 2 0\n"); // subscription reply

    const exec = client.makeExecutor();
    const a = exec(["-L", "tachyon", "display-message", "-p", "one"]);
    const b = exec(["-L", "tachyon", "has-session", "-t", "=ghost"]);
    await tick();
    expect(procs[0].written.slice(1)).toEqual(["display-message -p one", "has-session -t =ghost"]);
    procs[0].stdout.write("%begin 100 3 0\none\n%end 100 3 0\n");
    procs[0].stdout.write("%begin 100 4 0\ncan't find session: ghost\n%error 100 4 0\n");
    expect((await a).stdout).toBe("one\n");
    await expect(b).rejects.toThrow(TmuxError);
    await expect(b).rejects.toThrow("can't find session");
  });

  it("frame body may contain %-prefixed pane content (tag matching)", async () => {
    const { client, procs } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write("%begin 100 2 0\n%end 100 2 0\n");
    const exec = client.makeExecutor();
    const reply = exec(["-L", "tachyon", "capture-pane", "-p", "-t", "=x:"]);
    await tick();
    procs[0].stdout.write("%begin 100 3 0\n%end of file reached\nnormal line\n%end 100 3 0\n");
    expect((await reply).stdout).toBe("%end of file reached\nnormal line\n");
  });

  it("falls back: client down, foreign socket, newline args, empty cmd", async () => {
    const { client, procs, fallbackCalls } = makeClient();
    const exec = client.makeExecutor();
    await exec(["-L", "tachyon", "list-sessions"]); // down -> fallback
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write("%begin 100 2 0\n%end 100 2 0\n");
    await exec(["-L", "other-socket", "list-sessions"]); // not ours -> fallback
    await exec(["-L", "tachyon", "send-keys", "-l", "two\nlines"]); // newline -> fallback
    // 3 routed fallbacks + the anchor new-session from start() itself
    expect(fallbackCalls.filter((c) => !c.includes("new-session"))).toHaveLength(3);
    expect(procs[0].written).toHaveLength(1); // only the subscription rode the channel
  });

  it("dead-map and sessions-changed notifications dispatch; deadmap value parsed", async () => {
    const { client, procs, events } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write(`%subscription-changed ${DEADMAP_SUBSCRIPTION} $0 - - - : a=A|b=D3|\n`);
    procs[0].stdout.write("%sessions-changed\n");
    await tick();
    expect(events.deadMaps).toHaveLength(1);
    expect(events.deadMaps[0].get("b")).toEqual({ dead: true, exitCode: 3 });
    expect(events.sessions).toBe(1);
  });

  it("client death: pending rejected as transport (executor retries on fallback), reconnect + resubscribe", async () => {
    const { client, procs, fallbackCalls, events } = makeClient();
    await client.start();
    guard(procs[0]);
    await tick();
    procs[0].stdout.write("%begin 100 2 0\n%end 100 2 0\n");

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
