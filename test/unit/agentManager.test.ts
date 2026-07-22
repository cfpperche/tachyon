import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AgentManager, MaxAgentsError, ResumeUnavailableError, ForkUnavailableError, WatchController, newlyDeclaredAutostart, type AgentManagerOptions } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile, spawnSettingsPath } from "../../src/activity/sessionOwners.js";
import { FORGET_AGENT_FOOTPRINTS, forgetAgent } from "../../src/agents/forgetAgent.js";
import { HarnessManager, harnessHome, opencodeHarnessDirs } from "../../src/harness/HarnessManager.js";
import { adapterFor, harnessable } from "../../src/resume/adapters.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { boundDeliveryPreReservationRefusals, exerciseBoundDeliveryPreReservationRefusal } from "../helpers/boundDeliveryExecutionHarness.js";
import { briefFilePath } from "../../src/agents/briefFile.js";
import { SOUL_LAUNCH_RESERVATION_BOOT_ID, soulLaunchReservationsDir } from "../../src/agents/soul.js";
import { paneTranscriptPath, paneTranscriptExists, ensurePaneTranscriptFile } from "../../src/agents/paneTranscript.js";
import { EvolutionStore } from "../../src/evolution/EvolutionStore.js";
import { resolveEvolutionStartupSnapshot } from "../../src/evolution/startupSnapshot.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

function canonicalSpawnReceipt(worktree: { path: string; branch: string }, head = "head") {
  return {
    deliveryId: "d-test",
    projectionId: "gd-test",
    segmentId: "seg-0",
    worktree: worktree.path,
    branch: worktree.branch,
    head,
  };
}
const SOUL_LEGACY_LIFECYCLE = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/agent-soul-legacy/lifecycle-bypass-cases.json"), "utf8")) as {
  cases: Array<{ name: string; bytes: string; sendKeys: string[] }>;
};
function soulLegacyLifecycleCase(name: string) {
  return SOUL_LEGACY_LIFECYCLE.cases.find((item) => item.name === name)!;
}
function soulLifecycleBypassSpies(manager: AgentManager) {
  const compositor = vi.spyOn(manager as never, "effectiveCmd" as never);
  const soulResolver = vi.fn();
  Object.defineProperty(manager, "resolveSoul", { configurable: true, value: soulResolver });
  return { compositor, soulResolver };
}

describe("Delivery pre-reservation refusals", () => {
  it.each(boundDeliveryPreReservationRefusals)("refuses %s with the complete zero-effect vector", async (refusal) => {
    await exerciseBoundDeliveryPreReservationRefusal(refusal);
  });
});

/**
 * Parse env from either `new-session -e KEY=value` or `set-environment -t … KEY value`
 * (respawn path, t-4d2630). `set-environment -u` deletes a key from the result.
 */
function envFromTmuxArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" && args[i + 1]?.includes("=")) {
      const pair = args[++i]!;
      const eq = pair.indexOf("=");
      out[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (args[i] === "set-environment") {
      // set-environment [-u] -t =target NAME [VALUE]
      let j = i + 1;
      let unset = false;
      while (args[j] === "-u" || args[j] === "-r" || args[j] === "-h" || args[j] === "-g" || args[j] === "-F") {
        if (args[j] === "-u" || args[j] === "-r") unset = true;
        j++;
      }
      if (args[j] === "-t") j += 2;
      const name = args[j];
      if (name !== undefined) {
        if (unset) delete out[name];
        else if (args[j + 1] !== undefined) out[name] = args[j + 1]!;
      }
      i = unset ? j : j + 1;
    }
  }
  return out;
}

/** Collect names passed to `set-environment -u` / `-r` in a tmux argv chain (t-4d2630). */
function unsetEnvKeysFromTmuxArgs(args: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "set-environment") continue;
    let j = i + 1;
    let unset = false;
    while (args[j] === "-u" || args[j] === "-r" || args[j] === "-h" || args[j] === "-g" || args[j] === "-F") {
      if (args[j] === "-u" || args[j] === "-r") unset = true;
      j++;
    }
    if (args[j] === "-t") j += 2;
    if (unset && args[j] !== undefined) keys.push(args[j]!);
  }
  return keys;
}

/** Apply new-session `-e` / set-environment tokens onto a per-session env map (fake tmux). */
function applyTmuxEnvToSession(sessionEnv: Map<string, Record<string, string>>, args: string[]): void {
  let session: string | undefined;
  const tIdx = args.indexOf("-t");
  if (tIdx >= 0 && args[tIdx + 1]) {
    session = args[tIdx + 1]!.replace(/^=/, "").replace(/:$/, "");
  }
  const sIdx = args.indexOf("-s");
  if (sIdx >= 0 && args[sIdx + 1]) session = args[sIdx + 1];
  if (!session) return;
  const env = sessionEnv.get(session) ?? {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" && args[i + 1]?.includes("=")) {
      const pair = args[++i]!;
      const eq = pair.indexOf("=");
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (args[i] === "set-environment") {
      let j = i + 1;
      let unset = false;
      while (args[j] === "-u" || args[j] === "-r" || args[j] === "-h" || args[j] === "-g" || args[j] === "-F") {
        if (args[j] === "-u" || args[j] === "-r") unset = true;
        j++;
      }
      if (args[j] === "-t") j += 2;
      const name = args[j];
      if (name !== undefined) {
        if (unset) delete env[name];
        else if (args[j + 1] !== undefined) env[name] = args[j + 1]!;
      }
      i = unset ? j : j + 1;
    }
  }
  sessionEnv.set(session, env);
}

/** Stateful in-memory tmux fake at the executor level — exercises real TmuxService arg paths. */
function fakeTmux(opts: { failRespawn?: boolean; failShowEnvironment?: boolean } = {}) {
  const sessions = new Set<string>();
  const dead = new Map<string, number>(); // session -> exit code (remain-on-exit dead pane)
  const panes = new Map<string, string>();
  const sessionEnv = new Map<string, Record<string, string>>(); // launch env from -e / set-environment
  const sentKeys: Array<{ session: string; key: string }> = [];
  const respawnArgs: string[][] = [];
  const newSessionArgs: string[][] = [];
  const pipedSessions = new Map<string, string>(); // t-6a6a00 — session -> its current pipe-pane shell-command (absent = not piping)
  const pipePaneArgs: string[][] = [];
  const opLog: string[] = []; // t-6a6a00 — chronological op tags, for asserting detach-before-kill ordering
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => {
      const i = args.indexOf("-t");
      return args[i + 1].replace(/^=/, "").replace(/:$/, "");
    };
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.add(name);
      applyTmuxEnvToSession(sessionEnv, args);
      newSessionArgs.push(args);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("respawn-pane")) {
      if (opts.failRespawn) throw new Error("respawn failed");
      const t = target();
      if (!sessions.has(t)) throw new Error("can't find session");
      dead.delete(t); // remain-on-exit dead pane becomes live again
      applyTmuxEnvToSession(sessionEnv, args);
      respawnArgs.push(args);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "show-environment": {
        if (opts.failShowEnvironment) throw new Error("show-environment failed");
        const t = target();
        if (!sessions.has(t)) throw new Error("can't find session");
        const env = sessionEnv.get(t) ?? {};
        return {
          stdout: Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + (Object.keys(env).length ? "\n" : ""),
          stderr: "",
        };
      }
      case "rename-session": {
        const from = target();
        const to = args[args.length - 1];
        if (!sessions.delete(from)) throw new Error("can't find session");
        sessions.add(to);
        if (dead.has(from)) {
          dead.set(to, dead.get(from) as number);
          dead.delete(from);
        }
        if (sessionEnv.has(from)) {
          sessionEnv.set(to, sessionEnv.get(from)!);
          sessionEnv.delete(from);
        }
        return { stdout: "", stderr: "" };
      }
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        sessionEnv.delete(target());
        pipedSessions.delete(target());
        opLog.push(`kill-session:${target()}`);
        return { stdout: "", stderr: "" };
      case "pipe-pane": {
        const t = target();
        if (!sessions.has(t)) throw new Error("can't find session");
        pipePaneArgs.push(args);
        const cmd = args[args.length - 1];
        if (cmd.startsWith("cat >>")) {
          pipedSessions.set(t, cmd);
          opLog.push(`pipe-pane:attach:${t}`);
        } else {
          pipedSessions.delete(t);
          opLog.push(`pipe-pane:detach:${t}`);
        }
        return { stdout: "", stderr: "" };
      }
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
  return { sessions, dead, panes, sessionEnv, sentKeys, respawnArgs, newSessionArgs, pipedSessions, pipePaneArgs, opLog, tmux: new TmuxService(exec) };
}

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeManager(yaml: string, maxAgentsSetting = 8, tmuxOpts: { failRespawn?: boolean; failShowEnvironment?: boolean } = {}) {
  const { sessions, dead, panes, sentKeys, respawnArgs, newSessionArgs, tmux } = fakeTmux(tmuxOpts);
  const config = configOf(yaml);
  const spawned: string[] = [];
  const killed: string[] = [];
  const restarted: string[] = [];
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => maxAgentsSetting,
    onSpawned: (n) => spawned.push(n),
    onKilled: (n) => killed.push(n),
    onRestart: (n) => restarted.push(n),
    materializeHarness: ({ name, def }) => adapterFor(def.cmd)?.runtime === "pi"
      ? { home: `/private/pi/${name}`, env: { PI_CODING_AGENT_DIR: `/private/pi/${name}`, PI_CODING_AGENT_SESSION_DIR: `/private/pi/${name}/sessions` }, args: [] }
      : null,
    materializePiSessionDir: (name) => `/private/pi/${name}/sessions`,
  });
  return { manager, sessions, dead, panes, sentKeys, respawnArgs, newSessionArgs, spawned, killed, restarted };
}

describe("AgentManager", () => {
  it("clears legacy, prior-boot, and dead-owner launch reservations while preserving a same-boot live owner", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-soul-reservations-"));
    try {
      const dir = soulLaunchReservationsDir(root);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const legacy = path.join(dir, "ada--legacy--123e4567-e89b-42d3-a456-426614174000.json");
      const reusedPid = path.join(dir, "ada--reused--123e4567-e89b-42d3-a456-426614174001.json");
      const dead = path.join(dir, "ada--dead--123e4567-e89b-42d3-a456-426614174002.json");
      const live = path.join(dir, "ada--live--123e4567-e89b-42d3-a456-426614174003.json");
      fs.writeFileSync(legacy, JSON.stringify({ principal: "Ada", ownerPid: process.pid }), { mode: 0o600 });
      fs.writeFileSync(reusedPid, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: "prior-extension-host" }), { mode: 0o600 });
      fs.writeFileSync(dead, JSON.stringify({ principal: "Ada", ownerPid: 2_147_483_647, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
      fs.writeFileSync(live, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
      const { tmux } = fakeTmux();
      const config = configOf("agents:\n  Ada:\n    cmd: codex\n");
      void new AgentManager({ tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, getMaxAgents: () => 8 });
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(reusedPid)).toBe(false);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("spawns a declared agent into a namespaced session", async () => {
    const { manager, sessions, spawned } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
    expect(spawned).toEqual(["claude"]);
  });

  it("SDD 421 pins Agent Evolution to the session and resolves a newer version only on fresh restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-manager-evolution-"));
    try {
      const evolution = new EvolutionStore(root);
      const first = await evolution.createCandidate("reviewer", {
        reviewId: "review-first",
        taskId: "t-111111",
        target: { kind: "learning", content: "Use the first approved method.", reason: "It is repeatable." },
      });
      const firstDetail = await evolution.candidateDetail("reviewer", first.id);
      await evolution.approveCandidate("reviewer", first.id, {
        expectedActiveVersion: 0,
        expectedTargetDigest: firstDetail.currentTargetDigest,
      });

      const fake = fakeTmux();
      const ledger = new SessionLedger(root);
      let config = configOf("agents:\n  reviewer:\n    cmd: claude\n    selfEvolution: {enabled: true}\n");
      const manager = new AgentManager({
        tmux: fake.tmux,
        wsHash: workspaceHash(root),
        workspaceRoot: root,
        ledger,
        getConfig: () => config,
        getMaxAgents: () => 8,
      });
      await manager.spawn("reviewer");
      expect(fake.newSessionArgs[0]!.at(-1)).toContain("Use the first approved method.");
      const pinned = ledger.get("reviewer")!.evolution!;
      expect(pinned.version).toBe(1);

      const second = await evolution.createCandidate("reviewer", {
        reviewId: "review-second",
        taskId: "t-222222",
        target: { kind: "learning", content: "Use the second approved method.", reason: "It improves the next run." },
      });
      const secondDetail = await evolution.candidateDetail("reviewer", second.id);
      await evolution.approveCandidate("reviewer", second.id, {
        expectedActiveVersion: 1,
        expectedTargetDigest: secondDetail.currentTargetDigest,
      });
      expect(ledger.get("reviewer")!.evolution).toEqual(pinned);

      await manager.restart("reviewer", { stop: "force", session: "new" });
      expect(fake.respawnArgs.at(-1)!.at(-1)).toContain("Use the second approved method.");
      expect(ledger.get("reviewer")!.evolution).toMatchObject({ version: 2, agent: "reviewer" });
      expect(ledger.get("reviewer")!.evolution!.digest).not.toBe(pinned.digest);

      const versionTwoDigest = ledger.get("reviewer")!.evolution!.digest;
      config = configOf("agents:\n  reviewer:\n    cmd: grok\n    selfEvolution: {enabled: true}\n");
      await manager.restart("reviewer", { stop: "force", session: "new" });
      expect(fake.respawnArgs.at(-1)!.at(-1)).toContain("Use the second approved method.");
      expect(ledger.get("reviewer")!.evolution).toMatchObject({ version: 2, digest: versionTwoDigest });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("SDD 421 delivers the same approved evolution snapshot through every supported runtime channel", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-manager-evolution-runtimes-"));
    try {
      const evolution = new EvolutionStore(root);
      const candidate = await evolution.createCandidate("reviewer", {
        reviewId: "review-runtime-parity",
        taskId: "t-333333",
        target: { kind: "learning", content: "Keep runtime-neutral evidence.", reason: "The profile belongs to Tachyon." },
      });
      const detail = await evolution.candidateDetail("reviewer", candidate.id);
      await evolution.approveCandidate("reviewer", candidate.id, {
        expectedActiveVersion: 0,
        expectedTargetDigest: detail.currentTargetDigest,
      });
      const expected = await resolveEvolutionStartupSnapshot(root, "reviewer", evolution);

      for (const cmd of ["claude", "codex", "agy", "gemini", "opencode", "grok", "hermes", "pi"]) {
        const fake = fakeTmux();
        const ledger = new SessionLedger(root);
        const config = configOf(`agents:\n  reviewer:\n    cmd: ${cmd}\n    selfEvolution: {enabled: true}\n`);
        const manager = new AgentManager({
          tmux: fake.tmux,
          wsHash: workspaceHash(root),
          workspaceRoot: root,
          ledger,
          getConfig: () => config,
          getMaxAgents: () => 8,
          materializePiSessionDir: (name) => path.join(root, ".tachyon", "pi-sessions", name),
        });

        await manager.spawn("reviewer");
        const session = sessionName(workspaceHash(root), "reviewer");
        const delivered = cmd === "hermes"
          ? fake.sessionEnv.get(session)?.HERMES_TUI_QUERY
          : fake.newSessionArgs[0]?.at(-1);
        expect(delivered, `runtime=${cmd}`).toContain("Keep runtime-neutral evidence.");
        expect(ledger.get("reviewer")?.evolution, `runtime=${cmd}`).toEqual(expected);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    const { manager, sessions, killed, respawnArgs, restarted } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.kill("a")).rejects.toThrow("not running");
    await manager.spawn("a");
    await manager.restart("a", { stop: "force", session: "new" });
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    // t-4d2630: live session → respawn-pane -k (no kill+new, no onRestart close dance)
    expect(respawnArgs).toHaveLength(1);
    expect(respawnArgs[0]).toContain("respawn-pane");
    expect(respawnArgs[0]).toContain("-k");
    expect(restarted).toEqual([]);
    await manager.kill("a");
    expect(killed).toEqual(["a"]);
    expect(sessions.size).toBe(0);
  });

  it("t-4d2630: restart falls back to kill+new (and onRestart) when respawn fails", async () => {
    const { manager, sessions, respawnArgs, newSessionArgs, restarted } = makeManager(
      "agents:\n  a:\n    cmd: x\n",
      8,
      { failRespawn: true },
    );
    await manager.spawn("a");
    const beforeNew = newSessionArgs.length;
    await manager.restart("a", { stop: "force", session: "new" });
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(respawnArgs).toHaveLength(0); // failed before record — fake throws first
    expect(newSessionArgs.length).toBe(beforeNew + 1);
    expect(restarted).toEqual(["a"]); // kill+new path closes the UI terminal
  });

  it("t-4d2630: show-environment failure falls back to kill+new (not set-only respawn)", async () => {
    // Env-sync needs show-environment to know which keys to unset. If that fails,
    // respawnPane must throw so we kill+new rather than set-only respawn with stale keys.
    const { manager, sessions, respawnArgs, newSessionArgs, restarted } = makeManager(
      "agents:\n  a:\n    cmd: x\n",
      8,
      { failShowEnvironment: true },
    );
    await manager.spawn("a"); // new-session path — does not need show-environment
    const beforeNew = newSessionArgs.length;
    await manager.restart("a", { stop: "force", session: "new" });
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(respawnArgs).toHaveLength(0); // never reached respawn-pane
    expect(newSessionArgs.length).toBe(beforeNew + 1);
    expect(restarted).toEqual(["a"]);
  });

  it("t-4d2630: restart with no existing session uses new-session (not respawn)", async () => {
    const { manager, sessions, respawnArgs, newSessionArgs, restarted } = makeManager("agents:\n  a:\n    cmd: x\n");
    // Ledger/def exists without a live session (e.g. after kill, or cold restart of a declared agent)
    await manager.spawn("a");
    await manager.kill("a");
    respawnArgs.length = 0;
    const beforeNew = newSessionArgs.length;
    await manager.restart("a", { stop: "force", session: "new" });
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(respawnArgs).toHaveLength(0);
    expect(newSessionArgs.length).toBe(beforeNew + 1);
    expect(restarted).toEqual([]); // no kill of an existing attach client
  });

  describe("spec 389 restart matrix", () => {
    it("force+new returns resumed:false and respawns immediately (no graceful keys)", async () => {
      const { manager, sentKeys, respawnArgs } = makeManager("agents:\n  a:\n    cmd: x\n");
      await manager.spawn("a");
      sentKeys.length = 0;
      const result = await manager.restart("a", { stop: "force", session: "new" });
      expect(result).toEqual({ stop: "force", session: "new", resumed: false, forcedAfterGracefulTimeout: false });
      expect(sentKeys).toEqual([]); // no graceful stop handshake
      expect(respawnArgs.length).toBe(1);
    });

    it("graceful+new stops, times out, session-only hard-kills, then new-section (no ad-hoc wipe)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-restart-graceful-"));
      try {
        const { sessions, dead, panes, sentKeys, respawnArgs, newSessionArgs, tmux } = fakeTmux();
        const ledger = new SessionLedger(root);
        const config = configOf("agents:\n  worker:\n    cmd: codex\n");
        const manager = new AgentManager({
          tmux,
          wsHash: HASH,
          workspaceRoot: root,
          getConfig: () => config,
          getMaxAgents: () => 8,
          ledger,
        });
        await manager.spawn("worker");
        const session = `tachyon-${HASH}-worker`;
        expect(sessions.has(session)).toBe(true);
        sentKeys.length = 0;
        const beforeNew = newSessionArgs.length;
        const result = await manager.restart("worker", {
          stop: "graceful",
          session: "new",
          gracefulTimeoutMs: 0, // process ignores EOF in the fake → immediate force-fallback
        });
        expect(result.stop).toBe("graceful");
        expect(result.session).toBe("new");
        expect(result.resumed).toBe(false);
        expect(result.forcedAfterGracefulTimeout).toBe(true);
        expect(sentKeys.some((k) => k.key === "C-d" || k.key === "C-c")).toBe(true);
        // After session-only kill + fresh start the entry is still defined (not dismissed).
        const listed = await manager.list();
        expect(listed.some((e) => e.name === "worker")).toBe(true);
        expect(sessions.has(session)).toBe(true);
        // kill-session then new-session (or respawn if session left as dead) — either way process is back.
        expect(respawnArgs.length + (newSessionArgs.length - beforeNew)).toBeGreaterThanOrEqual(1);
        void dead; void panes;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("default restart is graceful+resume and falls back to new when not resumable", async () => {
      const { manager, sentKeys } = makeManager("agents:\n  a:\n    cmd: x\n");
      await manager.spawn("a");
      sentKeys.length = 0;
      const result = await manager.restart("a", { gracefulTimeoutMs: 0 });
      expect(result.stop).toBe("graceful");
      expect(result.session).toBe("resume");
      expect(result.resumed).toBe(false); // no resume block / transcript
      expect(result.forcedAfterGracefulTimeout).toBe(true);
      expect(sentKeys.length).toBeGreaterThan(0);
    });

    it("graceful restart clears stopping badge so a live pane is not stuck stopping/stop-failed", async () => {
      // dogfood 2026-07-16: Restart default used stopGracefully then resume/fresh; sidebar stayed
      // on "stopping…" while the editor pane was already live with primer.
      const { manager } = makeManager("agents:\n  a:\n    cmd: x\n");
      await manager.spawn("a");
      await manager.stopGracefully("a");
      expect((await manager.list()).find((r) => r.name === "a")).toMatchObject({ running: true, stopping: true });
      await manager.restart("a", { stop: "graceful", session: "new", gracefulTimeoutMs: 0 });
      const row = (await manager.list()).find((r) => r.name === "a");
      expect(row).toMatchObject({ running: true });
      expect(row?.stopping).toBeUndefined();
      expect(row?.stopFailed).toBeUndefined();
    });

    it("graceful+resume resumes when ledger has a valid transcript", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-restart-resume-"));
      const projects = path.join(root, "projects", "-ws");
      fs.mkdirSync(projects, { recursive: true });
      const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      fs.writeFileSync(path.join(projects, `${sid}.jsonl`), "{}\n");
      try {
        const { sessions, dead, tmux } = fakeTmux();
        const ledger = new SessionLedger(root);
        ledger.record("claude", {
          declared: true,
          cwd: "/ws",
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: sid, configHome: root },
        });
        const config = configOf("agents:\n  claude:\n    cmd: claude\n");
        const manager = new AgentManager({
          tmux,
          wsHash: HASH,
          workspaceRoot: root,
          getConfig: () => config,
          getMaxAgents: () => 8,
          ledger,
          fileExists: (p) => fs.existsSync(p),
        });
        // Stopped row — skip stop phase, go straight to resume.
        const result = await manager.restart("claude", { stop: "graceful", session: "resume" });
        expect(result.resumed).toBe(true);
        expect(result.session).toBe("resume");
        expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
        void dead;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("force+resume falls back to new when resume is unavailable", async () => {
      const { manager, respawnArgs } = makeManager("agents:\n  a:\n    cmd: x\n");
      await manager.spawn("a");
      const result = await manager.restart("a", { stop: "force", session: "resume" });
      expect(result.stop).toBe("force");
      expect(result.session).toBe("resume");
      expect(result.resumed).toBe(false);
      expect(respawnArgs.length).toBe(1);
    });
  });

  it("stopGracefully sends EOF without killing the tmux session", async () => {
    const { manager, sessions, sentKeys, killed } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.stopGracefully("a")).rejects.toThrow("not running");
    await manager.spawn("a");
    await manager.stopGracefully("a");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-a`, key: "C-c" },
      { session: `tachyon-${HASH}-a`, key: "C-c" },
      { session: `tachyon-${HASH}-a`, key: "C-d" },
    ]);
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(killed).toEqual([]);
  });

  it("SDD 403: stopGracefully executes Pi's measured abort, clear and conditional EOF sequence", async () => {
    const { manager, sentKeys } = makeManager("agents:\n  pi:\n    cmd: pi\n");
    await manager.spawn("pi");
    await manager.stopGracefully("pi");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-pi`, key: "Escape" },
      { session: `tachyon-${HASH}-pi`, key: "C-c" },
      { session: `tachyon-${HASH}-pi`, key: "C-d" },
      { session: `tachyon-${HASH}-pi`, key: "C-d" },
    ]);
  });

  it("stopGracefully interrupts an active Codex turn before EOF", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    panes.set(`tachyon-${HASH}-codex`, "• Working (6m 03s • esc to interrupt)");
    await manager.stopGracefully("codex");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-codex`, key: "Escape" },
      { session: `tachyon-${HASH}-codex`, key: "C-c" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
    ]);
  });

  it("stopGracefully does not interrupt an idle Codex pane", async () => {
    const { manager, panes, sentKeys } = makeManager("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    panes.set(`tachyon-${HASH}-codex`, "› ");
    await manager.stopGracefully("codex");
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-codex`, key: "C-c" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
    ]);
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
    await expect(manager.restart("orphan", { stop: "force", session: "new" })).rejects.toThrow("no stored definition");
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
  const captureSpawnCmd = async (
    yml: string,
    name: string,
    opts?: Parameters<AgentManager["spawn"]>[1],
    workspaceRoot = WS,
  ): Promise<string> => {
    const calls: string[][] = [];
    const recording = new (await import("../../src/tmux/TmuxService.js")).TmuxService(async (args) => {
      calls.push(args);
      if (args[2] === "has-session" || args[2] === "list-panes") throw new Error("none");
      return { stdout: "", stderr: "" };
    });
    const manager = new AgentManager({
      tmux: recording,
      wsHash: workspaceHash(workspaceRoot),
      workspaceRoot,
      getConfig: () => configOf(yml),
      getMaxAgents: () => 8,
    });
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

  it("spec 363 T3 — a bare declared top-level agent receives universal protocol only", async () => {
    const cmd = await captureSpawnCmd("agents:\n  codex:\n    cmd: codex\n", "codex");
    expect(cmd).toContain("── TACHYON PRIMER ──");
    expect(cmd).not.toContain("── PROJECT GUIDANCE (PROJECT-OWNED) ──");
    expect(cmd).not.toContain("npm test");
    expect(cmd).not.toContain("<your spawner>");
  });

  it("delivers explicit workspace verification facts to a bare declared agent", async () => {
    const cmd = await captureSpawnCmd(
      "agents:\n  codex:\n    cmd: codex\nsettings:\n  verify:\n    full: ./verify-all\n    typecheck: ./check-types\n",
      "codex",
    );
    expect(cmd).toContain("Configured verification (source: workspace config settings.verify):");
    expect(cmd).toContain("  - full: ./verify-all");
    expect(cmd).toContain("  - typecheck: ./check-types");
  });

  it("rejects oversized dynamic primer facts before creating a tmux session", async () => {
    const full = `node ${JSON.stringify("'".repeat(4_000))}`;
    const config = configOf(
      `agents:\n  codex:\n    cmd: codex\nsettings:\n  verify:\n    full: ${JSON.stringify(full)}\n`,
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });

    await expect(manager.spawn("codex")).rejects.toThrow(/startup brief.*safe pane-delivery ceiling/);
    expect(fake.newSessionArgs).toHaveLength(0);
  });

  it("delivers configured project guidance to a bare declared agent in the owned block", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-spawn-"));
    try {
      fs.mkdirSync(path.join(root, "docs"));
      fs.writeFileSync(path.join(root, "docs", "agent.md"), "PROJECT_MARKER\n  keep spacing\n", "utf8");
      const cmd = await captureSpawnCmd(
        "agents:\n  codex:\n    cmd: codex\nsettings:\n  projectGuidance:\n    files: [docs/agent.md]\n",
        "codex",
        undefined,
        root,
      );

      expect(cmd).toContain("── TACHYON PRIMER ──");
      expect(cmd).toContain("── PROJECT GUIDANCE (PROJECT-OWNED) ──");
      expect(cmd).toContain("Source: docs/agent.md");
      expect(cmd).toContain("PROJECT_MARKER\n  keep spacing\n");
      expect(cmd.indexOf("── END PRIMER ──")).toBeLessThan(cmd.indexOf("── PROJECT GUIDANCE (PROJECT-OWNED) ──"));
      expect(cmd.indexOf("── END PROJECT GUIDANCE ──")).toBeLessThan(cmd.indexOf("── BEFORE FINISHING ──"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("diverts long project guidance before primer framing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-long-"));
    try {
      fs.writeFileSync(path.join(root, "guidance.md"), `LONG_GUIDANCE_${"x".repeat(5_000)}`, "utf8");
      const cmd = await captureSpawnCmd(
        "agents:\n  codex:\n    cmd: codex\nsettings:\n  projectGuidance:\n    files: [guidance.md]\n",
        "codex",
        undefined,
        root,
      );
      const file = briefFilePath(root, "codex");
      expect(cmd).toContain("── TACHYON PRIMER ──");
      expect(cmd).toContain(file);
      expect(cmd).toContain("Your full startup brief is long");
      expect(cmd).toContain("project guidance (1 source)");
      expect(cmd).toContain("task contract (absent)");
      expect(cmd).toContain("Task objective: absent");
      expect(cmd).not.toContain("LONG_GUIDANCE_");
      const onDisk = fs.readFileSync(file, "utf8");
      expect(onDisk).toContain("── STARTUP BRIEF CONTENTS ──");
      expect(onDisk).toContain("Task: absent");
      expect(onDisk).toContain("── PROJECT GUIDANCE (PROJECT-OWNED) ──");
      expect(onDisk).toContain("LONG_GUIDANCE_");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the prior long brief unchanged when restart framing is oversized", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-restart-atomic-"));
    const guidance = path.join(root, "guidance.md");
    fs.writeFileSync(guidance, `OLD_GUIDANCE_${"o".repeat(5_000)}`, "utf8");
    let config = configOf(
      "agents:\n  codex:\n    cmd: codex\nsettings:\n  projectGuidance:\n    files: [guidance.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await manager.spawn("codex");
      const destination = briefFilePath(root, "codex");
      const oldBrief = fs.readFileSync(destination, "utf8");
      fs.writeFileSync(guidance, `NEW_GUIDANCE_${"n".repeat(5_000)}`, "utf8");
      config = configOf(
        `agents:\n  codex:\n    cmd: codex\nsettings:\n  verify:\n    full: ${JSON.stringify(`node ${JSON.stringify("'".repeat(4_000))}`)}\n  projectGuidance:\n    files: [guidance.md]\n`,
      );

      await expect(manager.restart("codex", { stop: "force", session: "new" })).rejects.toThrow(/safe pane-delivery ceiling/);
      expect(fs.readFileSync(destination, "utf8")).toBe(oldBrief);
      expect(fake.respawnArgs).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["deliverable", { deliverable: "The restarted pointer still reports DELIVERABLE" }, "DELIVERABLE"],
    ["done_when", { doneWhen: "The restarted pointer still reports DONE_WHEN" }, "DONE_WHEN"],
  ] as const)("reuses the persisted %s completion kind when restarting a long startup brief", async (_kind, completion, display) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-startup-brief-restart-contract-"));
    const fake = fakeTmux();
    const ledger = new SessionLedger(root);
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => configOf("agents:\n  anchor:\n    cmd: sh\n"),
      getMaxAgents: () => 8,
      ledger,
    });
    const taskBrief = `TASK: preserve restart metadata\nDONE_WHEN: ${"r".repeat(5_000)}`;
    const contract = {
      task: "Preserve restart metadata",
      context: "The startup brief is long",
      constraints: "Do not parse rendered text",
      ...completion,
    };
    try {
      await manager.spawn("worker", { cmd: "codex", taskBrief, contract });
      expect(fake.newSessionArgs[0]?.at(-1)).toContain(`task contract (${display})`);

      await manager.restart("worker", { stop: "force", session: "new" });

      expect(fake.respawnArgs.at(-1)?.at(-1)).toContain(`task contract (${display})`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", {}],
    ["ambiguous", { deliverable: "SENSITIVE_DELIVERABLE", doneWhen: "SENSITIVE_DONE_WHEN" }],
  ])("refuses restart before mutation when the persisted contract completion is %s", async (_case, completion) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-startup-brief-invalid-contract-"));
    const fake = fakeTmux();
    const ledger = new SessionLedger(root);
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => configOf("agents:\n  anchor:\n    cmd: sh\n"),
      getMaxAgents: () => 8,
      ledger,
    });
    const taskBrief = `TASK: preserve restart metadata\nDONE_WHEN: ${"r".repeat(5_000)}`;
    const validContract = {
      task: "Preserve restart metadata",
      context: "The startup brief is long",
      constraints: "Do not parse rendered text",
      doneWhen: "The initial spawn succeeds",
    };
    try {
      await manager.spawn("worker", { cmd: "codex", taskBrief, contract: validContract });
      const destination = briefFilePath(root, "worker");
      const previousBrief = fs.readFileSync(destination, "utf8");
      const persisted = JSON.parse(fs.readFileSync(ledger.path, "utf8")) as {
        sessions: Record<string, { def: { contract: Record<string, unknown> } }>;
      };
      persisted.sessions.worker.def.contract = {
        task: "SENSITIVE_TASK_BODY",
        context: "SENSITIVE_CONTEXT_BODY",
        constraints: "SENSITIVE_CONSTRAINTS_BODY",
        ...completion,
      };
      fs.writeFileSync(ledger.path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

      const error = await manager.restart("worker", { stop: "force", session: "new" }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/persisted spawn contract is invalid.*exactly one/);
      expect((error as Error).message).not.toMatch(/SENSITIVE_/);
      expect(fake.respawnArgs).toHaveLength(0);
      expect(fs.readFileSync(destination, "utf8")).toBe(previousBrief);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails invalid project guidance before creating or replacing a tmux session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-fail-"));
    const yaml = "agents:\n  codex:\n    cmd: codex\nsettings:\n  projectGuidance:\n    files: [guidance.md]\n";
    const config = configOf(yaml);
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await expect(manager.spawn("codex")).rejects.toThrow(/guidance\.md/);
      expect(fake.newSessionArgs).toHaveLength(0);

      fs.writeFileSync(path.join(root, "guidance.md"), "valid", "utf8");
      await manager.spawn("codex");
      fs.rmSync(path.join(root, "guidance.md"));
      await expect(manager.restart("codex", { stop: "force", session: "new" })).rejects.toThrow(/guidance\.md/);
      expect(fake.respawnArgs).toHaveLength(0);
      expect(fake.sessions.has(sessionName(workspaceHash(root), "codex"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read or deliver project guidance for terminal entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-terminal-"));
    const config = configOf(
      "terminals:\n  server:\n    cmd: sh\nsettings:\n  projectGuidance:\n    files: [missing.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await manager.spawn("server");
      expect(fake.newSessionArgs).toHaveLength(1);
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("sh");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit self-managed resume command without reading startup guidance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-self-managed-"));
    const config = configOf(
      "agents:\n  claude:\n    cmd: claude --resume existing-session\n    role: reviewer\n    instructions: must-not-be-pushed\nsettings:\n  projectGuidance:\n    files: [missing.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await manager.spawn("claude");
      const cmd = fake.newSessionArgs[0]?.at(-1);
      expect(cmd).toBe("claude --resume existing-session");
      expect(cmd).not.toContain("TACHYON PRIMER");
      expect(cmd).not.toContain("PROJECT GUIDANCE");
      expect(cmd).not.toContain("must-not-be-pushed");
      expect(cmd).not.toContain("review for quality");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps self-managed Hermes byte-exact and omits HERMES_TUI_QUERY", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-hermes-resume-"));
    const config = configOf(
      "agents:\n  hermes:\n    cmd: hermes --resume saved-session\n    role: reviewer\n    instructions: must-not-be-pushed\nsettings:\n  projectGuidance:\n    files: [missing.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    const session = sessionName(workspaceHash(root), "hermes");
    try {
      await manager.spawn("hermes");
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("hermes --resume saved-session");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI_QUERY).toBeUndefined();
      expect(fake.sessionEnv.get(session)?.HERMES_TUI).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps env-wrapped Codex resume byte-exact without reading or pushing onboarding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-codex-resume-env-"));
    const config = configOf(
      "agents:\n  codex:\n    cmd: env -u TOKEN codex resume saved-session\n    role: reviewer\n    instructions: must-not-be-pushed\nsettings:\n  projectGuidance:\n    files: [missing.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await manager.spawn("codex");
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("env -u TOKEN codex resume saved-session");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers Hermes guidance through env wrappers whose options consume operands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-hermes-env-"));
    fs.writeFileSync(path.join(root, "guidance.md"), "WRAPPED_HERMES_GUIDANCE", "utf8");
    const config = configOf(
      "agents:\n  hermes:\n    cmd: env -u TOKEN hermes\nsettings:\n  projectGuidance:\n    files: [guidance.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    const session = sessionName(workspaceHash(root), "hermes");
    try {
      await manager.spawn("hermes");
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("env -u TOKEN hermes");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI_QUERY).toContain("WRAPPED_HERMES_GUIDANCE");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI).toBe("1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read or size-check startup guidance for an agent without a prompt adapter", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-unsupported-"));
    const config = configOf(
      `agents:\n  aider:\n    cmd: aider\n    instructions: undeliverable\nsettings:\n  verify:\n    full: ${JSON.stringify(`node ${JSON.stringify("'".repeat(4_000))}`)}\n  projectGuidance:\n    files: [missing.md]\n`,
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await manager.spawn("aider");
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("aider");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers project guidance through Hermes startup env on spawn and restart, including long-brief pointers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-hermes-"));
    fs.writeFileSync(path.join(root, "guidance.md"), "HERMES_SHORT", "utf8");
    const config = configOf(
      "agents:\n  hermes:\n    cmd: hermes\nsettings:\n  projectGuidance:\n    files: [guidance.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    const session = sessionName(workspaceHash(root), "hermes");
    try {
      await manager.spawn("hermes");
      expect(fake.newSessionArgs[0]?.at(-1)).toBe("hermes");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI_QUERY).toContain("HERMES_SHORT");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI_QUERY).toContain("── TACHYON PRIMER ──");
      expect(fake.sessionEnv.get(session)?.HERMES_TUI).toBe("1");

      fs.writeFileSync(path.join(root, "guidance.md"), `HERMES_LONG_${"x".repeat(5_000)}`, "utf8");
      await manager.restart("hermes", { stop: "force", session: "new" });
      const restartedBrief = fake.sessionEnv.get(session)?.HERMES_TUI_QUERY;
      expect(restartedBrief).toContain(briefFilePath(root, "hermes"));
      expect(restartedBrief).not.toContain("HERMES_LONG_");
      expect(fs.readFileSync(briefFilePath(root, "hermes"), "utf8")).toContain("HERMES_LONG_");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit Hermes classic CLI when a startup brief must be delivered", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-hermes-cli-"));
    const config = configOf(
      "agents:\n  hermes:\n    cmd: hermes --cli\n    role: reviewer\n    instructions: review for quality\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      getMaxAgents: () => 8,
    });
    try {
      await expect(manager.spawn("hermes")).rejects.toThrow(/Hermes startup brief requires the TUI/i);
      expect(fake.newSessionArgs).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects explicit Hermes chat / query surfaces when a startup brief must be delivered", async () => {
    for (const cmd of ["hermes chat", "hermes chat -q hello", "hermes -q hello", "hermes --query hello"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-hermes-chat-"));
      const config = configOf(
        "agents:\n  hermes:\n    cmd: " + cmd + "\n    role: reviewer\n    instructions: review for quality\n",
      );
      const fake = fakeTmux();
      const manager = new AgentManager({
        tmux: fake.tmux,
        wsHash: workspaceHash(root),
        workspaceRoot: root,
        getConfig: () => config,
        getMaxAgents: () => 8,
      });
      try {
        await expect(manager.spawn("hermes"), `cmd=${cmd}`).rejects.toThrow(/Hermes startup brief requires the TUI/i);
        expect(fake.newSessionArgs, `cmd=${cmd}`).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
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
      resolveCaptureId?: (rt: string, cwd: string, configHome?: string) => Promise<string | null>;
      resolveCaptureSession?: (rt: string, cwd: string, configHome?: string, id?: string) => Promise<{ id: string; path: string } | null>;
      resolveCurrentSession?: (rt: string, cwd: string) => Promise<string | null>;
      homeDir?: () => string;
      defaultClaudeConfigHome?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      worktreeDirty?: (rec: any) => Promise<boolean>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveSpawnCwd?: (ctx: any) => Promise<{ cwd: string; worktree?: any; delegationBaseSha?: string } | null>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createForkWorktree?: (forkName: string, source: any) => Promise<{ cwd: string; worktree: any } | null>;
      seedTranscript?: (from: string, to: string) => boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      completePreparedWorktree?: (worktree: any) => Promise<void>;
      recordCanonicalDelivery?: AgentManagerOptions["recordCanonicalDelivery"];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      materializeHarness?: (ctx: { name: string; def: any }) => any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveCurrentSessionFull?: (rt: string, cwd: string, title?: string, configHome?: string) => Promise<string | null>;
      getExtraEnv?: () => Record<string, string>;
      getBridgeGeneration?: () => number;
      materializeBridgeMcp?: (name: string) => string | undefined;
      materializeBridgeMcpOpencode?: (name: string, cwd: string) => string | undefined;
      materializeBridgeMcpGrok?: (name: string) => string | undefined;
      piBridgeExtensionPath?: () => string | undefined;
      materializePiSessionDir?: (name: string) => string;
      materializeOwnershipSettings?: (name: string, opts?: {
        ownershipOnly?: boolean;
        cwd?: string;
        configHome?: string;
        statusLineCapture?: boolean;
      }) => string | undefined;
      materializeCodexSessionStartHookConfig?: (name: string, opts?: { ownershipOnly?: boolean }) => string | string[] | undefined;
      ownedSession?: (name: string, cwd: string) => { sessionId: string; transcriptPath: string } | undefined;
      notify?: (m: string, l: "warn") => void;
      mintAgentToken?: (name: string) => Record<string, string>;
      revokeAgentToken?: (name: string) => void;
      removeHarnessHome?: (name: string) => void;
      removePiSessionDir?: (name: string) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prepareDeliveryJoin?: (name: string, request: any) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      confirmDeliveryJoin?: (name: string, request: any, prepared: any, pid?: number) => Promise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      failDeliveryJoin?: (name: string, request: any, prepared: any, error: unknown) => Promise<void>;
      /** SDD 368 T14 — snapshot deny set for marker-less crash-window agents. */
      isDeliveryLifecycleDenied?: (name: string) => boolean;
      launchPreflight?: AgentManagerOptions["launchPreflight"];
      failNewSession?: boolean;
      failKillSession?: boolean;
    } = {},
  ) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-am-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const sessions = new Set<string>();
    const dead = new Set<string>();
    const sessionEnv = new Map<string, Record<string, string>>();
    const cmds: string[] = []; // last positional arg of each new-session / respawn-pane = the command
    const newSessionArgs: string[][] = []; // full args of each new-session (to assert env -e)
    const respawnArgs: string[][] = []; // full args of each respawn-pane chain (t-4d2630)
    const startArgs: string[][] = []; // chronological new-session OR respawn (prefer for env asserts)
    const paneInjections: string[] = []; // t-762940 — send-keys -l / load-buffer paste payloads
    const failRespawn = { current: false };
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = () => {
        const i = args.indexOf("-t");
        return args[i + 1].replace(/^=/, "").replace(/:$/, "");
      };
      if (args.includes("new-session")) {
        if (opts.failNewSession) throw new Error("injected downstream newSession failure");
        sessions.add(args[args.indexOf("-s") + 1]);
        applyTmuxEnvToSession(sessionEnv, args);
        cmds.push(args[args.length - 1]);
        newSessionArgs.push(args);
        startArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("respawn-pane")) {
        if (failRespawn.current) throw new Error("respawn failed");
        const t = target();
        if (!sessions.has(t)) throw new Error("can't find session");
        dead.delete(t);
        applyTmuxEnvToSession(sessionEnv, args);
        cmds.push(args[args.length - 1]);
        respawnArgs.push(args);
        startArgs.push(args);
        return { stdout: "", stderr: "" };
      }
      switch (args[2]) {
        case "has-session":
          if (!sessions.has(target())) throw new Error("can't find session");
          return { stdout: "", stderr: "" };
        case "show-environment": {
          const t = target();
          if (!sessions.has(t)) throw new Error("can't find session");
          const env = sessionEnv.get(t) ?? {};
          return {
            stdout: Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + (Object.keys(env).length ? "\n" : ""),
            stderr: "",
          };
        }
        case "kill-session":
          if (opts.failKillSession) throw new Error("injected kill failure");
          dead.delete(target());
          sessions.delete(target());
          sessionEnv.delete(target());
          return { stdout: "", stderr: "" };
        case "list-sessions":
          if (sessions.size === 0) throw new Error("no server running");
          return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
        case "list-panes":
          if (sessions.size === 0) throw new Error("no server running");
          return { stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t`).join("\n") + "\n", stderr: "" };
        case "send-keys":
          if (args.includes("-l")) paneInjections.push(args[args.length - 1]);
          return { stdout: "", stderr: "" };
        case "load-buffer": {
          // multiline primer uses load-buffer + paste-buffer (t-17d7ea)
          const file = args[args.length - 1];
          try {
            paneInjections.push(fs.readFileSync(file, "utf8"));
          } catch {
            /* ignore missing tmp */
          }
          return { stdout: "", stderr: "" };
        }
        default:
          return { stdout: "", stderr: "" };
      }
    };
    const config = parseConfig(yaml).config!;
    const ledger = new SessionLedger(ws);
    const tmux = new TmuxService(exec);
    const manager = new AgentManager({
      tmux,
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
      defaultClaudeConfigHome: opts.defaultClaudeConfigHome,
      resolveSpawnCwd: opts.resolveSpawnCwd,
      worktreeDirty: opts.worktreeDirty,
      createForkWorktree: opts.createForkWorktree,
      seedTranscript: opts.seedTranscript,
      completePreparedWorktree: opts.completePreparedWorktree,
      recordCanonicalDelivery: opts.recordCanonicalDelivery ?? (async (input) => canonicalSpawnReceipt(input.worktree, input.baseSha)),
      materializeHarness: opts.materializeHarness,
      getExtraEnv: opts.getExtraEnv,
      getBridgeGeneration: opts.getBridgeGeneration,
      materializeBridgeMcp: opts.materializeBridgeMcp,
      materializeBridgeMcpOpencode: opts.materializeBridgeMcpOpencode,
      materializeBridgeMcpGrok: opts.materializeBridgeMcpGrok,
      piBridgeExtensionPath: opts.piBridgeExtensionPath,
      materializePiSessionDir: opts.materializePiSessionDir,
      materializeOwnershipSettings: opts.materializeOwnershipSettings,
      materializeCodexSessionStartHookConfig: opts.materializeCodexSessionStartHookConfig,
      ownedSession: opts.ownedSession,
      notify: opts.notify,
      mintAgentToken: opts.mintAgentToken,
      revokeAgentToken: opts.revokeAgentToken,
      removeHarnessHome: opts.removeHarnessHome,
      removePiSessionDir: opts.removePiSessionDir,
      prepareDeliveryJoin: opts.prepareDeliveryJoin,
      confirmDeliveryJoin: opts.confirmDeliveryJoin,
      failDeliveryJoin: opts.failDeliveryJoin,
      isDeliveryLifecycleDenied: opts.isDeliveryLifecycleDenied,
      launchPreflight: opts.launchPreflight,
    });
    return { manager, ledger, sessions, dead, cmds, newSessionArgs, respawnArgs, startArgs, paneInjections, failRespawn, ws, hash };
  }

  it("refuses disabled canonical profiles before spawn, resume, restart, or bound Delivery preparation", async () => {
    let prepared = 0;
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n", {
      prepareDeliveryJoin: async () => { prepared += 1; throw new Error("must not prepare"); },
      confirmDeliveryJoin: async () => undefined,
    });
    h.manager.defOf("reviewer")!.profileLifecycle = {
      enabled: false,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await expect(h.manager.spawn("reviewer")).rejects.toThrow("canonical agent profile is disabled");
    await expect(h.manager.spawn("reviewer", { cmd: "codex" })).rejects.toThrow("canonical agent profile is disabled");
    await expect(h.manager.resume("reviewer", {
      def: { cmd: "codex", kind: "agent" },
      resume: { runtime: "codex", sessionId: "session-1" },
      cwd: h.ws,
      declared: true,
      updatedAt: "now",
    })).rejects.toThrow("canonical agent profile is disabled");
    await expect(h.manager.restart("reviewer", { stop: "force", session: "new" })).rejects.toThrow("canonical agent profile is disabled");
    await expect(h.manager.spawn("review-run", {
      deliveryJoin: {
        deliveryId: "delivery-1",
        role: "reviewer",
        ownsSubset: [],
        expectedHead: "abc",
        declaredAgent: "reviewer",
        operationId: "join-disabled",
      },
    })).rejects.toThrow("canonical agent profile is disabled");

    expect(prepared).toBe(0);
    expect(h.sessions.size).toBe(0);
    expect(h.newSessionArgs).toEqual([]);
  });

  it("SDD 368 T6 reuses the prepared Delivery worktree and never invokes fresh-worktree resolution", async () => {
    const prepared: string[] = [];
    const confirmed: string[] = [];
    let freshResolutions = 0;
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      resolveSpawnCwd: async () => { freshResolutions += 1; return null; },
      prepareDeliveryJoin: async (name, request) => {
        prepared.push(`${name}:${request.deliveryId}`);
        return {
          cwd: ws,
          worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
          reservationNonce: "nonce", segmentId: "seg-t14",
        };
      },
      confirmDeliveryJoin: async (name) => { confirmed.push(name); },
    });
    await manager.spawn("successor", {
      cmd: "claude", parent: "boss",
      deliveryJoin: { deliveryId: "d-one", role: "fixer", ownsSubset: ["src"], expectedHead: "abc", operationId: "join-1" },
    });
    expect(prepared).toEqual(["successor:d-one"]);
    expect(confirmed).toEqual(["successor"]);
    expect(freshResolutions).toBe(0);
    expect(ledger.get("successor")?.cwd).toBe(ws);
    expect(ledger.get("successor")?.worktree?.branch).toBe("tachyon/delivery");
  });

  it("SDD 368 T6 refuses unavailable joins without spawning or falling back", async () => {
    let freshResolutions = 0;
    const { manager, ledger } = resumeHarness("agents: {}\n", {
      resolveSpawnCwd: async () => { freshResolutions += 1; return null; },
      prepareDeliveryJoin: async () => { throw new Error("DELIVERY_LEASE_UNAVAILABLE"); },
      confirmDeliveryJoin: async () => undefined,
    });
    await expect(manager.spawn("successor", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-one", role: "fixer", ownsSubset: [], expectedHead: "abc", operationId: "join-2" },
    })).rejects.toThrow("DELIVERY_LEASE_UNAVAILABLE");
    expect(freshResolutions).toBe(0);
    expect(ledger.get("successor")).toBeUndefined();
  });

  it("SDD 368 T6 terminates a spawned successor when durable confirmation fails", async () => {
    const failed: string[] = [];
    const { manager, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce", segmentId: "seg-t14",
      }),
      confirmDeliveryJoin: async () => { throw new Error("confirmation lost"); },
      failDeliveryJoin: async (name) => { failed.push(name); },
    });
    await expect(manager.spawn("successor", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-one", role: "fixer", ownsSubset: [], expectedHead: "abc", operationId: "join-3" },
    })).rejects.toThrow("confirmation lost");
    expect(failed).toEqual(["successor"]);
    expect(await manager.runningAgents()).not.toContain("successor");
  });

  it("SDD 368 T6 fails visibly when reservation compensation itself fails", async () => {
    const { manager, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce", segmentId: "seg-t14",
      }),
      confirmDeliveryJoin: async () => { throw new Error("confirmation failed"); },
      failDeliveryJoin: async () => { throw new Error("reservation quarantine failed"); },
    });
    const error = await manager.spawn("successor", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-one", role: "fixer", ownsSubset: [], expectedHead: "abc", operationId: "join-4" },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain("compensation was incomplete");
    expect(error.errors.map((entry: Error) => entry.message)).toEqual(["confirmation failed", "reservation compensation failed"]);
  });

  it("SDD 368 T14 persists reverse binding after confirmed join", async () => {
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce-bind",
        segmentId: "seg-bind",
      }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("successor", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-bind", role: "fixer", ownsSubset: ["src"], expectedHead: "abc", operationId: "join-bind" },
    });
    expect(ledger.get("successor")?.delivery).toEqual({
      deliveryId: "d-bind",
      segmentId: "seg-bind",
      executionNonce: "nonce-bind",
    });
  });

  it("SDD 368 T14 binding-write failure compensates like a failed join", async () => {
    const failed: string[] = [];
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce",
        segmentId: "seg-1",
      }),
      confirmDeliveryJoin: async (name) => {
        // Pre-seed a conflicting binding so post-confirm bindDelivery refuses.
        ledger.bindDelivery(name, { deliveryId: "d-OTHER", segmentId: "seg-OTHER", executionNonce: "x" });
      },
      failDeliveryJoin: async (name) => { failed.push(name); },
    });
    // First create a row that confirm can conflict-bind against by intercepting: actually
    // confirm runs after spawnCore which creates the row; we bind a different value then
    // persistDeliveryBinding tries the join binding and fails.
    await expect(manager.spawn("successor", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-one", role: "fixer", ownsSubset: [], expectedHead: "abc", operationId: "join-bind-fail" },
    })).rejects.toThrow(/existing binding differs|Delivery join failed/);
    expect(failed).toEqual(["successor"]);
    expect(await manager.runningAgents()).not.toContain("successor");
  });

  it("SDD 368 T14 refuses generic resume and restart for Delivery-bound rows", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "s1" },
      cwd: ws,
      declared: true,
      delivery: { deliveryId: "d-1", segmentId: "seg-1", executionNonce: "n" },
    });
    await expect(manager.resume("claude", ledger.get("claude")!)).rejects.toThrow(/Delivery-bound/);
    await expect(manager.restart("claude", { stop: "force", session: "new" })).rejects.toThrow(/Delivery-bound/);
    // Invalid marker also refuses
    ledger.record("invalid", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "s2" },
      cwd: ws,
      declared: false,
      delivery: { invalid: true },
    });
    await expect(manager.resume("invalid", ledger.get("invalid")!)).rejects.toThrow(/Delivery-bound/);
    // resumeReadiness is false for marker-bound rows
    expect(await manager.resumeReadiness("claude", ledger.get("claude")!)).toBe(false);
    expect(await manager.resumeReadiness("invalid", ledger.get("invalid")!)).toBe(false);
  });

  it("SDD 368 T14 snapshot deny set blocks marker-less crash-window spawn/resume/restart/readiness before mutation", async () => {
    const denied = new Set(["crash-holder"]);
    const { manager, ledger, ws } = resumeHarness(
      "agents:\n  crash-holder:\n    cmd: claude\n    autostart: true\n",
      { isDeliveryLifecycleDenied: (name) => denied.has(name) },
    );
    // Ordinary marker-less row — only the snapshot deny set blocks it.
    ledger.record("crash-holder", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "s-crash" },
      cwd: ws,
      declared: true,
    });
    expect(ledger.get("crash-holder")?.delivery).toBeUndefined();

    // Seed transient caches; refused restart must not clear them.
    const internals = manager as unknown as {
      readinessCache: Map<string, { sessionId: string; ready: boolean }>;
      stoppingSince: Map<string, number>;
      cleanExited: Set<string>;
    };
    internals.readinessCache.set("crash-holder", { sessionId: "s-crash", ready: true });
    internals.stoppingSince.set("crash-holder", Date.now());
    internals.cleanExited.add("crash-holder");

    await expect(manager.spawn("crash-holder")).rejects.toThrow(/Delivery lifecycle is unavailable/);
    await expect(manager.resume("crash-holder", ledger.get("crash-holder")!)).rejects.toThrow(/Delivery/);
    await expect(manager.restart("crash-holder", { stop: "force", session: "new" })).rejects.toThrow(/Delivery/);
    // Caches untouched after refused restart.
    expect(internals.readinessCache.get("crash-holder")).toEqual({ sessionId: "s-crash", ready: true });
    expect(internals.stoppingSince.has("crash-holder")).toBe(true);
    expect(internals.cleanExited.has("crash-holder")).toBe(true);

    expect(await manager.resumeReadiness("crash-holder", ledger.get("crash-holder")!)).toBe(false);
    const pending = await manager.autostartPending();
    expect(pending).not.toContain("crash-holder");

    // Explicit deliveryJoin remains allowed even while the deny set is active for other names.
    let joinWs = "";
    const join = resumeHarness("agents: {}\n", {
      isDeliveryLifecycleDenied: (name) => denied.has(name),
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: joinWs,
        worktree: { path: joinWs, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "n",
        segmentId: "seg-join",
      }),
      confirmDeliveryJoin: async () => undefined,
    });
    joinWs = join.ws;
    await join.manager.spawn("recovery", {
      cmd: "claude",
      deliveryJoin: { deliveryId: "d-r", role: "fixer", ownsSubset: [], expectedHead: "abc", operationId: "join-ok" },
    });
    expect(await join.manager.runningAgents()).toContain("recovery");
  });

  it("SDD 368 T14 worktree occupancy gathers all rows and fails closed on duplicates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-occ-"));
    dirs.push(root);
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const { manager, ledger, hash } = resumeHarness("agents: {}\n");
    // Two bound rows claim the same worktree cwd → dirty/unavailable (dead), not free.
    ledger.record("a1", {
      def: { cmd: "claude", kind: "agent" },
      cwd: wt,
      declared: false,
      delivery: { deliveryId: "d-1", segmentId: "seg-a", executionNonce: "n1" },
    });
    ledger.record("a2", {
      def: { cmd: "claude", kind: "agent" },
      cwd: wt,
      declared: false,
      delivery: { deliveryId: "d-1", segmentId: "seg-b", executionNonce: "n2" },
    });
    // Probe occupancy via reuse path's public surface when possible; fall back to private method.
    const occ = await (manager as unknown as {
      findLedgerWorktreeOccupant: (p: string) => Promise<{ agent: string; state: "live" | "dead"; cwd: string } | undefined>;
    }).findLedgerWorktreeOccupant(wt);
    expect(occ?.state).toBe("dead");
    expect(["a1", "a2"]).toContain(occ?.agent);
    void hash;
  });

  it("SDD 368 T14/R3 cwd-drifted bound worktree.path still dirties public occupancy/reuse", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cwd-drift-"));
    dirs.push(root);
    const deliveryWt = path.join(root, "delivery-wt");
    const driftedCwd = path.join(root, "elsewhere");
    fs.mkdirSync(deliveryWt, { recursive: true });
    fs.mkdirSync(driftedCwd, { recursive: true });
    const { manager, ledger } = resumeHarness("agents: {}\n");
    // Bound row: worktree.path names the Delivery worktree, but cwd drifted elsewhere.
    // Pre-R3 occupancy only scanned rec.cwd and would miss this occupant.
    ledger.record("drifter", {
      def: { cmd: "claude", kind: "agent" },
      cwd: driftedCwd,
      worktree: {
        path: deliveryWt,
        branch: "tachyon/d",
        tachyonCreatedBranch: true,
        baseRef: "abc",
        createdAt: "t0",
      },
      declared: false,
      delivery: { deliveryId: "d-drift", segmentId: "seg-d", executionNonce: "n-d" },
    });
    const publicOcc = await manager.worktreeOccupant(deliveryWt);
    expect(publicOcc).toEqual(expect.objectContaining({
      state: "dirty",
      agent: "drifter",
    }));
    // Drifted cwd alone must not free the delivery worktree for a second writer.
    expect(await manager.worktreeOccupant(driftedCwd)).toEqual(expect.objectContaining({
      state: "dirty",
      agent: "drifter",
    }));
    void ledger;
  });

  it.each([
    ["codex", "--sandbox read-only"],
    ["claude", "--permission-mode plan"],
    ["grok", "--permission-mode plan"],
  ])("SDD 368 T10 applies and persists the measured reviewer-safe %s command", async (runtime, expectedFlag) => {
    const { manager, ledger, cmds, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn(`reviewer-${runtime}`, { cmd: runtime, parent: "boss",
      deliveryJoin: { deliveryId: "d-review", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: `join-${runtime}` } });
    expect(cmds.at(-1)).toContain(expectedFlag);
    expect(ledger.get(`reviewer-${runtime}`)?.def?.cmd).toContain(expectedFlag);
  });

  it.each([
    ["pi", "pi --exclude-tools bash,edit,write"],
    ["env MODE=review pi -- positional", "env MODE=review pi --exclude-tools bash,edit,write -- positional"],
    ["npx --yes pi -- positional", "npx --yes pi --exclude-tools bash,edit,write -- positional"],
  ])("SDD 404: injects and persists Pi Delivery reviewer safety structurally: %s", async (cmd, effective) => {
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "pi-safe", segmentId: "seg-pi" }),
      confirmDeliveryJoin: async () => undefined,
      materializeHarness: ({ name, def }) => adapterFor(def.cmd)?.runtime === "pi"
        ? { home: `/private/pi/${name}`, env: { PI_CODING_AGENT_DIR: `/private/pi/${name}`, PI_CODING_AGENT_SESSION_DIR: `/private/pi/${name}/sessions` }, args: [] }
        : null,
      materializePiSessionDir: (name) => `/private/pi/${name}/sessions`,
    });
    await manager.spawn("pi-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "pi-review" } });
    expect(ledger.get("pi-reviewer")?.def?.cmd).toBe(effective);
  });

  it("SDD 404: preserves an explicit canonical Pi reviewer denylist byte-for-byte", async () => {
    const cmd = "pi --exclude-tools write,bash,edit --thinking high";
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "pi-safe", segmentId: "seg-pi" }),
      confirmDeliveryJoin: async () => undefined,
      materializeHarness: ({ name }) => ({ home: `/private/pi/${name}`, env: { PI_CODING_AGENT_DIR: `/private/pi/${name}`, PI_CODING_AGENT_SESSION_DIR: `/private/pi/${name}/sessions` }, args: [] }),
      materializePiSessionDir: (name) => `/private/pi/${name}/sessions`,
    });
    await manager.spawn("pi-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "pi-review" } });
    expect(ledger.get("pi-reviewer")?.def?.cmd).toBe(cmd);
  });

  it.each([
    ["codex --sandbox \"read-only\"", "codex --sandbox \"read-only\""],
    ["codex -s=read-only", "codex -s=read-only"],
    ["codex -sread-only", "codex -sread-only"],
    ["claude --permission-mode 'plan'", "claude --permission-mode 'plan'"],
    ["grok --permission-mode=plan", "grok --permission-mode=plan"],
  ])("SDD 368 T10 preserves an already-safe literal reviewer command byte-for-byte: %s", async (cmd, expected) => {
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("literal-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "literal" } });
    expect(ledger.get("literal-reviewer")?.def?.cmd).toBe(expected);
  });

  it.each([
    ["codex -- positional", "codex --sandbox read-only -- positional"],
    ["env MODE=review codex -- positional", "env MODE=review codex --sandbox read-only -- positional"],
    ["npx --yes codex -- positional", "npx --yes codex --sandbox read-only -- positional"],
    ["npx -p @openai/codex codex -- positional", "npx -p @openai/codex codex --sandbox read-only -- positional"],
    ["npx --package=@openai/codex codex -- positional", "npx --package=@openai/codex codex --sandbox read-only -- positional"],
    ["env --argv0 reviewer codex -- positional", "env --argv0 reviewer codex --sandbox read-only -- positional"],
    ["env -a codex -f vars.env codex -- positional", "env -a codex -f vars.env codex --sandbox read-only -- positional"],
    ["pnpx --allow-build native-addon codex -- positional", "pnpx --allow-build native-addon codex --sandbox read-only -- positional"],
  ])("SDD 368 T10 inserts reviewer safety immediately after the structural runtime token: %s", async (cmd, effective) => {
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("structural-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "structural" } });
    expect(ledger.get("structural-reviewer")?.def?.cmd).toBe(effective);
  });

  it.each([
    "codex --sandbox workspace-write",
    "codex -s danger-full-access",
    "codex -sworkspace-write",
    "codex --full-auto",
    "codex -sread-only --sandbox read-only",
    "codex --sandbox=read-only -s read-only",
    "codex --dangerously-bypass-approvals-and-sandbox",
    "claude --permission-mode acceptEdits",
    "claude --dangerously-skip-permissions",
    "grok --permission-mode default",
    "grok --dangerously-skip-permissions",
    "grok --always-approve",
    "claude --permission-mode plan --permission-mode=plan",
    "grok --permission-mode=plan --permission-mode plan",
    "pi --tools read,grep,find,ls",
    "pi --no-tools",
    "pi --no-builtin-tools",
    "pi --exclude-tools bash,edit",
    "pi --exclude-tools bash,edit,write --exclude-tools read",
    "pi --exclude-tools=bash,edit,write",
    "pi -xt bash,edit",
  ])("SDD 368/403 refuses conflicting reviewer command before reservation or spawn: %s", async (cmd) => {
    let prepared = false;
    const { manager, cmds } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async () => { prepared = true; throw new Error("must not prepare"); },
      confirmDeliveryJoin: async () => undefined,
    });
    await expect(manager.spawn("unsafe-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d-review", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "unsafe" } }))
      .rejects.toThrow(/reviewer command/);
    expect(prepared).toBe(false);
    expect(cmds).toHaveLength(0);
  });

  it.each([
    "codex | tee /tmp/review", "codex && sh", "codex; sh", "codex > /tmp/review",
    "codex $(printf unsafe)", "codex $REVIEW_MODE", "codex *.md",
    "env -S 'codex --'", "env --unknown codex", "env -a", "env -f codex",
    "npx -c codex", "npx --unknown codex", "npx -p", "npx --package= codex",
    "pnpx --shell-mode codex", "pnpx --unknown codex", "bunx --unknown codex", "bunx -p",
    "pnpx --allow-build", "pnpx --allow-build --package pkg codex", "pnpx --allow-build= codex",
  ])("SDD 368 T10 refuses ambiguous reviewer shell structure before reservation: %s", async (cmd) => {
    let prepared = false;
    const { manager } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async () => { prepared = true; throw new Error("must not prepare"); }, confirmDeliveryJoin: async () => undefined,
    });
    await expect(manager.spawn("ambiguous-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "ambiguous" } }))
      .rejects.toThrow(/structurally ambiguous|shell expansion/);
    expect(prepared).toBe(false);
  });

  it.each([
    "env env codex --",
    "env MODE=review env codex --",
    "env -i --argv0 reviewer /usr/bin/env codex --",
    "env env npx codex --",
  ])("SDD 368 T10 R3 refuses nested env before reservation or spawn: %s", async (cmd) => {
    let prepared = false;
    const { manager, cmds } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async () => { prepared = true; throw new Error("must not prepare"); },
      confirmDeliveryJoin: async () => undefined,
    });
    await expect(manager.spawn("nested-env-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "nested-env" } }))
      .rejects.toThrow(/structurally ambiguous/);
    expect(prepared).toBe(false);
    expect(cmds).toHaveLength(0);
  });

  it.each([
    "npx codex@0.144.1 -- positional",
    "npx @openai/codex -- positional",
    "env MODE=review pnpx @scope/reviewer-cli -- positional",
    "bunx custom-reviewer@latest -- positional",
  ])("SDD 368 T10 A3 refuses package specs whose effective adapter cannot be proven: %s", async (cmd) => {
    let prepared = false;
    const { manager } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async () => { prepared = true; throw new Error("must not prepare"); }, confirmDeliveryJoin: async () => undefined,
    });
    await expect(manager.spawn("package-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "package" } }))
      .rejects.toThrow(/cannot prove the runtime adapter/);
    expect(prepared).toBe(false);
  });

  it.each([
    ["custom-review-runtime", false],
    ["env MODE=review custom-review-runtime", false],
    ["npx codex -- positional", true],
    ["npx opencode -- positional", false],
  ])("SDD 368 T10 A3 preserves direct/env unknown and known literal launcher policy: %s", async (cmd, sandboxed) => {
    const advisories: string[] = [];
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      notify: (message) => { advisories.push(message); },
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("policy-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "policy" } });
    const effective = ledger.get("policy-reviewer")?.def?.cmd ?? "";
    expect(effective.includes("--sandbox read-only")).toBe(sandboxed);
    expect(advisories.length > 0).toBe(!sandboxed);
  });

  it("SDD 368 T10 treats bypass-looking text after -- and single-quoted control text as positional data", async () => {
    const cmd = "codex -- '--dangerously-bypass-approvals-and-sandbox | && ; >'";
    const { manager, ledger, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("positional-reviewer", { cmd,
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "positional" } });
    expect(ledger.get("positional-reviewer")?.def?.cmd).toBe("codex --sandbox read-only -- '--dangerously-bypass-approvals-and-sandbox | && ; >'");
  });

  it("SDD 368 T10 real env and deterministic wrappers pass the inserted sandbox argv to Codex", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-reviewer-bin-"));
    const executable = path.join(bin, "codex");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_FILE\"\n", { mode: 0o755 });
    const wrapper = "#!/bin/sh\ncase \"$(basename \"$0\")\" in\n  npx) while [ $# -gt 0 ]; do case \"$1\" in -p|--package|-w|--workspace) shift 2;; --package=*|--workspace=*|-y|--yes|--no|--workspaces|--include-workspace-root) shift;; --) shift; break;; *) break;; esac; done;;\n  pnpx) while [ $# -gt 0 ]; do case \"$1\" in --allow-build|--package|--reporter) shift 2;; --allow-build=*|--package=*|--reporter=*) shift;; *) break;; esac; done;;\n  bunx) while [ $# -gt 0 ]; do case \"$1\" in -p|--package) shift 2;; --package=*|--bun|--no-install|--verbose|--silent) shift;; *) break;; esac; done;;\nesac\nexec \"$@\"\n";
    for (const name of ["npx", "pnpx", "bunx"]) fs.writeFileSync(path.join(bin, name), wrapper, { mode: 0o755 });
    const { manager, cmds, ws } = resumeHarness("agents: {}\n", {
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    const cases = [
      "env --argv0 reviewer codex -- positional",
      "npx -p @openai/codex codex -- positional",
      "pnpx --allow-build native-addon --package @openai/codex --reporter append-only codex -- positional",
      "bunx --no-install -p @openai/codex codex -- positional",
    ];
    for (const [index, raw] of cases.entries()) {
      const capture = path.join(bin, `argv-${index}.txt`);
      await manager.spawn(`argv-reviewer-${index}`, { cmd: raw,
        deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: `argv-${index}` } });
      execFileSync("/bin/sh", ["-c", cmds.at(-1)!], { env: { ...process.env, CAPTURE_FILE: capture, PATH: `${bin}:${process.env.PATH}` } });
      expect(fs.readFileSync(capture, "utf8").trim().split("\n").slice(0, 4)).toEqual(["--sandbox", "read-only", "--", "positional"]);
    }
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it("SDD 368 T10 leaves unsupported reviewer runtimes unchanged with an advisory", async () => {
    const advisories: string[] = [];
    const { manager, cmds, ws } = resumeHarness("agents: {}\n", {
      notify: (message) => { advisories.push(message); },
      prepareDeliveryJoin: async (_name, request) => ({ cwd: ws,
        worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" },
        reservationNonce: "nonce", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
    });
    await manager.spawn("reviewer-unknown", { cmd: "custom-review-runtime",
      deliveryJoin: { deliveryId: "d-review", role: "reviewer", ownsSubset: [], expectedHead: "abc", operationId: "unknown" } });
    expect(cmds.at(-1)).toContain("custom-review-runtime");
    expect(cmds.at(-1)).not.toMatch(/--sandbox|--permission-mode/);
    expect(advisories).toEqual([expect.stringContaining("no measured shell-level read-only mode")]);
  });

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
    expect(cmds[0]).toContain("codex '");
    expect(cmds[0]).toContain("── TACHYON PRIMER ──");
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
    const { manager, respawnArgs } = resumeHarness("agents:\n  codex:\n    cmd: codex\n    env:\n      TACHYON_AGENT_NAME: wrong\n");
    await manager.spawn("codex");
    respawnArgs.length = 0;
    await manager.restart("codex", { stop: "force", session: "new" });
    // t-4d2630: live session → set-environment name/value tokens (not new-session -e KEY=value)
    const args = respawnArgs.at(-1)!;
    expect(args).toContain("respawn-pane");
    const nameIdx = args.indexOf("TACHYON_AGENT_NAME");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(args[nameIdx + 1]).toBe("codex");
    expect(args).not.toContain("wrong");
  });

  it("t-4d2630: restart unsets launch env keys omitted from the desired env (no stale inherit)", async () => {
    // Spawn with a transient override present; drop it before restart. Respawn must
    // `set-environment -u` the vanished key — set-only would leave the old session value.
    let extra: Record<string, string> = { ANTHROPIC_BASE_URL: "http://stale.example", KEEP_ME: "yes" };
    const { manager, respawnArgs, newSessionArgs } = resumeHarness(
      "agents:\n  codex:\n    cmd: codex\n",
      { getExtraEnv: () => ({ ...extra }) },
    );
    await manager.spawn("codex");
    expect(envFromTmuxArgs(newSessionArgs.at(-1)!).ANTHROPIC_BASE_URL).toBe("http://stale.example");

    extra = { KEEP_ME: "yes" }; // ANTHROPIC_BASE_URL intentionally omitted on restart
    respawnArgs.length = 0;
    await manager.restart("codex", { stop: "force", session: "new" });
    const args = respawnArgs.at(-1)!;
    expect(args).toContain("respawn-pane");
    expect(unsetEnvKeysFromTmuxArgs(args)).toContain("ANTHROPIC_BASE_URL");
    const env = envFromTmuxArgs(args);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.TACHYON_AGENT_NAME).toBe("codex");
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

    await expect(manager.transcriptPathOf("codex")).resolves.toEqual({
      path: `${ws}/rollout-codex-id.jsonl`, runtime: "codex", sessionId: "codex-id",
    });
  });

  it("t-0b2f30: transcriptPathOf resolves OpenCode storage as a session-shaped Activity path", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", {
      resolveCaptureSession: async (_rt, _cwd, configHome, id) =>
        id === "ses_agent" && configHome?.endsWith(".local/share") ? { id, path: `${ws}/data/opencode/storage` } : null,
      homeDir: () => `${ws}/home`,
      fileExists: (p) => p === `${ws}/data/opencode/storage`,
    });
    await manager.spawn("opencode");
    const rec = ledger.get("opencode")!;
    ledger.record("opencode", { ...rec, resume: { ...rec.resume!, sessionId: "ses_agent" } });

    await expect(manager.transcriptPathOf("opencode")).resolves.toEqual({
      path: `${ws}/data/opencode/storage/ses_agent.jsonl`, runtime: "opencode", sessionId: "ses_agent",
    });
  });

  it("t-0b2f30: runtimeConfigHome's opencode branch honors an ambient XDG_DATA_HOME override", async () => {
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/custom/xdg-data";
    try {
      let seenConfigHome: string | undefined;
      const { manager, ledger, ws } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", {
        resolveCaptureSession: async (_rt, _cwd, configHome, id) => {
          seenConfigHome = configHome;
          return id === "ses_agent" ? { id, path: `${ws}/data/opencode/storage` } : null;
        },
        homeDir: () => `${ws}/home`,
        fileExists: (p) => p === `${ws}/data/opencode/storage`,
      });
      await manager.spawn("opencode");
      const rec = ledger.get("opencode")!;
      ledger.record("opencode", { ...rec, resume: { ...rec.resume!, sessionId: "ses_agent" } });

      await expect(manager.transcriptPathOf("opencode")).resolves.toEqual({
        path: `${ws}/data/opencode/storage/ses_agent.jsonl`, runtime: "opencode", sessionId: "ses_agent",
      });
      expect(seenConfigHome).toBe("/custom/xdg-data"); // NOT the hardcoded `${ws}/home/.local/share`
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });

  it("t-0b2f30: two same-cwd opencode agents refuse newest-by-cwd guessing (shared config home, no ownership fallback)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n  opencode2:\n    cmd: opencode\n", {
      resolveCaptureSession: async () => ({ id: "sibling", path: `${ws}/data/opencode/storage` }),
      fileExists: () => true,
    });
    await manager.spawn("opencode");
    await manager.spawn("opencode2");
    const rec = ledger.get("opencode")!;
    ledger.record("opencode", { ...rec, resume: { ...rec.resume!, sessionId: "" } });
    const rec2 = ledger.get("opencode2")!;
    ledger.record("opencode2", { ...rec2, resume: { ...rec2.resume!, sessionId: "" } });

    // Both agents compute the same (hardcoded-less) configHome and share cwd → refused, not guessed, for either.
    await expect(manager.transcriptPathOf("opencode", { live: true })).resolves.toBeUndefined();
    await expect(manager.transcriptPathOf("opencode2", { live: true })).resolves.toBeUndefined();
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

    await expect(manager.transcriptPathOf("codex", { live: true })).resolves.toEqual({
      path: `${ws}/${OWNED}.jsonl`, runtime: "codex", sessionId: OWNED,
    });

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

    await manager.rehydrateFromLedger();

    expect(ledger.get("codex")?.resume?.configHome).toBe("/home/test/.codex");
    await expect(manager.transcriptPathOf("codex", { live: true })).resolves.toEqual({
      path: `${ws}/rollout-codex-id.jsonl`, runtime: "codex", sessionId: "codex-id",
    });
  });

  it("Hermes live Activity follows an in-TUI /resume past the captured session id", async () => {
    const homes: Array<string | undefined> = [];
    const { manager, ledger, ws } = resumeHarness("agents:\n  hermes:\n    cmd: hermes\n", {
      resolveCaptureId: async (_runtime, _cwd, configHome) => {
        homes.push(configHome);
        return "resumed-current";
      },
      fileExists: () => true,
    });
    const configHome = path.join(ws, ".tachyon", "bridge-mcp", "hermes.hermes");
    ledger.record("hermes", {
      def: { cmd: "hermes", kind: "agent" },
      resume: { runtime: "hermes", sessionId: "captured-old", configHome },
      cwd: ws,
      declared: true,
      updatedAt: "t",
    });

    await expect(manager.transcriptPathOf("hermes")).resolves.toEqual({
      path: path.join(configHome, "state.db"), runtime: "hermes", sessionId: "captured-old",
    });
    await expect(manager.transcriptPathOf("hermes", { live: true })).resolves.toEqual({
      path: path.join(configHome, "state.db"), runtime: "hermes", sessionId: "resumed-current",
    });
    expect(homes).toEqual([configHome]);
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

  it("spec 240: rehydrateFromLedger backfills a missing configHome on a pre-240 row (locks it before any toggle)", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "x" }, cwd: "/repo", declared: true });
    await manager.rehydrateFromLedger();
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
    await manager.restart("claude", { stop: "force", session: "new" });
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

  it("deterministic soul preflight preserves a crashed pane, ledger and postmortem with zero resource residue", async () => {
    let worktrees = 0;
    let tokens = 0;
    let harnesses = 0;
    const { manager, ledger, sessions, dead, ws, hash } = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n    soul: true\n", {
      resolveSpawnCwd: async () => { worktrees++; return null; },
      mintAgentToken: () => { tokens++; return {}; },
      materializeHarness: () => { harnesses++; return undefined; },
    });
    const session = `tachyon-${hash}-reviewer`;
    sessions.add(session);
    dead.add(session);
    const identity = { soul: { source: ".tachyon/agents/reviewer/SOUL.md", profileId: "123e4567-e89b-42d3-a456-426614174000", sha256: "a".repeat(64), chars: 5, bytes: 5, channel: "startup-argument" as const, state: "offered" as const, offeredAt: new Date(0).toISOString() }, health: "offered" as const };
    ledger.record("reviewer", { def: { cmd: "codex", kind: "agent", soul: true }, resume: { runtime: "codex", sessionId: "prior" }, cwd: ws, declared: true, identity });
    const postmortem = (manager as unknown as { postmortemOutput: Map<string, { text: string; truncated: boolean; maxLines: number; maxBytes: number }> }).postmortemOutput;
    postmortem.set("reviewer", { text: "prior crash output", truncated: false, maxLines: 1000, maxBytes: 65_536 });

    await expect(manager.spawn("reviewer")).rejects.toMatchObject({ code: "soul/missing" });
    expect(sessions.has(session)).toBe(true);
    expect(dead.has(session)).toBe(true);
    expect(ledger.get("reviewer")?.identity).toEqual(identity);
    expect(postmortem.get("reviewer")?.text).toBe("prior crash output");
    expect({ worktrees, tokens, harnesses }).toEqual({ worktrees: 0, tokens: 0, harnesses: 0 });
    expect(fs.existsSync(path.join(ws, ".tachyon", "agent-profile-transactions", "launch-reservations"))).toBe(false);
  });

  it("failed human restart preserves the live session and prior offered identity", async () => {
    const { manager, ledger, sessions, respawnArgs, ws, hash } = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n    soul: true\n");
    const profile = path.join(ws, ".tachyon", "agents", "reviewer");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profile, "SOUL.md"), "Exact identity", { mode: 0o600 });
    fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "reviewer", state: "active" }), { mode: 0o600 });
    await manager.spawn("reviewer");
    const before = structuredClone(ledger.get("reviewer")?.identity);
    fs.renameSync(path.join(profile, "SOUL.md"), path.join(profile, "SOUL.removed.md"));

    await expect(manager.restart("reviewer", { stop: "force", session: "new" })).rejects.toMatchObject({ code: "soul/missing" });
    expect(sessions.has(`tachyon-${hash}-reviewer`)).toBe(true);
    expect(respawnArgs).toEqual([]);
    expect(ledger.get("reviewer")?.identity).toEqual(before);
    expect(fs.readdirSync(path.join(ws, ".tachyon", "agent-profile-transactions", "launch-reservations"))).toEqual([]);
  });

  it("cleans an already-created soul reservation when downstream session launch fails", async () => {
    const { manager, ws } = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n    soul: true\n", { failNewSession: true });
    const profile = path.join(ws, ".tachyon", "agents", "reviewer");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profile, "SOUL.md"), "Exact identity", { mode: 0o600 });
    fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "reviewer", state: "active" }), { mode: 0o600 });

    await expect(manager.spawn("reviewer")).rejects.toThrow("injected downstream newSession failure");
    expect(fs.readdirSync(path.join(ws, ".tachyon", "agent-profile-transactions", "launch-reservations"))).toEqual([]);
  });

  it("holds a declared soul reservation until Delivery preparation and launch settle", async () => {
    let finish!: (prepared: { cwd: string; worktree: { path: string; branch: string; tachyonCreatedBranch: boolean; baseRef: string; createdAt: string }; reservationNonce: string; segmentId: string }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>((resolve) => { finish = resolve; });
    const { manager, ws } = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n    soul: true\n", {
      prepareDeliveryJoin: async () => pending,
      confirmDeliveryJoin: async () => undefined,
    });
    const profile = path.join(ws, ".tachyon", "agents", "reviewer");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profile, "SOUL.md"), "Exact identity", { mode: 0o600 });
    fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "reviewer", state: "active" }), { mode: 0o600 });

    const launch = manager.spawn("review-run", {
      deliveryJoin: { deliveryId: "delivery-1", role: "reviewer", ownsSubset: [], expectedHead: "abc", declaredAgent: "reviewer", operationId: "join-1" },
    });
    const reservations = path.join(ws, ".tachyon", "agent-profile-transactions", "launch-reservations");
    await vi.waitFor(() => expect(fs.readdirSync(reservations)).toHaveLength(1));
    finish({ cwd: ws, worktree: { path: ws, branch: "tachyon/delivery", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "now" }, reservationNonce: "nonce", segmentId: "segment" });
    await launch;
    expect(fs.readdirSync(reservations)).toEqual([]);
  });

  it("resume() spawns the runtime's resume command and persists the id", async () => {
    const { manager, ledger, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      newSessionId: () => "uuid-1",
    });
    await manager.spawn("claude"); // mint
    await manager.kill("claude"); // simulate process/session gone
    const { compositor, soulResolver } = soulLifecycleBypassSpies(manager);
    compositor.mockClear();
    const rec = { def: { cmd: "claude --permission-mode plan", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "uuid-1" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("claude", rec);
    const oracle = soulLegacyLifecycleCase("resume-command");
    expect(cmds.at(-1)).toBe(oracle.bytes);
    expect(ledger.get("claude")!.resume!.sessionId).toBe("uuid-1");
    expect(compositor).not.toHaveBeenCalled();
    expect(soulResolver).not.toHaveBeenCalled();
    expect(oracle.sendKeys).toEqual([]);
  });

  it("t-4d2630: resume with an existing session uses respawn-pane -k (not kill+new)", async () => {
    const { manager, cmds, respawnArgs, newSessionArgs, hash } = resumeHarness(
      "agents:\n  claude:\n    cmd: claude\n",
      { fileExists: () => true },
    );
    await manager.spawn("claude");
    const beforeNew = newSessionArgs.length;
    respawnArgs.length = 0;
    await manager.resume("claude", {
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: "claude" as const, sessionId: "sid" },
      cwd: "/ws",
      declared: true,
      updatedAt: "t",
    });
    expect(respawnArgs).toHaveLength(1);
    expect(respawnArgs[0]).toContain("respawn-pane");
    expect(respawnArgs[0]).toContain("-k");
    expect(respawnArgs[0]).toContain(`=tachyon-${hash}-claude:`);
    expect(newSessionArgs.length).toBe(beforeNew);
    expect(cmds.at(-1)).toContain("--resume sid");
  });

  it("t-4d2630: resume falls back to new-session when respawn fails", async () => {
    const { manager, respawnArgs, newSessionArgs, failRespawn } = resumeHarness(
      "agents:\n  claude:\n    cmd: claude\n",
      { fileExists: () => true },
    );
    await manager.spawn("claude");
    failRespawn.current = true;
    const beforeNew = newSessionArgs.length;
    await manager.resume("claude", {
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: "claude" as const, sessionId: "sid" },
      cwd: "/ws",
      declared: true,
      updatedAt: "t",
    });
    expect(respawnArgs).toHaveLength(0);
    expect(newSessionArgs.length).toBe(beforeNew + 1);
    expect(newSessionArgs.at(-1)!.at(-1)).toContain("claude --resume sid");
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
    await manager.restart("claude", { stop: "force", session: "new" });
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

  it("388: rebind readiness probes fresh without weakening the ordinary negative cache", async () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    let transcriptPresent = false;
    let transcriptProbes = 0;
    const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: () => {
        transcriptProbes++;
        return transcriptPresent;
      },
    });
    const record = {
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: "claude" as const, sessionId },
      cwd: h.ws,
      declared: true,
      updatedAt: "t",
    };

    expect(await h.manager.resumeReadiness("claude", record)).toBe(false);
    expect(transcriptProbes).toBe(1);

    transcriptPresent = true;
    expect(await h.manager.resumeReadiness("claude", record)).toBe(false);
    expect(transcriptProbes).toBe(1);

    expect(await h.manager.rebindResumeReadiness("claude", record)).toEqual({ kind: "ready" });
    expect(transcriptProbes).toBe(2);

    expect(await h.manager.resumeReadiness("claude", record)).toBe(false);
    expect(transcriptProbes).toBe(2);
  });

  it("388: rebind readiness permanently denies Delivery and snapshot-owned rows without resolving", async () => {
    const snapshotDenied = new Set(["snapshot-owned"]);
    let resolutionProbes = 0;
    let transcriptProbes = 0;
    const h = resumeHarness(
      "agents:\n  delivery-owned:\n    cmd: claude\n  snapshot-owned:\n    cmd: claude\n",
      {
        isDeliveryLifecycleDenied: (name) => snapshotDenied.has(name),
        resolveCurrentSession: async () => {
          resolutionProbes++;
          return "44444444-4444-4444-4444-444444444444";
        },
        fileExists: () => {
          transcriptProbes++;
          return true;
        },
      },
    );
    const deliveryRecord = {
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: "claude" as const, sessionId: "delivery-session" },
      cwd: h.ws,
      declared: true,
      updatedAt: "t",
      delivery: { deliveryId: "delivery-1", segmentId: "segment-1", executionNonce: "nonce-1" },
    };
    const snapshotRecord = {
      def: { cmd: "claude", kind: "agent" as const },
      resume: { runtime: "claude" as const, sessionId: "snapshot-session" },
      cwd: h.ws,
      declared: true,
      updatedAt: "t",
    };

    expect(await h.manager.rebindResumeReadiness("delivery-owned", deliveryRecord)).toMatchObject({ kind: "denied" });
    expect(await h.manager.rebindResumeReadiness("snapshot-owned", snapshotRecord)).toMatchObject({ kind: "denied" });
    expect(resolutionProbes).toBe(0);
    expect(transcriptProbes).toBe(0);
  });

  it("resume() resolves a capture runtime's id from disk", async () => {
    const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCaptureId: async () => "captured-id",
    });
    const rec = { def: { cmd: "codex", kind: "agent" as const }, resume: { runtime: "codex" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("codex", rec);
    expect(cmds.at(-1)).toBe("codex resume captured-id");
  });

  it("default resume does not paste the 363 primer (all runtimes; re-attach only)", async () => {
    const { manager, paneInjections } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCaptureId: async () => "captured-id",
    });
    const rec = { def: { cmd: "codex", kind: "agent" as const }, resume: { runtime: "codex" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("codex", rec);
    const joined = paneInjections.join("\n");
    expect(joined).not.toContain("── TACHYON PRIMER ──");
    expect(joined).not.toContain("── END BEFORE FINISHING ──");
    expect(paneInjections).toEqual([]);
  });

  it("t-762940: resume({ injectPrimer: false }) remains a no-op paste (rebind / explicit)", async () => {
    const { manager, paneInjections, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --model sonnet\n", {
      fileExists: () => true,
    });
    const rec = { def: { cmd: "claude --model sonnet", kind: "agent" as const }, resume: { runtime: "claude" as const, sessionId: "session-a" }, cwd: "/ws", declared: true, updatedAt: "t" };
    const { compositor, soulResolver } = soulLifecycleBypassSpies(manager);
    await manager.resume("claude", rec, { injectPrimer: false });
    const oracle = soulLegacyLifecycleCase("host-rebind-command");
    expect(cmds.at(-1)).toBe(oracle.bytes);
    expect(paneInjections).toEqual(oracle.sendKeys);
    expect(compositor).not.toHaveBeenCalled();
    expect(soulResolver).not.toHaveBeenCalled();
  });

  it("resume({ injectPrimer: true }) opt-in still pastes the 363 primer", async () => {
    const { manager, paneInjections } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
      resolveCaptureId: async () => "captured-id",
    });
    const rec = { def: { cmd: "codex", kind: "agent" as const }, resume: { runtime: "codex" as const, sessionId: "" }, cwd: "/ws", declared: true, updatedAt: "t" };
    await manager.resume("codex", rec, { injectPrimer: true });
    const joined = paneInjections.join("\n");
    expect(joined).toContain("── TACHYON PRIMER ──");
    expect(joined).toContain("── END BEFORE FINISHING ──");
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

  it("SDD 405/408: refuses a Pi Fork while its Pi source is live", async () => {
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const forkId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sourcePath = "/private/pi/pi-a/sessions/source transcript.jsonl";
    const ids = [sourceId, forkId];
    const piPrivate = {
      materializeHarness: ({ name }: { name: string }) => ({
        home: `/private/pi/${name}`,
        env: {
          PI_CODING_AGENT_DIR: `/private/pi/${name}`,
          PI_CODING_AGENT_SESSION_DIR: `/private/pi/${name}/sessions`,
        },
        args: [],
      }),
      materializePiSessionDir: (name: string) => `/private/pi/${name}/sessions`,
    };
    const { manager, ledger, cmds, ws } = resumeHarness("agents:\n  pi-a:\n    cmd: pi\n", {
      newSessionId: () => ids.shift()!,
      resolveCaptureSession: async (_rt, cwd, home, id) => {
        if (id === sourceId && cwd === ws && home === "/private/pi/pi-a/sessions") return { id: sourceId, path: sourcePath };
        if (id === forkId && cwd === ws && home === "/private/pi/pi-a-fork-1/sessions") {
          return { id: forkId, path: "/private/pi/pi-a-fork-1/sessions/fork.jsonl" };
        }
        return null;
      },
      ownedSession: (name, cwd) => name === "pi-a" && cwd === ws
        ? { sessionId: sourceId, transcriptPath: sourcePath }
        : undefined,
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
      piBridgeExtensionPath: () => "/immutable/pi-bridge-extension.mjs",
      ...piPrivate,
    });
    await manager.spawn("pi-a");
    const plan = await manager.planFork("pi-a");
    expect(plan).toMatchObject({ source: "pi-a", forkName: "pi-a-fork-1", sourceId, runtime: "pi" });
    const starts = cmds.length;

    await expect(manager.commitFork(plan)).rejects.toThrow(
      "Pi OAuth safety currently permits one live Pi agent per workspace; stop 'pi-a' first",
    );
    expect(cmds).toHaveLength(starts);
    expect(ledger.get("pi-a-fork-1")).toBeUndefined();
    expect(ledger.get("pi-a")?.resume?.sessionId).toBe(sourceId);
  });

  it("SDD 405: Pi Fork refuses absent or mismatched positive ownership before new side effects", async () => {
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ownership: { sessionId: string; transcriptPath: string } | undefined;
    let resolvePath = "/private/pi-a/sessions/source.jsonl";
    const { manager, cmds } = resumeHarness("agents:\n  pi-a:\n    cmd: pi\n", {
      newSessionId: () => sourceId,
      resolveCaptureSession: async () => ({ id: sourceId, path: resolvePath }),
      ownedSession: () => ownership,
      materializeHarness: ({ name }) => ({ home: `/private/${name}`, env: {}, args: [] }),
      materializePiSessionDir: (name) => `/private/${name}/sessions`,
    });
    await manager.spawn("pi-a");
    const starts = cmds.length;
    await expect(manager.planFork("pi-a")).rejects.toThrow("ownership has not been observed");
    ownership = { sessionId: sourceId, transcriptPath: "/different/source.jsonl" };
    await expect(manager.planFork("pi-a")).rejects.toThrow("does not resolve to one exact transcript");
    expect(cmds).toHaveLength(starts);
  });

  it("planFork: treats a rejected worktree dirty probe as dirty", async () => {
    const sourceWorktree = { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" };
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      worktreeDirty: async () => {
        throw new Error("configured git probe unavailable");
      },
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: sourceWorktree });

    const plan = await manager.planFork("claude");

    expect(plan.sourceWorktree).toEqual(sourceWorktree);
    expect(plan.dirty).toBe(true);
  });

  it("SDD 370 rejects catalog drift before creating a fork worktree", async () => {
    const sourceWorktree = { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" };
    let supported = true;
    let createCalls = 0;
    const preflightCwds: Array<string | undefined> = [];
    const { manager, ledger, sessions } = resumeHarness("agents:\n  claude:\n    cmd: claude --model sonnet-current\n", {
      resolveCurrentSession: async () => UUID,
      worktreeDirty: async () => false,
      createForkWorktree: async () => {
        createCalls += 1;
        return { cwd: "/wt/fork", worktree: { ...sourceWorktree, path: "/wt/fork", branch: "tachyon/claude-fork-1" } };
      },
      launchPreflight: {
        check: async (_command, _env, cwd) => {
          preflightCwds.push(cwd);
          return supported
            ? { state: "supported", runtime: "claude", model: "sonnet-current", source: "fixture" }
            : { state: "unsupported", code: "runtime_model_unavailable", runtime: "claude", model: "sonnet-current", suggestions: [] };
        },
      },
    });
    await manager.spawn("claude");
    const source = ledger.get("claude")!;
    ledger.record("claude", { ...source, worktree: sourceWorktree });
    const plan = await manager.planFork("claude");
    supported = false;

    await expect(manager.commitFork(plan)).rejects.toMatchObject({ code: "runtime_model_unavailable" });
    expect(createCalls).toBe(0);
    expect(preflightCwds).toEqual([expect.any(String), expect.any(String)]);
    expect(sessions.has(manager.session(plan.forkName))).toBe(false);
    expect(ledger.get(plan.forkName)).toBeUndefined();
  });

  it("SDD 370 repeats a supported fork preflight in the prospective worktree cwd", async () => {
    const sourceWorktree = { path: "/wt/source", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" };
    const preflightCwds: Array<string | undefined> = [];
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude --model sonnet-current\n", {
      resolveCurrentSession: async () => UUID,
      worktreeDirty: async () => false,
      createForkWorktree: async () => ({
        cwd: "/wt/fork",
        worktree: { ...sourceWorktree, path: "/wt/fork", branch: "tachyon/claude-fork-1" },
      }),
      seedTranscript: () => true,
      launchPreflight: {
        check: async (_command, _env, cwd) => {
          preflightCwds.push(cwd);
          return { state: "supported", runtime: "claude", model: "sonnet-current", source: "fixture" };
        },
      },
    });
    await manager.spawn("claude");
    ledger.record("claude", { ...ledger.get("claude")!, worktree: sourceWorktree });

    const forkName = await manager.commitFork(await manager.planFork("claude"));

    expect(preflightCwds).toEqual([expect.any(String), expect.any(String), "/wt/fork"]);
    expect(ledger.get(forkName)?.cwd).toBe("/wt/fork");
    await manager.kill(forkName);
  });

  it("commitFork (no worktree): spawns the fork-session combo and records a persistent sibling row", async () => {
    const settings: Array<{ name: string; ownershipOnly: boolean; cwd?: string; configHome?: string }> = [];
    const { manager, ledger, cmds, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      defaultClaudeConfigHome: "/accounts/default-claude",
      materializeOwnershipSettings: (name, opts) => {
        settings.push({ name, ownershipOnly: !!opts?.ownershipOnly, cwd: opts?.cwd, configHome: opts?.configHome });
        return `/ws/.tachyon/spawn-settings/${name}.json`;
      },
    });
    await manager.spawn("claude");
    settings.length = 0;
    const plan = await manager.planFork("claude");
    const { compositor, soulResolver } = soulLifecycleBypassSpies(manager);
    compositor.mockClear();
    const forkName = await manager.commitFork(plan);
    expect(forkName).toBe("claude-fork-1");
    const forkSession = `tachyon-${path.basename(ws)}-claude-fork-1`;
    expect(cmds.at(-1)).toBe(
      `claude -n ${forkSession} --resume ${UUID} --fork-session --settings '/ws/.tachyon/spawn-settings/claude-fork-1.json'`,
    );
    expect(settings).toEqual([{
      name: "claude-fork-1",
      ownershipOnly: true,
      cwd: ws,
      configHome: "/accounts/default-claude",
    }]);
    const oracle = soulLegacyLifecycleCase("native-fork-command");
    const legacyCommand = cmds.at(-1)
      ?.replace(forkSession, "<FORK_SESSION>")
      .replace(/ --settings '[^']+'$/, "");
    expect(legacyCommand).toBe(oracle.bytes);
    expect(oracle.sendKeys).toEqual([]);
    expect(ledger.get("claude-fork-1")).toMatchObject({
      def: { cmd: "claude", kind: "agent", fork: true }, // base cmd → a later resume uses the normal named path, never re-forks
      resume: { runtime: "claude", sessionId: forkSession }, // the fork's OWN name (captured → uuid later)
      declared: false,
      cwd: ws, // no worktree → shares the source cwd (same project dir, context carries)
    });
    expect(ledger.get("claude-fork-1")?.def?.parent).toBeUndefined(); // sibling, NOT a lineage child
    const names = (await manager.list()).map((a) => a.name);
    expect(names).toContain("claude-fork-1");
    expect(compositor).not.toHaveBeenCalled();
    expect(soulResolver).not.toHaveBeenCalled();
  });

  it("commitFork copies soul/role/task/evolution offer metadata without resolving or composing identity", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n    role: reviewer\n    soul: true\n", { resolveCurrentSession: async () => UUID });
    const profile = path.join(ws, ".tachyon", "agents", "claude");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profile, "SOUL.md"), "Calm and exact.", { mode: 0o600 });
    fs.writeFileSync(path.join(profile, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "claude", state: "active" }), { mode: 0o600 });
    await manager.spawn("claude", { taskBrief: "One-run objective." });
    expect(fs.readdirSync(path.join(ws, ".tachyon", "agent-profile-transactions", "launch-reservations"))).toEqual([]);
    const evolution = await resolveEvolutionStartupSnapshot(ws, "claude");
    ledger.record("claude", { ...ledger.get("claude")!, evolution });
    const source = ledger.get("claude")!;
    const plan = await manager.planFork("claude");
    fs.renameSync(path.join(profile, "SOUL.md"), path.join(profile, "SOUL.removed-after-spawn.md"));
    const { compositor, soulResolver } = soulLifecycleBypassSpies(manager);
    compositor.mockClear();

    const forkName = await manager.commitFork(plan);
    const fork = ledger.get(forkName)!;
    expect(fork.def).toMatchObject({ role: "reviewer", soul: true, taskBrief: "One-run objective.", fork: true });
    expect(fork.identity).toEqual(source.identity);
    expect(fork.evolution).toEqual(source.evolution);
    expect(compositor).not.toHaveBeenCalled();
    expect(soulResolver).not.toHaveBeenCalled();
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

  it("SDD 369 T3 passes a fork's inherited explicit Claude config home to capture materialization", async () => {
    const homes: Array<string | undefined> = [];
    const { manager } = resumeHarness(
      "agents:\n  claude:\n    cmd: claude\n    env:\n      CLAUDE_CONFIG_DIR: /accounts/external-claude\n",
      {
        resolveCurrentSession: async () => UUID,
        materializeOwnershipSettings: (_name, opts) => {
          homes.push(opts?.configHome);
          return "/ws/.tachyon/spawn-settings/claude.json";
        },
      },
    );
    await manager.spawn("claude");
    homes.length = 0;

    await manager.commitFork(await manager.planFork("claude"));

    expect(homes).toEqual(["/accounts/external-claude"]);
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
    const evolutionRoot = path.join(ws, ".tachyon", "agents", name, "evolution");
    fs.mkdirSync(path.join(evolutionRoot, "skills", "helper"), { recursive: true });
    fs.writeFileSync(path.join(evolutionRoot, "profile.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(evolutionRoot, "skills", "helper", "SKILL.md"), "# helper\n", "utf8");

    expect(() => forgetAgent(name, {
      workspaceRoot: ws,
      removeHarnessHome: (agent) => new HarnessManager(ws).remove(agent),
    })).not.toThrow();
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(evolutionRoot)).toBe(false);
  });

  it("canonical forgetAgent footprint list names every per-agent removal surface", () => {
    expect(FORGET_AGENT_FOOTPRINTS).toEqual([
      "session ledger row",
      "activity log and writer state",
      "session-owner ledger rows",
      "private harness/config home (including Pi sessions)",
      "legacy/idempotent Pi session subtree",
      "per-spawn settings file",
      "generated spawn brief and soul anchor",
      "durable pane transcript",
      "Agent Evolution Profile",
    ]);
  });

  // t-13c2b6 B4 — "Directly exercise forgetAgent with throwing ledger/removeHarness dependencies and
  // real later artifacts to prove all later removals still run exactly once and the aggregate preserves
  // ordered causes." Ledger (1st footprint) and harness home (4th, the "middle" one) are forced to throw;
  // every other real, on-disk footprint must still be removed exactly once.
  it("canonical forgetAgent preserves ordered causes and still removes every other artifact when its ledger and harness-home removals both throw", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-forget-order-"));
    dirs.push(ws);
    const name = "chaos-agent";
    const ledgerError = new Error("injected ledger remove failure");
    const harnessError = new Error("injected harness home removal failure");
    let ledgerRemoveCalls = 0, harnessCalls = 0;
    const throwingLedger = {
      remove: (n: string) => { ledgerRemoveCalls += 1; if (n === name) throw ledgerError; },
    } as unknown as SessionLedger;

    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId(name)}.jsonl`);
    const stateFile = path.join(actDir, `${agentLogId(name)}.state.json`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    fs.writeFileSync(stateFile, "{}", "utf8");
    fs.writeFileSync(sessionOwnersFile(ws), `${JSON.stringify({ agent: name, sessionId: "s1", transcriptPath: "/p", cwd: ws, source: "startup", ts: "t1" })}\n`, "utf8");
    fs.mkdirSync(path.dirname(spawnSettingsPath(ws, name)), { recursive: true });
    fs.writeFileSync(spawnSettingsPath(ws, name), "{}\n", "utf8");
    const briefFile = briefFilePath(ws, name, "spawn");
    fs.mkdirSync(path.dirname(briefFile), { recursive: true });
    fs.writeFileSync(briefFile, "brief\n", "utf8");
    const anchorFile = path.join(ws, ".tachyon", "anchors", `${name}.md`);
    fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
    fs.writeFileSync(anchorFile, "anchor\n", "utf8");
    const transcriptFile = paneTranscriptPath(ws, name);
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    fs.writeFileSync(transcriptFile, "pane output\n", "utf8");

    let failure: unknown;
    try {
      forgetAgent(name, {
        workspaceRoot: ws,
        ledger: throwingLedger,
        removeHarnessHome: (agent) => { harnessCalls += 1; if (agent === name) throw harnessError; },
      });
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(AggregateError);
    // Exactly the two injected failures, in the exact source order forgetAgent attempts them
    // (ledger first, harness home fourth) — every other footprint attempt succeeded silently.
    expect((failure as AggregateError).errors).toEqual([ledgerError, harnessError]);
    expect(ledgerRemoveCalls).toBe(1);
    expect(harnessCalls).toBe(1);
    // Every later-owned real artifact this attempt did NOT inject a failure for is still removed
    // exactly once: an early ledger failure and a later harness failure never short-circuit the rest.
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(readSessionOwners(sessionOwnersFile(ws)).map((r) => r.agent)).toEqual([]);
    expect(fs.existsSync(spawnSettingsPath(ws, name))).toBe(false);
    expect(fs.existsSync(briefFile)).toBe(false);
    expect(fs.existsSync(anchorFile)).toBe(false);
    expect(fs.existsSync(transcriptFile)).toBe(false);
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
    const completed: string[] = [];
    const forkCwd = "/wt/claude-fork-1";
    let forkLedger: SessionLedger | undefined;
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      homeDir: () => "/home/u",
      createForkWorktree: async (forkName) => ({ cwd: forkCwd, worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "tachyon/claude", createdAt: "t" } }),
      seedTranscript: (from, to) => {
        seeded.push({ from, to });
        return true;
      },
      completePreparedWorktree: async (record) => {
        expect(forkLedger?.get("claude-fork-1")?.worktree).toEqual(record);
        completed.push(record.path);
      },
    });
    forkLedger = ledger;
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
    expect(completed).toEqual([forkCwd]);
  });

  it("commitFork (worktree source): fails closed and preserves the locked worktree when transcript seeding fails", async () => {
    const forkCwd = "/wt/claude-fork-1";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      createForkWorktree: async (forkName) => ({ cwd: forkCwd, worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } }),
      seedTranscript: () => false, // copy didn't land → claude --resume would find nothing
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    const failure = await manager.commitFork(await manager.planFork("claude")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/couldn't seed.*locked recovery checkout: \/wt\/claude-fork-1/) });
    expect((failure as AggregateError).errors[1]).toMatchObject({ message: expect.stringContaining("unlock it explicitly") });
    expect(ledger.get("claude-fork-1")).toBeUndefined(); // no leaked sibling row
  });

  it("commitFork continues checkout diagnostics when removing a failed fork ledger row throws", async () => {
    const forkCwd = "/wt/claude-fork-1";
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      createForkWorktree: async (forkName) => ({
        cwd: forkCwd,
        worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "tachyon/claude", createdAt: "t" },
      }),
      seedTranscript: () => false,
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    const realRemove = ledger.remove.bind(ledger);
    vi.spyOn(ledger, "remove").mockImplementation((name) => {
      if (name === "claude-fork-1") throw new Error("injected fork ledger remove failure");
      realRemove(name);
    });

    const failure = await manager.commitFork(await manager.planFork("claude")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringContaining("locked recovery checkout: /wt/claude-fork-1") });
    expect((failure as AggregateError).errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("failed to remove fork recovery ledger row") }));
    expect((failure as AggregateError).errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("unlock it explicitly") }));
  });

  it("commitFork continues token and checkout compensation when its live recovery record retry fails", async () => {
    const forkCwd = "/wt/claude-fork-1";
    const revoked: string[] = [];
    let generationCalls = 0;
    const { manager, ledger, sessions } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      failKillSession: true,
      resolveCurrentSession: async () => UUID,
      createForkWorktree: async (forkName) => ({
        cwd: forkCwd,
        worktree: { path: forkCwd, branch: `tachyon/${forkName}`, tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "tachyon/claude", createdAt: "t" },
      }),
      seedTranscript: () => true,
      mintAgentToken: (name) => ({ TACHYON_AGENT_BRIDGE_TOKEN: `token-${name}` }),
      revokeAgentToken: (name) => { revoked.push(name); },
      getBridgeGeneration: () => {
        generationCalls += 1;
        if (generationCalls > 1) throw new Error("injected post-spawn stamp failure");
        return 1;
      },
    });
    await manager.spawn("claude");
    const src = ledger.get("claude")!;
    ledger.record("claude", { ...src, worktree: { path: "/wt/claude", branch: "tachyon/claude", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" } });
    const realRecord = ledger.record.bind(ledger);
    let forkWrites = 0;
    vi.spyOn(ledger, "record").mockImplementation((name, record) => {
      if (name === "claude-fork-1") {
        forkWrites += 1;
        if (forkWrites === 2) throw new Error("injected fork recovery record failure");
      }
      realRecord(name, record);
    });

    const failure = await manager.commitFork(await manager.planFork("claude")).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/locked recovery checkout: \/wt\/claude-fork-1.*live recovery session/) });
    expect((failure as AggregateError).errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("failed to persist fork recovery handle") }));
    expect(ledger.get("claude-fork-1")?.worktree?.path).toBe(forkCwd);
    expect(ledger.get("claude-fork-1")?.def?.fork).toBe(true);
    expect(sessions.has(manager.session("claude-fork-1"))).toBe(true);
    expect(revoked).toEqual(["claude-fork-1"]);
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

  it("spec t-e2ebe3: private-home opencode delegation passes UNGATED (no isolated worktree required)", async () => {
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n");
    // The gated-only restriction was REMOVED — opencode now rates private-home (per-agent XDG), so a
    // parented spawn delegates without a worktree. (Pre-t-e2ebe3: this threw "requires an isolated worktree".)
    await manager.spawn("reviewer", { cmd: "opencode", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
  });

  it("spec 358 / t-e2ebe3: opencode delegation also passes with an isolated worktree", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC }),
    });
    await manager.spawn("reviewer", { cmd: "opencode", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
    expect(newSessionArgs[0][newSessionArgs[0].indexOf("-c") + 1]).toBe(REC.path);
  });

  it("serializes concurrent launches of one name across cwd preparation and tmux creation", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const resolveSpawnCwd = vi.fn(async () => {
      markEntered();
      await release;
      return { cwd: REC.path, worktree: REC };
    });
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", { resolveSpawnCwd });

    const first = manager.spawn("reviewer", { cmd: "opencode", parent: "boss" });
    await entered;
    const second = manager.spawn("reviewer", { cmd: "opencode", parent: "boss" });
    await Promise.resolve();
    expect(resolveSpawnCwd).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    await expect(second).rejects.toThrow(/already running/);
    expect(resolveSpawnCwd).toHaveBeenCalledTimes(1);
    expect(newSessionArgs).toHaveLength(1);
  });

  it("t-a08d3d: user-declared XDG_DATA_HOME on a plain opencode def loses to the harness value in the final spawn env", async () => {
    // Follow-up on .tachyon/reviews/2ec9f65.md item 2: the fs-level test in harness.test.ts only
    // proves materializeHomeOnly's OWN output is correct — it never touches applyHarness's
    // `{ ...env, ...mat.env }` merge (AgentManager.ts). This test drives a REAL spawn through the
    // production materializeHarness wiring shape (mirrors Workspace.ts: no `harness:` block, no
    // `isolate:`, ad-hoc opencode → auto-injected `isolate: "transcript"` → materializeHomeOnly) with
    // a REAL HarnessManager, so a future spread-order flip (`{ ...mat.env, ...env }`) or a short-
    // circuited merge for opencode would fail this test, not just the fs-level one.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-h4-"));
    dirs.push(base);
    const realHome = path.join(base, "realhome");
    const opencodeDataHome = path.join(base, "realopencodedata");
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(path.join(opencodeDataHome, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(opencodeDataHome, "opencode", "auth.json"), '{"token":"OC"}');

    let harnessMgr: HarnessManager;
    const { manager, newSessionArgs, ws } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
      // Mirrors Workspace.ts's materializeHarness wiring exactly (spec 226/298/357): a plain, non-
      // `harness:`-declared opencode agent only gets private-home treatment via the ad-hoc
      // auto-injected `isolate: "transcript"` (AgentManager.spawnCore) — there is no opencode-runtime
      // default branch the way codex has one.
      materializeHarness: ({ name, def }) => {
        const adapter = adapterFor(def.cmd);
        if (!harnessable(adapter) || !adapter) return null;
        if (def.isolate === "transcript") return harnessMgr.materializeHomeOnly(name, adapter);
        if (adapter.runtime === "codex") return harnessMgr.materializeHomeOnly(name, adapter);
        return null;
      },
    });
    harnessMgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"), undefined, undefined, opencodeDataHome);

    // A plain opencode agent — ad-hoc, no `harness:` block declared anywhere — spawned with a
    // user-declared env trying to smuggle an attacker-controlled XDG_DATA_HOME into the process.
    await manager.spawn("reviewer", { cmd: "opencode", env: { XDG_DATA_HOME: "/attacker/path" } });

    const dirsExpected = opencodeHarnessDirs(harnessHome(ws, "reviewer"));
    const args = newSessionArgs.at(-1)!;
    expect(args).toContain(`XDG_DATA_HOME=${dirsExpected.data}`);
    expect(args).toContain(`XDG_CONFIG_HOME=${dirsExpected.config}`);
    expect(args).toContain(`XDG_STATE_HOME=${dirsExpected.state}`);
    expect(args).not.toContain("XDG_DATA_HOME=/attacker/path");
  });

  it("spec 357: removal deletes the private runtime home with the other ephemeral state", () => {
    const removed: string[] = [];
    const { manager } = resumeHarness("agents:\n  coder:\n    cmd: codex\n", { removeHarnessHome: (name) => removed.push(name) });
    manager.removeEphemeralFootprint("coder");
    expect(removed).toEqual(["coder"]);
  });

  it("H3: resume of a harness agent re-applies the harness wiring", async () => {
    const { manager, cmds, startArgs } = resumeHarness(HARNESS_YML, {
      ...stubHarness(),
      fileExists: () => true,
    });
    await manager.spawn("researcher");
    const before = startArgs.length;
    await manager.resume("researcher", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", declared: true, updatedAt: "t" });
    expect(cmds.at(-1)).toContain("--strict-mcp-config");
    expect(startArgs.length).toBe(before + 1);
    expect(envFromTmuxArgs(startArgs.at(-1)!).CLAUDE_CONFIG_DIR).toBe("/h/researcher");
  });

  it("reload-safe: resume binds a legacy ad-hoc Claude session to its persisted private configHome", async () => {
    const privateHome = "/persisted/private/reviewer";
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { manager, cmds, startArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
      fileExists: () => true,
      launchPreflight: { check: async () => ({ state: "supported", runtime: "claude", source: "fixture" }) },
    });
    await manager.resume("reviewer", {
      def: { cmd: "claude --model sonnet", kind: "agent", parent: "boss" },
      resume: { runtime: "claude", sessionId, configHome: privateHome },
      cwd: "/ws",
      declared: false,
      updatedAt: "t",
    });

    const args = startArgs.at(-1)!;
    expect(cmds.at(-1)).toContain(`--resume ${sessionId}`);
    expect(envFromTmuxArgs(args).CLAUDE_CONFIG_DIR).toBe(privateHome);
  });

  it("reload-safe: resume preserves Claude's implicit global home instead of exporting CLAUDE_CONFIG_DIR", async () => {
    const globalHome = "/home/test/.claude";
    const { manager, startArgs } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      fileExists: () => true,
      homeDir: () => "/home/test",
    });
    await manager.resume("claude", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", configHome: globalHome },
      cwd: "/ws",
      declared: true,
      updatedAt: "t",
    });

    expect(envFromTmuxArgs(startArgs.at(-1)!).CLAUDE_CONFIG_DIR).toBeUndefined();
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

  it("phase 2: renaming a managed Pi agent is refused while its private session home is name-keyed", async () => {
    const { manager } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
      getExtraEnv: () => ({}),
      materializePiSessionDir: (name) => `/private/pi-sessions/${name}`,
    });
    await manager.spawn("pi");
    await expect(manager.rename("pi", "pi2")).rejects.toThrow("managed Pi session isn't supported yet");
  });

  // spec 236 — the Bridge reaches EVERY Tachyon-spawned agent via withRuntimeBridge (one shared step).
  describe("spec 236 — deterministic Bridge injection", () => {
    const BRIDGE = () => ({
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp", TACHYON_BRIDGE_TOKEN: "tok" }),
      materializeBridgeMcp: (name: string) => `/ws/.tachyon/bridge-mcp/${name}.json`,
    });
    const PI_PRIVATE_HOME = () => ({
      materializeHarness: ({ name }: { name: string }) => ({
        home: `/private/pi-homes/${name}`,
        env: {
          PI_CODING_AGENT_DIR: `/private/pi-homes/${name}`,
          PI_CODING_AGENT_SESSION_DIR: `/private/pi-homes/${name}/sessions`,
        },
        args: [],
      }),
      materializePiSessionDir: (name: string) => `/private/pi-homes/${name}/sessions`,
    });

    it("codex (non-pipeline): spawn injects the -c Bridge override", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", BRIDGE());
      await manager.spawn("codex");
      expect(cmds.at(-1)).toContain('mcp_servers.tachyon_bridge={url="http://127.0.0.1:9/mcp"');
      expect(cmds.at(-1)).toContain('bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"');
      expect(cmds.at(-1)).not.toMatch(/Bearer\s/); // no literal token on argv
    });

    it("Pi: spawn and restart mint private sessions and load the staged extension before the primer", async () => {
      const extension = "/immutable/engine/pi-bridge-extension.mjs";
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const restartedSessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      const sessionIds = [sessionId, restartedSessionId];
      const bridge = {
        newSessionId: () => sessionIds.shift()!,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp", TACHYON_BRIDGE_TOKEN: "shared-secret" }),
        mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "agent-secret" }),
        piBridgeExtensionPath: () => extension,
        ...PI_PRIVATE_HOME(),
      };
      const { manager, ledger, cmds, startArgs } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", bridge);

      await manager.spawn("pi");
      expect(cmds.at(-1)).toMatch(/^pi --extension '\/immutable\/engine\/pi-bridge-extension\.mjs' /);
      expect(cmds.at(-1)).toContain(`--session-id ${sessionId}`);
      expect(cmds.at(-1)).toContain("── TACHYON PRIMER ──");
      expect(cmds.at(-1)).not.toContain("shared-secret");
      expect(cmds.at(-1)).not.toContain("agent-secret");
      expect(envFromTmuxArgs(startArgs.at(-1)!)).toMatchObject({
        TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp",
        TACHYON_AGENT_BRIDGE_TOKEN: "agent-secret",
        PI_CODING_AGENT_DIR: "/private/pi-homes/pi",
        PI_CODING_AGENT_SESSION_DIR: "/private/pi-homes/pi/sessions",
      });
      expect(ledger.get("pi")?.resume).toMatchObject({
        runtime: "pi",
        sessionId,
        configHome: "/private/pi-homes/pi/sessions",
      });

      await manager.restart("pi", { stop: "force", session: "new" });
      expect(cmds.at(-1)).toContain(`--extension '${extension}'`);
      expect(cmds.at(-1)).toContain(`--session-id ${restartedSessionId}`);
      expect(envFromTmuxArgs(startArgs.at(-1)!)).toMatchObject({
        PI_CODING_AGENT_DIR: "/private/pi-homes/pi",
        PI_CODING_AGENT_SESSION_DIR: "/private/pi-homes/pi/sessions",
      });
      expect(ledger.get("pi")?.resume?.sessionId).toBe(restartedSessionId);
    });

    it("SDD 408: permits only one live Pi process per workspace and releases the slot after stop", async () => {
      const sessionIds = [
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa",
      ];
      const { manager, sessions, hash } = resumeHarness(
        "agents:\n  pi-a:\n    cmd: pi\n  pi-b:\n    cmd: pi\n",
        {
          newSessionId: () => sessionIds.shift()!,
          getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
          piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
          ...PI_PRIVATE_HOME(),
        },
      );

      const attempts = await Promise.allSettled([manager.spawn("pi-a"), manager.spawn("pi-b")]);
      const winnerIndex = attempts.findIndex((result) => result.status === "fulfilled");
      const loserIndex = attempts.findIndex((result) => result.status === "rejected");
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(loserIndex).toBeGreaterThanOrEqual(0);
      const winner = winnerIndex === 0 ? "pi-a" : "pi-b";
      const loser = loserIndex === 0 ? "pi-a" : "pi-b";
      expect(attempts[loserIndex]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: `cannot start Pi agent '${loser}': Pi OAuth safety currently permits one live Pi agent per workspace; stop '${winner}' first`,
        }),
      });
      expect([...sessions].filter((session) => session.endsWith("-pi-a") || session.endsWith("-pi-b"))).toEqual([
        `tachyon-${hash}-${winner}`,
      ]);

      await manager.kill(winner);
      await manager.spawn(loser);
      expect(sessions.has(`tachyon-${hash}-${loser}`)).toBe(true);
    });

    it("SDD 408: refuses Pi admission when another live managed entry cannot be classified", async () => {
      const { manager, sessions, hash } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
        newSessionId: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        ...PI_PRIVATE_HOME(),
      });
      sessions.add(`tachyon-${hash}-unknown-live-entry`);

      await expect(manager.spawn("pi")).rejects.toThrow(
        "could not classify live workspace entry 'unknown-live-entry' for Pi OAuth safety",
      );
      expect(sessions.has(`tachyon-${hash}-pi`)).toBe(false);
    });

    it("SDD 406: Pi resource harness args survive spawn and restart alongside private home, session identity, and Bridge", async () => {
      const extension = "/immutable/engine/pi-bridge-extension.mjs";
      const materialized: string[] = [];
      const bridge = {
        newSessionId: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => extension,
        materializeHarness: ({ name }: { name: string }) => {
          materialized.push(name);
          return {
            home: `/private/pi-homes/${name}`,
            env: {
              PI_CODING_AGENT_DIR: `/private/pi-homes/${name}`,
              PI_CODING_AGENT_SESSION_DIR: `/private/pi-homes/${name}/sessions`,
            },
            args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--skill", "'/private/pi-homes/pi/.tachyon-resources/generation-a/skills/review'"],
          };
        },
        materializePiSessionDir: (name: string) => `/private/pi-homes/${name}/sessions`,
        resolveCaptureSession: async (_runtime: string, _cwd: string, _home: string | undefined, id: string | undefined) => id
          ? { id, path: `/private/pi-homes/pi/sessions/2026_${id}.jsonl` }
          : null,
        fileExists: (file: string) => file.startsWith("/private/pi-homes/pi/sessions/2026_"),
      };
      const { manager, ledger, cmds } = resumeHarness("agents:\n  pi:\n    cmd: pi\n    harness:\n      skills: skills/review\n", bridge);

      await manager.spawn("pi");
      expect(cmds.at(-1)).toContain(`--extension '${extension}'`);
      expect(cmds.at(-1)).toContain("--no-extensions --no-skills --no-prompt-templates --no-themes");
      expect(cmds.at(-1)).toContain("--skill '/private/pi-homes/pi/.tachyon-resources/generation-a/skills/review'");

      await manager.restart("pi", { stop: "force", session: "new" });
      expect(cmds.at(-1)).toContain(`--extension '${extension}'`);
      expect(cmds.at(-1)).toContain("--no-extensions --no-skills --no-prompt-templates --no-themes");

      await manager.resume("pi", ledger.get("pi")!);
      expect(cmds.at(-1)).toContain("--session aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(cmds.at(-1)).toContain(`--extension '${extension}'`);
      expect(cmds.at(-1)).toContain("--no-extensions --no-skills --no-prompt-templates --no-themes");
      expect(materialized).toEqual(["pi", "pi", "pi"]);
    });

    it("Pi: resume requires the exact transcript, reopens its id, re-injects Bridge, and omits primer", async () => {
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const transcript = `/private/pi-homes/pi/sessions/2026_${sessionId}.jsonl`;
      const resolved: Array<{ runtime: string; cwd: string; home?: string; id?: string }> = [];
      const { manager, ledger, cmds, startArgs, paneInjections } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
        newSessionId: () => sessionId,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        ...PI_PRIVATE_HOME(),
        resolveCaptureSession: async (runtime, cwd, home, id) => {
          resolved.push({ runtime, cwd, home, id });
          return runtime === "pi" && id === sessionId ? { id, path: transcript } : null;
        },
        fileExists: (file) => file === transcript,
      });
      await manager.spawn("pi");
      const record = ledger.get("pi")!;
      expect(await manager.resumeReadiness("pi", record)).toBe(true);
      paneInjections.length = 0;
      await manager.resume("pi", record);

      expect(cmds.at(-1)).toContain(`--session ${sessionId}`);
      expect(cmds.at(-1)).toContain("--extension '/immutable/engine/pi-bridge-extension.mjs'");
      expect(cmds.at(-1)).not.toContain("TACHYON PRIMER");
      expect(paneInjections).toEqual([]);
      expect(envFromTmuxArgs(startArgs.at(-1)!)).toMatchObject({
        PI_CODING_AGENT_DIR: "/private/pi-homes/pi",
        PI_CODING_AGENT_SESSION_DIR: "/private/pi-homes/pi/sessions",
      });
      expect(resolved.at(-1)).toMatchObject({ runtime: "pi", home: "/private/pi-homes/pi/sessions", id: sessionId });
    });

    it("Pi: resume fails closed when its exact transcript cannot be resolved", async () => {
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const { manager, ledger, cmds } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
        newSessionId: () => sessionId,
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        ...PI_PRIVATE_HOME(),
        resolveCaptureSession: async () => null,
      });
      await manager.spawn("pi");
      const record = ledger.get("pi")!;
      expect(await manager.resumeReadiness("pi", record)).toBe(false);
      const before = cmds.length;
      await expect(manager.resume("pi", record)).rejects.toThrow("transcript no longer on disk");
      expect(cmds).toHaveLength(before);
    });

    it("Pi: explicit user session flags remain self-managed but still receive a private runtime home", async () => {
      const { manager, ledger, cmds, startArgs } = resumeHarness("agents:\n  pi:\n    cmd: pi --session user-owned\n", {
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        ...PI_PRIVATE_HOME(),
      });
      await manager.spawn("pi");
      expect(cmds.at(-1)).toBe("pi --extension '/immutable/engine/pi-bridge-extension.mjs' --session user-owned");
      expect(envFromTmuxArgs(startArgs.at(-1)!)).toMatchObject({
        PI_CODING_AGENT_DIR: "/private/pi-homes/pi",
        PI_CODING_AGENT_SESSION_DIR: "/private/pi-homes/pi/sessions",
      });
      expect(ledger.get("pi")?.resume).toBeUndefined();
    });

    it("Pi: a missing staged extension warns and refuses a false wired spawn", async () => {
      const warnings: string[] = [];
      const { manager } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => undefined,
        materializePiSessionDir: (name) => `/private/pi-sessions/${name}`,
        notify: (message) => warnings.push(message),
      });
      await expect(manager.spawn("pi")).rejects.toThrow("Bridge tools could not be materialized");
      expect(warnings).toContain("agent 'pi': staged Pi Bridge extension is unavailable");
    });

    it("SDD 404: Pi canonical reviewer denylist preserves staged Bridge wiring", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  pi:\n    cmd: pi --exclude-tools bash,edit,write\n", {
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        ...PI_PRIVATE_HOME(),
      });
      await manager.spawn("pi");
      expect(cmds.at(-1)).toContain("--extension '/immutable/engine/pi-bridge-extension.mjs'");
      expect(cmds.at(-1)).toContain("--exclude-tools bash,edit,write");
    });

    it("Pi: refuses tool-filtering flags that would make a wired stamp lie", async () => {
      const warnings: string[] = [];
      const { manager } = resumeHarness("agents:\n  pi:\n    cmd: pi --no-tools\n", {
        getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
        piBridgeExtensionPath: () => "/immutable/engine/pi-bridge-extension.mjs",
        materializePiSessionDir: (name) => `/private/pi-sessions/${name}`,
        notify: (message) => warnings.push(message),
      });
      await expect(manager.spawn("pi")).rejects.toThrow("Bridge tools could not be materialized");
      expect(warnings.some((warning) => warning.includes("restricts tools beyond"))).toBe(true);
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

    it("persists an unwired outcome across spawn, restart, and resume instead of retaining a prior binding", async () => {
      let bridgeUp = true;
      const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        getBridgeGeneration: () => 7,
        getExtraEnv: (): Record<string, string> => bridgeUp ? { TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" } : {},
        materializeBridgeMcp: () => bridgeUp ? "/ws/.tachyon/bridge-mcp/claude.json" : undefined,
        fileExists: () => true,
      });

      ledger.record("claude", {
        def: { cmd: "claude", kind: "agent" },
        resume: { runtime: "claude", sessionId: "stale-session" },
        cwd: "/ws",
        declared: true,
        bridgeClient: { boundGeneration: 6, wired: true },
      });

      bridgeUp = false;
      await manager.spawn("claude");
      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 7, wired: false });

      bridgeUp = true;
      await manager.restart("claude", { stop: "force", session: "new" });
      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 7, wired: true });

      bridgeUp = false;
      await manager.restart("claude", { stop: "force", session: "new" });
      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 7, wired: false });

      const record = ledger.get("claude")!;
      ledger.record("claude", { ...record, bridgeClient: { boundGeneration: 7, wired: true } });
      await manager.resume("claude", ledger.get("claude")!);
      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 7, wired: false });
    });

    it("reload-safe: deferred resume leaves the prior Bridge stamp untouched for coordinator proof", async () => {
      const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        ...BRIDGE(),
        getBridgeGeneration: () => 7,
        fileExists: () => true,
      });
      ledger.record("claude", {
        def: { cmd: "claude", kind: "agent" },
        resume: { runtime: "claude", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        cwd: "/ws",
        declared: true,
        bridgeClient: { boundGeneration: 6, wired: true },
      });

      await manager.resume("claude", ledger.get("claude")!, { injectPrimer: false, deferBridgeStamp: true });

      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 6, wired: true });
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
      // Bridge MCP wiring still adds no config argv; the universal onboarding prompt uses opencode's
      // existing --prompt adapter.
      expect(cmds.at(-1)).toContain("opencode --prompt");
      expect(cmds.at(-1)).toContain("── TACHYON PRIMER ──");
      // OPENCODE_CONFIG points at the materialized file
      expect(newSessionArgs.at(-1)!.some((a) => a === "-e")).toBe(true);
      const envPairs = newSessionArgs.at(-1)!.filter((a) => a.startsWith("OPENCODE_CONFIG="));
      expect(envPairs).toHaveLength(1);
      expect(envPairs[0]).toBe("OPENCODE_CONFIG=/ws/.tachyon/bridge-mcp/opencode.opencode.json");
      // the materializer was called with the agent's spawn cwd (the workspace root in the harness)
      expect(calls).toEqual([{ name: "opencode", cwd: expect.any(String) }]);
    });

    it("opencode (non-harness): resume re-injects OPENCODE_CONFIG (rebuilds the env)", async () => {
      const { manager, startArgs } = resumeHarness(
        "agents:\n  opencode:\n    cmd: opencode\n",
        { ...OPENCODE_BRIDGE(), fileExists: () => true },
      );
      await manager.spawn("opencode");
      const spawnEnv = envFromTmuxArgs(startArgs.at(-1)!).OPENCODE_CONFIG;
      await manager.resume("opencode", {
        def: { cmd: "opencode", kind: "agent" },
        resume: { runtime: "opencode", sessionId: "ses_x" },
        cwd: "/ws",
        declared: false,
        updatedAt: "t",
      });
      expect(envFromTmuxArgs(startArgs.at(-1)!).OPENCODE_CONFIG).toBe(spawnEnv);
    });

    it("opencode (non-harness): restart re-injects OPENCODE_CONFIG (own restartBuild/restartBridge merge site, spec 236 review LOW fix)", async () => {
      const calls: Array<{ name: string; cwd: string }> = [];
      const { manager, startArgs } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", OPENCODE_BRIDGE(calls));
      await manager.spawn("opencode");
      const spawnEnv = envFromTmuxArgs(startArgs.at(-1)!).OPENCODE_CONFIG;
      calls.length = 0;
      await manager.restart("opencode", { stop: "force", session: "new" });
      expect(envFromTmuxArgs(startArgs.at(-1)!).OPENCODE_CONFIG).toBe(spawnEnv);
      expect(calls).toEqual([{ name: "opencode", cwd: expect.any(String) }]);
    });

    it("opencode: no OPENCODE_CONFIG when the Bridge is down (self-heals on next restart)", async () => {
      const { manager, newSessionArgs } = resumeHarness("agents:\n  opencode:\n    cmd: opencode\n", {
        materializeBridgeMcpOpencode: () => undefined,
      });
      await manager.spawn("opencode");
      expect(newSessionArgs.at(-1)!.some((a) => a.startsWith("OPENCODE_CONFIG="))).toBe(false);
    });

    // t-843576 — grok (non-harness): private GROK_HOME with Bridge MCP + auth symlink; inject GROK_HOME env.
    const GROK_BRIDGE = (calls?: string[]) => ({
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp", TACHYON_BRIDGE_TOKEN: "tok" }),
      materializeBridgeMcpGrok: (name: string) => {
        calls?.push(name);
        return `/ws/.tachyon/bridge-mcp/${name}.grok`;
      },
    });

    it("grok (non-harness): spawn injects GROK_HOME=<private home> env (no argv change)", async () => {
      const calls: string[] = [];
      const { manager, cmds, newSessionArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", GROK_BRIDGE(calls));
      await manager.spawn("grok");
      // grok mints a session id via `-s <uuid>` (no Bridge argv flags)
      expect(cmds.at(-1)).toMatch(/^grok -s /);
      expect(cmds.at(-1)).not.toContain("mcp_servers");
      expect(cmds.at(-1)).not.toContain("--mcp-config");
      const envPairs = newSessionArgs.at(-1)!.filter((a) => a.startsWith("GROK_HOME="));
      expect(envPairs).toEqual(["GROK_HOME=/ws/.tachyon/bridge-mcp/grok.grok"]);
      expect(calls).toEqual(["grok"]);
    });

    it("grok (non-harness): resume re-injects GROK_HOME", async () => {
      const { manager, startArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", {
        ...GROK_BRIDGE(),
        fileExists: () => true,
      });
      await manager.spawn("grok");
      const spawnEnv = envFromTmuxArgs(startArgs.at(-1)!).GROK_HOME;
      await manager.resume("grok", {
        def: { cmd: "grok", kind: "agent" },
        resume: { runtime: "grok", sessionId: "g-ses" },
        cwd: "/ws",
        declared: true,
        updatedAt: "t",
      });
      expect(envFromTmuxArgs(startArgs.at(-1)!).GROK_HOME).toBe(spawnEnv);
    });

    it("grok (non-harness): restart re-injects GROK_HOME", async () => {
      const calls: string[] = [];
      const { manager, startArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", GROK_BRIDGE(calls));
      await manager.spawn("grok");
      const spawnEnv = envFromTmuxArgs(startArgs.at(-1)!).GROK_HOME;
      calls.length = 0;
      await manager.restart("grok", { stop: "force", session: "new" });
      expect(envFromTmuxArgs(startArgs.at(-1)!).GROK_HOME).toBe(spawnEnv);
      expect(calls).toEqual(["grok"]);
    });

    // harness early-return (def.harness → withRuntimeBridge no-op) is covered by the claude/codex
    // harness cases above — same gate, independent of binary. loadConfig does not yet accept
    // harness: on grok in YAML; harness-path Bridge fold is exercised by HarnessManager tests.

    it("grok: no GROK_HOME injection when the Bridge is down (self-heals on next restart)", async () => {
      const { manager, newSessionArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", {
        materializeBridgeMcpGrok: () => undefined,
      });
      await manager.spawn("grok");
      expect(newSessionArgs.at(-1)!.some((a) => a.startsWith("GROK_HOME="))).toBe(false);
    });

    // t-303f2b — gated/ad-hoc grok must use the Bridge private GROK_HOME (same as declared), not a
    // second isolate:transcript harness home that races auth materialization.
    it("t-303f2b: ad-hoc grok with Bridge materializer injects bridge GROK_HOME (no harness isolate race)", async () => {
      const calls: string[] = [];
      const matCalls: Array<{ name: string; isolate?: string }> = [];
      const WT = { path: "/wt/h/deliveryMechanismLeaseGrokR1", branch: "tachyon/deliveryMechanismLeaseGrokR1", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
      const { manager, newSessionArgs } = resumeHarness("agents: {}\n", {
        ...GROK_BRIDGE(calls),
        launchPreflight: { check: async () => ({ state: "supported", runtime: "grok", source: "fixture" }) },
        resolveSpawnCwd: async () => ({ cwd: WT.path, worktree: WT, delegationBaseSha: "base" }),
        materializeHarness: ({ name, def }) => {
          matCalls.push({ name, isolate: def.isolate });
          return { home: `/ws/.tachyon/harness/${name}`, env: { GROK_HOME: `/ws/.tachyon/harness/${name}/.grok` }, args: [] };
        },
      });
      await manager.spawn("deliveryMechanismLeaseGrokR1", {
        cmd: "grok --model grok-4.5 --permission-mode auto --no-subagents",
        gate: {
          behaviorTest: "mechanism-only lease policy never impersonates proven_empty",
          owns: ["src/delivery/leaseService.ts"],
        },
        contract: { task: "lease core", context: "sdd 368", constraints: "no scope creep", doneWhen: "tests green" },
      });
      const envPairs = newSessionArgs.at(-1)!.filter((a) => a.startsWith("GROK_HOME="));
      expect(envPairs).toEqual(["GROK_HOME=/ws/.tachyon/bridge-mcp/deliveryMechanismLeaseGrokR1.grok"]);
      expect(calls).toEqual(["deliveryMechanismLeaseGrokR1"]);
      // materializeHarness must not run for auto-isolate on grok when bridge private home is available
      expect(matCalls).toEqual([]);
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

    it("t-554634: codex top-level declared: injects SessionStart and bypasses hook trust (option C)", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: (name, opts?: { ownershipOnly?: boolean }) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("codex");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(cmds.at(-1)).not.toContain("--settings");
      expect(calls).toEqual([{ name: "codex", ownershipOnly: false }]);
    });

    it("t-554634: codex top-level declared: restart and resume keep bypass with Tachyon hooks", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: (name, opts?: { ownershipOnly?: boolean }) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("codex");
      await manager.restart("codex", { stop: "force", session: "new" });
      await manager.resume("codex", { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "captured-id" }, cwd: "/ws", declared: true, updatedAt: "t" });
      expect(cmds).toHaveLength(3);
      for (const cmd of cmds) {
        expect(cmd).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
        expect(cmd).toContain("--dangerously-bypass-hook-trust");
      }
      expect(calls).toEqual([
        { name: "codex", ownershipOnly: false },
        { name: "codex", ownershipOnly: false },
        { name: "codex", ownershipOnly: false },
      ]);
    });

    it("t-554634: codex without Tachyon hook materialization does not get bypass", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: () => undefined,
      });
      await manager.spawn("codex");
      expect(cmds.at(-1)).not.toContain("--dangerously-bypass-hook-trust");
      expect(cmds.at(-1)).not.toContain("hooks.SessionStart");
    });

    it("t-84ff5c: declared codex subagent spawn bypasses hook trust when Tachyon injects hooks", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  grok:\n    cmd: grok\n    subagents: [gxReview]\n  gxReview:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: (name, opts) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("gxReview");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(calls).toEqual([{ name: "gxReview", ownershipOnly: false }]);
    });

    it("t-84ff5c: declared codex subagent resume bypasses hook trust when Tachyon re-injects hooks", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  grok:\n    cmd: grok\n    subagents: [gxReview]\n  gxReview:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: (name, opts) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.resume("gxReview", {
        def: { cmd: "codex", kind: "agent" },
        resume: { runtime: "codex", sessionId: "codex-session-1" },
        cwd: "/ws",
        declared: true,
        updatedAt: "t",
      });
      expect(cmds.at(-1)).toContain("resume codex-session-1");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(calls).toEqual([{ name: "gxReview", ownershipOnly: false }]);
    });

    it("t-84ff5c: declared codex subagent restart keeps the bypass with Tachyon hooks", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  grok:\n    cmd: grok\n    subagents: [gxReview]\n  gxReview:\n    cmd: codex\n", {
        materializeCodexSessionStartHookConfig: (name, opts) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.spawn("gxReview");
      await manager.restart("gxReview", { stop: "force", session: "new" });
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(calls).toEqual([
        { name: "gxReview", ownershipOnly: false },
        { name: "gxReview", ownershipOnly: false },
      ]);
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

    it("codex ad-hoc: resume keeps ownership-only hooks and bypasses hook trust", async () => {
      const calls: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        materializeCodexSessionStartHookConfig: (name, opts?: { ownershipOnly?: boolean }) => {
          calls.push({ name, ownershipOnly: !!opts?.ownershipOnly });
          return "hooks.SessionStart=[{hooks=[]}]";
        },
      });
      await manager.resume("reviewer", {
        def: { cmd: "codex", kind: "agent" },
        resume: { runtime: "codex", sessionId: "codex-session-1" },
        cwd: "/ws",
        declared: false,
        updatedAt: "t",
      });
      expect(cmds.at(-1)).toContain("resume codex-session-1");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
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

    it("codex ad-hoc: prompt text mentioning the bypass flag still gets one real bypass argv", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
        materializeCodexSessionStartHookConfig: () => "hooks.SessionStart=[{hooks=[]}]",
      });
      await manager.spawn("reviewer", {
        cmd: "codex",
        parent: "claude",
        instructions: "review text mentioning --dangerously-bypass-hook-trust as prose",
      });
      const cmd = cmds.at(-1)!;
      expect(cmd).toContain("codex --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmd.match(/--dangerously-bypass-hook-trust/g)).toHaveLength(2);
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

    it("SDD 369 T3 passes the effective cwd and private Claude config home to capture materialization", async () => {
      const details: Array<{ name: string; ownershipOnly: boolean; cwd?: string; configHome?: string }> = [];
      const { manager, ws } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        materializeHarness: ({ name }: { name: string }) => ({
          env: { CLAUDE_CONFIG_DIR: harnessHome(ws, name) },
          args: [],
        }),
        materializeOwnershipSettings: (name, opts) => {
          details.push({
            name,
            ownershipOnly: !!opts?.ownershipOnly,
            cwd: opts?.cwd,
            configHome: opts?.configHome,
          });
          return `/ws/.tachyon/spawn-settings/${name}.json`;
        },
      });

      await manager.spawn("reviewer", { cmd: "claude", parent: "boss" });

      expect(details).toEqual([{
        name: "reviewer",
        ownershipOnly: true,
        cwd: ws,
        configHome: harnessHome(ws, "reviewer"),
      }]);
    });

    it("SDD 369 T3 keeps ownership settings but fails capture closed for explicit --setting-sources", async () => {
      const details: Array<{ statusLineCapture?: boolean }> = [];
      const { manager, cmds } = resumeHarness(
        "agents:\n  claude:\n    cmd: claude --setting-sources project\n",
        {
          materializeOwnershipSettings: (_name, opts) => {
            details.push({ statusLineCapture: opts?.statusLineCapture });
            return "/ws/.tachyon/spawn-settings/claude.json";
          },
        },
      );

      await manager.spawn("claude");

      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/claude.json'");
      expect(details).toEqual([{ statusLineCapture: false }]);
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

    it("codex: no materializer wired adds no ownership flags beyond universal onboarding", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n", OWN());
      await manager.spawn("codex");
      expect(cmds.at(-1)).toContain("codex '");
      expect(cmds.at(-1)).toContain("── TACHYON PRIMER ──");
      expect(cmds.at(-1)).not.toContain("spawn-settings");
    });

    it("self-managed claude (--resume ...): left untouched, NO ownership injection", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --resume evals\n", OWN());
      await manager.spawn("claude");
      expect(cmds.at(-1)).toBe("claude --resume evals");
    });

    it("user command already sets --settings: skipped + advisory", async () => {
      const warns: string[] = [];
      const materialized: Array<{ name: string; ownershipOnly: boolean }> = [];
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude --settings ./mine.json\n", { ...OWN(materialized), notify: (m) => warns.push(m) });
      await manager.spawn("claude");
      expect(cmds.at(-1)).toContain("claude --settings ./mine.json"); // the user's --settings is preserved
      expect(cmds.at(-1)).not.toContain("spawn-settings"); // our ownership --settings file is NOT appended
      expect(warns.some((w) => w.includes("--settings"))).toBe(true);
      expect(materialized).toEqual([]);
    });

    it("no materializer wired: no injection (degrades safely)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n");
      await manager.spawn("claude");
      expect(cmds.at(-1)).not.toContain("--settings");
    });
  });
});

describe("AgentManager — restart terminal lifecycle (t-4d2630 respawn keeps clients)", () => {
  it("happy-path restart: onSpawned only (no onRestart close) — respawn keeps the attach", async () => {
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
    await manager.restart("a", { stop: "force", session: "new" });
    // t-4d2630: respawn-pane keeps attached clients; UI close dance is only for kill+new fallback
    expect(events).toEqual(["open"]);
  });

  it("respawn-failure fallback: onRestart close then onSpawned reopen", async () => {
    const { tmux } = fakeTmux({ failRespawn: true });
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
    events.length = 0;
    await manager.restart("a", { stop: "force", session: "new" });
    expect(events).toEqual(["close", "open"]);
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
    await manager.restart("spirit", { stop: "force", session: "new" }); // needs the moved ad-hoc definition
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
    const tmux = extra.tmux ?? new TmuxService(exec);
    const manager = new AgentManager({
      tmux,
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => configOf(yaml),
      getMaxAgents: () => 8,
      ledger,
      // Production always wires canonical Delivery storage; most unit cases do not inspect it.
      recordCanonicalDelivery: async (input) => canonicalSpawnReceipt(input.worktree, input.baseSha),
      ...extra,
    });
    dirs.push(ws);
    return { manager, ledger, sessions, cmds, newSessionArgs, tmux, ws };
  }

  it("SDD 370 fails delegated explicit models closed when the runtime has no catalog adapter", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");

    await expect(h.manager.spawn("grok-child", { cmd: "grok --model grok-4.5" })).rejects.toMatchObject({
      code: "runtime_preflight_unverifiable",
    });
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("grok-child")).toBeUndefined();
  });

  it.each(["sonnet", "claude-sonnet-5"])("delegated Claude explicit model %s enters bounded startup validation", async (model) => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");

    await expect(h.manager.spawn("claude-child", { cmd: `claude --model ${model}` })).resolves.toBeUndefined();
    expect(h.sessions.has(h.manager.session("claude-child"))).toBe(true);
    expect(h.ledger.get("claude-child")).toMatchObject({
      declared: false,
      def: { cmd: `claude --model ${model}` },
      resume: { runtime: "claude" },
    });
    expect(await h.manager.isReady("claude-child")).toBe(false);
  });

  it("provisional Claude model rejection fails spawn and removes the rejected session", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      launchReadiness: {
        wait: async () => ({ state: "rejected", code: "runtime_model_rejected" }),
      },
    });

    await expect(h.manager.spawn("claude-child", { cmd: "claude --model invalid-model" })).rejects.toMatchObject({
      code: "runtime_model_rejected",
    });
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("claude-child")).toBeUndefined();
  });

  it("SDD 370 probes the materialized private CODEX_HOME and exact cwd, then compensates a new home on rejection", async () => {
    let expectedHome = "";
    let observed: { home?: string; cwd?: string } = {};
    const removed: string[] = [];
    const h = harness("agents:\n  codex:\n    cmd: codex --model missing\n", {
      materializeHarness: () => {
        fs.mkdirSync(expectedHome, { recursive: true });
        return { home: expectedHome, env: { CODEX_HOME: expectedHome }, args: [] };
      },
      removeHarnessHome: (name) => {
        removed.push(name);
        fs.rmSync(expectedHome, { recursive: true, force: true });
      },
      launchPreflight: {
        requiresPreparedEnvironment: true,
        check: async (_command, env, cwd) => {
          observed = { home: env.CODEX_HOME, cwd };
          return { state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "missing", suggestions: [] };
        },
      },
    });
    expectedHome = harnessHome(h.ws, "codex");

    await expect(h.manager.spawn("codex")).rejects.toMatchObject({ code: "runtime_model_unavailable" });
    expect(observed).toEqual({ home: expectedHome, cwd: h.ws });
    expect(removed).toEqual(["codex"]);
    expect(fs.existsSync(expectedHome)).toBe(false);
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("codex")).toBeUndefined();
  });

  it("SDD 370 rolls back a newly prepared worktree when exact-environment preflight rejects", async () => {
    const worktree = { path: "/wt/codex", branch: "tachyon/codex", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const rollbacks: unknown[][] = [];
    const h = harness("agents:\n  codex:\n    cmd: codex --model missing\n    worktree: true\n", {
      resolveSpawnCwd: async () => ({
        cwd: worktree.path,
        worktree,
        created: true,
        rollbackHeadSha: "base",
        preparationHeadBefore: "base",
        preparationHeadAfter: "prepared",
      }),
      rollbackPreparedWorktree: async (...args) => { rollbacks.push(args); },
      launchPreflight: {
        requiresPreparedEnvironment: true,
        check: async () => ({ state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "missing", suggestions: [] }),
      },
    });

    await expect(h.manager.spawn("codex")).rejects.toMatchObject({ code: "runtime_model_unavailable" });
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0]?.slice(0, 5)).toEqual([worktree, "base", "base", "prepared", true]);
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("codex")).toBeUndefined();
  });

  it("SDD 370 revalidates Codex catalog drift before restart replacement and stopped resume", async () => {
    let supported = true;
    let wsRoot = "";
    const calls: Array<{ cwd?: string; home?: string }> = [];
    const h = harness("agents:\n  codex:\n    cmd: codex --model gpt-current\n", {
      materializeHarness: ({ name }) => ({ home: harnessHome(wsRoot, name), env: { CODEX_HOME: harnessHome(wsRoot, name) }, args: [] }),
      launchPreflight: {
        requiresPreparedEnvironment: true,
        check: async (_command, env, cwd) => {
          calls.push({ cwd, home: env.CODEX_HOME });
          return supported
            ? { state: "supported", runtime: "codex", model: "gpt-current", source: "fixture" }
            : { state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "gpt-current", suggestions: [] };
        },
      },
      fileExists: () => true,
      resolveCaptureId: async () => "captured-session",
    });
    wsRoot = h.ws;

    await h.manager.spawn("codex");
    const session = h.manager.session("codex");
    supported = false;
    await expect(h.manager.restart("codex", { stop: "force", session: "new" })).rejects.toMatchObject({ code: "runtime_model_unavailable" });
    expect(h.sessions.has(session)).toBe(true);

    await h.manager.kill("codex");
    await expect(h.manager.resume("codex", h.ledger.get("codex")!)).rejects.toMatchObject({ code: "runtime_model_unavailable" });
    expect(h.sessions.has(session)).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.cwd === h.ws && call.home === harnessHome(h.ws, "codex"))).toBe(true);
  });

  it("stale declared ledger parents are ignored so declared agents stay top-level", async () => {
    const { manager, ledger, ws } = harness("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: claude\n");
    await manager.spawn("child"); // running, but spawned WITHOUT parent → no in-memory lineage link
    const sessionsPath = ledger.path;
    fs.writeFileSync(
      sessionsPath,
      `${JSON.stringify({ sessions: { child: { def: { cmd: "claude", kind: "agent", parent: "boss" }, cwd: ws, declared: true, updatedAt: "t" } } }, null, 2)}\n`,
      "utf8",
    );
    await manager.rehydrateFromLedger();
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
    await manager.rehydrateFromLedger();
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

  it("t-f660d8: declared spawn_agent parent reaches primer without runtime lineage", async () => {
    // Sidebar keeps declared agents top-level (declaredOwner); primer must still name the spawner for doorbell.
    const { manager, ledger, cmds } = harness(
      "agents:\n  codex:\n    cmd: claude\n    subagents: [reviewer]\n  reviewer:\n    cmd: claude\n",
    );
    await manager.spawn("reviewer", { parent: "codex" });
    const listed = (await manager.list()).find((a) => a.name === "reviewer");
    expect(listed?.parent).toBeUndefined(); // no runtime lineage
    expect(listed?.declaredOwner).toBe("codex");
    expect(manager.parentOf("reviewer")).toBeUndefined();
    expect(ledger.get("reviewer")?.def?.parent).toBeUndefined();
    // Primer is embedded in the spawn command payload for claude.
    expect(cmds.some((c) => c.includes("spawned by \"codex\""))).toBe(true);
    expect(cmds.some((c) => c.includes("no delegator/parent on record"))).toBe(false);
  });

  it("t-f660d8: declaredOwner alone still frames primer when spawn omits parent", async () => {
    const { manager, cmds } = harness(
      "agents:\n  codex:\n    cmd: claude\n    subagents: [reviewer]\n  reviewer:\n    cmd: claude\n",
    );
    await manager.spawn("reviewer"); // no opts.parent — still declaredOwner=codex from subagents
    expect(cmds.some((c) => c.includes("spawned by \"codex\""))).toBe(true);
  });

  it("t-f660d8: declared agent honors explicit cwd", async () => {
    const { manager, ws, newSessionArgs } = harness("agents:\n  reviewer:\n    cmd: sh\n");
    const custom = path.join(ws, "custom-cwd");
    fs.mkdirSync(custom, { recursive: true });
    await manager.spawn("reviewer", { cwd: custom });
    // Declared non-adapter may not write a ledger row; tmux new-session -c is the launch contract.
    const flat = newSessionArgs.flat().join("\0");
    expect(flat).toContain(path.resolve(custom));
    const cIdx = newSessionArgs[0]?.indexOf("-c") ?? -1;
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(newSessionArgs[0]?.[cIdx + 1]).toBe(path.resolve(custom));
  });

  it("t-f660d8: parented ad-hoc with explicit cwd fails closed", async () => {
    const { manager, ws } = harness("agents:\n  boss:\n    cmd: claude\n");
    await manager.spawn("boss");
    const other = path.join(ws, "other");
    fs.mkdirSync(other, { recursive: true });
    await expect(
      manager.spawn("kid", { cmd: "sh", parent: "boss", cwd: other }),
    ).rejects.toThrow(/cwd is not used for parented ad-hoc|inherit the parent's cwd/i);
  });

  it("t-f660d8: missing spawn cwd fails closed", async () => {
    const { manager, ws } = harness("agents:\n  reviewer:\n    cmd: sh\n");
    await expect(
      manager.spawn("reviewer", { cwd: path.join(ws, "does-not-exist") }),
    ).rejects.toThrow(/not an existing directory/i);
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
    await manager.rehydrateFromLedger();
    void ws;
    await manager.restart("w", { stop: "force", session: "new" });
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

  it("finalizes restart quarantine only after refreshing the durable worktree ledger", async () => {
    const REC = { path: "/wt/h/dev", branch: "tachyon/dev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let durableLedger: SessionLedger | undefined;
    const completed: string[] = [];
    const h = harness("agents:\n  dev:\n    cmd: sh\n    kind: terminal\n    worktree: true\n", {
      resolveSpawnCwd: async (ctx) => ({
        cwd: REC.path,
        worktree: REC,
        ...(ctx.isRestart ? { preparationLocked: true } : {}),
      }),
      completePreparedWorktree: async (record) => {
        expect(durableLedger?.get("dev")?.worktree).toEqual(record);
        completed.push(record.path);
      },
    });
    durableLedger = h.ledger;

    await h.manager.spawn("dev");
    await h.manager.restart("dev", { stop: "force", session: "new" });

    expect(completed).toEqual([REC.path]);
  });

  it("reports the locked recovery checkout when restart fails after quarantine acquisition", async () => {
    const REC = { path: "/wt/h/dev", branch: "tachyon/dev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let tokenCalls = 0;
    const h = harness("agents:\n  dev:\n    cmd: claude\n    worktree: true\n", {
      resolveSpawnCwd: async (ctx) => ({ cwd: REC.path, worktree: REC, ...(ctx.isRestart ? { preparationLocked: true } : {}) }),
      mintAgentToken: () => {
        tokenCalls += 1;
        if (tokenCalls > 1) throw new Error("injected restart preparation failure");
        return { TACHYON_AGENT_TOKEN: "token" };
      },
    });
    await h.manager.spawn("dev");

    const failure = await h.manager.restart("dev", { stop: "force", session: "new" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/injected restart preparation failure.*locked recovery checkout: \/wt\/h\/dev/) });
  });

  it("revokes a freshly minted restart token when the failed launch is proven sessionless", async () => {
    const revoked: string[] = [];
    let newSessionCalls = 0;
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) {
        newSessionCalls += 1;
        throw new Error("injected restart new-session failure");
      }
      if (args[2] === "has-session" || args[2] === "list-sessions") throw new Error("no session");
      if (args[2] === "list-panes") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const h = harness("agents:\n  dev:\n    cmd: claude\n", {
      tmux: new TmuxService(exec),
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "restart-token" }),
      revokeAgentToken: (name) => { revoked.push(name); },
    });

    const failure = await h.manager.restart("dev", { stop: "force", session: "new" }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: "injected restart new-session failure" });
    expect(newSessionCalls).toBe(1);
    expect(revoked).toEqual(["dev"]);
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

  it("retries a durable recovery handle and keeps the token when a post-readiness ledger write fails with a live runtime", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const revoked: string[] = [];
    let completed = 0;
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "b" }),
      completePreparedWorktree: async () => { completed += 1; },
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "token" }),
      revokeAgentToken: (name) => { revoked.push(name); },
    });
    const realRecord = h.ledger.record.bind(h.ledger);
    let recordCalls = 0;
    vi.spyOn(h.ledger, "record").mockImplementation((name, record) => {
      recordCalls += 1;
      if (recordCalls === 1) throw new Error("injected ledger record failure");
      realRecord(name, record);
    });
    vi.spyOn(h.tmux, "killSession").mockRejectedValueOnce(new Error("injected kill failure"));

    const failure = await h.manager.spawn("reviewer", { cmd: "claude", parent: "boss" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/locked recovery checkout: \/wt\/h\/reviewer.*live recovery session/) });
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "injected ledger record failure" });
    expect(recordCalls).toBe(2);
    expect(h.ledger.get("reviewer")?.worktree).toEqual(REC);
    expect(h.sessions.has(h.manager.session("reviewer"))).toBe(true);
    expect(revoked).toEqual([]);
    expect(completed).toBe(0);
  });

  it("kills and probes before revoking a token when the post-readiness Bridge stamp fails", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const revoked: string[] = [];
    let completed = 0;
    let rolledBack = 0;
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "b" }),
      completePreparedWorktree: async () => { completed += 1; },
      rollbackPreparedWorktree: async () => { rolledBack += 1; },
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "token" }),
      revokeAgentToken: (name) => { revoked.push(name); },
      getBridgeGeneration: () => { throw new Error("injected Bridge stamp failure"); },
    });

    const failure = await h.manager.spawn("reviewer", { cmd: "claude", parent: "boss" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringContaining("locked recovery checkout: /wt/h/reviewer") });
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "injected Bridge stamp failure" });
    expect(h.sessions.has(h.manager.session("reviewer"))).toBe(false);
    expect(h.ledger.get("reviewer")?.worktree).toEqual(REC);
    expect(revoked).toEqual(["reviewer"]);
    expect(rolledBack).toBe(0);
    expect(completed).toBe(0);
  });

  it("compensates token and checkout preparation when replacing a dead pane cannot be killed", async () => {
    const REC = { path: "/wt/h/dev", branch: "tachyon/dev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const tmux = fakeTmux();
    const revoked: string[] = [];
    const rolledBack: unknown[][] = [];
    let resolutions = 0;
    const h = harness("agents:\n  dev:\n    cmd: claude\n    worktree: true\n", {
      tmux: tmux.tmux,
      resolveSpawnCwd: async () => {
        resolutions += 1;
        return resolutions === 1
          ? { cwd: REC.path, worktree: REC }
          : {
              cwd: REC.path,
              worktree: REC,
              preparationLocked: true,
              rollbackHeadSha: "b",
              preparationHeadBefore: "b",
              preparationHeadAfter: "prepared",
            };
      },
      rollbackPreparedWorktree: async (...args) => { rolledBack.push(args); },
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "replacement-token" }),
      revokeAgentToken: (name) => { revoked.push(name); },
    });
    await h.manager.spawn("dev");
    const session = h.manager.session("dev");
    tmux.dead.set(session, 1);
    vi.spyOn(tmux.tmux, "killSession").mockRejectedValueOnce(new Error("injected dead-pane kill failure"));
    const launchesBefore = tmux.newSessionArgs.length;

    const failure = await h.manager.spawn("dev").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringContaining("compensated checkout: /wt/h/dev") });
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "injected dead-pane kill failure" });
    expect(revoked).toEqual(["dev"]);
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0]?.slice(0, 5)).toEqual([REC, "b", "b", "prepared", false]);
    expect(tmux.newSessionArgs).toHaveLength(launchesBefore);
    expect(tmux.sessions.has(session)).toBe(true);
    expect(tmux.dead.has(session)).toBe(true);
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

  it("t-f660d8: parented opencode spawn refuses an explicit cwd instead of pretending to apply it", async () => {
    const { manager, ledger, newSessionArgs, ws } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => null,
    });
    const worktreePath = path.join(ws, "worktrees", "rev");
    fs.mkdirSync(worktreePath, { recursive: true });
    const REC = { path: worktreePath, branch: "tachyon/rev", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    ledger.record("rev", { def: { cmd: "opencode", kind: "agent" }, worktree: REC, cwd: REC.path, declared: false });
    await expect(manager.spawn("helper", { cmd: "opencode", parent: "boss", cwd: REC.path }))
      .rejects.toThrow(/cwd is not used for parented ad-hoc children/);
    expect(newSessionArgs).toHaveLength(0);
  });

  it("t-e2ebe3: parented opencode spawn delegates without requiring isolated worktree", async () => {
    const { manager, newSessionArgs } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => null,
    });
    // Parented ad-hoc children inherit the parent cwd — omit opts.cwd (product fails closed on explicit cwd).
    await manager.spawn("helper", { cmd: "opencode", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
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
        gate: { behaviorTest: "login retry fails then passes", owns: ["src"] },
      }),
    ).rejects.toThrow(/gated delegation requires an isolated worktree/);
  });

  it("gated spawn publishes the canonical Delivery input and returns its exact receipt", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "old-delegation-base", createdAt: "t" };
    let recorded: Parameters<NonNullable<AgentManagerOptions["recordCanonicalDelivery"]>>[0] | undefined;
    const receipt = canonicalSpawnReceipt(REC, "fresh-source-head");
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async (ctx) => {
        expect(ctx.gate?.behaviorTest).toBe("login retry fails then passes");
        return { cwd: REC.path, worktree: REC, delegationBaseSha: "fresh-source-head" };
      },
      recordCanonicalDelivery: (input) => { recorded = input; return receipt; },
    });
    const result = await manager.spawn("reviewer", {
      cmd: "claude",
      parent: "boss",
      delegator: "boss",
      contract: { task: "add login retry", context: "auth flow flakes", constraints: "no new deps", doneWhen: "retry behavior test passes" },
      gate: { behaviorTest: "login retry fails then passes", owns: ["src/auth.ts"] },
    });
    expect(result).toEqual(receipt);
    expect(recorded).toMatchObject({
      name: "reviewer",
      delegator: "boss",
      baseSha: "fresh-source-head",
      worktree: REC,
      gate: { owns: ["src/auth.ts"], behaviorTest: "login retry fails then passes" },
      contract: { task: "add login retry", doneWhen: "retry behavior test passes" },
    });
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.parent).toBeUndefined();
    expect(reviewer?.delegator).toBe("boss");
  });

  it("composes gated onboarding with the fixed oracle path outside implementer ownership", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const { manager, newSessionArgs } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async (ctx) => {
        expect(ctx.gate).toBeDefined();
        ctx.gate!.stubPath = "tests/product/login-retry.invariant.ts";
        return { cwd: REC.path, worktree: REC, delegationBaseSha: "source-head" };
      },
    });

    await manager.spawn("reviewer", {
      cmd: "claude",
      parent: "boss",
      delegator: "boss",
      contract: {
        task: "implement login retry",
        context: "retry behavior is missing",
        constraints: "preserve auth semantics",
        doneWhen: "login retry invariant passes",
      },
      gate: { behaviorTest: "login retry fails then passes", owns: ["src/auth.ts"] },
    });

    const cmd = newSessionArgs[0]?.at(-1) ?? "";
    expect(cmd).toContain("at tests/product/login-retry.invariant.ts");
    expect(cmd).toContain("Owns: src/auth.ts.");
    expect(cmd).not.toContain("Owns: src/auth.ts, tests/product/login-retry.invariant.ts.");
  });

  it("keeps ledger and worktree visible when rejected delegation kill cannot prove the session dead", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const sessions = new Set<string>();
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
      if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]); return { stdout: "", stderr: "" }; }
      if (args[2] === "has-session") { if (!sessions.has(target)) throw new Error("none"); return { stdout: "", stderr: "" }; }
      if (args[2] === "kill-session") throw new Error("injected kill failure");
      if (args[2] === "list-sessions") return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      if (args[2] === "list-panes") return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { manager, ledger } = harness("agents:\n  boss:\n    cmd: claude\n", {
      tmux: new TmuxService(exec), resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC }),
      recordCanonicalDelivery: async () => { throw new Error("canonical reject"); },
    });
    const failure = await manager.spawn("reviewer", { cmd: "claude", delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" }, gate: { behaviorTest: "b", owns: ["src"] } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "canonical reject" });
    expect(ledger.get("reviewer")).toBeDefined();
  });

  it("keeps the checkout quarantined but removes ungated restart authority after a dead runtime's canonical Delivery is rejected", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const removed: string[] = [];
    let completed = 0;
    const { manager, ledger, ws } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "b" }),
      rollbackPreparedWorktree: async () => { removed.push(REC.path); },
      recordCanonicalDelivery: async () => { throw new Error("canonical reject"); },
      completePreparedWorktree: async () => { completed += 1; },
    });
    const failure = await manager.spawn("reviewer", { cmd: "claude", delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" }, gate: { behaviorTest: "b", owns: ["src"] } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "canonical reject" });
    expect(removed).toEqual([]);
    expect(ledger.get("reviewer")).toBeUndefined();
    expect(completed).toBe(0); // delegation intent never became durable, so the quarantine lock stays.

    const reloadedTmux = fakeTmux();
    const reloaded = new AgentManager({
      tmux: reloadedTmux.tmux,
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => configOf("agents:\n  boss:\n    cmd: claude\n"),
      getMaxAgents: () => 8,
      ledger,
    });
    await reloaded.rehydrateFromLedger();
    await expect(reloaded.restart("reviewer", { stop: "force", session: "new" })).rejects.toThrow(/no stored definition/);
    expect(reloadedTmux.newSessionArgs).toHaveLength(0);
  });

  it("unlocks a fresh gated worktree only after ledger and canonical Delivery authority are durable", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const order: string[] = [];
    let durableLedger: SessionLedger | undefined;
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "b" }),
      recordCanonicalDelivery: async () => {
        expect(durableLedger?.get("reviewer")?.worktree).toEqual(REC);
        order.push("delegation");
        return canonicalSpawnReceipt(REC, "b");
      },
      completePreparedWorktree: async (record) => {
        expect(durableLedger?.get("reviewer")?.worktree).toEqual(REC);
        expect(record).toEqual(REC);
        order.push("unlock");
      },
    });
    durableLedger = h.ledger;

    await h.manager.spawn("reviewer", {
      cmd: "claude",
      delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" },
      gate: { behaviorTest: "b", owns: ["src"] },
    });

    expect(order).toEqual(["delegation", "unlock"]);
    expect(h.sessions.has(h.manager.session("reviewer"))).toBe(true);
  });

  it("keeps a live session, durable ledger and recovery lock when final unlock fails", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const notices: string[] = [];
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "b" }),
      recordCanonicalDelivery: async () => canonicalSpawnReceipt(REC, "b"),
      completePreparedWorktree: async () => { throw new Error("injected unlock failure"); },
      notify: (message) => { notices.push(message); },
    });

    await h.manager.spawn("reviewer", {
      cmd: "claude",
      delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" },
      gate: { behaviorTest: "b", owns: ["src"] },
    });

    expect(h.sessions.has(h.manager.session("reviewer"))).toBe(true);
    expect(h.ledger.get("reviewer")?.worktree).toEqual(REC);
    expect(notices).toContainEqual(expect.stringContaining("worktree remains locked for recovery"));
    expect(notices).toContainEqual(expect.stringContaining("injected unlock failure"));
  });

  it("fails a gated launch closed when canonical Delivery storage is not wired", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let completed = 0;
    let resolved = 0;
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => { resolved += 1; return { cwd: REC.path, worktree: REC, preparationLocked: true }; },
      recordCanonicalDelivery: undefined,
      completePreparedWorktree: async () => { completed += 1; },
    });

    const failure = await h.manager.spawn("reviewer", {
      cmd: "claude",
      delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" },
      gate: { behaviorTest: "b", owns: ["src"] },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: "gated delegation requires canonical Delivery persistence" });
    expect(resolved).toBe(0);
    expect(completed).toBe(0);
    expect(h.ledger.get("reviewer")).toBeUndefined();
    expect(h.sessions.has(h.manager.session("reviewer"))).toBe(false);
  });

  it("preserves an advanced reused-worktree preparation when new-session fails and no pane exists", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: false, baseRef: "base", createdAt: "t" };
    const preserved: unknown[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("new-session")) throw new Error("injected new-session failure");
      if (args[2] === "has-session" || args[2] === "list-sessions") throw new Error("no server");
      if (args[2] === "list-panes") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { manager, ledger } = harness("agents:\n  boss:\n    cmd: claude\n", {
      tmux: new TmuxService(exec),
      resolveSpawnCwd: async () => ({
        cwd: REC.path,
        worktree: REC,
        created: false,
        preparationLocked: true,
        rollbackHeadSha: "base",
        preparationHeadBefore: "base",
        preparationHeadAfter: "prepared",
      }),
      rollbackPreparedWorktree: async (...args) => {
        preserved.push(args);
        throw new Error("prepared worktree recovery state was preserved");
      },
    });

    const failure = await manager.spawn("reviewer", {
      cmd: "sh",
      delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" },
      gate: { behaviorTest: "cmd:node check.mjs", owns: ["src"] },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "injected new-session failure" });
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.slice(0, 5)).toEqual([REC, "base", "base", "prepared", false]);
    expect(ledger.get("reviewer")).toBeUndefined();
  });

  it("reports locked recovery and revokes the token after a rejected launch is proven dead", async () => {
    const REC = { path: "/wt/h/codex", branch: "tachyon/codex", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const revoked: string[] = [];
    const h = harness("agents:\n  codex:\n    cmd: codex\n    worktree: true\n", {
      resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true, preparationLocked: true, rollbackHeadSha: "base" }),
      launchPreflight: { check: async () => ({ state: "supported", runtime: "codex", source: "test" }) },
      launchReadiness: { wait: async () => ({ state: "rejected", code: "runtime_auth_rejected" }) },
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "token" }),
      revokeAgentToken: (name) => { revoked.push(name); },
    });

    const failure = await h.manager.spawn("codex").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: expect.stringContaining("locked recovery checkout: /wt/h/codex") });
    expect(revoked).toEqual(["codex"]);
    expect(h.sessions.has(h.manager.session("codex"))).toBe(false);
    expect(h.ledger.get("codex")).toBeUndefined();
  });

  it("never kills an ambiguous same-named pane after new-session reports failure", async () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: false, baseRef: "base", createdAt: "t" };
    const sessions = new Set<string>();
    let killCalls = 0;
    let rollbackCalls = 0;
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
      if (args.includes("new-session")) {
        sessions.add(args[args.indexOf("-s") + 1]);
        throw new Error("duplicate session race");
      }
      if (args[2] === "has-session") {
        if (!sessions.has(target)) throw new Error("none");
        return { stdout: "", stderr: "" };
      }
      if (args[2] === "kill-session") { killCalls += 1; sessions.delete(target); return { stdout: "", stderr: "" }; }
      if (args[2] === "list-sessions") return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      if (args[2] === "list-panes") return { stdout: [...sessions].map((name) => `${name}\t0\t`).join("\n"), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
      tmux: new TmuxService(exec),
      resolveSpawnCwd: async () => ({
        cwd: REC.path,
        worktree: REC,
        preparationHeadBefore: "base",
        preparationHeadAfter: "prepared",
      }),
      rollbackPreparedWorktree: async () => { rollbackCalls += 1; },
    });

    const failure = await manager.spawn("reviewer", {
      cmd: "sh",
      delegator: "boss",
      contract: { task: "t", context: "c", constraints: "x", doneWhen: "d" },
      gate: { behaviorTest: "cmd:node check.mjs", owns: ["src"] },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((error) => String(error).includes("uncertain"))).toBe(true);
    expect(killCalls).toBe(0);
    expect(rollbackCalls).toBe(0);
    expect(sessions.has(manager.session("reviewer"))).toBe(true);
  });

  it("rehydrates a re-discovered ad-hoc agent so it is restartable + re-nested", async () => {
    const { manager, ledger, ws, cmds } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("worker", { def: { cmd: "sh", kind: "terminal", parent: "claude" }, cwd: ws, declared: false });
    await manager.rehydrateFromLedger();
    const worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("claude"); // lineage restored
    await manager.restart("worker", { stop: "force", session: "new" }); // would throw "no stored definition" without rehydrate
    expect(cmds.at(-1)).toBe("sh");
  });

  it("does NOT rehydrate a name that is declared in config (no ad-hoc shadow)", async () => {
    const { manager, ledger, ws } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", { def: { cmd: "sh", kind: "terminal" }, cwd: ws, declared: false }); // stale/odd
    await manager.rehydrateFromLedger();
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
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-a`, key: "C-c" },
      { session: `tachyon-${HASH}-a`, key: "C-c" },
      { session: `tachyon-${HASH}-a`, key: "C-d" },
    ]);
    expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({ running: true, stopping: true });
  });

  it("t-82456f: Codex clears resumed composer state and retries EOF while the pane remains alive", async () => {
    const { manager, sentKeys } = makeManager("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");

    await manager.stopGracefully("codex");

    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-codex`, key: "C-c" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
      { session: `tachyon-${HASH}-codex`, key: "C-d" },
    ]);
  });

  it("graceful stop surfaces a retryable failure when the pane stays alive past fallback", async () => {
    const { manager, sentKeys } = makeManager("agents:\n  a:\n    cmd: x\n");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await manager.spawn("a");
      await manager.stopGracefully("a");
      now.mockReturnValue(1_000 + AgentManager.STOPPING_FALLBACK_MS + 1);
      expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({ running: true, stopFailed: true });
      expect((await manager.list()).find((a) => a.name === "a")).not.toMatchObject({ stopping: true });

      await manager.stopGracefully("a");
      expect(sentKeys).toHaveLength(6);
      expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({ running: true, stopping: true });
      expect((await manager.list()).find((a) => a.name === "a")).not.toMatchObject({ stopFailed: true });
    } finally {
      now.mockRestore();
    }
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

  it("retains a clean-exited ad-hoc postmortem across manager reload until explicit dismiss", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-211f6-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const ledger = new SessionLedger(ws);
    ledger.record("review", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, declared: false }); // clean exit
    ledger.record("boom", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, declared: false }); // crashed
    const { tmux, sessions, dead, panes } = fakeTmux();
    const reviewSession = sessionName(hash, "review");
    const boomSession = sessionName(hash, "boom");
    sessions.add(reviewSession);
    sessions.add(boomSession);
    dead.set(reviewSession, 0);
    dead.set(boomSession, 137);
    panes.set(reviewSession, "durable postmortem");
    const opts = { tmux, wsHash: hash, workspaceRoot: ws, getConfig: () => configOf("agents:\n  decoy:\n    cmd: x\n"), getMaxAgents: () => 8, ledger };
    const manager = new AgentManager(opts);
    await manager.rehydrateFromLedger();
    await expect(manager.dismissCleanExitPane("review")).resolves.toBe(true);
    expect(ledger.get("review")?.lifecycle).toMatchObject({ state: "clean-exited" });
    expect(ledger.get("boom")).toBeDefined();

    const reloaded = new AgentManager(opts);
    await reloaded.rehydrateFromLedger();
    expect((await reloaded.list()).find((a) => a.name === "review")).toMatchObject({
      cleanExited: true,
      running: false,
      dead: false,
    });
    reloaded.dismissAdhoc("review");
    expect(ledger.get("review")).toBeUndefined();
    expect((await reloaded.list()).find((a) => a.name === "review")).toBeUndefined();
  });

  it("dismissAdhoc forgets a sessionless stopped ad-hoc — def, lineage AND ledger row", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, declared: false });
    await manager.rehydrateFromLedger();
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeDefined();
    manager.dismissAdhoc("ghost");
    expect(ledger.get("ghost")).toBeUndefined(); // won't rehydrate after reload
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeUndefined(); // gone from the live listing
  });

  it("dismissAdhoc emits the lifecycle callback so Bridge callers refresh the sidebar", async () => {
    const killed: string[] = [];
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n", { onKilled: (name) => killed.push(name) });
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, declared: false });
    await manager.rehydrateFromLedger();
    manager.dismissAdhoc("ghost");
    expect(killed).toEqual(["ghost"]);
  });

  it("rename rewrites a child's persisted parent in the ledger", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("parent", { def: { cmd: "claude", kind: "agent" }, cwd: ws, declared: false });
    ledger.record("child", { def: { cmd: "sh", kind: "terminal", parent: "parent" }, cwd: ws, declared: false });
    await manager.rehydrateFromLedger();
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
    await manager.restart("a", { stop: "force", session: "new" });
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

describe("AgentManager — Bridge wiring fail-closed (t-d42565)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function harness211(yaml: string, extra: Partial<ConstructorParameters<typeof AgentManager>[0]> = {}) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-d42565-"));
    const ledger = new SessionLedger(ws);
    const sessions = new Set<string>();
    const cmds: string[] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]); cmds.push(args[args.length - 1]); return { stdout: "", stderr: "" }; }
      switch (args[2]) {
        case "has-session": if (!sessions.has(target())) throw new Error("none"); return { stdout: "", stderr: "" };
        case "kill-session": sessions.delete(target()); return { stdout: "", stderr: "" };
        case "list-panes": return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
        case "list-sessions": if (!sessions.size) throw new Error("no server"); return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
        default: return { stdout: "", stderr: "" };
      }
    };
    const manager = new AgentManager({
      tmux: new TmuxService(exec),
      wsHash: workspaceHash(ws),
      workspaceRoot: ws,
      getConfig: () => configOf(yaml),
      getMaxAgents: () => 8,
      ledger,
      ...extra,
    });
    dirs.push(ws);
    return { manager, ledger, cmds, ws };
  }

  it("refuses AI ad-hoc spawn when Bridge URL is set but MCP materialization fails", async () => {
    const { manager } = harness211("agents:\n  boss:\n    cmd: claude\n", {
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
      materializeBridgeMcp: () => undefined, // claude path cannot wire
    });
    await expect(
      manager.spawn("child", { cmd: "claude", parent: "boss", instructions: "do work" }),
    ).rejects.toThrow(/Bridge tools could not be materialized|notify_agent/i);
  });

  it("allows AI spawn without Bridge URL (no false fail when Bridge is down)", async () => {
    const { manager, cmds } = harness211("agents:\n  boss:\n    cmd: claude\n", {
      getExtraEnv: () => ({}),
    });
    await manager.spawn("child", { cmd: "claude", parent: "boss", instructions: "do work" });
    expect(cmds.length).toBe(1);
  });

  it("allows a non-AI agent command when Bridge MCP materialization does not apply", async () => {
    const { manager, cmds } = harness211("agents:\n  worker:\n    cmd: sh\n", {
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
    });
    await manager.spawn("worker");
    expect(cmds.at(-1)).toBe("sh");
  });

  it("allows AI spawn when materialization succeeds", async () => {
    const { manager, cmds, ws } = harness211("agents:\n  boss:\n    cmd: claude\n", {
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
      materializeBridgeMcp: (name) => {
        const f = path.join(ws, `${name}.mcp.json`);
        fs.writeFileSync(f, "{}\n");
        return f;
      },
    });
    await manager.spawn("child", { cmd: "claude", parent: "boss", instructions: "do work" });
    expect(cmds.some((c) => c.includes("--mcp-config"))).toBe(true);
  });
});

describe("AgentManager — durable pane transcripts (t-6a6a00)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  // Real temp workspaceRoot (unlike the module-level WS="/repo" fixture used elsewhere in this file) —
  // ensurePaneTranscriptFile does real fs writes, and "/repo" is deliberately unwritable in this sandbox.
  function pipeTranscriptHarness(yaml: string, tmuxOpts: { failRespawn?: boolean } = {}) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pipepane-am-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const { sessions, pipedSessions, pipePaneArgs, opLog, tmux } = fakeTmux(tmuxOpts);
    const config = configOf(yaml);
    const ledger = new SessionLedger(ws);
    const manager = new AgentManager({
      tmux,
      wsHash: hash,
      workspaceRoot: ws,
      getConfig: () => config,
      getMaxAgents: () => 8,
      ledger,
      resolveCurrentSession: async () => "11111111-1111-4111-8111-111111111111",
      fileExists: () => true,
      recordCanonicalDelivery: async (input) => canonicalSpawnReceipt(input.worktree, input.baseSha),
    });
    return { manager, ws, hash, ledger, sessions, pipedSessions, pipePaneArgs, opLog };
  }

  it("spawn attaches the durable pipe to .tachyon/pane-transcripts/<agent>.log", async () => {
    const { manager, ws, hash, pipedSessions } = pipeTranscriptHarness("agents:\n  worker:\n    cmd: sh\n");
    await manager.spawn("worker");
    const session = sessionName(hash, "worker");
    const file = paneTranscriptPath(ws, "worker");
    expect(pipedSessions.get(session)).toBe(`cat >> '${file}'`);
    expect(fs.existsSync(file)).toBe(true); // pre-created (0600) — not left to the shell's `>>` to create
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("kill detaches the pipe BEFORE killSession (not after — tmux would tear the pipe down anyway on kill, but the design point is explicit detach-first)", async () => {
    const { manager, ws, hash, pipedSessions, opLog } = pipeTranscriptHarness("agents:\n  worker:\n    cmd: sh\n");
    await manager.spawn("worker");
    const session = sessionName(hash, "worker");
    await manager.kill("worker");
    expect(pipedSessions.has(session)).toBe(false);
    const detachIdx = opLog.indexOf(`pipe-pane:detach:${session}`);
    const killIdx = opLog.indexOf(`kill-session:${session}`);
    expect(detachIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeGreaterThan(detachIdx); // detach happened while the session still existed
    // kill is a stop, not a forget — the durable transcript file itself survives.
    expect(fs.existsSync(paneTranscriptPath(ws, "worker"))).toBe(true);
  });

  it("restart (respawn-pane path) re-attaches the pipe idempotently on the SAME session", async () => {
    const { manager, hash, pipedSessions, pipePaneArgs } = pipeTranscriptHarness("agents:\n  worker:\n    cmd: sh\n");
    await manager.spawn("worker");
    const session = sessionName(hash, "worker");
    const attachesAfterSpawn = pipePaneArgs.length;
    await manager.restart("worker", { stop: "force", session: "new" });
    expect(pipedSessions.has(session)).toBe(true); // still piping after restart
    expect(pipePaneArgs.length).toBeGreaterThan(attachesAfterSpawn); // re-attached, not skipped
  });

  it("commitFork attaches the pipe on the fork's own new session", async () => {
    const { manager, ws, hash, pipedSessions } = pipeTranscriptHarness("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    await manager.commitFork(await manager.planFork("claude"));
    const forkSession = sessionName(hash, "claude-fork-1");
    expect(pipedSessions.has(forkSession)).toBe(true);
    expect(fs.existsSync(paneTranscriptPath(ws, "claude-fork-1"))).toBe(true);
  });

  it("kill of an AD-HOC one-shot removes its durable transcript too (kill IS the forget for ad-hoc — spec 247 parity, not a new gap)", async () => {
    const { manager, ws } = pipeTranscriptHarness("agents:\n  decoy:\n    cmd: x\n");
    await manager.spawn("oneshot", { cmd: "sh" });
    expect(paneTranscriptExists(ws, "oneshot")).toBe(true);
    await manager.kill("oneshot");
    expect(paneTranscriptExists(ws, "oneshot")).toBe(false);
  });

  it("forgetAgent (the canonical ephemeral-footprint cleanup) removes the durable pane transcript file", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pipepane-forget-"));
    dirs.push(ws);
    const file = ensurePaneTranscriptFile(ws, "oneshot");
    fs.writeFileSync(file, "leftover output\n", "utf8");
    expect(fs.existsSync(file)).toBe(true);
    expect(() => forgetAgent("oneshot", { workspaceRoot: ws })).not.toThrow();
    expect(fs.existsSync(file)).toBe(false);
    // idempotent — forgetting an agent with no transcript at all must not throw.
    expect(() => forgetAgent("never-existed", { workspaceRoot: ws })).not.toThrow();
  });

  it("attach is best-effort: an unwritable workspace root never blocks or throws during spawn", async () => {
    // WS ("/repo") is a symbolic, deliberately unwritable fixture used across this file — mirrors
    // the constructor-optional-side-effect convention the rest of AgentManager already follows.
    const { manager, sessions } = makeManager("agents:\n  worker:\n    cmd: sh\n");
    await expect(manager.spawn("worker")).resolves.not.toThrow();
    expect(sessions.has(sessionName(HASH, "worker"))).toBe(true);
  });
});
