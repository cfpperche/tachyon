import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, sessionName, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { Bridge } from "../../src/bridge/Bridge.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile } from "../../src/activity/sessionOwners.js";
import { ReloadTransactionStore } from "../../src/host-action/index.js";
import { __createdTerminals, __resetVscodeMock } from "../mocks/vscode.js";
import { readDelegationRecord } from "../../src/bridge/delegationRecord.js";
import { canonicalBehaviorStubPath } from "../../src/bridge/behaviorStub.js";

/**
 * spec 235 — the headless Workspace smoke test (the deferred spec-233 payoff): drive the orchestrator with
 * NO Electron, NO real tmux, NO bound Bridge port — proving config → managers → monitors → factory
 * lifecycle are wired together correctly. Substrate is injected via `Workspace.createForTest`.
 */

/** In-memory EngineHost — every host touchpoint is a no-op/recorder; the engine can't tell it isn't vscode. */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  readonly watches: Array<{ root: string; glob: string; events: WatchEvents; onEvent: () => void; disposed: boolean }> = [];
  private readonly stateMap = new Map<string, unknown>();
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
    this.notices.push({ message, level });
  }
  focusPrimaryView(): void {}
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
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string, private readonly settings: Record<string, unknown> = {}) {}
}

/** fake-exec tmux: a real TmuxService whose command channel is a fake (same pattern as the manager suites). */
function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>();
  const sent = new Map<string, string>(); // session -> last literal send-keys text (spec 332 death-poke assertions)
  const panes = new Map<string, string>();
  const calls: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.add(name);
      panes.set(name, "");
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
    if (args[2] === "capture-pane") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      return { stdout: panes.get(name) ?? "", stderr: "" };
    }
    if (args[2] === "kill-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      sessions.delete(name);
      dead.delete(name);
      panes.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, dead, sent, panes, calls, tmux: new TmuxService(exec) };
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

async function makeWorkspace(onViewsChanged: (view: ViewKind) => void = () => {}, opts: { bCmd?: string; tachyonYaml?: string } = {}) {
  const root = mkdir();
  // `a` autostarts (exercises the start() launch path); `b` is launched explicitly via the manager.
  fs.writeFileSync(path.join(root, "tachyon.yml"), opts.tachyonYaml ?? `agents:\n  a:\n    cmd: sh\n    autostart: true\n  b:\n    cmd: ${opts.bCmd ?? "sh"}\n`, "utf8");
  const host = new FakeHost(mkdir());
  const { tmux, sessions, dead, sent, panes, calls } = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged }, { tmux, startBridge: false });
  return { ws, host, sessions, dead, sent, panes, calls };
}

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

function latestDelegationRecord(root: string, agent: string) {
  const dir = path.join(root, ".tachyon", "delegations");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${agent}-`)).sort();
  return readDelegationRecord(path.join(dir, files.at(-1)!));
}

describe("Workspace — headless composition smoke (spec 235)", () => {
  it("builds + starts with no Electron / real tmux / bound port; start() auto-launches the declared agent", async () => {
    const { ws, sessions } = await makeWorkspace();
    await ws.start();
    expect(sessions.size).toBe(1); // config → start → manager → fake tmux, end to end, headless
    ws.dispose();
  });

  it("uses the configured Git executable for the fork dirty probe when PATH has no git", async () => {
    const root = mkdir();
    const trace = path.join(root, "git-trace.txt");
    const binary = path.join(root, "git-configured");
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  claude:\n    cmd: claude\n", "utf8");
    fs.writeFileSync(
      binary,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$TACHYON_TEST_GIT_TRACE\"",
        "if [ \"$1\" = \"status\" ] && [ \"$2\" = \"--porcelain\" ]; then",
        "  printf '%s\\n' 'status failed' >&2",
        "  exit 17",
        "fi",
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const host = new FakeHost(mkdir(), { "tachyon.gitPath": binary });
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    const worktreeDirty = (ws.manager as unknown as { opts: { worktreeDirty?: (rec: { path: string }) => Promise<boolean> } }).opts.worktreeDirty;
    const priorPath = process.env.PATH;
    const priorTrace = process.env.TACHYON_TEST_GIT_TRACE;
    process.env.PATH = "";
    process.env.TACHYON_TEST_GIT_TRACE = trace;
    try {
      expect(worktreeDirty).toBeDefined();
      expect(await worktreeDirty!({ path: root })).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorTrace === undefined) delete process.env.TACHYON_TEST_GIT_TRACE;
      else process.env.TACHYON_TEST_GIT_TRACE = priorTrace;
      ws.dispose();
    }

    expect(fs.readFileSync(trace, "utf8").trim()).toBe("status --porcelain");
  });

  it("notifies Runtime Ops when detached listener-ready initialization completes", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "settings:\n  bridgeClientRebind:\n    onHostGenerationBump: notify\nagents:\n  a:\n    cmd: codex\n", "utf8");
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "sessions.json"), JSON.stringify({
      sessions: {
        a: {
          cwd: root,
          declared: true,
          resume: { runtime: "codex", sessionId: "survivor" },
          bridgeClient: { boundGeneration: 0, wired: true },
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      },
    }));
    const host = new FakeHost(mkdir());
    const { tmux, sessions } = fakeTmux();
    sessions.add(sessionName(workspaceHash(root), "a"));
    const views: ViewKind[] = [];
    vi.spyOn(Bridge.prototype, "start").mockImplementation(async function(this: Bridge) {
      (this as unknown as { _port: number })._port = 41000;
      return 41000;
    });

    const ws = await Workspace.createForTest(root, { host, onViewsChanged: (view) => views.push(view) }, { tmux });
    await vi.waitFor(() => {
      expect(ws.runtimeOpsBridgeHealth("a")).toMatchObject({ currentGeneration: 1, boundGeneration: 0, wired: true, clientState: "suspect" });
      expect(views).toContain("agents");
    });
    await ws.dispose();
  });

  it("gated delegation records the reused task worktree HEAD, not the source HEAD (spec 362 T1)", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const host = new FakeHost(mkdir());
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    const contract = { task: "change behavior", context: "regression fixture", constraints: "stay scoped", doneWhen: "behavior test passes" };
    await ws.manager.spawn("reviewer", { cmd: "sh", contract, gate: { behaviorTest: "behavior regression" }, reveal: false });
    const first = latestDelegationRecord(root, "reviewer");
    const wt = ws.ledger.get("reviewer")?.worktree;
    expect(wt).toBeTruthy();

    fs.writeFileSync(path.join(wt!.path, "feature.txt"), "previous delegation\n", "utf8");
    git(wt!.path, ["add", "feature.txt"]);
    git(wt!.path, ["commit", "-m", "previous delegation"]);
    const taskBranchHead = git(wt!.path, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "main.txt"), "source moved elsewhere\n", "utf8");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "-m", "source moved"]);
    const sourceHead = git(root, ["rev-parse", "HEAD"]);
    expect(taskBranchHead).not.toBe(sourceHead);

    await ws.manager.kill("reviewer");
    await ws.manager.spawn("reviewer", { cmd: "sh", contract, gate: { behaviorTest: "behavior regression" }, reveal: false });
    const second = latestDelegationRecord(root, "reviewer");

    expect(first.baseSha).not.toBe(taskBranchHead);
    expect(second.baseSha).toBe(taskBranchHead);
    expect(second.baseSha).not.toBe(sourceHead);
    ws.dispose();
  });

  it("gated spawn commits a canonical behavior test stub", async () => {
    const root = mkdir();
    const wtBase = path.join(root, ".tachyon-test-worktrees");
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents:\n  boss:\n    cmd: sh\n`,
      "utf8",
    );
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "base"]);

    const host = new FakeHost(mkdir());
    const { tmux } = fakeTmux();
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
    const contract = { task: "fill generated behavior", context: "stub fixture", constraints: "stay scoped", doneWhen: "generated stub passes" };
    await ws.manager.spawn("stubber", {
      cmd: "sh",
      delegator: "boss",
      contract,
      gate: { behaviorTest: "generated behavior stays canonical", owns: ["src"] },
      reveal: false,
    });

    const record = latestDelegationRecord(root, "stubber");
    const wt = ws.ledger.get("stubber")?.worktree;
    const stubPath = canonicalBehaviorStubPath("stubber");

    expect(wt).toBeTruthy();
    expect(record.stubPath).toBe(stubPath);
    expect(record.owns).toEqual(["src", stubPath]);
    expect(record.baseSha).toBe(git(wt!.path, ["rev-parse", "HEAD"]));
    expect(git(wt!.path, ["show", "--format=%an <%ae>", "--no-patch", record.baseSha])).toBe("tachyon-container <tachyon@example.invalid>");
    expect(git(wt!.path, ["show", "--format=", "--name-only", record.baseSha])).toBe(stubPath);
    expect(fs.readFileSync(path.join(wt!.path, ...stubPath.split("/")), "utf8")).toContain('it("generated behavior stays canonical"');
    ws.dispose();
  });

  it("recovers pending host-action reload only after the Bridge is ready", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  idle:\n    cmd: sh\n", "utf8");
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
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  codex:\n    cmd: codex\n  claude:\n    cmd: claude\n", "utf8");
    const host = new FakeHost(mkdir());
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
    const session = [...sessions][0];
    dead.set(session, 7); // the pane died with exit 7
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

    (ws as unknown as { gcLedger(declaredInConfig: Set<string>, live: Set<string>): void }).gcLedger(new Set(["a", "b"]), new Set());

    expect(ws.ledger.get("old")).toBeUndefined();
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(readSessionOwners(sessionOwnersFile(ws.workspaceRoot)).map((r) => r.agent)).toEqual(["a"]);
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
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  a:\n    cmd: sh\n", "utf8");
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
      shellArgs: ["-u", "-L", "tachyon", "attach-session", "-d", "-t", `=${session}`],
      isTransient: true,
    });
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
    const { ws, host, panes } = await makeWorkspace((view) => changed.push(view), { bCmd: "codex" });
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
      tachyonYaml: "agents:\n  owner:\n    cmd: codex\n    subagents: [reviewer]\n  reviewer:\n    cmd: codex\n",
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
    const { ws, sent, panes } = await makeWorkspace(() => {}, { bCmd: "codex" });
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
});
