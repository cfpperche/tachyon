import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveAgentProfileHomeDir, Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { ResumeUnavailableError } from "@tachyon/engine/agents/AgentManager.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { registerTools, type NotifyLevel } from "@tachyon/engine/bridge/tools.js";
import { ActivityLog, agentLogId } from "@tachyon/engine/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile, spawnSettingsPath } from "@tachyon/engine/activity/sessionOwners.js";
import { ReloadTransactionStore } from "@tachyon/engine/host-action/index.js";
import { __createdTerminals, __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-35c998 — the launch preflight, made hermetic. Production's opencode adapter answers "is this
 * authenticated?" by running `opencode providers list`, which is correct there and wrong here: it
 * made every `cmd: opencode` spawn in this file execute an installed CLI, the machine-dependence
 * SDD 387 forbids. The stub answers as a credentialed home does, so those spawns behave exactly as
 * they did before; every other adapter stays the real, non-executing one.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();
import { Terminals } from "../../src/presentation/Terminals.js";
import type { TerminalPresentationOptions } from "@tachyon/engine/workspace/TerminalPresentation.js";
import { harnessHome, harnessRoot } from "@tachyon/engine/harness/HarnessManager.js";
import { parse as parseYaml, stringify } from "yaml";
import { serializeAgentProfileAuthorityRegistry } from "@tachyon/engine/config/agentProfileAuthority.js";
import type { AgentProfileStudioMutationV1 } from "@tachyon/shared/config/agentProfileStudio.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR } from "@tachyon/engine/config/agentProfileProjection.js";
import { agentProfileAuthoritiesSecretKey, workspaceVersionStateKey } from "@tachyon/engine/workspace/operationalStateKeys.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml, type SavedAgentSpec } from "../helpers/savedAgentFixture.js";
import { asAgent, composeCommand } from "@tachyon/engine/config/loadConfig.js";
import { composeAgentPrompt } from "@tachyon/engine/agents/promptLayers.js";
import { executeExtensionCommand } from "@tachyon/engine/engine-service/extensionOperationService.js";
import { parseExtensionCommandV1, type ExtensionCommandV1 } from "@tachyon/engine/runtime-api/extensionOperations.js";
import type { NoticeQueueMetadata } from "@tachyon/engine/bridge/NoticeQueue.js";

/**
 * spec 235 — the headless Workspace smoke test (the deferred spec-233 payoff): drive the orchestrator with
 * NO Electron, NO real tmux, NO bound Bridge port — proving config → managers → monitors → factory
 * lifecycle are wired together correctly. Substrate is injected via `Workspace.createForTest`.
 */

/**
 * Substrate, not subject: the harness materializer needs a credential FILE to link, nothing more.
 *
 * t-a12966 injected claude and codex. t-b10d93 added opencode, which had stayed declared-and-skipped
 * on the grounds that its preflight runs the installed runtime — true of the preflight, and stubbed
 * out above (`HERMETIC_PREFLIGHT`) since t-35c998. The door still refusing was
 * `HarnessManager.materializeHome`, which copies `<XDG_DATA_HOME>/opencode/auth.json` and fails closed
 * when it is absent: substrate, and a fixture supplies it. All three run on any machine now.
 */
useDisposableRuntimeAuth(["claude", "codex", "opencode"]);

describe("resolveAgentProfileHomeDir", () => {
  it("uses an isolated absolute home only inside Dev Host", () => {
    expect(resolveAgentProfileHomeDir(undefined, {
      TACHYON_DEV_HOST: "1",
      TACHYON_DEV_HOST_PROFILE_HOME: "/tmp/dev-host-profile-home",
    })).toBe("/tmp/dev-host-profile-home");
    expect(resolveAgentProfileHomeDir(undefined, {
      TACHYON_DEV_HOST_PROFILE_HOME: "/tmp/dev-host-profile-home",
    })).toBeUndefined();
    expect(resolveAgentProfileHomeDir(undefined, {
      TACHYON_DEV_HOST: "1",
      TACHYON_DEV_HOST_PROFILE_HOME: "relative/home",
    })).toBeUndefined();
    expect(resolveAgentProfileHomeDir("/explicit/test-home", {})).toBe("/explicit/test-home");
  });
});

/** In-memory EngineHost — every host touchpoint is a no-op/recorder; the engine can't tell it isn't vscode. */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel; actions: NoticeAction[] }[] = [];
  readonly watches: Array<{ root: string; glob: string; events: WatchEvents; onEvent: () => void; disposed: boolean }> = [];
  private readonly stateMap = new Map<string, unknown>();
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.notices.push({ message, level, actions: [...actions] });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): { dispose(): void } {
    const watch = { root, glob, events, onEvent, disposed: false };
    this.watches.push(watch);
    return { dispose() { watch.disposed = true; } };
  }
  gitExtensionPath(): string | string[] | undefined {
    const configured = this.settings["git.path"];
    return typeof configured === "string" || Array.isArray(configured) ? configured as string | string[] : undefined;
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
  createTerminalPresentation(options: TerminalPresentationOptions): Terminals {
    return new Terminals(options.onReveal, options.kindOf, options.manifest);
  }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string, private readonly settings: Record<string, unknown> = {}) {}
}

class SharedSecretHost extends FakeHost {
  constructor(storageDir: string, private readonly backend: Map<string, string>, settings: Record<string, unknown> = {}) {
    super(storageDir, settings);
  }
  override getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.backend.get(key));
  }
  override setSecret(key: string, value: string): Promise<void> {
    this.backend.set(key, value);
    return Promise.resolve();
  }
}

/** fake-exec tmux: a real TmuxService whose command channel is a fake (same pattern as the manager suites). */
function fakeTmux(opts: {
  realPaneProcesses?: boolean;
  /**
   * t-28bf8f — the measured race: `kill-session` returns while the pane's root process is still
   * alive in the checkout. Real tmux does this whenever the process outlives its own session
   * (reparented, or a shutdown that takes longer than the call), which is exactly the state
   * `refreshWorktreeOccupancy` was taught to quarantine on. With this set the child is left running
   * and stays in `children`, so the case can end it deliberately and watch the retry succeed.
   */
  orphanPaneProcesses?: boolean;
  onExec?: (args: string[]) => void;
} = {}) {
  const sessions = new Set<string>();
  /** `${session}\0${key}` → value, mirroring tmux's per-session environment. */
  const sessionEnv = new Map<string, string>();
  const dead = new Map<string, number>();
  const sent = new Map<string, string>(); // session -> last literal send-keys text (spec 332 death-poke assertions)
  const pasteBuffers = new Map<string, string>();
  const panes = new Map<string, string>();
  const calls: string[][] = [];
  const children = new Map<string, ChildProcess>();
  const waitForExit = (child: ChildProcess) => new Promise<void>((resolve) => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
  const stop = async (name: string) => {
    const child = children.get(name);
    if (child?.exitCode === null) { child.kill("SIGKILL"); await waitForExit(child); }
    children.delete(name);
  };
  const replacePaneProcess = async (name: string, cwd?: string) => {
    // The cwd matters to exactly one reader and only when a case asks for it: `probeRememberedRootProcess`
    // re-establishes "is this pid still in THAT checkout?" through /proc/<pid>/cwd. Undefined inherits,
    // byte-identical to every pre-existing caller.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", ...(cwd ? { cwd } : {}) });
    children.set(name, child);
    return child;
  };
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    // t-d06da3 — a seam for cases whose subject is what happens when a tmux command FAILS partway
    // through a launch. Default undefined, so every existing case is byte-identical.
    opts.onExec?.(args);
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.add(name);
      // t-fab832 — record the session environment the real tmux would keep, so `show-environment`
      // can answer with the attestation this build mints at creation.
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-e") continue;
        const eq = (args[i + 1] ?? "").indexOf("=");
        if (eq > 0) sessionEnv.set(`${name}\u0000${args[i + 1]!.slice(0, eq)}`, args[i + 1]!.slice(eq + 1));
      }
      panes.set(name, "");
      if (opts.realPaneProcesses) await replacePaneProcess(name, args.includes("-c") ? args[args.indexOf("-c") + 1] : undefined);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "show-environment") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      const lines = [...sessionEnv].filter(([k]) => k.startsWith(`${name}\u0000`))
        .map(([k, v]) => `${k.slice(name.length + 1)}=${v}`);
      return { stdout: lines.join("\n"), stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session"); // non-zero exit = does not exist
    }
    if (args[2] === "list-panes") {
      // t-4736b4 — real tmux answers a down server with `error connecting to <socket> (No such file
      // or directory)`, which `sessionStates` classifies as a CONFIRMED zero sessions. The bare
      // "no server" this fake used matches none of those patterns, so it modelled an AMBIGUOUS
      // failure instead — the one condition where the inventory cannot be measured. That mismatch was
      // invisible while `agentStates()` covered a null read with its last-known-good snapshot; the
      // removal path reads the ambiguity directly, so the fixture has to tell the truth.
      if (sessions.size === 0) throw new Error("error connecting to /tmp/tmux-1000/fake (No such file or directory)");
      return { stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys" && args.includes("-l")) {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      sent.set(name, args[args.length - 1]);
    }
    if (args[2] === "load-buffer") {
      const buffer = args[args.indexOf("-b") + 1];
      pasteBuffers.set(buffer, fs.readFileSync(args.at(-1)!, "utf8"));
    }
    if (args[2] === "paste-buffer") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      const buffer = args[args.indexOf("-b") + 1];
      sent.set(name, pasteBuffers.get(buffer) ?? "");
      if (args.includes("-d")) pasteBuffers.delete(buffer);
    }
    if (args[2] === "delete-buffer") pasteBuffers.delete(args[args.indexOf("-b") + 1]);
    if (args[2] === "capture-pane") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      return { stdout: panes.get(name) ?? "", stderr: "" };
    }
    if (args.includes("display-message")) {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      const child = children.get(name);
      return { stdout: child?.pid ? `${child.pid}\n` : "", stderr: "" };
    }
    if (args[2] === "kill-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (!opts.orphanPaneProcesses) await stop(name);
      sessions.delete(name);
      dead.delete(name);
      panes.delete(name);
    }
    if (args[2] === "rename-session") {
      const oldName = args[args.indexOf("-t") + 1].replace(/^=/, "");
      const newName = args.at(-1)!;
      if (!sessions.has(oldName) || sessions.has(newName)) throw new Error("rename conflict");
      sessions.delete(oldName);
      sessions.add(newName);
      if (dead.has(oldName)) { dead.set(newName, dead.get(oldName)!); dead.delete(oldName); }
      if (panes.has(oldName)) { panes.set(newName, panes.get(oldName)!); panes.delete(oldName); }
      const child = children.get(oldName);
      if (child) { children.delete(oldName); children.set(newName, child); }
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sessionEnv, dead, sent, panes, calls, children, replacePaneProcess, stop, cleanup: async () => { await Promise.all([...children.keys()].map(stop)); }, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ws-headless-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * SDD 478 M7 — declare Saved agents inside a root the case built itself, and return the host
 * that attests them. Same shape `makeWorkspace({ canonical })` builds, for the many cases that need
 * to write their own `tachyon.yml` tail (settings, verify blocks) or their own Workspace deps.
 */
function canonicalHost(
  root: string,
  agents: ReadonlyArray<{ name: string; spec?: SavedAgentSpec }>,
  extraYaml = "",
  settings: Record<string, unknown> = {},
): { host: SharedSecretHost; secrets: Map<string, string> } {
  const fixtures = agents.map((entry) => writeSavedAgent(root, entry.name, entry.spec ?? {}));
  fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml(fixtures) + extraYaml, "utf8");
  const secrets = savedAgentSecrets(root, fixtures);
  return { host: new SharedSecretHost(mkdir(), secrets, settings), secrets };
}

/** SDD 494 Part 0 — reproduce claude23's refusal without reading host runtime state. */
async function refusedSavedAgentWorkspace() {
  const root = mkdir();
  const homeDir = mkdir();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2),
  );
  const permissions = {
    source: "global",
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: ["fresh", "restart", "resume", "fork"],
  };
  const { host } = canonicalHost(root, [
    {
      name: "claude",
      spec: {
        runtime: "claude",
        extra: {
          grants: { proposeSavedAgent: true },
          nativeConfig: { permissions: { ...permissions, authorize: ["bypassPermissions"] } },
        },
      },
    },
    {
      name: "claude23",
      spec: { runtime: "claude", extra: { nativeConfig: { permissions } } },
    },
  ]);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  expect(asAgent(ws.config?.agents.claude)?.profileLifecycle).toBeDefined();
  expect(ws.config?.agents.claude23).toBeUndefined();
  expect(ws.refusedAgents().claude23).toContain("'bypassPermissions' is not projectable");
  return { root, ws, fake };
}

/**
 * SDD 494 Part 4 — the same `claude23` shape, with ONE owner's record withheld.
 *
 * Each variant is a row of the resolution table in `spec.md`, built through the real loader rather
 * than by handing the derivation a literal. `refused` is the shape the live workspace is in today:
 * every record present, the runtime projection refused by spec 471.
 */
async function savedAgentStateWorkspace(
  withheld: "refused" | "roster-row" | "profile" | "authority" | "roster-row-and-profile" | "everything-but-the-home",
): Promise<{ root: string; ws: Workspace }> {
  const root = mkdir();
  const homeDir = mkdir();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2),
  );
  const permissions = {
    source: "global",
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: ["fresh", "restart", "resume", "fork"],
  };
  const fixtures = [
    writeSavedAgent(root, "claude", {
      runtime: "claude",
      extra: { nativeConfig: { permissions: { ...permissions, authorize: ["bypassPermissions"] } } },
    }),
    writeSavedAgent(root, "claude23", { runtime: "claude", extra: { nativeConfig: { permissions } } }),
  ];
  const withoutSubject = fixtures.filter((entry) => entry.name !== "claude23");
  const homeOnly = withheld === "everything-but-the-home";
  const profileHidden = withheld === "profile" || withheld === "roster-row-and-profile";
  // t-ae221c — the `agents:` block is written in full every time on purpose. It is retired: it can
  // no longer grant or withhold a roster row, and every fixture below proves that by producing its
  // state through the DIRECTORY while this block still names claude23.
  fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml(fixtures), "utf8");
  if (profileHidden) fs.rmSync(path.join(root, ".tachyon", "agents", "claude23"), { recursive: true, force: true });
  // The one way a roster row can still be withheld while the bytes stay: an `agent.yml` that is on
  // disk and cannot be read. A directory in its place is the deterministic version of that.
  if (withheld === "roster-row") {
    const file = path.join(root, ".tachyon", "agents", "claude23", "agent.yml");
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  // t-8b58b3 — the residue O1/O2/O3 leave: the DIRECTORY survives and everything that names it does
  // not. Unlinking only `agent.yml` is exactly what `removeAgentProfileIfExact` used to do, so this
  // fixture is the rolled-back create as it reached disk, not a shape invented for the assertion.
  if (homeOnly) fs.unlinkSync(path.join(root, ".tachyon", "agents", "claude23", "agent.yml"));
  const secrets = savedAgentSecrets(root, withheld === "authority" || homeOnly ? withoutSubject : fixtures);
  const host = new SharedSecretHost(mkdir(), secrets, {});
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  return { root, ws };
}

async function makeWorkspace(
  onViewsChanged: (view: ViewKind) => void = () => {},
  opts: {
    /** make `b` a real agent on this runtime instead of a supervised shell. */
    bRuntime?: SavedAgentSpec["runtime"];
    tachyonYaml?: string;
    canonical?: ReadonlyArray<{ name: string; spec?: SavedAgentSpec }>;
    extraYaml?: string;
  } = {},
) {
  const root = mkdir();
  // SDD 478 M7 — a case that needs a real AGENT declares one: a canonical profile plus the
  // host-custodied authority that attests it. `agents:` no longer accepts a definition.
  if (opts.canonical) {
    const fixtures = opts.canonical.map((entry) => writeSavedAgent(root, entry.name, entry.spec ?? {}));
    fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml(fixtures) + (opts.extraYaml ?? ""), "utf8");
    const host = new SharedSecretHost(mkdir(), savedAgentSecrets(root, fixtures));
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    return { ws, host, ...fake };
  }
  // `a` autostarts (exercises the start() launch path); `b` is launched explicitly via the manager.
  // SDD 478 M7 — `a` and `b` are supervised SHELLS, so they are terminals. They were only agents
  // because `allowLegacyAgentFixtures` accepted an inline shape the product refuses; nothing here
  // exercises an agent capability, so declaring them honestly costs the cases nothing. A case that
  // does need `b` to be an agent asks for `bRuntime`, which declares it canonically.
  const terminals = `terminals:\n  a:\n    cmd: sh\n    autostart: true\n${opts.bRuntime ? "" : "  b:\n    cmd: sh\n"}`;
  const bAgent = opts.bRuntime ? [writeSavedAgent(root, "b", { runtime: opts.bRuntime })] : [];
  fs.writeFileSync(path.join(root, "tachyon.yml"), opts.tachyonYaml ?? savedAgentsYaml(bAgent) + terminals, "utf8");
  const host = new SharedSecretHost(mkdir(), savedAgentSecrets(root, bAgent));
  const { tmux, sessions, sessionEnv, dead, sent, panes, calls } = fakeTmux();
  // SDD 368 T14/R4 — createForTest alone yields a ready empty snapshot; callers that need
  // start()-side autostart/rehydrate must call start() explicitly (pre-R3 helper semantics).
  const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  return { ws, host, tmux, sessions, sessionEnv, dead, sent, panes, calls };
}

it("t-8168a7 review: durable turn evidence is positive only for the current session", async () => {
  const { ws } = await makeWorkspace();
  try {
    const agent = "b";
    const currentSession = "current-session";
    ws.ledger.record(agent, {
      cwd: ws.workspaceRoot,
      updatedAt: "test",
      resume: { runtime: "codex", sessionId: currentSession },
    });
    const log = new ActivityLog(path.join(ws.workspaceRoot, ".tachyon", "activity"), agent);
    const message = (sessionId: string, text: string) => ({
      type: "assistant.message.completed" as const,
      runtime: "codex" as const,
      sequence: 1,
      sessionId,
      payload: { text },
      raw: {},
    });
    const subject = ws as unknown as { hasDurableTurnEvidence(agent: string): boolean };

    log.appendRecord([message("old-session", "old incarnation")], { runtime: "codex", sessionId: "old-session", recordId: "old" }, "2026-08-06T00:00:00Z");
    expect(subject.hasDurableTurnEvidence(agent)).toBe(false);

    log.appendRecord([message(currentSession, "finished current turn")], { runtime: "codex", sessionId: currentSession, recordId: "current" }, "2026-08-06T00:01:00Z");
    expect(subject.hasDurableTurnEvidence(agent)).toBe(true);
  } finally {
    ws.dispose();
  }
});

it("t-6f0377 defers one replaceable context-renewal gesture until idle", async () => {
  const { ws, sent } = await makeWorkspace(() => {}, { bRuntime: "codex" });
  await ws.manager.spawn("b");
  const subject = ws as unknown as {
    requestContextCompaction(agent: string): Promise<{ status: string; replaced?: string }>;
    requestFreshContext(agent: string): Promise<{ status: string; replaced?: string }>;
    recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
  };

  expect(await subject.requestContextCompaction("b")).toEqual({ status: "pending" });
  expect(sent.get(ws.manager.session("b"))).not.toBe("/compact");
  expect(await subject.requestFreshContext("b")).toEqual({ status: "pending", replaced: "compact" });

  await subject.recoverOnIdle("b", false);
  expect(sent.get(ws.manager.session("b"))).toBe("/new");
  await subject.recoverOnIdle("b", false);
  expect(sent.get(ws.manager.session("b"))).toBe("/new");
  ws.dispose();
});

it("t-6f0377 refuses an unmeasured runtime by name", async () => {
  const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: "other", spec: { runtime: "pi" } }] });
  await ws.manager.spawn("other");
  const subject = ws as unknown as { requestContextCompaction(agent: string): Promise<unknown> };
  await expect(subject.requestContextCompaction("other")).rejects.toThrow(/runtime 'pi'.*no measured compact gesture/);
  ws.dispose();
});

it("discards an unreadable key on reload instead of taking the workspace down", async () => {
  // SDD 478 M7 — this used to prove that a rejected edit leaves the last known-good config live, with
  // an unreadable `restart` standing in for the retired inline identity field.
  //
  // t-48dd8d moved that boundary. A key the loader cannot read no longer refuses the FILE: it is
  // discarded, the rest of the workspace loads, and `restart` falls to `never` — the closed side,
  // since an agent that does not restart itself is the conservative reading of a broken policy. That
  // is the whole owner decision of 2026-08-07, and this is where a reader will look for it.
  const { ws } = await makeWorkspace(() => {}, { tachyonYaml: "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n    restart: on-crash\n" });
  expect(ws.config?.agents.dev.restart).toBe("on-crash");
  fs.writeFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n    restart: sometimes\n", "utf8");

  expect(ws.reloadConfig()).toBe(true);
  expect(ws.configFailure).toBeUndefined();
  expect(ws.config?.agents.dev.restart).toBe("never");
  ws.dispose();
});

it("still retains the prior known-good config when the file cannot be read at all", async () => {
  // The other half of the same boundary, and the reason the LKG snapshot still exists: bytes that are
  // not YAML leave nothing to salvage, so the reload is refused and the live config is untouched.
  const { ws } = await makeWorkspace(() => {}, { tachyonYaml: "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n    restart: on-crash\n" });
  expect(ws.config?.agents.dev.restart).toBe("on-crash");
  fs.writeFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "terminals: [unclosed\n", "utf8");

  expect(ws.reloadConfig()).toBe(false);
  expect(ws.configFailure?.errors[0]).toContain("invalid YAML");
  expect(ws.config?.agents.dev.restart).toBe("on-crash");
  expect(ws.readConfigLkg()?.agents.map((agent) => agent.name)).toContain("dev");
  ws.dispose();
});

it("t-af6803 isolates one invalid profile without invalidating or stopping the healthy fleet", async () => {
  const root = mkdir();
  const fixtures = [writeSavedAgent(root, "healthy"), writeSavedAgent(root, "broken")];
  fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml(fixtures), "utf8");
  const host = new SharedSecretHost(mkdir(), savedAgentSecrets(root, fixtures));
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
  try {
    await ws.manager.spawn("healthy");
    const healthySession = ws.manager.session("healthy");
    expect(fake.sessions.has(healthySession)).toBe(true);

    const brokenPath = path.join(root, ".tachyon", "agents", "broken", "agent.yml");
    fs.writeFileSync(brokenPath, fs.readFileSync(brokenPath, "utf8").replace("schemaVersion: 1", "schemaVersion: 2"));

    expect(ws.reloadConfig()).toBe(true);
    expect(ws.configFailure).toBeUndefined();
    expect(ws.config?.agents.healthy).toBeDefined();
    expect(ws.config?.agents.broken).toBeUndefined();
    expect(fake.sessions.has(healthySession)).toBe(true);
    expect(ws.refusedAgents().broken).toMatch(/profile\/schema: schemaVersion/);
    expect(() => ws.assertNotLkgOnlySpawn("healthy")).not.toThrow();
    expect(() => ws.assertNotLkgOnlySpawn("broken")).toThrow(/profile\/schema: schemaVersion/);
  } finally {
    ws.dispose();
  }
});

it("loads a canonical agent profile only after host-custodied authority is available", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  const profileDir = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(profileDir, { recursive: true });
  const profile = stringify({
    schemaVersion: 1,
    agentId: "11111111-1111-4111-8111-111111111111",
    runtime: { adapter: "codex", executable: "codex" },
    displayName: "Reviewer",
  });
  fs.writeFileSync(path.join(profileDir, "agent.yml"), profile);
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\nsettings:\n  auth: false\n",
  );
  const secrets = new Map<string, string>();
  secrets.set(agentProfileAuthoritiesSecretKey(workspaceHash(root)), serializeAgentProfileAuthorityRegistry(new Map([
    ["codex", {
      schemaVersion: 1,
      agentName: "codex",
      agentId: "11111111-1111-4111-8111-111111111111",
      revision: "profile-r1",
      canonicalSha256: createHash("sha256").update(profile).digest("hex"),
      runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
    }],
  ])));
  const host = new SharedSecretHost(mkdir(), secrets);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    expect(ws.configFailure).toBeUndefined();
    expect(ws.config?.agents.codex).toMatchObject({ cmd: "codex" });
    expect((ws.config as unknown as { agentSources: Record<string, { mode: string }> }).agentSources.codex?.mode).toBe("profile");
    expect(ws.authEnabled).toBe(false);
    expect(ws.readConfigLkg()?.agents.find((agent) => agent.name === "codex")).toMatchObject({
      sourceMode: "profile",
      agentId: "11111111-1111-4111-8111-111111111111",
      authorityRevision: "profile-r1",
      profileSha256: createHash("sha256").update(profile).digest("hex"),
    });
    const profileWatch = host.watches.find((watch) => watch.glob === ".tachyon/agents/*/agent.yml");
    expect(profileWatch).toBeTruthy();
    fs.writeFileSync(path.join(profileDir, "agent.yml"), profile.replace("Reviewer", "Coder"));
    profileWatch!.onEvent();
    expect(ws.configFailure?.errors.join("\n")).toContain("profile/authority-boundary");
    expect(ws.config?.agents.codex?.cmd).toBe("codex");
    expect(() => ws.assertNotLkgOnlySpawn("codex")).toThrow("trusted configuration is invalid");
  } finally {
    ws.dispose();
  }
});

/**
 * t-bd14d8 — a file watch is a Terminal capability, measured through the door that ACTS on it.
 *
 * `rebuildWatches` turns every glob it finds into `restart(agent, { stop: "force", session: "new" })`
 * — force-kill plus a fresh session, which is the feature for `bun run dev` and the erasure of an
 * agent's transcript for anything else. The loop reads `config.agents`, the UNIFIED map, and had no
 * arm for kind, so a `lifecycle.watch` left in an older profile reached the terminal behaviour.
 *
 * Asserted on `host.watches`, not on a config field: what matters is whether a WATCHER exists, and a
 * projection that stripped the value while some other producer re-added it would still register one.
 * The terminal half is in the same case on purpose — a guard that silences both kinds would pass
 * every agent assertion here and break the feature it was told not to touch.
 *
 * Watched fail on the pre-fix tree: `src/**` was watched for the agent too, and the roster carried
 * `watch: ["src/**"]` on it.
 */
it("t-bd14d8: an agent's legacy lifecycle.watch registers no watcher and is warned about; a terminal's still does", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  const { host } = canonicalHost(
    root,
    [{ name: "codex", spec: { extra: { lifecycle: { watch: ["src/**", "package.json"] } } } }],
    "terminals:\n  dev:\n    cmd: npm run dev\n    watch: \"src/**\"\nsettings:\n  auth: false\n",
  );
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    expect(ws.configFailure).toBeUndefined();
    // The agent still LOADS — the stale key is stripped, never a refusal (t-48dd8d: invalid config
    // warns and does not trap). An agent that vanished from the roster would be the worse answer.
    expect(asAgent(ws.config?.agents.codex)).toMatchObject({ cmd: "codex", watch: [] });
    // Read raw, not through `asAgent`: that helper narrows to an AgentEntry and answers undefined
    // for a terminal, which would pass this assertion for the wrong reason.
    expect(ws.config?.agents.dev).toMatchObject({ kind: "terminal", watch: ["src/**"] });

    // The real registrar, called by every config-load path (`start`, the tachyon.yml change hook,
    // `mutateConfig`). `createForTest` stops short of `start()`, so the case drives it directly
    // rather than asserting on a config field that no watcher was ever built from.
    ws.rebuildWatches();
    const watched = host.watches.filter((watch) => watch.glob === "src/**" || watch.glob === "package.json");
    // Exactly one: the terminal's. The agent contributed two globs to the pre-fix tree.
    expect(watched.map((watch) => watch.glob)).toEqual(["src/**"]);

    const warning = host.notices.find((notice) => notice.message.includes("lifecycle.watch is ignored"));
    expect(warning, "a dropped watch must be named, not silently ignored").toBeTruthy();
    expect(warning!.message).toContain("src/**, package.json");
    expect(warning!.message).toContain("terminals:");
  } finally {
    ws.dispose();
  }
});

it("creates, edits and disables a canonical profile through the Workspace lifecycle boundary", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.mkdirSync(path.join(homeDir, ".codex"));
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), 'model = "ambient-model"\n');
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    expect(ws.config?.agents.reviewer).toMatchObject({ cmd: "codex" });
    const edited = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "edit",
      expectedRevision: created.revision,
      patch: { displayName: "Review Agent" },
    });
    expect((await ws.inspectAgentProfileLifecycle("reviewer")).profile.displayName).toBe("Review Agent");
    await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "set-enabled",
      expectedRevision: edited.revision,
      enabled: false,
    });
    expect(asAgent(ws.config?.agents.reviewer)?.profileLifecycle?.enabled).toBe(false);
    await expect(ws.manager.spawn("reviewer")).rejects.toThrow("canonical agent profile is disabled");
    expect(fake.sessions.size).toBe(0);
  } finally {
    ws.dispose();
  }
});

/**
 * t-afc86e — the ROUND TRIP, and the reason this slice exists at all.
 *
 * A verify gate and a setup list are stored as pinned profile-local documents and referenced by id.
 * The form authors TEXT. So every save has to write bytes + digest + reference in one transaction,
 * and every open has to read those bytes back — and the failure mode if the read-back is missing is
 * silent and destructive: the field renders blank for an agent that HAS a gate, and the very next
 * save writes the blank over it. Nothing throws, nothing warns, the gate is simply gone.
 *
 * That is the t-bd14d8 watch trap inverted. There a stale value survived every edit and could never
 * leave; here a live value would leave on every edit without anyone asking for it. So the assertion
 * that matters is not "a save can write a verify" — it is this one: write it, close, reopen, save
 * again WITHOUT touching the field, and it is still there.
 *
 * Driven through `commitAgentProfileStudio` / `inspectAgentProfileStudio` — the doors the webview
 * actually calls — and checked on DISK as well as in the projection, because a projection that
 * happened to echo its input back would pass while the file said something else.
 */
it("t-afc86e: an agent's setup commands survive a save that does not touch them", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  const editable = (over: Partial<AgentProfileStudioMutationV1["editable"]> = {}): AgentProfileStudioMutationV1["editable"] => ({
    displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" },
    cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
    worktree: { enabled: true, branch: "", setup: ["python -m venv .venv", "pip install -e ."] },
    instructions: "", isolation: "",
    ...over,
  });

  try {
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", editable: editable(),
    });
    // 1. The save round-trips into the projection the form is rebuilt from.
    expect(created.editable.worktree.setup).toEqual(["python -m venv .venv", "pip install -e ."]);

    // 2. And it is really on disk, as pinned documents the profile names by reference.
    const profileDir = path.join(root, ".tachyon", "agents", "reviewer");
    expect(fs.readFileSync(path.join(profileDir, "workspace-setup"), "utf8")).toBe("python -m venv .venv\npip install -e .\n");
    const stored = parseYaml(fs.readFileSync(path.join(profileDir, "agent.yml"), "utf8")) as Record<string, never>;
    expect(stored.workspace).toMatchObject({ worktree: { setup: ["workspace-setup"] } });

    // 3. The projection RUNS it: this is what `runWorktreeSetup` consumes.
    expect(asAgent(ws.config?.agents.reviewer)?.worktreeSetup).toEqual(["python -m venv .venv", "pip install -e ."]);

    // 4. THE ONE THAT MATTERS. Reopen and save an unrelated edit, exactly as a human would: the form
    //    refills itself from the snapshot, so whatever the snapshot did not carry gets written back
    //    as blank. Nothing here mentions setup except reading it out of the snapshot.
    const reopened = await ws.inspectAgentProfileStudio("reviewer");
    const untouched = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", expectedRevision: reopened.revision,
      editable: { ...reopened.editable, displayName: "Renamed Reviewer" },
    });
    expect(untouched.editable.displayName).toBe("Renamed Reviewer");
    expect(untouched.editable.worktree.setup).toEqual(["python -m venv .venv", "pip install -e ."]);

    // 5. Clearing is still possible — the field is editable, not merely persistent. The reference and
    //    the workspace key both leave the profile; an unreferenced file on disk reads to nobody.
    const cleared = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", expectedRevision: untouched.revision,
      editable: { ...untouched.editable, worktree: { ...untouched.editable.worktree, setup: [] } },
    });
    expect(cleared.editable.worktree.setup).toEqual([]);
    const afterClear = parseYaml(fs.readFileSync(path.join(profileDir, "agent.yml"), "utf8")) as { workspace?: Record<string, unknown>; references?: unknown[] };
    expect(afterClear.references ?? []).toEqual([]);
  } finally {
    ws.dispose();
  }
});

/**
 * t-d48775 — persistent instructions, WRITTEN through the product and READ BACK after a restart.
 *
 * The defect this closes was not a missing control. `prompt.instructions` naming a pinned
 * `instructions.md` was in the schema from the start; the portable-bundle importer wrote it; the
 * Agent Studio field rendered with an inviting placeholder. What was missing was a writer the human
 * could reach and a reader on the other end — the projection REFUSED any canonical profile carrying
 * the binding, so the one existing writer produced an agent that dropped off the roster.
 *
 * That is why a test that only proves the write proves nothing here. Each leg below is a place the
 * old code stopped:
 *
 *  1. the save reaches the FILE, in the documented format — not a new key of our own
 *  2. the snapshot carries the TEXT back, so reopening the form shows it instead of a blank box that
 *     the next save would write over the real bytes
 *  3. a SECOND Workspace over the same durable state — a window reload, the closest thing to restart
 *     this harness has — still projects it
 *  4. and the projection puts it where the runtime actually reads it: `AgentEntry.instructions`,
 *     which `composeCommand` turns into the launch argument and `composeAgentPrompt` counts in the
 *     manifest. This is the leg that was empty before: bytes on disk are not delivery.
 *
 * Then the negative halves, because "it works" is only half a contract: an unrelated save must not
 * erase them, and clearing the box must remove the binding rather than leave a pin with no document.
 */
it("t-d48775: persistent instructions written in Agent Studio survive a reload and reach the agent", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const substrate = { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir };
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, substrate);
  const AUTHORED = "you are a code reviewer; read the diff and flag correctness issues";
  const profileDir = path.join(root, ".tachyon", "agents", "reviewer");
  const storedProfile = () => parseYaml(fs.readFileSync(path.join(profileDir, "agent.yml"), "utf8")) as {
    prompt?: Record<string, unknown>;
    references?: Array<Record<string, unknown>>;
  };
  const editable = (over: Partial<AgentProfileStudioMutationV1["editable"]> = {}): AgentProfileStudioMutationV1["editable"] => ({
    displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" },
    cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
    worktree: { enabled: false, branch: "", setup: [] },
    instructions: "", isolation: "",
    ...over,
  });

  let reloaded: Workspace | undefined;
  try {
    // 1. Created with instructions, through the door the webview posts to.
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer",
      editable: editable({ instructions: AUTHORED }),
    });
    expect(created.editable.instructions).toBe(AUTHORED);
    expect(created.bindings.prompt.instructions).toBe(true);
    expect(created.bindings.foreignPersistentInstructions).toBe(false);

    // 2. On disk, in the format the portable bundle already produces and the lane already reads —
    //    a document plus a pinned reference, not a new key in agent.yml.
    expect(fs.readFileSync(path.join(profileDir, "instructions.md"), "utf8")).toBe(`${AUTHORED}\n`);
    expect(storedProfile().prompt).toEqual({ instructions: "persistent-instructions" });
    expect(storedProfile().references).toMatchObject([{
      id: "persistent-instructions", kind: "instructions", scope: "profile",
      path: "instructions.md", mode: "pinned",
      sha256: createHash("sha256").update(`${AUTHORED}\n`).digest("hex"),
    }]);

    // 3. RESTART. A second Workspace over the same root and the same host authority reads only what
    //    is durable — and both halves come back: the form's value, and the agent's.
    reloaded = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, substrate);
    const afterReload = await reloaded.inspectAgentProfileStudio("reviewer");
    expect(afterReload.editable.instructions).toBe(AUTHORED);

    // 4. And it REACHES the agent. `AgentEntry.instructions` is what `AgentManager` composes into
    //    the startup body and what `composeCommand` appends to the launch command; the refusal this
    //    change removes is exactly what kept this field undefined for every agent that can exist.
    const entry = asAgent(reloaded.config?.agents.reviewer);
    expect(entry?.instructions).toBe(`${AUTHORED}\n`);
    expect(composeCommand({ cmd: entry!.cmd, instructions: entry!.instructions })).toContain(AUTHORED);
    expect(composeAgentPrompt({ instructions: entry?.instructions, bridgeGuidance: false }))
      .toMatchObject({ manifest: { persistentInstructions: true } });

    // 5. The PORTABLE BUNDLE still matches the living profile. This is the reason the writer reuses
    //    `prompt.instructions` plus a pinned document instead of inventing a key of its own: export
    //    reads the binding, so a second format would have made the exported bundle describe an agent
    //    that no longer existed. A clone carries the text across into a fresh identity.
    const exported = await ws.exportAgentProfileBundle("reviewer");
    expect(exported.bundle.profile.documents?.instructions?.text).toBe(`${AUTHORED}\n`);
    await ws.cloneAgentProfileAgent("reviewer", "reviewer2");
    expect((await ws.inspectAgentProfileStudio("reviewer2")).editable.instructions).toBe(AUTHORED);

    // 6. An unrelated save must not erase them — the form refills from the snapshot, so anything the
    //    snapshot did not carry would be written back as blank.
    const untouched = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", expectedRevision: afterReload.revision,
      editable: { ...afterReload.editable, displayName: "Renamed Reviewer" },
    });
    expect(untouched.editable.instructions).toBe(AUTHORED);

    // 7. Edited, then cleared. Clearing removes the binding AND the reference — a pin with no
    //    document is the fail-closed state the projection refuses the whole profile over.
    const edited = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", expectedRevision: untouched.revision,
      editable: { ...untouched.editable, instructions: "answer only in Portuguese" },
    });
    expect(edited.editable.instructions).toBe("answer only in Portuguese");
    expect(fs.readFileSync(path.join(profileDir, "instructions.md"), "utf8")).toBe("answer only in Portuguese\n");

    const cleared = await ws.commitAgentProfileStudio({
      schemaVersion: 1, kind: "agent-instance", agentName: "reviewer", expectedRevision: edited.revision,
      editable: { ...edited.editable, instructions: "" },
    });
    expect(cleared.editable.instructions).toBe("");
    expect(cleared.bindings.prompt.instructions).toBe(false);
    expect(storedProfile().prompt).toBeUndefined();
    expect(storedProfile().references ?? []).toEqual([]);
    expect(ws.reloadConfig()).toBe(true);
    expect(asAgent(ws.config?.agents.reviewer)?.instructions).toBeUndefined();
  } finally {
    reloaded?.dispose();
    ws.dispose();
  }
});

/**
 * t-d48775 — the OTHER door onto the same binding, refused where it can be explained.
 *
 * `agent-profile.saved-agent-create` (Saved Agent approval) commits a profile and no profile-local
 * documents. A `prompt.instructions` arriving through it would name a reference nothing satisfies —
 * the schema does catch that, but as a reference-integrity error that never mentions the door the
 * caller actually wanted. Approval's own mutation carries no instructions today; this asserts the
 * refusal a future caller will meet instead of a broken transaction.
 */
it("t-d48775: the Saved Agent creation door refuses instructions it cannot publish a document for", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    await expect(ws.commitSavedAgentCreation({
      agentName: "reviewer",
      createProfile: {
        runtime: { adapter: "codex", executable: "codex" },
        prompt: { instructions: "persistent-instructions" },
        lifecycle: { enabled: true },
      },
    })).rejects.toThrow(/Saved Agent creation door/);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer"))).toBe(false);
  } finally {
    ws.dispose();
  }
});

it("creates and edits canonical Agent Studio profiles through a redacted CAS boundary", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "reviewer",
      editable: {
        displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" },
        cwd: "", lifecycle: { autostart: true, restart: "on-crash", attention: false },
        worktree: { enabled: true, branch: "feature/reviewer", setup: [] }, instructions: "", isolation: "transcript",
      },
    });
    // t-ca9086: human-authorized Studio create writes enabled; start/autostart remain separate.
    expect(created.enabled).toBe(true);
        expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).not.toContain("cmd:");

    const edited = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "reviewer",
      expectedRevision: created.revision,
      editable: {
        displayName: "Review Agent", runtime: { adapter: "codex", executable: "codex" },
        cwd: "", lifecycle: { autostart: true, restart: "on-crash", attention: false },
        worktree: { enabled: true, branch: "feature/reviewer", setup: [] }, instructions: "", isolation: "transcript",
      },
    });
    expect(edited.editable).toMatchObject({ displayName: "Review Agent", runtime: { adapter: "codex", executable: "codex" } });
    await expect(ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "reviewer",
      expectedRevision: created.revision,
      editable: {
        displayName: "Stale", runtime: { adapter: "codex", executable: "codex" },
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
        worktree: { enabled: false, branch: "", setup: [] }, instructions: "", isolation: "",
      },
    })).rejects.toThrow("revision conflict");
    expect((await ws.inspectAgentProfileStudio("reviewer")).editable.displayName).toBe("Review Agent");
  } finally {
    ws.dispose();
  }
});

it("runs canonical Agent Studio lifecycle actions with revision checks and explicit forget confirmation", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  keeper:\n    cmd: sh\nsettings:\n  auth: false\n");
  const ws = await Workspace.createForTest(
    root,
    { host: new SharedSecretHost(mkdir(), new Map()), onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "reviewer",
      editable: {
        displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" },
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
        worktree: { enabled: false, branch: "", setup: [] }, instructions: "", isolation: "",
      },
    });
    // t-05dff5 — a stale revision RESOLVES as a governed refusal instead of rejecting: it is an
    // answer the engine computed for a reader, and only a value survives the engine\u2194shell wire
    // with its classification intact.
    expect(await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: "reviewer",
      expectedRevision: "f".repeat(64),
      enabled: true,
    })).toMatchObject({ kind: "refused", code: "agent-profile/revision-conflict" });
    const enabled = await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: "reviewer",
      expectedRevision: created.revision,
      enabled: true,
    });
    expect(enabled).toMatchObject({ kind: "snapshot", snapshot: { enabled: true } });
    if (enabled.kind !== "snapshot") throw new Error("unreachable");
    const renamed = await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "rename",
      agentName: "reviewer",
      expectedRevision: enabled.snapshot.revision,
      newName: "maintainer",
    });
    expect(renamed).toMatchObject({ kind: "snapshot", snapshot: { agentName: "maintainer", agentId: created.agentId } });
    if (renamed.kind !== "snapshot") throw new Error("unreachable");
    await expect(ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "forget",
      agentName: "maintainer",
      expectedRevision: renamed.snapshot.revision,
      confirmation: "reviewer",
    })).rejects.toThrow("confirmation mismatch");
    const forgotten = await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "forget",
      agentName: "maintainer",
      expectedRevision: renamed.snapshot.revision,
      confirmation: "maintainer",
    });
    expect(forgotten).toEqual({ schemaVersion: 1, kind: "forgotten", agentName: "maintainer", agentId: created.agentId });

    // t-9464ac — the runtime backstop for the untyped boundary. TypeScript already refuses an
    // unrouted variant at compile time (the `never` binding fails at the point of the omission), so
    // this can only be reached by a caller that skipped schema validation. It must name the operation
    // rather than complain about forget confirmation, which is what the old fall-through did and what
    // sent the reviewer looking at the wrong branch.
    await expect(ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "totally-unrouted",
      agentName: "maintainer",
      expectedRevision: "a".repeat(64),
    } as never)).rejects.toThrow(/'totally-unrouted' is not routed/);
  } finally {
    ws.dispose();
  }
});

it("exports, imports and clones portable profiles through the Workspace boundary", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const source = await ws.commitAgentProfileLifecycle({
      agentName: "source",
      operation: "create",
      createProfile: { displayName: "Source", runtime: { adapter: "codex", executable: "codex" } },
    });
    await expect(ws.exportAgentProfileStudioBundle("source", "f".repeat(64))).rejects.toThrow("revision conflict");
    const exported = await ws.exportAgentProfileStudioBundle("source", source.snapshot.revision);
    const cloned = await ws.cloneAgentProfileStudioBundle("source", source.snapshot.revision, "cloned");
    const imported = await ws.importAgentProfileBundle("imported", exported.bytes);

    expect(new Set([source.snapshot.agentId, imported.lifecycle.snapshot.agentId, cloned.lifecycle.snapshot.agentId]).size).toBe(3);
    expect(asAgent(ws.config?.agents.imported)?.profileLifecycle?.enabled).toBe(false);
    expect(asAgent(ws.config?.agents.cloned)?.profileLifecycle?.enabled).toBe(false);
    expect(cloned.bundleSha256).toBe(exported.sha256);
    await expect(ws.manager.spawn("imported")).rejects.toThrow("canonical agent profile is disabled");
  } finally {
    ws.dispose();
  }
});

it("renames a running canonical profile and keeps the same live session through the Workspace transaction boundary", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const secrets = new Map<string, string>();
  const host = new SharedSecretHost(mkdir(), secrets);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    await ws.manager.spawn("reviewer");
    ws.terminals.open("reviewer", ws.manager.session("reviewer"));
    expect(fake.sessions.has(ws.manager.session("reviewer"))).toBe(true);
    await ws.renameAgent("reviewer", "maintainer");

    expect(ws.config?.agents.reviewer).toBeUndefined();
    expect(asAgent(ws.config?.agents.maintainer)?.profileLifecycle).toMatchObject({ agentId: created.snapshot.agentId });
    expect(await ws.inspectAgentProfileLifecycle("maintainer")).toMatchObject({ agentId: created.snapshot.agentId });
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "maintainer", "agent.yml"))).toBe(true);
    expect(fake.sessions.has(ws.manager.session("reviewer"))).toBe(false);
    expect(fake.sessions.has(ws.manager.session("maintainer"))).toBe(true);
    expect(ws.terminals.has("reviewer")).toBe(false);
    expect(ws.terminals.has("maintainer")).toBe(true);
  } finally {
    ws.dispose();
  }
});

it("forgets a stopped canonical profile while preserving its private runtime home", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  keeper:\n    cmd: sh\nsettings:\n  auth: false\n");
  const secrets = new Map<string, string>();
  const host = new SharedSecretHost(mkdir(), secrets);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    ws.ledger.record("reviewer", { cwd: root, updatedAt: "captured", instance: { lifetime: "saved", resumePolicy: "restartable" } });
    const activityDir = path.join(root, ".tachyon", "activity");
    fs.mkdirSync(activityDir, { recursive: true });
    fs.writeFileSync(path.join(activityDir, `${agentLogId("reviewer")}.jsonl`), "owned activity\n");
    const runtimeHome = ws.harness.home("reviewer");
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(runtimeHome, "credentials.json"), "preserve\n");

    const result = await ws.forgetAgentProfileAgent("reviewer");
    await ws.start(); // startup GC must honor the durable retirement receipt

    expect(result.agentId).toBe(created.snapshot.agentId);
    expect(ws.config?.agents.reviewer).toBeUndefined();
    expect(ws.ledger.get("reviewer")).toBeUndefined();
    expect(fs.readFileSync(path.join(runtimeHome, "credentials.json"), "utf8")).toBe("preserve\n");
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer"))).toBe(false);
    expect(fs.readFileSync(path.join(
      root,
      ".tachyon",
      "retired-agent-profiles",
      result.agentId,
      result.txid,
      "runtime-projections",
      "activity.jsonl",
    ), "utf8")).toBe("owned activity\n");
    expect(secrets.get(agentProfileAuthoritiesSecretKey(workspaceHash(root)))).not.toContain('"agentName": "reviewer"');
  } finally {
    ws.dispose();
  }
});

/**
 * SDD 494 Part 0 — every actor and trigger measured in the evidence table has one matching case.
 * The text-editor case is intentionally outside the governed transaction. It remains the unsafe
 * escape hatch. The other four cases prove each product door keeps the refused member addressable.
 */
describe("SDD 494 Part 0 — Saved Agent removal actor x trigger", () => {
  it("Human, Agent Studio x planAgentProfileForget", async () => {
    const { ws } = await refusedSavedAgentWorkspace();
    try {
      const revision = (await ws.inspectAgentProfileLifecycle("claude23")).revision;
      const plan = await ws.planAgentProfileForget("claude23", revision);
      expect(plan.steps.find((entry) => entry.id === "remove-locator")?.state).toBe("will-run");
    } finally {
      ws.dispose();
    }
  });

  it("Human, Agent Studio x forgetAgentProfileAgentCascade", async () => {
    const { root, ws } = await refusedSavedAgentWorkspace();
    try {
      const result = await ws.forgetAgentProfileAgentCascade("claude23");
      expect(result.agentName).toBe("claude23");
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude23"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".tachyon", "canonical-agent-transactions", "forget", result.txid, "journal.json"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("Agent, Bridge x propose_saved_agent_removal", async () => {
    const { root, ws } = await refusedSavedAgentWorkspace();
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (name: string, _schema: unknown, handler: unknown) => { tools.set(name, handler as never); } } as never,
      {
        workspaceRoot: root,
        caller: { kind: "agent", name: "claude" },
        manager: ws.manager,
        inspectSavedAgentProfile: async (name: string) => {
          if (!ws.isSavedAgentMember(name)) return undefined;
          const snapshot = await ws.inspectAgentProfileLifecycle(name);
          return { agentId: snapshot.agentId, revision: snapshot.revision };
        },
      } as never,
    );
    try {
      const result = await tools.get("propose_saved_agent_removal")!({ name: "claude23", rationale: "retire refused fixture" });
      expect(result.isError).toBeFalsy();
    } finally {
      ws.dispose();
    }
  });

  it("Human, sidebar x config.agent.delete", async () => {
    const { root, ws } = await refusedSavedAgentWorkspace();
    try {
      await executeExtensionCommand(
        { workspace: ws, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
        { action: "config.agent.delete", agent: "claude23", removeWorktree: false },
      );
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude23"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".tachyon", "canonical-agent-transactions", "forget"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("Agent or Human x dismiss_agent", async () => {
    const { root, ws } = await refusedSavedAgentWorkspace();
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (name: string, _schema: unknown, handler: unknown) => { tools.set(name, handler as never); } } as never,
      { workspaceRoot: root, caller: { kind: "agent", name: "claude" }, manager: ws.manager } as never,
    );
    try {
      const result = await tools.get("dismiss_agent")!({ name: "claude23" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("propose_saved_agent_removal");
    } finally {
      ws.dispose();
    }
  });

  it("Human, text editor x edit tachyon.yml", async () => {
    const { root, ws } = await refusedSavedAgentWorkspace();
    try {
      const file = path.join(root, "tachyon.yml");
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.replace(/  claude23:\n    profile: .tachyon\/agents\/claude23\/agent.yml\n/u, ""));
      expect(fs.readFileSync(file, "utf8")).not.toContain("claude23:");
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude23", "agent.yml"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });
});

/**
 * t-af4a5f — the same question one row down: who can remove a roster row whose row is a DECLARED
 * TERMINAL, and what does each of them leave behind?
 *
 * The enumeration came before the code, and it is this list of case names:
 *
 *  - **A1 Human, sidebar x config.agent.delete** — `extension.ts:3632` reaches the third arm of
 *    `deleteConfiguredAgent`, the only arm with no governed transaction behind it.
 *  - **A2 Agent or API client, extension.invoke x config.agent.delete** — the SAME arm, reached
 *    without the sidebar and with no section filter. `t-359469` measured this asymmetry on the removed profile door
 *    door: the human path never renders for a terminal and the API path does, so a case that only
 *    drives the button measures the door nobody uses.
 *  - **A3 Agent, Bridge x dismiss_agent** — refused ahead of every side effect.
 *  - **A4 Human or Agent, text editor / write_tachyon_config x edit tachyon.yml** — no door runs at
 *    all. The deliberate escape hatch, and the reason the sweep has to name what it leaves.
 *  - **A5 Tachyon, interruption x between this door's two writes** — the window with no journal, no
 *    lock and no reconcile. Two cases, one per write, because the order between them IS the fix.
 *
 * The removal policy itself is `removeEmptyAgentProfileHome` (`packages/engine/src/config/agentProfileHome.ts`) and
 * is not re-stated here: these cases drive the production door and assert what it leaves on disk,
 * which is the only thing that proves the door reaches the policy at all.
 */
describe("t-af4a5f — declared-terminal roster-row removal actor x trigger", () => {
  const homeOf = (root: string) => path.join(root, ".tachyon", "agents", "b");

  /** A declared terminal `b` that has run once and owns an Agent Profile home. */
  async function terminalWithFootprint() {
    const made = await makeWorkspace();
    const root = made.ws.workspaceRoot;
    await made.ws.manager.spawn("b");
    fs.mkdirSync(homeOf(root), { recursive: true });
    expect(made.ws.config?.agents.b?.kind).toBe("terminal");
    expect(fs.existsSync(homeOf(root))).toBe(true);
    // Measured, and the reason `gcLedger` can never finish this door's work: a declared terminal
    // holds no session-ledger row, so the one startup sweep that runs `forgetAgent` for a name that
    // left `tachyon.yml` never sees this name.
    expect(made.ws.ledger.get("b")).toBeUndefined();
    return { ...made, root };
  }

  const deleteCommand = { action: "config.agent.delete", agent: "b", removeWorktree: false } as const;

  const runDoor = (ws: Workspace, command: ExtensionCommandV1) => executeExtensionCommand(
    { workspace: ws, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
    command,
  );

  /**
   * A5's interruption, injected at exactly the write the measurement names. A crash cannot be staged
   * in-process, and a helper called directly would prove nothing about this door — so the door runs
   * for real and one of its two writes refuses.
   */
  const interruptedAt = (ws: Workspace, method: "forgetAgent" | "deleteTerminalDeclaration"): Workspace =>
    new Proxy(ws, {
      get(target, property, receiver) {
        if (property === method) return () => { throw new Error(`interrupted at ${String(property)}`); };
        const value = Reflect.get(target, property, target);
        void receiver;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Workspace;

  const sweepState = async (ws: Workspace) =>
    (await ws.reconcileSavedAgentRoster()).agents.find((row) => row.agent === "b")?.state;

  it("A1 Human, sidebar x config.agent.delete", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      await runDoor(ws, deleteCommand);
      expect(ws.config?.agents.b).toBeUndefined();
      expect(fs.existsSync(homeOf(root))).toBe(false);
      expect(fs.existsSync(path.join(root, ".tachyon", "pane-transcripts", "b.log"))).toBe(false);
      expect(await sweepState(ws)).toBeUndefined();
    } finally {
      ws.dispose();
    }
  });

  it("A1 Human, sidebar x config.agent.delete, over a home holding a human's notes.md", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      fs.writeFileSync(path.join(homeOf(root), "notes.md"), "# a human note\n");
      await runDoor(ws, deleteCommand);
      expect(ws.config?.agents.b).toBeUndefined();
      // The `rmdir` refuses, which is the guard rather than a check in front of one, so the bytes
      // stay — and since t-8b58b3 what stays is named instead of reported as `absent`.
      expect(fs.readFileSync(path.join(homeOf(root), "notes.md"), "utf8")).toContain("a human note");
      expect(await sweepState(ws)).toBe("orphan-home");
    } finally {
      ws.dispose();
    }
  });

  it("A2 Agent or API client, extension.invoke x config.agent.delete", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      // Through the runtime-api parser an untrusted caller actually goes through: the action is in
      // EXTENSION_COMMAND_ACTIONS and its schema takes any agent name, terminal or not.
      await runDoor(ws, parseExtensionCommandV1({ action: "config.agent.delete", agent: "b", removeWorktree: false }));
      expect(ws.config?.agents.b).toBeUndefined();
      expect(fs.existsSync(homeOf(root))).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  it("A3 Agent, Bridge x dismiss_agent", async () => {
    const { ws, root } = await terminalWithFootprint();
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (name: string, _schema: unknown, handler: unknown) => { tools.set(name, handler as never); } } as never,
      { workspaceRoot: root, caller: { kind: "agent", name: "a" }, manager: ws.manager } as never,
    );
    try {
      const result = await tools.get("dismiss_agent")!({ name: "b" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("config.agent.delete");
      expect(result.content[0]?.text).not.toContain("propose_saved_agent_removal");
      expect(result.content[0]?.text).not.toContain("Agent Studio");
      expect(ws.config?.agents.b?.kind).toBe("terminal");
      expect(fs.existsSync(homeOf(root))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("A4 Human or Agent, text editor x edit tachyon.yml", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      const file = path.join(root, "tachyon.yml");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("  b:\n    cmd: sh\n", ""));
      expect(fs.readFileSync(file, "utf8")).not.toContain("  b:");
      // Nothing runs, by design — and the whole footprint stays. What the product owes this shape is
      // a name for it, which the sweep gives.
      expect(fs.existsSync(homeOf(root))).toBe(true);
      expect(await sweepState(ws)).toBe("orphan-home");
    } finally {
      ws.dispose();
    }
  });

  it("A5 Tachyon, interruption x the footprint write, which must be the FIRST one", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      await expect(runDoor(interruptedAt(ws, "forgetAgent"), deleteCommand)).rejects.toThrow("interrupted at forgetAgent");
      // The whole point of the order: an interruption here may not have spent the roster row. While
      // the entry is still declared the name is listed, addressable, and the retry finishes it —
      // whereas a row deleted first strands the footprint below with no journal and no door.
      expect(ws.config?.agents.b?.kind).toBe("terminal");
      expect(fs.existsSync(homeOf(root))).toBe(true);
      await runDoor(ws, deleteCommand);
      expect(ws.config?.agents.b).toBeUndefined();
      expect(fs.existsSync(homeOf(root))).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  it("A5 Tachyon, interruption x the roster-row write, which must be the LAST one", async () => {
    const { ws, root } = await terminalWithFootprint();
    try {
      await expect(runDoor(interruptedAt(ws, "deleteTerminalDeclaration"), deleteCommand)).rejects.toThrow("interrupted at deleteTerminalDeclaration");
      // The residue this leaves is not residue: a declared terminal with the footprint of one that
      // has never been launched. Nothing on disk needs a door, and the sweep has nothing to report.
      expect(ws.config?.agents.b?.kind).toBe("terminal");
      expect(fs.existsSync(homeOf(root))).toBe(false);
      expect(await sweepState(ws)).toBeUndefined();
      // Idempotent: the second attempt converges instead of failing on the already-cleared half.
      await runDoor(ws, deleteCommand);
      expect(ws.config?.agents.b).toBeUndefined();
    } finally {
      ws.dispose();
    }
  });
});

/**
 * SDD 494 Part 4 — the disagreement, named where a reader already looks.
 *
 * Each case names the row of `spec.md`'s resolution table it measures, and each one is built through
 * the real loader. The `unprojectable` case is the live `claude23`: the workspace agent is NOT
 * touched by this suite, and its own case asserts that reconciliation removed nothing.
 */
describe("SDD 494 Part 4 — the five disagreement states", () => {
  const doorOf = (report: Awaited<ReturnType<Workspace["reconcileSavedAgentRoster"]>>, agent: string) =>
    report.agents.find((row) => row.agent === agent)!;

  it("unprojectable: classifies claude23's exact shape, names the door, and removes nothing", async () => {
    const { root, ws } = await savedAgentStateWorkspace("refused");
    try {
      const report = await ws.reconcileSavedAgentRoster();
      const row = doorOf(report, "claude23");
      expect(row.state).toBe("unprojectable");
      expect(row.member).toBe(true);
      expect(row.facts).toEqual({ rosterRow: true, profileOnDisk: true, authorityRecord: true, projection: false, profileHomeOnDisk: true });
      expect(row.removal.door).toBe("Agent Studio -> Forget (Bridge: propose_saved_agent_removal)");
      expect(row.refusal).toContain("'bypassPermissions' is not projectable");
      // The healthy neighbour is reported as consistent, so the state is a measurement rather than a
      // label every refused workspace gets.
      expect(doorOf(report, "claude").state).toBe("consistent");
      // Read-only: the fixture is the acceptance fixture, and the tool must never be a removal door.
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude23", "agent.yml"))).toBe(true);
      expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toContain("claude23:");
      expect(ws.isSavedAgentMember("claude23")).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("the sidebar row's refusal string names the state and keeps the reason", async () => {
    const { ws } = await savedAgentStateWorkspace("refused");
    try {
      const line = ws.refusedAgents().claude23;
      expect(line.startsWith("unprojectable — the profile and the runtime configuration disagree. ")).toBe(true);
      expect(line).toContain("'bypassPermissions' is not projectable");
    } finally {
      ws.dispose();
    }
  });

  /**
   * t-ae221c — this used to be `orphan-locator`: the `tachyon.yml` pointer survived the directory,
   * so the agent stayed a member with a Forget door. The directory IS the agent now, so removing it
   * removes the agent, and what is left is exactly what `stranded-authority` already names — a host
   * record whose agent is gone.
   *
   * Stated because it costs the human something: there is no product door left for this shape, and
   * the state's own reason says so rather than pretending one exists. `orphan-locator` keeps its arm
   * in the truth table (the derivation stays total) and has no producer through this sweep any more:
   * a roster row now implies a readable `agent.yml`, which is what `profileOnDisk` measures.
   */
  it("t-ae221c: removing the profile home removes the AGENT, leaving a stranded authority", async () => {
    const { root, ws } = await savedAgentStateWorkspace("profile");
    try {
      const row = doorOf(await ws.reconcileSavedAgentRoster(), "claude23");
      expect(row.state).toBe("stranded-authority");
      expect(row.member).toBe(false);
      expect(row.facts).toEqual({ rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: false });
      expect(row.removal.door).toBeNull();
      // The retired block still names it, and that changes nothing.
      expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toContain("claude23:");
      expect(ws.isSavedAgentMember("claude23")).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  it("unattested: a roster row and a profile with no host authority stays a member with a door", async () => {
    const { ws } = await savedAgentStateWorkspace("authority");
    try {
      const row = doorOf(await ws.reconcileSavedAgentRoster(), "claude23");
      expect(row.state).toBe("unattested");
      expect(row.member).toBe(true);
      expect(row.facts).toEqual({ rosterRow: true, profileOnDisk: true, authorityRecord: false, projection: false, profileHomeOnDisk: true });
      expect(row.removal.door).toContain("Forget");
      expect(row.refusal).toContain("host profile authority is missing");
    } finally {
      ws.dispose();
    }
  });

  /**
   * The third open question of `spec.md`, measured rather than argued: the state IS reachable —
   * t-ae221c only changed WHICH door produces it. Deleting a stanza by hand used to; membership is
   * the directory now, so what is left is an `agent.yml` that is on disk and cannot be read. The
   * handling is unchanged and is the reason the state has to keep existing: bytes are there, so it
   * is reported and kept rather than swept.
   */
  it("unlisted-profile: an unreadable profile is not a member, and its bytes are kept", async () => {
    const { root, ws } = await savedAgentStateWorkspace("roster-row");
    try {
      const row = doorOf(await ws.reconcileSavedAgentRoster(), "claude23");
      expect(row.state).toBe("unlisted-profile");
      expect(row.member).toBe(false);
      expect(row.facts.profileOnDisk).toBe(true);
      expect(row.removal.door).toBeNull();
      expect(row.removal.reason).toContain("never deletes it automatically");
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", "claude23", "agent.yml"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("stranded-authority: an authority with no roster row and no profile is not a member and has no door", async () => {
    const { ws } = await savedAgentStateWorkspace("roster-row-and-profile");
    try {
      const row = doorOf(await ws.reconcileSavedAgentRoster(), "claude23");
      expect(row.state).toBe("stranded-authority");
      expect(row.member).toBe(false);
      expect(row.facts).toEqual({ rosterRow: false, profileOnDisk: false, authorityRecord: true, projection: false, profileHomeOnDisk: false });
      expect(row.removal.door).toBeNull();
    } finally {
      ws.dispose();
    }
  });

  /**
   * t-8b58b3 — the sweep enumerates `.tachyon/agents/` to find its subjects, then measured only the
   * FILE inside each one. A directory-only residue therefore came back with four false facts,
   * derived to `absent`, and answered "there is nothing to remove" about a directory the same
   * function had just listed. That is worse than not looking: a false negative delivered as proof.
   *
   * The fix is the fifth fact, not a new arm of the derivation — given all-false, `absent` was the
   * only honest answer available to it.
   */
  it("orphan-home: a directory the sweep just enumerated is reported, not called absent", async () => {
    const { root, ws } = await savedAgentStateWorkspace("everything-but-the-home");
    try {
      const home = path.join(root, ".tachyon", "agents", "claude23");
      expect(fs.readdirSync(home)).toEqual([]);
      const row = doorOf(await ws.reconcileSavedAgentRoster(), "claude23");
      expect(row.state).toBe("orphan-home");
      expect(row.member).toBe(false);
      expect(row.facts).toEqual({
        rosterRow: false,
        profileOnDisk: false,
        authorityRecord: false,
        projection: false,
        profileHomeOnDisk: true,
      });
      // No door, and a reason that carries the human the rest of the way instead of denying the
      // residue exists. `rmdir` is the same policy the removal helpers apply on the write side.
      expect(row.removal.door).toBeNull();
      expect(row.removal.reason).toContain("rmdir");
      expect(row.removal.reason).not.toContain("there is nothing to remove");
      // Read-only, like every other state: the sweep reports the directory, it never removes it.
      expect(fs.existsSync(home)).toBe(true);
      // The healthy neighbour still classifies, so this is a measurement and not a blanket label.
      expect(doorOf(await ws.reconcileSavedAgentRoster(), "claude").state).toBe("consistent");
    } finally {
      ws.dispose();
    }
  });

  it("Agent, Bridge x reconcile_roster answers with the same report", async () => {
    const { root, ws } = await savedAgentStateWorkspace("refused");
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerTools(
      { registerTool: (name: string, _schema: unknown, handler: unknown) => { tools.set(name, handler as never); } } as never,
      {
        workspaceRoot: root,
        caller: { kind: "agent", name: "claude" },
        manager: ws.manager,
        savedAgentRosterReconciliation: () => ws.reconcileSavedAgentRoster(),
      } as never,
    );
    try {
      const result = await tools.get("reconcile_roster")!({});
      expect(result.isError).toBeFalsy();
      const report = JSON.parse(result.content[0]!.text) as Awaited<ReturnType<Workspace["reconcileSavedAgentRoster"]>>;
      const row = doorOf(report, "claude23");
      expect(row.state).toBe("unprojectable");
      expect(row.removal.door).toBe("Agent Studio -> Forget (Bridge: propose_saved_agent_removal)");
    } finally {
      ws.dispose();
    }
  });
});

it("refuses the bare canonical forget while a tmux binding exists, and plans the kill in the Studio door", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  keeper:\n    cmd: sh\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    await ws.commitAgentProfileLifecycle({
      agentName: "auditor",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    await ws.manager.spawn("reviewer");
    await expect(ws.forgetAgentProfileAgent("reviewer")).rejects.toThrow("fully stopped");
    expect(asAgent(ws.config?.agents.reviewer)?.profileLifecycle).toBeDefined();
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer", "agent.yml"))).toBe(true);

    // t-e722ce — the STUDIO door no longer inherits that refusal, and that is the change.
    //
    // "Stop the agent first" was a precondition the product could satisfy itself and made the human
    // satisfy instead; the sidebar's Remove always tore the session down, and the door that stayed
    // now does the same. The refusal is not lost, it is MOVED EARLIER: the plan reports this exact
    // condition as a step that WILL RUN and names the kill, so the human reads "the session is live
    // and will be killed" before approving rather than "could not be completed" afterwards.
    const revision = (await ws.inspectAgentProfileStudio("reviewer")).revision;
    const planned = await ws.planAgentProfileForget("reviewer", revision);
    const stopStep = planned.steps.find((entry) => entry.id === "stop-session");
    expect(stopStep?.state).toBe("will-run");
    expect(stopStep?.detail).toContain("will be killed");
    expect(planned.executable).toBe(true);

    expect(await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "forget",
      agentName: "reviewer",
      expectedRevision: revision,
      confirmation: "reviewer",
    })).toMatchObject({ kind: "forgotten", agentName: "reviewer" });
    expect(ws.config?.agents.reviewer).toBeUndefined();

    // t-05dff5's property still holds at this hop: a refusal the cascade CANNOT resolve for the
    // human arrives as a VALUE carrying the engine's own sentence and its class, rather than as the
    // flattened "the profile lifecycle action could not be completed" this door used to show.
    expect(await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "forget",
      agentName: "auditor",
      expectedRevision: "f".repeat(64),
      confirmation: "auditor",
    })).toMatchObject({ kind: "refused", code: "agent-profile/revision-conflict" });
  } finally {
    ws.dispose();
  }
});

/** Flushes the best-effort async poke chain (`tmux.hasSession(...).then(...)`) that `pokeParentOnDeath`
 *  fires without the lifecycle tick awaiting it. */
const flush = () => new Promise((r) => setTimeout(r, 0));
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const exitPoke = (agent: string, exitDescriptor: string): string =>
  `[tachyon] child '${agent}' exited(${exitDescriptor}) — inspect Activity/read_output, dismiss, resume, or re-delegate`;



describe("Workspace — headless composition smoke (spec 235)", () => {
  it("SDD 369 T3 composes the extension-global Claude capture into the existing per-spawn settings layer", async () => {
    const root = mkdir();
    // SDD 478 M7 — capture composition is a property of the Claude COMMAND LINE, and after the
    // legacy shim an authored command line belongs to a Temporary agent: `agents:` takes a Saved
    // profile pointer, whose runtime surface is typed selectors, not argv.
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n", "utf8");
    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const requests: Array<{ workspaceRoot: string; agent: string; cwd: string; configHome?: string }> = [];
    const ws = await Workspace.createForTest(root, {
      host,
      onViewsChanged: () => {},
      claudeStatusLineCapture: {
        materialize: (request) => {
          requests.push(request);
          return { type: "command", command: "node '/private/capture-wrapper.cjs'", padding: 1 };
        },
      },
    }, { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    try {
      await ws.manager.spawn("claude", { cmd: "claude" });

      expect(requests).toEqual([{
        workspaceRoot: root,
        agent: "claude",
        cwd: root,
        // SDD 478 M7 — a Temporary Claude agent runs against its own per-agent harness home, not the
        // ambient ~/.claude the retired inline shape used. Capture is materialized against the home
        // the agent will actually read, which is the whole point of passing it here.
        configHome: path.join(harnessRoot(root), "claude"),
      }]);
      const settings = JSON.parse(fs.readFileSync(spawnSettingsPath(root, "claude"), "utf8")) as Record<string, unknown>;
      expect(settings.statusLine).toEqual({
        type: "command",
        command: "node '/private/capture-wrapper.cjs'",
        padding: 1,
      });
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("SDD 369 T3 does not compose capture across an explicit Claude settings-source filter", async () => {
    const root = mkdir();
    // SDD 478 M7 — see above: an explicit `--setting-sources` filter is argv, so the agent that
    // carries one is ad-hoc. A canonical profile has no way to express this flag at all.
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n", "utf8");
    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const requests: unknown[] = [];
    const ws = await Workspace.createForTest(root, {
      host,
      onViewsChanged: () => {},
      claudeStatusLineCapture: {
        materialize: (request) => {
          requests.push(request);
          return { type: "command", command: "node '/private/capture-wrapper.cjs'" };
        },
      },
    }, { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    try {
      await ws.manager.spawn("claude", { cmd: "claude --setting-sources project" });

      expect(requests).toEqual([]);
      const settings = JSON.parse(fs.readFileSync(spawnSettingsPath(root, "claude"), "utf8")) as Record<string, unknown>;
      expect(settings.statusLine).toBeUndefined();
      expect(settings.hooks).toBeDefined();
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("keeps a failed Resume-all offer and reports a failed fresh-spawn fallback", async () => {
    const { ws, host } = await makeWorkspace();
    const record = { instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true }, cwd: ws.workspaceRoot };
    (ws as unknown as { resumable: Array<{ name: string; record: typeof record }> }).resumable = [
      { name: "a", record },
    ];
    vi.spyOn(ws.manager, "resume").mockRejectedValueOnce(new ResumeUnavailableError("a", "transcript missing"));
    vi.spyOn(ws.manager, "spawn").mockRejectedValueOnce(new Error("project guidance source missing.md"));

    await ws.resumeAllOffered();

    expect((ws as unknown as { resumable: Array<{ name: string }> }).resumable.map((item) => item.name)).toEqual(["a"]);
    expect(host.notices.some((notice) =>
      notice.level === "error" &&
      notice.message.includes("could not resume agent 'a'") &&
      notice.message.includes("project guidance source missing.md")
    )).toBe(true);
    ws.dispose();
  });

















  it("recovers pending host-action reload only after the Bridge is ready", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  idle:\n    cmd: sh\n", "utf8");
    const storage = mkdir();
    const host = new FakeHost(storage);
    const hash = workspaceHash(root);
    host.setState(`tachyon.callerIdentity.instanceId.${hash}`, "host-fixed");
    host.setState(`tachyon.hostAction.sessionEpoch.${hash}`, 1);

    const store = new ReloadTransactionStore(path.join(storage, "host-actions", "reload-pending.json"));
    await store.begin({
      actionId: "act-reload-recover",
      command: "workbench.action.reloadWindow",
      bundle: { host_instance_id: "host-fixed", workspace_id: hash, extension_build_id: "0.0.0-test", session_epoch: 1 },
      deadlineMs: 60_000,
      now: Date.now(),
    });

    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    await flush();
    expect(await store.readPending()).toMatchObject({ action_id: "act-reload-recover" });

    (ws.bridge as unknown as { _port?: number })._port = 41000;
    await (ws as unknown as { recoverPendingHostActionReload: () => Promise<void> }).recoverPendingHostActionReload();

    expect(await store.readPending()).toBeUndefined();
    const auditLines = fs.readFileSync(path.join(storage, "host-actions", "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0].payload).toMatchObject({ kind: "outcome", actionId: "act-reload-recover", state: "reattached_verified" });
    expect(host.notices.map((notice) => notice.message)).toContain(
      "tachyon.yml: terminals: in tachyon.yml is legacy and continues to load; new declarations live at .tachyon/terminals/<name>.yml.",
    );
    ws.dispose();
  });

  it("blocks reloadWindow while another agent is actively working", async () => {
    const root = mkdir();
    const { host } = canonicalHost(root, [
      { name: "codex", spec: { runtime: "codex" } },
      { name: "claude", spec: { runtime: "claude" } },
    ]);
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    await ws.manager.spawn("codex");
    await ws.manager.spawn("claude");
    (ws.monitor as unknown as { stateOf(agent: string): { state: string; composerOccupied?: boolean } | undefined }).stateOf = (agent: string) =>
      agent === "claude" ? { state: "working" } : { state: "idle" };

    const result = await (ws as unknown as { runHostAction(input: { action: string; caller: { kind: "agent"; name: string } }): Promise<unknown> }).runHostAction({
      action: "reloadWindow",
      caller: { kind: "agent", name: "codex" },
    });

    expect(result).toMatchObject({ ok: false, code: "precondition_failed" });
    expect(JSON.stringify(result)).toContain("claude:working");
    expect(host.notices.at(-1)).toMatchObject({ level: "warn" });
    expect(host.notices.at(-1)?.message).toContain("reloadWindow blocked");
    ws.dispose();
  });

  it("watches task JSON files and debounces out-of-band task refreshes (t-4bf28a)", async () => {
    vi.useFakeTimers();
    const views: ViewKind[] = [];
    const { ws, host } = await makeWorkspace((view) => views.push(view));
    // Ignore view notifications from start()/autostart; this test only measures the task debounce.
    views.length = 0;
    const taskWatch = host.watches.find((w) => w.glob === ".tachyon/tasks/*.json");

    expect(taskWatch).toMatchObject({ root: ws.workspaceRoot, disposed: false });
    expect(taskWatch?.events).toEqual({ change: true, create: true, delete: true });

    taskWatch?.onEvent();
    taskWatch?.onEvent();
    await vi.advanceTimersByTimeAsync(74);
    expect(views).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(views).toEqual(["tasks"]);

    ws.dispose();
  });

  it("disposes the task watcher and cancels a pending task refresh", async () => {
    vi.useFakeTimers();
    const views: ViewKind[] = [];
    const { ws, host } = await makeWorkspace((view) => views.push(view));
    views.length = 0;
    const taskWatch = host.watches.find((w) => w.glob === ".tachyon/tasks/*.json");

    taskWatch?.onEvent();
    await ws.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(taskWatch?.disposed).toBe(true);
    expect(views).toEqual([]);
  });

  it("spawns a declared agent through the manager into the fake tmux", async () => {
    const { ws, sessions } = await makeWorkspace();
    await ws.manager.spawn("b");
    expect([...sessions].some((s) => s.endsWith("-b"))).toBe(true);
    ws.dispose();
  });

  it("injects the legacy Bridge token, not the external token, into spawned agent env", async () => {
    const { ws, calls } = await makeWorkspace();
    await ws.manager.spawn("b");
    const spawnArgs = calls.find((c) => c.includes("new-session"))!;
    expect(ws.token).toBeDefined();
    expect(ws.externalToken).toBeDefined();
    expect(ws.externalToken).not.toBe(ws.token);
    expect(spawnArgs).toContain(`TACHYON_BRIDGE_TOKEN=${ws.token}`);
    expect(spawnArgs).not.toContain(`TACHYON_BRIDGE_TOKEN=${ws.externalToken}`);
    ws.dispose();
  });

  it("polling lifecycle reacts to a dead pane on tick(), then dispose() is clean", async () => {
    const { ws, host, sessions, dead } = await makeWorkspace();
    await ws.manager.spawn("b");
    const session = [...sessions].find((s) => s.endsWith("-b"));
    expect(session).toBeDefined();
    dead.set(session!, 7); // the pane died with exit 7
    await ws.tick(); // no control-mode events in test mode — the poll drives lifecycle
    expect(host.notices.some((n) => /crash/i.test(n.message))).toBe(true);
    expect(() => ws.dispose()).not.toThrow();
  });

  it("GC of a removed declared agent deletes its durable activity log with the ledger row", async () => {
    const { ws } = await makeWorkspace();
    ws.ledger.record("old", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, updatedAt: "t", instance: { lifetime: "saved", resumePolicy: "restartable" } });
    const actDir = path.join(ws.workspaceRoot, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("old")}.jsonl`);
    const stateFile = path.join(actDir, `${agentLogId("old")}.state.json`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    fs.writeFileSync(stateFile, "{}", "utf8");
    fs.writeFileSync(sessionOwnersFile(ws.workspaceRoot), [
      JSON.stringify({ agent: "old", sessionId: "s-old", transcriptPath: "/p/old.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t1" }),
      JSON.stringify({ agent: "a", sessionId: "s-a", transcriptPath: "/p/a.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t2" }),
    ].join("\n") + "\n", "utf8");

    await (ws as unknown as { gcLedger(declaredInConfig: Set<string>, live: Set<string>): Promise<void> })
      .gcLedger(new Set(["a", "b"]), new Set());

    expect(ws.ledger.get("old")).toBeUndefined();
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(readSessionOwners(sessionOwnersFile(ws.workspaceRoot)).map((r) => r.agent)).toEqual(["a"]);
    ws.dispose();
  });

  it("reports a footprint-removal failure instead of taking the startup sweep down", async () => {
    const { ws, host } = await makeWorkspace();
    ws.ledger.record("old", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, updatedAt: "t", instance: { lifetime: "saved", resumePolicy: "restartable" } });
    vi.spyOn(ws.harness, "retireCredentials").mockImplementationOnce(() => { throw new Error("secret storage unavailable"); });

    await expect((ws as unknown as { gcLedger(declaredInConfig: Set<string>, live: Set<string>): Promise<void> })
      .gcLedger(new Set(), new Set())).resolves.toBeUndefined();

    expect(host.notices.some((notice) => notice.level === "warn"
      && notice.message.includes("Could not finish cleanup for removed agent old"))).toBe(true);
    ws.dispose();
  });

  it("compacts stale session-owner rows on start while keeping live, ledger, and declared agents", async () => {
    const { ws, sessions, sessionEnv } = await makeWorkspace();
    // clean-exited Temporary stays listed (postmortem/resume) and is NOT kill-parity auto-collected,
    // so the session-owner row still has a durable ledger anchor after start.
    ws.ledger.record("resumable", {
      def: { cmd: "sh", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "t",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
      lifecycle: { state: "clean-exited", exitedAt: "2026-08-05T00:00:00.000Z" },
    });
    // t-fab832 — the post-cut contract: a live agent session must ATTEST that this build created it,
    // and the proof lives on the session rather than in the ledger. This fixture adds the session
    // directly, so it seeds the attestation the way a real `new-session` would. The case this test
    // used to cover — a live session with no proof — is no longer a state an activated workspace can
    // be in, because the gate refuses it. What the test is about is unchanged: compaction keeps the
    // rows still referenced and drops `stale`.
    sessions.add(ws.manager.session("live-only"));
    sessionEnv.set(`${ws.manager.session("live-only")}\u0000TACHYON_INSTANCE_CUT`, "agent-instance-v5");
    fs.mkdirSync(path.dirname(sessionOwnersFile(ws.workspaceRoot)), { recursive: true });
    fs.writeFileSync(sessionOwnersFile(ws.workspaceRoot), [
      JSON.stringify({ agent: "a", sessionId: "s-a", transcriptPath: "/p/a.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t1" }),
      JSON.stringify({ agent: "resumable", sessionId: "s-resume", transcriptPath: "/p/resume.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t2" }),
      JSON.stringify({ agent: "live-only", sessionId: "s-live", transcriptPath: "/p/live.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t3" }),
      JSON.stringify({ agent: "stale", sessionId: "s-stale", transcriptPath: "/p/stale.jsonl", cwd: ws.workspaceRoot, source: "startup", ts: "t4" }),
    ].join("\n") + "\n", "utf8");

    await ws.start();

    expect(readSessionOwners(sessionOwnersFile(ws.workspaceRoot)).map((r) => r.agent)).toEqual(["a", "resumable", "live-only"]);
    ws.dispose();
  });

  it("releases an active claim without retriage on startup when its known agent session was lost", async () => {
    const { ws } = await makeWorkspace();
    ws.ledger.record("crashchild", {
      def: { cmd: "sh", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-crash",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    await ws.taskStore.create({ id: "t-dead01", title: "claimed before crash", author: "human" });
    await ws.taskStore.update("t-dead01", { status: "triaged", actor: "human" });
    await ws.taskStore.update("t-dead01", { status: "active", assignee: "crashchild", actor: "human" });

    await ws.start();

    expect(ws.taskStore.get("t-dead01")).toMatchObject({ status: "active" });
    expect(ws.taskStore.get("t-dead01").assignee).toBeUndefined();
    expect(ws.taskStore.journal.read("t-dead01").at(-1)?.text).toContain("agent 'crashchild' was not running when the workspace started");
    ws.dispose();
  });

  it("summarizes children found not running after reload to their surviving parent", async () => {
    const { ws, sessions, sessionEnv, sent } = await makeWorkspace();
    ws.ledger.record("coordinator", {
      def: { cmd: "pi", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    for (const child of ["alpha", "beta"]) {
      ws.ledger.record(child, {
        def: { cmd: "pi", kind: "agent", parent: "coordinator" },
        cwd: ws.workspaceRoot,
        updatedAt: "before-reload",
        instance: { lifetime: "temporary", resumePolicy: "restartable" },
      });
    }
    const parentSession = ws.manager.session("coordinator");
    sessions.add(parentSession);
    sessionEnv.set(`${parentSession}\u0000TACHYON_INSTANCE_CUT`, "agent-instance-v5");

    await ws.start();
    expect(sent.has(parentSession)).toBe(false); // startup never assumes unknown attention means idle
    await (
      ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }
    ).recoverOnIdle("coordinator", false);

    expect(sent.get(parentSession)).toBe(
      "[tachyon] after reload, children 'alpha', 'beta' are not running. "
      + "Tachyon could not observe whether they exited while the host was down or were already stopped — "
      + "inspect Activity/list_agents, dismiss, resume, or re-delegate",
    );
    ws.dispose();
  });

  it("holds the reload summary until an absent parent starts, then delivers it once", async () => {
    const { ws, sent } = await makeWorkspace();
    // fork survives kill-parity auto-collect (explicit Dismiss only) so a later spawn can rehydrate
    // the Temporary def without needing a worktree ensure on a non-git test root.
    ws.ledger.record("coordinator", {
      def: { cmd: "pi", kind: "agent", fork: true },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    ws.ledger.record("worker", {
      def: { cmd: "pi", kind: "agent", parent: "coordinator" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });

    await ws.start();
    expect(sent.size).toBe(0);

    await ws.manager.spawn("coordinator");
    await (
      ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }
    ).recoverOnIdle("coordinator", false);

    const parentSession = ws.manager.session("coordinator");
    expect(sent.get(parentSession)).toContain("after reload, child 'worker' is not running");

    sent.delete(parentSession);
    (
      ws as unknown as { summarizeMissingChildrenAfterReload(live: ReadonlySet<string>): void }
    ).summarizeMissingChildrenAfterReload(new Set(["coordinator"]));
    await flush();
    expect(sent.has(parentSession)).toBe(false);
    ws.dispose();
  });

  it("does not summarize absence when the reload inventory is ambiguous", async () => {
    const { ws, sessions, sessionEnv, sent } = await makeWorkspace();
    ws.ledger.record("coordinator", {
      def: { cmd: "pi", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    ws.ledger.record("worker", {
      def: { cmd: "pi", kind: "agent", parent: "coordinator" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    const parentSession = ws.manager.session("coordinator");
    sessions.add(parentSession);
    sessionEnv.set(`${parentSession}\u0000TACHYON_INSTANCE_CUT`, "agent-instance-v5");
    vi.spyOn(ws.manager, "runningAgentsStrict").mockResolvedValueOnce(null);

    await ws.start();
    await flush();

    expect(sent.has(parentSession)).toBe(false);
    ws.dispose();
  });

  it("keeps an active claim on startup when that agent session survived", async () => {
    const { ws, sessions, sessionEnv } = await makeWorkspace();
    ws.ledger.record("survivor", {
      def: { cmd: "sh", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    const session = ws.manager.session("survivor");
    sessions.add(session);
    sessionEnv.set(`${session}\u0000TACHYON_INSTANCE_CUT`, "agent-instance-v5");
    await ws.taskStore.create({ id: "t-a11ce0", title: "surviving claim", author: "human" });
    await ws.taskStore.update("t-a11ce0", { status: "triaged", actor: "human" });
    await ws.taskStore.update("t-a11ce0", { status: "active", assignee: "survivor", actor: "human" });

    await ws.start();

    expect(ws.taskStore.get("t-a11ce0")).toMatchObject({ status: "active", assignee: "survivor" });
    ws.dispose();
  });

  it("keeps active claims when startup cannot inventory tmux conclusively", async () => {
    const { ws } = await makeWorkspace();
    ws.ledger.record("unknownstate", {
      def: { cmd: "pi", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    await ws.taskStore.create({ id: "t-fa11ed", title: "claim under ambiguous inventory", author: "human" });
    await ws.taskStore.update("t-fa11ed", { status: "triaged", actor: "human" });
    await ws.taskStore.update("t-fa11ed", { status: "active", assignee: "unknownstate", actor: "human" });
    vi.spyOn(ws.manager, "runningAgentsStrict").mockResolvedValueOnce(null);

    await ws.start();

    expect(ws.taskStore.get("t-fa11ed")).toMatchObject({ status: "active", assignee: "unknownstate" });
    ws.dispose();
  });

  it("t-01a425: auto-collects kill-parity Temporary residue after crash (no session, no worktree)", async () => {
    const { ws, host } = await makeWorkspace();
    ws.ledger.record("ghost", {
      def: { cmd: "pi", kind: "agent", parent: "coord" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-crash",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
      resume: { runtime: "pi", sessionId: "ghost-sess" },
    });
    expect(ws.ledger.get("ghost")).toBeDefined();

    await ws.start();

    expect(ws.ledger.get("ghost")).toBeUndefined();
    expect(host.notices.some((n) => n.message.includes("collected") && n.message.includes("'ghost'"))).toBe(true);
    const listed = await ws.manager.list();
    expect(listed.some((a) => a.name === "ghost")).toBe(false);
    ws.dispose();
  });

  it("t-01a425: keeps a worktree-owned stopped Temporary listed (legitimate resume) and offers bulk dismiss", async () => {
    const { ws, host } = await makeWorkspace();
    // Real git root so removeAgentWorktree can prove absence (probeAbsence needs `git worktree list`).
    execFileSync("git", ["init"], { cwd: ws.workspaceRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: ws.workspaceRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws.workspaceRoot, stdio: "ignore" });
    fs.writeFileSync(path.join(ws.workspaceRoot, "README"), "x", "utf8");
    execFileSync("git", ["add", "README"], { cwd: ws.workspaceRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: ws.workspaceRoot, stdio: "ignore" });
    // Path is absent on purpose: the human-review class is the ledger CLAIM, not disk presence.
    // removeAgentWorktree treats an already-absent checkout as success (t-05dff5), then dismiss finishes the row.
    const wtPath = path.join(ws.workspaceRoot, ".cache", "wt-paused-missing");
    ws.ledger.record("paused", {
      def: { cmd: "pi", kind: "agent" },
      cwd: wtPath,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
      resume: { runtime: "pi", sessionId: "paused-sess" },
      worktree: {
        path: wtPath,
        branch: "tachyon/tmp.paused",
        baseRef: "main",
        createdAt: "before-reload",
        tachyonCreatedBranch: true,
      },
    });

    await ws.start();

    // Legitimate resumable stop must survive auto-collect.
    expect(ws.ledger.get("paused")).toBeDefined();
    const listed = await ws.manager.list();
    expect(listed.some((a) => a.name === "paused" && !a.running)).toBe(true);

    const bulk = host.notices.find((n) => n.message.includes("stopped temporary") && n.message.includes("'paused'"));
    expect(bulk).toBeDefined();
    expect(bulk?.actions.some((a) => a.label.includes("Dismiss all"))).toBe(true);

    // Human bulk action removes the row through the production dismiss door.
    await bulk!.actions.find((a) => a.label.includes("Dismiss all"))!.run();
    expect(ws.ledger.get("paused")).toBeUndefined();
    ws.dispose();
  });

  it("t-01a425: does not auto-collect Temporary residue when the tmux inventory is ambiguous", async () => {
    const { ws } = await makeWorkspace();
    ws.ledger.record("maybe", {
      def: { cmd: "pi", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-reload",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    vi.spyOn(ws.manager, "runningAgentsStrict").mockResolvedValueOnce(null);

    await ws.start();

    expect(ws.ledger.get("maybe")).toBeDefined();
    ws.dispose();
  });

  it("restores persisted terminal tabs from Workspace.start after surviving tmux sessions are ready", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(mkdir());
    const { tmux, sessions } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    const session = ws.manager.session("a");
    sessions.add(session);
    host.setState(`tachyon.terminals.open.v1.${workspaceHash(root)}`, [
      { schemaVersion: 1, agent: "a", session, title: "Agent A" },
    ]);

    await ws.start();

    expect(__createdTerminals).toHaveLength(1);
    expect(__createdTerminals[0].options).toMatchObject({
      name: "Agent A",
      isTransient: true,
    });
    expect(__createdTerminals[0].options.shellArgs?.[0]).toBe("-u");
    expect(__createdTerminals[0].options.shellArgs?.[1]).toBe("-S");
    expect(__createdTerminals[0].options.shellArgs?.[2]).toMatch(/\/tmux-\d+\/tachyon$/);
    expect(__createdTerminals[0].options.shellArgs?.slice(3)).toEqual(["attach-session", "-d", "-t", `=${session}`]);
    ws.dispose();
  });



});

describe("Workspace — death-poke wiring (spec 332)", () => {
  it("releases the dead agent's active board claim without retriage", async () => {
    const { ws, sessions, dead } = await makeWorkspace();
    ws.ledger.record("claimchild", {
      def: { cmd: "pi", kind: "agent" },
      cwd: ws.workspaceRoot,
      updatedAt: "before-crash",
      instance: { lifetime: "temporary", resumePolicy: "restartable" },
    });
    sessions.add(ws.manager.session("claimchild"));
    await ws.taskStore.create({ id: "t-c1a1ed", title: "claimed work", author: "human" });
    await ws.taskStore.update("t-c1a1ed", { status: "triaged", actor: "human" });
    await ws.taskStore.update("t-c1a1ed", { status: "active", assignee: "claimchild", actor: "human" });
    await ws.tick(); // establish the live lifecycle baseline

    dead.set(ws.manager.session("claimchild"), 137);
    await ws.tick();
    await flush();

    expect(ws.taskStore.get("t-c1a1ed")).toMatchObject({ status: "active" });
    expect(ws.taskStore.get("t-c1a1ed").assignee).toBeUndefined();
    expect(ws.taskStore.journal.read("t-c1a1ed").at(-1)?.text).toContain("agent 'claimchild' exited (137)");
    ws.dispose();
  });

  it("an unexpected crash pokes the live parent with the death envelope", async () => {
    const { ws, dead, sent } = await makeWorkspace();
    await ws.manager.spawn("b"); // the parent, running
    await ws.manager.spawn("child1", { cmd: "codex", parent: "b" });
    const childSession = ws.manager.session("child1");
    const parentSession = ws.manager.session("b");
    dead.set(childSession, 7); // crashed, exit 7
    await ws.tick();
    await flush();
    expect(sent.get(parentSession)).toBe(exitPoke("child1", "7"));
    ws.dispose();
  });

  it("a clean self-exit (code 0) also pokes the live parent", async () => {
    const { ws, dead, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child2", { cmd: "codex", parent: "b" });
    const childSession = ws.manager.session("child2");
    const parentSession = ws.manager.session("b");
    dead.set(childSession, 0);
    await ws.tick();
    await flush();
    expect(sent.get(parentSession)).toBe(exitPoke("child2", "0"));
    ws.dispose();
  });

  it("a deliberate kill_agent (manager.kill) suppresses the poke — cancellation isn't completion", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child3", { cmd: "codex", parent: "b" });
    const parentSession = ws.manager.session("b");
    await ws.manager.kill("child3"); // removes the whole session — the next tick observes it as "gone"
    await ws.tick();
    await flush();
    expect(sent.has(parentSession)).toBe(false);
    ws.dispose();
  });

  it("a crashed agent with no parent is a no-op (nobody to wake, never throws)", async () => {
    const { ws, dead, sent } = await makeWorkspace();
    await ws.manager.spawn("b"); // no parent set — a root-level agent
    const session = ws.manager.session("b");
    dead.set(session, 1);
    await ws.tick(); // must not throw even though manager.parentOf("b") is undefined
    await flush();
    expect(sent.size).toBe(0);
    ws.dispose();
  });

  it("a genuinely vanished session (external kill, two consecutive ticks) pokes 'killed' once confirmed", async () => {
    // t-3a3a14b — onGone needs two consecutive absent observations before it fires at all.
    const { ws, sessions, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child4", { cmd: "codex", parent: "b" });
    const childSession = ws.manager.session("child4");
    const parentSession = ws.manager.session("b");
    await ws.tick(); // baseline: child4 observed alive
    sessions.delete(childSession); // external/unexpected removal — no manager.kill, no expectedDeath
    await ws.tick(); // 1st absent observation — pending, no poke yet
    await flush();
    expect(sent.has(parentSession)).toBe(false);
    await ws.tick(); // 2nd consecutive absent observation — onGone fires
    await flush();
    expect(sent.get(parentSession)).toBe(exitPoke("child4", "killed"));
    ws.dispose();
  });

  it("does not poke for terminal children", async () => {
    const { ws, dead, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("server", { cmd: "npm run dev", kind: "terminal" });
    const childSession = ws.manager.session("server");
    const parentSession = ws.manager.session("b");
    dead.set(childSession, 0);
    await ws.tick();
    await flush();
    expect(sent.has(parentSession)).toBe(false);
    ws.dispose();
  });
});

describe("Workspace — vanished-child poke re-check (t-3a3a14c)", () => {
  /** exposes the private method to drive the confirmVanished guard directly, in isolation from the
   *  two-tick LifecycleMonitor confirmation (b) already covered above. */
  function deathPokeOf(ws: Awaited<ReturnType<typeof makeWorkspace>>["ws"]) {
    return (
      ws as unknown as { pokeParentOnDeath(agent: string, exitDescriptor: string, confirmVanished?: boolean): void }
    ).pokeParentOnDeath.bind(ws);
  }

  it("skips the 'killed' poke when the child's own session is actually still there (false alarm)", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child1", { cmd: "codex", parent: "b" });
    const parentSession = ws.manager.session("b");
    // child1's session was never removed from the fake tmux — a false "gone" observation.
    deathPokeOf(ws)("child1", "killed", true);
    await flush();
    expect(sent.has(parentSession)).toBe(false);
    ws.dispose();
  });

  it("still pokes 'killed' when the recheck confirms the child's session is genuinely gone", async () => {
    const { ws, sessions, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child2", { cmd: "codex", parent: "b" });
    const parentSession = ws.manager.session("b");
    sessions.delete(ws.manager.session("child2")); // truly gone
    deathPokeOf(ws)("child2", "killed", true);
    await flush();
    expect(sent.get(parentSession)).toBe(exitPoke("child2", "killed"));
    ws.dispose();
  });

  it("a confirmed crash/clean-exit poke (confirmVanished not set) ignores the child's current session state", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child3", { cmd: "codex", parent: "b" });
    const parentSession = ws.manager.session("b");
    // child3's session is still present (a dead pane, remain-on-exit) — must NOT be mistaken for a
    // false alarm; a real exit code came from a confirmed tmux read this tick, no recheck needed.
    deathPokeOf(ws)("child3", "7");
    await flush();
    expect(sent.get(parentSession)).toBe(exitPoke("child3", "7"));
    ws.dispose();
  });
});

describe("Workspace — upgrade notice scoped to genuine stragglers (t-e5910c)", () => {
  const OLD_VERSION = "0.0.0-old";
  const UPGRADE_NOTICE_SNIPPET = "keep the old Bridge tools until restarted";

  async function bootWithSurvivor(opts: { record: Record<string, unknown>; tachyonYaml?: string }) {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), opts.tachyonYaml ?? "agents:\n  placeholder:\n    cmd: sh\n", "utf8");
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".tachyon", "sessions.json"),
      JSON.stringify({ sessions: { survivor: { cwd: root, ...opts.record } } }),
      "utf8",
    );
    const host = new FakeHost(mkdir());
    host.setState(workspaceVersionStateKey(workspaceHash(root)), OLD_VERSION);
    const { tmux, sessions } = fakeTmux();
    sessions.add(sessionName(workspaceHash(root), "survivor"));
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT });
    return { ws, host };
  }

  it("suppresses the notice for a wired, non-Delivery-bound survivor under the default (auto) rebind policy", async () => {
    const { ws, host } = await bootWithSurvivor({
      record: { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s1" }, declared: true, updatedAt: "t" },
    });
    try {
      expect(host.notices.some((n) => n.message.includes(UPGRADE_NOTICE_SNIPPET))).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  it("still warns for a survivor that is not Bridge-wired at all (explicit opt-out)", async () => {
    const { ws, host } = await bootWithSurvivor({
      record: {
        def: { cmd: "codex", kind: "agent" },
        resume: { runtime: "codex", sessionId: "s1" },
        bridgeClient: { boundGeneration: 0, wired: false },
        declared: true,
        updatedAt: "t",
      },
    });
    try {
      expect(host.notices.some((n) => n.message.includes(UPGRADE_NOTICE_SNIPPET))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("still warns when the rebind policy is off (the coordinator never touches anyone)", async () => {
    const { ws, host } = await bootWithSurvivor({
      record: { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s1" }, declared: true, updatedAt: "t" },
      tachyonYaml: 'agents: {}\nterminals:\n  placeholder:\n    cmd: sh\nsettings:\n  bridgeClientRebind:\n    onHostGenerationBump: "off"\n',
    });
    try {
      expect(host.notices.some((n) => n.message.includes(UPGRADE_NOTICE_SNIPPET))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("still warns when the rebind policy is notify (marks suspect but never proactively stops/resumes — an idle survivor gets no automatic fix)", async () => {
    const { ws, host } = await bootWithSurvivor({
      record: { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s1" }, declared: true, updatedAt: "t" },
      tachyonYaml: 'agents: {}\nterminals:\n  placeholder:\n    cmd: sh\nsettings:\n  bridgeClientRebind:\n    onHostGenerationBump: "notify"\n',
    });
    try {
      expect(host.notices.some((n) => n.message.includes(UPGRADE_NOTICE_SNIPPET))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

});

describe("Workspace — needs-input parent poke (t-8605be)", () => {
  /** exposes the private method the same way the 341 suite below reaches deliverNotice/recoverOnIdle */
  function pokeOf(ws: Awaited<ReturnType<typeof makeWorkspace>>["ws"]) {
    return (ws as unknown as { pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void }).pokeParentOnNeedsInput.bind(ws);
  }

  it("pokes the live parent with the child's matched prompt line when it enters needs-input", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b"); // the parent, running
    await ws.manager.spawn("child1", { cmd: "opencode", parent: "b" });
    const parentSession = ws.manager.session("b");
    pokeOf(ws)("child1", "1) yes  2) no");
    await flush();
    expect(sent.get(parentSession)).toBe("[tachyon] child 'child1' is waiting for input: 1) yes  2) no");
    ws.dispose();
  });

  it("falls back to a generic line when no matched prompt text is available", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child2", { cmd: "opencode", parent: "b" });
    const parentSession = ws.manager.session("b");
    pokeOf(ws)("child2", undefined);
    await flush();
    expect(sent.get(parentSession)).toBe("[tachyon] child 'child2' is waiting for input: waiting for input");
    ws.dispose();
  });

  it("a needs-input child with no parent is a no-op (nobody to wake, never throws)", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b"); // no parent set — a root-level agent
    expect(() => pokeOf(ws)("b", "waiting")).not.toThrow();
    await flush();
    expect(sent.size).toBe(0);
    ws.dispose();
  });

  it("queues (via deliverNotice, per 341) rather than typing into a busy parent", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child3", { cmd: "opencode", parent: "b" });
    const parentSession = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string; hasStartedTurn?: boolean } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working", hasStartedTurn: true } : originalStateOf(agent);
    pokeOf(ws)("child3", "pick one");
    await flush();
    expect(sent.has(parentSession)).toBe(false); // queued, not typed into a busy pane
    ws.dispose();
  });
});

describe("Workspace — declared top-level prose-question handback (t-10771a)", () => {
  it("toasts and sidebars an idle prose question from a declared top-level agent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const changed: ViewKind[] = [];
    const { ws, host, panes } = await makeWorkspace((view) => changed.push(view), { bRuntime: "codex" });
    await ws.manager.spawn("b");
    const session = ws.manager.session("b");
    panes.set(session, "I can implement either path.\nShould I keep the smaller change?");

    await ws.monitor.tick();
    vi.setSystemTime(1_009_000);
    await ws.monitor.tick();

    expect(ws.monitor.stateOf("b")).toMatchObject({
      state: "idle",
      awaitingHuman: true,
      awaitingHumanReason: "Should I keep the smaller change?",
    });
    expect(host.notices.map((n) => n.message)).toContain("'b' needs you: Should I keep the smaller change?");
    expect(changed).toContain("agents");
    ws.dispose();
  });

  it("does not derive awaiting-human for declared subagents or Temporary children", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ws, host, panes } = await makeWorkspace(() => {}, {
      canonical: [
        { name: "owner", spec: { runtime: "codex", extra: { ownership: { subagents: ["reviewer"] } } } },
        { name: "reviewer", spec: { runtime: "codex" } },
      ],
    });
    await ws.manager.spawn("reviewer");
    await ws.manager.spawn("adhocChild", { cmd: "codex", parent: "owner" });
    panes.set(ws.manager.session("reviewer"), "Can I change the API shape?");
    panes.set(ws.manager.session("adhocChild"), "Should I ask the user?");

    await ws.monitor.tick();
    vi.setSystemTime(1_009_000);
    await ws.monitor.tick();

    expect(ws.monitor.stateOf("reviewer")).toMatchObject({ state: "idle", awaitingHuman: false });
    expect(ws.monitor.stateOf("adhocChild")).toMatchObject({ state: "idle", awaitingHuman: false });
    expect(host.notices.some((n) => n.message.includes("needs you"))).toBe(false);
    ws.dispose();
  });
});

describe("Workspace — notify_agent idle delivery (spec 341)", () => {
  it("queues notices while the target is working and flushes one on idle recovery", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    const session = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string; hasStartedTurn?: boolean } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working", hasStartedTurn: true } : originalStateOf(agent);

    const deliverNotice = (ws as unknown as { deliverNotice(agent: string, line: string): Promise<{ status: string }> }).deliverNotice.bind(ws);
    const recoverOnIdle = (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);
    const queued = await deliverNotice("b", "[tachyon] a → b: queued");
    expect(queued.status).toBe("queued");
    expect(sent.has(session)).toBe(false);

    (ws.monitor as unknown as { stateOf(agent: string): { state: string; hasStartedTurn?: boolean } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "idle" } : originalStateOf(agent);
    await recoverOnIdle("b", false);
    expect(sent.get(session)).toBe("[tachyon] a → b: queued");

    sent.delete(session);
    await recoverOnIdle("b", false);
    expect(sent.has(session)).toBe(false);
    ws.dispose();
  });

  it("flushes a notice queued behind an occupied composer when the monitor observes the composer clear (t-f45313)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { ws, sent, panes } = await makeWorkspace(() => {}, { bRuntime: "codex" });
    await ws.manager.spawn("b");
    const session = ws.manager.session("b");
    panes.set(session, "done\n\n❯ ");
    await ws.monitor.tick();
    vi.setSystemTime(1_009_000);
    await ws.monitor.tick();
    expect(ws.monitor.stateOf("b")).toMatchObject({ state: "idle", composerOccupied: false });

    const deliverNotice = (ws as unknown as { deliverNotice(agent: string, line: string): Promise<{ status: string }> }).deliverNotice.bind(ws);
    panes.set(session, "done\n\n❯ draft");
    vi.setSystemTime(1_010_000);
    await ws.monitor.tick();
    expect(ws.monitor.stateOf("b")).toMatchObject({ state: "idle", composerOccupied: true });

    const queued = await deliverNotice("b", "[tachyon] a → b: queued");
    expect(queued.status).toBe("queued");
    expect(sent.has(session)).toBe(false);

    panes.set(session, "done\n\n❯ ");
    vi.setSystemTime(1_011_000);
    await ws.monitor.tick();
    // t-a53dd9 — the flush now re-reads the composer FROM THE PANE before it writes, so the drain
    // takes one more async round-trip than it used to. Nothing about the expectations below changed;
    // the pass just has more hops to make.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ws.monitor.stateOf("b")).toMatchObject({ state: "idle", composerOccupied: false });
    expect(sent.get(session)).toBe("[tachyon] a → b: queued");

    sent.delete(session);
    await flushMicrotasks();
    expect(sent.has(session)).toBe(false);
    ws.dispose();
  });

  it("does not submit into needs-input and clears queued notices across a killed session", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    const session = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "needs-input" } : originalStateOf(agent);
    const deliverNotice = (ws as unknown as { deliverNotice(agent: string, line: string): Promise<{ status: string }> }).deliverNotice.bind(ws);
    const recoverOnIdle = (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);

    const queued = await deliverNotice("b", "[tachyon] a → b: permission-safe");
    expect(queued.status).toBe("queued");
    expect(sent.has(session)).toBe(false);

    await ws.manager.kill("b");
    await ws.manager.spawn("b");
    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "idle" } : originalStateOf(agent);
    await recoverOnIdle("b", false);
    expect(sent.has(session)).toBe(false);
    ws.dispose();
  });

  /**
   * t-99ccc9 originally asserted that this notice is DROPPED. t-fb1453 measured what that costs: a
   * child's completion report is destroyed by the act of dismissing the child, which is the normal end
   * of a delegation. "Sender was killed" was only ever a proxy for "the parent already consumed this"
   * — t-99ccc9's own body defers the real acknowledgement mechanism and demands, in the same breath,
   * "nenhuma perda silenciosa de completion signals" plus delayed messages "rotuladas como atrasadas".
   *
   * So the contract flipped from drop to deliver-with-provenance, and both halves are asserted here:
   * the report arrives, and it arrives visibly labelled so it cannot read as fresh news. The dead-child
   * HOST poke (the t-572cef/t-eed531 case) is still dropped — see notifyDoorbellDelivery.test.ts.
   */
  it("delivers a queued notify whose sender was killed, labelled as delayed (t-99ccc9 → t-fb1453)", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("a");
    await ws.manager.spawn("b");
    const targetSession = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string; hasStartedTurn?: boolean } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working", hasStartedTurn: true } : originalStateOf(agent);
    const internals = ws as unknown as {
      deliverNotice(agent: string, line: string, metadata: NoticeQueueMetadata): Promise<{ status: string }>;
      sourceNoticeMetadata(agent: string, origin: "host-poke" | "agent-authored"): NoticeQueueMetadata;
      recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
    };

    const queued = await internals.deliverNotice("b", "[tachyon] a → b: t-21101f done", internals.sourceNoticeMetadata("a", "agent-authored"));
    expect(queued.status).toBe("queued");
    await ws.manager.kill("a");

    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "idle" } : originalStateOf(agent);
    await internals.recoverOnIdle("b", false);
    const delivered = sent.get(targetSession) ?? "";
    expect(delivered).toContain("t-21101f done");
    expect(delivered).toContain("delayed");
    expect(delivered).toContain("reported by 'a'; 'a' was dismissed before delivery");
    ws.dispose();
  });
});

describe("Agent Studio — declaring ownership.subagents (t-4c113c)", () => {
  const OWNER = "codexCanonico";
  const TEAM = ["claudeBuilder", "claudeReviewer", "claudeRuntime"];

  async function ownedFleet(extra: ReadonlyArray<{ name: string; spec?: SavedAgentSpec }> = []) {
    return makeWorkspace(() => {}, {
      canonical: [{ name: OWNER }, ...TEAM.map((name) => ({ name })), ...extra],
    });
  }

  const profileText = (ws: Workspace, name: string) =>
    fs.readFileSync(path.join(ws.workspaceRoot, ".tachyon", "agents", name, "agent.yml"), "utf8");

  const setSubagents = async (ws: Workspace, subagents: string[]) => {
    const before = await ws.inspectAgentProfileStudio(OWNER);
    return ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: OWNER,
      expectedRevision: before.revision,
      subagents,
    });
  };

  it("links the whole team in one transaction, touching no other profile and no YAML", async () => {
    const { ws } = await ownedFleet();
    const yamlBefore = fs.readFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "utf8");
    const teamBefore = TEAM.map((name) => profileText(ws, name));
    expect(ws.config?.declaredOwner).toEqual({});

    const result = await setSubagents(ws, TEAM);

    expect(result.kind).toBe("snapshot");
    // The whole point: the sidebar's `declaredOwner` now carries the tree, derived from config.
    expect(ws.config?.declaredOwner).toEqual(Object.fromEntries(TEAM.map((name) => [name, OWNER])));
    expect(asAgent(ws.config?.agents[OWNER])?.subagents).toEqual(TEAM);
    expect(parseYaml(profileText(ws, OWNER)).ownership).toEqual({ subagents: TEAM });
    // Nothing outside the owner's own profile was written — not the children, not tachyon.yml.
    expect(TEAM.map((name) => profileText(ws, name))).toEqual(teamBefore);
    expect(fs.readFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "utf8")).toBe(yamlBefore);
    ws.dispose();
  });

  it("declares ownership while the owner is running — ownership has no runtime lifecycle role", async () => {
    const { ws } = await ownedFleet();
    await ws.manager.spawn(OWNER);
    expect(await ws.manager.runningAgents()).toContain(OWNER);

    await setSubagents(ws, TEAM);

    expect(ws.config?.declaredOwner).toEqual(Object.fromEntries(TEAM.map((name) => [name, OWNER])));
    // Runtime lineage is still the actual spawner; the declaration never seeds it (spec 352). The
    // roster carries BOTH facts separately, which is what the sidebar groups on.
    await ws.manager.spawn(TEAM[0]!);
    expect(ws.manager.parentOf(TEAM[0]!)).toBeUndefined();
    const row = (await ws.manager.list()).find((entry) => entry.name === TEAM[0]!);
    expect(row).toMatchObject({ declaredOwner: OWNER, parent: undefined });
    ws.dispose();
  });

  it("preserves CAS: a revision from before the declaration is refused, and the new one works", async () => {
    const { ws } = await ownedFleet();
    const stale = (await ws.inspectAgentProfileStudio(OWNER)).revision;
    await setSubagents(ws, [TEAM[0]!]);
    const fresh = (await ws.inspectAgentProfileStudio(OWNER)).revision;
    expect(fresh).not.toBe(stale);

    expect(await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: OWNER,
      expectedRevision: stale,
      subagents: TEAM,
    })).toMatchObject({ kind: "refused", code: "agent-profile/revision-conflict" });
    expect(asAgent(ws.config?.agents[OWNER])?.subagents).toEqual([TEAM[0]]);

    await setSubagents(ws, TEAM);
    expect(asAgent(ws.config?.agents[OWNER])?.subagents).toEqual(TEAM);
    ws.dispose();
  });

  it("removes the declaration with an empty list and drops the derived ownership", async () => {
    const { ws } = await ownedFleet();
    await setSubagents(ws, TEAM);
    await setSubagents(ws, []);

    expect(ws.config?.declaredOwner).toEqual({});
    expect(asAgent(ws.config?.agents[OWNER])?.subagents).toBeUndefined();
    expect(parseYaml(profileText(ws, OWNER)).ownership).toBeUndefined();
    ws.dispose();
  });

  it("refuses a contract violation before the transaction starts, leaving the profile byte-identical", async () => {
    const { ws } = await ownedFleet();
    await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: TEAM[0]!,
      expectedRevision: (await ws.inspectAgentProfileStudio(TEAM[0]!)).revision,
      subagents: [TEAM[1]!],
    });
    const ownerBefore = profileText(ws, OWNER);

    // TEAM[1] already has an owner; TEAM[0] now owns something, so it may not be owned either.
    await expect(setSubagents(ws, [TEAM[1]!])).rejects.toThrow(`already declared as a subagent of '${TEAM[0]}'`);
    await expect(setSubagents(ws, [TEAM[0]!])).rejects.toThrow("declares its own subagents");
    await expect(setSubagents(ws, [OWNER])).rejects.toThrow("cannot reference itself");
    await expect(setSubagents(ws, ["ghost"])).rejects.toThrow("is not declared in agents/terminals");

    expect(profileText(ws, OWNER)).toBe(ownerBefore);
    expect(ws.config?.declaredOwner).toEqual({ [TEAM[1]!]: TEAM[0]! });
    ws.dispose();
  });

  it("offers the Agent Form only the targets the transaction would accept", async () => {
    const { ws } = await ownedFleet();
    expect(await ws.agentOwnershipView(OWNER)).toEqual({ subagents: [], candidates: TEAM });

    await setSubagents(ws, [TEAM[0]!]);
    // A declared child stays a candidate FOR ITS OWN OWNER, so the form can render it checked and
    // let it be unchecked; it disappears from every other agent's candidate list instead.
    expect(await ws.agentOwnershipView(OWNER)).toEqual({ subagents: [TEAM[0]], candidates: TEAM });
    // An owned agent may own nothing, so the form shows why instead of an empty picker.
    expect(await ws.agentOwnershipView(TEAM[0]!)).toEqual({ subagents: [], candidates: [], ownedBy: OWNER });
    // An unowned peer may still declare — but never the child this owner took, and never the owner
    // itself, which now declares subagents of its own.
    expect(await ws.agentOwnershipView(TEAM[1]!)).toEqual({ subagents: [], candidates: [TEAM[2]] });
    ws.dispose();
  });
});

/**
 * t-e722ce — ONE human door, and the proof that it is the door that WORKS.
 *
 * The trap this task exists inside is an ordering trap. The button the owner asked to remove
 * (sidebar → Remove) was the only one that could finish the job; the button he asked to keep (Agent
 * Studio → Forget) was the one that refused. Removing the first before the second could do the work
 * would leave a human with no door at all — so the two halves land together, and this is the test
 * that proves the surviving half inherited the capability.
 *
 * It is deliberately built on a REAL git repository with a REAL worktree. The whole failure was
 * about what happens to a checkout and to the two records that claim it, and a fake `worktrees.remove`
 * would assert only that the code calls the function it obviously calls.
 */
function gitRepoWorkspace(): string {
  const root = mkdir();
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "T"]);
  fs.writeFileSync(path.join(root, "README.md"), "hi\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return root;
}

it("t-e722ce: Agent Studio → Forget removes the worktree the sidebar's Remove used to remove", async () => {
  const root = gitRepoWorkspace();
  const homeDir = mkdir();
  const worktreeBase = mkdir();
  // Two agents: `tachyon.yml` refuses to lose its last one, and the point here is the worktree.
  const { host } = canonicalHost(root, [{ name: "reviewer" }, { name: "keeper" }], `settings:\n  auth: false\n  worktree:\n    base: ${worktreeBase}\n`);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    // Give the agent a real checkout, claimed in BOTH records — exactly the state the dogfood found
    // `claude-validador` and `codex` in, and the state in which every human door disagreed.
    const branch = "tachyon/reviewer";
    const worktreePath = path.join(worktreeBase, "reviewer");
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "main"], { cwd: root, stdio: "ignore" });
    const record = {
      path: worktreePath,
      branch,
      tachyonCreatedBranch: true,
      baseRef: execFileSync("git", ["rev-parse", "main"], { cwd: root, encoding: "utf8" }).trim(),
      createdAt: new Date().toISOString(),
    };
    ws.ledger.record("reviewer", { cwd: worktreePath, worktree: record, def: { cmd: "codex", kind: "agent" } });
    ws.managedWorktrees.syncAgentRecord("reviewer", record);
    expect(ws.managedWorktrees.list({ kind: "agent" })).toHaveLength(1);

    // 0. THE OTHER HUMAN DOOR IS CLOSED. Control → Worktrees keeps the CHANGE worktrees and hands
    //    agent ones back by name. It has to REFUSE rather than merely hide the button, because what
    //    it performs is real and partial — it drops the registry entry and leaves the session ledger
    //    still owning the checkout, so forget goes on refusing `forget-worktree-owned` while the
    //    surface that could have fixed it stops offering the branch. That is the measured dead end.
    const entry = ws.managedWorktrees.list({ kind: "agent" })[0]!;
    const refusedByControl = await executeExtensionCommand(
      // Only `workspace` is reached on this path; the rest of the context is never touched by the
      // hygiene case, and stubbing it keeps the case under test in view.
      { workspace: ws, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
      { action: "worktree.remove-managed", id: entry.id },
    ) as { removed: boolean; error?: string };
    expect(refusedByControl.removed).toBe(false);
    expect(refusedByControl.error).toContain("Agent Studio");
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(ws.ledger.get("reviewer")?.worktree?.path).toBe(worktreePath);

    // 1. THE PLAN. One click, before anything is approved, and it names the checkout rather than
    //    making the human discover it through a refusal.
    const revision = (await ws.inspectAgentProfileStudio("reviewer")).revision;
    const plan = await ws.planAgentProfileForget("reviewer", revision);
    expect(plan.authority).toBe("session-ledger");
    expect(plan.executable).toBe(true);
    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    expect(byId.get("stop-session")?.state).toBe("satisfied");
    expect(byId.get("remove-worktree")).toMatchObject({ state: "will-run" });
    expect(byId.get("remove-worktree")?.detail).toContain(worktreePath);
    expect(byId.get("remove-locator")?.state).toBe("will-run");
    expect(byId.get("quarantine-profile")?.state).toBe("will-run");
    // The retention declaration is the cascade's, not the bare transaction's: the worktree IS
    // deleted here, so claiming it survives would be the plan lying about its own first step.
    expect(plan.retained).not.toContain("worktrees");
    expect(plan.retained).toContain("continuity");

    // 2. THE EXECUTION, through the door the panel actually calls. Before this change it resolved
    //    `{ kind: "refused", code: "agent-profile/forget-worktree-owned" }` and nothing moved.
    const forgotten = await ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "forget",
      agentName: "reviewer",
      expectedRevision: revision,
      confirmation: "reviewer",
    });
    expect(forgotten).toMatchObject({ kind: "forgotten", agentName: "reviewer" });

    // 3. THE RESULT — everything the sidebar's Remove used to leave behind it, and the three sources
    //    agreeing again, which is the state the dogfood had to reach by hand.
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(ws.ledger.get("reviewer")).toBeUndefined();
    expect(ws.managedWorktrees.list({ kind: "agent" })).toHaveLength(0);
    expect(ws.config?.agents.reviewer).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer"))).toBe(false);
  } finally {
    ws.dispose();
  }
});

/**
 * t-621613 — the same Control → Worktrees button, on an entry whose agent does not exist.
 *
 * The refusal above names Agent Studio → Forget as the way out. That door is reached BY NAME: it
 * needs a roster row to be listed and a ledger row to plan the removal, and an orphan entry has
 * neither — so the refusal names nothing reachable and the checkout can only be cleared by raw git
 * plus hand-editing `.tachyon/managed-worktrees.json`, which is exactly what happened on 2026-08-02.
 *
 * Both halves are one case on purpose: the entry that still has an agent must go on being refused in
 * the same words, or this stopped being an exception and became a hole.
 */
it("t-621613: Control → Worktrees removes an agent entry whose agent is gone, and still refuses one whose agent is not", async () => {
  const root = gitRepoWorkspace();
  const homeDir = mkdir();
  const worktreeBase = mkdir();
  const { host } = canonicalHost(root, [{ name: "reviewer" }, { name: "keeper" }], `settings:\n  auth: false\n  worktree:\n    base: ${worktreeBase}\n`);
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  const control = { workspace: ws, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0];
  const registerHome = (agent: string): { path: string; branch: string } => {
    const branch = `tachyon/${agent}`;
    const worktreePath = path.join(worktreeBase, agent);
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, "main"], { cwd: root, stdio: "ignore" });
    ws.managedWorktrees.syncAgentRecord(agent, {
      path: worktreePath,
      branch,
      tachyonCreatedBranch: true,
      baseRef: execFileSync("git", ["rev-parse", "main"], { cwd: root, encoding: "utf8" }).trim(),
      createdAt: new Date().toISOString(),
    });
    return { path: worktreePath, branch };
  };
  try {
    // THE ORPHAN: a registry entry and a checkout for a name that is in no roster and no ledger.
    const ghost = registerHome("ghost");
    // THE LIVE HOME: declared in tachyon.yml, so somebody still lives there.
    const kept = registerHome("keeper");
    const idOf = (agent: string) => ws.managedWorktrees.list({ kind: "agent" }).find((e) => e.agent === agent)!.id;

    const removed = await executeExtensionCommand(control, { action: "worktree.remove-managed", id: idOf("ghost") }) as {
      removed: boolean; error?: string;
    };

    expect(removed.removed).toBe(true);
    expect(fs.existsSync(ghost.path)).toBe(false);
    expect(ws.managedWorktrees.list({ kind: "agent" }).some((e) => e.agent === "ghost")).toBe(false);

    // FAIL-BEFORE for the half that must not change: this refused with the Agent Studio message
    // before the change and still does, because `keeper` is declared.
    const refused = await executeExtensionCommand(control, { action: "worktree.remove-managed", id: idOf("keeper") }) as {
      removed: boolean; error?: string;
    };
    expect(refused.removed).toBe(false);
    expect(refused.error).toContain("Agent Studio");
    expect(fs.existsSync(kept.path)).toBe(true);
  } finally {
    ws.dispose();
  }
});

/**
 * t-e722ce — the plan REFUSES in the same words the transaction would, and refusing is not acting.
 *
 * A blocked step has to be distinguishable from a step that will run, and the plan must leave the
 * workspace exactly as it found it: this is the read-only half of the contract, and a projection
 * that quietly performed its own first step would be the worst possible version of this feature.
 */
it("t-e722ce: the forget plan names the blocking precondition and changes nothing", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  const { host } = canonicalHost(root, [{ name: "reviewer" }], "settings:\n  auth: false\n");
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    await ws.manager.spawn("reviewer");
    const revision = (await ws.inspectAgentProfileStudio("reviewer")).revision;
    const plan = await ws.planAgentProfileForget("reviewer", revision);
    const stop = plan.steps.find((step) => step.id === "stop-session");
    // A live session is a step the cascade PERFORMS (it kills the pane), not a wall — so the plan
    // must say "will run" and name the kill, or the human is being asked to go stop something the
    // product was about to stop for them. That misdirection is the whole class of bug here.
    expect(stop?.state).toBe("will-run");
    expect(plan.executable).toBe(true);
    // Read-only: the agent is still declared, still on disk, still in tmux.
    expect(asAgent(ws.config?.agents.reviewer)?.profileLifecycle).toBeDefined();
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer", "agent.yml"))).toBe(true);

    // A revision that moved under the panel is refused as a VALUE, with its code intact, exactly as
    // the lifecycle door refuses — the plan crosses the same wire and must survive it the same way.
    await expect(ws.planAgentProfileForget("reviewer", "f".repeat(64)))
      .rejects.toMatchObject({ code: "agent-profile/revision-conflict" });
  } finally {
    ws.dispose();
  }
});

/**
 * t-d06da3 (spec 484, "failed create") — the fourth measure-first read, end to end on a real git
 * repository: an isolated launch that fails after `git worktree add` has already succeeded.
 *
 * t-d29398 CHANGED THE ANSWER, deliberately, and this case is now the pair of outcomes rather than the
 * one. The old contract preserved EVERY failed create, on the argument that deleting one "would risk
 * deleting a concurrent ignored write or rewinding a commit after a time-of-check/time-of-use gap".
 * That argument described a probe-then-remove this no longer performs: the compensation is a SOFT
 * `git worktree remove`, and git re-reads the tree inside the removal and refuses on any modified or
 * untracked file, so there is no gap to race. What the old contract cost was measured on 2026-08-07 —
 * the owner's launch failed on a missing credential, the locked leftover refused every retry, and the
 * refusal instructed him to unlock a checkout the product gave him no way to unlock.
 *
 * So: debris this attempt made goes, and anything git will not part with stays — and the original
 * question this case exists to answer is asked of BOTH outcomes, because it is the same question.
 * `classify.ts` classifies a registered `ManagedWorktreeEntry`, so a preserved checkout is visible to
 * `worktree_audit` iff `.tachyon/managed-worktrees.json` still names it, and a discarded one is
 * residue of a second kind if that row survives it.
 */
it("t-d06da3/t-d29398: a launch that fails after `git worktree add` discards the checkout it just made, registry row and all", async () => {
  const root = gitRepoWorkspace();
  const homeDir = mkdir();
  const worktreeBase = mkdir();
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    `agents: {}\nsettings:\n  auth: false\n  worktree:\n    base: ${worktreeBase}\n`,
  );
  const host = new SharedSecretHost(mkdir(), new Map());
  // The failure: tmux refuses to create the session. That lands AFTER cwd resolution, which is where
  // a real launch spends most of its fallible steps, and it is the shape every one of them shares.
  let refuseSessions = true;
  const fake = fakeTmux({
    onExec: (args) => { if (refuseSessions && args.includes("new-session")) throw new Error("tmux server unavailable"); },
  });
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    await ws.commitAgentProfileLifecycle({
      agentName: "isolated",
      operation: "create",
      createProfile: {
        runtime: { adapter: "codex", executable: "codex" },
        workspace: { worktree: { enabled: true } },
      },
    });

    // Measured, not assumed: the launch fails through the PRESERVATION path, so the assertions below
    // are about a checkout the product deliberately kept — not one it happened not to reach yet.
    // The human is left holding the actionable cause and nothing else: no second failure about
    // recovery state, because there is no recovery state.
    const failure = await ws.manager.spawn("isolated").then(() => null, (error: unknown) => error as Error);
    expect(failure?.message).toContain("tmux server unavailable");

    const checkout = ws.worktrees.pathForAgent("isolated");
    // 1. Gone from disk and from git — the leftover that refused the owner's retry cannot form.
    expect(fs.existsSync(checkout)).toBe(false);
    // 2. And gone from the registry. `Workspace.resolveSpawnCwd` registers the record the moment the
    //    resolver hands it back — before the HEAD probe, before any launch step can fail — so a
    //    discard that left the row behind would just move the residue one surface over: a claim on a
    //    directory that does not exist, which is exactly what `record-only` rows are.
    expect(ws.managedWorktrees.list({ kind: "agent" }).map((e) => e.path)).not.toContain(path.resolve(checkout));

    // And the retry, once the cause is fixed, is an ordinary launch again.
    refuseSessions = false;
    await ws.manager.spawn("isolated");
    expect(fs.existsSync(checkout)).toBe(true);
  } finally {
    ws.dispose();
  }
});

/**
 * t-d29398 — the other outcome, on the same seam: git refuses, so the checkout stays, still
 * quarantined and still REGISTERED. This is the half the door exists for, and it is what keeps the
 * discard above from being "delete the failed launch's tree" — the same code path answers both, and
 * which one it answers is decided by git looking at the tree, not by us deciding beforehand.
 */
it("t-d29398: a failed launch preserves — and keeps registered — a checkout that has something in it", async () => {
  const root = gitRepoWorkspace();
  const homeDir = mkdir();
  const worktreeBase = mkdir();
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    `agents: {}\nsettings:\n  auth: false\n  worktree:\n    base: ${worktreeBase}\n`,
  );
  const host = new SharedSecretHost(mkdir(), new Map());
  // Someone writes into the fresh checkout before the launch fails. `worktreeSetup` is the realistic
  // author; the point under test is git's refusal, so the file is written by the failing step itself.
  const fake = fakeTmux({
    onExec: (args) => {
      if (!args.includes("new-session")) return;
      const checkout = path.join(worktreeBase, workspaceHash(root), "isolated");
      if (fs.existsSync(checkout)) fs.writeFileSync(path.join(checkout, "unsaved.txt"), "someone's work\n");
      throw new Error("tmux server unavailable");
    },
  });
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: homeDir },
  );
  try {
    await ws.commitAgentProfileLifecycle({
      agentName: "isolated",
      operation: "create",
      createProfile: {
        runtime: { adapter: "codex", executable: "codex" },
        workspace: { worktree: { enabled: true } },
      },
    });

    const failure = await ws.manager.spawn("isolated").then(() => null, (error: unknown) => error as AggregateError);
    expect((failure?.errors ?? []).map((e: Error) => e.message)).toContain(
      "agent worktree recovery state was preserved instead of automatic cleanup",
    );

    const checkout = ws.worktrees.pathForAgent("isolated");
    expect(fs.readFileSync(path.join(checkout, "unsaved.txt"), "utf8")).toBe("someone's work\n");
    expect(ws.managedWorktrees.list({ kind: "agent" }).map((e) => e.path)).toContain(path.resolve(checkout));

    // Visible AS quarantined, with the facts a human needs before touching it — that is what makes
    // the refusal's "Release lock" a reachable gesture rather than a sentence about one.
    const [row] = await ws.managedWorktrees.listClassified({ kind: "agent" });
    expect(row?.classification.lock).toBeDefined();
    expect(row?.classification.dirty).toBe(true);
    expect(row?.classification.state).toBe("needs-review");

    const released = await ws.managedWorktrees.releaseLock(row!.id, { actor: { kind: "human" } });
    expect(released.released).toBe(true);
    expect(fs.readFileSync(path.join(checkout, "unsaved.txt"), "utf8")).toBe("someone's work\n");
  } finally {
    ws.dispose();
  }
});

/**
 * spec 484 — the branch a Temporary child is born on, proven THROUGH the Workspace and real git.
 *
 * `resolveWorktreeCwd` decides that branch from `ctx.temporary`, and the only thing that puts that
 * fact in front of it is one property in `Workspace.resolveSpawnCwd`. The resolver's own unit tests
 * hand it `temporary: true` themselves, so not one of them can see whether the Workspace does —
 * delete the plumbing and they all stay green while every real spawn silently goes back to the
 * name-derived branch. A source pin asserting the expression appears once stood here instead; that
 * is the shape t-e73e54 already caught being wrong (a second door elsewhere satisfies it just as
 * happily, a comment satisfies it, and rewriting the same expression breaks it for nothing).
 *
 * So these drive the composition that actually ships — `Workspace` → `AgentManager.spawn` → the
 * resolver → `git` — and read the answer off the repository, where a branch either exists or does
 * not. A REAL repo is not decoration here: adoption of a leftover branch is a git decision
 * (`exists-free` → attach), and a faked `ensure` would only assert that we call what we call.
 */
function delegatingWorkspace(
  tmuxOpts: Parameters<typeof fakeTmux>[0] = {},
): Promise<{ root: string; ws: Workspace; fake: ReturnType<typeof fakeTmux> }> {
  const root = gitRepoWorkspace();
  const worktreeBase = mkdir();
  // `boss` is the parent this child is delegated by. It is declared because lineage must name an
  // agent this workspace knows; where the PARENT runs is never consulted on this path, because a
  // child that asked for `worktree: true` is getting its own checkout rather than inheriting one.
  const { host } = canonicalHost(
    root,
    [{ name: "boss", spec: { runtime: "claude" } }],
    `settings:\n  auth: false\n  worktree:\n    base: ${worktreeBase}\n`,
  );
  const fake = fakeTmux(tmuxOpts);
  return Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT, agentProfileHomeDir: mkdir() },
  ).then((ws) => ({ root, ws, fake }));
}

/** Every local branch the repository actually has — the only authority on what could be adopted. */
const branchesOf = (repo: string): string[] =>
  execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: repo, encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("spec 484: a delegated Temporary child is born on a per-SPAWN branch, and the name-derived one is never minted", async () => {
  const { root, ws, fake } = await delegatingWorkspace();
  try {
    await ws.manager.spawn("residuo", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });

    const record = ws.ledger.get("residuo")?.worktree;
    expect(record?.branch).toMatch(/^tachyon\/tmp\.residuo\.\d{8}-\d{6}-[0-9a-z]+$/u);
    // Git is the authority, not our own record: the checkout is really sitting on that branch.
    expect(gitIn(record!.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(record!.branch);
    // And the branch a SECOND child of this name would have found free and adopted was never created.
    expect(branchesOf(root)).not.toContain("tachyon/residuo");
  } finally {
    ws.dispose();
    await fake.cleanup();
  }
});

it("spec 484: two spawns of the SAME Temporary name get two different branches, and the first child's commits are left alone", async () => {
  const { root, ws, fake } = await delegatingWorkspace();
  try {
    await ws.manager.spawn("residuo", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });
    const first = ws.ledger.get("residuo")!.worktree!;
    // Give the first child work of its own, because the defect is not "same string" — it is a second
    // child committing on top of a stranger's commits while its briefing says it starts from main.
    fs.writeFileSync(path.join(first.path, "first-childs-work.txt"), "written by the first residuo\n", "utf8");
    gitIn(first.path, ["add", "-A"]);
    gitIn(first.path, ["commit", "-m", "first child's work"]);
    const firstTip = gitIn(root, ["rev-parse", first.branch]);

    // End of life, exactly as the Bridge performs it: kill the pane, then drop the row. Dismiss is
    // what clears the ledger, and the cleared ledger is what makes the respawn a NEW child rather
    // than a relaunch of this one.
    await ws.manager.kill("residuo");
    ws.manager.dismissTemporary("residuo");
    // Sweep the CHECKOUT and keep the branch — the leftover a human is left holding after a one-shot
    // child, and the exact state in which `exists-free` → attach used to fire.
    expect(await ws.worktrees.remove(first, false)).toMatchObject({ removed: true, branchDeleted: false });
    expect(branchesOf(root)).toContain(first.branch);

    await ws.manager.spawn("residuo", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });
    const second = ws.ledger.get("residuo")!.worktree!;

    // The property the user actually gets: a reused NAME is not a reused identity.
    expect(second.branch).not.toBe(first.branch);
    expect(second.branch).toMatch(/^tachyon\/tmp\.residuo\./u);
    // It started from the trunk, which is what its briefing told it, not from its namesake's tip.
    expect(fs.existsSync(path.join(second.path, "first-childs-work.txt"))).toBe(false);
    expect(gitIn(second.path, ["rev-parse", "HEAD"])).toBe(gitIn(root, ["rev-parse", "main"]));
    // And the orphan is still exactly where its owner left it — nothing was built on top of it.
    expect(gitIn(root, ["rev-parse", first.branch])).toBe(firstTip);
  } finally {
    ws.dispose();
    await fake.cleanup();
  }
});

/**
 * t-28bf8f — the refusal that used to strand a checkout with NO door on it.
 *
 * MEASURED TWICE on 0.56.149, in two runtimes: `kill_agent` on a Temporary child that owned a checkout
 * answered `still has a live root process for its worktree` — a correct refusal, because tearing a
 * checkout out from under a live process is the data loss `rollbackPreparedWorktree` exists to avoid —
 * and left behind the worktree, its branch, its `managed-worktrees.json` entry, and NO session row.
 * The four end-of-life doors (UI delete, `dismiss_agent`, Agent Studio Forget, `kill_agent`) all address
 * an agent BY NAME, so all four then answered "not found"; the fifth, `unregister_worktree`, addresses
 * the entry by id and refuses anyone who is not its owner — and the owner was the row the same call had
 * just deleted. Both cleanups were `git worktree remove --force` + `git branch -D` + hand-editing JSON.
 *
 * The trigger is a narrow race (the coordinator's own journal refuted "agents that did work": six clean
 * kills, two orphans, and what separates them is only whether the pane's root process was still alive at
 * the instant of measurement). So this does not wait for the race — it FORCES the state: `kill-session`
 * leaves the pane's root process running with its cwd inside the checkout, which is exactly what
 * `refreshWorktreeOccupancy` was already written to quarantine on, and what `/proc/<pid>/cwd` then reads.
 *
 * What it asserts is atomicity, not the refusal: after a refusal NOTHING durable moved, and the agent is
 * still listed and still addressable — so the retry that finishes the job exists at all.
 */
it("t-28bf8f: a kill refused by a live root process moves nothing, and the retry after it dies finishes the removal", async () => {
  const { root, ws, fake } = await delegatingWorkspace({ realPaneProcesses: true, orphanPaneProcesses: true });
  const notices: string[] = [];
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  registerTools(
    { registerTool: (name: string, _schema: unknown, handler: unknown) => { tools.set(name, handler as never); } } as never,
    {
      workspaceRoot: root,
      caller: { kind: "agent", name: "boss" },
      notify: (message: string) => { notices.push(message); },
      manager: ws.manager,
      // The Workspace IS the removal cascade's port bundle, exactly as it wires itself (`agentWorktrees: this`).
      agentWorktrees: ws,
    } as never,
  );
  const killAgent = tools.get("kill_agent")!;
  const listed = async (): Promise<string[]> => (await ws.manager.list()).map((a) => a.name);
  try {
    await ws.manager.spawn("filho", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });
    const record = ws.ledger.get("filho")!.worktree!;
    // Occupancy is captured from the LIVE pane, with its root pid — the ordinary reading every worktree
    // surface performs (`WorktreeManager.remove`, Control → Worktrees' classifier, `worktree_audit`),
    // and the state the field repro was in when its kill arrived.
    expect(await ws.manager.worktreeOccupant(record.path)).toMatchObject({ state: "live", agent: "filho" });

    const refused = await killAgent({ name: "filho" });

    // 1. THE REFUSAL IS RIGHT, and stays right — this change never relaxes it.
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("still has a live root process");
    expect(refused.content[0]?.text).toContain("wait for that process to exit, then retry kill_agent('filho')");
    // 2. AND NOTHING MOVED. Each of these was measured as moved-or-stranded in the field repro.
    expect(await listed()).toContain("filho");                                       // list_agents
    expect(ws.ledger.get("filho")?.worktree?.path).toBe(record.path);                // sessions.json
    expect(ws.managedWorktrees.list({ kind: "agent" }).map((e) => e.agent)).toContain("filho"); // managed-worktrees.json
    expect(fs.existsSync(record.path)).toBe(true);
    expect(branchesOf(root)).toContain(record.branch);
    // The per-spawn settings file stands for the whole ephemeral footprint `removeEphemeralFootprint`
    // deletes — harness home, activity log, pane transcript. None of it is
    // recoverable, which is why this had to be PREVENTED rather than rolled back after the fact.
    expect(fs.existsSync(spawnSettingsPath(root, "filho"))).toBe(true);

    // 3. THE ROOT PROCESS DIES, and the SAME door — addressed by the same name, which only still
    //    resolves because the refusal kept the row — completes the whole removal.
    await fake.stop(ws.manager.session("filho"));
    const done = await killAgent({ name: "filho" });

    expect(done.isError).toBeFalsy();
    expect(done.content[0]?.text).toContain(record.path);
    expect(await listed()).not.toContain("filho");
    expect(ws.ledger.get("filho")).toBeUndefined();
    expect(ws.managedWorktrees.list({ kind: "agent" })).toHaveLength(0);
    expect(fs.existsSync(record.path)).toBe(false);
    expect(branchesOf(root)).not.toContain(record.branch);
    expect(fs.existsSync(spawnSettingsPath(root, "filho"))).toBe(false);
  } finally {
    ws.dispose();
    await fake.cleanup();
  }
});

/**
 * t-28bf8f — the other two actors that reach the same effect, and neither goes through a removal door.
 *
 * The field repro arrived through `kill_agent`, but "who else can reach this?" answers with two more:
 * the sidebar's forced Kill (`agent.kill` → `manager.kill`), which never refuses anything, and Stop All
 * (`killAll`), which collects Temporary rows through its OWN copy of the collection rather than through
 * `kill`. Both would strand a checkout, its branch and its registry entry behind a row they deleted —
 * silently, with no refusal to blame. So the invariant is asserted per door, not per bug report.
 */
it("t-28bf8f: neither a forced Kill nor Stop All collects a Temporary row that still owns a checkout", async () => {
  const { ws, fake } = await delegatingWorkspace();
  const owns = (name: string): boolean =>
    ws.managedWorktrees.list({ kind: "agent" }).some((e) => e.agent === name) && !!ws.ledger.get(name)?.worktree;
  try {
    await ws.manager.spawn("byKill", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });
    await ws.manager.kill("byKill");
    // Stopped, still listed, and both records still agree about who owns the checkout — which is what
    // makes `dismiss_agent`/`kill_agent`/UI Remove able to finish it later.
    expect((await ws.manager.list()).map((a) => a.name)).toContain("byKill");
    expect(owns("byKill")).toBe(true);

    await ws.manager.spawn("byStopAll", { cmd: "claude", kind: "agent", parent: "boss", worktree: true, reveal: false });
    await ws.manager.killAll();
    expect((await ws.manager.list()).map((a) => a.name)).toEqual(expect.arrayContaining(["byKill", "byStopAll"]));
    expect(owns("byStopAll")).toBe(true);

    // Non-vacuity: a Temporary that owns NOTHING is still collected by a stop, exactly as spec 211
    // requires — the guard is about the checkout, not about Temporary rows in general.
    await ws.manager.spawn("semArvore", { cmd: "claude", kind: "agent", parent: "boss", reveal: false });
    await ws.manager.kill("semArvore");
    expect((await ws.manager.list()).map((a) => a.name)).not.toContain("semArvore");
  } finally {
    ws.dispose();
    await fake.cleanup();
  }
});

/**
 * t-746f0f — a capability may be authorized while the agent runs, and the product SAYS what that
 * means for the session in front of the human.
 *
 * The precondition these cases measure was never argued for this door: it was born as
 * `assertAgentStoppedForProfileMigration` for the legacy→canonical migration and became
 * `…ForProfileMutation` on every lifecycle commit when the legacy format was removed. The cost was
 * measured live on 0.56.157 — a human killed a running coordinator's session to give it one skill,
 * and read "The profile lifecycle action could not be completed." on the way there.
 */
describe("Agent Studio — authorizing a capability with the agent running (t-746f0f)", () => {
  const AGENT = "claudeCoordenador";

  async function runningAgentWithSkills(skills: readonly string[]) {
    const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: AGENT, spec: { runtime: "claude" } }] });
    for (const skill of skills) {
      const dir = path.join(ws.workspaceRoot, ".claude", "skills", skill);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skill}\n\noriginal content\n`);
    }
    return ws;
  }

  /** What the agent's private home actually holds — the tree the live process was launched with. */
  const deliveredSkills = (ws: Workspace): string[] => {
    const skills = path.join(harnessHome(ws.workspaceRoot, AGENT), "skills");
    return fs.existsSync(skills) ? fs.readdirSync(skills).sort() : [];
  };

  it("authorizes a skill for a RUNNING agent and reports that it lands at the next launch", async () => {
    const ws = await runningAgentWithSkills(["atlas"]);
    try {
      await ws.manager.spawn(AGENT);
      expect(await ws.manager.runningAgents()).toContain(AGENT);

      const result = await ws.authorizeAgentSkill(AGENT, "atlas");

      expect(result).toMatchObject({ ok: true, referenceId: "atlas", reachesAgentAtNextLaunch: true });
      // The grant and the selection are both durable, which is what makes the next launch deliver it.
      const snapshot = await ws.inspectAgentProfileLifecycle(AGENT);
      expect(snapshot.profile.capabilities?.skills).toContain("atlas");
      expect(snapshot.profile.references?.map((reference) => reference.id)).toContain("atlas");
    } finally {
      ws.dispose();
    }
  });

  /**
   * The proof constraint 2 asks for: nothing is reprojected under the live session.
   *
   * Skills reach an agent through `HarnessManager.replaceCapturedSkillTree`, which runs only inside
   * `AgentManager.materializeRuntimeHarness` — spawn, restart, resume, fork. This asserts the
   * consequence rather than the call graph: the tree the session launched with is byte-identical
   * after the authorization, and the capability appears only once the process is replaced.
   */
  it("leaves the live session's delivered skills untouched, and delivers on the next launch", async () => {
    const ws = await runningAgentWithSkills(["atlas"]);
    try {
      await ws.manager.spawn(AGENT);
      const before = deliveredSkills(ws);
      expect(before).not.toContain("atlas");

      await ws.authorizeAgentSkill(AGENT, "atlas");

      // The running agent still holds exactly what it was launched with.
      expect(deliveredSkills(ws)).toEqual(before);

      // The next launch, which is the only thing that materializes a skill tree.
      await ws.manager.kill(AGENT);
      await ws.manager.spawn(AGENT);
      expect(deliveredSkills(ws)).toContain("atlas");
      expect(fs.readFileSync(path.join(harnessHome(ws.workspaceRoot, AGENT), "skills", "atlas", "SKILL.md"), "utf8"))
        .toContain("original content");
    } finally {
      ws.dispose();
    }
  });

  /**
   * Reauthorize is the gesture the task is named for: the tree changed on disk, the pin did not, and
   * `authorizeAgentSkill` without `reauthorize` correctly refuses to accept new content silently.
   */
  it("reauthorizes changed content while the agent runs, re-pinning the new digest", async () => {
    const ws = await runningAgentWithSkills(["atlas"]);
    try {
      await ws.authorizeAgentSkill(AGENT, "atlas");
      const pinned = (await ws.inspectAgentProfileLifecycle(AGENT)).profile.references?.find((r) => r.id === "atlas");
      fs.writeFileSync(path.join(ws.workspaceRoot, ".claude", "skills", "atlas", "SKILL.md"), "# atlas\n\nnew content\n");
      await ws.manager.spawn(AGENT);

      expect(await ws.authorizeAgentSkill(AGENT, "atlas")).toMatchObject({ ok: true, outcome: "digest-changed" });
      const stillPinned = (await ws.inspectAgentProfileLifecycle(AGENT)).profile.references?.find((r) => r.id === "atlas");
      expect(stillPinned?.sha256).toBe(pinned?.sha256);

      expect(await ws.authorizeAgentSkill(AGENT, "atlas", { reauthorize: true }))
        .toMatchObject({ ok: true, outcome: "reauthorized", reachesAgentAtNextLaunch: true });
      const repinned = (await ws.inspectAgentProfileLifecycle(AGENT)).profile.references?.find((r) => r.id === "atlas");
      expect(repinned?.sha256).not.toBe(pinned?.sha256);
    } finally {
      ws.dispose();
    }
  });

  /**
   * The exemption is per caller, not per door. Revoking while the agent runs would leave a withdrawn
   * capability still in the live session, so that one keeps the precondition — and now says so.
   */
  it("still refuses to REVOKE under a live session, naming the sequence", async () => {
    const ws = await runningAgentWithSkills(["atlas"]);
    try {
      await ws.authorizeAgentSkill(AGENT, "atlas");
      await ws.manager.spawn(AGENT);

      await expect(ws.revokeAgentSkill(AGENT, "atlas")).rejects.toMatchObject({
        code: "agent-profile/agent-running",
        message: expect.stringContaining(`Stop '${AGENT}', apply the change, then start it again`),
      });
    } finally {
      ws.dispose();
    }
  });

  /**
   * A plugin commits once per skill through ONE ports object, so the CAS token has to advance with
   * each commit. Captured once and reused, the second skill refused with a revision conflict against
   * its own predecessor — and that refusal reached the panel as "could not be completed".
   */
  it("authorizes every skill of a multi-skill plugin in one gesture", async () => {
    const ws = await runningAgentWithSkills([]);
    try {
      for (const skill of ["mapa", "bussola"]) {
        const dir = path.join(ws.workspaceRoot, ".tachyon", "plugins", "cartografia", "skills", skill);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skill}\n`);
      }
      fs.mkdirSync(path.join(ws.workspaceRoot, ".tachyon"), { recursive: true });
      fs.writeFileSync(path.join(ws.workspaceRoot, ".tachyon", "plugins.lock.json"), JSON.stringify({
        plugins: {
          cartografia: {
            name: "cartografia",
            version: "1.0.0",
            runtimes: ["claude"],
            targets: [
              { runtime: "claude", kind: "skill-dir", file: ".claude/skills/mapa" },
              { runtime: "claude", kind: "skill-dir", file: ".claude/skills/bussola" },
            ],
          },
        },
      }));

      expect(await ws.authorizeAgentPlugin(AGENT, "cartografia")).toMatchObject({
        ok: true,
        authorized: ["bussola", "mapa"],
        outcomes: ["authorized", "authorized"],
      });
      expect((await ws.inspectAgentProfileLifecycle(AGENT)).profile.capabilities?.skills).toEqual(["bussola", "mapa"]);
    } finally {
      ws.dispose();
    }
  });

  /**
   * The requirement STAYS for a mutation a live session was launched from — and now arrives as the
   * refusal it always was, carrying all three gestures instead of one flattened sentence.
   */
  it("names the stop/apply/start sequence for a mutation that does need the agent stopped", async () => {
    const ws = await runningAgentWithSkills([]);
    try {
      await ws.manager.spawn(AGENT);
      const before = await ws.inspectAgentProfileStudio(AGENT);

      const refused = await ws.commitAgentProfileStudioLifecycle({
        schemaVersion: 1,
        operation: "set-enabled",
        agentName: AGENT,
        expectedRevision: before.revision,
        enabled: false,
      });

      expect(refused).toMatchObject({ kind: "refused", code: "agent-profile/agent-running" });
      expect(refused).toMatchObject({
        message: expect.stringContaining(`Stop '${AGENT}', apply the change, then start it again`),
      });
    } finally {
      ws.dispose();
    }
  });
});
