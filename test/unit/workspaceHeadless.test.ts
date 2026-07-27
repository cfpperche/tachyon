import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveAgentProfileHomeDir, Workspace } from "../../src/workspace/Workspace.js";
import { ResumeUnavailableError } from "../../src/agents/AgentManager.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile, spawnSettingsPath } from "../../src/activity/sessionOwners.js";
import { ReloadTransactionStore } from "../../src/host-action/index.js";
import { __createdTerminals, __resetVscodeMock } from "../mocks/vscode.js";
import { Terminals } from "../../src/presentation/Terminals.js";
import type { TerminalPresentationOptions } from "../../src/workspace/TerminalPresentation.js";
import { canonicalBehaviorStubPath } from "../../src/bridge/behaviorStub.js";
import { harnessRoot } from "../../src/harness/HarnessManager.js";
import { briefFilePath } from "../../src/agents/briefFile.js";
import { blankAgentFields } from "../../src/webview/agent-studio-shell/domain.js";
import type { FormState } from "../../src/webview/formLogic.js";
import { loadOrCreateHmacKey } from "../../src/bridge/callerIdentity.js";
import { deterministicGitDeliveryId } from "../../src/git-delivery/store.js";
import { renderEvolutionLearnings } from "../../src/evolution/domain.js";
import { stringify } from "yaml";
import { serializeAgentProfileAuthorityRegistry } from "../../src/config/agentProfileAuthority.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import { agentProfileAuthoritiesSecretKey, workspaceVersionStateKey } from "../../src/workspace/operationalStateKeys.js";
import { writeCanonicalAgent, canonicalAgentSecrets, canonicalAgentsYaml, enableCanonicalSelfEvolution, type CanonicalAgentSpec } from "../helpers/canonicalAgentFixture.js";
import { asAgent } from "../../src/config/loadConfig.js";

/**
 * spec 235 — the headless Workspace smoke test (the deferred spec-233 payoff): drive the orchestrator with
 * NO Electron, NO real tmux, NO bound Bridge port — proving config → managers → monitors → factory
 * lifecycle are wired together correctly. Substrate is injected via `Workspace.createForTest`.
 */

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
  getSetting<T>(section: string, key: string, dflt: T): T {
    const configured = this.settings[`${section}.${key}`];
    return (configured === undefined ? dflt : configured) as T;
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
function fakeTmux(opts: { realPaneProcesses?: boolean } = {}) {
  const sessions = new Set<string>();
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
  const replacePaneProcess = async (name: string) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.set(name, child);
    return child;
  };
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.add(name);
      panes.set(name, "");
      if (opts.realPaneProcesses) await replacePaneProcess(name);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session"); // non-zero exit = does not exist
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
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
      await stop(name);
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
  return { sessions, dead, sent, panes, calls, children, replacePaneProcess, cleanup: async () => { await Promise.all([...children.keys()].map(stop)); }, tmux: new TmuxService(exec) };
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
 * SDD 478 M7 — declare canonical agents inside a root the case built itself, and return the host
 * that attests them. Same shape `makeWorkspace({ canonical })` builds, for the many cases that need
 * to write their own `tachyon.yml` tail (settings, verify blocks) or their own Workspace deps.
 */
function canonicalHost(
  root: string,
  agents: ReadonlyArray<{ name: string; spec?: CanonicalAgentSpec }>,
  extraYaml = "",
  settings: Record<string, unknown> = {},
): { host: SharedSecretHost; secrets: Map<string, string> } {
  const fixtures = agents.map((entry) => writeCanonicalAgent(root, entry.name, entry.spec ?? {}));
  fs.writeFileSync(path.join(root, "tachyon.yml"), canonicalAgentsYaml(fixtures) + extraYaml, "utf8");
  const secrets = canonicalAgentSecrets(root, fixtures);
  return { host: new SharedSecretHost(mkdir(), secrets, settings), secrets };
}

/**
 * SDD 478 M7 — a workspace whose canonical agents have Evolution ENABLED.
 *
 * The projection pins the Evolution selector to a profileId, and only the store mints one, so the
 * store's profile has to exist before the selector can name it: seed a workspace, create the
 * profiles through its own authority, re-sign the profiles, and reload. A canonical agent therefore
 * cannot create its Evolution profile on first session — the profile is what the declaration points
 * at, so it precedes the declaration.
 */
async function createEvolvingWorkspace(
  names: readonly string[],
  runtime: CanonicalAgentSpec["runtime"],
  fake: ReturnType<typeof fakeTmux>,
) {
  const root = mkdir();
  const { host, secrets } = canonicalHost(root, names.map((name) => ({ name, spec: { runtime } })));
  const deps = { host, onViewsChanged: () => {} };
  // The seed workspace gets its own tmux: disposing it must not tear down the channel the case
  // itself is about to spawn through.
  const seed = await Workspace.createForTest(root, deps, { tmux: fakeTmux().tmux, startBridge: false });
  for (const name of names) {
    enableCanonicalSelfEvolution(root, name, (await seed.evolutionStore.ensureProfile(name)).profileId, secrets);
  }
  seed.dispose();
  return { root, host, ws: await Workspace.createForTest(root, deps, { tmux: fake.tmux, startBridge: false }) };
}

async function makeWorkspace(
  onViewsChanged: (view: ViewKind) => void = () => {},
  opts: {
    /** make `b` a real agent on this runtime instead of a supervised shell. */
    bRuntime?: CanonicalAgentSpec["runtime"];
    tachyonYaml?: string;
    canonical?: ReadonlyArray<{ name: string; spec?: CanonicalAgentSpec }>;
    extraYaml?: string;
  } = {},
) {
  const root = mkdir();
  // SDD 478 M7 — a case that needs a real AGENT declares one: a canonical profile plus the
  // host-custodied authority that attests it. `agents:` no longer accepts a definition.
  if (opts.canonical) {
    const fixtures = opts.canonical.map((entry) => writeCanonicalAgent(root, entry.name, entry.spec ?? {}));
    fs.writeFileSync(path.join(root, "tachyon.yml"), canonicalAgentsYaml(fixtures) + (opts.extraYaml ?? ""), "utf8");
    const host = new SharedSecretHost(mkdir(), canonicalAgentSecrets(root, fixtures));
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux: fake.tmux, startBridge: false });
    return { ws, host, ...fake };
  }
  // `a` autostarts (exercises the start() launch path); `b` is launched explicitly via the manager.
  // SDD 478 M7 — `a` and `b` are supervised SHELLS, so they are terminals. They were only agents
  // because `allowLegacyAgentFixtures` accepted an inline shape the product refuses; nothing here
  // exercises an agent capability, so declaring them honestly costs the cases nothing. A case that
  // does need `b` to be an agent asks for `bRuntime`, which declares it canonically.
  const terminals = `terminals:\n  a:\n    cmd: sh\n    autostart: true\n${opts.bRuntime ? "" : "  b:\n    cmd: sh\n"}`;
  const bAgent = opts.bRuntime ? [writeCanonicalAgent(root, "b", { runtime: opts.bRuntime })] : [];
  fs.writeFileSync(path.join(root, "tachyon.yml"), opts.tachyonYaml ?? canonicalAgentsYaml(bAgent) + terminals, "utf8");
  const host = new SharedSecretHost(mkdir(), canonicalAgentSecrets(root, bAgent));
  const { tmux, sessions, dead, sent, panes, calls } = fakeTmux();
  // SDD 368 T14/R4 — createForTest alone yields a ready empty snapshot; callers that need
  // start()-side autostart/rehydrate must call start() explicitly (pre-R3 helper semantics).
  const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux, startBridge: false });
  return { ws, host, tmux, sessions, dead, sent, panes, calls };
}

it("rejects an invalid reload and retains the prior known-good config", async () => {
  // SDD 478 M7 — this used to prove the point with `soul: SOUL.md` on an inline agent. Neither half
  // of that is expressible now: `agents:` takes a profile pointer, and a canonical profile cannot
  // carry `soul` at all (the projection defers it to t-a2827d). The guarantee under test is the
  // reload boundary itself — a rejected edit must leave the last known-good config live — so it is
  // proven with an invalid key on the arm that does accept one.
  const { ws } = await makeWorkspace(() => {}, { tachyonYaml: "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n    restart: on-crash\n" });
  expect(ws.config?.agents.dev.restart).toBe("on-crash");
  fs.writeFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "agents: {}\nterminals:\n  dev:\n    cmd: npm run dev\n    restart: sometimes\n", "utf8");

  expect(ws.reloadConfig()).toBe(false);
  expect(ws.configFailure?.errors).toContain("terminals.dev.restart: must be 'never' or 'on-crash'");
  expect(ws.config?.agents.dev.restart).toBe("on-crash");
  expect(ws.readConfigLkg()?.agents.map((agent) => agent.name)).toContain("dev");
  ws.dispose();
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
    prompt: { role: "reviewer" },
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
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    expect(ws.configFailure).toBeUndefined();
    expect(ws.config?.agents.codex).toMatchObject({ cmd: "codex", role: "reviewer" });
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
    fs.writeFileSync(path.join(profileDir, "agent.yml"), profile.replace("reviewer", "coder"));
    profileWatch!.onEvent();
    expect(ws.configFailure?.errors.join("\n")).toContain("profile/authority-boundary");
    expect(asAgent(ws.config?.agents.codex)?.role).toBe("reviewer");
    expect(() => ws.assertNotLkgOnlySpawn("codex")).toThrow("trusted configuration is invalid");
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
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
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

it("creates and edits canonical Agent Studio profiles through a redacted CAS boundary", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fakeTmux().tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "canonical",
      agentName: "reviewer",
      editable: {
        displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
        cwd: "apps/reviewer", lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
        worktree: { enabled: true, branch: "feature/reviewer" }, isolation: "transcript",
      },
    });
    expect(created.enabled).toBe(false);
    expect(created.editable.role).toBe("reviewer");
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).not.toContain("cmd:");

    const edited = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "canonical",
      agentName: "reviewer",
      expectedRevision: created.revision,
      editable: {
        displayName: "Review Agent", runtime: { adapter: "codex", executable: "codex" }, role: "tester",
        cwd: "apps/reviewer", lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
        worktree: { enabled: true, branch: "feature/reviewer" }, isolation: "transcript",
      },
    });
    expect(edited.editable).toMatchObject({ displayName: "Review Agent", role: "tester", runtime: { adapter: "codex", executable: "codex" } });
    await expect(ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "canonical",
      agentName: "reviewer",
      expectedRevision: created.revision,
      editable: {
        displayName: "Stale", runtime: { adapter: "codex", executable: "codex" }, role: "coder",
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
        worktree: { enabled: false, branch: "" }, isolation: "",
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
    { tmux: fakeTmux().tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "canonical",
      agentName: "reviewer",
      editable: {
        displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
        worktree: { enabled: false, branch: "" }, isolation: "",
      },
    });
    await expect(ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: "reviewer",
      expectedRevision: "f".repeat(64),
      enabled: true,
    })).rejects.toThrow("revision conflict");
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
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    const source = await ws.commitAgentProfileLifecycle({
      agentName: "source",
      operation: "create",
      createProfile: { displayName: "Source", runtime: { adapter: "codex", executable: "codex" }, prompt: { role: "reviewer" } },
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
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    const evolution = await ws.evolutionStore.ensureProfile("reviewer");
    await ws.manager.spawn("reviewer");
    ws.terminals.open("reviewer", ws.manager.session("reviewer"));
    expect(fake.sessions.has(ws.manager.session("reviewer"))).toBe(true);
    await ws.renameAgent("reviewer", "maintainer");

    expect(ws.config?.agents.reviewer).toBeUndefined();
    expect(asAgent(ws.config?.agents.maintainer)?.profileLifecycle).toMatchObject({ agentId: created.snapshot.agentId });
    expect(await ws.inspectAgentProfileLifecycle("maintainer")).toMatchObject({ agentId: created.snapshot.agentId });
    expect(await ws.evolutionStore.readProfile("reviewer")).toBeUndefined();
    expect(await ws.evolutionStore.readProfile("maintainer")).toMatchObject({ profileId: evolution.profileId, agent: "maintainer" });
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
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    const created = await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    await ws.evolutionStore.ensureProfile("reviewer");
    ws.ledger.record("reviewer", { cwd: root, declared: true, updatedAt: "captured" });
    const activityDir = path.join(root, ".tachyon", "activity");
    fs.mkdirSync(activityDir, { recursive: true });
    fs.writeFileSync(path.join(activityDir, `${agentLogId("reviewer")}.jsonl`), "owned activity\n");
    const runtimeHome = ws.harness.home("reviewer");
    fs.mkdirSync(runtimeHome, { recursive: true });
    fs.writeFileSync(path.join(runtimeHome, "credentials.json"), "preserve\n");

    const result = await ws.forgetCanonicalProfileAgent("reviewer");
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

it("refuses canonical forget while any tmux binding still exists", async () => {
  const root = mkdir();
  const homeDir = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  keeper:\n    cmd: sh\nsettings:\n  auth: false\n");
  const host = new SharedSecretHost(mkdir(), new Map());
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(
    root,
    { host, onViewsChanged: () => {} },
    { tmux: fake.tmux, startBridge: false, agentProfileHomeDir: homeDir },
  );
  try {
    await ws.commitAgentProfileLifecycle({
      agentName: "reviewer",
      operation: "create",
      createProfile: { runtime: { adapter: "codex", executable: "codex" } },
    });
    await ws.manager.spawn("reviewer");
    await expect(ws.forgetCanonicalProfileAgent("reviewer")).rejects.toThrow("fully stopped");
    expect(asAgent(ws.config?.agents.reviewer)?.profileLifecycle).toBeDefined();
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "reviewer", "agent.yml"))).toBe(true);
  } finally {
    ws.dispose();
  }
});

it("directs legacy Agent Studio submissions to canonical Agent Studio", async () => {
  const { ws } = await makeWorkspace();
  const invalid = { ...blankAgentFields(), name: "invalid", cmd: "codex", soul: "yes" } as unknown as FormState;
  expect(ws.studioSubmit({ state: invalid })).toEqual([
    "inline agent editing is retired — create or edit the canonical agent in Agent Studio",
  ]);
  ws.dispose();
});

it("moves Evolution on rename while disable and profile edits retain the same canonical profile", async () => {
  // SDD 478 M7 — the disable and the runtime change used to arrive as inline `agents:` text through
  // writeTachyonConfigText, which the config writer now refuses. Both are canonical profile edits,
  // so they are made where they live. The runtime half is now a stronger refusal than an edit —
  // "runtime adapter changes require an explicit authority migration" — so the ordinary edit that
  // stands in for it is a profile field. The guarantee under test is unchanged: no edit may disturb
  // the agent's Evolution state, and a rename must carry it.
  const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: "reviewer", spec: { runtime: "codex" } }] });
  const profile = await ws.evolutionStore.ensureProfile("reviewer");
  const originalRoot = ws.evolutionStore.rootFor("reviewer");

  const retargeted = await ws.commitAgentProfileLifecycle({
    agentName: "reviewer",
    operation: "edit",
    expectedRevision: (await ws.inspectAgentProfileLifecycle("reviewer")).revision,
    patch: { displayName: "Reviewer" },
  });
  const disabled = await ws.commitAgentProfileLifecycle({
    agentName: "reviewer",
    operation: "set-enabled",
    expectedRevision: retargeted.revision,
    enabled: false,
  });
  expect(ws.config?.agents.reviewer).toMatchObject({ cmd: "codex" });
  expect((await ws.readAgentEvolutionOverview("reviewer")).summary).toMatchObject({
    enabled: false,
    profilePresent: true,
    activeVersion: 0,
  });
  expect(ws.evolutionStore.rootFor("reviewer")).toBe(originalRoot);
  expect((await ws.evolutionStore.readProfile("reviewer"))?.profileId).toBe(profile.profileId);

  await ws.commitAgentProfileLifecycle({
    agentName: "reviewer",
    operation: "set-enabled",
    expectedRevision: disabled.revision,
    enabled: true,
  });
  await ws.renameAgent("reviewer", "maintainer");
  expect(ws.config?.agents.reviewer).toBeUndefined();
  expect(ws.config?.agents.maintainer?.cmd).toBe("codex");
  expect(await ws.evolutionStore.readProfile("reviewer")).toBeUndefined();
  expect(await ws.evolutionStore.readProfile("maintainer")).toMatchObject({
    profileId: profile.profileId,
    agent: "maintainer",
    activeVersion: 0,
  });
  const reusedOldName = await ws.evolutionStore.ensureProfile("reviewer");
  expect(reusedOldName.profileId).not.toBe(profile.profileId);

  await ws.forgetAgent("maintainer");
  expect(fs.existsSync(ws.evolutionStore.rootFor("maintainer"))).toBe(false);
  const recreated = await ws.evolutionStore.ensureProfile("maintainer");
  expect(recreated.profileId).not.toBe(profile.profileId);
  await ws.dispose();
});

it("uses Workspace authority for Evolution profile creation and rejects tampered production startup", async () => {
  // SDD 478 M7 — was "first-session creation": a canonical agent's Evolution profile is minted
  // before the declaration that pins it (see createEvolvingWorkspace), so what is provable here is
  // that the profile the WORKSPACE's own authority created starts a session, and a forged one does not.
  const { ws } = await createEvolvingWorkspace(["fresh", "tampered"], "claude", fakeTmux());
  await ws.manager.spawn("fresh");
  await expect(ws.evolutionStore.readProfile("fresh")).resolves.toMatchObject({ agent: "fresh", activeVersion: 0 });

  await ws.evolutionStore.ensureProfile("tampered");
  await fs.promises.writeFile(ws.evolutionStore.learningsPath("tampered"), renderEvolutionLearnings([{
    id: "forged",
    sourceTaskId: "t-999999",
    sourceReviewId: "review-forged",
    approvedAt: "2026-07-21T20:00:00.000Z",
    content: "Unapproved edit.",
  }]), "utf8");
  await expect(ws.manager.spawn("tampered")).rejects.toMatchObject({ code: "evolution/authority-invalid" });
  await ws.dispose();
});

it("rolls back a declared agent rename when the Evolution destination already exists", async () => {
  const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: "reviewer", spec: { runtime: "codex" } }] });
  const reviewer = await ws.evolutionStore.ensureProfile("reviewer");
  const orphan = await ws.evolutionStore.ensureProfile("maintainer");

  // SDD 478 M7 — a declared agent is canonical now, so the rename takes the profile-transaction
  // branch, which reports the same conflict as a plain message instead of an `evolution/*` code.
  // What the case is here to prove is the rollback below: neither side may be left half-moved.
  await expect(ws.renameAgent("reviewer", "maintainer")).rejects.toThrow(
    "Agent Evolution Profile already exists for 'maintainer'",
  );
  expect(ws.config?.agents.reviewer?.cmd).toBe("codex");
  expect(ws.config?.agents.maintainer).toBeUndefined();
  expect(await ws.evolutionStore.readProfile("reviewer")).toEqual(reviewer);
  expect(await ws.evolutionStore.readProfile("maintainer")).toEqual(orphan);
  await ws.dispose();
});

it("leaves no live journal behind when the real config writer refuses a profile mutation", async () => {
  // SDD 478 M7 — `createSoulProfile` mutates a declared agent by adding an inline `soul:` key, and
  // every declared agent is now a canonical profile pointer, which cannot coexist with an inline
  // field. So the mutation is refused by the real writer rather than applied. What this case has
  // always been about survives that change: the transaction must unwind, leaving no live journal.
  const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: "Ada", spec: { runtime: "codex" } }] });
  try {
    await expect(ws.createSoulProfile("Ada")).rejects.toMatchObject({ code: "soul/io-error" });
    await flushMicrotasks();
    const transactions = path.join(ws.workspaceRoot, ".tachyon", "agent-profile-transactions");
    const entries = fs.existsSync(transactions) ? fs.readdirSync(transactions) : [];
    expect(entries.filter((entry) => /^[0-9a-f-]{36}$/i.test(entry))).toEqual([]);
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const DEFAULT_BEHAVIOR_STUB_TEMPLATE = "test/unit/{agent}Behavior.gen.test.ts";

function namedBehaviorSettings(stubPath = DEFAULT_BEHAVIOR_STUB_TEMPLATE) {
  return {
    adapter: "vitest-name" as const,
    command: "npm test --",
    stubPath,
    executorPaths: ["README.md"],
  };
}

function namedBehaviorVerifyYaml(stubPath = DEFAULT_BEHAVIOR_STUB_TEMPLATE): string {
  const settings = namedBehaviorSettings(stubPath);
  return [
    "  verify:",
    "    prepare: node -e \"\"",
    "    behavior:",
    `      adapter: ${settings.adapter}`,
    `      command: ${JSON.stringify(settings.command)}`,
    `      stubPath: ${JSON.stringify(settings.stubPath)}`,
    `      executorPaths: ${JSON.stringify(settings.executorPaths)}`,
    "",
  ].join("\n");
}

describe("Workspace — headless composition smoke (spec 235)", () => {
  it("SDD 369 T3 composes the extension-global Claude capture into the existing per-spawn settings layer", async () => {
    const root = mkdir();
    // SDD 478 M7 — capture composition is a property of the Claude COMMAND LINE, and after the
    // legacy shim an authored command line belongs to an ad-hoc agent: `agents:` takes a canonical
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
    }, { tmux: fake.tmux, startBridge: false });
    try {
      await ws.manager.spawn("claude", { cmd: "claude" });

      expect(requests).toEqual([{
        workspaceRoot: root,
        agent: "claude",
        cwd: root,
        // SDD 478 M7 — an ad-hoc Claude agent runs against its own per-agent harness home, not the
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
    }, { tmux: fake.tmux, startBridge: false });
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

  it("re-anchor transports configured project guidance without overwriting the startup brief", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "guidance.md"), `REANCHOR_GUIDANCE_${"g".repeat(5_000)}`, "utf8");
    const { host } = canonicalHost(root, [{ name: "a", spec: { runtime: "claude" } }], "settings:\n  projectGuidance:\n    files: [guidance.md]\n");
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host, onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      await ws.manager.spawn("a");
      const spawnFile = briefFilePath(root, "a");
      const originalSpawnBrief = fs.readFileSync(spawnFile, "utf8");

      await ws.reanchor("a");

      const session = ws.manager.session("a");
      const injected = fake.sent.get(session) ?? "";
      const reanchorFile = briefFilePath(root, "a", "reanchor");
      const reanchorBrief = fs.readFileSync(reanchorFile, "utf8");
      expect(injected).toContain("── TACHYON PRIMER ──");
      expect(injected).toContain(reanchorFile);
      expect(injected.indexOf("── END PRIMER ──")).toBeLessThan(injected.indexOf(reanchorFile));
      expect(injected.indexOf(reanchorFile)).toBeLessThan(injected.indexOf("── BEFORE FINISHING ──"));
      expect(reanchorBrief).toContain("── PROJECT GUIDANCE (PROJECT-OWNED) ──");
      expect(reanchorBrief).toContain("REANCHOR_GUIDANCE_");
      expect(reanchorBrief).toContain("cat .tachyon/roles/a.md");
      expect(fs.readFileSync(spawnFile, "utf8")).toBe(originalSpawnBrief);
    } finally {
      ws.dispose();
    }
  });

  it("SDD 421 re-anchor reuses the session's pinned Evolution snapshot", async () => {
    const fake = fakeTmux();
    const { ws } = await createEvolvingWorkspace(["a"], "claude", fake);
    try {
      const first = await ws.evolutionStore.createCandidate("a", {
        reviewId: "review-first",
        taskId: "t-111111",
        target: { kind: "learning", content: "Pinned first-session learning.", reason: "Approved before spawn." },
      });
      const firstDetail = await ws.evolutionStore.candidateDetail("a", first.id);
      await ws.evolutionStore.approveCandidate("a", first.id, {
        expectedActiveVersion: 0,
        expectedTargetDigest: firstDetail.currentTargetDigest,
      });
      await ws.manager.spawn("a");
      expect(ws.ledger.get("a")?.evolution?.version).toBe(1);

      const second = await ws.evolutionStore.createCandidate("a", {
        reviewId: "review-second",
        taskId: "t-222222",
        target: { kind: "learning", content: "Next-session-only learning.", reason: "Approved after spawn." },
      });
      const secondDetail = await ws.evolutionStore.candidateDetail("a", second.id);
      await ws.evolutionStore.approveCandidate("a", second.id, {
        expectedActiveVersion: 1,
        expectedTargetDigest: secondDetail.currentTargetDigest,
      });

      await ws.reanchor("a");
      const reanchorPayload = fake.sent.get(ws.manager.session("a")) ?? "";
      expect(reanchorPayload).toContain("Pinned first-session learning.");
      expect(reanchorPayload).not.toContain("Next-session-only learning.");
      expect(ws.ledger.get("a")?.evolution?.version).toBe(1);
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("re-anchor leaves a running pane untouched when configured guidance becomes invalid", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "guidance.md"), "valid guidance", "utf8");
    const { host } = canonicalHost(root, [{ name: "a", spec: { runtime: "claude" } }], "settings:\n  projectGuidance:\n    files: [guidance.md]\n");
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host, onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      await ws.manager.spawn("a");
      const session = ws.manager.session("a");
      fs.rmSync(path.join(root, "guidance.md"));

      await expect(ws.reanchor("a")).rejects.toThrow(/guidance\.md/);
      expect(fake.sessions.has(session)).toBe(true);
      expect(fake.sent.has(session)).toBe(false);
      expect(fs.existsSync(briefFilePath(root, "a", "reanchor"))).toBe(false);
    } finally {
      ws.dispose();
    }
  });

  it("surfaces an automatic re-anchor guidance failure instead of swallowing it", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "guidance.md"), "valid guidance", "utf8");
    const { host } = canonicalHost(root, [{ name: "a", spec: { runtime: "claude" } }], "settings:\n  projectGuidance:\n    files: [guidance.md]\n");
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host, onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      await ws.manager.spawn("a");
      fs.rmSync(path.join(root, "guidance.md"));
      const recoverOnIdle = (ws as unknown as {
        recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
      }).recoverOnIdle.bind(ws);

      await recoverOnIdle("a", true);

      expect(host.notices.some((notice) =>
        notice.level === "warn" &&
        notice.message.includes("could not re-anchor agent 'a'") &&
        notice.message.includes("guidance.md")
      )).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("keeps a failed Resume-all offer and reports a failed fresh-spawn fallback", async () => {
    const { ws, host } = await makeWorkspace();
    const record = { declared: true, cwd: ws.workspaceRoot };
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

  it("accepts a clean recovery inventory with more than one unique commit", async () => {
    const { ws } = await makeWorkspace();
    const repo = mkdir();
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repo, "recovery.txt"), "base\n");
    git(repo, ["add", "recovery.txt"]);
    git(repo, ["commit", "-m", "base"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(repo, "recovery.txt"), "one\n");
    git(repo, ["commit", "-am", "one"]);
    const firstUniqueSha = git(repo, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(repo, "recovery.txt"), "two\n");
    git(repo, ["commit", "-am", "two"]);
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const inspect = (ws as unknown as {
      requiredRecoveryInventory(cwd: string, base: string): Promise<{
        inventory: { headSha: string; dirtyPaths: Array<{ status: string; path: string }>; uniqueCommits: string[] };
      }>;
    }).requiredRecoveryInventory.bind(ws);
    try {
      await expect(inspect(repo, baseSha)).resolves.toEqual({
        inventory: { headSha, dirtyPaths: [], uniqueCommits: [headSha, firstUniqueSha] },
      });

      fs.writeFileSync(path.join(repo, "dirty.txt"), "untracked\n");
      await expect(inspect(repo, baseSha)).resolves.toEqual({
        inventory: { headSha, dirtyPaths: [{ status: "??", path: "dirty.txt" }], uniqueCommits: [headSha, firstUniqueSha] },
      });
    } finally {
      ws.dispose();
    }
  });

  it("routes an exact pending recovery join through its existing reservation", async () => {
    const { ws } = await makeWorkspace();
    const recoveryWorktree = mkdir();
    const pending = {
      id: "d-recovery",
      lease: { state: "pending", holder: { segmentId: "seg-recovery", executionAgent: "recovery", reservationNonce: "nonce" } },
    };
    const internal = ws as unknown as {
      exactCanonicalProjection(delivery: unknown): Promise<{
        worktreePath: string; branchRef: string; tachyonCreatedBranch: boolean; baseRef: string; createdAt: string;
      }>;
      prepareDeliveryJoin(name: string, request: {
        deliveryId: string; role: "recovery"; ownsSubset: string[]; expectedHead: string; operationId: string;
      }): Promise<{ cwd: string; reservationNonce: string; segmentId: string }>;
    };
    vi.spyOn(ws.deliveries, "get").mockResolvedValue(pending as never);
    internal.exactCanonicalProjection = vi.fn(async () => ({
      worktreePath: recoveryWorktree,
      branchRef: "tachyon/recovery",
      tachyonCreatedBranch: true,
      baseRef: "main",
      createdAt: "2026-07-17T00:00:00.000Z",
    }));
    const prepare = vi.spyOn(ws.deliveryLease, "preparePendingRecovery").mockResolvedValue({
      delivery: pending,
      reservationNonce: "nonce",
    } as never);
    try {
      await expect(internal.prepareDeliveryJoin("recovery", {
        deliveryId: "d-recovery",
        role: "recovery",
        ownsSubset: ["test/fixtures/spec376-canonical-dogfood.json"],
        expectedHead: "head",
        operationId: "join-recovery",
      })).resolves.toMatchObject({ cwd: recoveryWorktree, reservationNonce: "nonce", segmentId: "seg-recovery" });
      expect(prepare).toHaveBeenCalledWith({
        deliveryId: "d-recovery",
        canonicalWorktree: recoveryWorktree,
        expectedHeadSha: "head",
        executionAgent: "recovery",
        principal: undefined,
        ownsSubset: ["test/fixtures/spec376-canonical-dogfood.json"],
      });
    } finally {
      ws.dispose();
    }
  });

  it("refuses a canonical gated open whose worktree carries only a pinned base SHA", async () => {
    expect.hasAssertions();
    // t-2dd637 — `WorktreeRecord.baseRef` is a fork-point SHA on every producer path. Coalescing the
    // projection base to it pins containment to a commit, which `containedInBase` then reads as a
    // ceiling and refuses forever. The open boundary must fail closed instead.
    const { ws } = await makeWorkspace();
    const pinned = "8787658ae1bc2ed11c3ee002f0bf2cb7bd3b4c08";
    // `open` is the projection's durable write (DeliveryProjectionService.openCanonical).
    const gitCreate = vi.spyOn(ws.gitDeliveries, "open");
    const deliveryCreate = vi.spyOn(ws.deliveries, "create");
    const record = (ws as unknown as {
      recordCanonicalDelivery(input: {
        name: string;
        gate: { behaviorTest: string; owns?: string[] };
        worktree: { path: string; branch: string; tachyonCreatedBranch: boolean; baseRef: string; baseBranch?: string; createdAt: string };
        baseSha: string;
      }): Promise<unknown>;
    }).recordCanonicalDelivery.bind(ws);
    try {
      await expect(record({
        name: "implementer",
        gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] },
        worktree: {
          path: mkdir(),
          branch: "tachyon/implementer",
          tachyonCreatedBranch: false,
          baseRef: pinned,
          baseBranch: undefined,
          createdAt: "2026-07-19T00:00:00.000Z",
        },
        baseSha: pinned,
      })).rejects.toThrow(/DELIVERY_BASE_REF_UNRESOLVED/);

      // Load-bearing half: a throw AFTER a durable write would still leave the broken record
      // behind. Nothing may be persisted — not the projection, not the Delivery itself.
      expect(gitCreate).not.toHaveBeenCalled();
      expect(deliveryCreate).not.toHaveBeenCalled();
    } finally {
      ws.dispose();
    }
  });

  it("mechanism-only canonical Delivery reuses one worktree through review completion", async () => {
    const root = mkdir(); const base = path.join(root, ".tachyon-worktrees");
    fs.writeFileSync(path.join(root, "tachyon.yml"), `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(base)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`, "utf8");
    git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n"); git(root, ["add", "README.md"]); git(root, ["commit", "-m", "base"]);
    const host = new FakeHost(mkdir()); const fake = fakeTmux({ realPaneProcesses: true });
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    const contract = { task: "implement", context: "real lifecycle", constraints: "scoped", doneWhen: "complete" };
    try {
      await ws.manager.spawn("implementer", { cmd: "claude", delegator: "boss", contract, gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] }, reveal: false });
      const initial = (await ws.deliveries.list())[0]!; const canonical = fs.realpathSync(ws.ledger.get("implementer")!.worktree!.path);
      expect(initial.lease.holder).toMatchObject({ executionAgent: "implementer", principal: "implementer" });
      expect(initial.segments[0]).toMatchObject({ executionAgent: "implementer", principal: "implementer" });
      expect(initial.lease.holder?.process?.pid).toBeGreaterThan(0); expect(initial.lease.holder?.executionNonce).toBeTruthy();
      expect(ws.ledger.get("implementer")?.delivery).toEqual({
        deliveryId: initial.id,
        segmentId: initial.lease.holder!.segmentId,
        executionNonce: initial.lease.holder!.executionNonce,
      });
      const initialHeads = JSON.parse(await host.getSecret(`tachyon.authorityHeads.v1.${workspaceHash(root)}`) ?? "{}") as Record<string, unknown>;
      expect(initialHeads[`canonical:${initial.id}`]).toEqual({
        revision: initial.version,
        mac: initial.authorityIntegrity?.mac,
      });
      await expect(ws.manager.restart("implementer")).rejects.toThrow(/Delivery/);
      const head = git(canonical, ["rev-parse", "HEAD"]);
      const tree = git(canonical, ["rev-parse", "HEAD^{tree}"]);

      // SDD 368 T17: an independently gated change stays live in parallel, but receives its own
      // Delivery/worktree. Sequential exclusivity is per Delivery, never a workspace-global lock.
      await ws.manager.spawn("parallel-implementer", {
        cmd: "claude",
        delegator: "boss",
        contract: { ...contract, task: "independent parallel change" },
        gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["docs"] },
        reveal: false,
      });
      const parallel = (await ws.deliveries.list()).find((delivery) =>
        delivery.lease.holder?.executionAgent === "parallel-implementer");
      expect(parallel).toBeDefined();
      const parallelCanonical = fs.realpathSync(ws.ledger.get("parallel-implementer")!.worktree!.path);
      expect(parallel?.id).not.toBe(initial.id);
      expect(parallelCanonical).not.toBe(canonical);
      expect(parallel?.lease.state).toBe("held");
      expect(fake.children.get(ws.manager.session("parallel-implementer"))?.exitCode).toBeNull();
      expect((await ws.gitDeliveries.list()).filter((delivery) =>
        delivery.deliveryId === initial.id || delivery.deliveryId === parallel?.id)).toHaveLength(2);
      const canonicalBase = fs.realpathSync(base) + path.sep;
      const deliveryWorktrees = () => git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => fs.realpathSync(line.slice("worktree ".length)))
        .filter((worktree) => worktree.startsWith(canonicalBase));
      expect(deliveryWorktrees()).toEqual(expect.arrayContaining([canonical, parallelCanonical]));
      expect(deliveryWorktrees()).toHaveLength(2);

      const verify = async (integrityHash: string) => ws.deliveryVerification.run(
        initial.id,
        { kind: "agent", name: "boss" },
        async () => ({ publish: async () => ({
          result: "accepted",
          evidence: { refSha: head, treeSha: tree, verdict: "accept", integrityHash, recordPath: `${integrityHash}.json` },
        }) }),
      );
      await expect(verify("pre-review-verification")).resolves.toBe("accepted");
      expect(fake.sessions.has(ws.manager.session("implementer"))).toBe(false);
      expect(fake.children.get(ws.manager.session("parallel-implementer"))?.exitCode).toBeNull();

      const join = async (name: string, role: "reviewer" | "fixer", operation: string) => ws.manager.spawn(name, { cmd: "claude", reveal: false, deliveryJoin: { deliveryId: initial.id, role, ownsSubset: role === "reviewer" ? [] : ["src"], expectedHead: head, operationId: operation } });
      await join("reviewer-1", "reviewer", "review-1");
      expect(fake.children.get(ws.manager.session("implementer"))?.exitCode).not.toBeNull();
      expect(fs.realpathSync(ws.ledger.get("reviewer-1")!.cwd)).toBe(canonical);
      await ws.deliveryLease.completeReview({ deliveryId: initial.id, canonicalWorktree: canonical, expectedReviewedHeadSha: head, verdict: "FINDINGS", actor: { kind: "agent", name: "boss" }, operationId: "findings" });
      await join("fixer", "fixer", "fixer");
      await expect(verify("post-fix-verification")).resolves.toBe("accepted");
      await join("reviewer-2", "reviewer", "review-2");
      await ws.deliveryLease.completeReview({ deliveryId: initial.id, canonicalWorktree: canonical, expectedReviewedHeadSha: head, verdict: "ACCEPT", actor: { kind: "agent", name: "boss" }, operationId: "accept" });
      const final = await ws.deliveries.get(initial.id);
      expect(final?.lease.state).toBe("free"); expect(final?.segments.map((s) => s.role)).toEqual(["implementer", "reviewer", "fixer", "reviewer"]);
      const finalHeads = JSON.parse(await host.getSecret(`tachyon.authorityHeads.v1.${workspaceHash(root)}`) ?? "{}") as Record<string, unknown>;
      expect(finalHeads[`canonical:${initial.id}`]).toEqual({
        revision: final?.version,
        mac: final?.authorityIntegrity?.mac,
      });
      expect((await ws.gitDeliveries.list()).filter((g) => g.deliveryId === initial.id)).toHaveLength(1);
      expect((await ws.deliveries.get(parallel!.id))?.lease.state).toBe("held");
      expect(fake.children.get(ws.manager.session("parallel-implementer"))?.exitCode).toBeNull();
      expect(deliveryWorktrees()).toEqual(expect.arrayContaining([canonical, parallelCanonical]));
      expect(deliveryWorktrees()).toHaveLength(2);
    } finally { await fake.cleanup(); ws.dispose(); }
  });

  it("verify_task stops and releases the exact live tail without kill quarantine", async () => {
    const root = mkdir(); const base = path.join(root, ".tachyon-worktrees");
    fs.writeFileSync(path.join(root, "tachyon.yml"), `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(base)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`, "utf8");
    git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n"); git(root, ["add", "README.md"]); git(root, ["commit", "-m", "base"]);
    const host = new FakeHost(mkdir()); const fake = fakeTmux({ realPaneProcesses: true });
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    try {
      await ws.manager.spawn("implementer", { cmd: "claude", delegator: "boss", contract: {
        task: "implement", context: "verification owns the stop", constraints: "scoped", doneWhen: "complete",
      }, gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] }, reveal: false });
      const initial = (await ws.deliveries.list())[0]!;
      const canonical = fs.realpathSync(ws.ledger.get("implementer")!.worktree!.path);
      const head = git(canonical, ["rev-parse", "HEAD"]);
      const tree = git(canonical, ["rev-parse", "HEAD^{tree}"]);
      const result = await ws.deliveryVerification.run(initial.id, { kind: "agent", name: "boss" }, async () => ({
        publish: async () => ({ result: "accepted", evidence: {
          refSha: head, treeSha: tree, verdict: "accept", integrityHash: "integration-proof", recordPath: "record.json",
        } }),
      }));
      expect(result).toBe("accepted");
      expect(fake.sessions.has(ws.manager.session("implementer"))).toBe(false);
      const completed = await ws.deliveries.get(initial.id);
      expect(completed?.lease.state).toBe("free");
      expect(completed?.segments[0]).toMatchObject({ releasedHeadSha: head, outcome: "completed" });
      expect(completed?.events.map((event) => event.type)).toContain("verification_tail_released");
      expect(completed?.events.at(-1)?.type).toBe("verification_completed");
      await expect(ws.manager.spawn("reviewer", { cmd: "claude", reveal: false, deliveryJoin: {
        deliveryId: initial.id, role: "reviewer", ownsSubset: [], expectedHead: head, operationId: "post-verification-review",
      } })).resolves.toBeUndefined();
    } finally { await fake.cleanup(); ws.dispose(); }
  });

  it("kill quarantines a cleanly ended predecessor before a successor can join", async () => {
    const root = mkdir(); const base = path.join(root, ".tachyon-worktrees");
    fs.writeFileSync(path.join(root, "tachyon.yml"), `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(base)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`, "utf8");
    git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n"); git(root, ["add", "README.md"]); git(root, ["commit", "-m", "base"]);
    const host = new FakeHost(mkdir()); const fake = fakeTmux({ realPaneProcesses: true });
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    try {
      await ws.manager.spawn("implementer", { cmd: "claude", delegator: "boss", contract: { task: "implement", context: "clean exit then join", constraints: "scoped", doneWhen: "complete" }, gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] }, reveal: false });
      const initial = (await ws.deliveries.list())[0]!;
      const canonical = fs.realpathSync(ws.ledger.get("implementer")!.worktree!.path);
      const holderBefore = structuredClone((await ws.deliveries.get(initial.id))!.lease.holder!);
      expect(holderBefore.process?.pid).toBeGreaterThan(0);
      expect(holderBefore.executionNonce).toBeTruthy();
      const head = git(canonical, ["rev-parse", "HEAD"]);
      // Clean self-exit of the exact predecessor — process gone, lease still held.
      await ws.manager.kill("implementer");
      expect(fake.sessions.has(ws.manager.session("implementer"))).toBe(false);
      const child = fake.children.get(ws.manager.session("implementer"));
      expect(child === undefined || child.exitCode !== null).toBe(true);
      await expect(ws.manager.spawn("reviewer", { cmd: "claude", reveal: false, deliveryJoin: { deliveryId: initial.id, role: "reviewer", ownsSubset: [], expectedHead: head, operationId: "gone-predecessor-join" } })).rejects.toThrow(/quarantined/i);
      const after = await ws.deliveries.get(initial.id);
      expect(after?.lease.state).toBe("quarantined");
      expect(after?.lease.holder?.executionAgent).toBe("implementer");
      expect(after?.segments.map((s) => s.role)).toEqual(["implementer"]);
      expect((await ws.gitDeliveries.list()).filter((g) => g.deliveryId === initial.id)).toHaveLength(1);
      expect(fs.readdirSync(base).filter((x) => fs.statSync(path.join(base, x)).isDirectory())).toHaveLength(1);
    } finally { await fake.cleanup(); ws.dispose(); }
  });

  it("quarantines a replacement pane PID without touching the replacement session", async () => {
    const root = mkdir(); const base = path.join(root, ".tachyon-worktrees");
    fs.writeFileSync(path.join(root, "tachyon.yml"), `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(base)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`, "utf8");
    git(root, ["init"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test User"]); fs.writeFileSync(path.join(root, "README.md"), "base\n"); git(root, ["add", "README.md"]); git(root, ["commit", "-m", "base"]);
    const fake = fakeTmux({ realPaneProcesses: true }); const ws = await Workspace.createForTest(root, { host: new FakeHost(mkdir()), onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false }); let original: ChildProcess | undefined;
    try {
      await ws.manager.spawn("implementer", { cmd: "claude", delegator: "boss", contract: { task: "implement", context: "replacement", constraints: "scoped", doneWhen: "complete" }, gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] }, reveal: false });
      const delivery = (await ws.deliveries.list())[0]!; const cwd = fs.realpathSync(ws.ledger.get("implementer")!.cwd); const head = git(cwd, ["rev-parse", "HEAD"]); original = fake.children.get(ws.manager.session("implementer"));
      const replacement = await fake.replacePaneProcess(ws.manager.session("implementer"));
      await expect(ws.manager.spawn("reviewer", { cmd: "claude", reveal: false, deliveryJoin: { deliveryId: delivery.id, role: "reviewer", ownsSubset: [], expectedHead: head, operationId: "replacement" } })).rejects.toThrow(/DELIVERY_QUARANTINED|DELIVERY_EXACT_STOP_REFUSED/);
      expect(replacement.exitCode).toBeNull(); expect(fake.sessions.has(ws.manager.session("implementer"))).toBe(true);
      expect((await ws.deliveries.get(delivery.id))?.lease.state).toBe("quarantined");
    } finally { if (original?.exitCode === null) original.kill("SIGKILL"); await fake.cleanup(); ws.dispose(); }
  });

  it("serializes host authority-head prepares so concurrent updates cannot lose sibling heads", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    const secretKey = `tachyon.authorityHeads.v1.${workspaceHash(root)}`;
    const originalSetSecret = host.setSecret.bind(host);
    const writes: string[] = [];
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    host.setSecret = async (key, value) => {
      if (key === secretKey) {
        writes.push(value);
        if (writes.length === 1) {
          enterFirst();
          await firstReleased;
        }
      }
      await originalSetSecret(key, value);
    };
    const prepare = (ws as unknown as {
      prepareAuthorityHead(identity: string, next: { revision: number; mac: string }, expectedMac?: string): Promise<void>;
    }).prepareAuthorityHead.bind(ws);
    try {
      const first = prepare("delivery-a", { revision: 1, mac: "a".repeat(64) });
      await firstEntered;
      const second = prepare("delivery-b", { revision: 1, mac: "b".repeat(64) });
      await flushMicrotasks();
      expect(writes).toHaveLength(1);

      releaseFirst();
      await Promise.all([first, second]);

      const persisted = JSON.parse(await host.getSecret(secretKey) ?? "{}") as Record<string, unknown>;
      expect(persisted).toEqual({
        "canonical:delivery-a": { revision: 1, mac: "a".repeat(64) },
        "canonical:delivery-b": { revision: 1, mac: "b".repeat(64) },
      });
    } finally {
      ws.dispose();
    }
  });

  it("refreshes shared authority custody before a stale host prepares another head", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n", "utf8");
    const secrets = new Map<string, string>();
    const firstFake = fakeTmux();
    const secondFake = fakeTmux();
    const first = await Workspace.createForTest(
      root,
      { host: new SharedSecretHost(mkdir(), secrets), onViewsChanged: () => {} },
      { tmux: firstFake.tmux, startBridge: false },
    );
    const second = await Workspace.createForTest(
      root,
      { host: new SharedSecretHost(mkdir(), secrets), onViewsChanged: () => {} },
      { tmux: secondFake.tmux, startBridge: false },
    );
    const prepareFirst = (first as unknown as {
      prepareAuthorityHead(identity: string, next: { revision: number; mac: string }): Promise<void>;
    }).prepareAuthorityHead.bind(first);
    const prepareSecond = (second as unknown as {
      prepareAuthorityHead(identity: string, next: { revision: number; mac: string }): Promise<void>;
    }).prepareAuthorityHead.bind(second);
    try {
      await prepareFirst("delivery-a", { revision: 1, mac: "c".repeat(64) });
      await prepareSecond("delivery-b", { revision: 1, mac: "d".repeat(64) });

      const secretKey = `tachyon.authorityHeads.v1.${workspaceHash(root)}`;
      expect(JSON.parse(secrets.get(secretKey) ?? "{}")).toEqual({
        "canonical:delivery-a": { revision: 1, mac: "c".repeat(64) },
        "canonical:delivery-b": { revision: 1, mac: "d".repeat(64) },
      });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("rejects a signed canonical rollback from another host and quarantines only that Delivery", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n    autostart: false\n", "utf8");
    const secrets = new Map<string, string>();
    const firstFake = fakeTmux();
    const secondFake = fakeTmux();
    const first = await Workspace.createForTest(root, { host: new SharedSecretHost(mkdir(), secrets), onViewsChanged: () => {} }, { tmux: firstFake.tmux, startBridge: false });
    const secondHost = new SharedSecretHost(mkdir(), secrets);
    const second = await Workspace.createForTest(root, { host: secondHost, onViewsChanged: () => {} }, { tmux: secondFake.tmux, startBridge: false });
    try {
      const created = await first.deliveries.create({
        id: "d-shared-rollback",
        workspaceId: workspaceHash(root),
        createdBy: { kind: "system", name: "tachyon" },
        contract: { baseSha: "base", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/shared" },
        events: [{ id: "event-created", at: "2026-07-15T12:00:00.000Z", type: "created", by: { kind: "system", name: "tachyon" } }],
      });
      const database = new DatabaseSync(first.deliveries.databasePath);
      let versionOneJson: string;
      try {
        versionOneJson = String((database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(created.id) as { record_json: string }).record_json);
      } finally {
        database.close();
      }
      const updated = await first.deliveries.update(created.id, created.version, (record) => {
        record.events.push({ id: "event-version-two", at: "2026-07-15T12:01:00.000Z", type: "advanced", by: { kind: "system", name: "tachyon" } });
        return record;
      });
      await expect(second.deliveries.get(created.id)).resolves.toMatchObject({ version: updated.version });

      const attacker = new DatabaseSync(first.deliveries.databasePath);
      try {
        attacker.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(versionOneJson, created.id);
      } finally {
        attacker.close();
      }

      await expect(second.deliveries.get(created.id)).rejects.toThrow("authority head mismatch");
      await second.start();
      expect(second.deliveryReloadPhase()).toBe("ready");
      expect(second.deliveryReloadState()?.byId.get(created.id)).toMatchObject({ class: "unavailable" });
      const quarantineNotice = secondHost.notices.find((notice) => /quarantined 1 canonical Delivery record/.test(notice.message));
      expect(quarantineNotice?.message).not.toContain(created.id);
      expect(quarantineNotice?.message.length).toBeLessThan(180);
      // The invalid authority is still unusable; only unrelated generic lifecycle remains available.
      await expect(second.deliveries.get(created.id)).rejects.toThrow("authority head mismatch");
      await expect(second.manager.spawn("a")).resolves.toBeUndefined();
      expect(await second.manager.runningAgents()).toContain("a");
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("one-time reseals a pre-hardening unsigned Delivery without blocking signed rows", async () => {
    const { DeliveryStore } = await import("../../src/delivery/store.js");
    const root = mkdir();
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents: {}\nterminals:\n  bound-old:\n    cmd: sh\n    autostart: false\n  ordinary:\n    cmd: sh\n    autostart: false\n",
      "utf8",
    );
    const unsignedStore = new DeliveryStore(root);
    const unsigned = await unsignedStore.create({
      id: "d-pre-hardening",
      workspaceId: workspaceHash(root),
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "base", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/old" },
    });
    const readStoredJson = (): string => {
      const database = new DatabaseSync(unsignedStore.databasePath);
      try {
        return String((database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(unsigned.id) as { record_json: string }).record_json);
      } finally {
        database.close();
      }
    };
    const before = readStoredJson();
    expect(JSON.parse(before)).not.toHaveProperty("authorityIntegrity");
    fs.writeFileSync(path.join(root, ".tachyon", "sessions.json"), JSON.stringify({
      sessions: {
        "bound-old": {
          def: { cmd: "sh", kind: "agent" },
          resume: { runtime: "claude", sessionId: "old-session" },
          cwd: root,
          declared: true,
          delivery: { deliveryId: unsigned.id, segmentId: "old-segment", executionNonce: "old-nonce" },
          updatedAt: "2026-07-15T12:00:00.000Z",
        },
      },
    }), "utf8");

    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    try {
      expect(ws.deliveryReloadPhase()).toBe("ready");
      expect(ws.deliveryReloadState()?.byId.get(unsigned.id)).toMatchObject({ class: "unavailable" });
      expect(ws.deliveryReloadState()?.unavailableAgents.has("bound-old")).toBe(true);
      await expect(ws.manager.spawn("bound-old")).rejects.toThrow(/Delivery/);
      await expect(ws.deliveries.get(unsigned.id)).resolves.toMatchObject({ id: unsigned.id });
      expect(JSON.parse(readStoredJson())).toHaveProperty("authorityIntegrity");

      const signed = await ws.deliveries.create({
        id: "d-post-hardening",
        workspaceId: workspaceHash(root),
        createdBy: { kind: "system", name: "tachyon" },
        contract: { baseSha: "base", behaviorTest: "gate", owns: [], taskRef: "tachyon/new" },
      });
      await ws.start();
      expect(ws.deliveryReloadPhase()).toBe("ready");
      expect(ws.deliveryReloadState()?.byId.get(unsigned.id)?.class).toBe("unavailable");
      expect(ws.deliveryReloadState()?.byId.get(signed.id)?.class).toBe("terminal");
      await expect(ws.deliveries.get(signed.id)).resolves.toMatchObject({ id: signed.id });
      expect(JSON.parse(readStoredJson())).toHaveProperty("authorityIntegrity");

      expect(host.notices.filter((notice) => /quarantined 1 canonical Delivery record/.test(notice.message))).toHaveLength(0);
      await expect(ws.manager.spawn("ordinary")).resolves.toBeUndefined();
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("one-time reseals a pre-hardening unsigned Delivery already at version > 1, anchoring its head at that version", async () => {
    // Real legacy data is never version 1 by the time the reseal migration ships (spec-397 t-headfix):
    // this drives the exact end-to-end path (real Workspace + real DeliveryStore + real host authority
    // port) that shipped broken, rather than a hand-simulated port.
    const { DeliveryStore } = await import("../../src/delivery/store.js");
    const root = mkdir();
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents: {}\nterminals:\n  ordinary:\n    cmd: sh\n    autostart: false\n",
      "utf8",
    );
    const unsignedStore = new DeliveryStore(root);
    let record = await unsignedStore.create({
      id: "d-pre-hardening-v3",
      workspaceId: workspaceHash(root),
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "base", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/old-v3" },
    });
    for (let i = 0; i < 2; i++) {
      record = await unsignedStore.update(record.id, record.version, (r) => {
        r.events.push({ id: `bump-${i}`, at: "2026-07-15T12:00:00.000Z", type: "advanced", by: { kind: "system", name: "tachyon" } });
        return r;
      });
    }
    expect(record.version).toBe(3);
    const database = new DatabaseSync(unsignedStore.databasePath);
    try {
      const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(record.id) as { record_json: string };
      expect(JSON.parse(row.record_json)).not.toHaveProperty("authorityIntegrity");
    } finally {
      database.close();
    }

    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    try {
      const migrated = await ws.deliveries.get(record.id);
      expect(migrated?.version).toBe(3);
      expect(migrated?.authorityIntegrity?.mac).toMatch(/^[0-9a-f]{64}$/);
      const secretKey = `tachyon.authorityHeads.v1.${workspaceHash(root)}`;
      const heads = JSON.parse(await host.getSecret(secretKey) ?? "{}") as Record<string, { revision: number; mac: string }>;
      expect(heads[`canonical:${record.id}`]).toEqual({ revision: 3, mac: migrated!.authorityIntegrity!.mac });
      // The migration marker is set, so ordinary operations on this now-signed Delivery work.
      const advanced = await ws.deliveries.update(record.id, record.version, (r) => {
        r.events.push({ id: "post-migration", at: "2026-07-15T12:05:00.000Z", type: "advanced", by: { kind: "system", name: "tachyon" } });
        return r;
      });
      expect(advanced.version).toBe(4);
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("keeps anti-rollback CAS intact for ordinary heads while the migration-only initial path stays guarded", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n    autostart: false\n", "utf8");
    const host = new FakeHost(mkdir());
    const fake = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    const prepare = (ws as unknown as {
      prepareAuthorityHead(identity: string, next: { revision: number; mac: string }, expectedMac?: string): Promise<void>;
    }).prepareAuthorityHead.bind(ws);
    const establishInitial = (ws as unknown as {
      establishInitialAuthorityHead(identity: string, head: { revision: number; mac: string }): Promise<void>;
    }).establishInitialAuthorityHead.bind(ws);
    const secretKey = `tachyon.authorityHeads.v1.${workspaceHash(root)}`;
    try {
      // Ordinary create still establishes the first head at a fixed revision 1.
      await prepare("delivery-anti-rollback", { revision: 1, mac: "a".repeat(64) });
      expect(JSON.parse(await host.getSecret(secretKey) ?? "{}")).toEqual({
        "canonical:delivery-anti-rollback": { revision: 1, mac: "a".repeat(64) },
      });

      // A same-revision "update" under the correct expectedMac (non-monotonic) is refused.
      await expect(prepare("delivery-anti-rollback", { revision: 1, mac: "b".repeat(64) }, "a".repeat(64)))
        .rejects.toThrow(/non-monotonic update/);
      // A stale/incorrect expectedMac (an attacker replaying an older CAS token) is refused too.
      await expect(prepare("delivery-anti-rollback", { revision: 2, mac: "c".repeat(64) }, "9".repeat(64)))
        .rejects.toThrow(/non-monotonic update/);
      // Both refused attempts left the durable head untouched.
      expect(JSON.parse(await host.getSecret(secretKey) ?? "{}")).toEqual({
        "canonical:delivery-anti-rollback": { revision: 1, mac: "a".repeat(64) },
      });

      // The migration-only initial path can never overwrite or lower an existing head.
      await expect(establishInitial("delivery-anti-rollback", { revision: 5, mac: "d".repeat(64) }))
        .rejects.toThrow(/already exists with different state/);
      // It is idempotent on the exact same head.
      await expect(establishInitial("delivery-anti-rollback", { revision: 1, mac: "a".repeat(64) })).resolves.toBeUndefined();
      expect(JSON.parse(await host.getSecret(secretKey) ?? "{}")).toEqual({
        "canonical:delivery-anti-rollback": { revision: 1, mac: "a".repeat(64) },
      });

      // A fresh identity may be established at N > 1 only by the migration-only path...
      await expect(establishInitial("delivery-legacy-v7", { revision: 7, mac: "e".repeat(64) })).resolves.toBeUndefined();
      // ...but once established, ordinary CAS rules govern it: a non-monotonic follow-up is refused...
      await expect(prepare("delivery-legacy-v7", { revision: 7, mac: "f".repeat(64) }, "e".repeat(64)))
        .rejects.toThrow(/non-monotonic update/);
      // ...and only a genuine revision+1 advance under the correct expectedMac succeeds.
      await expect(prepare("delivery-legacy-v7", { revision: 8, mac: "f".repeat(64) }, "e".repeat(64))).resolves.toBeUndefined();
      expect(JSON.parse(await host.getSecret(secretKey) ?? "{}")).toMatchObject({
        "canonical:delivery-legacy-v7": { revision: 8, mac: "f".repeat(64) },
      });
    } finally {
      ws.dispose();
      await fake.cleanup();
    }
  });

  it("refreshes a previously absent canonical head after another host creates the Delivery", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n    autostart: false\n", "utf8");
    const secrets = new Map<string, string>();
    const firstFake = fakeTmux();
    const secondFake = fakeTmux();
    const first = await Workspace.createForTest(root, { host: new SharedSecretHost(mkdir(), secrets), onViewsChanged: () => {} }, { tmux: firstFake.tmux, startBridge: false });
    const second = await Workspace.createForTest(root, { host: new SharedSecretHost(mkdir(), secrets), onViewsChanged: () => {} }, { tmux: secondFake.tmux, startBridge: false });
    try {
      await expect(second.deliveries.get("d-created-elsewhere")).resolves.toBeUndefined();
      const created = await first.deliveries.create({
        id: "d-created-elsewhere",
        workspaceId: workspaceHash(root),
        createdBy: { kind: "system", name: "tachyon" },
        contract: { baseSha: "base", behaviorTest: "gate", owns: [], taskRef: "tachyon/shared" },
      });
      await expect(second.deliveries.get(created.id)).resolves.toEqual(created);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("explicit cmd verifier preserves the pre-spawn HEAD without creating a stub or setup commit", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);
    const headBeforeSpawn = git(root, ["rev-parse", "HEAD"]);

    const fake = fakeTmux({ realPaneProcesses: true });
    const ws = await Workspace.createForTest(
      root,
      { host: new FakeHost(mkdir()), onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      const receipt = await ws.manager.spawn("command-gate", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "preserve behavior",
          context: "project-owned command verifier",
          constraints: "stay scoped",
          doneWhen: "command passes",
        },
        gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] },
        reveal: false,
      });

      if (!receipt) throw new Error("canonical spawn receipt missing");
      const record = await ws.deliveries.get(receipt.deliveryId);
      const wt = ws.ledger.get("command-gate")?.worktree;
      expect(wt).toBeTruthy();
      expect(record?.contract.stubPath).toBeUndefined();
      expect(record?.contract.verifySettings).toEqual({});
      expect(record?.contract.owns).toEqual(["src"]);
      expect(record?.contract.baseSha).toBe(headBeforeSpawn);
      expect(git(wt!.path, ["rev-parse", "HEAD"])).toBe(headBeforeSpawn);
      expect(git(wt!.path, ["log", "--format=%s"])).toBe("base");
      expect(fs.existsSync(path.join(wt!.path, "test"))).toBe(false);
      expect(fake.sessions.size).toBe(1);
    } finally {
      await ws.dispose();
      await fake.cleanup();
    }
  });

  it("preserves a freshly created gated worktree when preparation fails without an exact HEAD token", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host: new FakeHost(mkdir()), onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    const rollback = vi.spyOn(ws.worktrees, "rollbackCreated");
    vi.spyOn(ws.worktrees, "headState").mockResolvedValueOnce({ headRef: "", dirty: false });
    try {
      await expect(ws.manager.spawn("rollback-gate", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "prepare safely",
          context: "forced HEAD resolution failure",
          constraints: "leave no worktree",
          doneWhen: "preparation is atomic",
        },
        gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src"] },
        reveal: false,
      })).rejects.toThrow(/could not resolve its prepared worktree HEAD.*recovery state was preserved/);

      expect(rollback).not.toHaveBeenCalled();
      expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
      expect(git(root, ["branch", "--list", "tachyon/rollback-gate"])).toContain("tachyon/rollback-gate");
      expect(ws.ledger.get("rollback-gate")).toBeUndefined();
      expect(fake.sessions.size).toBe(0);
    } finally {
      await ws.dispose();
    }
  });

  it("preserves an attached human-branch worktree when post-oracle launch preparation fails", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    // SDD 478 M6 — `branch:` is an Agent capability and `cmd: sh` declares a terminal, so the old
    // stanza was refused. M7 — the agent is canonical now, and the branch it attaches to lives in
    // the profile's own `workspace.worktree` (no process is spawned here; tmux is a double).
    const { host } = canonicalHost(
      root,
      [{ name: "attached", spec: { runtime: "codex", extra: { workspace: { worktree: { enabled: true, branch: "human/attached" } } } } }],
      `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(wtBase)}\n`,
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    const attachedOracle = path.join(root, "test", "unit", "attachedBehavior.gen.test.ts");
    fs.mkdirSync(path.dirname(attachedOracle), { recursive: true });
    fs.writeFileSync(attachedOracle, "it('attached branch keeps ownership', () => { throw new Error('RED'); });\n", "utf8");
    git(root, ["add", "README.md", "test/unit/attachedBehavior.gen.test.ts"]);
    git(root, ["commit", "-m", "base"]);
    git(root, ["branch", "human/attached"]);
    const humanHead = git(root, ["rev-parse", "human/attached"]);

    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host, onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    vi.spyOn(ws.manager as unknown as { effectiveInstructions: () => string }, "effectiveInstructions")
      .mockImplementationOnce(() => { throw new Error("forced primer preparation failure"); });
    try {
      const failure = await ws.manager.spawn("attached", {
        delegator: "boss",
        contract: {
          task: "prepare attached branch safely",
          context: "stub commit must be compensated",
          constraints: "preserve the human branch",
          doneWhen: "failure leaves its original HEAD",
        },
        gate: { behaviorTest: "attached branch keeps ownership", owns: ["src"] },
        reveal: false,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toMatchObject({ message: "forced primer preparation failure" });
      expect((failure as AggregateError).errors[1]).toMatchObject({ message: expect.stringContaining("recovery state was preserved") });
      // t-7faea9 — same class as gated prep: recovery wrapper AggregateError must inline primary
      // (this path is AgentManager launch preparation after oracle, not Workspace gated catch).
      expect((failure as AggregateError).message).toContain("forced primer preparation failure");
      expect((failure as AggregateError).message).toMatch(/agent 'attached' launch preparation failed:/);

      expect(git(root, ["rev-parse", "human/attached"])).toBe(humanHead);
      expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
      expect(ws.ledger.get("attached")).toBeUndefined();
      expect(fake.sessions.size).toBe(0);

      await expect(ws.manager.spawn("attached", {
        delegator: "boss",
        contract: {
          task: "prepare attached branch safely",
          context: "retry must not adopt quarantined state",
          constraints: "preserve the human branch",
          doneWhen: "an explicit recovery precedes reuse",
        },
        gate: { behaviorTest: "attached branch keeps ownership", owns: ["src"] },
        reveal: false,
      })).rejects.toMatchObject({ reason: "recovery-preserved" });
      expect(fake.sessions.size).toBe(0);
    } finally {
      await ws.dispose();
    }
  });

  it("plain verifier without project behavior settings fails before worktree or tmux creation", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host: new FakeHost(mkdir()), onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      await expect(ws.manager.spawn("unconfigured", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "preserve behavior",
          context: "missing project adapter",
          constraints: "stay scoped",
          doneWhen: "verifier passes",
        },
        gate: { behaviorTest: "project invariant remains true", owns: ["src"] },
        reveal: false,
      })).rejects.toThrow(/settings\.verify\.behavior/);

      const worktrees = git(root, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      expect(worktrees).toHaveLength(1);
      expect(fs.existsSync(wtBase) ? fs.readdirSync(wtBase) : []).toHaveLength(0);
      expect(ws.ledger.get("unconfigured")).toBeUndefined();
      expect(fake.sessions.size).toBe(0);
      expect(fake.calls.some((args) => args.includes("new-session"))).toBe(false);
    } finally {
      await ws.dispose();
    }
  });

  it("rejects oversized or control-bearing gate facts before worktree, oracle, or tmux creation", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n${namedBehaviorVerifyYaml()}  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const fake = fakeTmux();
    const ws = await Workspace.createForTest(
      root,
      { host: new FakeHost(mkdir()), onViewsChanged: () => {} },
      { tmux: fake.tmux, startBridge: false },
    );
    try {
      await expect(ws.manager.spawn("oversized-gate", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "reject oversized verifier",
          context: "preparation must have no side effects",
          constraints: "keep the workspace clean",
          doneWhen: "the request fails before setup",
        },
        gate: { behaviorTest: "x".repeat(2049), owns: ["src"] },
        reveal: false,
      })).rejects.toThrow(/at most 2048 UTF-8 bytes/);

      await expect(ws.manager.spawn("control-gate", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "reject terminal injection",
          context: "preparation must have no side effects",
          constraints: "keep the workspace clean",
          doneWhen: "the request fails before setup",
        },
        gate: { behaviorTest: "project promise\u001b[2J", owns: ["src"] },
        reveal: false,
      })).rejects.toThrow(/behavior_test must not contain control characters/);

      await expect(ws.manager.spawn("control-owns", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "reject terminal injection",
          context: "preparation must have no side effects",
          constraints: "keep the workspace clean",
          doneWhen: "the request fails before setup",
        },
        gate: { behaviorTest: "cmd:node scripts/check-behavior.mjs", owns: ["src\u001b]8;;https://example.test\u0007"] },
        reveal: false,
      })).rejects.toThrow(/owns\[0\] must not contain control characters/);

      expect(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
      expect(fs.existsSync(wtBase) ? fs.readdirSync(wtBase) : []).toHaveLength(0);
      expect(ws.ledger.get("oversized-gate")).toBeUndefined();
      expect(fake.sessions.size).toBe(0);
    } finally {
      await ws.dispose();
    }
  });

  it("t-7faea9: missing named behavior oracle surfaces in gated preparation AggregateError.message", async () => {
    // Named gate without a committed oracle must not leave coordinators debugging only
    // "recovery state was preserved" — the missing-oracle text is Bridge-visible.
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    const behaviorSettings = namedBehaviorSettings("test/generated-gates/{agent}.behavior.test.ts");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n${namedBehaviorVerifyYaml(behaviorSettings.stubPath)}  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base without oracle"]);

    const host = new FakeHost(mkdir());
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    try {
      const failure = await ws.manager.spawn("missingoracle", {
        cmd: "sh",
        delegator: "boss",
        contract: {
          task: "should fail at oracle bind",
          context: "no stub committed",
          constraints: "surface real cause",
          doneWhen: "error names missing oracle",
        },
        gate: { behaviorTest: "generated behavior stays canonical", owns: ["src"] },
        reveal: false,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      const msg = (failure as AggregateError).message;
      expect(msg).toMatch(/gated delegation 'missingoracle' preparation failed:/);
      expect(msg).toMatch(/behavior oracle|does not exist|commit a real failing project-owned test/i);
      expect(msg).toMatch(/fresh worktree recovery state was preserved/);
      expect((failure as AggregateError).errors[0]).toBeInstanceOf(Error);
      expect(((failure as AggregateError).errors[0] as Error).message).toMatch(/does not exist|commit a real failing/i);
      expect(ws.ledger.get("missingoracle")).toBeUndefined();
    } finally {
      ws.dispose();
    }
  });

  it("configured named gate binds a pre-existing project-owned oracle without authorizing edits", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    const behaviorSettings = namedBehaviorSettings("test/generated-gates/{agent}.behavior.test.ts");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n${namedBehaviorVerifyYaml(behaviorSettings.stubPath)}  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents: {}\nterminals:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    const stubPath = canonicalBehaviorStubPath("stubber", behaviorSettings);
    const oracleBody = "it('generated behavior stays canonical', () => { throw new Error('RED'); });\n";
    const oraclePath = path.join(root, ...stubPath.split("/"));
    fs.mkdirSync(path.dirname(oraclePath), { recursive: true });
    fs.writeFileSync(oraclePath, oracleBody, "utf8");
    git(root, ["add", "README.md", stubPath]);
    git(root, ["commit", "-m", "base"]);

    const host = new FakeHost(mkdir());
    const fake = fakeTmux({ realPaneProcesses: true });
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
    try {
      const contract = { task: "fill generated behavior", context: "stub fixture", constraints: "stay scoped", doneWhen: "generated stub passes" };
      const receipt = await ws.manager.spawn("stubber", {
        cmd: "sh",
        delegator: "boss",
        contract,
        gate: { behaviorTest: "generated behavior stays canonical", owns: ["src"] },
        reveal: false,
      });

      if (!receipt) throw new Error("canonical spawn receipt missing");
      const record = await ws.deliveries.get(receipt.deliveryId);
      const wt = ws.ledger.get("stubber")?.worktree;
      expect(wt).toBeTruthy();
      expect(record?.contract.stubPath).toBe(stubPath);
      expect(record?.contract.owns).toEqual(["src"]);
      expect(record?.contract.oracleHash).toBe(createHash("sha256").update(oracleBody).digest("hex"));
      expect(record?.contract.baseSha).toBe(git(wt!.path, ["rev-parse", "HEAD"]));
      expect(git(wt!.path, ["show", "--format=%an <%ae>", "--no-patch", record!.contract.baseSha])).toBe("Test User <test@example.com>");
      expect(fs.readFileSync(path.join(wt!.path, ...stubPath.split("/")), "utf8")).toBe(oracleBody);
    } finally {
      await ws.dispose();
      await fake.cleanup();
    }
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
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    await flush();
    expect(await store.readPending()).toMatchObject({ action_id: "act-reload-recover" });

    (ws.bridge as unknown as { _port?: number })._port = 41000;
    await (ws as unknown as { recoverPendingHostActionReload: () => Promise<void> }).recoverPendingHostActionReload();

    expect(await store.readPending()).toBeUndefined();
    const auditLines = fs.readFileSync(path.join(storage, "host-actions", "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0].payload).toMatchObject({ kind: "outcome", actionId: "act-reload-recover", state: "reattached_verified" });
    expect(host.notices).toEqual([]);
    ws.dispose();
  });

  it("blocks reloadWindow while another agent is actively working", async () => {
    const root = mkdir();
    const { host } = canonicalHost(root, [
      { name: "codex", spec: { runtime: "codex" } },
      { name: "claude", spec: { runtime: "claude" } },
    ]);
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
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
    ws.ledger.record("old", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, declared: true, updatedAt: "t" });
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

  it("keeps a removed agent footprint retryable when authority retirement fails", async () => {
    const { ws, host } = await makeWorkspace();
    ws.ledger.record("old", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, declared: true, updatedAt: "t" });
    await ws.evolutionStore.ensureProfile("old");
    vi.spyOn(ws.evolutionStore, "retireAgent").mockRejectedValueOnce(new Error("secret storage unavailable"));

    await (ws as unknown as { gcLedger(declaredInConfig: Set<string>, live: Set<string>): Promise<void> })
      .gcLedger(new Set(), new Set());

    expect(ws.ledger.get("old")).toBeDefined();
    expect(fs.existsSync(ws.evolutionStore.rootFor("old"))).toBe(true);
    expect(host.notices.some((notice) => notice.level === "warn" && notice.message.includes("secret storage unavailable"))).toBe(true);
    ws.dispose();
  });

  it("compacts stale session-owner rows on start while keeping live, ledger, and declared agents", async () => {
    const { ws, sessions } = await makeWorkspace();
    ws.ledger.record("resumable", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, declared: false, updatedAt: "t" });
    sessions.add(ws.manager.session("live-only"));
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

  it("restores persisted terminal tabs from Workspace.start after surviving tmux sessions are ready", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\nterminals:\n  a:\n    cmd: sh\n", "utf8");
    const host = new FakeHost(mkdir());
    const { tmux, sessions } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
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

  it("SDD 368 T14 does not auto-resume a dead Delivery-bound runtime on Workspace.start", async () => {
    const root = mkdir();
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  holder:\n    cmd: claude\n    autostart: true\n  a:\n    cmd: sh\n    autostart: false\n",
      "utf8",
    );
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "sessions.json"), JSON.stringify({
      sessions: {
        holder: {
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: "dead-session" },
          cwd: root,
          declared: true,
          delivery: { deliveryId: "d-dead", segmentId: "seg-1", executionNonce: "n1" },
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    }), "utf8");
    const host = new FakeHost(mkdir());
    const { tmux, sessions } = fakeTmux();
    // holder is NOT live — dead Delivery-bound must not generic-resume; a is not autostart.
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    await ws.start();
    // Delivery-bound holder must not appear as a started session via generic resume/autostart.
    expect([...sessions].some((s) => s.endsWith("-holder"))).toBe(false);
    // Rehydrate still keeps the ledger row for visibility.
    expect(ws.ledger.get("holder")?.delivery).toEqual({
      deliveryId: "d-dead",
      segmentId: "seg-1",
      executionNonce: "n1",
    });
    // Reload snapshot was computed (read-only) and is explicitly ready.
    expect(ws.deliveryReloadPhase()).toBe("ready");
    expect(ws.deliveryReloadState()).toBeDefined();
    // Offered resume list must not include the Delivery-bound agent.
    expect(ws.resumableAgents()).not.toContain("holder");
    ws.dispose();
  });

  it("SDD 368 T14 Workspace.reload snapshot denies marker-less crash-window holder via real stores", async () => {
    const { DeliveryStore } = await import("../../src/delivery/store.js");
    const { GitDeliveryStore } = await import("../../src/git-delivery/store.js");
    const root = mkdir();
    const wt = path.join(root, "wt-crash");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  crash-holder:\n    cmd: claude\n    autostart: true\n  ordinary:\n    cmd: sh\n    autostart: false\n",
      "utf8",
    );
    const now = "2026-07-12T00:00:00.000Z";
    const host = new FakeHost(mkdir());
    const authorityKey = await loadOrCreateHmacKey(host);
    const gitDeliveryId = deterministicGitDeliveryId("d-crash");
    const canonicalHeads = new Map<string, { revision: number; mac: string }>();
    // Durable Delivery + Git projection, but NO ledger reverse binding (crash window).
    const store = new DeliveryStore(root, {
      now: () => now,
      authorityIntegrityKey: () => authorityKey,
      authorityHead: {
        current: async (id) => canonicalHeads.get(id),
        prepare: async (id, next, expectedMac) => {
          const current = canonicalHeads.get(id);
          if (expectedMac === undefined ? current !== undefined : current?.mac !== expectedMac) {
            throw new Error("test authority head compare-and-swap mismatch");
          }
          canonicalHeads.set(id, { ...next });
        },
      },
    });
    await store.create({
      id: "d-crash",
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      contract: { baseSha: "abc", behaviorTest: "gate", owns: ["src"], taskRef: "tachyon/crash" },
      lease: {
        state: "held",
        holder: {
          segmentId: "seg-crash",
          executionAgent: "crash-holder",
          process: { pid: 1, processStart: "1", bootId: "boot" },
          executionNonce: "nonce-crash",
        },
        expectedHeadSha: "abc",
        changedAt: now,
      },
      segments: [{
        id: "seg-crash",
        index: 0,
        role: "implementer",
        executionAgent: "crash-holder",
        grantedBy: { kind: "system", name: "tachyon" },
        ownsSubset: ["src"],
        grantedHeadSha: "abc",
        grantedAt: now,
      }],
      events: [],
      gitDeliveryId,
    });
    await host.setSecret(`tachyon.authorityHeads.v1.${workspaceHash(root)}`, JSON.stringify({
      "canonical:d-crash": canonicalHeads.get("d-crash"),
    }));
    await new GitDeliveryStore(root, { now: () => now }).open({
      workspaceId: "ws",
      createdBy: { kind: "system", name: "tachyon" },
      deliveryId: "d-crash",
      agent: "crash-holder",
      branchRef: "tachyon/crash",
      worktreePath: wt,
      tachyonCreatedBranch: true,
      baseRef: "abc",
      currentHeadSha: "abc",
      reason: "workspace-headless-crash-window",
    });
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "sessions.json"), JSON.stringify({
      sessions: {
        "crash-holder": {
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: "dead-crash" },
          cwd: wt,
          worktree: { path: wt, branch: "tachyon/crash", tachyonCreatedBranch: true, baseRef: "abc", createdAt: now },
          declared: true,
          // no delivery marker — the crash-window shape
          updatedAt: now,
        },
      },
    }), "utf8");

    const { tmux, sessions } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    await ws.start();

    const snap = ws.deliveryReloadState();
    expect(snap).toBeDefined();
    expect(ws.deliveryReloadPhase()).toBe("ready");
    expect(snap!.byId.get("d-crash")?.class).toBe("unavailable");
    expect(snap!.unavailableAgents.has("crash-holder")).toBe(true);
    // Generic autostart/resume must not launch the marker-less crash holder.
    expect([...sessions].some((s) => s.endsWith("-crash-holder"))).toBe(false);
    expect(ws.resumableAgents()).not.toContain("crash-holder");
    // Direct spawn still refused by deny set after start.
    await expect(ws.manager.spawn("crash-holder")).rejects.toThrow(/Delivery/);
    ws.dispose();
  });

  it("SDD 368 T14/R4 factory ready pre-start; start store-read failure deny-all + deliveryJoin; start retry failed→ready", async () => {
    const root = mkdir();
    const { host } = canonicalHost(root, [
      { name: "ordinary", spec: { runtime: "claude", autostart: true } },
      { name: "offered", spec: { runtime: "claude", autostart: false } },
    ]);
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "sessions.json"), JSON.stringify({
      sessions: {
        ordinary: {
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: "sess-ord" },
          cwd: root,
          declared: true,
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
        offered: {
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: "sess-off" },
          cwd: root,
          declared: true,
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    }), "utf8");

    const { tmux, sessions } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    // T14/R4: factory never exposes uninitialized; healthy empty stores → ready before start.
    expect(ws.deliveryReloadPhase()).toBe("ready");
    expect(ws.deliveryReloadPhase()).not.toBe("uninitialized");
    expect(ws.deliveryReloadState()).toBeDefined();
    // Ordinary pre-start generic spawn succeeds on the factory-ready empty snapshot.
    await ws.manager.spawn("ordinary");
    expect(await ws.manager.runningAgents()).toContain("ordinary");
    await ws.manager.kill("ordinary");

    // Force a real Workspace.start store-read failure on the Delivery store list path.
    const originalListWithCorrupt = ws.deliveries.listWithCorrupt.bind(ws.deliveries);
    (ws.deliveries as { listWithCorrupt: () => Promise<unknown> }).listWithCorrupt = async () => {
      throw new Error("forced Delivery store-read failure");
    };
    await ws.start();

    expect(ws.deliveryReloadPhase()).toBe("failed");
    expect(ws.deliveryReloadState()).toBeUndefined();
    expect(host.notices.some((n) => /delivery reload reconciliation failed/i.test(n.message))).toBe(true);
    // Zero generic launches / offers — ordinary autostart and offered resume must not fire.
    expect([...sessions].some((s) => s.endsWith("-ordinary"))).toBe(false);
    expect([...sessions].some((s) => s.endsWith("-offered"))).toBe(false);
    expect(ws.resumableAgents()).toEqual([]);
    // Direct generic lifecycle refused while snapshot is failed.
    await expect(ws.manager.spawn("ordinary")).rejects.toThrow(/Delivery/);
    await expect(ws.manager.resume("ordinary", ws.ledger.get("ordinary")!)).rejects.toThrow(/Delivery/);
    await expect(ws.manager.restart("ordinary")).rejects.toThrow(/Delivery/);
    expect(await ws.manager.resumeReadiness("ordinary", ws.ledger.get("ordinary")!)).toBe(false);
    expect(await ws.manager.autostartPending()).not.toContain("ordinary");

    // Explicit deliveryJoin remains allowed under failed phase.
    let joinCwd = "";
    const originalPrepare = (ws.manager as unknown as { opts: {
      prepareDeliveryJoin?: (name: string, request: { expectedHead: string }) => Promise<unknown>;
      confirmDeliveryJoin?: () => Promise<void>;
    } }).opts;
    originalPrepare.prepareDeliveryJoin = async (_name, request) => {
      joinCwd = root;
      return {
        cwd: joinCwd,
        worktree: {
          path: joinCwd,
          branch: "tachyon/delivery",
          tachyonCreatedBranch: true,
          baseRef: request.expectedHead,
          createdAt: "now",
        },
        reservationNonce: "n-join",
        segmentId: "seg-join",
      };
    };
    originalPrepare.confirmDeliveryJoin = async () => undefined;
    await ws.manager.spawn("joiner", {
      cmd: "claude",
      deliveryJoin: {
        deliveryId: "d-r3",
        role: "fixer",
        ownsSubset: [],
        expectedHead: "abc",
        operationId: "join-r3-fail-open-closed",
      },
    });
    expect(await ws.manager.runningAgents()).toContain("joiner");

    // Successful start retry: restore store list → failed→ready; generic lifecycle unblocked.
    (ws.deliveries as { listWithCorrupt: typeof originalListWithCorrupt }).listWithCorrupt = originalListWithCorrupt;
    await ws.start();
    expect(ws.deliveryReloadPhase()).toBe("ready");
    expect(ws.deliveryReloadState()).toBeDefined();
    // ordinary may have been auto-resumed/autostarted by the successful start; either way spawn/resume path is open.
    await expect(ws.manager.spawn("offered")).resolves.toBeUndefined();
    expect(await ws.manager.runningAgents()).toContain("offered");
    ws.dispose();
  });
});

describe("Workspace — death-poke wiring (spec 332)", () => {
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
    await ws.manager.spawn("server", { cmd: "npm run dev", parent: "b" });
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
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
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

  it("still warns for a Delivery-bound wired survivor (the coordinator always leaves it running)", async () => {
    const { ws, host } = await bootWithSurvivor({
      record: {
        def: { cmd: "codex", kind: "agent" },
        resume: { runtime: "codex", sessionId: "s1" },
        declared: true,
        delivery: { deliveryId: "d-1", segmentId: "seg-0", executionNonce: "nonce-1" },
        updatedAt: "t",
      },
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
    await ws.manager.spawn("child1", { cmd: "sh", parent: "b" });
    const parentSession = ws.manager.session("b");
    pokeOf(ws)("child1", "1) yes  2) no");
    await flush();
    expect(sent.get(parentSession)).toBe("[tachyon] child 'child1' is waiting for input: 1) yes  2) no");
    ws.dispose();
  });

  it("falls back to a generic line when no matched prompt text is available", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("b");
    await ws.manager.spawn("child2", { cmd: "sh", parent: "b" });
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
    await ws.manager.spawn("child3", { cmd: "sh", parent: "b" });
    const parentSession = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working" } : originalStateOf(agent);
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

  it("does not derive awaiting-human for declared subagents or ad-hoc children", async () => {
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
    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working" } : originalStateOf(agent);

    const deliverNotice = (ws as unknown as { deliverNotice(agent: string, line: string): Promise<{ status: string }> }).deliverNotice.bind(ws);
    const recoverOnIdle = (ws as unknown as { recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> }).recoverOnIdle.bind(ws);
    const queued = await deliverNotice("b", "[tachyon] a → b: queued");
    expect(queued.status).toBe("queued");
    expect(sent.has(session)).toBe(false);

    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
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

  it("drops a queued notify when its sender is killed before the recipient becomes idle (t-99ccc9)", async () => {
    const { ws, sent } = await makeWorkspace();
    await ws.manager.spawn("a");
    await ws.manager.spawn("b");
    const targetSession = ws.manager.session("b");
    const originalStateOf = ws.monitor.stateOf.bind(ws.monitor);
    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "working" } : originalStateOf(agent);
    const internals = ws as unknown as {
      deliverNotice(agent: string, line: string, metadata: { sourceChild?: string; sourceIncarnation?: number }): Promise<{ status: string }>;
      sourceNoticeMetadata(agent: string): { sourceChild?: string; sourceIncarnation?: number };
      recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void>;
    };

    const queued = await internals.deliverNotice("b", "[tachyon] a → b: stale", internals.sourceNoticeMetadata("a"));
    expect(queued.status).toBe("queued");
    await ws.manager.kill("a");

    (ws.monitor as unknown as { stateOf(agent: string): { state: string } | undefined }).stateOf = (agent: string) =>
      agent === "b" ? { state: "idle" } : originalStateOf(agent);
    await internals.recoverOnIdle("b", false);
    expect(sent.has(targetSession)).toBe(false);
    ws.dispose();
  });
});
