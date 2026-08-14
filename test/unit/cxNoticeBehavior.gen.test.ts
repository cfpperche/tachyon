import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-35c998 — hermetic launch preflight: production's opencode adapter runs `opencode providers list`
 * to answer "is this authenticated?", which made every `cmd: opencode` spawn below execute an
 * installed CLI. The stub answers as a credentialed home does; other adapters stay real.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();

  constructor(private readonly storageDir: string) {}

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
}

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
  return { sent, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cxnotice-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  vi.useRealTimers();
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWorkspace() {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  parent:\n    cmd: sh\n", "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sent } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  return { ws, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function forceStateOf(ws: Workspace, agent: string, state: string) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): { state: string; hasStartedTurn?: boolean } | undefined }).stateOf = (a: string) =>
    a === agent ? { state, hasStartedTurn: state === "working" } : original(a);
}

function pokeNeedsInputOf(ws: Workspace) {
  return (ws as unknown as { pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void }).pokeParentOnNeedsInput.bind(ws);
}

function recoverOnIdleOf(ws: Workspace) {
  return (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);
}

function deliverNoticeOf(ws: Workspace) {
  return (
    ws as unknown as {
      deliverNotice(agent: string, line: string, metadata?: { sourceChild?: string; sourceIncarnation?: number }): Promise<unknown>;
    }
  ).deliverNotice.bind(ws);
}

function agentIncarnationsOf(ws: Workspace): Map<string, number> {
  return (ws as unknown as { agentIncarnations: Map<string, number> }).agentIncarnations;
}

/**
 * t-b10d93 — `cwdProbe` below is spawned with `cmd: opencode`, and its credential is substrate: with
 * `HERMETIC_PREFLIGHT` above already off the executing path, the only remaining reader is
 * `HarnessManager.materializeHome` copying `<XDG_DATA_HOME>/opencode/auth.json`. A fixture file
 * replaces the three-title skip list this file used to carry.
 */
useDisposableRuntimeAuth(["opencode"]);

describe("container-generated delegation behavior", () => {
  it("a queued notice carries its source child's incarnation and a poke from a dead incarnation is dropped even after a same-name respawn", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "old incarnation");
    await flush();
    expect(sent.has(parentSession)).toBe(false);

    await ws.manager.kill("cwdProbe");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);
    expect(sent.has(parentSession)).toBe(false);

    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "current incarnation");
    await flush();
    expect(sent.has(parentSession)).toBe(false);

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);
    expect(sent.get(parentSession)).toBe("[tachyon] child 'cwdProbe' is waiting for input: current incarnation");

    ws.dispose();
  });

  it("t-572cef: a live child whose incarnation entry is missing (modeling a reload survivor) still has its poke delivered", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    // Model what rehydrateFromLedger leaves for a session that survived a reload: the child is
    // genuinely alive but has no agentIncarnations entry for this process lifetime (never went
    // through onSpawned).
    agentIncarnationsOf(ws).delete("cwdProbe");

    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "reload survivor poke");
    await flush();
    expect(sent.has(parentSession)).toBe(false);

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);
    expect(sent.get(parentSession)).toBe("[tachyon] child 'cwdProbe' is waiting for input: reload survivor poke");

    ws.dispose();
  });

  it("t-572cef: a text-identical notify_agent relay is not absorbed into a child poke's dedup slot and survives the child's death", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });
    const parentSession = ws.manager.session("parent");
    const duplicateLine = "[tachyon] child 'cwdProbe' is waiting for input: duplicate text";

    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "duplicate text");
    await flush();
    // A metadata-free relay (e.g. a notify_agent call) enqueues with text identical to the poke above.
    await deliverNoticeOf(ws)("parent", duplicateLine);
    expect(sent.has(parentSession)).toBe(false);

    // The child dies for good and respawns under a new incarnation — the original poke's slot is now
    // stale and must drop, but the relay (never tagged with cwdProbe's incarnation) must not have been
    // merged into it, so it still gets delivered.
    await ws.manager.kill("cwdProbe");
    await ws.manager.spawn("cwdProbe", { cmd: "opencode", parent: "parent" });

    forceStateOf(ws, "parent", "idle");
    await recoverOnIdleOf(ws)("parent", false);
    expect(sent.get(parentSession)).toBe(duplicateLine);

    ws.dispose();
  });
});
