import { skipTestsWithoutOptionalRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, expect, it, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-eed531 — ghost-attention regression, queue-purge half (the monitor-side drop is covered by the
 * sibling test/unit/ocGhostBehavior.gen.test.ts at HEAD, which already passes).
 *
 * Repro (2026-07-08): an ad-hoc child (`cwdProbe`) entered needs-input WHILE its parent was busy, so
 * `pokeParentOnNeedsInput` → `deliverNotice(parent, "[tachyon] child 'cwdProbe' is waiting for input: …")`
 * ENQUEUED the poke into the PARENT's NoticeQueue (target key = parent name). The child was then killed
 * + its tmux session gone + absent from list_agents. `Workspace.onKilled(child)` calls
 * `noticeQueue.clear(child)` — but the stale poke sits in the PARENT's queue, not the child's, so it
 * survives. On the parent's next idle, `recoverOnIdle` → `flushQueuedNotice` drains the stale entry and
 * `submitNoticeLine` writes it into the parent's pane (it checks the PARENT's hasSession, not the
 * child's) — the dead child "reaches out from beyond the grave". The fix: gate `flushQueuedNotice` on a
 * `recentlyKilled` set populated at `onKilled` and drained at the next spawn of the same name; a queued
 * poke whose `child 'X'` subject is in that set is dropped at flush instead of being typed into the pane.
 */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
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
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(key: string): T | undefined {
    return this.stateMap.get(key) as T | undefined;
  }
  setState(key: string, value: unknown): void {
    this.stateMap.set(key, value);
  }
  private readonly secrets = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }
  setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
    return Promise.resolve();
  }
  appVersion(): string {
    return "0.0.0-test";
  }
  mediaPath(...segments: string[]): string {
    return path.join(this.storageDir, ...segments);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

/** fake-exec tmux — same pattern as test/unit/workspaceHeadless.test.ts. */
function fakeTmux() {
  const sessions = new Set<string>();
  const sent = new Map<string, string>();
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
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stdout2: "", stderr: "" } as unknown as ExecResult;
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys" && args.includes("-l")) {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      sent.set(name, args[args.length - 1]);
    }
    if (args[2] === "kill-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      sessions.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, tmux: new TmuxService(exec) };
}

/**
 * `t-64ea85` — measured: without this seam the `cmd: opencode` spawns below executed the installed
 * `opencode` binary three times (pwd=/tmp/ocghostq-*). The stub answers as a credentialed home does;
 * every other adapter stays the real, non-executing one.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ocghostq-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWorkspace(onViewsChanged: (view: ViewKind) => void = () => {}) {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  parent:\n    cmd: sh\n", "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sessions, sent } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  return { ws, host, sessions, sent };
}

/** Flushes the best-effort async poke chain (`tmux.hasSession(...).then(...)`) that `pokeParentOn*` fire
 *  without awaiting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Force `monitor.stateOf(agent)` to the given state, preserving other agents' real snapshots. */
function forceStateOf(ws: Workspace, agent: string, state: string) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): { state: string } | undefined }).stateOf = (a: string) =>
    a === agent ? { state } : original(a);
}

function deliverNoticeOf(ws: Workspace) {
  return (ws as unknown as { deliverNotice(agent: string, line: string): Promise<{ status: string }> }).deliverNotice.bind(ws);
}
function pokeNeedsInputOf(ws: Workspace) {
  return (ws as unknown as { pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void }).pokeParentOnNeedsInput.bind(ws);
}
function recoverOnIdleOf(ws: Workspace) {
  return (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);
}

const STALE_POKE_LINE = "[tachyon] child 'cwdProbe' is waiting for input: Continue? [y/n]";

skipTestsWithoutOptionalRuntimeAuth({
  opencode: [
    "a queued parent notice about a killed child is purged and never flushed to the parent pane",
    "a queued parent notice about a still-alive child is flushed normally (no-over-purge guard)",
    "an ordinary relayed notice whose body merely contains poke-shaped text is delivered, not purged (regex anchor)",
  ],
});

describe("container-generated delegation behavior", () => {
  it("a queued parent notice about a killed child is purged and never flushed to the parent pane", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    // Repro step 1: parent is busy (working) → the child's needs-input poke gets ENQUEUED into the parent's
    // NoticeQueue (target key = parent), not typed. To exercise deliverNotice's enqueue branch directly we
    // force the parent's attention state to "working" before the poke fires.
    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "Continue? [y/n]");
    await flush();
    expect(sent.has(parentSession)).toBe(false); // still queued, nothing typed into the busy parent yet
    // t-572cef: a second, metadata-free deliverNotice call with this same text used to sit here to model
    // "another copy of the same stale notice" — but under the shipped origin-aware NoticeQueue dedup, a
    // metadata-free call is a distinct, always-deliverable relay (never tied to cwdProbe's identity), so
    // it no longer belongs in a test asserting a *poke*'s purge. Dropped to keep this test single-notice.

    // Repro step 2: kill the child — tmux session gone + absent from list_agents. onKilled(cwdProbe)
    // runs synchronously; the stale poke is in the PARENT's queue (target key = "parent") and survives
    // noticeQueue.clear("cwdProbe") — that's exactly the bug.
    await ws.manager.kill("cwdProbe");

    // Repro step 3: the parent goes idle — the next tick pumps recoverOnIdle → flushQueuedNotice(parent).
    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);

    // Fixed behavior: the stale poke about the dead child is PURGED at flush, never typed into the parent
    // pane — the dead child does not reach out from beyond the grave.
    expect(sent.has(parentSession)).toBe(false);

    ws.dispose();
  });

  it("a queued parent notice about a still-alive child is flushed normally (no-over-purge guard)", async () => {
    // t-eed531 — the purge must be scoped to freshly-killed children; a poke about a child that is still
    // alive must still be delivered on idle. This is the no-over-purge assertion that protects existing
    // delivery semantics for alive agents.
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("liveChild", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    forceStateOf(ws, "parent", "working");
    const queued = await deliverNoticeOf(ws)("parent", "[tachyon] child 'liveChild' is waiting for input: pick one");
    expect(queued.status).toBe("queued");

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);

    // The live child's poke flushes normally — the purge only fires for recentlyKilled children.
    expect(sent.get(parentSession)).toBe("[tachyon] child 'liveChild' is waiting for input: pick one");

    ws.dispose();
  });

  it("an ordinary relayed notice whose body merely contains poke-shaped text is delivered, not purged (regex anchor)", async () => {
    // t-eed531 review finding 1 — sourceChildOfLine's regex must be anchored to position 0. A relayed
    // notify_agent message that happens to quote a prior poke line inside its body (not as its own prefix)
    // must not be mistaken for a real child-death poke, even when the quoted name is in recentlyKilled.
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    forceStateOf(ws, "parent", "working");
    const relayedLine = `[tachyon] other → parent: FYI, I saw \`${STALE_POKE_LINE}\` earlier`;
    const queued = await deliverNoticeOf(ws)("parent", relayedLine);
    expect(queued.status).toBe("queued");

    await ws.manager.kill("cwdProbe"); // populates recentlyKilled.has("cwdProbe") = true

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);

    // The relayed notice doesn't start with "[tachyon] child '...'", so it must flush normally — the
    // unanchored regex would have matched "cwdProbe" inside the quoted body and wrongly purged this.
    expect(sent.get(parentSession)).toBe(relayedLine);

    ws.dispose();
  });
});
