import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
import { harnessRoot } from "../../src/harness/HarnessManager.js";
import { briefFilePath } from "../../src/agents/briefFile.js";
import { blankAgentFields } from "../../src/webview/agent-studio-shell/domain.js";
import type { FormState } from "../../src/webview/formLogic.js";
import { renderEvolutionLearnings } from "../../src/evolution/domain.js";
import { parse as parseYaml, stringify } from "yaml";
import { serializeAgentProfileAuthorityRegistry } from "../../src/config/agentProfileAuthority.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import { agentProfileAuthoritiesSecretKey, workspaceVersionStateKey } from "../../src/workspace/operationalStateKeys.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml, enableSavedAgentSelfEvolution, type SavedAgentSpec } from "../helpers/savedAgentFixture.js";
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
function fakeTmux(opts: { realPaneProcesses?: boolean } = {}) {
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
      // t-fab832 — record the session environment the real tmux would keep, so `show-environment`
      // can answer with the attestation this build mints at creation.
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "-e") continue;
        const eq = (args[i + 1] ?? "").indexOf("=");
        if (eq > 0) sessionEnv.set(`${name}\u0000${args[i + 1]!.slice(0, eq)}`, args[i + 1]!.slice(eq + 1));
      }
      panes.set(name, "");
      if (opts.realPaneProcesses) await replacePaneProcess(name);
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
  return { sessions, sessionEnv, dead, sent, panes, calls, children, replacePaneProcess, cleanup: async () => { await Promise.all([...children.keys()].map(stop)); }, tmux: new TmuxService(exec) };
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

/**
 * SDD 478 M7 — a workspace whose canonical agents have Evolution ENABLED.
 *
 * The projection pins the Evolution selector to a profileId, and only the store mints one, so the
 * store's profile has to exist before the selector can name it: seed a workspace, create the
 * profiles through its own authority, re-sign the profiles, and reload. A canonical agent therefore
 * cannot create its Evolution profile on first session — the profile is what the declaration points
 * at, so it precedes the declaration.
 */
/**
 * `t-d185e1` — Evolution has a product writer, so the capability is reachable and not merely
 * projectable.
 *
 * `projectDefinition` grants `selfEvolution` only when the profile pins an `evolution-selector.json`
 * naming a `profileId`. Nothing in `src/` ever wrote that file or that reference, so once `agents:`
 * narrowed to canonical pointers, no declared agent could enable Evolution by any product path —
 * only `enableSavedAgentSelfEvolution` above, a TEST helper, could reach the enabled projection. A
 * capability that exists in the projection and nowhere a human can get to is not a capability.
 *
 * The ordering is forced, not stylistic: the Evolution store mints the `profileId`, never the author,
 * and `AgentManager.evolutionForFreshSession` refuses a spawn whose snapshot id disagrees with the
 * pinned one. So the store's profile must exist before the selector that names it.
 */
describe("t-d185e1 — enabling Evolution on a declared canonical agent", () => {
  async function canonicalWorkspace(name: string) {
    const root = mkdir();
    const { host, secrets } = canonicalHost(root, [{ name, spec: { runtime: "claude" } }]);
    const deps = { host, onViewsChanged: () => {} };
    const ws = await Workspace.createForTest(root, deps, { tmux: fakeTmux().tmux, startBridge: false });
    return { root, ws, deps, secrets, name };
  }

  const profileOf = (root: string, name: string) =>
    parseYaml(fs.readFileSync(path.join(root, ".tachyon", "agents", name, "agent.yml"), "utf8")) as Record<string, unknown>;

  it("starts unreachable: a fresh canonical agent has no selector and no selfEvolution", async () => {
    const { root, ws, name } = await canonicalWorkspace("reviewer");
    try {
      expect(fs.existsSync(path.join(root, ".tachyon", "agents", name, "evolution-selector.json"))).toBe(false);
      expect(asAgent(ws.config?.agents[name])?.selfEvolution).toBeUndefined();
    } finally { ws.dispose(); }
  });

  it("pins the selector the projection reads, naming the id the STORE minted", async () => {
    const { root, ws, name } = await canonicalWorkspace("reviewer");
    try {
      await ws.enableAgentSelfEvolution(name);

      const bytes = fs.readFileSync(path.join(root, ".tachyon", "agents", name, "evolution-selector.json"), "utf8");
      const stored = (await ws.evolutionStore.readProfile(name))?.profileId;
      expect(stored).toBeTruthy();
      // Exactly these two keys: the reader refuses any extra one outright.
      expect(JSON.parse(bytes)).toEqual({ profileId: stored, schemaVersion: 1 });

      const profile = profileOf(root, name);
      const pinned = (profile.references as Array<Record<string, unknown>>)
        .find((reference) => reference.path === "evolution-selector.json")!;
      expect(pinned).toMatchObject({ kind: "evolution", scope: "profile", owner: profile.agentId, mode: "pinned" });
      // The pin is what makes the bytes trustworthy — a mismatched digest fails the whole projection
      // closed, so the digest is the property worth asserting rather than mere presence.
      expect(pinned.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect((profile.prompt as Record<string, unknown>).evolution).toBe(pinned.id);
    } finally { ws.dispose(); }
  });

  it("makes the capability REACHABLE: a reloaded workspace projects selfEvolution enabled", async () => {
    // The point of the task. Everything above could hold while the projection still refused.
    const { root, ws, deps, name } = await canonicalWorkspace("reviewer");
    let stored: string | undefined;
    try {
      await ws.enableAgentSelfEvolution(name);
      stored = (await ws.evolutionStore.readProfile(name))?.profileId;
    } finally { ws.dispose(); }

    const reloaded = await Workspace.createForTest(root, deps, { tmux: fakeTmux().tmux, startBridge: false });
    try {
      const projected = asAgent(reloaded.config?.agents[name]);
      expect(projected?.selfEvolution).toEqual({ enabled: true });
      expect(projected?.profileEvolution?.profileId).toBe(stored);
    } finally { reloaded.dispose(); }
  });

  it("refuses a second enable rather than pinning a second selector", async () => {
    const { ws, name } = await canonicalWorkspace("reviewer");
    try {
      await ws.enableAgentSelfEvolution(name);
      await expect(ws.enableAgentSelfEvolution(name)).rejects.toThrow(/already selects an Evolution profile/);
    } finally { ws.dispose(); }
  });
});

async function createEvolvingWorkspace(
  names: readonly string[],
  runtime: SavedAgentSpec["runtime"],
  fake: ReturnType<typeof fakeTmux>,
) {
  const root = mkdir();
  const { host, secrets } = canonicalHost(root, names.map((name) => ({ name, spec: { runtime } })));
  const deps = { host, onViewsChanged: () => {} };
  // The seed workspace gets its own tmux: disposing it must not tear down the channel the case
  // itself is about to spawn through.
  const seed = await Workspace.createForTest(root, deps, { tmux: fakeTmux().tmux, startBridge: false });
  for (const name of names) {
    enableSavedAgentSelfEvolution(root, name, (await seed.evolutionStore.ensureProfile(name)).profileId, secrets);
  }
  seed.dispose();
  return { root, host, ws: await Workspace.createForTest(root, deps, { tmux: fake.tmux, startBridge: false }) };
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
    const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux: fake.tmux, startBridge: false });
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
  const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux, startBridge: false });
  return { ws, host, tmux, sessions, sessionEnv, dead, sent, panes, calls };
}

it("rejects an invalid reload and retains the prior known-good config", async () => {
  // SDD 478 M7 — this used to prove the point with `soul: SOUL.md` on an inline agent. Neither half
  // of that is expressible now: `agents:` takes a profile pointer, and a canonical profile cannot
  // carry `soul` at all (the projection refuses it: Soul is a formation lane, not a projected prompt field — t-50bbd4). The guarantee under test is the
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
      kind: "agent-instance",
      agentName: "reviewer",
      editable: {
        displayName: "Reviewer", runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
        cwd: "", lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
        worktree: { enabled: true, branch: "feature/reviewer" }, isolation: "transcript",
      },
    });
    // t-ca9086: human-authorized Studio create writes enabled; start/autostart remain separate.
    expect(created.enabled).toBe(true);
    expect(created.editable.role).toBe("reviewer");
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).not.toContain("cmd:");

    const edited = await ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
      agentName: "reviewer",
      expectedRevision: created.revision,
      editable: {
        displayName: "Review Agent", runtime: { adapter: "codex", executable: "codex" }, role: "tester",
        cwd: "", lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
        worktree: { enabled: true, branch: "feature/reviewer" }, isolation: "transcript",
      },
    });
    expect(edited.editable).toMatchObject({ displayName: "Review Agent", role: "tester", runtime: { adapter: "codex", executable: "codex" } });
    await expect(ws.commitAgentProfileStudio({
      schemaVersion: 1,
      kind: "agent-instance",
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
      kind: "agent-instance",
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
    await expect(ws.forgetAgentProfileAgent("reviewer")).rejects.toThrow("fully stopped");
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

it("refuses a soul mutation a canonical pointer cannot accept, structurally and by name", async () => {
  // SDD 478 M7 — `createSoulProfile` mutates a declared agent by adding an inline `soul:` key, and
  // every declared agent is now a canonical profile pointer, which cannot coexist with an inline
  // field. t-e81ec5: the refusal used to happen deep in the config writer as `soul/io-error`, a code
  // that blames the disk for something no retry can fix, while Agent Studio still offered the button.
  // It is now refused up front, with a code and a message that name the reason and where soul lives.
  // What this case has always been about survives both changes: nothing is half-applied.
  const { ws } = await makeWorkspace(() => {}, { canonical: [{ name: "Ada", spec: { runtime: "codex" } }] });
  try {
    await expect(ws.createSoulProfile("Ada")).rejects.toMatchObject({ code: "soul/canonical-profile-unsupported" });
    await expect(ws.createSoulProfile("Ada")).rejects.toThrow(/canonical profile pointer/);
    // The refusal names where the capability actually lives, so the operator is not left guessing.
    await expect(ws.createSoulProfile("Ada")).rejects.toThrow(/t-e50d4f/);
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
    }, { tmux: fake.tmux, startBridge: false });
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

  it("keeps a removed agent footprint retryable when authority retirement fails", async () => {
    const { ws, host } = await makeWorkspace();
    ws.ledger.record("old", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, updatedAt: "t", instance: { lifetime: "saved", resumePolicy: "restartable" } });
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
    const { ws, sessions, sessionEnv } = await makeWorkspace();
    ws.ledger.record("resumable", { def: { cmd: "sh", kind: "agent" }, cwd: ws.workspaceRoot, updatedAt: "t", instance: { lifetime: "temporary", resumePolicy: "restartable" } });
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

    await expect(ws.commitAgentProfileStudioLifecycle({
      schemaVersion: 1,
      operation: "set-subagents",
      agentName: OWNER,
      expectedRevision: stale,
      subagents: TEAM,
    })).rejects.toThrow("revision conflict");
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
