import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import type { NotifyLevel } from "@tachyon/engine/bridge/tools.js";
import type { TerminalPresentationOptions } from "@tachyon/engine/workspace/TerminalPresentation.js";
import { Terminals } from "../../apps/vscode-extension/src/presentation/Terminals.js";
import { __createdTerminals, __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-b88106 — agent surface preservation across the real lifecycle wiring.
 *
 * `surfacePreservation.test.ts` pins the RULE in isolation. This pins the WIRING: the real
 * `Workspace`, the real `AgentManager`, and the real `Terminals` presentation composed exactly as
 * production composes them, so a regression in who-calls-what is caught and not just a regression in
 * the predicate. Only tmux and the editor widget are substituted.
 *
 * The defect: restarting an agent that was working headless created an editor terminal nobody asked
 * for. Crash recovery and watch-restart take the same code path, so the interruption did not even
 * need a human to trigger it.
 */

/** Editor terminals this run created for an agent, excluding ones already disposed. */
function liveSurfaces(agent: string): typeof __createdTerminals {
  return __createdTerminals.filter((t) => !t.disposed && t.options.name === agent);
}

/** In-memory EngineHost — the same shape `workspaceHeadless.test.ts` uses; the engine can't tell it isn't vscode. */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel; actions: NoticeAction[] }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
  constructor(private readonly storageDir: string) {}
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.notices.push({ message, level, actions: [...actions] });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose() {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(key: string): T | undefined { return this.stateMap.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.stateMap.set(key, value); }
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  createTerminalPresentation(options: TerminalPresentationOptions): Terminals {
    return new Terminals(options.onReveal, options.kindOf, options.manifest);
  }
  onViewsChanged(_view: ViewKind): void {}
}

/**
 * fake-exec tmux — the same channel-level fake the manager/headless suites use (tmux global flags
 * occupy args[0..1], so the verb is args[2]).
 */
function fakeTmux() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]!);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session"); // non-zero exit = does not exist
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "kill-session") {
      sessions.delete(args[args.indexOf("-t") + 1]!.replace(/^=/, ""));
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, tmux: new TmuxService(exec) };
}

/**
 * `t-64ea85` — measured: without this seam the `cmd: opencode` cases below executed the installed
 * `opencode` binary twice (pwd=/tmp/ws-surface-*). The stub answers as a credentialed home does;
 * every other adapter stays the real, non-executing one.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

const dirs: string[] = [];
function mkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-surface-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  __resetVscodeMock();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function makeWorkspace() {
  const root = mkdir();
  // SDD 478 M7 — these cases are about the editor SURFACE, which the boundary marks shared: a
  // supervised process has one exactly like an agent does. `cmd: sh` is a terminal, so it is
  // declared as one instead of riding the retired inline-agents shim.
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  worker:\n    cmd: sh\n", "utf8");
  const host = new FakeHost(mkdir());
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  return { ws, ...fake };
}

/**
 * `t-ed0f43` — the F3 case used to be declared-and-skipped whenever the HOST had no opencode
 * credential, which made the suite cover more on a logged-in checkout than in an agent's worktree.
 * Measured: injection alone was not enough HERE, because the launch preflight still executed
 * `opencode providers list` and failed closed (`credential store probe failed`). Both doors have to
 * be closed, and `HERMETIC_PREFLIGHT` above closes the first one.
 */
useDisposableRuntimeAuth(["opencode"]);

describe("t-b88106 — a relaunch preserves the agent's surface (real Workspace wiring)", () => {
  it("an explicit start opens the agent's editor terminal", async () => {
    const { ws } = await makeWorkspace();
    await ws.manager.spawn("worker");
    expect(liveSurfaces("worker")).toHaveLength(1);
  });

  it("restarting a HEADLESS agent creates no editor terminal — the reported defect", async () => {
    const { ws, sessions } = await makeWorkspace();
    await ws.manager.spawn("worker");
    // The human closes the tab: the agent keeps working, headless. `Terminals` observes the close
    // through onDidCloseTerminal, so the presentation genuinely no longer holds a surface.
    liveSurfaces("worker")[0]!.dispose();
    expect(liveSurfaces("worker")).toHaveLength(0);
    const createdBefore = __createdTerminals.length;

    await ws.manager.restart("worker", { stop: "force", session: "new" });

    expect(liveSurfaces("worker")).toHaveLength(0);
    expect(__createdTerminals.length).toBe(createdBefore); // not even a created-then-hidden tab
    expect(sessions.has(ws.manager.session("worker"))).toBe(true); // the agent itself did restart
  });

  it("restarting a VISIBLE agent keeps exactly one surface — restored, never duplicated", async () => {
    const { ws } = await makeWorkspace();
    await ws.manager.spawn("worker");
    expect(liveSurfaces("worker")).toHaveLength(1);

    await ws.manager.restart("worker", { stop: "force", session: "new" });

    expect(liveSurfaces("worker")).toHaveLength(1);
  });

  it("a relaunch after the agent was killed does not resurrect its old surface", async () => {
    const { ws } = await makeWorkspace();
    await ws.manager.spawn("worker");
    expect(liveSurfaces("worker")).toHaveLength(1);

    await ws.manager.kill("worker"); // kill closes the surface AND ends the agent
    expect(liveSurfaces("worker")).toHaveLength(0);

    // Starting it again is an explicit start, so it reveals — but via the start intent, not by
    // inheriting anything the dead incarnation left behind.
    await ws.manager.spawn("worker");
    expect(liveSurfaces("worker")).toHaveLength(1);
  });

  it("repeated restarts of a headless agent stay headless (no drift over time)", async () => {
    const { ws } = await makeWorkspace();
    await ws.manager.spawn("worker");
    liveSurfaces("worker")[0]!.dispose();

    for (let i = 0; i < 3; i++) await ws.manager.restart("worker", { stop: "force", session: "new" });

    expect(liveSurfaces("worker")).toHaveLength(0);
  });

  it("a Bridge-spawned child never opens a surface, and restarting it does not either (F3)", async () => {
    const { ws } = await makeWorkspace();
    await ws.manager.spawn("worker");
    await ws.manager.spawn("child", { cmd: "opencode", parent: "worker", reveal: false });
    expect(liveSurfaces("child")).toHaveLength(0);

    await ws.manager.restart("child", { stop: "force", session: "new" });

    expect(liveSurfaces("child")).toHaveLength(0);
  });
});
