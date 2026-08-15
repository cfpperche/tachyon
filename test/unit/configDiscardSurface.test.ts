import { createWorkspaceForTest } from "@tachyon/bridge/workspaceComposition.js";
/**
 * t-7d6013 — a discarded declaration leaves a DURABLE record, and never anything more than a record.
 *
 * t-48dd8d made every unreadable key warn instead of refusing the file, and the owner then chose that
 * NOTHING closes as a result ("opção A, simplicidade sempre"). That choice puts the entire weight on
 * the notice, and the notice was a toast. These tests measure the replacement on the door production
 * uses — a real `Workspace` reloading a real file — because the parser has always reported the
 * discards; what was missing was anything downstream that remembered them.
 *
 * The three properties, in the order they can go wrong:
 *   1. the record exists after the toast would have faded, and the file still LOADS (no configFailure,
 *      so nothing here can reach `isLkgOnlySpawn` and mark a healthy fleet unspawnable);
 *   2. a human can take it off the screen — a durable notice with no dismissal is worse than the toast
 *      it replaces;
 *   3. the dismissal covers ONE set of discarded lines, so it can never hide a set nobody has read.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { buildSidebarFleet, type SidebarFleetSource } from "@tachyon/engine/sidebar/sidebarFleetService.js";
import { projectSidebarView } from "@tachyon/engine/runtime-api/sidebarProjection.js";
import { applySidebarMutation } from "@tachyon/engine/sidebar/sidebarMutationService.js";
import { isSidebarMutationInputV1 } from "@tachyon/engine/runtime-api/sidebarCommands.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * The expensive case from the contract, verbatim: `sandboxMode` misspelled on a codex entry drops the
 * WHOLE entry, and a delegated codex agent with no authored projection gets
 * `sandbox_mode="danger-full-access"` (AgentManager.ts:2093-2094). Plus one discard from each of the
 * other blocks that can drop a declaration, so the record is measured across doors and not on one key.
 */
const FILE_WITH_DISCARDS = [
  "settings:",
  "  maxAgents: 0",
  "  agentPermissionProjection:",
  "    reviewer:",
  "      runtime: codex",
  "      sandbox_mode: read-only",
  "  worktree:",
  "    shareDependencies: nope",
  "",
].join("\n");

const FILE_CLEAN = ["settings:", "  maxAgents: 4", ""].join("\n");

class FakeHost implements EngineHost {
  readonly toasts: Array<{ message: string; level: NotifyLevel }> = [];
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
    this.toasts.push({ message, level });
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
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

function fakeTmux(): TmuxService {
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
    if (args[2] === "list-sessions") return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "kill-session") sessions.delete(target());
    return { stdout: "", stderr: "" };
  };
  return new TmuxService(exec);
}

const dirs: string[] = [];
const mkdir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-config-discards-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  __resetVscodeMock();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The fleet source IS the workspace in production; this mirrors that by reading the same live fields
 * on every build, so a source snapshotted before a reload can never make the surface look durable.
 */
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
    get config() { return ws.config; },
    get configFailure() { return ws.configFailure; },
    get configDiscards() { return ws.configDiscards; },
    commandRunner: ws.commandRunner,
    runbookRunner: ws.runbookRunner,
    handoffStore: { snapshot: () => ({ exists: false, staleness: "fresh", pendingCount: 0 }) },
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

async function attach(yaml: string): Promise<{ ws: Workspace; host: FakeHost; tmux: TmuxService; file: string }> {
  const root = mkdir();
  const file = path.join(root, "tachyon.yml");
  fs.writeFileSync(file, yaml, "utf8");
  const host = new FakeHost(mkdir());
  const tmux = fakeTmux();
  const ws = await createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
  return { ws, host, tmux, file };
}

describe("t-7d6013 durable surface for discarded tachyon.yml declarations", () => {
  it("records what was dropped, keeps the file loaded, and degrades nothing", async () => {
    const { ws, host, tmux } = await attach(FILE_WITH_DISCARDS);

    // The toast still fires — it is the "right now" signal, and this surface is an addition to it.
    expect(host.toasts.some((toast) => toast.level === "warn" && toast.message.includes("sandbox_mode"))).toBe(true);

    const discards = ws.configDiscards;
    expect(discards?.file).toBe("tachyon.yml");
    expect(discards?.entries).toEqual([
      "settings.maxAgents: must be an integer >= 1",
      "settings.worktree.shareDependencies: must be a boolean",
      "settings.agentPermissionProjection.reviewer: unknown key 'sandbox_mode'",
      "settings.agentPermissionProjection.reviewer: a codex entry must set at least one of approvalPolicy, sandboxMode, bridgeToolApproval",
    ]);

    // NOT a failure: the config loaded, so nothing here reaches isLkgOnlySpawn or the degraded roster.
    expect(ws.configFailure).toBeUndefined();
    expect(ws.config).toBeDefined();

    // And the owner's rule is intact where it costs the most: the entry is GONE rather than replaced
    // by a safer posture, which is what leaves a delegated codex agent on the class default.
    expect(ws.config?.settings.agentPermissionProjection).toBeUndefined();
    expect(ws.config?.settings.maxAgents).toBeUndefined();

    const fleet = await buildSidebarFleet(fleetSource(ws, tmux));
    expect(fleet.configDiscards?.signature).toBe(discards?.signature);
    expect(fleet.configDiscards?.summary).toBe(
      "settings.maxAgents: must be an integer >= 1 (+3 more)",
    );
    expect(fleet.configError).toBeUndefined();
    expect(fleet.agents.every((row) => row.configInvalid !== true)).toBe(true);
  });

  it("survives the strict sidebar projection (an undeclared field would drop the whole fleet)", async () => {
    const { ws, tmux } = await attach(FILE_WITH_DISCARDS);
    const view = await projectSidebarView(fleetSource(ws, tmux));
    expect(view.fleet.configDiscards?.entries.length).toBe(4);
    expect(view.fleet.configDiscards?.signature).toMatch(/^[a-f0-9]{16}$/);
  });

  it("a clean file records nothing", async () => {
    const { ws, tmux } = await attach(FILE_CLEAN);
    expect(ws.configDiscards).toBeUndefined();
    expect((await buildSidebarFleet(fleetSource(ws, tmux))).configDiscards).toBeUndefined();
  });

  it("the human can dismiss it, and an unchanged file stays quiet across reloads", async () => {
    const { ws, tmux } = await attach(FILE_WITH_DISCARDS);
    const signature = ws.configDiscards!.signature;

    const result = await applySidebarMutation(ws, { action: "config.dismissDiscards", id: signature }, () => undefined);
    expect(result.changed).toBe(true);
    expect(ws.configDiscards).toBeUndefined();
    expect((await buildSidebarFleet(fleetSource(ws, tmux))).configDiscards).toBeUndefined();

    // The reload every file save triggers must not resurrect a decision the human already made.
    ws.reloadConfig();
    expect(ws.configDiscards).toBeUndefined();

    // Dismissing again changes nothing, and a signature that is not the live one is refused outright —
    // a click that raced a reload must never hide a set nobody has read.
    expect(ws.dismissConfigDiscards(signature)).toBe(false);
    expect(ws.dismissConfigDiscards("0123456789abcdef")).toBe(false);
  });

  it("comes back when what was discarded changes, including the same typo written again", async () => {
    const { ws, tmux, file } = await attach(FILE_WITH_DISCARDS);
    const first = ws.configDiscards!.signature;
    expect(ws.dismissConfigDiscards(first)).toBe(true);

    // A DIFFERENT mistake is a different record — the dismissal covered the old set, not the file.
    fs.writeFileSync(file, `${FILE_CLEAN}  companion:\n    allowedHost: [example.com]\n`, "utf8");
    ws.reloadConfig();
    expect(ws.configDiscards?.entries).toEqual(["settings.companion: unknown key 'allowedHost'"]);
    expect(ws.configDiscards?.signature).not.toBe(first);

    // Fixed, then broken again the same way: the record returns rather than inheriting a dismissal
    // that was made about a file which no longer exists.
    const second = ws.configDiscards!.signature;
    expect(ws.dismissConfigDiscards(second)).toBe(true);
    fs.writeFileSync(file, FILE_CLEAN, "utf8");
    ws.reloadConfig();
    expect(ws.configDiscards).toBeUndefined();
    fs.writeFileSync(file, `${FILE_CLEAN}  companion:\n    allowedHost: [example.com]\n`, "utf8");
    ws.reloadConfig();
    expect(ws.configDiscards?.signature).toBe(second);
    expect((await buildSidebarFleet(fleetSource(ws, tmux))).configDiscards?.signature).toBe(second);
  });

  it("the dismiss gesture accepts only a signature", () => {
    expect(isSidebarMutationInputV1({ action: "config.dismissDiscards", id: "0123456789abcdef" })).toBe(true);
    // A name, a path, an upper-case digest or an extra field are all refused at the wire, so the
    // engine never resolves a dismissal from anything but the identity the banner rendered.
    expect(isSidebarMutationInputV1({ action: "config.dismissDiscards", id: "tachyon.yml" })).toBe(false);
    expect(isSidebarMutationInputV1({ action: "config.dismissDiscards", id: "0123456789ABCDEF" })).toBe(false);
    expect(isSidebarMutationInputV1({ action: "config.dismissDiscards", id: "0123456789abcdef", extra: 1 })).toBe(false);
  });

  it("a fatal reload keeps the still-running config's discards instead of clearing them", async () => {
    const { ws, file } = await attach(FILE_WITH_DISCARDS);
    const signature = ws.configDiscards!.signature;

    // Bytes that are not YAML: one of the two fatals t-48dd8d left standing. The previously loaded
    // config keeps running, so the record of what IT discarded is still true.
    fs.writeFileSync(file, "agents: [unclosed\n", "utf8");
    ws.reloadConfig();
    expect(ws.configFailure).toBeDefined();
    expect(ws.configDiscards?.signature).toBe(signature);
  });
});
