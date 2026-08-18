import { createWorkspaceForTest } from "@tachyon/bridge/workspaceComposition.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents, NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { NoticeQueueMetadata } from "@tachyon/shared/bridge/noticeQueue.js";
import { appendDoorbellEvent } from "@tachyon/engine/workspace/doorbell.js";
import { readNoticeCursorFile } from "@tachyon/engine/workspace/noticeCursor.js";
import { registerTools, type BridgeDeps } from "@tachyon/bridge/tools.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-b47fb2 fatia 2 — THE PROOF: a pending notice survives an engine instance swap.
 *
 * Fatia 1 measured the loss end to end (`docs/research/t-b47fb2-dreno-de-notice-perdida.md`): the
 * queue is a `Map` inside the engine process, the `0.93.9 → 0.93.10` swap at 20:07:06Z on 2026-08-17
 * destroyed everything still pending in it, and only `.tachyon/doorbells.jsonl` survived. This file
 * reproduces exactly that shape — two Workspace instances over ONE workspace root, with the tmux
 * sessions surviving the swap the way real panes do — and asserts both halves:
 *
 *   POSITIVE  a notice queued but never delivered by instance 1 reaches the pane after instance 2 boots.
 *   NEGATIVE  a notice instance 1 DID deliver is not delivered a second time by instance 2.
 *
 * The negative control is not decoration. Reconstituting without one trades a loss for a flood, and
 * every positive assertion in this file still passes when you make that trade.
 */

class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
    this.notices.push({ message, level });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(key: string): T | undefined { return this.stateMap.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.stateMap.set(key, value); }
  private readonly secrets = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

/**
 * A fake tmux SERVER shared by both engine instances, handing each one its own `TmuxService`.
 *
 * That split is the whole point of the file. In production the panes are OS processes on a `-L tachyon`
 * server that outlives the extension host, and each engine instance builds its own client over it —
 * `TmuxService.dispose()` tears down the client, never the sessions. Sharing one service object across
 * the swap would measure a disposed client instead of a restarted engine.
 */
function fakeTmuxServer() {
  const sessions = new Set<string>();
  const sent = new Map<string, string[]>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]!);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: `${[...sessions].map((s) => `${s}\t0\t`).join("\n")}\n`, stderr: "" };
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys" && args.includes("-l")) {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
      sent.set(name, [...(sent.get(name) ?? []), args[args.length - 1]!]);
    }
    if (args[2] === "kill-session") {
      sessions.delete(args[args.indexOf("-t") + 1]!.replace(/^=/, ""));
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, connect: () => new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "notice-restart-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

const priv = (ws: Workspace) => ws as unknown as {
  deliverNotice(agent: string, line: string, metadata?: NoticeQueueMetadata): Promise<{ status: string }>;
  recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
  sourceNoticeMetadata(agent: string, origin: "host-poke" | "agent-authored"): NoticeQueueMetadata;
  reconstituteNoticeQueue(agents: readonly string[]): void;
  noticeQueue: { count(t: string): number; queues: Map<string, { createdAt: number; doorbellAt?: string }[]> };
};

/** Age every queued item for `target` past the queue's TTL, the same way `notifyDoorbellDelivery` does. */
function ageQueuePastTtl(ws: Workspace, target: string): void {
  for (const item of priv(ws).noticeQueue.queues.get(target) ?? []) item.createdAt -= 11 * 60_000;
}

function forceStateOf(ws: Workspace, agent: string, state: string, extra: Record<string, unknown> = {}) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): unknown }).stateOf = (a: string) =>
    a === agent ? { state, hasStartedTurn: state === "working", ...extra } : original(a);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The submit path sleeps between paste and Enter, so a zero-tick flush is not enough to observe it. */
async function waitForSent(sent: Map<string, string[]>, session: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const text = (sent.get(session) ?? []).join("");
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return (sent.get(session) ?? []).join("");
}

async function bootEngine(root: string, tmux: TmuxService, host: FakeHost): Promise<Workspace> {
  return createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
}

/**
 * `notify_agent`'s own shape, reduced to what the queue sees: the durable witness row is appended and
 * its `at` travels into the delivery as `doorbellAt`. `communication-io.ts` mints that timestamp once
 * and passes it exactly like this, and the last test in this file pins that it still does.
 */
async function ring(ws: Workspace, root: string, from: string, to: string, summary: string, at: string) {
  appendDoorbellEvent(root, { from, to, at, summary });
  const line = `[tachyon] ${from} → ${to}: ${summary}`;
  return {
    line,
    result: await priv(ws).deliverNotice(to, line, { ...priv(ws).sourceNoticeMetadata(from, "agent-authored"), doorbellAt: at }),
  };
}

describe("t-b47fb2 — a pending notice survives the engine instance swap", () => {
  it("POSITIVE: a notice queued by instance 1 is delivered after instance 2 boots", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  coord:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(mkdir());
    const server = fakeTmuxServer();

    // ── instance 1: the coordinator is mid-turn, so the doorbell queues in memory and nowhere else.
    const first = await bootEngine(root, server.connect(), host);
    // Boot establishes the cursor file — `start()` does exactly this before anything is running.
    priv(first).reconstituteNoticeQueue([]);
    await first.manager.spawn("coord");
    const session = first.manager.session("coord");
    forceStateOf(first, "coord", "working");
    const at = new Date().toISOString();
    const { result } = await ring(first, root, "child", "coord", "t-83d04e done, tree clean", at);
    expect(result.status).toBe("queued");
    expect(server.sent.has(session)).toBe(false);
    // Nothing durable says it was delivered — which is the whole point of the cursor.
    expect(readNoticeCursorFile(root)?.cursors.coord).toBeUndefined();

    // ── the swap. 2026-08-17 20:07:06Z, and again 2026-08-18 11:37:07. The Map dies with the process.
    first.dispose();

    const second = await bootEngine(root, server.connect(), host);
    priv(second).reconstituteNoticeQueue(["coord"]);
    expect(priv(second).noticeQueue.count("coord")).toBe(1);
    // The ORIGINAL ring time, carried across the swap. Stamping the boot clock would make a report
    // that has been waiting since before the crash arrive looking like it just happened.
    expect(priv(second).noticeQueue.queues.get("coord")?.[0]?.createdAt).toBe(Date.parse(at));
    expect(priv(second).noticeQueue.queues.get("coord")?.[0]?.doorbellAt).toBe(at);

    ageQueuePastTtl(second, "coord");
    forceStateOf(second, "coord", "idle");
    await priv(second).recoverOnIdle("coord", false);
    const delivered = await waitForSent(server.sent, session, "t-83d04e done, tree clean");

    expect(delivered).toContain("t-83d04e done, tree clean");
    // Never as fresh news: the restored item keeps the ORIGINAL ring time, so the envelope says so.
    expect(delivered).toContain("delayed");
    // And delivery is what records the hand-over.
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe(at);
    second.dispose();
  });

  it("NEGATIVE CONTROL: a notice instance 1 already delivered is NOT delivered again", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  coord:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(mkdir());
    const server = fakeTmuxServer();

    const first = await bootEngine(root, server.connect(), host);
    priv(first).reconstituteNoticeQueue([]);
    await first.manager.spawn("coord");
    const session = first.manager.session("coord");
    forceStateOf(first, "coord", "idle");
    const at = new Date().toISOString();
    const { result } = await ring(first, root, "child", "coord", "already read this one", at);
    expect(result.status).toBe("notified");
    expect((server.sent.get(session) ?? []).join("")).toContain("already read this one");
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe(at);
    first.dispose();

    server.sent.clear();
    const second = await bootEngine(root, server.connect(), host);
    priv(second).reconstituteNoticeQueue(["coord"]);

    expect(priv(second).noticeQueue.count("coord")).toBe(0);
    forceStateOf(second, "coord", "idle");
    await priv(second).recoverOnIdle("coord", false);
    await flush();
    expect((server.sent.get(session) ?? []).join("")).not.toContain("already read this one");
    second.dispose();
  });

  it("NEGATIVE CONTROL: the FIRST boot on an existing trail replays nothing", async () => {
    // The upgrade case. This workspace's `doorbells.jsonl` has 3,291 rows; a boot that read them as
    // pending would open with thousands of notices, which the card names as worse than the loss.
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  coord:\n    cmd: sh\n", "utf8");
    for (let index = 0; index < 40; index += 1) {
      appendDoorbellEvent(root, {
        from: "child",
        to: "coord",
        at: `2026-08-17T18:${String(index).padStart(2, "0")}:00.000Z`,
        summary: `history ${index}`,
      });
    }
    const host = new FakeHost(mkdir());
    const server = fakeTmuxServer();
    const ws = await bootEngine(root, server.connect(), host);
    await ws.manager.spawn("coord");
    const session = ws.manager.session("coord");

    priv(ws).reconstituteNoticeQueue(["coord"]);

    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    expect(readNoticeCursorFile(root)?.baseline).toBe("2026-08-17T18:39:00.000Z");
    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();
    expect(server.sent.get(session) ?? []).toEqual([]);
    ws.dispose();
  });
});

describe("t-b47fb2 — notify_agent is the door that mints the cursor position", () => {
  it("passes the witnessed `at` of the row it just appended as `doorbellAt`", async () => {
    // The reconstitution above is only as good as the production door feeding it. Without this the
    // engine would advance nothing on delivery, and every delivered notice would come back at boot.
    const root = makeTempDir("notify-doorbell-at-");
    const seen: { metadata?: NoticeQueueMetadata }[] = [];
    const mcp = {
      handlers: new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean }>>(),
      registerTool(name: string, _def: unknown, handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }>) {
        this.handlers.set(name, handler);
      },
    };
    registerTools(mcp as never, {
      workspaceRoot: root,
      manager: {
        kindOf: () => "agent",
        session: (name: string) => `session-${name}`,
        isReady: async () => true,
      } as unknown as BridgeDeps["manager"],
      tmux: { hasSession: async () => true } as unknown as BridgeDeps["tmux"],
      deliverNotice: async (_target: string, _line: string, metadata?: NoticeQueueMetadata) => {
        seen.push({ metadata });
        return { status: "notified" as const };
      },
    } as BridgeDeps);

    await mcp.handlers.get("notify_agent")!({ to: "coord", summary: "done", agent: "child" });

    const trail = fs.readFileSync(path.join(root, ".tachyon", "doorbells.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(trail).toHaveLength(1);
    expect(seen[0]?.metadata?.doorbellAt).toBe(trail[0].at);
  });
});
