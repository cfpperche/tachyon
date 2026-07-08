import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

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
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  getSetting<T>(_section: string, _key: string, dflt: T): T {
    return dflt;
  }
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
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  parent:\n    cmd: sh\n", "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sent } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
  return { ws, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function forceStateOf(ws: Workspace, agent: string, state: string) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): { state: string } | undefined }).stateOf = (a: string) =>
    a === agent ? { state } : original(a);
}

function pokeNeedsInputOf(ws: Workspace) {
  return (ws as unknown as { pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void }).pokeParentOnNeedsInput.bind(ws);
}

function recoverOnIdleOf(ws: Workspace) {
  return (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);
}

describe("container-generated delegation behavior", () => {
  it("a queued notice carries its source child's incarnation and a poke from a dead incarnation is dropped even after a same-name respawn", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("parent");
    await ws.manager.spawn("cwdProbe", { cmd: "sh", parent: "parent" });
    const parentSession = ws.manager.session("parent");

    forceStateOf(ws, "parent", "working");
    pokeNeedsInputOf(ws)("cwdProbe", "old incarnation");
    await flush();
    expect(sent.has(parentSession)).toBe(false);

    await ws.manager.kill("cwdProbe");
    await ws.manager.spawn("cwdProbe", { cmd: "sh", parent: "parent" });

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
});
