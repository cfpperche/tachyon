import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager, MaxAgentsError, ResumeUnavailableError, ForkUnavailableError, WatchController, newlyDeclaredAutostart } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile, spawnSettingsPath } from "../../src/activity/sessionOwners.js";
import { FORGET_AGENT_FOOTPRINTS, forgetAgent } from "../../src/agents/forgetAgent.js";
import { HarnessManager, harnessHome } from "../../src/harness/HarnessManager.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { delegationRecordFromSpawn, readDelegationRecord, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/** Stateful in-memory tmux fake at the executor level — exercises real TmuxService arg paths. */
function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>(); // session -> exit code (remain-on-exit dead pane)
  const panes = new Map<string, string>();
  const sentKeys: Array<{ session: string; key: string }> = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => {
      const i = args.indexOf("-t");
      return args[i + 1].replace(/^=/, "").replace(/:$/, "");
    };
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "rename-session": {
        const from = target();
        const to = args[args.length - 1];
        if (!sessions.delete(from)) throw new Error("can't find session");
        sessions.add(to);
        if (dead.has(from)) {
          dead.set(to, dead.get(from) as number);
          dead.delete(from);
        }
        return { stdout: "", stderr: "" };
      }
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        return { stdout: "", stderr: "" };
      case "send-keys":
        sentKeys.push({ session: target(), key: args[args.length - 1] });
        return { stdout: "", stderr: "" };
      case "capture-pane":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: panes.get(target()) ?? "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server running");
        return {
          stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n",
          stderr: "",
        };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, dead, panes, sentKeys, tmux: new TmuxService(exec) };
}

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeManager(yaml: string, maxAgentsSetting = 8) {
  const { sessions, dead, panes, sentKeys, tmux } = fakeTmux();
  const config = configOf(yaml);
  const spawned: string[] = [];
  const killed: string[] = [];
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => maxAgentsSetting,
    onSpawned: (n) => spawned.push(n),
    onKilled: (n) => killed.push(n),
  });
  return { manager, sessions, dead, panes, sentKeys, spawned, killed };
}

describe("AgentManager", () => {
  it("spawns a declared agent into a namespaced session", async () => {
    const { manager, sessions, spawned } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
    expect(spawned).toEqual(["claude"]);
  });

  it("rejects spawning an unknown agent without an ad-hoc cmd, accepts with one", async () => {
    const { manager, sessions } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.spawn("ghost")).rejects.toThrow("unknown agent");
    await manager.spawn("ghost", { cmd: "echo hi" });
    expect(sessions.has(`tachyon-${HASH}-ghost`)).toBe(true);
  });

  it("rejects double-spawn of a running agent", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    await expect(manager.spawn("a")).rejects.toThrow("already running");
  });

  it("enforces maxAgents from tachyon.yml settings over the editor setting", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n", 99);
    await manager.spawn("a");
    await expect(manager.spawn("b")).rejects.toThrow(MaxAgentsError);
  });

  it("falls back to the editor setting when yml has no maxAgents", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n", 1);
    await manager.spawn("a");
    await expect(manager.spawn("b")).rejects.toThrow("maxAgents limit reached (1)");
  });

  it("kill errors on a non-running agent, restart respawns a running one", async () => {
    const { manager, sessions, killed } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.kill("a")).rejects.toThrow("not running");
    await manager.spawn("a");
    await manager.restart("a");
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    await manager.kill("a");
    expect(killed).toEqual(["a"]);
    expect(sessions.size).toBe(0);
  });

  it("stopGracefully sends EOF without killing the tmux session", async () => {
    const { manager, sessions, sentKeys, killed } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.stopGracefully("a")).rejects.toThrow("not running");
    await manager.spawn("a");
    await manager.stopGracefully("a");
    expect(sentKeys).toEqual([{ session: `tachyon-${HASH}-a`, key: "C-d" }]);
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(killed).toEqual([]);
  });

  it("stopGracefully interrupts an active Codex turn before EOF", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    panes.set(`tachyon-${HASH}-codex`, "• Working (6m 03s • esc to interrupt)");
    await manager.stopGracefully("codex");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-codex`, key: "Escape" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
    ]);
  });

  it("stopGracefully does not interrupt an idle Codex pane", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    panes.set(`tachyon-${HASH}-codex`, "› ");
    await manager.stopGracefully("codex");
    expect(sentKeys).toEqual([{ session: `tachyon-${HASH}-codex`, key: "C-d" }]);
  });

  it("stopGracefully sends Claude's second EOF when the pane stays alive", async () => {
    const { manager, sessions, sentKeys } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    await manager.stopGracefully("claude");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-claude`, key: "C-c" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
    ]);
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
  });

  it("stopGracefully interrupts an active claude turn before EOF", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    panes.set(`tachyon-${HASH}-claude`, "esc to interrupt");
    await manager.stopGracefully("claude");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-claude`, key: "Escape" },
      { session: `tachyon-${HASH}-claude`, key: "C-c" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
    ]);
  });

  it("stopGracefully clears a leftover composer draft on an idle claude agent before EOF", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    panes.set(`tachyon-${HASH}-claude`, "› queued draft text that is not yet submitted");
    await manager.stopGracefully("claude");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-claude`, key: "C-c" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
      { session: `tachyon-${HASH}-claude`, key: "C-d" },
    ]);
  });

  it("cannot restart a re-discovered ad-hoc agent (no stored definition)", async () => {
    const { sessions, tmux } = fakeTmux();
    sessions.add(`tachyon-${HASH}-orphan`); // survived a previous extension host
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      getMaxAgents: () => 8,
    });
    await expect(manager.restart("orphan")).rejects.toThrow("no stored definition");
  });

  it("lists declared + running + ad-hoc agents merged", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n");
    await manager.spawn("a");
    await manager.spawn("extra", { cmd: "sleep 1" });
    const list = await manager.list();
    expect(list.map((i) => [i.name, i.running, i.declared])).toEqual([
      ["a", true, true],
      ["b", false, true],
      ["extra", true, false],
    ]);
  });

  it("crashed agents (dead pane) are not running, carry the exit code, and don't count toward maxAgents", async () => {
    const { manager, dead } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n");
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 137); // process died, pane remains
    const a = (await manager.list()).find((i) => i.name === "a");
    expect(a).toMatchObject({ running: false, crashed: true, exitCode: 137 });
    expect(await manager.runningAgents()).toEqual([]);
    // the dead pane doesn't occupy a maxAgents slot
    await manager.spawn("b");
  });

  it("spawning over a crashed agent replaces the dead pane", async () => {
    const { manager, sessions, dead } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 1);
    await manager.spawn("a"); // would throw 'already running' if it were alive
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(dead.has(`tachyon-${HASH}-a`)).toBe(false);
    const a = (await manager.list()).find((i) => i.name === "a");
    expect(a?.running).toBe(true);
  });

  it("killAll dismisses crashed panes too; autostart never replaces a postmortem", async () => {
    const { manager, sessions, dead } = makeManager(
      "agents:\n  a:\n    cmd: x\n    autostart: true\n  b:\n    cmd: y\n    autostart: true\n",
    );
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 2);
    // a is crashed (session present) -> autostart must NOT touch it; b has no session -> pending
    expect(await manager.autostartPending()).toEqual(["b"]);
    const killed = await manager.killAll();
    expect(killed).toEqual(["a"]);
    expect(sessions.size).toBe(0);
  });

  it("lineage: parent recorded, exposed in list, promoted on parent death, cleared on child kill", async () => {
    const { manager } = makeManager("agents:\n  orchestrator:\n    cmd: claude\n");
    await manager.spawn("orchestrator");
    await manager.spawn("worker", { cmd: "sh", parent: "orchestrator" });
    let worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("orchestrator");
    expect(manager.parentOf("worker")).toBe("orchestrator"); // spec 332 — the death-poke wiring's lookup
    expect(manager.parentOf("orchestrator")).toBeUndefined();

    // killing the parent leaves the child running; render promotes (parent still recorded)
    await manager.kill("orchestrator");
    worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.running).toBe(true);
    expect(worker?.parent).toBe("orchestrator"); // points at a gone agent — UI promotes to root

    // killing the ad-hoc child removes it from the listing entirely (def + lineage cleared)
    await manager.kill("worker");
    expect((await manager.list()).find((a) => a.name === "worker")).toBeUndefined();
  });

  it("spec 352 — declared owner surfaces separately from runtime actor lineage", async () => {
    const { manager } = makeManager("agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  codex:\n    cmd: codex\n  reviewer:\n    cmd: claude\n");
    await manager.spawn("reviewer", { parent: "codex" });
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.parent).toBeUndefined();
    expect(reviewer?.declaredOwner).toBe("claude");
    expect(manager.parentOf("reviewer")).toBeUndefined();
    expect(await manager.liveDescendants("claude")).toEqual([]);
    expect(await manager.liveDescendants("codex")).toEqual([]);
  });

  // spec 216 — captures the launched command for one spawn.
  const captureSpawnCmd = async (yml: string, name: string, opts?: Parameters<AgentManager["spawn"]>[1]): Promise<string> => {
    const calls: string[][] = [];
    const recording = new (await import("../../src/tmux/TmuxService.js")).TmuxService(async (args) => {
      calls.push(args);
      if (args[2] === "has-session" || args[2] === "list-panes") throw new Error("none");
      return { stdout: "", stderr: "" };
    });
    const manager = new AgentManager({ tmux: recording, wsHash: HASH, workspaceRoot: WS, getConfig: () => configOf(yml), getMaxAgents: () => 8 });
    await manager.spawn(name, opts);
    const spawnArgs = calls.find((c) => c.includes("new-session"))!;
    return spawnArgs[spawnArgs.length - 1];
  };

  it("ad-hoc child gets instructions + Bridge guidance appended (spec 216 Part B)", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\n", "revisor", { cmd: "claude", instructions: "review prs", parent: "a" });
    expect(cmd).toContain("review prs");
    expect(cmd).toContain("[Tachyon]"); // Bridge guidance (child has a parent)
  });

  it("declared role composes into the launch command, no guidance for a top-level agent (spec 216 Part A)", async () => {
    const cmd = await captureSpawnCmd("agents:\n  rev:\n    cmd: claude\n    role: reviewer\n", "rev");
    expect(cmd).toContain("review for quality"); // reviewer template text
    expect(cmd).not.toContain("[Tachyon]"); // no parent → no Bridge guidance
  });

  it("settings.bridgeGuidance: false suppresses the child guidance (spec 216), but not the spec 363 primer", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\nsettings:\n  bridgeGuidance: false\n", "w", { cmd: "claude", instructions: "do x", parent: "a" });
    expect(cmd).not.toContain("[Tachyon] You are part of a Tachyon team"); // Bridge guidance suppressed
    expect(cmd).toContain("do x"); // the actual instructions still land
    expect(cmd).toContain("── TACHYON PRIMER ──"); // spec 363 T3 — primer is independent of bridgeGuidance
  });

  it("non-AI child silently drops undeliverable guidance (sh has no instruction arg)", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\n", "w", { cmd: "sh", parent: "a" });
    expect(cmd).toBe("sh"); // sh has no instruction arg at all — nowhere for a primer to go either
  });

  it("spec 363 T3 — a lineage-bearing ad-hoc child's spawn command carries the PRIMER + BEFORE FINISHING block", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\n", "revisor2", { cmd: "claude", instructions: "review prs", parent: "a" });
    expect(cmd).toContain("── TACHYON PRIMER ──");
    expect(cmd).toContain("── END PRIMER ──");
    expect(cmd).toContain("── BEFORE FINISHING ──");
    expect(cmd).toContain("── END BEFORE FINISHING ──");
    expect(cmd).toMatch(/spawned by "a"/);
    expect(cmd.indexOf("── END PRIMER ──")).toBeLessThan(cmd.indexOf("review prs")); // primer opens the brief
    expect(cmd.indexOf("review prs")).toBeLessThan(cmd.indexOf("── BEFORE FINISHING ──")); // before-finishing closes it (recency)
  });

  it("spec 363 T3 — a bare declared top-level agent (no role/instructions/parent) is byte-identical: no primer", async () => {
    const cmd = await captureSpawnCmd("agents:\n  codex:\n    cmd: codex\n", "codex");
    expect(cmd).toBe("codex"); // ADDITIVE guard: nothing to onboard around, nothing is prepended
  });

  it("computes the pending autostart set, skipping survivors", async () => {
    const { manager } = makeManager(
      "agents:\n  a:\n    cmd: x\n    autostart: true\n  b:\n    cmd: y\n    autostart: true\n  c:\n    cmd: z\n",
    );
    await manager.spawn("a"); // simulate a survivor
    expect(await manager.autostartPending()).toEqual(["b"]);
  });

  it("spawn passes reveal to onSpawned — Bridge child (reveal:false) doesn't open a tab (F3)", async () => {
    const { tmux } = fakeTmux();
    const reveals: Array<[string, boolean]> = [];
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      getMaxAgents: () => 8,
      onSpawned: (n, r) => reveals.push([n, r]),
    });
    await manager.spawn("a"); // human/declared → reveal default true
    await manager.spawn("child", { cmd: "sh", parent: "a", reveal: false }); // Bridge child
    expect(reveals).toEqual([
      ["a", true],
      ["child", false],
    ]);
  });

  it("killAll kills only this workspace's sessions", async () => {
    const { manager, sessions } = makeManager("agents:\n  a:\n    cmd: x\n");
    sessions.add("tachyon-otherws0-x"); // other workspace
    await manager.spawn("a");
    const killed = await manager.killAll();
    expect(killed).toEqual(["a"]);
    expect(sessions.has("tachyon-otherws0-x")).toBe(true);
  });
});

describe("WatchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces bursts of change events into one restart", async () => {
    const restarts: string[] = [];
    const wc = new WatchController(async (a) => {
      restarts.push(a);
    }, 500);
    wc.onChange("dev");
    wc.onChange("dev");
    wc.onChange("dev");
    await vi.advanceTimersByTimeAsync(499);
    expect(restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts).toEqual(["dev"]);
  });

  it("tracks agents independently and cancels on dispose", async () => {
    const restarts: string[] = [];
    const wc = new WatchController(async (a) => {
      restarts.push(a);
    }, 100);
    wc.onChange("a");
    wc.onChange("b");
    await vi.advanceTimersByTimeAsync(100);
    expect(restarts.sort()).toEqual(["a", "b"]);

    wc.onChange("a");
    wc.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(restarts).toHaveLength(2);
  });
});

describe("AgentManager — session resume (spec 209)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function resumeHarness(
    yaml: string,
    opts: {
      newSessionId?: () => string;
      fileExists?: (p: string) => boolean;
      resolveCaptureId?: (rt: string, cwd: string) => Promise<string | null>;
      resolveCaptureSession?: (rt: string, cwd: string, configHome?: string, id?: string) => Promise<{ id: string; path: string } | null>;
      resolveCurrentSession?: (rt: string, cwd: string) => Promise<string | null>;
      homeDir?: () => string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      worktreeDirty?: (rec: any) => Promise<boolean>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveSpawnCwd?: (ctx: any) => Promise<{ cwd: string; worktree?: any; delegationBaseSha?: string } | null>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createForkWorktree?: (forkName: string, source: any) => Promise<{ cwd: string; worktree: any } | null>;
      seedTranscript?: (from: string, to: string) => boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      removeForkWorktree?: (worktree: any) => Promise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      materializeHarness?: (ctx: { name: string; def: any }) => any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveCurrentSessionFull?: (rt: string, cwd: string, title?: string, configHome?: string) => Promise<string | null>;
      getExtraEnv?: () => Record<string, string>;
      materializeBridgeMcp?: (name: string) => string | undefined;
      materializeBridgeMcpOpencode?: (name: string, cwd: string) => string | undefined;
      materializeOwnershipSettings?: (name: string) => string | undefined;
      materializeCodexSessionStartHookConfig?: (name: string) => string | string[] | undefined;
      ownedSession?: (name: string, cwd: string) => { sessionId: string; transcriptPath: string } | undefined;
      notify?: (m: string, l: "warn") => void;
      mintAgentToken?: (name: string) => Record<string, string>;
      revokeAgentToken?: (name: string) => void;
      removeHarnessHome?: (name: string) => void;
    } = {},
  ) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-am-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const sessions = new Set<string>();
    const cmds: string[] = []; // last positional arg of each new-session = the spawned command
    const newSessionArgs: string[][] = []; // full args of each new-session (to assert env -e)
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = () => {
        const i = args.indexOf("-t");
        return args[i + 1].replace(/^=/, "").replace(/:$/, "");
      };
      if (args.includes("new-session")) {
        sessions.add(args[args.indexOf("-s") + 1]);
        cmds.push(args[args.length - 1]);
        newSessionArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      switch (args[2]) {
        case "has-session":
          if (!sessions.has(target())) throw new Error("can't find session");
          return { stdout: "", stderr: "" };
        case "kill-session":
          sessions.delete(target());
          return { stdout: "", stderr: "" };
        case "list-sessions":
          if (sessions.size === 0) throw new Error("no server running");
          return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
        case "list-panes":
          if (sessions.size === 0) throw new Error("no server running");
          return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
        default:
          return { stdout: "", stderr: "" };
      }
    };
    const config = parseConfig(yaml).config!;
    const ledger = new SessionLedger(ws);
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: hash,
      workspaceRoot: ws,
      getConfig: () => config,
      getMaxAgents: () => 8,
      ledger,
      newSessionId: opts.newSessionId,
      fileExists: opts.fileExists ?? (() => true),
      resolveCaptureId: opts.resolveCaptureId,
      resolveCaptureSession: opts.resolveCaptureSession,
      resolveCurrentSession: opts.resolveCurrentSessionFull ?? opts.resolveCurrentSession,
      homeDir: opts.homeDir,
      resolveSpawnCwd: opts.resolveSpawnCwd,
      worktreeDirty: opts.worktreeDirty,
      createForkWorktree: opts.createForkWorktree,
      seedTranscript: opts.seedTranscript,
      removeForkWorktree: opts.removeForkWorktree,
      materializeHarness: opts.materializeHarness,
      getExtraEnv: opts.getExtraEnv,
      materializeBridgeMcp: opts.materializeBridgeMcp,
      materializeBridgeMcpOpencode: opts.materializeBridgeMcpOpencode,
      materializeOwnershipSettings: opts.materializeOwnershipSettings,
      materializeCodexSessionStartHookConfig: opts.materializeCodexSessionStartHookConfig,
      ownedSession: opts.ownedSession,
      notify: opts.notify,
      mintAgentToken: opts.mintAgentToken,
      revokeAgentToken: opts.revokeAgentToken,
      removeHarnessHome: opts.removeHarnessHome,
    });
    return { manager, ledger, cmds, newSessionArgs, ws, hash };
  }

  it("mint runtime (claude): spawns a NAMED session (-n) and records the name (spec 220)", async () => {
    const { manager, ledger, cmds, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      newSessionId: () => "uuid-ignored-for-claude", // claude name-mints; the random uuid is unused
    });
    await manager.spawn("claude");
    const name = `tachyon-${path.basename(ws)}-claude`;
    expect(cmds[0]).toContain(`-n ${name}`);
    expect(cmds[0]).not.toContain("--session-id");
    expect(ledger.get("claude")).toMatchObject({
      def: { cmd: "claude", kind: "agent" }, // original, pre-injection (resume re-passes clean flags)
      resume: { runtime: "claude", sessionId: name }, // the name; upgraded to the real uuid at kill (customTitle capture)
      declared: true,
      cwd: ws,
    });
  });

  it("capture runtime (codex): records intent with empty id, no injection", async () => {
    const { manager, ledger, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    expect(cmds[0]).toBe("codex"); // unchanged
    expect(ledger.get("codex")).toMatchObject({ resume: { runtime: "codex", sessionId: "" }, declared: true });
  });

  it("spawn injects TACHYON_AGENT_NAME for runtime hooks", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    expect(newSessionArgs.at(-1)).toContain("TACHYON_AGENT_NAME=codex");
  });

  it("TACHYON_AGENT_NAME is reserved and wins over user env", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  codex:\n    cmd: codex\n    env:\n      TACHYON_AGENT_NAME: wrong\n");
    await manager.spawn("codex");
    expect(newSessionArgs.at(-1)).toContain("TACHYON_AGENT_NAME=codex");
    expect(newSessionArgs.at(-1)).not.toContain("TACHYON_AGENT_NAME=wrong");
  });

  it("restart re-injects TACHYON_AGENT_NAME for runtime hooks", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  codex:\n    cmd: codex\n    env:\n      TACHYON_AGENT_NAME: wrong\n");
    await manager.spawn("codex");
    newSessionArgs.length = 0;
    await manager.restart("codex");
    expect(newSessionArgs.at(-1)).toContain("TACHYON_AGENT_NAME=codex");
    expect(newSessionArgs.at(-1)).not.toContain("TACHYON_AGENT_NAME=wrong");
  });

  it("self-resuming claude cmd (--resume) spawns VERBATIM and records NO resume block (regression: exit 1 on --session-id + --resume)", async () => {
    const { manager, ledger, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --resume tachyon\n", {
      newSessionId: () => "should-not-be-used",
    });
    await manager.spawn("claude");
    expect(cmds[0]).toBe("claude --resume tachyon"); // no --session-id appended
    expect(ledger.get("claude")?.resume).toBeUndefined(); // not a Tachyon-minted resume; its own cmd resumes on restart
    expect(ledger.get("claude")?.def?.cmd).toBe("claude --resume tachyon");
  });

  it("A3/220: kill upgrades the claude ledger id from the name to the captured uuid", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "captured-uuid",
      fileExists: () => true,
    });
    await manager.spawn("claude");
    const name = `tachyon-${path.basename(ws)}-claude`;
    expect(ledger.get("claude")!.resume!.sessionId).toBe(name); // the spawned name, pre-capture
    await manager.kill("claude");
    expect(ledger.get("claude")!.resume!.sessionId).toBe("captured-uuid"); // upgraded via customTitle
  });

  it("spec 238: transcriptPathOf resolves the live claude transcript (name→uuid) when it exists", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "live-uuid",
      fileExists: () => true,
      homeDir: () => "/home/test",
    });
    await manager.spawn("claude");
    const loc = await manager.transcriptPathOf("claude");
    expect(loc?.runtime).toBe("claude");
    expect(loc?.path).toContain("/home/test/.claude/projects/");
    expect(loc?.path.endsWith("live-uuid.jsonl")).toBe(true);
  });

  it("spec 238: transcriptPathOf is undefined when the transcript file is gone (→ view degrades to terminal)", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "live-uuid",
      fileExists: () => false,
    });
    await manager.spawn("claude");
    expect(await manager.transcriptPathOf("claude")).toBeUndefined();
  });

  it("spec 238: transcriptPathOf remains undefined for Codex without a path resolver and for an unknown agent", async () => {
    const { manager } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", { fileExists: () => true });
    await manager.spawn("codex");
    expect(await manager.transcriptPathOf("codex")).toBeUndefined();
    expect(await manager.transcriptPathOf("ghost")).toBeUndefined(); // no ledger/resume block
  });

  it("spec 305: transcriptPathOf resolves a Codex rollout by stored id", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCaptureSession: async (_rt, _cwd, _home, id) => id === "codex-id" ? { id, path: `${ws}/rollout-codex-id.jsonl` } : null,
      fileExists: () => true,
    });
    await manager.spawn("codex");
    const rec = ledger.get("codex")!;
    ledger.record("codex", { ...rec, resume: { ...rec.resume!, sessionId: "codex-id" } });

    await expect(manager.transcriptPathOf("codex")).resolves.toEqual({ path: `${ws}/rollout-codex-id.jsonl`, runtime: "codex" });
  });

  it("spec 305: Codex live Activity uses ownership on shared cwd and otherwise refuses newest-by-cwd guessing", async () => {
    const OWNED = "owned-codex";
    const { manager, ledger, ws } = resumeHarness("agents:\n  codex:\n    cmd: codex\n  codex2:\n    cmd: codex\n", {
      resolveCaptureSession: async () => ({ id: "sibling", path: `${ws}/sibling.jsonl` }),
      ownedSession: (name) => name === "codex" ? { sessionId: OWNED, transcriptPath: `${ws}/${OWNED}.jsonl` } : undefined,
      fileExists: () => true,
    });
    await manager.spawn("codex");
    await manager.spawn("codex2");
    const rec = ledger.get("codex")!;
    ledger.record("codex", { ...rec, resume: { ...rec.resume!, sessionId: "" } });

    await expect(manager.transcriptPathOf("codex", { live: true })).resolves.toEqual({ path: `${ws}/${OWNED}.jsonl`, runtime: "codex" });

    const noOwned = resumeHarness("agents:\n  codex:\n    cmd: codex\n  codex2:\n    cmd: codex\n", {
      resolveCaptureSession: async () => ({ id: "sibling", path: `${ws}/sibling.jsonl` }),
      fileExists: () => true,
    });
    await noOwned.manager.spawn("codex");
    await noOwned.manager.spawn("codex2");
    const noOwnedRec = noOwned.ledger.get("codex")!;
    noOwned.ledger.record("codex", { ...noOwnedRec, resume: { ...noOwnedRec.resume!, sessionId: "" } });
    await expect(noOwned.manager.transcriptPathOf("codex", { live: true })).resolves.toBeUndefined();
  });

  it("spec 305 follow-up: legacy Codex rows stamped with ~/.claude are re-homed to ~/.codex for Activity", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  codex:\n    cmd: codex\n  claude:\n    cmd: claude\n", {
      homeDir: () => "/home/test",
      resolveCaptureSession: async (_rt, _cwd, configHome) =>
        configHome === "/home/test/.codex" ? { id: "codex-id", path: `${ws}/rollout-codex-id.jsonl` } : null,
      fileExists: () => true,
    });
    ledger.record("codex", {
      def: { cmd: "codex", kind: "agent" },
      resume: { runtime: "codex", sessionId: "", configHome: "/home/test/.claude" },
      cwd: ws,
      declared: true,
      updatedAt: "t",
    });
    ledger.record("claude", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "claude-id", configHome: "/home/test/.claude" },
      cwd: ws,
      declared: true,
      updatedAt: "t",
    });

    manager.rehydrateFromLedger();

    expect(ledger.get("codex")?.resume?.configHome).toBe("/home/test/.codex");
    await expect(manager.transcriptPathOf("codex", { live: true })).resolves.toEqual({ path: `${ws}/rollout-codex-id.jsonl`, runtime: "codex" });
  });

  it("spec 238: transcriptPathOf({live}) follows the CURRENT session on an unambiguous cwd, past a captured uuid", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const NEW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : NEW), // newest-by-cwd (no title) = NEW
      fileExists: () => true,
    });
    await manager.spawn("claude");
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } }); // simulate an already-captured uuid
    expect((await manager.transcriptPathOf("claude"))?.path.endsWith(`${CAP}.jsonl`)).toBe(true); // non-live pins to stored
    expect((await manager.transcriptPathOf("claude", { live: true }))?.path.endsWith(`${NEW}.jsonl`)).toBe(true); // live follows newest
  });

  it("spec 238: live-follow is SUPPRESSED on a shared cwd (newest-by-cwd can't disambiguate)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const NEW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : NEW),
      fileExists: () => true,
    });
    await manager.spawn("claude");
    await manager.spawn("claude2");
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } });
    expect((await manager.transcriptPathOf("claude", { live: true }))?.path.endsWith(`${CAP}.jsonl`)).toBe(true); // stays pinned
  });

  it("spec 239: shared cwd + no captured id does NOT bare cwd-scan — returns undefined (prefer-gap, never a sibling's session)", async () => {
    const SIB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async () => null, // no title resolve
      resolveCaptureId: async () => SIB,           // the bare cwd-scan WOULD return a sibling's session (the bug)
      fileExists: () => true,
    });
    await manager.spawn("claude");
    await manager.spawn("claude2"); // both default to the workspace root → shared cwd
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: "" } }); // no captured id at all
    expect(await manager.transcriptPathOf("claude", { live: true })).toBeUndefined(); // gap — must NOT attribute the sibling
  });

  it("spec 243: ownership ledger lets a SHARED-cwd agent FOLLOW a /clear past its captured uuid (the frozen-Activity bug)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // the pre-/clear captured uuid (would pin without ownership)
    const NEW = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // the post-/clear session the hook recorded
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : null), // title still resolves to the OLD uuid
      fileExists: () => true,
      ownedSession: (name) => (name === "claude" ? { sessionId: NEW, transcriptPath: `${ws}/.claude/projects/x/${NEW}.jsonl` } : undefined),
    });
    await manager.spawn("claude");
    await manager.spawn("claude2"); // shared cwd → without ownership, claude would stay pinned to CAP (see the spec-238 test above)
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } });
    const loc = await manager.transcriptPathOf("claude", { live: true });
    expect(loc?.path.endsWith(`${NEW}.jsonl`)).toBe(true); // POSITIVE attribution: follows the agent's OWN new session
  });

  it("spec 243: ownership is authoritative only when its transcript EXISTS — else falls through (and stays a gap on a shared cwd)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const GONE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : null),
      fileExists: (p) => !p.endsWith(`${GONE}.jsonl`), // the owned transcript is gone
      ownedSession: () => ({ sessionId: GONE, transcriptPath: `/x/${GONE}.jsonl` }),
    });
    await manager.spawn("claude");
    await manager.spawn("claude2");
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } });
    // owned transcript missing → ignore the row; shared cwd → the captured-uuid pin still applies (no misattribution)
    expect((await manager.transcriptPathOf("claude", { live: true }))?.path.endsWith(`${CAP}.jsonl`)).toBe(true);
  });

  it("spec 243: ownership is NOT consulted for a non-live (pinned) read", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const NEW = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async () => null,
      fileExists: () => true,
      ownedSession: () => ({ sessionId: NEW, transcriptPath: `/x/${NEW}.jsonl` }),
    });
    await manager.spawn("claude");
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } });
    expect((await manager.transcriptPathOf("claude"))?.path.endsWith(`${CAP}.jsonl`)).toBe(true); // non-live → stored uuid, ownership skipped
  });

  it("spec 244: refreshOwnership (kill) advances a SHARED-cwd ledger id to the owned (post-/clear) session", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // stale captured (pre-/clear) — the title resolve can't move past it
    const NEW = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // the post-/clear session the ownership hook recorded
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : null), // shared-cwd title resolve = the OLD id
      fileExists: () => true,
      ownedSession: (name) => (name === "claude" ? { sessionId: NEW, transcriptPath: `/x/${NEW}.jsonl` } : undefined),
    });
    await manager.spawn("claude");
    await manager.spawn("claude2"); // shared cwd
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } }); // simulate the stale captured uuid
    await manager.kill("claude"); // triggers refreshOwnership
    expect(ledger.get("claude")!.resume!.sessionId).toBe(NEW); // ownership advanced it past the /clear
    expect(ledger.get("claude2")!.resume!.sessionId).not.toBe(NEW); // sibling untouched
  });

  it("spec 244: resume reopens the OWNED session past a stale stored uuid (claude --resume <new>)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const NEW = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const { manager, cmds, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: () => true,
      ownedSession: () => ({ sessionId: NEW, transcriptPath: `/x/${NEW}.jsonl` }),
    });
    await manager.spawn("claude");
    cmds.length = 0;
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", declared: true, updatedAt: "t" });
    expect(cmds.at(-1)).toContain(`--resume ${NEW}`); // reopened the current session, not the stale CAP
    expect(cmds.at(-1)).not.toContain(CAP);
    expect(ledger.get("claude")!.resume!.sessionId).toBe(NEW); // ledger persisted the owned id
  });

  it("spec 244: resume FALLS BACK to the stored id when the owned transcript is gone (no regression)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const GONE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: (p) => !p.includes(GONE), // the owned transcript no longer exists
      ownedSession: () => ({ sessionId: GONE, transcriptPath: `/x/${GONE}.jsonl` }),
    });
    await manager.spawn("claude");
    cmds.length = 0;
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", declared: true, updatedAt: "t" });
    expect(cmds.at(-1)).toContain(`--resume ${CAP}`); // owned gone → fall back to the stored id (today's behavior)
  });

  it("spec 244: no ownership row → resume keeps the existing stored-id path (no misattribution)", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: () => true,
      ownedSession: () => undefined, // nothing recorded for this agent
    });
    await manager.spawn("claude");
    cmds.length = 0;
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", declared: true, updatedAt: "t" });
    expect(cmds.at(-1)).toContain(`--resume ${CAP}`); // unchanged behavior
  });

  it("spec 244: resumeReadiness reads READY off the ownership ledger when the stored id is stale/gone (badge mirrors resume)", async () => {
    const STALE_GONE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // stored id whose transcript no longer exists
    const NEW = "dddddddd-dddd-dddd-dddd-dddddddddddd";        // the owned (current) session, on disk
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: (p) => !p.includes(STALE_GONE), // stale stored transcript gone; owned one exists
      resolveCurrentSessionFull: async () => null,
      ownedSession: () => ({ sessionId: NEW, transcriptPath: `/x/${NEW}.jsonl` }),
    });
    const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: STALE_GONE }, cwd: "/ws", declared: true, updatedAt: "t" };
    // Without the spec-244 fold this would be false (stored transcript gone) → sidebar "fresh start" though resume would work.
    expect(await manager.resumeReadiness("claude", rec)).toBe(true);
  });

  it("spec 240: `isolate: transcript` makes a same-cwd agent UNAMBIGUOUS → live-follow works + transcript in its own home", async () => {
    const CAP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const NEW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n    isolate: transcript\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_rt, _cwd, title) => (title ? CAP : NEW),
      fileExists: () => true,
    });
    await manager.spawn("claude");
    await manager.spawn("claude2"); // shares the cwd, but claude is in its OWN config home
    // spec 240: configHome persisted on spawn — claude → private home, claude2 → ~/.claude
    expect(ledger.get("claude")!.resume!.configHome).toContain("harness");
    expect(ledger.get("claude2")!.resume!.configHome).toContain(".claude");
    const rec = ledger.get("claude")!;
    ledger.record("claude", { ...rec, resume: { ...rec.resume!, sessionId: CAP } });
    const loc = await manager.transcriptPathOf("claude", { live: true });
    expect(loc?.path.endsWith(`${NEW}.jsonl`)).toBe(true); // unambiguous → FOLLOWS newest (not pinned like a shared plain pair)
    expect(loc?.path).toContain("harness"); // resolved under its own config home
  });

  it("spec 240: rehydrateFromLedger backfills a missing configHome on a pre-240 row (locks it before any toggle)", () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "x" }, cwd: "/repo", declared: true });
    manager.rehydrateFromLedger();
    expect(ledger.get("claude")!.resume!.configHome).toContain(".claude"); // derived + persisted once
  });

  it("spec 240: effectiveHome derives for a pre-240 row (no persisted configHome) without breaking lookup", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "live-uuid",
      fileExists: () => true,
    });
    await manager.spawn("claude");
    const rec = ledger.get("claude")!;
    delete (rec.resume as { configHome?: string }).configHome; // simulate a pre-240 row
    ledger.record("claude", rec);
    expect((await manager.transcriptPathOf("claude"))?.path.endsWith("live-uuid.jsonl")).toBe(true); // derives ~/.claude, still resolves
  });

  it("spec 240: restart RE-HOMES configHome to the derived home (isolate toggled on an already-recorded agent)", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n    isolate: transcript\n", {
      resolveCurrentSession: async () => "uuid",
      fileExists: () => true,
    });
    // a PRE-toggle row: the session was recorded under the SHARED home before `isolate` was declared.
    ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "old-uuid", configHome: "/home/whoever/.claude" }, cwd: "/repo", declared: true });
    await manager.restart("claude");
    // restart mints a FRESH session under the CURRENT derived home → re-homed to the private home (not preserved).
    expect(ledger.get("claude")!.resume!.configHome).toContain("harness");
    expect(ledger.get("claude")!.resume!.configHome).not.toBe("/home/whoever/.claude");
  });

  it("220: claude refresh resolves even on a SHARED cwd (unique title disambiguates), and a null resolver keeps the name", async () => {
    const shared = resumeHarness("agents:\n  claude:\n    cmd: claude\n  claude2:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "captured-uuid",
      fileExists: () => true,
    });
    await shared.manager.spawn("claude");
    await shared.manager.spawn("claude2"); // both default to the workspace root → shared cwd
    await shared.manager.kill("claude");
    expect(shared.ledger.get("claude")!.resume!.sessionId).toBe("captured-uuid"); // title-scoped → no ambiguity skip

    const keep = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => null,
      fileExists: () => true,
    });
    await keep.manager.spawn("claude");
    const keepName = `tachyon-${path.basename(keep.ws)}-claude`;
    await keep.manager.kill("claude");
    expect(keep.ledger.get("claude")!.resume!.sessionId).toBe(keepName); // null → stored name untouched
  });

  it("A3: refresh STAYS gated on a shared cwd for newest-by-cwd runtimes (codex)", async () => {
    const shared = resumeHarness("agents:\n  codex:\n    cmd: codex\n  codex2:\n    cmd: codex\n", {
      resolveCurrentSession: async () => "switched",
      fileExists: () => true,
    });
    await shared.manager.spawn("codex");
    await shared.manager.spawn("codex2"); // shared workspace-root cwd
    await shared.manager.kill("codex");
    expect(shared.ledger.get("codex")!.resume!.sessionId).toBe(""); // ambiguous → never guesses (capture stays empty)
  });

  it("A3: a throwing resolver never blocks kill (best-effort refresh)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => {
        throw new Error("disk boom");
      },
    });
    await manager.spawn("claude");
    const name = `tachyon-${path.basename(ws)}-claude`;
    await expect(manager.kill("claude")).resolves.toBeUndefined(); // teardown not blocked
    expect(ledger.get("claude")!.resume!.sessionId).toBe(name); // refresh failed silently, name kept
  });

  it("A3: resume canonicalizes an aliased record.cwd for the spawn (and the transcript check)", async () => {
    const { manager, newSessionArgs, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
    const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "sid" }, cwd: `${ws}/.`, declared: true, updatedAt: "t" };
    await manager.resume("claude", rec);
    const args = newSessionArgs.at(-1)!;
    expect(args[args.indexOf("-c") + 1]).toBe(ws); // '/ws/.' → '/ws' (matches refreshOwnership's normalization)
  });

  it("A3: the ambiguity gate normalizes cwds — an aliased sibling ('/x' vs '/x/.') counts as shared (codex)", async () => {
    // claude bypasses this gate (it resolves by unique customTitle, spec 220); the gate still guards
    // newest-by-cwd runtimes like codex, so the normalization is asserted there.
    const { manager, ledger, ws } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCurrentSession: async () => "switched",
      fileExists: () => true,
    });
    await manager.spawn("codex"); // cwd = ws
    ledger.record("sibling", { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s" }, cwd: `${ws}/.`, declared: true });
    await manager.kill("codex");
    expect(ledger.get("codex")!.resume!.sessionId).toBe(""); // alias resolved as shared → skipped (capture stays empty)
  });

  it("ad-hoc spawn records declared:false with a def (restartable) + resume", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  decoy:\n    cmd: x\n", { newSessionId: () => "x" });
    await manager.spawn("scratch", { cmd: "claude" });
    // claude name-mints (spec 220): the resume id is the deterministic name for the ad-hoc agent
    const name = `tachyon-${path.basename(ws)}-scratch`;
    expect(ledger.get("scratch")).toMatchObject({ declared: false, def: { cmd: "claude" }, resume: { sessionId: name } });
  });

  it("resume() spawns the runtime's resume command and persists the id", async () => {
    const { manager, ledger, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      newSessionId: () => "uuid-1",
    });
    await manager.spawn("claude"); // mint
    await manager.kill("claude"); // simulate process/session gone
    const rec = { def: { cmd: "claude --permission-mode plan", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "uuid-1" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("claude", rec);
    expect(cmds.at(-1)).toBe("claude --permission-mode plan --resume uuid-1");
    expect(ledger.get("claude")!.resume!.sessionId).toBe("uuid-1");
  });

  it("220: restart re-injects -n <name> and RESETS the ledger id to the name (not the pre-restart uuid)", async () => {
    const { manager, ledger, cmds, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "old-uuid",
      fileExists: () => true,
    });
    await manager.spawn("claude");
    const name = `tachyon-${path.basename(ws)}-claude`;
    await manager.kill("claude"); // capture upgrades the ledger id to the (old) session uuid
    expect(ledger.get("claude")!.resume!.sessionId).toBe("old-uuid");
    await manager.restart("claude");
    expect(cmds.at(-1)).toContain(`-n ${name}`); // restarted session carries the customTitle
    expect(ledger.get("claude")!.resume!.sessionId).toBe(name); // reset → next refresh/resume finds the NEW session
  });

  it("220: resume() upgrades a still-NAME claude id to the captured uuid (crash→Resume keeps context)", async () => {
    const { manager, cmds, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => "real-uuid", // crashed agent never ran kill()/refresh; capture at resume time
      fileExists: () => true,
    });
    const name = `tachyon-${path.basename(ws)}-claude`;
    const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: name }, cwd: ws, declared: true, updatedAt: "t" };
    await manager.resume("claude", rec);
    expect(cmds.at(-1)).toBe("claude --resume real-uuid"); // resumed by the captured uuid, not the bare name
  });

  it("220: resume() resolves a claude NAME id via the STORED title, not a recomputed one (rename-safe)", async () => {
    const { manager, cmds, ws } = resumeHarness("agents:\n  renamed:\n    cmd: claude\n", {
      // only the agent's ORIGINAL spawn title resolves — proves we pass the stored id, not claudeSessionName("renamed")
      resolveCurrentSession: async (_rt: string, _cwd: string, title?: string) => (title === "tachyon-oldws-oldname" ? "real-uuid" : null),
      fileExists: () => true,
    });
    const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "tachyon-oldws-oldname" }, cwd: ws, declared: true, updatedAt: "t" };
    await manager.resume("renamed", rec);
    expect(cmds.at(-1)).toBe("claude --resume real-uuid"); // resolved by the stored (old) title
  });

  it("rename moves the durable activity log to the new agent name", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  old:\n    cmd: claude\n", {});
    ledger.record("old", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: true, updatedAt: "t" });
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const oldLog = path.join(actDir, `${agentLogId("old")}.jsonl`);
    const oldState = path.join(actDir, `${agentLogId("old")}.state.json`);
    const newLog = path.join(actDir, `${agentLogId("new")}.jsonl`);
    const newState = path.join(actDir, `${agentLogId("new")}.state.json`);
    fs.writeFileSync(oldLog, '{"schemaVersion":1}\n', "utf8");
    fs.writeFileSync(oldState, "{}", "utf8");

    await manager.rename("old", "new");

    expect(ledger.get("old")).toBeUndefined();
    expect(ledger.get("new")).toBeDefined();
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(oldState)).toBe(false);
    expect(fs.existsSync(newLog)).toBe(true);
    expect(fs.existsSync(newState)).toBe(true);
  });

  it("221: resumeReadiness reflects transcript-on-disk, read-only (no spawn)", async () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const rec = (over: Partial<{ runtime: "claude" | "qwen"; sessionId: string }>) => ({
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: (over.runtime ?? "claude") as "claude" | "qwen", sessionId: over.sessionId ?? uuid },
      cwd: "/ws",
      declared: true,
      updatedAt: "t",
    });
    // distinct agent names per assertion — resumeReadiness caches per name (validated by sessionId).
    // captured uuid + transcript present → ready
    const present = resumeHarness("agents:\n  c:\n    cmd: claude\n", { fileExists: () => true });
    expect(await present.manager.resumeReadiness("a-present", rec({}))).toBe(true);
    // captured uuid + transcript gone → fresh
    const gone = resumeHarness("agents:\n  c:\n    cmd: claude\n", { fileExists: () => false });
    expect(await gone.manager.resumeReadiness("a-gone", rec({}))).toBe(false);
    // bare NAME id → resolves by title, then checks the resolved uuid's transcript
    const named = resumeHarness("agents:\n  c:\n    cmd: claude\n", { resolveCurrentSession: async () => uuid, fileExists: () => true });
    expect(await named.manager.resumeReadiness("a-named", rec({ sessionId: "tachyon-ws-c" }))).toBe(true);
    // qwen (resumesWithoutId) → always ready; no resume block → not ready
    const q = resumeHarness("agents:\n  q:\n    cmd: qwen\n");
    expect(await q.manager.resumeReadiness("a-qwen", rec({ runtime: "qwen", sessionId: "" }))).toBe(true);
    expect(await present.manager.resumeReadiness("a-nodef", { def: { cmd: "x", kind: "agent" }, cwd: "/ws", declared: true, updatedAt: "t" })).toBe(false);
    // resume block but NO def.cmd → resume() rejects it, so the badge must NOT say resumable (codex MAJOR)
    expect(await present.manager.resumeReadiness("a-noclmd", { resume: { runtime: "claude", sessionId: uuid }, cwd: "/ws", declared: true, updatedAt: "t" })).toBe(false);
  });

  it("221: resumeReadiness is cached per agent, auto-invalidated when the sessionId changes (no re-scan per refresh)", async () => {
    const uuid = "22222222-2222-2222-2222-222222222222";
    let probes = 0;
    const h = resumeHarness("agents:\n  c:\n    cmd: claude\n", {
      resolveCurrentSession: async () => {
        probes++;
        return uuid;
      },
      fileExists: () => true,
    });
    const recName = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "tachyon-ws-c" }, cwd: "/ws", declared: true, updatedAt: "t" };
    expect(await h.manager.resumeReadiness("c", recName)).toBe(true);
    expect(await h.manager.resumeReadiness("c", recName)).toBe(true); // cache hit — the project dir is NOT re-scanned
    expect(probes).toBe(1); // resolved once across repeated refreshes
    // capture upgraded name→uuid: the sessionId changed → the cache entry is invalidated, re-evaluated
    const recUuid = { ...recName, resume: { runtime: "claude" as const, sessionId: uuid } };
    expect(await h.manager.resumeReadiness("c", recUuid)).toBe(true);
    expect(probes).toBe(1); // a captured uuid needs NO resolveCurrentSession (cheap stat path), still no re-scan
  });

  it("resume() resolves a capture runtime's id from disk", async () => {
    const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCaptureId: async () => "captured-id",
    });
    const rec = { def: { cmd: "codex", kind: "agent" as const }, resume: { runtime: "codex" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("codex", rec);
    expect(cmds.at(-1)).toBe("codex resume captured-id");
  });

  it("resume() throws ResumeUnavailableError when the transcript is gone (fallback signal)", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => false });
    const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "u1" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await expect(manager.resume("claude", rec)).rejects.toThrow(ResumeUnavailableError);
  });

  it("resume() throws when a capture id cannot be resolved", async () => {
    const { manager } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", { resolveCaptureId: async () => null });
    const rec = { def: { cmd: "codex", kind: "agent" as const }, resume: { runtime: "codex" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await expect(manager.resume("codex", rec)).rejects.toThrow(ResumeUnavailableError);
  });

  it("resume() resumes qwen via --continue with no id (cwd-scoped, resumesWithoutId)", async () => {
    const { manager, cmds } = resumeHarness("agents:\n  qwen:\n    cmd: qwen\n");
    const rec = { def: { cmd: "qwen", kind: "agent" as const }, resume: { runtime: "qwen" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("qwen", rec);
    expect(cmds.at(-1)).toBe("qwen --continue");
  });

  // ── spec 225: session fork ──────────────────────────────────────────────
  const UUID = "abcdef01-2345-6789-abcd-ef0123456789";

  it("planFork: refuses a non-forkable runtime (codex has no native fork)", async () => {
    const { manager } = resumeHarness("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    await expect(manager.planFork("codex")).rejects.toThrow(/no native session fork/);
  });

  it("planFork: fail-closed when the live claude uuid can't be resolved (not forkable yet)", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => null });
    await manager.spawn("claude");
    await expect(manager.planFork("claude")).rejects.toThrow(/not forkable yet/);
  });

  it("planFork: resolves the live uuid and the unique sibling name", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    ledger.record("claude-fork-1", { def: { cmd: "claude", kind: "agent" }, cwd: "/x", declared: false }); // occupy -fork-1
    const plan = await manager.planFork("claude");
    expect(plan).toMatchObject({ source: "claude", forkName: "claude-fork-2", sourceId: UUID, runtime: "claude" });
  });

  it("commitFork (no worktree): spawns the fork-session combo and records a persistent sibling row", async () => {
    const { manager, ledger, cmds, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    const plan = await manager.planFork("claude");
    const forkName = await manager.commitFork(plan);
    expect(forkName).toBe("claude-fork-1");
    const forkSession = `tachyon-${path.basename(ws)}-claude-fork-1`;
    expect(cmds.at(-1)).toBe(`claude -n ${forkSession} --resume ${UUID} --fork-session`);
    expect(ledger.get("claude-fork-1")).toMatchObject({
      def: { cmd: "claude", kind: "agent", fork: true }, // base cmd → a later resume uses the normal named path, never re-forks
      resume: { runtime: "claude", sessionId: forkSession }, // the fork's OWN name (captured → uuid later)
      declared: false,
      cwd: ws, // no worktree → shares the source cwd (same project dir, context carries)
    });
    expect(ledger.get("claude-fork-1")?.def?.parent).toBeUndefined(); // sibling, NOT a lineage child
    const names = (await manager.list()).map((a) => a.name);
    expect(names).toContain("claude-fork-1");
  });

  it("commitFork injects the fork's own TACHYON_AGENT_NAME", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  claude:\n    cmd: claude\n    env:\n      TACHYON_AGENT_NAME: wrong\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    const plan = await manager.planFork("claude");
    newSessionArgs.length = 0;
    await manager.commitFork(plan);
    expect(newSessionArgs.at(-1)).toContain("TACHYON_AGENT_NAME=claude-fork-1");
    expect(newSessionArgs.at(-1)).not.toContain("TACHYON_AGENT_NAME=wrong");
  });

  it("commitFork: inherits + persists the source env so a model-swap survives the fork's restart/resume", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n    env:\n      ANTHROPIC_BASE_URL: https://api.glm.example\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    await manager.commitFork(await manager.planFork("claude"));
    // persisted on the fork's ledger def → rehydrate/restart/resume re-apply it (not just the first spawn)
    expect(ledger.get("claude-fork-1")?.def?.env).toEqual({ ANTHROPIC_BASE_URL: "https://api.glm.example" });
  });

  it("a forked sibling survives a Stop (persistent) and is dropped only on Dismiss", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    await manager.commitFork(await manager.planFork("claude"));
    await manager.kill("claude-fork-1");
    // Stop keeps the row + listing (unlike an ordinary ad-hoc, which would vanish).
    expect(ledger.get("claude-fork-1")?.def?.fork).toBe(true);
    expect((await manager.list()).map((a) => a.name)).toContain("claude-fork-1");
    manager.dismissAdhoc("claude-fork-1");
    expect(ledger.get("claude-fork-1")).toBeUndefined();
    expect((await manager.list()).map((a) => a.name)).not.toContain("claude-fork-1");
  });

  it("persists the spawn contract + skip reason on the ledger def and survives reload (spec 246 D8/D6)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", {});
    const contract = { task: "add retry to upload", context: "client.ts times out on flaky nets", constraints: "no new deps", deliverable: "a unit test proving backoff" };
    // the manager records opts.contract unconditionally (the Bridge owns the gate); a terminal cmd keeps adapters out of this test.
    await manager.spawn("helper", { cmd: "echo hi", parent: "main", contract });
    expect(ledger.get("helper")?.def?.contract).toEqual(contract);
    // reload: a fresh ledger over the same dir re-parses the persisted def (parseDef whitelist preserves it)
    expect(new SessionLedger(ws).get("helper")?.def?.contract).toEqual(contract);

    await manager.spawn("skipper", { cmd: "echo hi", parent: "main", contractSkipReason: "trivial throwaway probe" });
    expect(ledger.get("skipper")?.def?.contractSkipReason).toBe("trivial throwaway probe");
    expect(new SessionLedger(ws).get("skipper")?.def?.contractSkipReason).toBe("trivial throwaway probe");
  });

  it("delivers the brief into a launcher-wrapped AI child's spawn command (spec 246 codex #1)", async () => {
    const { manager, cmds } = resumeHarness("agents:\n  main:\n    cmd: claude\n", { newSessionId: () => "uuid" });
    await manager.spawn("child", { cmd: "npx claude", parent: "main", instructions: "TASK: do the thing" });
    // composeCommand now sees through `npx` (codex #1 fix), so the brief is appended, not dropped.
    expect(cmds.at(-1)).toContain("npx claude");
    expect(cmds.at(-1)).toMatch(/TASK: do the thing/);
  });

  it("kill of an ad-hoc agent deletes its durable activity log (pin p-4dadd3 dogfood follow-up: kill→remove path)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", {});
    await manager.spawn("oneshot", { cmd: "echo hi", parent: "main" }); // ad-hoc → gets a session + ledger row
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("oneshot")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    expect(fs.existsSync(logFile)).toBe(true);
    await manager.kill("oneshot"); // killSession leaves NO pane → the log would be an unreachable orphan
    expect(ledger.get("oneshot")).toBeUndefined(); // row removed (spec 211)
    expect(fs.existsSync(logFile)).toBe(false); // ...and the log dies with it (was orphaned before this fix)
  });

  it("dismissAdhoc deletes the agent's durable activity log (pin p-4dadd3 (a): log dies with the row)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    await manager.commitFork(await manager.planFork("claude")); // claude-fork-1 = an ad-hoc with a ledger row
    // Seed a durable activity log as the writer would have.
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("claude-fork-1")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    expect(fs.existsSync(logFile)).toBe(true);
    manager.dismissAdhoc("claude-fork-1");
    expect(ledger.get("claude-fork-1")).toBeUndefined();
    expect(fs.existsSync(logFile)).toBe(false); // gone with the row — no unreachable orphan
  });

  it("removeEphemeralFootprint routes through canonical forgetAgent cleanup, idempotently (spec 247)", async () => {
    const removedHomes: string[] = [];
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", { removeHarnessHome: (name) => removedHomes.push(name) });
    await manager.spawn("eph", { cmd: "echo hi", parent: "main" }); // ad-hoc → ledger row
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("eph")}.jsonl`);
    const stateFile = path.join(actDir, `${agentLogId("eph")}.state.json`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    fs.writeFileSync(stateFile, "{}", "utf8");
    fs.writeFileSync(sessionOwnersFile(ws), [
      JSON.stringify({ agent: "eph", sessionId: "s1", transcriptPath: "/p/eph.jsonl", cwd: ws, source: "startup", ts: "t1" }),
      JSON.stringify({ agent: "keep", sessionId: "s2", transcriptPath: "/p/keep.jsonl", cwd: ws, source: "startup", ts: "t2" }),
    ].join("\n") + "\n", "utf8");
    fs.mkdirSync(path.dirname(spawnSettingsPath(ws, "eph")), { recursive: true });
    fs.writeFileSync(spawnSettingsPath(ws, "eph"), "{}\n", "utf8");
    fs.writeFileSync(spawnSettingsPath(ws, "keep"), "{}\n", "utf8");
    expect(ledger.get("eph")).toBeDefined();
    manager.removeEphemeralFootprint("eph");
    expect(ledger.get("eph")).toBeUndefined(); // row gone (spec 211)
    expect(fs.existsSync(logFile)).toBe(false); // .jsonl gone (spec 239)
    expect(fs.existsSync(stateFile)).toBe(false); // .state.json sidecar gone too
    expect(readSessionOwners(sessionOwnersFile(ws)).map((r) => r.agent)).toEqual(["keep"]);
    expect(fs.existsSync(spawnSettingsPath(ws, "eph"))).toBe(false);
    expect(fs.existsSync(spawnSettingsPath(ws, "keep"))).toBe(true);
    expect(removedHomes).toEqual(["eph"]);
    // idempotent: re-calling, or calling for a name that never existed, must not throw (legitimizes the
    // dismissNode→kill double-call where kill already removed the footprint).
    expect(() => manager.removeEphemeralFootprint("eph")).not.toThrow();
    expect(() => manager.removeEphemeralFootprint("never-existed")).not.toThrow();
  });

  it("canonical forgetAgent removes a populated private harness home recursively", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-forget-"));
    dirs.push(ws);
    const name = "codex-populated";
    const home = harnessHome(ws, name);
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), "model = \"gpt-5\"\n", "utf8");
    fs.writeFileSync(path.join(home, "sessions", "session.jsonl"), "{}\n", "utf8");

    expect(() => forgetAgent(name, {
      workspaceRoot: ws,
      removeHarnessHome: (agent) => new HarnessManager(ws).remove(agent),
    })).not.toThrow();
    expect(fs.existsSync(home)).toBe(false);
  });

  it("canonical forgetAgent footprint list names every per-agent removal surface", () => {
    expect(FORGET_AGENT_FOOTPRINTS).toEqual([
      "tachyon.yml entry (removed by the declared-removal caller before durable cleanup)",
      "activity log and writer state",
      "session-owner ledger rows",
      "private harness/config home",
      "per-spawn settings file",
      "session ledger row",
    ]);
  });

  it("kill of a DECLARED agent KEEPS its durable log (spec 247: footprint removal is ephemeral-only)", async () => {
    const { manager, ws } = resumeHarness("agents:\n  worker:\n    cmd: claude\n", {});
    await manager.spawn("worker"); // declared → NOT in the adhoc map → kill's wasAdhoc is false
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("worker")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    await manager.kill("worker"); // a stop, not a delete
    expect(fs.existsSync(logFile)).toBe(true); // a declared agent is resumable later → its log must survive
  });

  it("commitFork (worktree source): makes its own worktree + seeds the transcript into the fork cwd", async () => {
    const seeded: Array<{ from: string; to: string }> = [];
    const forkCwd = "/wt/claude-fork-1";
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      homeDir: () => "/home/u",
      createForkWorktree: async (forkName) => ({ cwd: forkCwd, worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "tachyon/claude", createdAt: "t" } }),
      seedTranscript: (from, to) => {
        seeded.push({ from, to });
        return true;
      },
    });
    await manager.spawn("claude");
    // give the source a worktree so the fork branches off it
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    await manager.commitFork(await manager.planFork("claude"));
    // transcript seeded from the SOURCE cwd's project dir into the FORK cwd's project dir (claude --resume is cwd-scoped)
    expect(seeded).toHaveLength(1);
    expect(seeded[0].from).toContain(`${UUID}.jsonl`);
    expect(seeded[0].from).toContain(ws.replace(/[/.]/g, "-"));
    expect(seeded[0].to).toContain(forkCwd.replace(/[/.]/g, "-"));
    expect(ledger.get("claude-fork-1")?.worktree?.path).toBe(forkCwd);
    expect(ledger.get("claude-fork-1")?.cwd).toBe(forkCwd);
  });

  it("commitFork (worktree source): fails closed + rolls back the worktree when the transcript can't be seeded", async () => {
    const forkCwd = "/wt/claude-fork-1";
    const removed: string[] = [];
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      createForkWorktree: async (forkName) => ({ cwd: forkCwd, worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } }),
      seedTranscript: () => false, // copy didn't land → claude --resume would find nothing
      removeForkWorktree: async (wt) => void removed.push(wt.path),
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    await expect(manager.commitFork(await manager.planFork("claude"))).rejects.toThrow(/couldn't seed/);
    expect(removed).toEqual([forkCwd]); // orphan worktree rolled back
    expect(ledger.get("claude-fork-1")).toBeUndefined(); // no leaked sibling row
  });

  it("planFork: refuses a stopped source (fork captures a live session)", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID, fileExists: () => true });
    await manager.spawn("claude");
    await manager.kill("claude"); // declared → ledger row persists, but no live session
    await expect(manager.planFork("claude")).rejects.toThrow(/isn't running/);
  });

  it("planFork: refuses a self-managing claude cmd (--resume) — nothing to fork", async () => {
    const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude --resume evals\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    await expect(manager.planFork("claude")).rejects.toThrow(/manages its own session|no tracked session/);
  });

  it("commitFork (worktree source): fails closed when the fork worktree can't be created", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      createForkWorktree: async () => null, // git unavailable / branch conflict
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    await expect(manager.commitFork(await manager.planFork("claude"))).rejects.toThrow(ForkUnavailableError);
  });

  it("resume() re-applies the declared agent's env (F1: model-swap survives resume)", async () => {
    const { manager, newSessionArgs } = resumeHarness(
      "agents:\n  worker:\n    cmd: claude\n    env:\n      ANTHROPIC_BASE_URL: https://api.deepseek.com/anthropic\n",
      { newSessionId: () => "u9" },
    );
    await manager.spawn("worker");
    await manager.kill("worker");
    newSessionArgs.length = 0; // only inspect the resume's new-session
    await manager.resume("worker", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u9" }, cwd: "/ws", declared: true, updatedAt: "t" });
    const args = newSessionArgs.at(-1)!;
    expect(args).toContain("ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic");
  });

  // spec 226 — isolated-harness pipeline (H2/H3) + fork-block. A stub materializeHarness exercises
  // the shared wiring; the real fs materialization is covered in harness.test.ts.
  const HARNESS_YML = "agents:\n  researcher:\n    cmd: claude\n    harness:\n      mcp:\n        s:\n          command: x\n";
  const CODEX_HARNESS_YML = "agents:\n  coder:\n    cmd: codex\n    harness:\n      mcp:\n        s:\n          command: x\n";
  const stubHarness = () => ({
    materializeHarness: ({ name }: { name: string }) => ({
      home: `/h/${name}`,
      env: { CLAUDE_CONFIG_DIR: `/h/${name}` },
      args: ["--mcp-config", `/h/${name}/mcp.json`, "--strict-mcp-config"],
    }),
  });
  const stubCodexHarness = () => ({
    materializeHarness: ({ name }: { name: string }) => ({
      home: `/h/${name}`,
      env: { CODEX_HOME: `/h/${name}` },
      args: [],
    }),
  });

  it("H3: spawn of a harness agent appends --strict-mcp-config + CLAUDE_CONFIG_DIR env", async () => {
    const { manager, cmds, newSessionArgs } = resumeHarness(HARNESS_YML, stubHarness());
    await manager.spawn("researcher");
    expect(cmds.at(-1)).toContain("--mcp-config");
    expect(cmds.at(-1)).toContain("--strict-mcp-config");
    expect(newSessionArgs.at(-1)).toContain("CLAUDE_CONFIG_DIR=/h/researcher");
  });

  it("H3: a non-harness agent gets NO harness args (no mechanism leak)", async () => {
    const { manager, cmds } = resumeHarness("agents:\n  plain:\n    cmd: claude\n", stubHarness());
    await manager.spawn("plain");
    expect(cmds.at(-1)).not.toContain("--strict-mcp-config");
  });

  it("spec 298: spawn of a codex harness agent sets CODEX_HOME and appends no MCP flags", async () => {
    const { manager, cmds, newSessionArgs } = resumeHarness(CODEX_HARNESS_YML, stubCodexHarness());
    await manager.spawn("coder");
    expect(cmds.at(-1)).not.toContain("--mcp-config");
    expect(cmds.at(-1)).not.toContain("--strict-mcp-config");
    expect(newSessionArgs.at(-1)).toContain("CODEX_HOME=/h/coder");
  });

  it("spec 357: a default codex agent gets a private CODEX_HOME and persisted configHome", async () => {
    const { manager, ledger, newSessionArgs, ws } = resumeHarness("agents:\n  coder:\n    cmd: codex\n", {
      materializeHarness: ({ name }: { name: string }) => ({
        home: harnessHome(ws, name),
        env: { CODEX_HOME: harnessHome(ws, name) },
        args: [],
      }),
    });
    await manager.spawn("coder");
    expect(newSessionArgs.at(-1)).toContain(`CODEX_HOME=${harnessHome(ws, "coder")}`);
    expect(ledger.get("coder")?.resume?.configHome).toBe(harnessHome(ws, "coder"));
  });

  it("spec 357: same-cwd codex agents use distinct private homes", async () => {
    const { manager, ledger, newSessionArgs, ws } = resumeHarness("agents:\n  coder-a:\n    cmd: codex\n  coder-b:\n    cmd: codex\n", {
      materializeHarness: ({ name }: { name: string }) => ({
        home: harnessHome(ws, name),
        env: { CODEX_HOME: harnessHome(ws, name) },
        args: [],
      }),
    });
    await manager.spawn("coder-a");
    await manager.spawn("coder-b");
    expect(newSessionArgs.some((args) => args.includes(`CODEX_HOME=${harnessHome(ws, "coder-a")}`))).toBe(true);
    expect(newSessionArgs.some((args) => args.includes(`CODEX_HOME=${harnessHome(ws, "coder-b")}`))).toBe(true);
    expect(ledger.get("coder-a")?.cwd).toBe(ledger.get("coder-b")?.cwd);
    expect(ledger.get("coder-a")?.resume?.configHome).toBe(harnessHome(ws, "coder-a"));
    expect(ledger.get("coder-b")?.resume?.configHome).toBe(harnessHome(ws, "coder-b"));
  });

  it("spec 358: normal delegation fails closed when runtime isolation is unverified", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n");
    await expect(manager.spawn("reviewer", { cmd: "gemini", parent: "boss" })).rejects.toThrow(/runtime transcript isolation is not verified/);
    expect(newSessionArgs).toEqual([]);
  });

  it("spec 358: project-scoped opencode delegation fails without an isolated worktree", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n");
    await expect(manager.spawn("reviewer", { cmd: "opencode", parent: "boss" })).rejects.toThrow(/requires an isolated worktree for this spawn/);
    expect(newSessionArgs).toEqual([]);
  });

  it("spec 358: project-scoped opencode delegation passes with an isolated worktree", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC }),
    });
    await manager.spawn("reviewer", { cmd: "opencode", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
    expect(newSessionArgs[0][newSessionArgs[0].indexOf("-c") + 1]).toBe(REC.path);
  });

  it("spec 357: removal deletes the private runtime home with the other ephemeral state", () => {
    const removed: string[] = [];
    const { manager } = resumeHarness("agents:\n  coder:\n    cmd: codex\n", { removeHarnessHome: (name) => removed.push(name) });
    manager.removeEphemeralFootprint("coder");
    expect(removed).toEqual(["coder"]);
  });

  it("H3: resume of a harness agent re-applies the harness wiring", async () => {
    const { manager, cmds, newSessionArgs } = resumeHarness(HARNESS_YML, {
      ...stubHarness(),
      fileExists: () => true,
    });
    await manager.spawn("researcher");
    newSessionArgs.length = 0;
    await manager.resume("researcher", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", declared: true, updatedAt: "t" });
    expect(cmds.at(-1)).toContain("--strict-mcp-config");
    expect(newSessionArgs.at(-1)).toContain("CLAUDE_CONFIG_DIR=/h/researcher");
  });

  it("H2: resume scopes the session resolver + transcript check to the harness config home", async () => {
    const seen: { configHome?: string } = {};
    const fileExistsPaths: string[] = [];
    const { manager, ws } = resumeHarness(HARNESS_YML, {
      ...stubHarness(),
      resolveCurrentSessionFull: async (_rt, _cwd, _title, configHome) => {
        seen.configHome = configHome;
        return "u-uuid-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      },
      fileExists: (p) => {
        fileExistsPaths.push(p);
        return true;
      },
    });
    await manager.spawn("researcher");
    // a non-uuid stored id (a name) forces the by-title resolver to run
    await manager.resume("researcher", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "tachyon-ws-researcher" }, cwd: "/ws", declared: true, updatedAt: "t" });
    const expectedHome = harnessHome(ws, "researcher");
    expect(seen.configHome).toBe(expectedHome);
    // the transcript-exists probe used the redirected home (H2), not ~/.claude
    expect(fileExistsPaths.some((p) => p.startsWith(`${expectedHome}/projects/`))).toBe(true);
  });

  it("v1: forking an isolated-harness agent is refused (fail-closed)", async () => {
    const { manager } = resumeHarness(HARNESS_YML, stubHarness());
    await manager.spawn("researcher");
    await expect(manager.planFork("researcher")).rejects.toThrow("isolated-harness agent isn't supported yet");
  });

  it("v1: renaming an isolated-harness agent is refused (fail-closed — home is name-keyed)", async () => {
    const { manager } = resumeHarness(HARNESS_YML, stubHarness());
    await manager.spawn("researcher");
    await expect(manager.rename("researcher", "researcher2")).rejects.toThrow("isolated-harness agent isn't supported yet");
  });

  // spec 236 — the Bridge reaches EVERY Tachyon-spawned agent via withRuntimeBridge (one shared step).
  describe("spec 236 — deterministic Bridge injection", () => {
    const BRIDGE = () => ({
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp", TACHYON_BRIDGE_TOKEN: "tok" }),
      materializeBridgeMcp: (name: string) => `/ws/.tachyon/bridge-mcp/${name}.json`,
    });

    it("codex (non-pipeline): spawn injects the -c Bridge override", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", BRIDGE());
      await manager.spawn("codex");
      expect(cmds.at(-1)).toContain('mcp_servers.tachyon_bridge={url="http://127.0.0.1:9/mcp"');
      expect(cmds.at(-1)).toContain('bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"');
      expect(cmds.at(-1)).not.toMatch(/Bearer\s/); // no literal token on argv
    });

    it("claude (non-harness): spawn appends --mcp-config at the END (additive, after the prompt positional)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", BRIDGE());
      await manager.spawn("claude");
      expect(cmds.at(-1)!.endsWith("--mcp-config '/ws/.tachyon/bridge-mcp/claude.json'")).toBe(true);
      expect(cmds.at(-1)).not.toContain("--strict-mcp-config"); // additive, not isolating
    });

    it("claude harness: NO --mcp-config append (Bridge is folded into the materialized --strict file)", async () => {
      const { manager, cmds } = resumeHarness(HARNESS_YML, { ...stubHarness(), ...BRIDGE() });
      await manager.spawn("researcher");
      expect(cmds.at(-1)).not.toContain("bridge-mcp"); // not the non-harness file
      expect(cmds.at(-1)).toContain("--strict-mcp-config"); // only the harness wiring
    });

    it("codex harness: NO -c Bridge override (Bridge is folded into the private config.toml)", async () => {
      const { manager, cmds } = resumeHarness(CODEX_HARNESS_YML, { ...stubCodexHarness(), ...BRIDGE() });
      await manager.spawn("coder");
      expect(cmds.at(-1)).not.toContain("mcp_servers.tachyon_bridge=");
      expect(cmds.at(-1)).not.toContain("--mcp-config");
    });

    it("Bridge down (no URL): no injection (self-heals on next restart)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { materializeBridgeMcp: () => undefined });
      await manager.spawn("claude");
      expect(cmds.at(-1)).not.toContain("--mcp-config");
    });

    it("resume re-injects the Bridge (the BLOCKER fix — resume rebuilds the command)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { ...BRIDGE(), fileExists: () => true });
      await manager.spawn("claude");
      cmds.length = 0;
      await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", declared: true, updatedAt: "t" });
      expect(cmds.at(-1)).toContain("--mcp-config '/ws/.tachyon/bridge-mcp/claude.json'");
    });

    it("fork: a forked claude agent also gets the Bridge injected (it's Tachyon-spawned too)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { ...BRIDGE(), resolveCurrentSession: async () => UUID });
      await manager.spawn("claude");
      const plan = await manager.planFork("claude");
      await manager.commitFork(plan);
      expect(cmds.at(-1)).toContain("--fork-session");
      expect(cmds.at(-1)!.endsWith("--mcp-config '/ws/.tachyon/bridge-mcp/claude-fork-1.json'")).toBe(true);
    });

    it("warns when the user command already sets --strict-mcp-config (additive promise void)", async () => {
      const warns: string[] = [];
      const { manager } = resumeHarness("agents:\n  claude:\n    cmd: claude --strict-mcp-config\n", {
        ...BRIDGE(),
        notify: (m) => warns.push(m),
      });
      await manager.spawn("claude");
      expect(warns.some((w) => w.includes("--strict-mcp-config"))).toBe(true);
    });

    // spec 236 — opencode (non-harness): spawn sets OPENCODE_CONFIG env (no argv change), pointing at
    // the materialized Bridge-only opencode config file. The Bridge entry's bearer token stays a
    // `{env:TACHYON_AGENT_BRIDGE_TOKEN}` ref (opencode resolves {env:VAR} at runtime) so a per-agent
    // token minted into the session env resolves with no secret on disk or argv.
    const OPENCODE_BRIDGE = (calls?: Array<{ name: string; cwd: string }>) => ({
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp", TACHYON_BRIDGE_TOKEN: "tok" }),
      materializeBridgeMcpOpencode: (name: string, cwd: string) => {
        calls?.push({ name, cwd });
        return `/ws/.tachyon/bridge-mcp/${name}.opencode.json`;
      },
    });

    it("opencode (non-harness): spawn injects OPENCODE_CONFIG=<bridge file> env (no argv change)", async () => {
      const calls: Array<{ name: string; cwd: string }> = [];
      const { manager, cmds, newSessionArgs } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", OPENCODE_BRIDGE(calls));
      await manager.spawn("opencode");
      // cmd is unchanged (opencode has no --mcp-config / -c flags here)
      expect(cmds.at(-1)).toBe("opencode");
      // OPENCODE_CONFIG points at the materialized file
      expect(newSessionArgs.at(-1)!.some((a) => a === "-e")).toBe(true);
      const envPairs = newSessionArgs.at(-1)!.filter((a) => a.startsWith("OPENCODE_CONFIG="));
      expect(envPairs).toHaveLength(1);
      expect(envPairs[0]).toBe("OPENCODE_CONFIG=/ws/.tachyon/bridge-mcp/opencode.opencode.json");
      // the materializer was called with the agent's spawn cwd (the workspace root in the harness)
      expect(calls).toEqual([{ name: "opencode", cwd: expect.any(String) }]);
    });

    it("opencode (non-harness): resume re-injects OPENCODE_CONFIG (rebuilds the env)", async () => {
      const { manager, newSessionArgs } = resumeHarness(
        "agents:\n  opencode:\n    cmd: opencode\n",
        { ...OPENCODE_BRIDGE(), fileExists: () => true },
      );
      await manager.spawn("opencode");
      const spawnArgs = newSessionArgs.at(-1)!;
      newSessionArgs.length = 0;
      await manager.resume("opencode", {
        def: { cmd: "opencode", kind: "agent" },
        resume: { runtime: "opencode", sessionId: "ses_x" },
        cwd: "/ws",
        declared: false,
        updatedAt: "t",
      });
      expect(newSessionArgs.at(-1)!.filter((a) => a.startsWith("OPENCODE_CONFIG="))).toEqual(spawnArgs.filter((a) => a.startsWith("OPENCODE_CONFIG=")));
    });

    it("opencode: no OPENCODE_CONFIG when the Bridge is down (self-heals on next restart)", async () => {
      const { manager, newSessionArgs } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", {
        materializeBridgeMcpOpencode: () => undefined,
      });
      await manager.spawn("opencode");
      expect(newSessionArgs.at(-1)!.some((a) => a.startsWith("OPENCODE_CONFIG="))).toBe(false);
    });
  });

  describe("spec 243 — per-spawn --settings session-ownership hook", () => {
    const OWN = (calls?: Array<{ name: string; ownershipOnly: boolean }>) => ({
      materializeOwnershipSettings: (name: string, opts?: { ownershipOnly?: boolean }) => {
        calls?.push({ name, ownershipOnly: !!opts?.ownershipOnly });
        return `/ws/.tachyon/spawn-settings/${name}.json`;
      },
    });

    it("claude (non-harness): spawn appends --settings <per-spawn file>", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", OWN());
      await manager.spawn("claude");
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/claude.json'");
      expect(cmds.at(-1)).not.toContain("--allowedTools");
    });

    it("resume re-injects the ownership --settings (rebuilds the command, like the Bridge)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { ...OWN(), fileExists: () => true });
      await manager.spawn("claude");
      cmds.length = 0;
      await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", declared: true, updatedAt: "t" });
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/claude.json'");
      expect(cmds.at(-1)).not.toContain("--allowedTools");
    });

    it("codex: injects a session-scoped SessionStart hook via -c, not --settings", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", { materializeCodexSessionStartHookConfig: () => "hooks.SessionStart=[{hooks=[]}]" });
      await manager.spawn("codex");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).not.toContain("--settings");
    });

    it("codex ad-hoc: injects ownership-only SessionStart and bypasses hook trust for Tachyon's invocation", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const mats: Array<{ name: string; isolate?: string }> = [];
      const { manager, ledger, cmds, newSessionArgs, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        materializeHarness: ({ name, def }: { name: string; def: { isolate?: string } }) => {
          mats.push({ name, isolate: def.isolate });
          return { env: { CODEX_HOME: harnessHome(ws, name) }, args: [] };
        },
        materializeCodexSessionStartHookConfig: (name, opts?: { ownershipOnly?: boolean }) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("reviewer", { cmd: "codex", parent: "claude" });
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(newSessionArgs.at(-1)).toContain(`CODEX_HOME=${harnessHome(ws, "reviewer")}`);
      expect(ledger.get("reviewer")?.resume?.configHome).toBe(harnessHome(ws, "reviewer"));
      expect(mats).toEqual([{ name: "reviewer", isolate: "transcript" }]);
      expect(calls).toEqual([{ name: "reviewer", ownershipOnly: true }]);
    });

    it("codex ad-hoc: a user -c config flag is not mistaken for self-managed session state", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        materializeCodexSessionStartHookConfig: (name, opts?: { ownershipOnly?: boolean }) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("reviewer", { cmd: "codex -c model='gpt-5.1-codex'", parent: "claude" });
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(cmds.at(-1)).toContain("-c model='gpt-5.1-codex'");
      expect(calls).toEqual([{ name: "reviewer", ownershipOnly: true }]);
    });

    it("claude ad-hoc: injects ownership-only settings by the same runtime-neutral convention", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const mats: Array<{ name: string; isolate?: string }> = [];
      const { manager, ledger, cmds, newSessionArgs, ws } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        ...OWN(calls),
        materializeHarness: ({ name, def }: { name: string; def: { isolate?: string } }) => {
          mats.push({ name, isolate: def.isolate });
          return { env: { CLAUDE_CONFIG_DIR: harnessHome(ws, name) }, args: [] };
        },
      });
      await manager.spawn("reviewer", { cmd: "claude", parent: "boss" });
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/reviewer.json'");
      expect(cmds.at(-1)).toContain("--permission-mode auto");
      expect(cmds.at(-1)).not.toContain("--allowedTools");
      expect(newSessionArgs.at(-1)).toContain(`CLAUDE_CONFIG_DIR=${harnessHome(ws, "reviewer")}`);
      expect(ledger.get("reviewer")?.resume?.configHome).toBe(harnessHome(ws, "reviewer"));
      expect(mats).toEqual([{ name: "reviewer", isolate: "transcript" }]);
      expect(calls).toEqual([{ name: "reviewer", ownershipOnly: true }]);
    });

    it("claude ad-hoc: does not override an explicit permission mode", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", OWN());
      await manager.spawn("reviewer", { cmd: "claude --permission-mode manual", parent: "boss" });
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/reviewer.json'");
      expect(cmds.at(-1)).toContain("--permission-mode manual");
      expect(cmds.at(-1)).not.toContain("--permission-mode auto");
    });

    it("t-4e286c: claude ad-hoc with bypassPermissions is born with Tachyon settings and no auto downgrade", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", OWN());
      await manager.spawn("reviewer", { cmd: "claude --permission-mode bypassPermissions", parent: "boss" });
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/reviewer.json'");
      expect(cmds.at(-1)).toContain("--permission-mode bypassPermissions");
      expect(cmds.at(-1)).not.toContain("--permission-mode auto");
    });

    it("codex: no materializer wired leaves command unchanged", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", OWN());
      await manager.spawn("codex");
      expect(cmds.at(-1)).toBe("codex");
    });

    it("self-managed claude (--resume ...): left untouched, NO ownership injection", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --resume evals\n", OWN());
      await manager.spawn("claude");
      expect(cmds.at(-1)).toBe("claude --resume evals");
    });

    it("user command already sets --settings: skipped + advisory", async () => {
      const warns: string[] = [];
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --settings ./mine.json\n", { ...OWN(), notify: (m) => warns.push(m) });
      await manager.spawn("claude");
      expect(cmds.at(-1)).toContain("claude --settings ./mine.json"); // the user's --settings is preserved
      expect(cmds.at(-1)).not.toContain("spawn-settings"); // our ownership --settings file is NOT appended
      expect(warns.some((w) => w.includes("--settings"))).toBe(true);
    });

    it("no materializer wired: no injection (degrades safely)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n");
      await manager.spawn("claude");
      expect(cmds.at(-1)).not.toContain("--settings");
    });
  });
});

describe("AgentManager — restart terminal lifecycle (bug: first restart only closes)", () => {
  it("fires onRestart (close) BEFORE onSpawned (reopen) so the editor terminal is recreated", async () => {
    const { tmux } = fakeTmux();
    const events: string[] = [];
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      getMaxAgents: () => 8,
      onSpawned: () => events.push("open"),
      onRestart: () => events.push("close"),
    });
    await manager.spawn("a");
    expect(events).toEqual(["open"]); // initial spawn opens
    events.length = 0;
    await manager.restart("a");
    expect(events).toEqual(["close", "open"]); // restart: close old terminal, then reopen fresh
  });
});

describe("live rename (agent/terminal, running or not)", () => {
  it("renames a LIVE session in place and the new name answers", async () => {
    const { manager, sessions } = makeManager("agents:\n  claude:\n    cmd: claude\n  pilot:\n    cmd: x\n");
    await manager.spawn("claude");
    await manager.rename("claude", "ace");
    expect(sessions.has(`tachyon-${HASH}-ace`)).toBe(true);
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(false);
  });

  it("renames a crashed session too — the dead pane (exit code) rides along", async () => {
    const { manager, sessions, dead } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    dead.set(`tachyon-${HASH}-claude`, 7);
    await manager.rename("claude", "ace");
    expect(dead.get(`tachyon-${HASH}-ace`)).toBe(7);
    expect(sessions.has(`tachyon-${HASH}-ace`)).toBe(true);
  });

  it("children pointing at the renamed parent follow (lineage)", async () => {
    const { manager } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    await manager.spawn("worker", { cmd: "sh", parent: "claude" });
    await manager.rename("claude", "ace");
    const worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("ace");
  });

  it("an ad-hoc agent keeps its definition across rename (restart still works)", async () => {
    const { manager, sessions } = makeManager("agents:\n  decoy:\n    cmd: x\n");
    await manager.spawn("ghost", { cmd: "echo hi" });
    await manager.rename("ghost", "spirit");
    await manager.restart("spirit"); // needs the moved ad-hoc definition
    expect(sessions.has(`tachyon-${HASH}-spirit`)).toBe(true);
  });

  it("moves the resume-ledger record to the new name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-rename-"));
    try {
      const ledger = new SessionLedger(dir);
      ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "abc" }, cwd: dir, declared: true });
      const { tmux } = fakeTmux();
      const manager = new AgentManager({
        tmux,
        wsHash: HASH,
        workspaceRoot: dir,
        getConfig: () => configOf("agents:\n  claude:\n    cmd: claude\n"),
        getMaxAgents: () => 8,
        ledger,
      });
      await manager.rename("claude", "ace");
      expect(ledger.get("ace")?.resume?.sessionId).toBe("abc");
      expect(ledger.get("claude")).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to rename onto an existing agent", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n");
    await expect(manager.rename("a", "b")).rejects.toThrow(/already exists/);
  });
});

describe("AgentManager — ad-hoc persistence (spec 211)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function harness(yaml: string, extra: Partial<ConstructorParameters<typeof AgentManager>[0]> = {}) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-211-"));
    const ledger = new SessionLedger(ws);
    const sessions = new Set<string>();
    const cmds: string[] = [];
    const newSessionArgs: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]); cmds.push(args[args.length - 1]); newSessionArgs.push(args); return { stdout: "", stderr: "" }; }
      switch (args[2]) {
        case "has-session": if (!sessions.has(target())) throw new Error("none"); return { stdout: "", stderr: "" };
        case "kill-session": sessions.delete(target()); return { stdout: "", stderr: "" };
        case "list-panes": return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
        case "list-sessions": if (!sessions.size) throw new Error("no server"); return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
        default: return { stdout: "", stderr: "" };
      }
    };
    const manager = new AgentManager({ tmux: new TmuxService(exec), wsHash: workspaceHash(ws), workspaceRoot: ws, getConfig: () => configOf(yaml), getMaxAgents: () => 8, ledger, ...extra });
    dirs.push(ws);
    return { manager, ledger, sessions, cmds, newSessionArgs, ws };
  }

  it("stale declared ledger parents are ignored so declared agents stay top-level", async () => {
    const { manager, ledger, ws } = harness("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: claude\n");
    await manager.spawn("child"); // running, but spawned WITHOUT parent → no in-memory lineage link
    const sessionsPath = ledger.path;
    fs.writeFileSync(
      sessionsPath,
      `${JSON.stringify({ sessions: { child: { def: { cmd: "claude", kind: "agent", parent: "boss" }, cwd: ws, declared: true, updatedAt: "t" } } }, null, 2)}\n`,
      "utf8",
    );
    manager.rehydrateFromLedger();
    const child = (await manager.list()).find((a) => a.name === "child");
    expect(child?.parent).toBeUndefined();
    expect(manager.parentOf("child")).toBeUndefined();
    expect(ledger.get("child")?.def?.parent).toBeUndefined();
    expect(await manager.liveDescendants("boss")).toEqual([]);
  });

  it("spec 352 — rehydrate keeps declared ownership out of runtime lineage", async () => {
    const { manager, ledger, ws } = harness("agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  codex:\n    cmd: codex\n  reviewer:\n    cmd: claude\n");
    await manager.spawn("reviewer"); // running, but no runtime parent
    ledger.record("reviewer", { def: { cmd: "claude", kind: "agent", parent: "codex" }, cwd: ws, declared: true });
    manager.rehydrateFromLedger();
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.declaredOwner).toBe("claude");
    expect(reviewer?.parent).toBeUndefined();
    expect(await manager.liveDescendants("claude")).toEqual([]);
    expect(await manager.liveDescendants("codex")).toEqual([]);
  });

  it("does not record a parent for a declared NON-adapter agent", async () => {
    const { manager, ledger } = harness("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: sh\n");
    await manager.spawn("child", { parent: "boss" });
    expect(ledger.get("child")?.def?.parent).toBeUndefined();
  });

  it("rehydrate restores worktree:true so restart's resolver reuses the worktree (review fix)", async () => {
    const REC = { path: "/wt/h/w", branch: "tachyon/w", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let seenWorktree: boolean | undefined;
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n", {
      resolveSpawnCwd: async (ctx) => {
        seenWorktree = ctx.def.worktree;
        return null;
      },
    });
    ledger.record("w", { def: { cmd: "claude", kind: "agent" }, worktree: REC, cwd: REC.path, declared: false });
    manager.rehydrateFromLedger();
    void ws;
    await manager.restart("w");
    expect(seenWorktree).toBe(true);
  });

  it("records the worktree for a declared NON-adapter agent (fix: was gated on adhoc||adapter)", async () => {
    const REC = { path: "/wt/h/dev", branch: "tachyon/dev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const { manager, ledger } = harness("agents:\n  dev:\n    cmd: sh\n    kind: terminal\n", {
      resolveSpawnCwd: async () => ({ cwd: "/wt/h/dev", worktree: REC }),
    });
    await manager.spawn("dev"); // 'sh' has no resume adapter
    expect(ledger.get("dev")?.worktree).toEqual(REC); // still persisted because it has a worktree
  });

  it("liveDescendants lists running transitive children, then prunes a killed subtree (spec 210 guard)", async () => {
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n");
    await manager.spawn("boss");
    await manager.spawn("helper", { cmd: "claude", parent: "boss" });
    await manager.spawn("sub", { cmd: "claude", parent: "helper" });
    expect((await manager.liveDescendants("boss")).sort()).toEqual(["helper", "sub"]);
    await manager.kill("sub");
    expect(await manager.liveDescendants("boss")).toEqual(["helper"]);
  });

  it("spawn routes cwd through resolveSpawnCwd and persists the worktree record (spec 210)", async () => {
    const REC = { path: "/wt/h/rev", branch: "tachyon/rev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const { manager, ledger, newSessionArgs } = harness("agents:\n  rev:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: "/wt/h/rev", worktree: REC }),
    });
    await manager.spawn("rev");
    const args = newSessionArgs[0];
    expect(args[args.indexOf("-c") + 1]).toBe("/wt/h/rev"); // born in the worktree
    expect(ledger.get("rev")?.worktree).toEqual(REC); // persisted for cleanup/C2
  });

  it("spawn keeps the default cwd when resolveSpawnCwd returns null", async () => {
    const { manager, ledger, newSessionArgs, ws } = harness("agents:\n  rev:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => null,
    });
    await manager.spawn("rev");
    const args = newSessionArgs[0];
    expect(args[args.indexOf("-c") + 1]).toBe(ws); // workspace root
    expect(ledger.get("rev")?.worktree).toBeUndefined();
  });

  it("gated spawn fails closed when no worktree is available (spec 362 T1)", async () => {
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => null,
    });
    await expect(
      manager.spawn("reviewer", {
        cmd: "claude",
        parent: "boss",
        contract: { task: "add login retry", context: "auth flow flakes", constraints: "no new deps", doneWhen: "retry behavior test passes" },
        gate: { behaviorTest: "login retry fails then passes" },
      }),
    ).rejects.toThrow(/gated delegation requires an isolated worktree/);
  });

  it("gated spawn records the DelegationRecord with baseSha and task ref (spec 362 T1)", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "old-delegation-base", createdAt: "t" };
    const { manager, ws } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async (ctx) => {
        expect(ctx.gate?.behaviorTest).toBe("login retry fails then passes");
        return { cwd: REC.path, worktree: REC, delegationBaseSha: "fresh-source-head" };
      },
      recordDelegation: ({ name, delegator, gate, contract, worktree, baseSha }) => {
        writeDelegationRecord(
          ws,
          delegationRecordFromSpawn({
            agent: name,
            delegator,
            baseSha,
            taskRef: worktree.branch,
            gate,
            contract,
            createdAt: "2026-07-07T12:00:00.000Z",
          }),
        );
      },
    });
    await manager.spawn("reviewer", {
      cmd: "claude",
      parent: "boss",
      delegator: "boss",
      contract: { task: "add login retry", context: "auth flow flakes", constraints: "no new deps", doneWhen: "retry behavior test passes" },
      gate: { behaviorTest: "login retry fails then passes", owns: ["src/auth.ts"] },
    });
    const record = readDelegationRecord(path.join(ws, ".tachyon", "delegations", "reviewer-2026-07-07T12-00-00-000Z.json"));
    expect(record).toMatchObject({
      agent: "reviewer",
      delegator: "boss",
      baseSha: "fresh-source-head",
      taskRef: "tachyon/reviewer",
      owns: ["src/auth.ts"],
      behaviorTest: "login retry fails then passes",
      contract: { task: "add login retry", doneWhen: "retry behavior test passes" },
    });
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.parent).toBeUndefined();
    expect(reviewer?.delegator).toBe("boss");
  });

  it("rehydrates a re-discovered ad-hoc agent so it is restartable + re-nested", async () => {
    const { manager, ledger, ws, cmds } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("worker", { def: { cmd: "sh", kind: "terminal", parent: "claude" }, cwd: ws, declared: false });
    manager.rehydrateFromLedger();
    const worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("claude"); // lineage restored
    await manager.restart("worker"); // would throw "no stored definition" without rehydrate
    expect(cmds.at(-1)).toBe("sh");
  });

  it("does NOT rehydrate a name that is declared in config (no ad-hoc shadow)", async () => {
    const { manager, ledger, ws } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", { def: { cmd: "sh", kind: "terminal" }, cwd: ws, declared: false }); // stale/odd
    manager.rehydrateFromLedger();
    const claude = (await manager.list()).find((a) => a.name === "claude");
    expect(claude?.declared).toBe(true); // config wins, not the ledger shadow
  });

  it("kill removes an ad-hoc agent's ledger row (no resurrection); keeps a declared one's", async () => {
    const { manager, ledger } = harness("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("scratch", { cmd: "claude" }); // ad-hoc → recorded
    expect(ledger.get("scratch")).toBeDefined();
    await manager.kill("scratch");
    expect(ledger.get("scratch")).toBeUndefined();

    await manager.spawn("claude"); // declared → recorded for resume
    await manager.kill("claude");
    expect(ledger.get("claude")).toBeDefined(); // declared agents stay resumable
  });

  it("graceful stop is idempotent while stopping and marks the row transiently", async () => {
    const { manager, sentKeys } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    await manager.stopGracefully("a");
    await manager.stopGracefully("a");
    expect(sentKeys).toEqual([{ session: `tachyon-${HASH}-a`, key: "C-d" }]);
    expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({ running: true, stopping: true });
  });

  it("dismissCleanExitPane clears only clean-exit dead panes and retains bounded postmortem output", async () => {
    const { manager, sessions, dead, panes } = makeManager("agents:\n  clean:\n    cmd: x\n  boom:\n    cmd: x\n");
    sessions.add(`tachyon-${HASH}-clean`);
    sessions.add(`tachyon-${HASH}-boom`);
    dead.set(`tachyon-${HASH}-clean`, 0);
    dead.set(`tachyon-${HASH}-boom`, 137);
    panes.set(`tachyon-${HASH}-clean`, "one\ntwo\nthree");
    await expect(manager.dismissCleanExitPane("clean")).resolves.toBe(true);
    expect(sessions.has(`tachyon-${HASH}-clean`)).toBe(false);
    expect((await manager.list()).find((a) => a.name === "clean")).toMatchObject({ cleanExited: true, dead: false });
    expect(manager.postmortemTail("clean", 2)).toMatchObject({ text: "two\nthree", truncated: true });
    await expect(manager.dismissCleanExitPane("boom")).resolves.toBe(false);
    expect(sessions.has(`tachyon-${HASH}-boom`)).toBe(true);
  });

  it("spec 351 T7 (dueto F8): postmortem capture redacts a leaked Bridge token before retaining it", async () => {
    const TOKEN = "b".repeat(64);
    const { sessions, dead, panes, tmux } = fakeTmux();
    const config = configOf("agents:\n  clean:\n    cmd: x\n");
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      getMaxAgents: () => 8,
      getExtraEnv: () => ({ TACHYON_BRIDGE_TOKEN: TOKEN }),
    });
    sessions.add(`tachyon-${HASH}-clean`);
    dead.set(`tachyon-${HASH}-clean`, 0);
    panes.set(`tachyon-${HASH}-clean`, `one\necho $TACHYON_BRIDGE_TOKEN\n${TOKEN}\nTACHYON_BRIDGE_TOKEN=${TOKEN}`);
    await expect(manager.dismissCleanExitPane("clean")).resolves.toBe(true);
    const retained = manager.postmortemTail("clean");
    expect(retained?.text).not.toContain(TOKEN);
    expect(retained?.text).toContain("TACHYON_BRIDGE_TOKEN=[redacted]");
  });

  it("forgets a finished ad-hoc one-shot (clean exit 0) from the ledger; keeps a crashed one", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-211f6-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const ledger = new SessionLedger(ws);
    ledger.record("review", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, declared: false }); // clean exit
    ledger.record("boom", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, declared: false }); // crashed
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args[2] === "list-panes")
        return { stdout: `${sessionName(hash, "review")}\t1\t0\n${sessionName(hash, "boom")}\t1\t137\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new AgentManager({ tmux: new TmuxService(exec), wsHash: hash, workspaceRoot: ws, getConfig: () => configOf("agents:\n  decoy:\n    cmd: x\n"), getMaxAgents: () => 8, ledger });
    manager.rehydrateFromLedger();
    const infos = await manager.list();
    // dead panes still render in-session for postmortem...
    expect(infos.find((a) => a.name === "review")).toMatchObject({ dead: true, crashed: false, exitCode: 0 });
    expect(infos.find((a) => a.name === "boom")).toMatchObject({ dead: true, crashed: true });
    // ...but the clean-exit one-shot is dropped from the ledger so it won't rehydrate after reload; the crash stays.
    expect(ledger.get("review")).toBeUndefined();
    expect(ledger.get("boom")).toBeDefined();
  });

  it("dismissAdhoc forgets a sessionless stopped ad-hoc — def, lineage AND ledger row", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, declared: false });
    manager.rehydrateFromLedger();
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeDefined();
    manager.dismissAdhoc("ghost");
    expect(ledger.get("ghost")).toBeUndefined(); // won't rehydrate after reload
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeUndefined(); // gone from the live listing
  });

  it("dismissAdhoc emits the lifecycle callback so Bridge callers refresh the sidebar", async () => {
    const killed: string[] = [];
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n", { onKilled: (name) => killed.push(name) });
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, declared: false });
    manager.rehydrateFromLedger();
    manager.dismissAdhoc("ghost");
    expect(killed).toEqual(["ghost"]);
  });

  it("rename rewrites a child's persisted parent in the ledger", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("parent", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false });
    ledger.record("child", { def: { cmd: "sh", kind: "terminal", parent: "parent" }, cwd: ws, declared: false });
    manager.rehydrateFromLedger();
    await manager.rename("parent", "boss");
    expect(ledger.get("child")?.def?.parent).toBe("boss");
  });
});

describe("newlyDeclaredAutostart — live tachyon.yml edit (dogfood p-5a2a83 follow-up)", () => {
  const def = (autostart: boolean) => ({ autostart });
  it("starts a NEWLY-added autostart agent not already running", () => {
    const before = new Set(["claude"]);
    const after = { claude: def(true), worker: def(true) };
    expect(newlyDeclaredAutostart(before, after, new Set(["claude"]))).toEqual(["worker"]);
  });
  it("never re-starts a pre-existing agent (intentionally stopped stays stopped)", () => {
    const before = new Set(["claude", "worker"]);
    const after = { claude: def(true), worker: def(true) };
    expect(newlyDeclaredAutostart(before, after, new Set())).toEqual([]); // worker existed before → left alone
  });
  it("skips a new agent without autostart, and one already running", () => {
    const before = new Set<string>();
    const after = { a: def(false), b: def(true), c: def(true) };
    expect(newlyDeclaredAutostart(before, after, new Set(["c"]))).toEqual(["b"]); // a=no autostart, c=already up
  });
});

describe("AgentManager — spec 230 pipeline-node spawn", () => {
  it("persists def.env (the node nonce) and def.pipeline for a pipeline-node ad-hoc spawn", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "am-pl-"));
    try {
      const { tmux } = fakeTmux();
      const ledger = new SessionLedger(ws);
      const manager = new AgentManager({
        tmux,
        wsHash: HASH,
        workspaceRoot: ws,
        ledger,
        getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
        getMaxAgents: () => 8,
      });
      await manager.spawn("feature-r1-implement", {
        cmd: "claude",
        env: { TACHYON_RUN_ID: "r1", TACHYON_NODE_ID: "implement", TACHYON_NODE_NONCE: "secret-xyz" },
        pipeline: { runId: "r1", nodeId: "implement" },
      });
      const rec = ledger.get("feature-r1-implement");
      expect(rec?.def?.pipeline).toEqual({ runId: "r1", nodeId: "implement" });
      expect(rec?.def?.env).toMatchObject({ TACHYON_NODE_NONCE: "secret-xyz" });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("AgentManager — per-agent Bridge token mint/revoke (spec 351 T2)", () => {
  const SCOPE = { workspaceId: "ws-test", instanceId: "inst-test" };

  function registryBackedManager(yaml: string) {
    const registry = new CallerIdentityRegistry(crypto.randomBytes(32));
    const { tmux } = fakeTmux();
    const config = configOf(yaml);
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      getMaxAgents: () => 8,
      mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: registry.mint(name, SCOPE) }),
      revokeAgentToken: (name) => registry.revoke(name, SCOPE),
    });
    return { manager, registry };
  }

  it("spawn mints a live per-agent token for the agent's own name", async () => {
    const { manager, registry } = registryBackedManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    expect(registry.isLive("a", SCOPE)).toBe(true);
  });

  it("kill revokes the agent's token", async () => {
    const { manager, registry } = registryBackedManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    expect(registry.isLive("a", SCOPE)).toBe(true);
    await manager.kill("a");
    expect(registry.isLive("a", SCOPE)).toBe(false);
  });

  it("dismissAdhoc revokes the token too (idempotent if kill already revoked it)", async () => {
    const { manager, registry } = registryBackedManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a", { cmd: "sh -c true" });
    await manager.kill("a");
    expect(() => manager.dismissAdhoc("a")).not.toThrow();
    expect(registry.isLive("a", SCOPE)).toBe(false);
  });

  it("restart revokes the old token before minting a new one — a resolve against the pre-restart token fails", async () => {
    const registry = new CallerIdentityRegistry(crypto.randomBytes(32));
    let lastMinted = "";
    const { tmux } = fakeTmux();
    const config = configOf("agents:\n  a:\n    cmd: x\n");
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      getMaxAgents: () => 8,
      mintAgentToken: (name) => {
        lastMinted = registry.mint(name, SCOPE);
        return { TACHYON_AGENT_BRIDGE_TOKEN: lastMinted };
      },
      revokeAgentToken: (name) => registry.revoke(name, SCOPE),
    });
    await manager.spawn("a");
    const preRestartToken = lastMinted;
    await manager.restart("a");
    expect(registry.resolve(preRestartToken, SCOPE)).toEqual({ ok: false, reason: "token_revoked" });
    expect(registry.resolve(lastMinted, SCOPE)).toEqual({ ok: true, snapshot: { kind: "agent", name: "a" } });
  });

  it("resume mints a fresh token for the resumed session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-am-token-"));
    try {
      const registry = new CallerIdentityRegistry(crypto.randomBytes(32));
      const config = configOf("agents:\n  claude:\n    cmd: claude\n");
      const ledger = new SessionLedger(dir);
      const rec = { def: { cmd: "claude", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "tachyon-repo-claude" }, cwd: dir, declared: true, updatedAt: "t" };
      ledger.record("claude", rec);
      const exec = async (args: string[]): Promise<ExecResult> => {
        if (args[2] === "has-session" || args[2] === "list-panes" || args[2] === "list-sessions") throw new Error("none");
        return { stdout: "", stderr: "" };
      };
      const manager = new AgentManager({
        tmux: new TmuxService(exec),
        wsHash: HASH,
        workspaceRoot: dir,
        getConfig: () => config,
        getMaxAgents: () => 8,
        ledger,
        fileExists: () => true,
        mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: registry.mint(name, SCOPE) }),
        revokeAgentToken: (name) => registry.revoke(name, SCOPE),
      });
      await manager.resume("claude", rec);
      expect(registry.isLive("claude", SCOPE)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the generated codex Bridge injection references the NEW per-agent env var, not the shared one", async () => {
    const config = configOf("agents:\n  codex:\n    cmd: codex\n");
    const cmds: string[] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) cmds.push(args[args.length - 1]);
      if (args[2] === "has-session") throw new Error("none");
      return { stdout: "", stderr: "" };
    };
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      getMaxAgents: () => 8,
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
    });
    await manager.spawn("codex");
    expect(cmds.at(-1)).toContain('bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"');
  });
});
