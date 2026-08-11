import { skipTestsWithoutOptionalRuntimeAuth, useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import type { NoticeQueueMetadata } from "../../src/bridge/NoticeQueue.js";
import { RUNTIME_PROFILES } from "../../src/runtime/runtimeProfile.js";
import { ATTESTED_RUNTIMES } from "../../src/runtime/attestedRuntimes.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-35c998 — hermetic launch preflight: production's opencode adapter runs `opencode providers list`
 * to answer "is this authenticated?", which made every `cmd: opencode` spawn below execute an
 * installed CLI. The stub answers as a credentialed home does; other adapters stay real.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

/**
 * t-a53dd9 — the notice that was submitted ON TOP of the workspace owner's half-typed message.
 *
 * Measured 2026-08-02, in the worst possible pane: the owner was typing into `claude`, the pane he
 * uses to talk to the coordinator, when a `notify_agent` doorbell from `plugingrok` was typed in and
 * SUBMITTED. His text went out mixed with the injection, without him pressing anything. Silent loss
 * of human input.
 *
 * The queue this needed already existed, and so did the composer signal — `write_input` had been
 * refusing on `refused-composer` since t-f45313. What did not exist was the signal being read at the
 * moment of the write. `AgentAttention.composerOccupied` is recomputed by the attention tick, which
 * runs every ATTENTION_POLL_MS (3s), skips panes tmux reports as unchanged, and keeps serving its
 * last value while a slow pass is over its deadline. Every guard on the delivery path asked that
 * cached value "was a draft there, up to several seconds ago?" — and the answer for a human who
 * started typing since the last capture is `false`.
 *
 * The two directions cost differently and both are pinned here, because this task is defined by the
 * fact that neither is acceptable:
 *   - false negative (typing read as free) = the incident: the human's input is destroyed;
 *   - false positive (free read as typing) = the doorbell never lands and NOTHING says so, which is
 *     worse in the only way that matters — it leaves no trace to find.
 * So: a real draft holds the notice; a dim suggestion and an empty composer do not; a draft that is
 * never cleared cannot swallow the notice in silence.
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
 * The measured Claude Code 2.1.220 composer states (bytes from t-c5f29b / t-6ffa13, quoted in
 * docs/runtimes/parity.md), rendered into a pane tail with the surrounding furniture so
 * `findComposerRegion` has to do its real job rather than match a one-line fixture.
 */
const EMPTY_COMPOSER = "\x1b[39m❯ \x1b[0m";
/** The incident's own text, typed: no dim anywhere. */
const HUMAN_DRAFT = "\x1b[39m❯ integre em main e verifique o tree";
/** Claude renders a suggestion INSIDE an empty composer, entirely SGR-dim. NOT a human draft. */
const DIM_SUGGESTION = '\x1b[39m❯ \x1b[2mTry "fix typecheck errors"\x1b[0m';

const paneWith = (composerLine: string): string =>
  [
    "  ⎿  Done (3 tool uses · 12.1k tokens · 1m 4s)",
    "",
    "\x1b[96m──────────────────────────────────────── tachyon-coord ──\x1b[39m",
    composerLine,
    "\x1b[37m  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents\x1b[39m",
  ].join("\n");

/** fake-exec tmux with a settable pane body per session — same shape as notifyDoorbellDelivery. */
function fakeTmux() {
  const sessions = new Set<string>();
  const sent = new Map<string, string[]>();
  const panes = new Map<string, string>();
  /** EVERY send-keys, including a bare `C-m` with no text — the rate-limit auto-continue is one. */
  const keys: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args[2] === "has-session") {
      if (sessions.has(target())) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "capture-pane") return { stdout: panes.get(target()) ?? "", stderr: "" };
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys") {
      keys.push(args);
      if (args.includes("-l")) {
        const name = target();
        sent.set(name, [...(sent.get(name) ?? []), args[args.length - 1]]);
      }
    }
    if (args[2] === "kill-session") sessions.delete(target());
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, panes, keys, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "human-draft-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Force the CACHED attention reading — deliberately only the cached one. The pane content is set
 * separately, and the whole point of this suite is what happens when the two disagree.
 */
function forceStateOf(ws: Workspace, agent: string, state: string, extra: Record<string, unknown> = {}) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): unknown }).stateOf = (a: string) =>
    a === agent ? { state, ...extra } : original(a);
}

const priv = (ws: Workspace) => ws as unknown as {
  deliverNotice(agent: string, line: string, metadata?: NoticeQueueMetadata): Promise<{ status: string; heldFor?: string }>;
  recoverOnIdle(agent: string): Promise<void>;
  sourceNoticeMetadata(agent: string, origin: "host-poke" | "agent-authored"): NoticeQueueMetadata;
  pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void;
  tryRateLimitAutoContinue(agent: string, episodeKey: string, attempt: number): Promise<void>;
  noticeQueue: { count(t: string): number; queues: Map<string, Array<{ createdAt: number }>> };
  rateLimitRetries: Map<string, unknown>;
};

const DOORBELL = "[tachyon] plugingrok → claude: t-99 done, tree clean [details: t-99]";

/** Age every queued item past the queue's 10-minute TTL, using the real clock it reads. */
function ageQueuePastTtl(ws: Workspace, target: string): void {
  for (const item of priv(ws).noticeQueue.queues.get(target) ?? []) item.createdAt -= 11 * 60_000;
}

/**
 * The recipient is a claude-runtime AGENT, not a terminal: `cmdOf` returns null for terminals, so a
 * terminal recipient has no composer signal at all and would prove nothing about this fix.
 */
async function withCoordAndChild(composerLine = EMPTY_COMPOSER) {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n", "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sent, panes, keys } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  await ws.manager.spawn("coord", { cmd: "claude" });
  await ws.manager.spawn("child", { cmd: "opencode", parent: "coord" });
  const session = ws.manager.session("coord");
  const type = (line: string) => panes.set(session, paneWith(line));
  type(composerLine);
  return { ws, host, sent, panes, keys, session, type };
}

const doorbellMetadataFor = (ws: Workspace, sender: string) => priv(ws).sourceNoticeMetadata(sender, "agent-authored");

/**
 * t-a12966 — this file needs TWO different things from the machine, and only one of them is
 * substrate.
 *
 * The coordinator is a claude agent: its harness wants a credential FILE to link, which is injected
 * below. The child it pokes is spawned with `cmd: opencode`, and opencode is a different animal —
 * its launch preflight EXECUTES the installed runtime to ask whether it is authenticated, so no
 * fixture can stand in. Measured while classifying: the list here declared `claude`, which is the
 * dependency that does NOT bind. On a host with claude credentials and no opencode these twelve
 * went red rather than pending, blaming the composer guard for a missing runtime.
 */
useDisposableRuntimeAuth(["claude"]);

skipTestsWithoutOptionalRuntimeAuth({
  opencode: [
    "an unsent composer tells the human the agent is idle and names the remedy exactly once",
    "THE MEASURED BUG: the poll says the composer is free, the pane says a human is typing — nothing is injected",
    "the sender is TOLD a human is holding it — a queued doorbell that waits on a person says so",
    "NO REGRESSION: an empty composer still delivers immediately, exactly as before",
    "NO REGRESSION: Claude's dim suggestion is not a human and does not hold the queue (t-c5f29b bytes)",
    "the held notice arrives when the draft leaves — waiting, not discarding",
    "a queued notice is not flushed into a pane the human started typing in meanwhile",
    "the HOST poke rides the same guard — the fix cannot be walked around through the other door",
    "the rate-limit auto-continue does not press Enter on a human's draft, and re-arms instead of dying",
    "with a free composer the auto-continue still presses Enter, exactly as before",
    "an abandoned draft cannot hold a live-state poke forever: the TTL is swept even while the composer is held",
    "the exit does not depend on an event: the heartbeat sweeps a queue nothing else touches",
  ],
});

describe("t-a53dd9 — a human typing is not idleness", () => {
  it("an unsent composer tells the human the agent is idle and names the remedy exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ws, host, panes, session } = await withCoordAndChild(HUMAN_DRAFT);

    await ws.monitor.tick();
    vi.setSystemTime(1_009_000);
    await ws.monitor.tick();
    await ws.monitor.tick();

    // Late runtime chrome can briefly reclassify the pane as working. The same draft must not warn
    // again when it settles back to idle; the one-shot belongs to the draft episode, not state flap.
    panes.set(session, `late runtime chrome\n${paneWith(HUMAN_DRAFT)}`);
    vi.setSystemTime(1_009_001);
    await ws.monitor.tick();
    vi.setSystemTime(1_018_001);
    await ws.monitor.tick();

    expect(host.notices).toContainEqual({
      message: "'coord' is idle — your draft was not sent. Send it to start work, or discard it.",
      level: "warn",
    });
    expect(host.notices.filter((notice) => notice.message.includes("your draft was not sent"))).toHaveLength(1);
    ws.dispose();
  });

  it("THE MEASURED BUG: the poll says the composer is free, the pane says a human is typing — nothing is injected", async () => {
    // Fail-before: with only the cached guard, `forceStateOf(..., "idle")` (composerOccupied absent =
    // free, exactly what a pre-typing capture leaves behind) sent the line straight into the pane the
    // owner was typing in. The pane content here is the incident's own draft text.
    const { ws, sent, session } = await withCoordAndChild(HUMAN_DRAFT);

    forceStateOf(ws, "coord", "idle");
    const result = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    expect(result.status).toBe("queued");
    expect(sent.has(session)).toBe(false); // the human's draft is untouched
    expect(priv(ws).noticeQueue.count("coord")).toBe(1); // held, not dropped
    ws.dispose();
  });

  it("the sender is TOLD a human is holding it — a queued doorbell that waits on a person says so", async () => {
    // The false-positive cost this task names is a doorbell that never lands and leaves no trace.
    // A wait on a turn ends by itself in seconds; a wait on a person may not end at all, and the
    // sender is the party that still has the report and can route it elsewhere.
    const { ws } = await withCoordAndChild(HUMAN_DRAFT);
    forceStateOf(ws, "coord", "idle");

    const result = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    expect(result.heldFor).toBe("human-draft");
    ws.dispose();
  });

  it("NO REGRESSION: an empty composer still delivers immediately, exactly as before", async () => {
    // The inverse guard. This is the case that must not become "queued" — a fix that holds every
    // notice would satisfy the incident and break the product.
    const { ws, sent, session } = await withCoordAndChild(EMPTY_COMPOSER);

    forceStateOf(ws, "coord", "idle");
    const result = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    expect(result.status).toBe("notified");
    expect((sent.get(session) ?? []).join("")).toContain("t-99");
    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    ws.dispose();
  });

  it("NO REGRESSION: Claude's dim suggestion is not a human and does not hold the queue (t-c5f29b bytes)", async () => {
    // Claude renders suggestion text inside an OTHERWISE EMPTY composer. Reading it as a draft would
    // hold every notice to that agent forever while the human has nothing to clear and no key that
    // clears it — the measured false positive t-c5f29b already paid for once.
    const { ws, sent, session } = await withCoordAndChild(DIM_SUGGESTION);

    forceStateOf(ws, "coord", "idle");
    const result = await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));

    expect(result.status).toBe("notified");
    expect((sent.get(session) ?? []).join("")).toContain("t-99");
    ws.dispose();
  });

  it("the held notice arrives when the draft leaves — waiting, not discarding", async () => {
    const { ws, sent, session, type } = await withCoordAndChild(HUMAN_DRAFT);

    forceStateOf(ws, "coord", "idle");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
    expect(sent.has(session)).toBe(false);

    // The human submits (or clears): the composer is empty again, and the next idle pass delivers.
    type(EMPTY_COMPOSER);
    await priv(ws).recoverOnIdle("coord");
    await flush();

    expect((sent.get(session) ?? []).join("")).toContain("t-99");
    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    ws.dispose();
  });

  it("a queued notice is not flushed into a pane the human started typing in meanwhile", async () => {
    // The other half of the delivery path: `flushQueuedNotice` runs on an idle edge, and the edge
    // that fires it is not the edge that last measured the composer.
    const { ws, sent, session, type } = await withCoordAndChild(EMPTY_COMPOSER);

    forceStateOf(ws, "coord", "working");
    await priv(ws).deliverNotice("coord", DOORBELL, doorbellMetadataFor(ws, "child"));
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);

    type(HUMAN_DRAFT); // the human starts typing while the agent finishes its turn
    forceStateOf(ws, "coord", "idle");
    await priv(ws).recoverOnIdle("coord");
    await flush();

    expect(sent.has(session)).toBe(false);
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);
    ws.dispose();
  });

  it("the HOST poke rides the same guard — the fix cannot be walked around through the other door", async () => {
    // Constraint 4 of the task: notify_agent and the host's own poke must not be two paths. They are
    // one (`Workspace.deliverNotice`), and this is the assertion that keeps them one.
    const { ws, sent, session } = await withCoordAndChild(HUMAN_DRAFT);

    forceStateOf(ws, "coord", "idle");
    priv(ws).pokeParentOnNeedsInput("child", "Continue? [y/n]");
    await flush();

    expect(sent.has(session)).toBe(false);
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);
    ws.dispose();
  });
});

/**
 * "Who else can reach this?" — the repo's own rule, applied to the effect rather than to the caller.
 * The effect is TYPING INTO A PANE A HUMAN MAY OWN, and the actor×trigger list is: an Agent through
 * notify_agent, an Agent through write_input (covered in bridge.test.ts), Tachyon through the host
 * poke and the queued drain, Tachyon through context renewal,
 * and Tachyon through the rate-limit auto-continue timer. This block is the tail of that list.
 *
 * Deliberately NOT covered, and named so the gap is visible rather than assumed away: the continuity
 * injection (`injectContinuity`) writes only on the explicit `origin: "ui"` path, which is the human
 * asking for it in their own pane, and runbook/`def.spawn` instruction delivery, which is a human
 * command aimed at a terminal.
 */
describe("t-a53dd9 — the other doors onto the same pane", () => {
  it("the rate-limit auto-continue does not press Enter on a human's draft, and re-arms instead of dying", async () => {
    // This one is a BARE ENTER with no text of its own, which is why it never looked like an
    // injection: it types nothing, it just submits whatever is already in the composer — the human's
    // unfinished sentence. Skipping it must not cancel the retry chain, or the fix for one silent
    // loss would introduce another (a throttled agent that never auto-continues and says nothing).
    const { ws, keys } = await withCoordAndChild(HUMAN_DRAFT);
    forceStateOf(ws, "coord", "throttled", { episodeKey: "e1", rateLimit: { resetAt: Date.now() - 1_000 } });

    await priv(ws).tryRateLimitAutoContinue("coord", "e1", 0);

    expect(keys.some((args) => args.includes("C-m"))).toBe(false);
    expect(priv(ws).rateLimitRetries.has("coord")).toBe(true);
    ws.dispose();
  });

  it("with a free composer the auto-continue still presses Enter, exactly as before", async () => {
    const { ws, keys } = await withCoordAndChild(EMPTY_COMPOSER);
    forceStateOf(ws, "coord", "throttled", { episodeKey: "e1", rateLimit: { resetAt: Date.now() - 1_000 } });

    await priv(ws).tryRateLimitAutoContinue("coord", "e1", 0);

    expect(keys.some((args) => args.includes("C-m"))).toBe(true);
    ws.dispose();
  });
});

describe("t-a53dd9 — the wait has a declared exit", () => {
  it("an abandoned draft cannot hold a live-state poke forever: the TTL is swept even while the composer is held", async () => {
    // Before this task the expiry sweep sat AFTER the composer early-return, so the one queue that
    // could be held indefinitely was the one queue the TTL never reached. The notice would sit past
    // its TTL, unexpired and unreported, until some unrelated event happened to touch the queue.
    const { ws, host, sent, session } = await withCoordAndChild(HUMAN_DRAFT);

    forceStateOf(ws, "coord", "idle");
    await priv(ws).deliverNotice("coord", DOORBELL, priv(ws).sourceNoticeMetadata("child", "host-poke"));
    expect(priv(ws).noticeQueue.count("coord")).toBe(1);

    ageQueuePastTtl(ws, "coord"); // the human walked away and left the draft on screen
    await priv(ws).recoverOnIdle("coord");
    await flush();

    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    expect(sent.has(session)).toBe(false); // it expired; it was never typed over the draft
    const expiry = host.notices.find((n) => n.message.includes("expired in the delivery queue"));
    expect(expiry?.level).toBe("warn");
    expect(expiry?.message).toContain("child"); // named, so the human knows what to go find
    ws.dispose();
  });

  it("the exit does not depend on an event: the heartbeat sweeps a queue nothing else touches", async () => {
    // A draft that is never submitted and never cleared produces no state transitions at all, so a
    // notice held behind it generates no further events. If expiry only ran on events, the declared
    // exit would be unreachable in precisely the case it exists for.
    const { ws, host } = await withCoordAndChild(HUMAN_DRAFT);

    forceStateOf(ws, "coord", "idle");
    await priv(ws).deliverNotice("coord", DOORBELL, priv(ws).sourceNoticeMetadata("child", "host-poke"));
    ageQueuePastTtl(ws, "coord");

    await ws.tick();

    expect(priv(ws).noticeQueue.count("coord")).toBe(0);
    expect(host.notices.some((n) => n.message.includes("expired in the delivery queue"))).toBe(true);
    ws.dispose();
  });
});

/**
 * DONE_WHEN (d): the signal is measured PER RUNTIME and absence is declared BY NAME. This is that
 * declaration made mechanical — a new runtime cannot join the product with an unstated answer, and a
 * runtime cannot quietly lose its composer profile (which would silently return its agents to the
 * unguarded behaviour this task fixed) without failing here.
 *
 * `source`/`verified` are carried through deliberately: "declared" is a documented guess about a
 * prompt shape, not a measurement, and a guess that is wrong in the permissive direction reads a
 * human draft as an empty composer.
 */
describe("t-a53dd9 — the human-draft signal, per runtime", () => {
  const EXPECTED: Record<string, { source: string; verified: boolean } | null> = {
    // measured on a live pane, incl. the dim-suggestion and history-echo discriminators
    claude: { source: "measured", verified: true },
    // byte fixtures on 0.146.1 across empty-after-turn / short draft / WRAPPED draft / submitted
    // mid-turn (t-7a297f), on top of the dim-suggestion rule (t-aee74e); human multi-row draft unmeasured
    codex: { source: "measured", verified: true },
    // byte fixtures across empty / typed / post-turn / draft-after-turn (t-aafa10); mid-turn unmeasured
    grok: { source: "measured", verified: true },
    // framed editor between the final two rules (SDD 403)
    pi: { source: "measured", verified: true },
    // peer-shaped guards, never measured against the real TUI
    opencode: { source: "assumed", verified: false },
    hermes: { source: "assumed", verified: false },
    // NO SIGNAL AT ALL. These runtimes resume but declare no composer region, so nothing can be read
    // from their panes and delivery to them is as unguarded as it was before this task. Named here
    // rather than left to be discovered by an owner losing a message.
    gemini: null,
    antigravity: null,
    qwen: null,
    continue: null,
  };

  it("every runtime either declares a measurable composer or is named as having none", () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED).map((runtime) => {
        const composer = RUNTIME_PROFILES[runtime as keyof typeof RUNTIME_PROFILES]?.composer;
        return [runtime, composer ? { source: composer.source, verified: composer.verified } : null];
      }),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it("every ATTESTED runtime — the ones that may operate an Agent — has a composer signal", () => {
    // An attested runtime can be a notify_agent recipient with a human in front of it. One without a
    // composer profile would be a pane Tachyon writes into with no way to see the human at all.
    for (const runtime of ATTESTED_RUNTIMES) {
      expect(RUNTIME_PROFILES[runtime]?.composer, runtime).toBeDefined();
    }
  });
});
