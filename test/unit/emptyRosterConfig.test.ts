/**
 * t-f67185 — empty roster is a valid attached workspace.
 *
 * Guard + observation: parse accepts empty shapes; a real Workspace attaches without configFailure;
 * sidebar fleet is empty (the "(no agents)" path); Board/pins keep working without any declared entry.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../src/config/loadConfig.js";
import { Workspace } from "../../src/workspace/Workspace.js";
import { buildSidebarFleet, type SidebarFleetSource } from "../../src/sidebar/sidebarFleetService.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

class FakeHost implements EngineHost {
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(_message: string, _level: NotifyLevel = "info", _actions?: NoticeAction[]): void {}
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
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

function fakeTmux() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]!);
      return { stdout: "", stderr: "" };
    }
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args[2] === "has-session") {
      if (sessions.has(target())) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "kill-session") sessions.delete(target());
    return { stdout: "", stderr: "" };
  };
  return { sessions, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-empty-roster-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fleetSource(ws: Workspace, tmux: TmuxService): SidebarFleetSource {
  return {
    workspaceRoot: ws.workspaceRoot,
    wsHash: ws.wsHash,
    folderName: ws.folderName,
    bridge: {},
    manager: ws.manager,
    ledger: ws.ledger,
    tmux,
    worktrees: ws.worktrees,
    config: ws.config,
    configFailure: ws.configFailure,
    commandRunner: ws.commandRunner,
    runbookRunner: ws.runbookRunner,
    handoffStore: { snapshot: () => ({ exists: false, staleness: "missing", pendingCount: 0 }) },
    pinStore: ws.pinStore,
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    pipelines: { allRuns: () => [] },
    listPipelines: () => [],
    lastActivityAt: () => null,
    attentionOf: () => undefined,
    continuityBadge: () => undefined,
    persistenceHookHealth: () => undefined,
    evidenceHandoff: async () => undefined,
    readConfigLkg: () => null,
  } as unknown as SidebarFleetSource;
}

describe("t-f67185 empty roster workspace", () => {
  it.each([
    ["agents: {}", "agents: {}\n"],
    ["commands-only", "commands:\n  build:\n    cmd: npm run build\n"],
    ["neither block", "settings:\n  maxAgents: 2\n"],
  ] as const)("attaches %s with empty fleet; pins and board tasks work", async (_label, yaml) => {
    const parsed = parseConfig(yaml);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents).toEqual({});

    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), yaml, "utf8");
    const host = new FakeHost(mkdir());
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, {
      tmux,
      startBridge: false,
    });
    try {
      expect(ws.configFailure).toBeUndefined();
      expect(ws.config).toBeDefined();
      expect(ws.config?.agents).toEqual({});

      const fleet = await buildSidebarFleet(fleetSource(ws, tmux));
      expect(fleet.agents).toEqual([]);
      expect(fleet.configError).toBeUndefined();
      // App.tsx Agents tab: empty agents + no configError → "(no agents)".

      const pin = await ws.pinStore.create("empty-roster pin", "rostervazio");
      expect(ws.pinStore.list().some((p) => p.id === pin.id)).toBe(true);

      const task = await ws.taskStore.create({ title: "empty-roster board task", author: "rostervazio" });
      expect(ws.taskStore.find(task.id)?.title).toBe("empty-roster board task");
    } finally {
      ws.dispose();
    }
  });

  // t-48dd8d — a malformed roster block no longer kills the file: it is discarded, the rest loads,
  // and the difference from a genuinely empty roster is now the diagnostic rather than the outcome.
  // Discarding is safe here in the only direction that matters — the entries it could not read are
  // ABSENT, never half-built, so nothing is spawnable that the file did not successfully declare.
  it("discards a malformed agents block and keeps the rest of the file", async () => {
    const { config, errors, warnings } = parseConfig('agents: "olá"\ncommands:\n  build:\n    cmd: x\n');
    expect(errors).toEqual([]);
    expect(config?.agents).toEqual({});
    expect(config?.commands.build?.cmd).toBe("x");
    expect(warnings.some((e) => e.includes("'agents'") && e.includes("mapping"))).toBe(true);
  });
});
