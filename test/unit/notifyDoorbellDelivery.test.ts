import { skipTestsWithoutOptionalRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import type { NoticeQueueMetadata } from "../../src/bridge/NoticeQueue.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-fb1453 — the completion doorbell that the coordinator never heard.
 *
 * Measured 2026-08-01. `codex-revisor` finished t-21101f and called `notify_agent(to:"claude", …)`.
 * `.tachyon/doorbells.jsonl` witnessed three rings (19:13, 20:56, 21:08 UTC); the coordinator's own
 * `.tachyon/pane-transcripts/claude.log` — which covers that whole window — contains zero occurrences
 * of `codex-revisor →` and zero `[tachyon] X → Y:` envelopes. Both sides obeyed the protocol and the
 * coordinator went blind. The human then killed `codex-revisor` with `kill_agent`, minutes after the
 * third ring, which is what turned a delayed report into a destroyed one.
 *
 * The channel was never the problem: other Claude Code panes in the same workspace HAVE received
 * delivered envelopes (claude-runtime.log has 14). The notice died in `NoticeQueue` before it was ever
 * typed. This file pins each way it could die, and which of those are now closed.
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

/** fake-exec tmux — same pattern as test/unit/ocGhostQBehavior.gen.test.ts. */
function fakeTmux() {
  const sessions = new Set<string>();
  const sent = new Map<string, string[]>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" } as ExecResult;
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys" && args.includes("-l")) {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      sent.set(name, [...(sent.get(name) ?? []), args[args.length - 1]]);
    }
    if (args[2] === "kill-session") {
      sessions.delete(args[args.indexOf("-t") + 1].replace(/^=/, ""));
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWorkspace() {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  coord:\n    cmd: sh\n", "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sessions, sent } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
  return { ws, host, sessions, sent };
}

/** Flushes the best-effort async chains the poke/deliver paths fire without awaiting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Force `monitor.stateOf(agent)` to the given state, preserving other agents' real snapshots. */
function forceStateOf(ws: Workspace, agent: string, state: string, extra: Record<string, unknown> = {}) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): unknown }).stateOf = (a: string) =>
    a === agent ? { state, ...extra } : original(a);
}

const priv = (ws: Workspace) => ws as unknown as {
  deliverNotice(agent: string, line: string, metadata?: NoticeQueueMetadata): Promise<{ status: string }>;
  recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
  sourceNoticeMetadata(agent: string, origin: "host-poke" | "agent-authored"): NoticeQueueMetadata;
  pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void;
  recoveryInFlight: Set<string>;
  noticeQueue: { count(t: string): number; queues: Map<string, Array<{ createdAt: number }>> };
};

/** The exact shape `notify_agent` enqueues: the SENDER's identity, tagged as authored by it. */
const doorbellMetadataFor = (ws: Workspace, sender: string) => priv(ws).sourceNoticeMetadata(sender, "agent-authored");

const DOORBELL = "[tachyon] codex-revisor → claude: t-21101f done, tree clean [details: t-21101f]";

/** Age every queued item for `target` past the queue's 10-minute TTL, using the real clock it reads. */
function ageQueuePastTtl(ws: Workspace, target: string): void {
  for (const item of priv(ws).noticeQueue.queues.get(target) ?? []) item.createdAt -= 11 * 60_000;
}

async function withCoordAndChild() {
  const made = await makeWorkspace();
  await made.ws.manager.spawn("coord");
  await made.ws.manager.spawn("child", { cmd: "opencode", parent: "coord" });
  return { ...made, session: made.ws.manager.session("coord") };
}

skipTestsWithoutOptionalRuntimeAuth({
  opencode: [
    "THE MEASURED BUG: a doorbell from a child the coordinator has since KILLED is still delivered",
    "a HOST poke about a killed child is still purged — the ghost fix keeps its original scope",
    "a host poke about a child that is still ALIVE is delivered (no over-purge)",
    "baseline: busy at enqueue, idle later, child alive → delivered",
    "expiry names the sender and the line, the way overflow already names its count",
    "a notice queued because recovery held the mutex is drained in the same idle pass",
    "a submit whose completion could not be observed keeps the notice queued for the next idle",
    "a human draft in the composer holds the drain without losing the notice",
  ],
});

describe("t-fb1453 — an agent-authored doorbell outlives its author", () => {
  it("THE MEASURED BUG: a doorbell from a child the coordinator has since KILLED is still delivered", async () => {
    // This is the incident, reduced. The coordinator was busy when the child rang, so the notice was
    // queued; the coordinator then killed the child; the queued report was the child's own completion,
    // and killing the author is not evidence that the report became false.
    //
    // REGRESSION GUARD: this fails the moment the incarnation filter goes back to being applied to
    // every notice carrying a `sourceChild`, because `onKilled` deletes the child's live incarnation
    // and every entry that names it then mismatches. Nothing here is mocked around that filter — the
    // notice runs the real `flushQueuedNotice`, with a really-killed child, on the real queue.
    const { ws, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    const queued = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
    expect(queued.status).toBe("queued");
    expect(sent.has(session)).toBe(false); // nothing typed into a busy pane

    await ws.manager.kill("child"); // the coordinator dismisses the child it thinks is still stuck

    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    const delivered = (sent.get(session) ?? []).join("");
    expect(delivered).toContain("t-21101f");
    // t-99ccc9's incident (a report arriving after the parent already handled the work, reading as
    // fresh news) is answered by provenance, not by destruction: the line says how old it is and that
    // its author is gone. Delivering it unlabelled would trade one confusion for another.
    expect(delivered).toContain("delayed");
    expect(delivered).toContain("'child' was dismissed before you read this");
    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    ws.dispose();
  });

  it("a HOST poke about a killed child is still purged — the ghost fix keeps its original scope", async () => {
    // t-eed531's dead-child-reaching-out bug must stay fixed. A poke is a claim about a LIVE state
    // ("is waiting for input"), and that claim dies with the child. Same queue, same flush, same
    // killed child as the test above; only the ORIGIN differs, and the outcome inverts.
    const { ws, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    priv(ws).pokeParentOnNeedsInput("child", "Continue? [y/n]");
    await flush();
    expect(sent.has(session)).toBe(false);

    await ws.manager.kill("child");

    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect(sent.has(session)).toBe(false);
    ws.dispose();
  });

  it("a host poke about a child that is still ALIVE is delivered (no over-purge)", async () => {
    const { ws, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    priv(ws).pokeParentOnNeedsInput("child", "Continue? [y/n]");
    await flush();

    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect((sent.get(session) ?? []).join("")).toContain("is waiting for input");
    ws.dispose();
  });

  it("baseline: busy at enqueue, idle later, child alive → delivered", async () => {
    const { ws, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect((sent.get(session) ?? []).join("")).toContain("t-21101f");
    ws.dispose();
  });
});

describe("t-fb1453 — a notice the TTL eats is never eaten in silence", () => {
  it("expiry names the sender and the line, the way overflow already names its count", async () => {
    // Still a loss: the 10-minute TTL is spec 341's deliberate policy and this change does not touch
    // it. What changes is that the loss now has a witness — the sender was answered "queued … for
    // idle delivery" and, until now, nothing ever took that back.
    const { ws, host, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);

    ageQueuePastTtl(ws, "coord");

    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect(sent.has(session)).toBe(false); // the TTL still discards it
    const warned = host.notices.filter((n) => n.level === "warn").map((n) => n.message);
    expect(warned.join("|")).toContain("expired in the delivery queue");
    expect(warned.join("|")).toContain("child"); // WHOSE bell died
    expect(warned.join("|")).toContain("t-21101f"); // and WHAT it said
    ws.dispose();
  });
});

describe("t-fb1453 — the drain reaches notices that arrive at an awkward moment", () => {
  it("a notice queued because recovery held the mutex is drained in the same idle pass", async () => {
    // deliverNotice queues even an IDLE recipient while `recoveryInFlight` is set, so a doorbell that
    // lands during re-anchor/continuity used to wait for the next working→idle edge — and an agent
    // that has finished working has no next edge.
    const { ws, sent, session } = await withCoordAndChild();
    forceStateOf(ws, "coord", "idle");

    const original = (ws as unknown as { maybeRemindHandoff(a: string): Promise<void> }).maybeRemindHandoff.bind(ws);
    (ws as unknown as { maybeRemindHandoff(a: string): Promise<void> }).maybeRemindHandoff = async (a: string) => {
      await original(a);
      if (a !== "coord") return;
      // the child rings WHILE the recovery pass is still holding the mutex
      const queued = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
      expect(queued.status).toBe("queued");
    };

    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect((sent.get(session) ?? []).join("")).toContain("t-21101f");
    ws.dispose();
  });

  it("a submit whose completion could not be observed keeps the notice queued for the next idle", async () => {
    // t-b4a799's unknown-flattened-into-known, in the delivery path: `dequeue` removed the item before
    // anyone knew whether it had landed, so an unconfirmed submit consumed the only copy.
    const { ws } = await withCoordAndChild();

    (ws as unknown as { submitNoticeLine(a: string, l: string): Promise<{ status: string; reason?: string }> })
      .submitNoticeLine = async () => ({ status: "submit-unconfirmed", reason: "composer still shows the line" });

    forceStateOf(ws, "coord", "working");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();

    expect(priv(ws).noticeQueue.count("coord")).toBe(1); // retained, not silently consumed
    ws.dispose();
  });

  it("a human draft in the composer holds the drain without losing the notice", async () => {
    const { ws, sent, session } = await withCoordAndChild();

    forceStateOf(ws, "coord", "working");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    forceStateOf(ws, "coord", "idle", { composerOccupied: true });
    await priv(ws).recoverOnIdle("coord", false);
    await flush();
    expect(sent.has(session)).toBe(false);
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);

    // the human submits, the composer clears, the next idle pass delivers
    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord", false);
    await flush();
    expect((sent.get(session) ?? []).join("")).toContain("t-21101f");
    ws.dispose();
  });
});
