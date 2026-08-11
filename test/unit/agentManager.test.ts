import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { PARENT_CWD_REFUSAL } from "../../src/bridge/spawnContract.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager, MaxAgentsError, ResumeUnavailableError, ForkUnavailableError, WatchController, newlyDeclaredAutostart, type AgentManagerOptions, type SpawnReveal } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "../../src/tmux/TmuxService.js";
import { RuntimeLaunchPreflightRegistry } from "../../src/runtime/launchPreflight.js";
import { GrokLaunchPreflight } from "../../src/runtime/adapters/grokLaunchPreflight.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { asAgent, parseConfig, type AgentPermissionProjectionEntry, type TachyonConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { readSessionOwners, sessionOwnersFile, spawnSettingsPath } from "../../src/activity/sessionOwners.js";
import { FORGET_AGENT_FOOTPRINTS, forgetAgent } from "../../src/agents/forgetAgent.js";
import {
  POST_CUT_SESSION_ATTESTATION,
  POST_CUT_SESSION_ATTESTATION_ENV,
  withPostCutAttestation,
} from "../../src/agents/legacyFleetGate.js";
import { HarnessManager, bridgeGrokHome, bridgeHermesHome, harnessHome, opencodeHarnessDirs } from "../../src/harness/HarnessManager.js";
import { adapterFor, harnessable } from "../../src/resume/adapters.js";
import { CallerIdentityRegistry } from "../../src/bridge/callerIdentity.js";
import { briefFilePath } from "../../src/agents/briefFile.js";
import { identityLine, notifyParentGuidance, noInteractivePromptGuidance } from "../../src/bridge/spawnContract.js";
import { paneTranscriptPath, paneTranscriptExists, ensurePaneTranscriptFile } from "../../src/agents/paneTranscript.js";
import type { ResolvedAgentCapabilityProjection } from "../../src/config/agentProfileResolver.js";
import type { ResolvedAgentNativeConfigProjection } from "../../src/config/agentNativeConfigPolicy.js";
import { agentGroupParent, agentIsNested } from "../../src/webview/sidebar/grouping.js";
import type { AgentVM } from "../../src/sidebar/types.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/** t-0338fc — see the helper: opencode's adapter executes the runtime, so it is stubbed here. */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();


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
  // t-ab2682 — an actual composer, for the paths that READ the pane before acting on it. A fixed
  // frame cannot express "occupied, then cleared", and counting captures is brittle because
  // `refreshOwnership` and `interruptActiveTurn` read the pane too. So sessions listed here model
  // the measured editor instead: Ctrl-C clears the draft, literal text is appended to it, and Enter
  // submits it. Sessions absent from this map keep reading `panes` and are untouched.
  const composerDrafts = new Map<string, string>();
  /** Sessions whose runtime really exits when a submitted draft is `/exit` (claude's measured behaviour). */
  const exitsOnExitCommand = new Set<string>();
  /** Text that lands in the composer alongside literal text as it is typed — a notice or a human
   *  keystroke arriving in the same beat, which is what makes a later Enter submit THEIR content. */
  const composerInterloper = new Map<string, string>();
  /** t-ab2682 — a draft that lands ONCE just after a Ctrl-C clears the composer: the spawn brief
   *  winning the race against the stop. This is what makes the defect reproducible in a fake — a
   *  draft that is simply present before the stop is cleared by the profile's own Ctrl-C and never
   *  reaches the typing step. */
  const composerArrival = new Map<string, string>();
  /** What each Enter actually submitted. The defect is visible only here: the old delivery submitted
   *  the staged line WITH `/exit` appended to it, as a prompt. */
  const submittedLines: Array<{ session: string; text: string }> = [];
  const sessionEnv = new Map<string, Record<string, string>>(); // launch env from -e / set-environment
  const sentKeys: Array<{ session: string; key: string }> = [];
  const sentTexts: Array<{ session: string; text: string; submit: boolean }> = [];
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
      case "send-keys": {
        const t = target();
        const key = args[args.length - 1];
        sentKeys.push({ session: t, key });
        if (args.includes("-l")) sentTexts.push({ session: t, text: key, submit: false });
        if (composerDrafts.has(t)) {
          if (args.includes("-l")) composerDrafts.set(t, composerDrafts.get(t)! + key + (composerInterloper.get(t) ?? ""));
          else if (key === "C-c") {
            const arriving = composerArrival.get(t);
            composerArrival.delete(t);
            composerDrafts.set(t, arriving ?? "");
          }
          else if (key === "C-m") {
            const submitted = composerDrafts.get(t)!;
            submittedLines.push({ session: t, text: submitted });
            composerDrafts.set(t, "");
            if (submitted.trim() === "/exit" && exitsOnExitCommand.has(t)) dead.set(t, 0);
          }
        }
        return { stdout: "", stderr: "" };
      }
      case "capture-pane": {
        const t = target();
        if (!sessions.has(t)) throw new Error("can't find session");
        const draft = composerDrafts.get(t);
        if (draft !== undefined) return { stdout: `${panes.get(t) ?? ""}\n❯ ${draft}`, stderr: "" };
        return { stdout: panes.get(t) ?? "", stderr: "" };
      }
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
  return { sessions, dead, panes, composerDrafts, exitsOnExitCommand, composerInterloper, composerArrival, submittedLines, sessionEnv, sentKeys, sentTexts, respawnArgs, newSessionArgs, pipedSessions, pipePaneArgs, opLog, tmux: new TmuxService(exec) };
}

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeManager(yaml: string, tmuxOpts: { failRespawn?: boolean; failShowEnvironment?: boolean } = {}) {
  const { sessions, dead, panes, composerDrafts, exitsOnExitCommand, composerInterloper, composerArrival, submittedLines, sentKeys, sentTexts, respawnArgs, newSessionArgs, tmux } = fakeTmux(tmuxOpts);
  const config = configOf(yaml);
  const spawned: string[] = [];
  const killed: string[] = [];
  const restarted: string[] = [];
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    onSpawned: (n) => spawned.push(n),
    onKilled: (n) => killed.push(n),
    onRestart: (n) => restarted.push(n),
    materializeHarness: ({ name, def }) => adapterFor(def.cmd)?.runtime === "pi"
      ? { home: `/private/pi/${name}`, env: { PI_CODING_AGENT_DIR: `/private/pi/${name}`, PI_CODING_AGENT_SESSION_DIR: `/private/pi/${name}/sessions` }, args: [] }
      : null,
    materializePiSessionDir: (name) => `/private/pi/${name}/sessions`,
    launchPreflight: HERMETIC_PREFLIGHT,
  });
  return { manager, tmux, sessions, dead, panes, composerDrafts, exitsOnExitCommand, composerInterloper, composerArrival, submittedLines, sentKeys, sentTexts, respawnArgs, newSessionArgs, spawned, killed, restarted };
}

describe("AgentManager", () => {
  it("spawns a declared agent into a namespaced session", async () => {
    const { manager, sessions, spawned } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
    expect(spawned).toEqual(["claude"]);
  });

  it("rejects spawning an unknown agent without a Temporary cmd, accepts with one", async () => {
    const { manager, sessions } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.spawn("ghost")).rejects.toThrow("unknown agent");
    await manager.spawn("ghost", { cmd: "claude" });
    expect(sessions.has(`tachyon-${HASH}-ghost`)).toBe(true);
  });

  /**
   * t-9418ac — lineage is IDENTITY, and identity is agent-only: a terminal has no parent to inherit
   * from. The editor-host suite used to assert this by spawning `cmd: sh` and calling it an agent,
   * which the product now (correctly) refuses. Re-based here on the real AgentManager with a fake
   * tmux, so the semantics are proven without a fake process standing in for a runtime.
   */
  describe("lineage (spec 197)", () => {
    it("records the parent of a Temporary child and exposes it on both reads", async () => {
      const { manager, sessions } = makeManager("agents:\n  orchestrator:\n    cmd: codex\n");
      await manager.spawn("orchestrator");
      await manager.spawn("lineage-child", { cmd: "codex", parent: "orchestrator" });

      expect(sessions.has(`tachyon-${HASH}-lineage-child`)).toBe(true);
      expect(manager.parentOf("lineage-child")).toBe("orchestrator");
      const child = (await manager.list()).find((a) => a.name === "lineage-child");
      expect(child?.running).toBe(true);
      expect(child?.parent).toBe("orchestrator");
      expect(child?.lifetime).toBe("temporary");
    });

    it("a spawn without a parent records none — lineage is never inferred", async () => {
      const { manager } = makeManager("agents:\n  orchestrator:\n    cmd: codex\n");
      await manager.spawn("orchestrator");
      await manager.spawn("loner", { cmd: "codex" });
      expect(manager.parentOf("loner")).toBeUndefined();
      expect((await manager.list()).find((a) => a.name === "loner")?.parent).toBeUndefined();
    });

    it("the recorded parent OUTLIVES the parent's death — promotion is a render decision", async () => {
      // Measured, and worth stating because the opposite is the intuitive guess: killing the parent
      // does NOT rewrite or erase the child's link. A stopped agent that remains in the roster also
      // keeps its own parent; only collection/dismissal erases that identity fact.
      // The child is promoted to top level when it is RENDERED, because the sidebar nests only
      // against parents that are actually present in the row set. Keeping the recorded fact and
      // deciding presentation separately is what lets a re-spawned parent re-adopt its children.
      const { manager } = makeManager("agents:\n  orchestrator:\n    cmd: codex\n");
      await manager.spawn("orchestrator");
      await manager.spawn("lineage-child", { cmd: "codex", parent: "orchestrator" });
      expect(manager.parentOf("lineage-child")).toBe("orchestrator");

      await manager.kill("orchestrator");
      expect(manager.parentOf("lineage-child")).toBe("orchestrator");

      // The render half: with the parent gone from the row set, the child nests under nobody.
      const orphan = { name: "lineage-child", status: "running", parent: "orchestrator" } as AgentVM;
      expect(agentGroupParent(orphan)).toBe("orchestrator");
      expect(agentIsNested(orphan, new Set(["lineage-child"]))).toBe(false);
      expect(agentIsNested(orphan, new Set(["lineage-child", "orchestrator"]))).toBe(true);
    });
  });

  it("rejects double-spawn of a running agent", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    await expect(manager.spawn("a")).rejects.toThrow("already running");
  });

  // t-aaad95 — these two used to pin the PRECEDENCE between tachyon.yml and the `tachyon.maxAgents`
  // editor setting (yml won; the editor setting answered only when yml was silent). The editor key is
  // gone, so what is left to pin is that tachyon.yml is the authority and the built-in guardrail is
  // what answers when it says nothing — the same two observable outcomes, one source instead of two.
  it("enforces maxAgents from tachyon.yml settings", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n");
    await manager.spawn("a");
    await expect(manager.spawn("b")).rejects.toThrow(MaxAgentsError);
  });

  it("reports the limit it enforced", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n");
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

  /**
   * t-e73e54 — the gate refuses to activate a workspace holding an agent session without this proof,
   * and restart/resume used to produce exactly that. The remedy the refusal names is "restart the
   * fleet", which went through the broken path — so the workspace could not escape its own error.
   *
   * Asserted on the tmux arguments actually observed, per path, because the bug was a creation path
   * that never routed through the mint: exercising only the door we knew about is what missed it.
   */
  describe("t-e73e54 — every agent session creation carries the post-cut attestation", () => {
    const ATTESTED = `${POST_CUT_SESSION_ATTESTATION_ENV}=${POST_CUT_SESSION_ATTESTATION}`;

    it("mints on a fresh spawn", async () => {
      const { manager, newSessionArgs } = makeManager("agents:\n  a:\n    cmd: x\n");

      await manager.spawn("a");

      expect(newSessionArgs.at(-1)).toContain(ATTESTED);
    });

    it("mints on a respawn-in-place restart", async () => {
      // The path a live agent takes on an ordinary restart: the pane is reused, so the env has to be
      // re-applied rather than inherited. Respawn carries env as `set-environment -t <target> KEY
      // VALUE` — key and value as separate argv entries — not as the `-e KEY=VALUE` new-session uses.
      const { manager, respawnArgs } = makeManager("agents:\n  a:\n    cmd: x\n");
      await manager.spawn("a");

      await manager.restart("a", { stop: "force", session: "new" });

      expect(respawnArgs).not.toHaveLength(0);
      const args = respawnArgs.flat();
      const at = args.indexOf(POST_CUT_SESSION_ATTESTATION_ENV);
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 1]).toBe(POST_CUT_SESSION_ATTESTATION);
    });

    it("mints on the kill+new replacement restart", async () => {
      // The fallback when respawn fails — a genuinely new session, and the one that produced the
      // unattested session observed in the field.
      const { manager, newSessionArgs } = makeManager("agents:\n  a:\n    cmd: x\n", { failRespawn: true });
      await manager.spawn("a");

      await manager.restart("a", { stop: "force", session: "new" });

      expect(newSessionArgs.at(-1)).toContain(ATTESTED);
    });

    it("a caller-supplied attestation cannot override the minted one", () => {
      // Forging matters because the value is the protocol version: a session claiming an older cut
      // would be read as proof by a build that accepts it.
      expect(withPostCutAttestation({ [POST_CUT_SESSION_ATTESTATION_ENV]: "agent-instance-v4" }))
        .toEqual({ [POST_CUT_SESSION_ATTESTATION_ENV]: POST_CUT_SESSION_ATTESTATION });
    });
  });

  it("t-4d2630: restart falls back to kill+new (and onRestart) when respawn fails", async () => {
    const { manager, sessions, respawnArgs, newSessionArgs, restarted } = makeManager(
      "agents:\n  a:\n    cmd: x\n",
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

    it("graceful+new stops, times out, session-only hard-kills, then new-section (no Temporary wipe)", async () => {
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
          instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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

  /**
   * t-e3aaae — a session:new restart mints a NEW conversation, so everything the agent learned after
   * it was spawned is gone. Measured failure: `claude-opus5` was parked with skip_contract_reason,
   * handed `t-5bfb72` afterwards, restarted graceful+new, and came back to a brief made of nothing
   * but its own name and the doorbell guidance. It recovered the task by scanning the board for
   * `assignee == me && status == active`, and — with nothing on record about isolation — committed
   * straight to the primary checkout. The replacement brief must STATE both facts.
   */
  describe("t-e3aaae restart states the work on record", () => {
    const ASSIGNED = {
      id: "t-5bfb72",
      title: "SDD 477 auth-required mid-run",
      status: "active",
      priority: 2,
      body: "Hold the assigned task while the credential is missing; recovery stays human-explicit.",
    };
    // The exact poisoned ledger shape: protocol boilerplate only, no task text anywhere.
    const BOILERPLATE_BRIEF = [
      identityLine("worker"),
      notifyParentGuidance("codex-canonico"),
      noInteractivePromptGuidance("codex-canonico"),
    ].join("\n\n");

    function harness(root: string, overrides: Partial<AgentManagerOptions> = {}) {
      const fake = fakeTmux();
      const ledger = new SessionLedger(root);
      const manager = new AgentManager({
        tmux: fake.tmux,
        wsHash: workspaceHash(root),
        workspaceRoot: root,
        getConfig: () => configOf("agents:\n  anchor:\n    cmd: sh\n"),
        ledger,
        assignedWork: () => [ASSIGNED],
        ...overrides,
      });
      return { fake, ledger, manager, session: sessionName(workspaceHash(root), "worker") };
    }

    /** Everything the replacement session was actually handed (inline pane payload + brief file). */
    function delivered(root: string, fake: ReturnType<typeof fakeTmux>, from: { news: number; respawns: number }): string {
      const panes = [
        ...fake.newSessionArgs.slice(from.news),
        ...fake.respawnArgs.slice(from.respawns),
      ].map((args) => args.at(-1) ?? "");
      const file = briefFilePath(root, "worker");
      return [...panes, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""].join("\n");
    }

    function mark(fake: ReturnType<typeof fakeTmux>) {
      return { news: fake.newSessionArgs.length, respawns: fake.respawnArgs.length };
    }

    // The four ways a session ends up needing a fresh conversation. They differ only in how the
    // previous process died, and every one of them must arrive at the same stated record.
    const ENTRY_CONDITIONS = [
      ["clean exit", (fake: ReturnType<typeof fakeTmux>, session: string) => { fake.dead.set(session, 0); }, { stop: "graceful", session: "new" }],
      ["auth-rejected", (fake: ReturnType<typeof fakeTmux>, session: string) => {
        fake.dead.set(session, 1);
        fake.panes.set(session, "Invalid API key · Please run /login");
      }, { stop: "graceful", session: "new" }],
      // Context exhaustion leaves the pane ALIVE but useless — the graceful stop times out and the
      // session is hard-killed before the replacement starts. This is the measured repro's shape.
      ["context exhaustion", (fake: ReturnType<typeof fakeTmux>, session: string) => {
        fake.panes.set(session, "Context low · Run /compact to compact the conversation");
      }, { stop: "graceful", session: "new", gracefulTimeoutMs: 0 }],
      ["stopped session", (fake: ReturnType<typeof fakeTmux>, session: string) => { fake.sessions.delete(session); }, { stop: "force", session: "new" }],
    ] as const;

    it.each(ENTRY_CONDITIONS)("materializes the assigned task after %s", async (_label, arrange, restartOpts) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-entry-"));
      try {
        const { fake, manager, session } = harness(root);
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        arrange(fake, session);
        const from = mark(fake);

        await manager.restart("worker", { ...restartOpts });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("t-5bfb72");
        expect(brief).toContain("SDD 477 auth-required mid-run");
        expect(brief).toContain("Hold the assigned task while the credential is missing");
        expect(brief).toContain("you do not need to look it up");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("states the shared checkout authorizes nothing, so main is not the default place to work", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-shared-"));
      try {
        const { fake, manager } = harness(root);
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("Isolation: none on record");
        expect(brief).toContain("nothing here authorizes committing to the trunk");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("restates the durable worktree and branch the agent must stay inside", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-worktree-"));
      const checkout = path.join(root, "wt");
      fs.mkdirSync(checkout, { recursive: true });
      try {
        const worktree = {
          path: checkout,
          branch: "tachyon/change/t-5bfb72",
          tachyonCreatedBranch: true,
          baseRef: "main",
          createdAt: "2026-07-27T00:00:00.000Z",
        };
        const { fake, manager } = harness(root, {
          resolveSpawnCwd: async () => ({ cwd: checkout, worktree }),
        });
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain(`Isolation: git worktree ${checkout} on branch tachyon/change/t-5bfb72.`);
        expect(brief).toContain("Do not edit, commit to, or push the primary checkout");
        expect(brief).not.toContain("Isolation: none on record");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("forbids adopting work off the board when nothing is assigned", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-unassigned-"));
      try {
        const { fake, manager } = harness(root, { assignedWork: () => [] });
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("Assigned work on record: none.");
        expect(brief).toContain("Do not adopt work by scanning the board");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("names ONE current task and queues the other, rather than letting the agent pick (t-9d250c)", async () => {
      // t-e3aaae listed every assigned task as an equal and asked the agent to choose. Measured
      // consequence: a restarted session chose the one its FROZEN brief still named, which is the one
      // most likely to be finished (both t-9d250c incidents). The board picks now, deterministically.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-9d250c-ambiguous-"));
      try {
        const second = { id: "t-939a18", title: "SDD 478 M1", status: "active", priority: 1 };
        const { fake, manager } = harness(root, { assignedWork: () => [ASSIGNED, second] });
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        // priority 1 outranks ASSIGNED's 2, so the more urgent one is the contract and the other queues
        expect(brief).toContain("Your current task, read from the board at restart");
        expect(brief).toContain("t-939a18");
        expect(brief).toContain("NOT your current task");
        expect(brief).toContain("- t-5bfb72 — SDD 477 auth-required mid-run");
        expect(brief).not.toContain("say which one you are taking");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("names the finished task its own frozen brief still carries (t-9d250c incident 2)", async () => {
      // The restart replays the spawn brief verbatim. When that brief names work the board says is
      // landed, the record now answers it in the same document instead of leaving the agent to notice.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-9d250c-stale-contract-"));
      try {
        const { fake, manager } = harness(root, {
          assignedWork: () => [ASSIGNED],
          taskStatusById: (id: string) => (id === "t-067540" ? "landed" : undefined),
        });
        await manager.spawn("worker", {
          cmd: "codex",
          taskBrief: "TASK: Continue the now-ratified t-067540 / SDD 479 and prepare implementation.",
          parent: "codex-canonico",
        });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("- t-067540 — status landed on the board now");
        expect(brief).toContain("Do not reopen t-067540");
        // and the live contract is still stated as the current one
        expect(brief).toContain("t-5bfb72");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("THE t-7f3009 INCIDENT: a SPAWN whose brief names landed work is told so, not just a restart", async () => {
      // t-9d250c closed this for restart and only for restart: `sessionWorkRecordFor` had a single
      // call site, in the restart path, and the spawn call site omitted the argument entirely. So the
      // frozen t-2f6cdd contract was re-delivered through the SPAWN door five times after it landed,
      // each time naming a worktree that no longer existed. No board was ever read.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7f3009-spawn-stale-"));
      try {
        const { fake, manager } = harness(root, {
          assignedWork: () => [ASSIGNED],
          taskStatusById: (id: string) => (id === "t-2f6cdd" ? "landed" : undefined),
        });
        const from = mark(fake);

        // The real replayed document, and NO restart anywhere in this test.
        await manager.spawn("worker", {
          cmd: "codex",
          taskBrief: "TASK: Recover and finish t-2f6cdd from the existing clean change worktree; do not restart the investigation.",
          parent: "codex-canonico",
        });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("- t-2f6cdd — status landed on the board now");
        expect(brief).toContain("Do not reopen t-2f6cdd");
        // The live assignment is still stated, so the agent is not merely told what NOT to do.
        expect(brief).toContain("t-5bfb72");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("tells a spawned session it is new — never that it was restarted", async () => {
      // Reusing the restart record verbatim would have handed a first-launch agent "This session was
      // restarted with a NEW conversation. The previous one is not available to you", which is false
      // and invites it to go looking for a conversation it never had.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7f3009-spawn-framing-"));
      try {
        const { fake, manager } = harness(root);
        const from = mark(fake);

        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("SESSION SPAWN: WORK ON RECORD");
        expect(brief).toContain("This session is NEW.");
        expect(brief).not.toContain("SESSION RESTART: WORK ON RECORD");
        expect(brief).not.toContain("was restarted with a NEW conversation");
        expect(brief).toContain("read from the board at spawn");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("leaves the restart record t-9d250c landed exactly as it was", async () => {
      // The spawn wiring must not be paid for by rewording the restart contract: same anchor, same
      // opening sentence, same "at restart" phrasing.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7f3009-restart-unchanged-"));
      try {
        const { fake, manager } = harness(root);
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("SESSION RESTART: WORK ON RECORD");
        expect(brief).toContain("This session was restarted with a NEW conversation.");
        expect(brief).toContain("read from the board at restart");
        expect(brief).not.toContain("SESSION SPAWN: WORK ON RECORD");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("a spawn fails closed on an unreadable board, the same as a restart", async () => {
      // The board read is the fail-closed part: a session that cannot be told what it is working on
      // must not reach a pane at all. Naming the launch in the message keeps it accurate.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7f3009-spawn-failclosed-"));
      try {
        const { manager } = harness(root, {
          assignedWork: () => { throw new Error("task store is corrupt"); },
        });

        await expect(
          manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" }),
        ).rejects.toThrow(/refusing spawn for agent 'worker'/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("a failing stale-reference lookup never costs the spawn", async () => {
      // Mirrors the restart rule: the board read is fail-closed, naming what the brief still carries
      // is decoration, and decoration must not cost an agent its launch.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7f3009-spawn-stale-throws-"));
      try {
        const { fake, manager } = harness(root, {
          assignedWork: () => [ASSIGNED],
          taskStatusById: () => { throw new Error("status store unreadable"); },
        });
        const from = mark(fake);

        await manager.spawn("worker", { cmd: "codex", taskBrief: "TASK: finish t-2f6cdd", parent: "codex-canonico" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("SESSION SPAWN: WORK ON RECORD");
        expect(brief).toContain("t-5bfb72");
        expect(brief).not.toContain("on the board now");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("stops calling a boilerplate-only brief a present task", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-header-"));
      try {
        // Long enough to divert to the brief file, which is where the manifest header is rendered —
        // the header is the line that used to announce `task brief (present)` over pure boilerplate.
        const padded = { ...ASSIGNED, body: `${ASSIGNED.body}\n${"detail. ".repeat(600)}` };
        const { fake, manager } = harness(root, { assignedWork: () => [padded] });
        await manager.spawn("worker", { cmd: "codex", taskBrief: `${BOILERPLATE_BRIEF}\n\n${"pad ".repeat(1200)}`, parent: "codex-canonico" });
        expect(fake.newSessionArgs.at(-1)?.at(-1)).toContain("task brief (present)");
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).toContain("work on record (shared; t-5bfb72)");
        expect(brief).not.toContain("Task objective: absent");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("reports an absent task for a brief that is nothing but protocol boilerplate", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-boilerplate-"));
      try {
        // The measured `claude-opus5` row, padded ONLY with more boilerplate so the manifest header
        // is rendered. Non-emptiness used to be enough to claim a task; substance is now required.
        const boilerplateOnly = [
          BOILERPLATE_BRIEF,
          ...Array.from({ length: 12 }, () => noInteractivePromptGuidance("codex-canonico")),
        ].join("\n\n");
        const { fake, manager } = harness(root, { assignedWork: () => [] });

        await manager.spawn("worker", { cmd: "codex", taskBrief: boilerplateOnly, parent: "codex-canonico" });

        const spawned = fake.newSessionArgs.at(-1)?.at(-1) ?? "";
        expect(spawned).toContain("task contract (absent)");
        expect(spawned).not.toContain("task brief (present)");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("executes a substantive delegation brief when no board task is assigned (t-7b9e60 A)", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-7b9e60-adhoc-"));
      try {
        const { fake, manager } = harness(root, { assignedWork: () => [] });
        const spawnFrom = mark(fake);

        await manager.spawn("worker", {
          cmd: "codex",
          taskBrief: "TASK: Inspect the parser fixture and report the decisive finding.",
          contract: {
            task: "Inspect the parser fixture and report the decisive finding.",
            context: "This is a read-only consultation with no board task.",
            constraints: "Do not modify tracked files.",
            doneWhen: "The parent receives one evidence-backed finding.",
          },
          parent: "codex-canonico",
        });

        const brief = delivered(root, fake, spawnFrom);
        expect(brief).toContain("Assigned work on record: none.");
        expect(brief).toContain("Execute the delegation brief above as delegated work");
        expect(brief).not.toContain("Wait for an explicit assignment");

        const from = mark(fake);
        await manager.restart("worker", { stop: "force", session: "new" });
        const restarted = delivered(root, fake, from);
        expect(restarted).toContain("Execute the delegation brief above as delegated work");
        expect(restarted).not.toContain("Wait for an explicit assignment");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails closed when the assignment cannot be read, leaving the live pane untouched", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-failclosed-"));
      try {
        let readable = true;
        const { fake, manager, session } = harness(root, {
          assignedWork: () => {
            if (!readable) throw new Error("EIO: task store unreadable");
            return [ASSIGNED];
          },
        });
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        readable = false;
        const from = mark(fake);

        const error = await manager.restart("worker", { stop: "force", session: "new" }).catch((value: unknown) => value);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/assigned work could not be read/);
        expect(fake.newSessionArgs.length).toBe(from.news);
        expect(fake.respawnArgs.length).toBe(from.respawns);
        expect(fake.sessions.has(session)).toBe(true); // the running agent was never replaced
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("a failing stale-reference lookup never costs the restart (t-9d250c)", async () => {
      // The board read above is the fail-closed part; naming what the frozen brief still carries is
      // decoration. A store that throws HERE must not turn a describable restart into a refused one —
      // the agent would lose its whole session over a sentence it was never owed.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-9d250c-stale-throws-"));
      try {
        const { fake, manager } = harness(root, {
          assignedWork: () => [ASSIGNED],
          taskStatusById: () => { throw new Error("EIO: task store unreadable"); },
        });
        await manager.spawn("worker", { cmd: "codex", taskBrief: "TASK: finish t-067540 before anything else.", parent: "codex-canonico" });
        const from = mark(fake);

        await expect(manager.restart("worker", { stop: "force", session: "new" })).resolves.not.toThrow();

        const brief = delivered(root, fake, from);
        expect(brief).toContain("t-5bfb72"); // the live contract still arrives
        expect(brief).not.toContain("Do not reopen"); // and nothing is claimed about t-067540
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("claims nothing about assignments when no board resolver is wired", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-unwired-"));
      try {
        const { fake, manager } = harness(root, { assignedWork: undefined });
        await manager.spawn("worker", { cmd: "codex", taskBrief: BOILERPLATE_BRIEF, parent: "codex-canonico" });
        const from = mark(fake);

        await manager.restart("worker", { stop: "force", session: "new" });

        const brief = delivered(root, fake, from);
        expect(brief).not.toContain("SESSION RESTART: WORK ON RECORD");
        expect(brief).not.toContain("work on record (");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("leaves a resume restart alone — it keeps the conversation that already holds the work", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-e3aaae-resume-"));
      const projects = path.join(root, "projects", "-ws");
      fs.mkdirSync(projects, { recursive: true });
      const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      fs.writeFileSync(path.join(projects, `${sid}.jsonl`), "{}\n");
      try {
        const { fake, manager, ledger } = harness(root, { fileExists: (p: string) => fs.existsSync(p) });
        ledger.record("claude", {
          instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
          cwd: "/ws",
          def: { cmd: "claude", kind: "agent" },
          resume: { runtime: "claude", sessionId: sid, configHome: root },
        });
        const from = mark(fake);

        const result = await manager.restart("claude", { stop: "graceful", session: "resume" });

        expect(result.resumed).toBe(true);
        expect(delivered(root, fake, from)).not.toContain("SESSION RESTART: WORK ON RECORD");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
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

  it("t-22944a: confirms stopped, still-alive, and unknown as distinct outcomes", async () => {
    const { manager, tmux, dead } = makeManager("agents:\n  a:\n    cmd: x\n");
    const session = `tachyon-${HASH}-a`;
    await manager.spawn("a");

    expect(await manager.confirmGracefulStop("a", 0)).toBe("alive");
    dead.set(session, 0);
    expect(await manager.confirmGracefulStop("a", 0)).toBe("stopped");

    dead.delete(session);
    vi.spyOn(tmux, "sessionStates").mockRejectedValueOnce(new Error("tmux inventory unavailable"));
    expect(await manager.confirmGracefulStop("a", 0)).toBe("unknown");
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

  const CLAUDE = `tachyon-${HASH}-claude`;

  it("stopGracefully sends Claude's local exit command when the pane stays alive", async () => {
    const { manager, sessions, composerDrafts, exitsOnExitCommand, sentKeys, sentTexts } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    composerDrafts.set(CLAUDE, ""); // an idle, free composer
    exitsOnExitCommand.add(CLAUDE);
    await manager.stopGracefully("claude");
    expect(sentKeys).toEqual([
      { session: CLAUDE, key: "C-c" },
      { session: CLAUDE, key: "/exit" },
      { session: CLAUDE, key: "C-m" },
    ]);
    expect(sentTexts).toEqual([{ session: CLAUDE, text: "/exit", submit: false }]);
    expect(sessions.has(CLAUDE)).toBe(true);
  });

  it("stopGracefully interrupts an active claude turn before local exit", async () => {
    const { manager, panes, composerDrafts, exitsOnExitCommand, sentKeys, sentTexts } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    panes.set(CLAUDE, "esc to interrupt");
    composerDrafts.set(CLAUDE, "");
    exitsOnExitCommand.add(CLAUDE);
    await manager.stopGracefully("claude");
    expect(sentKeys).toEqual([
      { session: CLAUDE, key: "Escape" },
      { session: CLAUDE, key: "C-c" },
      { session: CLAUDE, key: "/exit" },
      { session: CLAUDE, key: "C-m" },
    ]);
    expect(sentTexts).toEqual([{ session: CLAUDE, text: "/exit", submit: false }]);
  });

  /**
   * t-ab2682 — the regression, and the reason the text step reads before it types. `/exit` typed
   * onto a staged line becomes part of THAT line, and the Enter behind it submits the pair to the
   * model as a prompt instead of running the command. Measured on claude 2.1.224 through the dogfood
   * door, 3 of 4 stops left the process alive with the pane reading `── END BEFORE FINISHING ──/exit`.
   *
   * Here the draft is the spawn brief, still being delivered when the stop arrives. Ctrl-C — the
   * profile's own clear step — frees the composer, and only then is the command typed. Run against
   * the old blind `sendKeys(text, true)` this fails: `/exit` is appended to the brief.
   */
  it("stopGracefully types its exit command only into a freed claude composer", async () => {
    const { manager, composerDrafts, composerArrival, exitsOnExitCommand, submittedLines, sentTexts } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    composerDrafts.set(CLAUDE, "");
    // The spawn brief lands just after the profile's Ctrl-C — the race the owner keeps losing.
    composerArrival.set(CLAUDE, "a spawn brief still being delivered");
    exitsOnExitCommand.add(CLAUDE);
    await manager.stopGracefully("claude");
    // The whole defect in one assertion: what the Enter submitted. The old blind delivery submitted
    // "a spawn brief still being delivered/exit" — a PROMPT — and the process stayed alive.
    expect(submittedLines).toEqual([{ session: CLAUDE, text: "/exit" }]);
    expect(sentTexts).toEqual([{ session: CLAUDE, text: "/exit", submit: false }]);
  });

  /**
   * The guard has to stay RED when the composer never frees: typing there is the defect itself. The
   * stop then reaches STOPPING_FALLBACK_MS and surfaces as `stop-failed` — a true statement, and
   * better than submitting whatever was staged to the model. This one burns the real
   * free-composer budget, hence the explicit timeout.
   */
  it("stopGracefully never types its exit command onto a claude composer that stays occupied", async () => {
    const { manager, panes, sentKeys, sentTexts } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    // Not a modelled composer: this draft survives Ctrl-C, so the pane never reads free.
    panes.set(CLAUDE, "❯ a human draft nobody submitted");
    await manager.stopGracefully("claude");
    expect(sentTexts).toEqual([]);
    expect(sentKeys.map((k) => k.key)).not.toContain("/exit");
    expect(sentKeys.map((k) => k.key)).not.toContain("C-m");
  }, 10_000);

  /**
   * The Enter is guarded the same way the typing is: it goes out only while the composer provably
   * holds exactly the text we typed. Anything else means the press would be blind, and a blind Enter
   * answers whatever selector happens to be focused.
   */
  it("stopGracefully withholds the submit when the claude composer no longer holds exactly its text", async () => {
    const { manager, composerDrafts, composerInterloper, sentKeys, sentTexts } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    composerDrafts.set(CLAUDE, "");
    // Something lands on the composer line in the same beat the command is typed.
    composerInterloper.set(CLAUDE, " and a draft that arrived beside it");
    await manager.stopGracefully("claude");
    // Typed, but never submitted: that Enter would have sent the other content to the model.
    expect(sentTexts).toEqual([{ session: CLAUDE, text: "/exit", submit: false }]);
    expect(sentKeys.map((k) => k.key)).not.toContain("C-m");
  });

  it("cannot restart a re-discovered Temporary agent (no stored definition)", async () => {
    const { sessions, tmux } = fakeTmux();
    sessions.add(`tachyon-${HASH}-orphan`); // survived a previous extension host
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
    });
    await expect(manager.restart("orphan", { stop: "force", session: "new" })).rejects.toThrow("no stored definition");
  });

  it("lists declared + running + Temporary agents merged", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n");
    await manager.spawn("a");
    await manager.spawn("extra", { cmd: "sleep 1", kind: "terminal" });
    const list = await manager.list();
    expect(list.map((i) => [i.name, i.running, i.lifetime])).toEqual([
      ["a", true, "saved"],
      ["b", false, "saved"],
      ["extra", true, "temporary"],
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
    await manager.spawn("worker", { cmd: "opencode", parent: "orchestrator" });
    let worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("orchestrator");
    expect(manager.parentOf("worker")).toBe("orchestrator"); // spec 332 — the death-poke wiring's lookup
    expect(manager.parentOf("orchestrator")).toBeUndefined();

    // killing the parent leaves the child running; render promotes (parent still recorded)
    await manager.kill("orchestrator");
    worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.running).toBe(true);
    expect(worker?.parent).toBe("orchestrator"); // points at a gone agent — UI promotes to root

    // killing the Temporary child removes it from the listing entirely (def + lineage cleared)
    await manager.kill("worker");
    expect((await manager.list()).find((a) => a.name === "worker")).toBeUndefined();
  });

  it("spec 352 — declared owner surfaces separately from runtime actor lineage", async () => {
    const { manager } = makeManager("agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  codex:\n    cmd: codex\n  reviewer:\n    cmd: claude\n");
    await manager.spawn("reviewer", { parent: "codex" });
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.parent).toBe("codex");
    expect(reviewer?.declaredOwner).toBe("claude");
    expect(manager.parentOf("reviewer")).toBe("codex");
    expect(await manager.liveDescendants("claude")).toEqual([]);
    expect(await manager.liveDescendants("codex")).toEqual(["reviewer"]);
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
    });
    await manager.spawn(name, opts);
    const spawnArgs = calls.find((c) => c.includes("new-session"))!;
    return spawnArgs[spawnArgs.length - 1];
  };

  it("Temporary child gets instructions + Bridge guidance appended (spec 216 Part B)", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\n", "revisor", { cmd: "claude", instructions: "review prs", parent: "a" });
    expect(cmd).toContain("review prs");
    expect(cmd).toContain("[Tachyon]"); // Bridge guidance (child has a parent)
  });

  it("settings.bridgeGuidance: false suppresses the child guidance (spec 216), but not the spec 363 primer", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\nsettings:\n  bridgeGuidance: false\n", "w", { cmd: "claude", instructions: "do x", parent: "a" });
    expect(cmd).not.toContain("[Tachyon] You are part of a Tachyon team"); // Bridge guidance suppressed
    expect(cmd).toContain("do x"); // the actual instructions still land
    expect(cmd).toContain("── TACHYON PRIMER ──"); // spec 363 T3 — primer is independent of bridgeGuidance
  });

  it("non-AI child silently drops undeliverable guidance (sh has no instruction arg)", async () => {
    const cmd = await captureSpawnCmd("agents:\n  a:\n    cmd: x\n", "w", { cmd: "sh", kind: "terminal" });
    expect(cmd).toBe("sh"); // sh has no instruction arg at all — nowhere for a primer to go either
  });

  it("spec 363 T3 — a lineage-bearing Temporary child's spawn command carries the PRIMER + BEFORE FINISHING block", async () => {
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

  it("does not deliver retired settings.verify facts to a bare declared agent", async () => {
    const cmd = await captureSpawnCmd(
      "agents:\n  codex:\n    cmd: codex\nsettings:\n  verify:\n    full: ./verify-all\n    typecheck: ./check-types\n",
      "codex",
    );
    expect(cmd).not.toContain("Configured verification");
    expect(cmd).not.toContain("./verify-all");
    expect(cmd).not.toContain("./check-types");
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
      expect(cmd).toContain("Task objective: absent — awaiting assignment");
      expect(cmd).not.toContain("LONG_GUIDANCE_");
      const onDisk = fs.readFileSync(file, "utf8");
      expect(onDisk).toContain("── STARTUP BRIEF CONTENTS ──");
      expect(onDisk).toContain("Task: absent — awaiting assignment");
      expect(onDisk).toContain("── PROJECT GUIDANCE (PROJECT-OWNED) ──");
      expect(onDisk).toContain("LONG_GUIDANCE_");
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
      "agents:\n  aider:\n    cmd: aider\n    instructions: undeliverable\nsettings:\n  projectGuidance:\n    files: [missing.md]\n",
    );
    const fake = fakeTmux();
    const manager = new AgentManager({
      tmux: fake.tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
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
    const reveals: Array<[string, SpawnReveal]> = [];
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      onSpawned: (n, r) => reveals.push([n, r]),
      launchPreflight: HERMETIC_PREFLIGHT,
    });
    await manager.spawn("a"); // human/declared → a start is the reason a surface should exist
    await manager.spawn("child", { cmd: "opencode", parent: "a", reveal: false }); // Bridge child
    expect(reveals).toEqual([
      ["a", "reveal"],
      ["child", "silent"],
    ]);
  });

  /**
   * t-b88106 — the reported defect. A relaunch used to assert `true`, so restarting an agent that was
   * working headless materialized an editor terminal nobody asked for. A relaunch CONTINUES an agent;
   * it does not decide whether the agent should be visible. That is now stated as `preserve`, and the
   * presentation layer resolves it against the surface the agent actually had.
   */
  it("restart asks the presentation to PRESERVE the surface rather than reveal one", async () => {
    const { tmux } = fakeTmux();
    const reveals: Array<[string, SpawnReveal]> = [];
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      onSpawned: (n, r) => reveals.push([n, r]),
    });
    await manager.spawn("a");
    await manager.restart("a", { stop: "force", session: "new" });
    expect(reveals).toEqual([
      ["a", "reveal"],
      ["a", "preserve"], // crash recovery and watch-restart take this exact path
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      materializeHarness?: (ctx: { name: string; def: any }) => any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveCurrentSessionFull?: (rt: string, cwd: string, title?: string, configHome?: string) => Promise<string | null>;
      getExtraEnv?: () => Record<string, string>;
      getBridgeGeneration?: () => number;
      materializeBridgeMcp?: (name: string) => string | undefined;
      materializeBridgeMcpOpencode?: (name: string, cwd: string) => string | undefined;
      materializeBridgeMcpGrok?: (name: string) => string | undefined;
      resolveAgentPermissionProjection?: (name: string, runtime: string) => AgentPermissionProjectionEntry | undefined;
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
      removeBridgeRuntimeHome?: (name: string) => void;
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
    /**
     * t-4736b4 — an AMBIGUOUS `list-panes` failure: not the "no server running" clean-down that
     * TmuxService reads as zero sessions, so `sessionStates` returns null and the manager cannot
     * measure occupancy. This is the condition that used to resurrect the pre-kill snapshot.
     */
    const ambiguousInventory = { current: false };
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
          if (ambiguousInventory.current) throw new Error("lost server: connection reset by peer");
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
      materializeHarness: opts.materializeHarness,
      getExtraEnv: opts.getExtraEnv,
      getBridgeGeneration: opts.getBridgeGeneration,
      materializeBridgeMcp: opts.materializeBridgeMcp,
      materializeBridgeMcpOpencode: opts.materializeBridgeMcpOpencode,
      materializeBridgeMcpGrok: opts.materializeBridgeMcpGrok,
      resolveAgentPermissionProjection: opts.resolveAgentPermissionProjection,
      piBridgeExtensionPath: opts.piBridgeExtensionPath,
      materializePiSessionDir: opts.materializePiSessionDir,
      materializeOwnershipSettings: opts.materializeOwnershipSettings,
      materializeCodexSessionStartHookConfig: opts.materializeCodexSessionStartHookConfig,
      ownedSession: opts.ownedSession,
      notify: opts.notify,
      mintAgentToken: opts.mintAgentToken,
      revokeAgentToken: opts.revokeAgentToken,
      removeHarnessHome: opts.removeHarnessHome,
      removeBridgeRuntimeHome: opts.removeBridgeRuntimeHome,
      removePiSessionDir: opts.removePiSessionDir,
      launchPreflight: opts.launchPreflight ?? HERMETIC_PREFLIGHT,
    });
    return { manager, ledger, sessions, dead, cmds, newSessionArgs, respawnArgs, startArgs, paneInjections, failRespawn, ambiguousInventory, ws, hash };
  }


  it("allows canonical forget preparation after killing a provisional Saved Agent", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    await h.manager.kill("reviewer");

    await expect(h.manager.prepareAgentProfileForget("reviewer")).resolves.toMatchObject({
      ledgerSha256: expect.any(String),
    });
  });

  it("t-dbddeb warns and permits forget when tmux contradicts a provisional launch reservation", async () => {
    const warnings: string[] = [];
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n", {
      notify: (message) => warnings.push(message),
    });
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    // The pane disappears outside AgentManager.kill(), leaving the process-local launch reservation behind.
    h.sessions.delete(sessionName(h.hash, "reviewer"));

    await expect(h.manager.prepareAgentProfileForget("reviewer")).resolves.toMatchObject({
      ledgerSha256: expect.any(String),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("believed a launch was still in flight");
    expect(warnings[0]).toContain("tmux measured no session");
    expect(warnings[0]).toContain("stale in-process launch reservation");
  });

  it("t-dbddeb keeps blocking when tmux confirms a provisional launch reservation", async () => {
    const warnings: string[] = [];
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n", {
      notify: (message) => warnings.push(message),
    });
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");

    await expect(h.manager.prepareAgentProfileForget("reviewer")).rejects.toMatchObject({
      code: "agent-profile/forget-agent-running",
      message: expect.stringContaining("launch reservation is confirmed by tmux"),
    });
    expect(warnings).toEqual([]);
  });

  it("t-dbddeb keeps failing closed when tmux cannot measure a provisional launch reservation", async () => {
    const warnings: string[] = [];
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n", {
      notify: (message) => warnings.push(message),
    });
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    h.ambiguousInventory.current = true;

    await expect(h.manager.prepareAgentProfileForget("reviewer")).rejects.toThrow("occupancy unverifiable");
    expect(warnings).toEqual([]);
  });

  it("t-dbddeb clears readiness markers when the lifecycle monitor dismisses a clean-exit pane", async () => {
    const warnings: string[] = [];
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n", {
      notify: (message) => warnings.push(message),
    });
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    vi.spyOn(h.manager, "agentStates").mockResolvedValue(new Map([
      ["reviewer", { dead: true, exitCode: 0 }],
    ]));
    await expect(h.manager.dismissCleanExitPane("reviewer")).resolves.toBe(true);

    await expect(h.manager.prepareAgentProfileForget("reviewer")).resolves.toMatchObject({
      ledgerSha256: expect.any(String),
    });
    expect(warnings).toEqual([]);
  });

  it("t-110aaa guard: canonical forget still refuses a running agent", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    await h.manager.spawn("reviewer");
    await expect(h.manager.prepareAgentProfileForget("reviewer")).rejects.toMatchObject({
      code: "agent-profile/forget-agent-running",
    });
  });

  /**
   * t-4736b4 — the measured reproduction. Five Saved Agents were stopped through the Bridge,
   * `list_agents` reported them `running:false`, their tmux sessions were gone, and canonical forget
   * still refused four of them "must be fully stopped" on every attempt. The seam was
   * `agentStates()`: it serves `lastAgentStates` when the fresh read is ambiguous, so the pre-kill
   * snapshot answered for tmux forever — and only a successful read clears that cache, which was the
   * very thing failing. The refusal had no door.
   *
   * Before the fix this asserted the wrong sentence: `must be fully stopped`, from a memory of a
   * session that had already been killed.
   */
  it("t-4736b4 refuses a forget it cannot measure as unverifiable, not as still-running", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    // Seed the known-good snapshot the way the sidebar poll does — this is what later gets resurrected.
    expect((await h.manager.agentStates()).has("reviewer")).toBe(true);
    await h.manager.kill("reviewer");
    h.ambiguousInventory.current = true;

    const failure = await h.manager.prepareAgentProfileForget("reviewer").catch((error: Error) => error) as Error;

    expect(failure.message).toContain("occupancy unverifiable");
    expect(failure.message).not.toContain("must be fully stopped");
    // The cache still holds the stale live entry — the point is that the removal path no longer reads it.
    expect(h.manager.isKnownAliveSync("reviewer")).toBe(true);
  });

  /**
   * t-4736b4 — and the refusal is decided from a fresh measurement every time, so it cannot become a
   * permanent state. The moment tmux answers, the same call goes through with no engine restart.
   */
  it("t-4736b4 lets the very next forget through once the inventory answers again", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    expect((await h.manager.agentStates()).has("reviewer")).toBe(true);
    await h.manager.kill("reviewer");

    h.ambiguousInventory.current = true;
    await expect(h.manager.prepareAgentProfileForget("reviewer")).rejects.toThrow("occupancy unverifiable");

    h.ambiguousInventory.current = false;
    await expect(h.manager.prepareAgentProfileForget("reviewer")).resolves.toMatchObject({
      ledgerSha256: expect.any(String),
    });
  });

  /**
   * t-4736b4 — the other half of the contract: a genuinely live session is still refused, and with
   * the running-specific sentence. Failing closed on `unknown` is only worth anything if `occupied`
   * did not get softer.
   */
  it("t-4736b4 still refuses a genuinely live session with the still-running message", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");

    const failure = await h.manager.prepareAgentProfileForget("reviewer").catch((error: Error) => error) as Error;

    expect(failure.message).toContain("must be fully stopped before canonical forget");
    expect(failure.message).not.toContain("occupancy unverifiable");
  });

  /**
   * t-4736b4 — `lastAgentStates` exists because a tmux read is noisy and the sidebar must not blink
   * every agent out of existence over one bad `list-panes` (t-3a3a14). The fix hardens the REMOVAL
   * path only; the readers built on that fallback keep it.
   */
  it("t-4736b4 leaves the sidebar fallback intact for ordinary readers", async () => {
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");

    await h.manager.spawn("reviewer");
    expect((await h.manager.agentStates()).has("reviewer")).toBe(true);

    h.ambiguousInventory.current = true;
    expect((await h.manager.agentStates()).has("reviewer")).toBe(true);
    await expect(h.manager.runningAgents()).resolves.toContain("reviewer");
    // The strict reader still reports the ambiguity rather than an empty fleet (t-016e8b).
    await expect(h.manager.runningAgentsStrict()).resolves.toBeNull();
  });

  it("t-33ae3f canonical forget removes the generated brief, generated context and pane transcript", async () => {
    // These three were left behind by the Saved Agent forget while `retainedBindings` never claimed
    // them: neither cleaned nor declared, which is the one state an audit of a removal cannot
    // classify. Six of seven committed forgets on the dogfood workspace had leaked them.
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    const brief = briefFilePath(h.ws, "reviewer");
    const anchor = path.join(h.ws, ".tachyon", "anchors", "reviewer.md");
    const transcript = paneTranscriptPath(h.ws, "reviewer");
    for (const file of [brief, anchor, transcript]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "residue");
    }

    await h.manager.spawn("reviewer");
    await h.manager.kill("reviewer");
    const snapshot = await h.manager.prepareAgentProfileForget("reviewer");
    await h.manager.convergeAgentProfileForget("reviewer", "11111111-1111-4111-8111-111111111111", "tx-1", snapshot);

    expect(fs.existsSync(brief)).toBe(false);
    expect(fs.existsSync(anchor)).toBe(false);
    expect(paneTranscriptExists(h.ws, "reviewer")).toBe(false);
  });

  it("t-33ae3f converge stays idempotent so rollForward can re-enter the phase", async () => {
    // `rollForward` replays from the journal after a crash; a second pass must not throw on files the
    // first pass already took.
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    asAgent(h.manager.defOf("reviewer"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };

    await h.manager.spawn("reviewer");
    await h.manager.kill("reviewer");
    const snapshot = await h.manager.prepareAgentProfileForget("reviewer");
    await h.manager.convergeAgentProfileForget("reviewer", "11111111-1111-4111-8111-111111111111", "tx-1", snapshot);

    await expect(
      h.manager.convergeAgentProfileForget("reviewer", "11111111-1111-4111-8111-111111111111", "tx-1", snapshot),
    ).resolves.toBeUndefined();
  });











  it("releases only a stopped agent's own stale worktree occupancy for governed removal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-forget-wt-"));
    dirs.push(root);
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const { manager } = resumeHarness("agents: {}\n");
    const internals = manager as unknown as {
      canonicalWorktreeKey: (value: string) => string;
      worktreeOccupancy: Map<string, { state: "pending" | "live" | "dirty"; agentId: string; cwd: string; pid?: number }>;
    };
    const key = internals.canonicalWorktreeKey(wt);

    internals.worktreeOccupancy.set(key, { state: "dirty", agentId: "claude", cwd: wt });
    await expect(manager.releaseOwnedWorktreeForRemoval("claude", wt)).resolves.toBeUndefined();
    await expect(manager.worktreeOccupant(wt)).resolves.toBeUndefined();

    internals.worktreeOccupancy.set(key, { state: "dirty", agentId: "reviewer", cwd: wt });
    await expect(manager.releaseOwnedWorktreeForRemoval("claude", wt)).rejects.toThrow(/quarantined by.*reviewer/);

    // A live but reused pid is not authority: the current process exists, but its measured cwd is
    // elsewhere, so it cannot keep this checkout quarantined merely because its number was cached.
    internals.worktreeOccupancy.set(key, { state: "dirty", agentId: "claude", cwd: wt, pid: process.pid });
    await expect(manager.releaseOwnedWorktreeForRemoval("claude", wt)).resolves.toBeUndefined();

    // Conversely, the same fresh measurement still refuses a process actually rooted in the target.
    const cwdKey = internals.canonicalWorktreeKey(process.cwd());
    internals.worktreeOccupancy.set(cwdKey, { state: "dirty", agentId: "claude", cwd: process.cwd(), pid: process.pid });
    await expect(manager.releaseOwnedWorktreeForRemoval("claude", process.cwd())).rejects.toThrow(
      /live root process.*wait for that process to exit, then retry kill_agent\('claude'\)/,
    );

    // An unreadable measurement is not collapsed into either life or death and changes no state.
    internals.worktreeOccupancy.set(key, { state: "dirty", agentId: "claude", cwd: wt, pid: 424242 });
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((value) => {
      if (String(value) === "/proc/424242/cwd") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return String(value);
    });
    await expect(manager.releaseOwnedWorktreeForRemoval("claude", wt)).rejects.toThrow(/occupancy unverifiable.*remembered root process/);
    expect(internals.worktreeOccupancy.has(key)).toBe(true);
    realpath.mockRestore();
  });

  /**
   * t-4736b4 — `config.agent.delete` with `removeWorktree:true` walks three occupancy gates in a row
   * (`removeAgentWorktree` → here → `prepareAgentProfileForget`). All three read the same stale
   * snapshot, so fixing only the forget would have moved the permanent refusal one step earlier
   * instead of removing it.
   */
  it("t-4736b4 refuses a worktree release it cannot measure, and allows it once tmux answers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-forget-wt-unknown-"));
    dirs.push(root);
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const h = resumeHarness("agents:\n  reviewer:\n    cmd: codex\n");
    const internals = h.manager as unknown as {
      canonicalWorktreeKey: (value: string) => string;
      worktreeOccupancy: Map<string, { state: "pending" | "live" | "dirty"; agentId: string; cwd: string; pid?: number }>;
    };
    const key = internals.canonicalWorktreeKey(wt);

    await h.manager.spawn("reviewer");
    expect((await h.manager.agentStates()).has("reviewer")).toBe(true);
    await h.manager.kill("reviewer");

    internals.worktreeOccupancy.set(key, { state: "dirty", agentId: "reviewer", cwd: wt });
    h.ambiguousInventory.current = true;
    await expect(h.manager.releaseOwnedWorktreeForRemoval("reviewer", wt)).rejects.toThrow("occupancy unverifiable");
    // Refused means untouched: the quarantine is still there to release on the retry.
    expect(internals.worktreeOccupancy.has(key)).toBe(true);

    h.ambiguousInventory.current = false;
    await expect(h.manager.releaseOwnedWorktreeForRemoval("reviewer", wt)).resolves.toBeUndefined();
    expect(internals.worktreeOccupancy.has(key)).toBe(false);
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
      cwd: ws,
    });
  });

  it("capture runtime (codex): records intent with empty id, no injection", async () => {
    const { manager, ledger, cmds } = resumeHarness("agents:\n  codex:\n    cmd: codex\n");
    await manager.spawn("codex");
    expect(cmds[0]).toContain("codex '");
    expect(cmds[0]).toContain("── TACHYON PRIMER ──");
    expect(ledger.get("codex")).toMatchObject({ resume: { runtime: "codex", sessionId: "" }, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
      updatedAt: "t",
    });
    ledger.record("claude", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: "claude-id", configHome: "/home/test/.claude" },
      cwd: ws,
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
    await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: CAP }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
    ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "x" }, cwd: "/repo", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
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
    ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "old-uuid", configHome: "/home/whoever/.claude" }, cwd: "/repo", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
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
    ledger.record("sibling", { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "s" }, cwd: `${ws}/.`, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
    await manager.kill("codex");
    expect(ledger.get("codex")!.resume!.sessionId).toBe(""); // alias resolved as shared → skipped (capture stays empty)
  });

  it("Temporary spawn records declared:false with a def (restartable) + resume", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  decoy:\n    cmd: x\n", { newSessionId: () => "x" });
    await manager.spawn("scratch", { cmd: "claude" });
    // claude name-mints (spec 220): the resume id is the deterministic name for the Temporary agent
    const name = `tachyon-${path.basename(ws)}-scratch`;
    expect(ledger.get("scratch")).toMatchObject({ instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false }, def: { cmd: "claude" }, resume: { sessionId: name } });
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
    ledger.record("old", { def: { cmd: "claude", kind: "agent" }, cwd: ws, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
    expect(await present.manager.resumeReadiness("a-nodef", { def: { cmd: "x", kind: "agent" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" })).toBe(false);
    // resume block but NO def.cmd → resume() rejects it, so the badge must NOT say resumable (codex MAJOR)
    expect(await present.manager.resumeReadiness("a-noclmd", { resume: { runtime: "claude", sessionId: uuid }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" })).toBe(false);
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
    await manager.resume("claude", rec, { injectPrimer: false });
    expect(cmds.at(-1)).toBe("claude --model sonnet --resume session-a");
    expect(paneInjections).toEqual([]);
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
    ledger.record("claude-fork-1", { def: { cmd: "claude", kind: "agent" }, cwd: "/x", instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } }); // occupy -fork-1
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

  /**
   * t-5e1113 (SDD 482 phase 2) — the declared policy is WRITTEN by the real paths, not just parseable.
   * `temporary` comes from the caller supplying a command, which is a declaration; nothing here reads the
   * name, the tmux session or `tachyon.yml` to decide.
   */
  it("t-5e1113: spawn and fork write the declared instance policy", async () => {
    const { manager, ledger } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      seedTranscript: () => true,
    });

    await manager.spawn("claude");
    expect(ledger.get("claude")?.instance).toEqual({ lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true });

    await manager.spawn("temp", { cmd: "claude --temp" });
    expect(ledger.get("temp")?.instance).toEqual({ lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false });

    // A fork is the independent-axes case: no durable Profile, but it owns a resume block.
    const forkName = await manager.commitFork(await manager.planFork("claude"));
    // A fork records lifecycleHooks:false explicitly — commitFork already decides it; now the row says so.
    expect(ledger.get(forkName)?.instance).toEqual({ lifetime: "temporary" as const, resumePolicy: "restartable" as const, lifecycleHooks: false });
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
    const legacyCommand = cmds.at(-1)
      ?.replace(forkSession, "<FORK_SESSION>")
      .replace(/ --settings '[^']+'$/, "");
    expect(legacyCommand).toBe("claude -n <FORK_SESSION> --resume abcdef01-2345-6789-abcd-ef0123456789 --fork-session");
    expect(ledger.get("claude-fork-1")).toMatchObject({
      def: { cmd: "claude", kind: "agent", fork: true }, // base cmd → a later resume uses the normal named path, never re-forks
      resume: { runtime: "claude", sessionId: forkSession }, // the fork's OWN name (captured → uuid later)
      // temporary AND restartable — the fork is the case the two axes exist for.
      instance: { lifetime: "temporary" as const, resumePolicy: "restartable" as const, lifecycleHooks: false },
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
    // Stop keeps the row + listing (unlike an ordinary Temporary, which would vanish).
    expect(ledger.get("claude-fork-1")?.def?.fork).toBe(true);
    expect((await manager.list()).map((a) => a.name)).toContain("claude-fork-1");
    manager.dismissTemporary("claude-fork-1");
    expect(ledger.get("claude-fork-1")).toBeUndefined();
    expect((await manager.list()).map((a) => a.name)).not.toContain("claude-fork-1");
  });

  it("persists the spawn contract + skip reason on the ledger def and survives reload (spec 246 D8/D6)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", {});
    const contract = { task: "add retry to upload", context: "client.ts times out on flaky nets", constraints: "no new deps", deliverable: "a unit test proving backoff" };
    // the manager records opts.contract unconditionally (the Bridge owns the gate).
    await manager.spawn("helper", { cmd: "opencode", parent: "main", contract });
    expect(ledger.get("helper")?.def?.contract).toEqual(contract);
    // reload: a fresh ledger over the same dir re-parses the persisted def (parseDef whitelist preserves it)
    expect(new SessionLedger(ws).get("helper")?.def?.contract).toEqual(contract);

    await manager.spawn("skipper", { cmd: "opencode", parent: "main", contractSkipReason: "trivial throwaway probe" });
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

  it("kill of a Temporary agent deletes its durable activity log (pin p-4dadd3 dogfood follow-up: kill→remove path)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", {});
    await manager.spawn("oneshot", { cmd: "opencode", parent: "main" }); // Temporary → gets a session + ledger row
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("oneshot")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    expect(fs.existsSync(logFile)).toBe(true);
    await manager.kill("oneshot"); // killSession leaves NO pane → the log would be an unreachable orphan
    expect(ledger.get("oneshot")).toBeUndefined(); // row removed (spec 211)
    expect(fs.existsSync(logFile)).toBe(false); // ...and the log dies with it (was orphaned before this fix)
  });

  it("dismissTemporary deletes the agent's durable activity log (pin p-4dadd3 (a): log dies with the row)", async () => {
    const { manager, ledger, ws } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { resolveCurrentSession: async () => UUID });
    await manager.spawn("claude");
    await manager.commitFork(await manager.planFork("claude")); // claude-fork-1 = a Temporary with a ledger row
    // Seed a durable activity log as the writer would have.
    const actDir = path.join(ws, ".tachyon", "activity");
    fs.mkdirSync(actDir, { recursive: true });
    const logFile = path.join(actDir, `${agentLogId("claude-fork-1")}.jsonl`);
    fs.writeFileSync(logFile, '{"schemaVersion":1}\n', "utf8");
    expect(fs.existsSync(logFile)).toBe(true);
    manager.dismissTemporary("claude-fork-1");
    expect(ledger.get("claude-fork-1")).toBeUndefined();
    expect(fs.existsSync(logFile)).toBe(false); // gone with the row — no unreachable orphan
  });

  // t-7bc276 — the door PRODUCTION uses. Bridge `dismiss_agent` and the UI dismiss both land on
  // dismissTemporary, which is why this asserts there and not on forgetAgent: the removal existed in
  // HarnessManager all along and simply never got called from here, so wiring is the whole defect.
  it("dismissTemporary removes the private bridge-mcp runtime home a non-harness grok/hermes agent ran out of", async () => {
    const { manager, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", {
      // Exactly how Workspace wires it — a fake would prove the test's own wiring, not the product's.
      removeBridgeRuntimeHome: (name) => { new HarnessManager(ws).retireBridgeRuntimeHomes(name, { procRoot: path.join(ws, "no-proc") }); },
    });
    await manager.spawn("oneshot", { cmd: "grok", parent: "main" }); // Temporary → ledger row

    // What grok actually writes there (measured 2026-08-07): a resumable session directory, plus the
    // ~12.8 MB `bundled/` tree that is 98% of the cost and identical in every home.
    const grokHome = bridgeGrokHome(ws, "oneshot");
    const hermesHome = bridgeHermesHome(ws, "oneshot");
    fs.mkdirSync(path.join(grokHome, "sessions", "s1"), { recursive: true });
    fs.writeFileSync(path.join(grokHome, "sessions", "s1", "chat_history.jsonl"), '{"type":"system"}\n', "utf8");
    fs.mkdirSync(path.join(grokHome, "bundled"), { recursive: true });
    fs.writeFileSync(path.join(grokHome, "bundled", "asset.bin"), "x".repeat(1024), "utf8");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "state.db"), "db", "utf8");
    // A sibling's home proves the removal is keyed by name and does not sweep the neighbours.
    const sibling = bridgeGrokHome(ws, "survivor");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "config.toml"), "", "utf8");

    manager.dismissTemporary("oneshot");

    expect(fs.existsSync(grokHome)).toBe(false);
    expect(fs.existsSync(hermesHome)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it("removeEphemeralFootprint routes through canonical forgetAgent cleanup, idempotently (spec 247)", async () => {
    const removedHomes: string[] = [];
    const { manager, ledger, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n", { removeHarnessHome: (name) => removedHomes.push(name) });
    await manager.spawn("eph", { cmd: "opencode", parent: "main" }); // Temporary → ledger row
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

  /**
   * t-4a1f85 — the ACTOR × TRIGGER that reaches `forgetAgent` most often: a Temporary agent dismissed
   * by a human in the sidebar, or by an agent through Bridge `dismiss_agent`. Both land here.
   *
   * `forgetAgent` used to remove a per-agent subtree and leave the parent standing. Nothing revisited
   * it — this path writes no journal, so no reconcile owns it — and the one sweep that enumerates the
   * directory called it `absent`, "there is nothing to remove".
   *
   * The neighbour is the policy argument: the removal is `rmdir`, so a home that still holds a
   * human-authored note is kept whole, directory included.
   */
  it("dismissTemporary takes the Agent Profile home it emptied and keeps one that still holds human data", async () => {
    const { manager, ws } = resumeHarness("agents:\n  main:\n    cmd: claude\n");
    const home = (name: string) => path.join(ws, ".tachyon", "agents", name);
    await manager.spawn("eph", { cmd: "opencode", parent: "main" });
    await manager.spawn("noteful", { cmd: "opencode", parent: "main" });
    for (const name of ["eph", "noteful"]) fs.mkdirSync(home(name), { recursive: true });
    fs.writeFileSync(path.join(home("noteful"), "notes.md"), "# a human note\n", "utf8");

    manager.dismissTemporary("eph");
    manager.dismissTemporary("noteful");

    expect(fs.existsSync(home("eph"))).toBe(false);
    expect(fs.readdirSync(home("noteful"))).toEqual(["notes.md"]);
    expect(fs.readFileSync(path.join(home("noteful"), "notes.md"), "utf8")).toBe("# a human note\n");
    // Idempotent like every other footprint: the dismissNode→kill double-call must not throw.
    expect(() => manager.dismissTemporary("eph")).not.toThrow();
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
      "session ledger row",
      "activity log and writer state",
      "session-owner ledger rows",
      "private runtime-home credentials",
      "private bridge-mcp runtime home",
      "legacy/idempotent Pi session subtree",
      "per-spawn settings file",
      "generated spawn brief",
      "durable pane transcript",
      "emptied Agent Profile home",
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
    const briefFile = briefFilePath(ws, name);
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
    await manager.spawn("worker"); // declared → config owns the definition → kill's wasTemporary is false
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
    await manager.resume("worker", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u9" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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

  it("t-110aaa: parented Grok delegates without a worktree and visibly reports project-scoped state", async () => {
    const warnings: string[] = [];
    const { manager, newSessionArgs } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
      notify: (message) => warnings.push(message),
    });
    await manager.spawn("grok-child", { cmd: "grok", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
    expect(warnings).toEqual([
      expect.stringContaining("project-scoped transcript and runtime state"),
    ]);
    expect(warnings[0]).toContain("same-user processes may read it");
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
    // `isolate:`, Temporary opencode → auto-injected `isolate: "transcript"` → materializeHomeOnly) with
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
      // `harness:`-declared opencode agent only gets private-home treatment via the Temporary
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

    // A plain opencode agent — Temporary, no `harness:` block declared anywhere — spawned with a
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
    await manager.resume("researcher", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
    expect(cmds.at(-1)).toContain("--strict-mcp-config");
    expect(startArgs.length).toBe(before + 1);
    expect(envFromTmuxArgs(startArgs.at(-1)!).CLAUDE_CONFIG_DIR).toBe("/h/researcher");
  });

  it("reload-safe: resume binds a legacy Temporary Claude session to its persisted private configHome", async () => {
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
      instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false },
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
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
    await manager.resume("researcher", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "tachyon-ws-researcher" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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

  it("t-088454: canonical Claude fork rematerializes projections and seeds between private homes in the same cwd", async () => {
    const materialized: Array<{ name: string; def: Record<string, unknown> }> = [];
    const seeds: Array<[string, string]> = [];
    const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async (_runtime, _cwd, _title, configHome) => {
        expect(configHome).toBe(path.join(h.ws, ".tachyon", "harness", "claude"));
        return UUID;
      },
      materializeHarness: ({ name, def }) => {
        materialized.push({ name, def });
        const home = path.join(h.ws, ".tachyon", "harness", name);
        fs.mkdirSync(home, { recursive: true });
        return { home, env: { CLAUDE_CONFIG_DIR: home }, args: ["--strict-mcp-config"] };
      },
      seedTranscript: (from, to) => {
        seeds.push([from, to]);
        return true;
      },
    });
    const sourceDef = asAgent(h.manager.defOf("claude"))!;
    sourceDef.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    sourceDef.profileNativeConfig = {
      adapter: "claude",
      selectors: { model: "claude-opus-5", reasoningEffort: "high" },
      settings: { includeCoAuthoredBy: false },
    };
    // t-59a11b — ownership metadata is non-enumerable, so the fork's structuredClone dropped it and
    // the forked agent stopped being marked pending on a runtime-config change.
    Object.defineProperty(sourceDef.profileNativeConfig, "sources", {
      value: { interface: "global" },
      enumerable: false,
      configurable: false,
    });
    sourceDef.profileCapabilities = {
      schemaVersion: 1,
      adapter: "claude",
      sha256: "b".repeat(64),
      sources: [],
      skills: [],
      mcp: {},
      hooks: {},
      pi: { extensions: [], prompts: [], themes: [], packages: [] },
    };

    await h.manager.spawn("claude");
    materialized.length = 0;
    const forkName = await h.manager.commitFork(await h.manager.planFork("claude"));

    const sourceHome = path.join(h.ws, ".tachyon", "harness", "claude");
    const forkHome = path.join(h.ws, ".tachyon", "harness", forkName);
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.name).toBe(forkName);
    expect(materialized[0]?.def.profileLifecycle).toBeUndefined();
    expect(materialized[0]?.def.profileNativeConfig).toEqual(sourceDef.profileNativeConfig);
    expect(materialized[0]?.def.profileCapabilities).toEqual(sourceDef.profileCapabilities);
    expect(materialized[0]?.def.profileNativeConfig).not.toBe(sourceDef.profileNativeConfig);
    expect(materialized[0]?.def.profileCapabilities).not.toBe(sourceDef.profileCapabilities);
    // The clone carries the ownership metadata across, still non-enumerable (t-59a11b).
    const forkedNative = materialized[0]!.def.profileNativeConfig as { sources?: Record<string, string> };
    expect(forkedNative.sources).toEqual({ interface: "global" });
    expect(Object.keys(forkedNative)).not.toContain("sources");
    expect(seeds).toEqual([[
      path.join(sourceHome, "projects", `-${h.ws.slice(1).replaceAll("/", "-")}`, `${UUID}.jsonl`),
      path.join(forkHome, "projects", `-${h.ws.slice(1).replaceAll("/", "-")}`, `${UUID}.jsonl`),
    ]]);
    expect(envFromTmuxArgs(h.startArgs.at(-1)!).CLAUDE_CONFIG_DIR).toBe(forkHome);
    expect(h.ledger.get(forkName)?.resume?.configHome).toBe(forkHome);
  });

  it("t-987347: create, restart, resume, crash-recovery and fork all re-materialize a profile that lost its selection", async () => {
    // The TRIGGER half of the actor × trigger list for t-987347; the RUNTIME half lives in
    // harness.test.ts and asserts what each runtime's door does to the disk. The actor here is "the
    // profile lost its selection", whose shape is `profileCapabilities: undefined` — zero selection
    // produces no projection at all (agentProfileResolver, `deliveredAnything`), which is exactly why
    // a revocation is routed somewhere else than a grant and why it stopped reaching the disk.
    //
    // Crash-recovery is not a sixth door: `Workspace.recoverFromCrash` is
    // `manager.restart({ stop: "force", session: "resume" })`, driven here under that name so the
    // list stays the list the repository's rule asks for rather than four of five.
    const materialized: Array<{ name: string; capabilities: unknown }> = [];
    const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSessionFull: async () => UUID,
      seedTranscript: () => true,
      materializeHarness: ({ name, def }) => {
        materialized.push({ name, capabilities: def.profileCapabilities });
        const home = path.join(h.ws, ".tachyon", "harness", name);
        fs.mkdirSync(home, { recursive: true });
        return { home, env: { CLAUDE_CONFIG_DIR: home }, args: [] };
      },
    });
    const def = asAgent(h.manager.defOf("claude"))!;
    def.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    def.profileNativeConfig = { adapter: "claude", selectors: {}, settings: {} };
    // No `profileCapabilities`: this IS the revoked profile.

    const at = (trigger: string) => ({ trigger, count: materialized.length });
    const reached: Array<{ trigger: string; count: number }> = [];
    await h.manager.spawn("claude");
    reached.push(at("create"));
    await h.manager.restart("claude", { stop: "force", session: "new" });
    reached.push(at("restart"));
    await h.manager.resume("claude", {
      def: { cmd: "claude", kind: "agent" },
      resume: { runtime: "claude", sessionId: UUID },
      cwd: h.ws,
      instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
      updatedAt: "t",
    });
    reached.push(at("resume"));
    await h.manager.restart("claude", { stop: "force", session: "resume" });
    reached.push(at("crash-recovery"));
    const forkName = await h.manager.commitFork(await h.manager.planFork("claude"));
    reached.push(at("fork"));

    // Every trigger added a materialization, and every one of them carried the revoked shape.
    expect(reached).toEqual([
      { trigger: "create", count: 1 },
      { trigger: "restart", count: 2 },
      { trigger: "resume", count: 3 },
      { trigger: "crash-recovery", count: 4 },
      { trigger: "fork", count: 5 },
    ]);
    expect(materialized.map((entry) => entry.capabilities)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(materialized.slice(0, 4).map((entry) => entry.name)).toEqual(["claude", "claude", "claude", "claude"]);
    expect(materialized[4]?.name).toBe(forkName);
  });

  it("t-088454: canonical Claude worktree fork seeds from source home/cwd to destination home/cwd", async () => {
    const sourceWorktree = { path: "/wt/source", branch: "tachyon/source", tachyonCreatedBranch: true, baseRef: "sha", baseBranch: "main", createdAt: "t" };
    const seeds: Array<[string, string]> = [];
    const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      worktreeDirty: async () => false,
      createForkWorktree: async () => ({
        cwd: "/wt/destination",
        worktree: { ...sourceWorktree, path: "/wt/destination", branch: "tachyon/destination" },
      }),
      materializeHarness: ({ name }) => {
        const home = path.join(h.ws, ".tachyon", "harness", name);
        return { home, env: { CLAUDE_CONFIG_DIR: home }, args: [] };
      },
      seedTranscript: (from, to) => {
        seeds.push([from, to]);
        return true;
      },
    });
    asAgent(h.manager.defOf("claude"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    await h.manager.spawn("claude");
    h.ledger.record("claude", { ...h.ledger.get("claude")!, worktree: sourceWorktree, cwd: "/wt/source" });

    await h.manager.commitFork(await h.manager.planFork("claude"));

    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.[0]).toContain(`${path.join(h.ws, ".tachyon", "harness", "claude")}/projects/-wt-source/`);
    expect(seeds[0]?.[1]).toContain(`${path.join(h.ws, ".tachyon", "harness", "claude-fork-1")}/projects/-wt-destination/`);
  });

  it("t-088454: failed canonical seed removes a newly created private home before any session exists", async () => {
    const removed: string[] = [];
    const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", {
      resolveCurrentSession: async () => UUID,
      materializeHarness: ({ name }) => {
        const home = path.join(h.ws, ".tachyon", "harness", name);
        fs.mkdirSync(home, { recursive: true });
        return { home, env: { CLAUDE_CONFIG_DIR: home }, args: [] };
      },
      seedTranscript: () => false,
      removeHarnessHome: (name) => {
        removed.push(name);
      },
    });
    asAgent(h.manager.defOf("claude"))!.profileLifecycle = {
      enabled: true,
      agentId: "11111111-1111-4111-8111-111111111111",
      canonicalSha256: "a".repeat(64),
      authorityRevision: "r1",
    };
    await h.manager.spawn("claude");
    removed.length = 0;

    await expect(h.manager.commitFork(await h.manager.planFork("claude"))).rejects.toThrow("couldn't seed");
    expect(removed).toEqual(["claude-fork-1"]);
    expect(h.sessions.has(h.manager.session("claude-fork-1"))).toBe(false);
    expect(h.ledger.get("claude-fork-1")).toBeUndefined();
  });

  it("v1: renaming an isolated-harness agent is refused (fail-closed — home is name-keyed)", async () => {
    const { manager } = resumeHarness(HARNESS_YML, stubHarness());
    await manager.spawn("researcher");
    await expect(manager.rename("researcher", "researcher2")).rejects.toThrow("isolated-harness agent isn't supported yet");
    await expect(manager.prepareAgentProfileRename("researcher", "researcher2")).rejects.toThrow("isolated-harness agent isn't supported yet");
  });

  it("phase 2: renaming a managed Pi agent is refused while its private session home is name-keyed", async () => {
    const { manager } = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
      getExtraEnv: () => ({}),
      materializePiSessionDir: (name) => `/private/pi-sessions/${name}`,
    });
    await manager.spawn("pi");
    await expect(manager.rename("pi", "pi2")).rejects.toThrow("managed Pi session isn't supported yet");
    await expect(manager.prepareAgentProfileRename("pi", "pi2")).rejects.toThrow("managed Pi session isn't supported yet");
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
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        bridgeClient: { boundGeneration: 6, wired: true },
      });

      await manager.resume("claude", ledger.get("claude")!, { injectPrimer: false, deferBridgeStamp: true });

      expect(ledger.get("claude")?.bridgeClient).toEqual({ boundGeneration: 6, wired: true });
    });

    it("resume re-injects the Bridge (the BLOCKER fix — resume rebuilds the command)", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { ...BRIDGE(), fileExists: () => true });
      await manager.spawn("claude");
      cmds.length = 0;
      await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "u-uuid-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
        instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false },
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

    it("grok (non-harness): spawn injects GROK_HOME=<private home> env and pins --no-memory", async () => {
      const calls: string[] = [];
      const { manager, cmds, newSessionArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", GROK_BRIDGE(calls));
      await manager.spawn("grok");
      // grok mints a session id via `-s <uuid>` (no Bridge argv flags)
      expect(cmds.at(-1)).toMatch(/^grok -s /);
      expect(cmds.at(-1)).not.toContain("mcp_servers");
      expect(cmds.at(-1)).not.toContain("--mcp-config");
      // t-c46c35 — this test used to assert "no argv change". There is one now.
      expect(cmds.at(-1)).toContain("--no-memory");
      // t-0e88f3 — and the argv is no longer what carries the guarantee. `--no-memory` was MEASURED
      // not to outrank GROK_MEMORY=1, so the env pin below is the control; the flag rides along as a
      // documented no-op. This is the launch site that matters most: the non-harness Bridge-wired path
      // is the common canonical Grok agent, and it reaches neither HarnessManager materializer.
      const envPairs = newSessionArgs.at(-1)!.filter((a) => a.startsWith("GROK_HOME=") || a.startsWith("GROK_MEMORY="));
      expect(envPairs).toEqual([
        "GROK_HOME=/ws/.tachyon/bridge-mcp/grok.grok",
        "GROK_MEMORY=0",
      ]);
      expect(calls).toEqual(["grok"]);
    });

    it("grok: with the Bridge down there is no private home AND no memory pin", async () => {
      // t-c46c35 — the honest boundary of this change. With no Bridge URL, withRuntimeBridge returns
      // before the grok branch, so the launch is untouched: no GROK_HOME, and no --no-memory either.
      // Tachyon is isolating nothing here, so the session inherits the runtime's own disabled default —
      // the pre-existing situation, unchanged. The pin covers the wired canonical path, which is the
      // path that has a private home worth protecting.
      const { manager, cmds, newSessionArgs } = resumeHarness("agents:\n  grok:\n    cmd: grok\n", {
        materializeBridgeMcpGrok: () => undefined,
      });
      await manager.spawn("grok");
      expect(cmds.at(-1)).not.toContain("--no-memory");
      // t-0e88f3 — the env pin observes the same boundary as the argv pin. Injecting GROK_MEMORY=0
      // into a launch Tachyon is otherwise not isolating would claim a guarantee over a session whose
      // config home, and therefore whose memory store, belongs to the user.
      expect(newSessionArgs.at(-1)!.filter((a) => a.startsWith("GROK_MEMORY="))).toEqual([]);
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
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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

    it("canonical Grok materializes its private home even when the Bridge is down", async () => {
      const materialized: string[] = [];
      const h = resumeHarness("agents:\n  grok:\n    cmd: grok\n", {
        materializeHarness: ({ name, def }) => {
          materialized.push(`${name}:${def.profileLifecycle?.authorityRevision ?? "legacy"}`);
          return {
            home: `/ws/.tachyon/bridge-mcp/${name}.grok`,
            env: { GROK_HOME: `/ws/.tachyon/bridge-mcp/${name}.grok` },
            args: [],
          };
        },
        materializeBridgeMcpGrok: () => undefined,
      });
      asAgent(h.manager.defOf("grok"))!.profileLifecycle = {
        enabled: true,
        agentId: "11111111-1111-4111-8111-111111111111",
        canonicalSha256: "a".repeat(64),
        authorityRevision: "grok-r1",
      };

      await h.manager.spawn("grok");

      expect(materialized).toEqual(["grok:grok-r1"]);
      expect(envFromTmuxArgs(h.newSessionArgs.at(-1)!).GROK_HOME).toBe("/ws/.tachyon/bridge-mcp/grok.grok");
    });

    // t-303f2b — gated/Temporary grok must use the Bridge private GROK_HOME (same as declared), not a
    // second isolate:transcript harness home that races auth materialization.
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
      await manager.resume("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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
      await manager.resume("codex", { def: { cmd: "codex", kind: "agent" }, resume: { runtime: "codex", sessionId: "captured-id" }, cwd: "/ws", instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true }, updatedAt: "t" });
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

    it("canonical Claude regenerates selected settings and exact folder trust on fresh, restart, and resume", async () => {
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
      const realClaudeHome = path.join(h.ws, "real-claude");
      const realClaudeJson = path.join(realClaudeHome, ".claude.json");
      fs.mkdirSync(realClaudeHome, { recursive: true });
      fs.mkdirSync(path.join(h.ws, ".claude", "skills", "review"), { recursive: true });
      fs.writeFileSync(path.join(realClaudeHome, ".credentials.json"), '{"token":"external-only"}\n');
      fs.writeFileSync(realClaudeJson, JSON.stringify({
        hasCompletedOnboarding: true,
        userID: "u123",
        projects: { "/ambient/sibling": { hasTrustDialogAccepted: true } },
      }));
      fs.writeFileSync(path.join(h.ws, ".claude", "settings.json"), JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "guard" }] }] },
      }));
      fs.writeFileSync(path.join(h.ws, ".claude", "settings.local.json"), JSON.stringify({
        permissions: { allow: ["Read", "Bash"] },
      }));
      fs.writeFileSync(path.join(h.ws, ".claude", "skills", "review", "SKILL.md"), "# Canonical review\n");
      fs.writeFileSync(path.join(h.ws, ".mcp.json"), JSON.stringify({
        mcpServers: { workspace: { command: "workspace-mcp" } },
      }));
      const harness = new HarnessManager(h.ws, realClaudeHome, {}, realClaudeJson);
      const materialized: string[] = [];
      asAgent(h.manager.defOf("claude"))!.profileLifecycle = {
        enabled: true, agentId: "11111111-1111-4111-8111-111111111111", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      const nativeConfig: ResolvedAgentNativeConfigProjection = {
        adapter: "claude",
        selectors: { model: "claude-opus-5", reasoningEffort: "high" },
        settings: { permissions: { allow: ["Read"] } },
      };
      const capabilities: ResolvedAgentCapabilityProjection = {
        schemaVersion: 1,
        adapter: "claude",
        sha256: "a".repeat(64),
        sources: [{ referenceId: "review", kind: "skill", scope: "profile", owner: "agent", path: "capabilities/review", sha256: "b".repeat(64) }],
        skills: [{ name: "review", source: {
          source: "capabilities/review",
          sourcePath: path.join(h.ws, "capabilities/review"),
          type: "tree",
          sha256: "b".repeat(64),
          entries: [
            { path: ".", type: "directory", mode: 0o755 },
            { path: "SKILL.md", type: "file", mode: 0o644, bytes: Buffer.from("# Captured review\n") },
          ],
        } }],
        mcp: { selected: { command: "selected-mcp" } },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "selected-hook" }] }] },
        pi: { extensions: [], prompts: [], themes: [], packages: [] },
      };
      asAgent(h.manager.defOf("claude"))!.profileNativeConfig = nativeConfig;
      asAgent(h.manager.defOf("claude"))!.profileCapabilities = capabilities;
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, cwd }) => {
        const result = harness.materializeCanonicalClaudeProfileHome(name, adapterFor("claude")!, {
          nativeConfig,
          capabilities,
        }, cwd);
        materialized.push(JSON.stringify({
          args: result.args,
          claudeJson: JSON.parse(fs.readFileSync(path.join(result.home, ".claude.json"), "utf8")),
          settings: JSON.parse(fs.readFileSync(path.join(result.home, "settings.json"), "utf8")),
          skill: fs.readFileSync(path.join(result.home, "skills", "review", "SKILL.md"), "utf8"),
          mcp: JSON.parse(fs.readFileSync(path.join(result.home, "mcp.json"), "utf8")),
          manifest: JSON.parse(fs.readFileSync(path.join(result.home, ".tachyon-profile-capabilities", "manifest.json"), "utf8")),
        }));
        return result;
      };

      await h.manager.spawn("claude");
      const privateHome = harnessHome(h.ws, "claude");
      fs.writeFileSync(path.join(privateHome, ".claude.json"), JSON.stringify({
        projects: { "/stale": { hasTrustDialogAccepted: true } },
      }));
      fs.writeFileSync(path.join(privateHome, "settings.json"), JSON.stringify({ permissions: { allow: ["Write"] } }));
      fs.mkdirSync(path.join(privateHome, "skills", "review"), { recursive: true });
      fs.writeFileSync(path.join(privateHome, "skills", "review", "SKILL.md"), "stale skill\n");
      fs.writeFileSync(path.join(privateHome, "mcp.json"), JSON.stringify({ mcpServers: { stale: { command: "stale" } } }));
      await h.manager.restart("claude", { stop: "force", session: "new" });
      fs.writeFileSync(path.join(privateHome, ".claude.json"), JSON.stringify({ runtimeState: "stale" }));
      fs.writeFileSync(path.join(privateHome, "settings.json"), JSON.stringify({ runtimeState: "stale" }));
      fs.mkdirSync(path.join(privateHome, "skills", "review"), { recursive: true });
      fs.writeFileSync(path.join(privateHome, "skills", "review", "SKILL.md"), "stale again\n");
      fs.writeFileSync(path.join(privateHome, "mcp.json"), JSON.stringify({ runtimeState: "stale" }));
      await h.manager.resume("claude", {
        def: { cmd: "claude", kind: "agent" },
        resume: { runtime: "claude", sessionId: "captured-id" },
        cwd: h.ws,
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        updatedAt: "now",
      });

      expect(materialized).toHaveLength(3);
      for (const captured of materialized) {
        const state = JSON.parse(captured);
        expect(state.args).toEqual([
          "--setting-sources", "user",
          "--settings", path.join(privateHome, "settings.json"),
          "--model", "claude-opus-5",
          "--effort", "high",
          "--mcp-config", path.join(privateHome, "mcp.json"),
          "--strict-mcp-config",
        ]);
        expect(state.claudeJson.projects).toEqual({
          [path.resolve(h.ws)]: { hasTrustDialogAccepted: true },
        });
        expect(state.claudeJson).toMatchObject({ hasCompletedOnboarding: true, userID: "u123" });
        expect(state.settings).toEqual({
          permissions: { allow: ["Read"] },
          hooks: capabilities.hooks,
          autoMemoryEnabled: false,
        });
        expect(state.skill).toBe("# Captured review\n");
        expect(state.mcp).toEqual({ mcpServers: { selected: { command: "selected-mcp" } } });
        expect(state.manifest).toMatchObject({ adapter: "claude", capabilityProjectionSha256: "a".repeat(64) });
        expect(JSON.stringify(state)).not.toContain("ambient/sibling");
        expect(JSON.stringify(state)).not.toContain("stale");
      }
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).CLAUDE_CONFIG_DIR))
        .toEqual([privateHome, privateHome, privateHome]);
    });

    it("canonical Grok regenerates exact trust without losing auth or Bridge MCP on fresh, restart, and resume", async () => {
      const h = resumeHarness("agents:\n  grok:\n    cmd: grok\n", { fileExists: () => true });
      const realGrokHome = path.join(h.ws, "real-grok");
      fs.mkdirSync(realGrokHome, { recursive: true });
      fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"token":"external-only"}\n');
      const harness = new HarnessManager(
        h.ws,
        path.join(h.ws, "real-claude"),
        {},
        path.join(h.ws, "real-claude", ".claude.json"),
        undefined,
        undefined,
        undefined,
        realGrokHome,
      );
      const bridge = {
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}" },
      };
      const materialized: Array<{ config: string; trust: string }> = [];
      asAgent(h.manager.defOf("grok"))!.profileLifecycle = {
        enabled: true, agentId: "11111111-1111-4111-8111-111111111111", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, cwd }) => {
        const home = harness.materializeBridgeMcpGrok(name, bridge, cwd ?? h.ws, { exactTrust: true });
        materialized.push({
          config: fs.readFileSync(path.join(home, "config.toml"), "utf8"),
          trust: fs.readFileSync(path.join(home, "trusted_folders.toml"), "utf8"),
        });
        return { home, env: { GROK_HOME: home, HOME: home }, args: [] };
      };

      await h.manager.spawn("grok");
      const privateHome = bridgeGrokHome(h.ws, "grok");
      fs.writeFileSync(path.join(privateHome, "trusted_folders.toml"), '[folders."/stale-restart"]\ntrusted = true\ndecided_at = 1\n');
      fs.writeFileSync(path.join(privateHome, "config.toml"), '[mcp_servers.stale]\ncommand = "wrong"\n');
      await h.manager.restart("grok", { stop: "force", session: "new" });
      fs.writeFileSync(path.join(privateHome, "trusted_folders.toml"), '[folders."/stale-resume"]\ntrusted = true\ndecided_at = 2\n');
      fs.rmSync(path.join(privateHome, "config.toml"));
      await h.manager.resume("grok", {
        def: { cmd: "grok", kind: "agent" },
        resume: { runtime: "grok", sessionId: "captured-id" },
        cwd: h.ws,
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        updatedAt: "now",
      });

      expect(materialized).toHaveLength(3);
      expect(new Set(materialized.map(({ config }) => config)).size).toBe(1);
      /**
       * t-6907aa — compared with `decided_at` normalized, because that field is a WALL-CLOCK stamp
       * and the three materializations happen at three separate moments.
       *
       * `seedGrokTrustedFolders` preserves a prior `decided_at` when one exists for the same folder,
       * but this test deliberately overwrites the file with a DIFFERENT folder key before each
       * relaunch (`/stale-restart`, `/stale-resume`), so the workspace root has no prior entry to
       * carry forward and every pass falls back to `Math.floor(Date.now() / 1000)`. Three reads of
       * the clock agree only while they land inside the same second — which they do when this file
       * runs alone, and stop doing under `verify:full`'s parallel load. Byte equality was therefore
       * asserting the scheduler, not the product: it failed a landing gate on a CSS-only change.
       *
       * The property the test is named for — regeneration is EXACT and history-independent — is
       * unchanged and still asserted below: same folder set, `trusted = true` exactly once, no stale
       * entry. The three now agree on all of that, and differ only where time legitimately does.
       */
      const withoutDecidedAt = (trust: string): string =>
        trust.replace(/^([ \t]*decided_at[ \t]*=[ \t]*)\d+$/gm, "$1<stamp>");
      expect(new Set(materialized.map(({ trust }) => withoutDecidedAt(trust))).size).toBe(1);
      // The stamp must still be present and numeric in every pass. Normalizing a field away is how a
      // relaxed assertion rots into a vacuous one — this keeps the field itself under test.
      for (const { trust } of materialized) expect(trust).toMatch(/^[ \t]*decided_at[ \t]*=[ \t]*\d+$/m);
      for (const { config, trust } of materialized) {
        expect(config).toContain("[mcp_servers.tachyon_bridge]");
        expect(config).not.toContain("mcp_servers.stale");
        expect(trust).toContain(`[folders."${path.resolve(h.ws)}"]`);
        expect(trust.match(/trusted\s*=\s*true/g)).toHaveLength(1);
        expect(trust).not.toContain("stale-");
      }
      // t-de73e0 — the credential is a private COPY, so it is compared by CONTENT: a shared inode
      // is exactly what let one agent's re-auth destroy the person's credential.
      expect(fs.lstatSync(path.join(privateHome, "auth.json")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(privateHome, "auth.json"), "utf8"))
        .toBe(fs.readFileSync(path.join(realGrokHome, "auth.json"), "utf8"));
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).GROK_HOME))
        .toEqual([privateHome, privateHome, privateHome]);
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).HOME))
        .toEqual([privateHome, privateHome, privateHome]);
    });

    it("canonical Pi regenerates exact trust without losing private state on fresh, restart, and resume", async () => {
      const h = resumeHarness("agents:\n  pi:\n    cmd: pi\n", {
        fileExists: () => true,
        materializePiSessionDir: (name) => path.join(harnessHome(h.ws, name), "sessions"),
        resolveCaptureSession: async (_runtime, _cwd, home, id) => ({
          id: id ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          path: path.join(home ?? h.ws, `${id ?? "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}.jsonl`),
        }),
      });
      const realPiHome = path.join(h.ws, "real-pi");
      fs.mkdirSync(realPiHome, { recursive: true });
      fs.writeFileSync(path.join(realPiHome, "auth.json"), '{"provider":{"type":"oauth"}}\n');
      fs.writeFileSync(path.join(realPiHome, "settings.json"), '{"theme":"dark"}\n');
      fs.writeFileSync(path.join(realPiHome, "trust.json"), '{"/ambient-parent":true}\n');
      const harness = new HarnessManager(
        h.ws,
        path.join(h.ws, "real-claude"),
        {},
        path.join(h.ws, "real-claude", ".claude.json"),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        realPiHome,
      );
      const materialized: string[] = [];
      asAgent(h.manager.defOf("pi"))!.profileLifecycle = {
        enabled: true, agentId: "11111111-1111-4111-8111-111111111111", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, cwd }) => {
        const result = harness.materializePiHomeOnly(name, { exactTrustCwd: cwd ?? h.ws });
        materialized.push(fs.readFileSync(path.join(result.home, "trust.json"), "utf8"));
        return result;
      };

      await h.manager.spawn("pi");
      const privateHome = harnessHome(h.ws, "pi");
      fs.writeFileSync(path.join(privateHome, "trust.json"), '{"/stale-restart":true}\n');
      fs.writeFileSync(path.join(privateHome, "settings.json"), '{"theme":"runtime-owned"}\n');
      await h.manager.restart("pi", { stop: "force", session: "new" });
      fs.writeFileSync(path.join(privateHome, "trust.json"), '{"/stale-resume":false}\n');
      await h.manager.resume("pi", {
        def: { cmd: "pi", kind: "agent" },
        resume: { runtime: "pi", sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
        cwd: h.ws,
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        updatedAt: "now",
      });

      expect(materialized).toHaveLength(3);
      expect(new Set(materialized).size).toBe(1);
      expect(JSON.parse(materialized[0]!)).toEqual({ [fs.realpathSync(h.ws)]: true });
      expect(JSON.parse(fs.readFileSync(path.join(privateHome, "settings.json"), "utf8")))
        .toEqual({ theme: "runtime-owned" });
      expect(JSON.parse(fs.readFileSync(path.join(privateHome, "auth.json"), "utf8")))
        .toEqual({ provider: { type: "oauth" } });
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).PI_CODING_AGENT_DIR))
        .toEqual([privateHome, privateHome, privateHome]);
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).PI_CODING_AGENT_SESSION_DIR))
        .toEqual([
          path.join(privateHome, "sessions"),
          path.join(privateHome, "sessions"),
          path.join(privateHome, "sessions"),
        ]);
    });

    it("t-1a3d50: canonical Codex regenerates one private policy on fresh, restart, and resume", async () => {
      const h = resumeHarness("agents:\n  codex:\n    cmd: codex\n", { fileExists: () => true });
      const realCodexHome = path.join(h.ws, "real-codex");
      const workspaceSource = path.join(h.ws, ".codex", "config.toml");
      fs.mkdirSync(realCodexHome, { recursive: true });
      fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
      fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"access_token":"external-only"}\n');
      fs.writeFileSync(path.join(realCodexHome, "config.toml"), 'model = "ambient-secret-model"\n');
      fs.writeFileSync(workspaceSource, '[mcp_servers.ambient]\ncommand = "must-not-copy"\n');

      const nativeConfig: ResolvedAgentNativeConfigProjection = {
        adapter: "codex",
        selectors: { model: "gpt-5.6", provider: "openai", reasoningEffort: "high", serviceTier: "fast" },
        permissions: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
        interface: { personality: "pragmatic", statusLine: ["model", "git-branch"], statusLineUseColors: true },
        featureFlags: { terminalResizeReflow: true },
      };
      const capabilities: ResolvedAgentCapabilityProjection = {
        schemaVersion: 1,
        adapter: "codex",
        sha256: "a".repeat(64),
        effectiveProfileSha256: "b".repeat(64),
        sources: [{ referenceId: "research", kind: "skill", scope: "project", owner: "workspace", path: "skills/research", sha256: "c".repeat(64) }],
        skills: [{ name: "research", source: {
          source: "skills/research", sourcePath: path.join(h.ws, "skills", "research"), type: "tree", sha256: "c".repeat(64),
          entries: [
            { path: ".", type: "directory", mode: 0o755 },
            { path: "SKILL.md", type: "file", mode: 0o644, bytes: Buffer.from("# Captured skill\n") },
          ],
        } }],
        mcp: { docs: { command: "node", args: ["docs.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } } },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node guard.js" }] }] },
        pi: { extensions: [], prompts: [], themes: [], packages: [] },
      };
      const harness = new HarnessManager(
        h.ws,
        path.join(h.ws, "real-claude"),
        { DOCS_TOKEN: "launch-only-secret" },
        path.join(h.ws, "real-claude", ".claude.json"),
        realCodexHome,
      );
      const materialized: string[] = [];
      // t-94d49a — a Codex profile that carries skills must launch OUTSIDE the workspace root, whose
      // `.agents/skills` belongs to the plugin installer; this stands in for the agent's worktree.
      const launchCwd = path.join(h.ws, "worktree");
      fs.mkdirSync(launchCwd, { recursive: true });
      asAgent(h.manager.defOf("codex"))!.profileLifecycle = {
        enabled: true, agentId: "11111111-1111-4111-8111-111111111111", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      asAgent(h.manager.defOf("codex"))!.profileNativeConfig = nativeConfig;
      asAgent(h.manager.defOf("codex"))!.profileCapabilities = capabilities;
      // The actual launch boundary is what matters: each lifecycle path invokes the same real private-home writer.
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, def }) => {
        const result = harness.materializeCanonicalCodexProfileHome(name, adapterFor("codex")!, {
          nativeConfig: def.profileNativeConfig,
          capabilities: def.profileCapabilities,
        }, launchCwd, { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } });
        materialized.push(fs.readFileSync(path.join(result.home, "config.toml"), "utf8"));
        return result;
      };

      await h.manager.spawn("codex");
      const privateHome = harnessHome(h.ws, "codex");
      fs.writeFileSync(path.join(privateHome, "config.toml"), 'model = "tampered"\n');
      fs.writeFileSync(path.join(launchCwd, ".agents", "skills", "research", "SKILL.md"), "tampered\n");
      await h.manager.restart("codex", { stop: "force", session: "new" });
      fs.rmSync(path.join(privateHome, "config.toml"));
      await h.manager.resume("codex", {
        def: { cmd: "codex", kind: "agent" },
        resume: { runtime: "codex", sessionId: "captured-id" },
        cwd: h.ws,
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        updatedAt: "now",
      });

      expect(materialized).toHaveLength(3);
      expect(new Set(materialized).size).toBe(1);
      const config = materialized[0]!;
      expect(config).toContain('model = "gpt-5.6"');
      expect(config).toContain('approval_policy = "on-request"');
      expect(config).toContain(`[projects.${JSON.stringify(path.resolve(h.ws))}]\ntrust_level = "trusted"`);
      expect(config).not.toContain(JSON.stringify(path.join(path.dirname(h.ws), "sibling")));
      expect(config).toContain("[mcp_servers.docs]");
      expect(config).toContain("[mcp_servers.tachyon_bridge]");
      expect(config).toContain("hooks.SessionStart =");
      expect(config).not.toContain("ambient-secret-model");
      expect(config).not.toContain("launch-only-secret");
      expect(fs.readFileSync(path.join(launchCwd, ".agents", "skills", "research", "SKILL.md"), "utf8")).toBe("# Captured skill\n");
      expect(fs.realpathSync(path.join(privateHome, "auth.json"))).toBe(fs.realpathSync(path.join(realCodexHome, "auth.json")));
      expect(fs.readFileSync(workspaceSource, "utf8")).toContain("must-not-copy");
      expect(h.startArgs.map((args) => envFromTmuxArgs(args).CODEX_HOME)).toEqual([privateHome, privateHome, privateHome]);
      await expect(h.manager.planFork("codex")).rejects.toThrow("has no native session fork");
    });

    it("t-5498a6: a delegated Codex child receives the parent's enumerated skills with audited origin", async () => {
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
      const parent = asAgent(h.manager.defOf("claude"))!;
      parent.profileCapabilities = {
        schemaVersion: 1, adapter: "claude", sha256: "a".repeat(64),
        sources: [{ referenceId: "visual-qa", kind: "skill", scope: "project", owner: "plugin:visual-qa", path: ".tachyon/plugins/visual-qa/skills/visual-qa", sha256: "b".repeat(64) }],
        skills: [{ name: "visual-qa", source: { source: "visual-qa", sourcePath: "/captured/visual-qa", type: "tree", sha256: "b".repeat(64), entries: [
          { path: ".", type: "directory", mode: 0o755 },
          { path: "SKILL.md", type: "file", mode: 0o644, bytes: Buffer.from("# Safe browser contract\n") },
        ] } }],
        mcp: { forbidden_secret_channel: { command: "never-inherit" } }, hooks: {},
        pi: { extensions: [], prompts: [], themes: [], packages: [] },
      };
      const realCodexHome = path.join(h.ws, "real-codex");
      fs.mkdirSync(realCodexHome);
      fs.writeFileSync(path.join(realCodexHome, "auth.json"), "{}");
      const harness = new HarnessManager(h.ws, path.join(h.ws, "real-claude"), {}, path.join(h.ws, "real-claude", ".claude.json"), realCodexHome);
      // t-94d49a — the child's own worktree: a Codex skill projection may not land in the workspace
      // root, where `.agents/skills` is the plugin installer's.
      const childCwd = path.join(h.ws, "child-worktree");
      fs.mkdirSync(childCwd, { recursive: true });
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, def }) =>
        harness.materializeProfileCapabilities(name, asAgent(def)!.profileCapabilities!, adapterFor("codex")!, childCwd);

      await h.manager.spawn("child", { cmd: "codex", parent: "claude", reveal: false });

      expect(fs.readFileSync(path.join(childCwd, ".agents", "skills", "visual-qa", "SKILL.md"), "utf8")).toContain("Safe browser contract");
      const manifest = JSON.parse(fs.readFileSync(path.join(harnessHome(h.ws, "child"), ".tachyon-profile-capabilities", "manifest.json"), "utf8"));
      expect(manifest.outputs.skills).toEqual([{ name: "visual-qa", sha256: "b".repeat(64), origins: [{ kind: "delegator", agent: "claude" }] }]);
      expect(fs.readFileSync(path.join(harnessHome(h.ws, "child"), "config.toml"), "utf8")).not.toContain("never-inherit");
    });

    it("t-b505b3: a delegated child receives lockfile-granted plugin skills, but invents none without a grant", async () => {
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n  bare:\n    cmd: codex\n", { fileExists: () => true });
      const skillDir = path.join(h.ws, ".claude", "skills", "visual-qa");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Plugin-granted visual QA\n");
      fs.mkdirSync(path.join(h.ws, ".tachyon"), { recursive: true });
      fs.writeFileSync(path.join(h.ws, ".tachyon", "plugins.lock.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: {
          "visual-qa": {
            name: "visual-qa", version: "1.0.0", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/visual-qa" }],
          },
        },
      }));
      const projections = new Map<string, ResolvedAgentCapabilityProjection | undefined>();
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, def }) => {
        projections.set(name, asAgent(def)?.profileCapabilities);
        return { home: path.join(h.ws, "homes", name), env: {}, args: [] };
      };

      await h.manager.spawn("plugin-child", { cmd: "grok", delegator: "claude", reveal: false });
      await h.manager.spawn("bare-child", { cmd: "codex", parent: "bare", reveal: false });

      const inherited = projections.get("plugin-child")!;
      expect(inherited.skills.map((skill) => skill.name)).toEqual(["visual-qa"]);
      expect(Buffer.from(inherited.skills[0]?.source.entries.find((entry) => entry.path === "SKILL.md")?.bytes ?? []).toString())
        .toBe("# Plugin-granted visual QA\n");
      expect(inherited.skillOrigins).toEqual({ "visual-qa": [{ kind: "delegator", agent: "claude" }] });
      expect(projections.get("bare-child")).toBeUndefined();
    });

    it("t-b505b3: an uncapturable grant is withheld by name and the child still spawns", async () => {
      // Measured in the field on 0.56.152: `product-foundation` is a legitimate 8.1 MiB plugin skill
      // against a 1 MiB capture cap, and the throw refused EVERY delegation in the workspace — grok
      // and codex alike. Losing one tool is recoverable; being unable to spawn at all is not.
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
      const small = path.join(h.ws, ".claude", "skills", "visual-qa");
      fs.mkdirSync(small, { recursive: true });
      fs.writeFileSync(path.join(small, "SKILL.md"), "# small\n");
      const huge = path.join(h.ws, ".claude", "skills", "product-foundation");
      fs.mkdirSync(huge, { recursive: true });
      fs.writeFileSync(path.join(huge, "SKILL.md"), "x".repeat(2 * 1024 * 1024));
      fs.mkdirSync(path.join(h.ws, ".tachyon"), { recursive: true });
      fs.writeFileSync(path.join(h.ws, ".tachyon", "plugins.lock.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: {
          "product-foundation": {
            name: "product-foundation", version: "1.0.0", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/product-foundation" }],
          },
          "visual-qa": {
            name: "visual-qa", version: "1.0.0", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/visual-qa" }],
          },
        },
      }));
      const warnings: string[] = [];
      const projections = new Map<string, ResolvedAgentCapabilityProjection | undefined>();
      const opts = (h.manager as unknown as { opts: AgentManagerOptions }).opts;
      opts.notify = (message: string) => { warnings.push(message); };
      opts.materializeHarness = ({ name, def }) => {
        projections.set(name, asAgent(def)?.profileCapabilities);
        return { home: path.join(h.ws, "homes", name), env: {}, args: [] };
      };

      await h.manager.spawn("child", { cmd: "grok", delegator: "claude", reveal: false });

      // The spawn happened at all — that is the regression this guards.
      const inherited = projections.get("child")!;
      // The capturable grant still crosses; only the oversized one is dropped.
      expect(inherited.skills.map((skill) => skill.name)).toEqual(["visual-qa"]);
      // Withheld BY NAME, never silently: the caller can see which tool the child lacks and why.
      expect(warnings.some((line) => line.includes("product-foundation") && line.includes("withheld"))).toBe(true);
    });

    it("t-b0cfd4: a plugin update withholds the changed skill instead of handing the child unapproved bytes", async () => {
      // Measured in the field on 0.56.154: installing tachyon-plugins v2.3.1 bumped agent-browser
      // 3.0.0 → 3.1.0, the parent's resolved sha no longer matched the fresh lockfile capture, and
      // the throw refused EVERY spawn. 4601017b answered that by REFRESHING the parent's snapshot
      // when provenance matched. Not refusing was right; refreshing was not — it delivers the child
      // bytes no human approved, and it made the two layers disagree, the config withholding the
      // changed skill while delegation quietly shipped it. Both now withhold by name and continue.
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
      const dir = path.join(h.ws, ".claude", "skills", "agent-browser");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# agent-browser 3.1.0 — the UPDATED bytes\n");
      fs.mkdirSync(path.join(h.ws, ".tachyon"), { recursive: true });
      fs.writeFileSync(path.join(h.ws, ".tachyon", "plugins.lock.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: {
          "agent-browser": {
            name: "agent-browser", version: "3.1.0", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/agent-browser" }],
          },
        },
      }));
      // The parent carries a STALE resolution of the same plugin-provided skill: right name, right
      // provenance, bytes from before the update.
      asAgent(h.manager.defOf("claude"))!.profileCapabilities = {
        schemaVersion: 1,
        adapter: "claude",
        sha256: "f".repeat(64),
        skills: [{ name: "agent-browser", source: { sha256: "a".repeat(64), entries: [{ path: "SKILL.md", bytes: [] }] } }],
        sources: [{ referenceId: "plugin:agent-browser:agent-browser", kind: "skill", scope: "project", owner: "plugin:agent-browser", path: ".claude/skills/agent-browser", sha256: "a".repeat(64) }],
        mcp: {}, hooks: {}, pi: { extensions: [], prompts: [], themes: [], packages: [] },
      } as unknown as ResolvedAgentCapabilityProjection;

      const warnings: string[] = [];
      const projections = new Map<string, ResolvedAgentCapabilityProjection | undefined>();
      const opts = (h.manager as unknown as { opts: AgentManagerOptions }).opts;
      opts.notify = (message: string) => { warnings.push(message); };
      opts.materializeHarness = ({ name, def }) => {
        projections.set(name, asAgent(def)?.profileCapabilities);
        return { home: path.join(h.ws, "homes", name), env: {}, args: [] };
      };

      await h.manager.spawn("child", { cmd: "grok", delegator: "claude", reveal: false });

      // The spawn happened at all — that is the regression 4601017b guards and this keeps.
      const inherited = projections.get("child")!;
      const skill = inherited.skills.find((candidate) => candidate.name === "agent-browser")!;
      // The updated bytes do NOT cross: the child receives the copy the parent's pin approved.
      expect(Buffer.from(skill.source.entries.find((entry) => entry.path === "SKILL.md")?.bytes ?? []).toString())
        .not.toContain("UPDATED");
      expect(skill.source.sha256).toBe("a".repeat(64));
      // Withheld BY NAME and out loud, naming the gesture that accepts the new content.
      expect(warnings.some((line) => line.includes("agent-browser") && line.includes("withheld") && line.includes("Reauthorize")))
        .toBe(true);
    });

    it("t-b0cfd4: a skill the parent's own config withheld does not reach the child either", async () => {
      // The alignment this task exists for. The config layer is the only one that can see a pin go
      // stale — by the time the lockfile is read at spawn the capture succeeds and looks healthy —
      // so without the parent carrying its withholdings the child would receive exactly the bytes
      // the parent is running without.
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n", { fileExists: () => true });
      for (const name of ["agent-browser", "sdd"]) {
        const dir = path.join(h.ws, ".claude", "skills", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name} — installed bytes\n`);
      }
      fs.mkdirSync(path.join(h.ws, ".tachyon"), { recursive: true });
      fs.writeFileSync(path.join(h.ws, ".tachyon", "plugins.lock.json"), JSON.stringify({
        schemaVersion: 1,
        plugins: {
          "agent-browser": {
            name: "agent-browser", version: "3.1.0", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/agent-browser" }],
          },
          sdd: {
            name: "sdd", version: "1.7.1", runtimes: ["claude"],
            targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/sdd" }],
          },
        },
      }));
      // What the config projection produced for the parent: sdd delivered, agent-browser withheld.
      const parent = asAgent(h.manager.defOf("claude"))!;
      parent.profileWithheldCapabilities = [{
        referenceId: "agent-browser",
        name: "agent-browser",
        kind: "skill",
        path: ".tachyon/plugins/agent-browser/skills/agent-browser",
        code: "profile/digest-mismatch",
        expectedSha256: "6".repeat(64),
        consumedSha256: "f".repeat(64),
        version: "3.0.0",
        detail: "profile/digest-mismatch: expected 6…, consumed f…",
      }];
      const warnings: string[] = [];
      const projections = new Map<string, ResolvedAgentCapabilityProjection | undefined>();
      const opts = (h.manager as unknown as { opts: AgentManagerOptions }).opts;
      opts.notify = (message: string) => { warnings.push(message); };
      opts.materializeHarness = ({ name, def }) => {
        projections.set(name, asAgent(def)?.profileCapabilities);
        return { home: path.join(h.ws, "homes", name), env: {}, args: [] };
      };

      await h.manager.spawn("child", { cmd: "grok", delegator: "claude", reveal: false });

      // Production reaches this projection from
      // canFork → defOf → definitionOf → withDelegatedToolkit → delegableToolkit on every
      // sidebar fleet build. A stable authorization condition is still one human warning, however
      // often the presentation asks whether the same child can fork.
      for (let evaluation = 0; evaluation < 30; evaluation++) h.manager.defOf("child");

      const inherited = projections.get("child")!;
      // The child spawned, with everything except the one capability nobody re-approved.
      expect(inherited.skills.map((skill) => skill.name)).toEqual(["sdd"]);
      expect(warnings.filter((line) => line.includes("agent-browser") && line.includes("Reauthorize"))).toHaveLength(1);
    });

    it("t-b0cfd4: two profiles pinning one name at different content withhold the delegated copy instead of aborting the spawn", async () => {
      // The fourth site of the same shape, found by sweeping for it rather than by waiting for it:
      // this threw, and a throw here is the whole spawn. Both copies are approved bytes, so neither
      // is unsafe — what is unsafe is choosing silently between two different things wearing one
      // name. The child's own authored selection wins and the delegated one is withheld by name.
      const h = resumeHarness("agents:\n  claude:\n    cmd: claude\n  child:\n    cmd: claude\n", { fileExists: () => true });
      const captured = (sha: string, body: string) => ({
        name: "sdd",
        source: {
          source: "sdd", sourcePath: "/captured/sdd", type: "tree" as const, sha256: sha,
          entries: [
            { path: ".", type: "directory" as const, mode: 0o755 },
            { path: "SKILL.md", type: "file" as const, mode: 0o644, bytes: Buffer.from(body) },
          ],
        },
      });
      asAgent(h.manager.defOf("claude"))!.profileCapabilities = {
        schemaVersion: 1, adapter: "claude", sha256: "a".repeat(64),
        sources: [{ referenceId: "sdd", kind: "skill", scope: "project", owner: "plugin:sdd", path: ".tachyon/plugins/sdd/skills/sdd", sha256: "a".repeat(64) }],
        skills: [captured("a".repeat(64), "# the delegator's sdd\n")],
        mcp: {}, hooks: {}, pi: { extensions: [], prompts: [], themes: [], packages: [] },
      };
      const warnings: string[] = [];
      const projections = new Map<string, ResolvedAgentCapabilityProjection | undefined>();
      const opts = (h.manager as unknown as { opts: AgentManagerOptions }).opts;
      opts.notify = (message: string) => { warnings.push(message); };
      opts.materializeHarness = ({ name, def }) => {
        projections.set(name, asAgent(def)?.profileCapabilities);
        return { home: path.join(h.ws, "homes", name), env: {}, args: [] };
      };

      // The child is DECLARED, with its own pin on the same name.
      asAgent(h.manager.defOf("child"))!.profileCapabilities = {
        schemaVersion: 1, adapter: "claude", sha256: "b".repeat(64),
        sources: [{ referenceId: "sdd", kind: "skill", scope: "project", owner: "plugin:sdd", path: ".tachyon/plugins/sdd/skills/sdd", sha256: "b".repeat(64) }],
        skills: [captured("b".repeat(64), "# the child's own sdd\n")],
        mcp: {}, hooks: {}, pi: { extensions: [], prompts: [], themes: [], packages: [] },
      };

      await h.manager.spawn("child", { parent: "claude", reveal: false });

      // The spawn happened at all — that is what the throw cost.
      const inherited = projections.get("child")!;
      const skill = inherited.skills.find((candidate) => candidate.name === "sdd")!;
      expect(Buffer.from(skill.source.entries.find((entry) => entry.path === "SKILL.md")?.bytes ?? []).toString())
        .toBe("# the child's own sdd\n");
      expect(warnings.some((line) => line.includes("sdd") && line.includes("withheld"))).toBe(true);
      // The withheld copy leaves the manifest's provenance too: a source naming bytes the child was
      // deliberately not given would describe a toolkit it does not have.
      expect(inherited.sources.map((source) => source.sha256)).toEqual(["b".repeat(64)]);
    });

    it("t-26f508: canonical Grok regenerates one private projection on fresh, restart and resume, and refuses fork", async () => {
      const h = resumeHarness("agents:\n  grok:\n    cmd: grok\n", { fileExists: () => true });
      const realGrokHome = path.join(h.ws, "real-grok");
      fs.mkdirSync(realGrokHome, { recursive: true });
      fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"access_token":"external-only"}\n');

      const nativeConfig: ResolvedAgentNativeConfigProjection = {
        adapter: "grok",
        selectors: {},
        toml: { "models.default": "grok-4.5", "ui.permission_mode": "ask", "features.telemetry": false },
      };
      const harness = new HarnessManager(
        h.ws,
        path.join(h.ws, "real-claude"),
        {},
        path.join(h.ws, "real-claude", ".claude.json"),
        undefined,
        undefined,
        undefined,
        realGrokHome,
      );
      asAgent(h.manager.defOf("grok"))!.profileLifecycle = {
        enabled: true, agentId: "22222222-2222-4222-8222-222222222222", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      asAgent(h.manager.defOf("grok"))!.profileNativeConfig = nativeConfig;
      const materialized: string[] = [];
      // Mirrors Workspace's canonical Grok branch: the same real writer on every lifecycle path.
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, def, cwd }) => {
        const home = harness.materializeBridgeMcpGrok(
          name,
          { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } },
          cwd,
          { exactTrust: true, ...(def.profileNativeConfig ? { nativeConfig: def.profileNativeConfig } : {}) },
        );
        materialized.push(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
        return { home, env: { GROK_HOME: home, HOME: home }, args: [] };
      };

      await h.manager.spawn("grok");
      await h.manager.restart("grok", { stop: "force", session: "new" });
      await h.manager.resume("grok", {
        def: { cmd: "grok", kind: "agent" },
        resume: { runtime: "grok", sessionId: "22222222-2222-4222-8222-222222222222" },
        cwd: h.ws,
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
        updatedAt: "now",
      });

      expect(materialized).toHaveLength(3);
      expect(new Set(materialized).size, "one projection, regenerated identically").toBe(1);
      const config = materialized[0]!;
      expect(config).toContain('default = "grok-4.5"');
      expect(config).toContain('permission_mode = "ask"');
      expect(config).toContain("telemetry = false");
      expect(config).toContain("[compat.claude]");
      expect(config).toContain("[mcp_servers.tachyon_bridge]");
      expect(config).not.toContain("external-only");
      // Auth stays external to the projection, which never authors it — and since t-de73e0 it is a
      // private copy rather than a pointer, so equality is by content.
      const privateHome = bridgeGrokHome(h.ws, "grok");
      expect(fs.lstatSync(path.join(privateHome, "auth.json")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(privateHome, "auth.json"), "utf8"))
        .toBe(fs.readFileSync(path.join(realGrokHome, "auth.json"), "utf8"));
      // t-ee5c05 — fork is no longer refused; it is covered by its own regression below.
    });

    it("t-ee5c05: a canonical Grok fork gets its own projected home and the SOURCE session directory", async () => {
      const h = resumeHarness("agents:\n  grok:\n    cmd: grok\n", {
        fileExists: () => true,
        newSessionId: () => UUID,
        // Wired as Workspace wires it, so `runtimeConfigHome` resolves the SOURCE's private bridge
        // home rather than falling through to the operator's real `~/.grok`.
        materializeBridgeMcpGrok: (name: string) => bridgeGrokHome(h.ws, name),
      });
      const realGrokHome = path.join(h.ws, "real-grok-fork");
      fs.mkdirSync(realGrokHome, { recursive: true });
      fs.writeFileSync(path.join(realGrokHome, "auth.json"), '{"access_token":"external-only"}\n');
      const nativeConfig: ResolvedAgentNativeConfigProjection = {
        adapter: "grok",
        selectors: {},
        toml: { "models.default": "grok-4.5" },
      };
      const harness = new HarnessManager(
        h.ws, path.join(h.ws, "real-claude"), {}, path.join(h.ws, "real-claude", ".claude.json"),
        undefined, undefined, undefined, realGrokHome,
      );
      asAgent(h.manager.defOf("grok"))!.profileLifecycle = {
        enabled: true, agentId: "33333333-3333-4333-8333-333333333333", canonicalSha256: "d".repeat(64), authorityRevision: "r1",
      };
      asAgent(h.manager.defOf("grok"))!.profileNativeConfig = nativeConfig;
      (h.manager as unknown as { opts: AgentManagerOptions }).opts.materializeHarness = ({ name, def, cwd }) => {
        const home = harness.materializeBridgeMcpGrok(
          name,
          { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer ${TACHYON_BRIDGE_TOKEN}" } },
          cwd,
          { exactTrust: true, ...(def.profileNativeConfig ? { nativeConfig: def.profileNativeConfig } : {}) },
        );
        return { home, env: { GROK_HOME: home, HOME: home }, args: [] };
      };
      await h.manager.spawn("grok");

      // A Grok session is a DIRECTORY. Plant one in the source's private home, with a lock file and a
      // subdirectory that must not travel, and the two files measured as load-bearing on 0.2.112.
      const sourceHome = bridgeGrokHome(h.ws, "grok");
      const sessionDir = path.dirname(adapterFor("grok")!.transcriptPath!(sourceHome, h.ws, UUID));
      fs.mkdirSync(path.join(sessionDir, "recap_requests"), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), '{"role":"user"}\n');
      fs.writeFileSync(path.join(sessionDir, "summary.json"), '{"summary":"source"}\n');
      fs.writeFileSync(path.join(sessionDir, "updates.jsonl"), '{"update":1}\n');
      fs.writeFileSync(path.join(sessionDir, "summary.json.lock"), "");

      const forkName = await h.manager.commitFork(await h.manager.planFork("grok"));
      const forkHome = bridgeGrokHome(h.ws, forkName);
      expect(forkHome).not.toBe(sourceHome);

      // The fork's own private home carries the projection and the Bridge, not an empty Bridge-only file.
      const forkConfig = fs.readFileSync(path.join(forkHome, "config.toml"), "utf8");
      expect(forkConfig).toContain('default = "grok-4.5"');
      expect(forkConfig).toContain("[compat.claude]");
      expect(forkConfig).toContain("[mcp_servers.tachyon_bridge]");

      // The SOURCE session directory travelled — `summary.json` + `updates.jsonl` are what make the
      // session resolvable, so seeding only `transcriptPath` (chat_history.jsonl) would leave the fork
      // with a session the runtime reports as not found.
      const forkSessionDir = path.dirname(adapterFor("grok")!.transcriptPath!(forkHome, h.ws, UUID));
      const seeded = fs.readdirSync(forkSessionDir).sort();
      expect(seeded).toEqual(["chat_history.jsonl", "summary.json", "updates.jsonl"]);
      expect(fs.readFileSync(path.join(forkSessionDir, "summary.json"), "utf8")).toContain("source");

      // HOME is co-bound to the fork's own home, and the fork resumes the SOURCE id.
      const forkEnv = envFromTmuxArgs(h.startArgs.at(-1)!);
      expect(forkEnv.GROK_HOME).toBe(forkHome);
      expect(forkEnv.HOME).toBe(forkHome);
      expect(h.cmds.at(-1)).toContain(`--fork-session`);
      expect(h.cmds.at(-1)).toContain(UUID);
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
        instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
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

    it("codex Temporary: injects ownership-only SessionStart and bypasses hook trust for Tachyon's invocation", async () => {
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

    it("codex Temporary: resume keeps ownership-only hooks and bypasses hook trust", async () => {
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
        instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false },
        updatedAt: "t",
      });
      expect(cmds.at(-1)).toContain("resume codex-session-1");
      expect(cmds.at(-1)).toContain("-c 'hooks.SessionStart=[{hooks=[]}]'");
      expect(cmds.at(-1)).toContain("--dangerously-bypass-hook-trust");
      expect(calls).toEqual([{ name: "reviewer", ownershipOnly: true }]);
    });

    it("codex Temporary: a user -c config flag is not mistaken for self-managed session state", async () => {
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

    it("codex Temporary: prompt text mentioning the bypass flag still gets one real bypass argv", async () => {
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

    it("claude Temporary: injects ownership-only settings by the same runtime-neutral convention", async () => {
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

    it("t-84f0eb: projects an authored Grok mode, defaults delegated Grok to always-approve, and leaves top-level absent", async () => {
      const worktree = { path: "/wt/reader", branch: "tachyon/reader", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        resolveAgentPermissionProjection: (name: string, runtime: string) =>
          name === "reader" && runtime === "grok" ? { runtime: "grok", mode: "auto" } : undefined,
        resolveSpawnCwd: async (ctx) => ({ cwd: `/wt/${ctx.name}`, worktree: { ...worktree, path: `/wt/${ctx.name}` } }),
      });

      await manager.spawn("reader", { cmd: "grok", parent: "boss", worktree: true });
      expect(cmds.at(-1)).toContain("--permission-mode auto");

      await manager.spawn("unconfigured", { cmd: "grok", parent: "boss", worktree: true });
      expect(cmds.at(-1)).toContain("--always-approve");
      await manager.restart("unconfigured", { stop: "force", session: "new" });
      expect(cmds.at(-1)).toContain("--always-approve");

      await manager.spawn("top-level", { cmd: "grok" });
      expect(cmds.at(-1)).not.toContain("--permission-mode");
      expect(cmds.at(-1)).not.toContain("--always-approve");
    });

    it("t-84f0eb: refuses a named permission projection when the managed runtime is not covered", async () => {
      const { manager } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        resolveAgentPermissionProjection: (name: string) => name === "reader" ? { runtime: "grok", mode: "auto" } : undefined,
      });
      await expect(manager.spawn("reader", { cmd: "claude" })).rejects.toThrow(
        "agent 'reader': authored permission projection targets an unsupported runtime 'claude'",
      );
    });

    // t-aaa2c6 — the measured doors, as a behavioural guard. Fail-before on every assertion below:
    // before this change a delegated Codex child carried none of the three `-c` overrides and stopped
    // for a human click on the Bridge tool, on applying edits, and on `git add`/`git commit`.
    it("t-aaa2c6: opens all three measured Codex doors for a delegated child and leaves top-level/declared alone", async () => {
      const worktree = { path: "/wt/writer", branch: "tachyon/writer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n  declared:\n    cmd: codex\n", {
        resolveSpawnCwd: async (ctx) => ({ cwd: `/wt/${ctx.name}`, worktree: { ...worktree, path: `/wt/${ctx.name}` } }),
      });

      await manager.spawn("writer", { cmd: "codex", parent: "boss", worktree: true });
      const delegated = cmds.at(-1)!;
      expect(delegated).toContain(`-c 'approval_policy="never"'`);
      expect(delegated).toContain(`-c 'sandbox_mode="danger-full-access"'`);
      expect(delegated).toContain(`-c 'mcp_servers.tachyon_bridge.default_tools_approval_mode="approve"'`);

      // restart is the same actor arriving through another door; it must not silently drop the class default.
      await manager.restart("writer", { stop: "force", session: "new" });
      expect(cmds.at(-1)).toContain(`-c 'approval_policy="never"'`);
      expect(cmds.at(-1)).toContain(`-c 'mcp_servers.tachyon_bridge.default_tools_approval_mode="approve"'`);

      // A top-level Codex agent a human starts keeps Codex's own posture, unchanged.
      await manager.spawn("top-level-codex", { cmd: "codex" });
      expect(cmds.at(-1)).not.toContain("approval_policy");
      expect(cmds.at(-1)).not.toContain("sandbox_mode");
      expect(cmds.at(-1)).not.toContain("default_tools_approval_mode");

      // So does a DECLARED agent started from the config with no delegator above it.
      await manager.spawn("declared");
      expect(cmds.at(-1)).not.toContain("approval_policy");
      expect(cmds.at(-1)).not.toContain("sandbox_mode");
      expect(cmds.at(-1)).not.toContain("default_tools_approval_mode");
    });

    it("t-aaa2c6: never rewrites a Codex door the command or an authored profile already states", async () => {
      const worktree = { path: "/wt/x", branch: "tachyon/x", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        resolveSpawnCwd: async (ctx) => ({ cwd: `/wt/${ctx.name}`, worktree: { ...worktree, path: `/wt/${ctx.name}` } }),
      });

      // An explicit command wins per door: the stated sandbox stays, the unstated ones are opened.
      await manager.spawn("stated", { cmd: "codex --sandbox read-only", parent: "boss", worktree: true });
      const stated = cmds.at(-1)!;
      expect(stated).toContain("--sandbox read-only");
      expect(stated).not.toContain("sandbox_mode=");
      expect(stated).toContain(`-c 'approval_policy="never"'`);

      // One bypass token already closes the approval and sandbox doors; do not restate them.
      await manager.spawn("bypassed", { cmd: "codex --dangerously-bypass-approvals-and-sandbox", parent: "boss", worktree: true });
      expect(cmds.at(-1)).not.toContain("approval_policy=");
      expect(cmds.at(-1)).not.toContain("sandbox_mode=");
      expect(cmds.at(-1)).toContain(`-c 'mcp_servers.tachyon_bridge.default_tools_approval_mode="approve"'`);
    });

    it("t-aaa2c6: an authored codex projection overrides the class default, per door", async () => {
      const worktree = { path: "/wt/y", branch: "tachyon/y", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", {
        resolveAgentPermissionProjection: (name: string, runtime: string) =>
          name === "narrow" && runtime === "codex"
            ? { runtime: "codex", sandboxMode: "workspace-write", bridgeToolApproval: "prompt" }
            : undefined,
        resolveSpawnCwd: async (ctx) => ({ cwd: `/wt/${ctx.name}`, worktree: { ...worktree, path: `/wt/${ctx.name}` } }),
      });

      await manager.spawn("narrow", { cmd: "codex", parent: "boss", worktree: true });
      const narrow = cmds.at(-1)!;
      expect(narrow).toContain(`-c 'sandbox_mode="workspace-write"'`);
      expect(narrow).toContain(`-c 'mcp_servers.tachyon_bridge.default_tools_approval_mode="prompt"'`);
      // The authored entry is the whole statement — an unstated door is NOT filled from the class default.
      expect(narrow).not.toContain("approval_policy");
    });

    // t-171cb2 — directory trust is the fourth door. Fail-before: without exactTrustCwd on the
    // delegated materialize path, a new worktree path never lands in private config.toml and Codex
    // stops at "Do you trust the contents of this directory?" before any work.
    it("t-171cb2: delegated Codex gets exact-path trust for its worktree cwd; top-level/declared do not", async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-trustdir-"));
      dirs.push(base);
      const realHome = path.join(base, "realhome");
      const realCodexHome = path.join(base, "realcodex");
      fs.mkdirSync(realHome, { recursive: true });
      fs.mkdirSync(realCodexHome, { recursive: true });
      fs.writeFileSync(path.join(realCodexHome, "auth.json"), "{}");
      const ambientSibling = path.join(base, "ambient-sibling");
      fs.writeFileSync(path.join(realCodexHome, "config.toml"), [
        'model = "ambient-from-human"',
        "",
        `[projects.${JSON.stringify(ambientSibling)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"));

      let harnessMgr: HarnessManager;
      // Mirrors Workspace.ts: Temporary codex is auto-isolate:transcript; delegated passes exactTrustCwd.
      const materializeHarness = ({ name, def, cwd, delegated }: {
        name: string;
        def: { cmd: string; isolate?: string; profileLifecycle?: unknown; profileNativeConfig?: unknown };
        cwd: string;
        delegated?: boolean;
      }) => {
        const adapter = adapterFor(def.cmd);
        if (!harnessable(adapter) || !adapter) return null;
        if (adapter.runtime !== "codex") return null;
        if (def.isolate === "transcript") {
          return harnessMgr.materializeHomeOnly(name, adapter, cwd, {
            ...(delegated ? { exactTrustCwd: cwd } : {}),
          });
        }
        return harnessMgr.materializeHomeOnly(name, adapter, cwd, {
          inheritNativeConfig: def.profileLifecycle === undefined,
          ...(delegated ? { exactTrustCwd: cwd } : {}),
        });
      };

      const worktreePath = (name: string) => path.join(base, "wt", name);
      const { manager, ws } = resumeHarness(
        "agents:\n  boss:\n    cmd: claude\n  declared:\n    cmd: codex\n",
        {
          materializeHarness: materializeHarness as never,
          resolveSpawnCwd: async (ctx: { name: string }) => {
            const p = worktreePath(ctx.name);
            fs.mkdirSync(p, { recursive: true });
            return {
              cwd: p,
              worktree: { path: p, branch: `tachyon/${ctx.name}`, tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" },
            };
          },
        },
      );
      harnessMgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"), realCodexHome);

      await manager.spawn("writer", { cmd: "codex", parent: "boss", worktree: true });
      const delegatedToml = fs.readFileSync(path.join(harnessHome(ws, "writer"), "config.toml"), "utf8");
      const writerCwd = worktreePath("writer");
      expect(delegatedToml).toContain(`[projects.${JSON.stringify(path.resolve(ws))}]\ntrust_level = "trusted"`);
      expect(delegatedToml).toContain(`[projects.${JSON.stringify(path.resolve(writerCwd))}]\ntrust_level = "trusted"`);
      expect(delegatedToml).not.toContain(JSON.stringify(ambientSibling));
      expect(delegatedToml).toContain("ambient-from-human");

      // restart is the same actor arriving through another door — trust must be re-written.
      await manager.restart("writer", { stop: "force", session: "new" });
      const afterRestart = fs.readFileSync(path.join(harnessHome(ws, "writer"), "config.toml"), "utf8");
      expect(afterRestart).toContain(`[projects.${JSON.stringify(path.resolve(writerCwd))}]\ntrust_level = "trusted"`);

      // Top-level Temporary Codex keeps today's seed: ambient projects stay, no auto worktree trust.
      await manager.spawn("top-level-codex", { cmd: "codex" });
      const topToml = fs.readFileSync(path.join(harnessHome(ws, "top-level-codex"), "config.toml"), "utf8");
      expect(topToml).toContain(JSON.stringify(ambientSibling));
      expect(topToml).not.toContain(JSON.stringify(path.resolve(worktreePath("top-level-codex"))));

      // Declared agent without a parent: same as today.
      await manager.spawn("declared");
      const declaredToml = fs.readFileSync(path.join(harnessHome(ws, "declared"), "config.toml"), "utf8");
      expect(declaredToml).toContain(JSON.stringify(ambientSibling));
      expect(declaredToml).not.toContain(JSON.stringify(path.resolve(worktreePath("declared"))));
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

    it("claude Temporary: does not override an explicit permission mode", async () => {
      const { manager, cmds } = resumeHarness("agents:\n  boss:\n    cmd: claude\n", OWN());
      await manager.spawn("reviewer", { cmd: "claude --permission-mode manual", parent: "boss" });
      expect(cmds.at(-1)).toContain("--settings '/ws/.tachyon/spawn-settings/reviewer.json'");
      expect(cmds.at(-1)).toContain("--permission-mode manual");
      expect(cmds.at(-1)).not.toContain("--permission-mode auto");
    });

    it("t-4e286c: claude Temporary with bypassPermissions is born with Tachyon settings and no auto downgrade", async () => {
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
  it("converges a captured canonical live rename idempotently across tmux, ledger, lineage and activity", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-canonical-live-rename-"));
    try {
      const ledger = new SessionLedger(dir);
      ledger.record("reviewer", { resume: { runtime: "codex", sessionId: "session-1" }, cwd: dir, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
      ledger.record("child", { def: { cmd: "sh", kind: "terminal", parent: "reviewer", delegator: "reviewer" }, cwd: dir, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
      const fake = fakeTmux();
      const hash = workspaceHash(dir);
      fake.sessions.add(`tachyon-${hash}-reviewer`);
      const activityDir = path.join(dir, ".tachyon", "activity");
      fs.mkdirSync(activityDir, { recursive: true });
      fs.writeFileSync(path.join(activityDir, `${agentLogId("reviewer")}.jsonl`), "event\n");
      const manager = new AgentManager({
        tmux: fake.tmux,
        wsHash: hash,
        workspaceRoot: dir,
        ledger,
        getConfig: () => configOf("agents:\n  reviewer:\n    cmd: codex\n"),
      });
      await manager.rehydrateFromLedger();
      const snapshot = await manager.prepareAgentProfileRename("reviewer", "maintainer");
      fs.appendFileSync(path.join(activityDir, `${agentLogId("reviewer")}.jsonl`), "late event\n");

      await manager.convergeAgentProfileRename("reviewer", "maintainer", snapshot);
      await manager.convergeAgentProfileRename("reviewer", "maintainer", snapshot);

      expect(fake.sessions.has(`tachyon-${hash}-reviewer`)).toBe(false);
      expect(fake.sessions.has(`tachyon-${hash}-maintainer`)).toBe(true);
      expect(ledger.get("reviewer")).toBeUndefined();
      expect(ledger.get("maintainer")?.resume?.sessionId).toBe("session-1");
      expect(ledger.get("child")?.def).toMatchObject({ parent: "maintainer", delegator: "maintainer" });
      expect((await manager.list()).find((agent) => agent.name === "child")?.parent).toBe("maintainer");
      expect(fs.existsSync(path.join(activityDir, `${agentLogId("reviewer")}.jsonl`))).toBe(false);
      expect(fs.readFileSync(path.join(activityDir, `${agentLogId("maintainer")}.jsonl`), "utf8")).toBe("event\nlate event\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acknowledges tmux rename success when the command result is lost", async () => {
    const { manager, sessions } = makeManager("agents:\n  reviewer:\n    cmd: codex\n");
    await manager.spawn("reviewer");
    const snapshot = await manager.prepareAgentProfileRename("reviewer", "maintainer");
    const oldSession = manager.session("reviewer");
    const newSession = manager.session("maintainer");
    vi.spyOn((manager as unknown as { opts: { tmux: TmuxService } }).opts.tmux, "renameSession").mockImplementationOnce(async () => {
      sessions.delete(oldSession);
      sessions.add(newSession);
      throw new Error("lost result");
    });
    await expect(manager.convergeAgentProfileRename("reviewer", "maintainer", snapshot)).resolves.toBeUndefined();
    expect(sessions.has(oldSession)).toBe(false);
    expect(sessions.has(newSession)).toBe(true);
  });

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
    await manager.spawn("worker", { cmd: "opencode", parent: "claude" });
    await manager.rename("claude", "ace");
    const worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("ace");
  });

  /**
   * t-eb4b30 — spec 211 for the SWEEP, which never had it.
   *
   * `kill()` removes a Temporary's ledger row precisely so it does not come back as a permanent
   * stopped entry. `killAll()` deleted the in-memory map entry and left the row, so the name vanished
   * from `list()` and returned on the next activation. Measured on the pre-change tree, which is why
   * this is a fix and not a consequence of collapsing the store: the collapse removed the mask.
   */
  it("killAll does not resurrect a Temporary agent on the next rehydrate (spec 211)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sweep-211-"));
    try {
      const ledger = new SessionLedger(dir);
      const { tmux } = fakeTmux();
      const manager = new AgentManager({
        tmux, wsHash: HASH, workspaceRoot: dir, ledger,
        getConfig: () => configOf("agents:\n  keeper:\n    cmd: claude\n"),
        launchPreflight: HERMETIC_PREFLIGHT,
      });
      await manager.spawn("temp1", { cmd: "claude" });
      expect((await manager.list()).map((a) => a.name)).toEqual(["keeper", "temp1"]);

      expect(await manager.killAll()).toEqual(["temp1"]);
      // The durable half: the row goes with the sweep, exactly as `kill()` does it.
      expect(ledger.get("temp1")).toBeUndefined();

      await manager.rehydrateFromLedger();
      // Before the fix this returned ["keeper", "temp1"] — the row survived and rehydrate read it back.
      expect((await manager.list()).map((a) => a.name)).toEqual(["keeper"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  /** A fork is PERSISTENT (spec 225): the sweep must NOT take its row, same exception `kill()` makes. */
  it("killAll keeps a forked sibling's row, so it stays listed and resumable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-sweep-fork-"));
    try {
      const ledger = new SessionLedger(dir);
      const { tmux, sessions } = fakeTmux();
      const manager = new AgentManager({
        tmux, wsHash: HASH, workspaceRoot: dir, ledger,
        getConfig: () => configOf("agents:\n  keeper:\n    cmd: claude\n"),
        launchPreflight: HERMETIC_PREFLIGHT,
      });
      await manager.spawn("sibling", { cmd: "claude" });
      const row = ledger.get("sibling")!;
      ledger.record("sibling", { ...row, def: { ...row.def!, fork: true } });
      sessions.add(manager.session("sibling"));

      await manager.killAll();

      expect(ledger.get("sibling")?.def?.fork).toBe(true);
      await manager.rehydrateFromLedger();
      expect((await manager.list()).map((a) => a.name)).toContain("sibling");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("a Temporary agent keeps its definition across rename (restart still works)", async () => {
    // t-eb4b30 — this needs a LEDGER now, and that is the point rather than a fixture chore: a
    // Temporary's definition is its ledger row, so the rename carries it by moving the row's key
    // (`renameExact`) instead of by moving an entry between keys of a second in-memory map. The
    // behaviour asserted here is unchanged; what changed is that only one thing had to move.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-temporary-rename-"));
    try {
      const ledger = new SessionLedger(dir);
      const { tmux, sessions } = fakeTmux();
      const manager = new AgentManager({
        tmux,
        wsHash: HASH,
        workspaceRoot: dir,
        getConfig: () => configOf("agents:\n  decoy:\n    cmd: x\n"),
        ledger,
        launchPreflight: HERMETIC_PREFLIGHT,
      });
      await manager.spawn("ghost", { cmd: "claude" });
      await manager.rename("ghost", "spirit");
      await manager.restart("spirit", { stop: "force", session: "new" }); // needs the moved definition
      expect(sessions.has(`tachyon-${HASH}-spirit`)).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("moves the resume-ledger record to the new name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-rename-"));
    try {
      const ledger = new SessionLedger(dir);
      ledger.record("claude", { def: { cmd: "claude", kind: "agent" }, resume: { runtime: "claude", sessionId: "abc" }, cwd: dir, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
      const { tmux } = fakeTmux();
      const manager = new AgentManager({
        tmux,
        wsHash: HASH,
        workspaceRoot: dir,
        getConfig: () => configOf("agents:\n  claude:\n    cmd: claude\n"),
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

describe("AgentManager — Temporary persistence (spec 211)", () => {
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
      ledger,
      launchPreflight: HERMETIC_PREFLIGHT,
      ...extra,
    });
    dirs.push(ws);
    return { manager, ledger, sessions, cmds, newSessionArgs, tmux, ws };
  }

  it("t-8168a7: list() exposes Attention's real-turn fact instead of boot readiness", async () => {
    const h = harness("agents:\n  reviewer:\n    cmd: claude\n", {
      hasStartedTurn: (name) => name === "reviewer",
    });

    expect((await h.manager.list()).find((entry) => entry.name === "reviewer")?.hasStartedTurn).toBe(true);
  });

  it("t-8168a7 review: list() preserves unknown instead of asserting never-started after reload", async () => {
    const h = harness("agents:\n  reviewer:\n    cmd: claude\n", {
      hasStartedTurn: () => undefined,
    });

    expect((await h.manager.list()).find((entry) => entry.name === "reviewer")?.hasStartedTurn).toBeUndefined();
  });

  it("persists a delegator at spawn and restores that display lineage after a host reload (t-bae303)", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n  reviewer:\n    cmd: claude\n");

    // The Bridge supplies `delegator` for a delegated launch. It is deliberately distinct from the
    // runtime parent edge, but it must survive the manager instance that accepted the launch.
    await h.manager.spawn("reviewer", { delegator: "boss" });
    expect(h.ledger.get("reviewer")?.def).toMatchObject({ delegator: "boss" });

    // A new manager has no in-memory delegator map. The durable ledger is the only input that can
    // put the reviewer back beneath its delegator in the sidebar and in later primer rendering.
    const reloaded = new AgentManager({
      tmux: h.tmux,
      wsHash: workspaceHash(h.ws),
      workspaceRoot: h.ws,
      getConfig: () => configOf("agents:\n  boss:\n    cmd: claude\n  reviewer:\n    cmd: claude\n"),
      ledger: h.ledger,
    });
    await reloaded.rehydrateFromLedger();

    expect(reloaded.delegatorOf("reviewer")).toBe("boss");
    expect((await reloaded.list()).find((entry) => entry.name === "reviewer")?.delegator).toBe("boss");
  });

  it("SDD 370 fails delegated explicit models closed when the runtime has no catalog adapter", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");

    // t-85c586 moved grok OUT of this case (it has an authoritative adapter now), so the property is
    // asserted on a runtime that still has none — the point was never grok, it was "no catalog".
    // t-0338fc gave opencode an adapter, but a CREDENTIAL one: it deliberately still answers the model
    // question with `unverifiable`, so a pin fails closed here exactly as it did before it existed.
    await expect(h.manager.spawn("oc-child", { cmd: "opencode --model some-model" })).rejects.toMatchObject({
      code: "runtime_preflight_unverifiable",
    });
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("oc-child")).toBeUndefined();
  });

  it("t-8f3f7d refuses a generic Temporary AGENT at the manager, not only at the Bridge", async () => {
    // Defence in depth: the Bridge produces the friendly refusal, but the manager serves several doors
    // and the invariant is the manager's, not any one door's discretion.
    const h = harness("agents:\n  boss:\n    cmd: claude\n");
    await expect(h.manager.spawn("shelly", { cmd: "sh", kind: "agent" })).rejects.toMatchObject({
      code: "agent_runtime_unsupported",
    });
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("shelly")).toBeUndefined();
  });

  it("t-8f3f7d treats an omitted kind as the STRICT arm, so a forgetful caller never gets a silent terminal", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");
    await expect(h.manager.spawn("forgot", { cmd: "npm run dev" })).rejects.toMatchObject({
      code: "agent_runtime_unsupported",
    });
    expect(h.sessions.size).toBe(0);
  });

  it("t-8f3f7d builds a declared terminal on the Terminal arm, with no agent capability to hand it", async () => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");
    await h.manager.spawn("devserver", { cmd: "npm run dev", kind: "terminal" });
    expect(h.manager.kindOf("devserver")).toBe("terminal");
    const def = h.manager.defOf("devserver")!;
    expect(def.kind).toBe("terminal");
    // asAgent is the ONLY way to reach an agent-only field, and it refuses this arm outright.
    expect(asAgent(def)).toBeUndefined();
  });

  it("t-8f3f7d reads a Temporary entry's kind back on restart instead of recomputing it", async () => {
    // The M4 property, now exercised through the M9 door: a stored terminal stays a terminal across a
    // relaunch even though its command would never be admitted as an agent.
    const h = harness("agents:\n  boss:\n    cmd: claude\n");
    await h.manager.spawn("devserver", { cmd: "npm run dev", kind: "terminal" });
    await h.manager.restart("devserver", { stop: "force", session: "new" });
    expect(h.manager.kindOf("devserver")).toBe("terminal");
    expect(h.sessions.has(h.manager.session("devserver"))).toBe(true);
  });

  it("t-0338fc refuses an opencode launch whose credential store is empty, and tells the human why", async () => {
    // The measured hazard: without this gate the spawn SUCCEEDS and the agent answers on `big-pickle`,
    // so the failure everyone sees is not a failure at all. Refused with no model pinned — the silent
    // fallback is specific to the unpinned default path, which is how Tachyon launches opencode.
    const notices: Array<{ text: string; level?: string }> = [];
    const h = harness("agents:\n  boss:\n    cmd: claude\n", {
      notify: (text, level) => { notices.push({ text, ...(level ? { level } : {}) }); },
      launchPreflight: hermeticLaunchPreflight("┌  Credentials /p/auth.json\n│\n└  0 credentials\n"),
    });

    await expect(h.manager.spawn("oc-child", { cmd: "opencode" })).rejects.toMatchObject({
      code: "runtime_auth_unavailable",
    });
    expect(h.sessions.size).toBe(0);
    expect(h.ledger.get("oc-child")).toBeUndefined();
    expect(notices).toEqual([{
      text: "agent 'oc-child' cannot run: the opencode runtime reports it is not authenticated"
        + " — run `opencode providers login` (or set a provider API key in the agent's environment), then launch the agent again."
        + " Tachyon will not retry or restart it automatically.",
      level: "warn",
    }]);
  });

  it("t-85c586 admits a grok pin the catalog lists and refuses one it does not", async () => {
    // The adapter is injected with a stubbed probe: the verdicts belong to Tachyon's logic, and the
    // real-CLI agreement is the dogfood's job, so this stays deterministic off-machine.
    const catalog = ["You are logged in with grok.com.", "", "Available models:", "  * grok-4.5 (default)"].join("\n");
    const launchPreflight = new RuntimeLaunchPreflightRegistry({
      grok: new GrokLaunchPreflight(async () => ({ code: 0, text: catalog })),
    });

    const ok = harness("agents:\n  boss:\n    cmd: claude\n", { launchPreflight });
    await ok.manager.spawn("grok-ok", { cmd: "grok --model grok-4.5" });
    expect(ok.ledger.get("grok-ok")).toBeDefined();

    const bad = harness("agents:\n  boss:\n    cmd: claude\n", { launchPreflight });
    await expect(bad.manager.spawn("grok-bad", { cmd: "grok --model grok-4.5-build" })).rejects.toMatchObject({
      code: "runtime_model_unavailable",
    });
    expect(bad.sessions.size).toBe(0);
    expect(bad.ledger.get("grok-bad")).toBeUndefined();
  });

  it.each(["sonnet", "claude-sonnet-5"])("delegated Claude explicit model %s enters bounded startup validation", async (model) => {
    const h = harness("agents:\n  boss:\n    cmd: claude\n");

    await expect(h.manager.spawn("claude-child", { cmd: `claude --model ${model}` })).resolves.toBeUndefined();
    expect(h.sessions.has(h.manager.session("claude-child"))).toBe(true);
    expect(h.ledger.get("claude-child")).toMatchObject({
      instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false },
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

  it("t-d501fc: the REAL classify pipeline rejects a spawn against Claude's measured refusal pane, not a stubbed one", async () => {
    // The test above stubs `launchReadiness.wait` and so proves nothing about whether the actual
    // classify() regex recognizes a real Claude pane — that stub is the exact gap the incident fell
    // into. This one runs the production `GenericLaunchReadiness` against the real Claude composer
    // profile and a pane captured verbatim from the incident: the CLI never exits, it settles at its
    // ordinary empty `❯ ` composer right under the refusal, which is what made "ready" look plausible.
    const fake = fakeTmux();
    const h = harness("agents:\n  boss:\n    cmd: claude\n", { tmux: fake.tmux });
    const session = sessionName(workspaceHash(h.ws), "claude-child");
    fake.panes.set(session, [
      "There's an issue with the selected model (sonnet-5). It may not exist or you may not have",
      "access to it. Run /model to pick a different model.",
      "",
      "❯ ",
    ].join("\n"));

    await expect(h.manager.spawn("claude-child", { cmd: "claude --model sonnet-5" })).rejects.toMatchObject({
      code: "runtime_model_rejected",
    });
    expect(fake.sessions.has(session)).toBe(false);
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

  /**
   * t-5e1113 (SDD 482, decision 5) — the INTENT is unchanged and still the point of this test: a stale
   * row must not re-nest an agent that is running top-level. What changed is the mechanism. The parent
   * used to be erased from the row on write; now it is retained (Saved lineage is durable) and the
   * instance bound is what refuses it — this process started `child` without a parent, so its lineage
   * is settled and a row describing an earlier instance cannot override it.
   */
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
    // The row KEEPS its parent now — durability is the decision; the instance bound is the refusal.
    expect(ledger.get("child")?.def?.parent).toBe("boss");
    expect(await manager.liveDescendants("boss")).toEqual([]);
  });

  it("rehydrates Saved lineage without conflating it with declared ownership", async () => {
    const { manager, ledger, ws } = harness("agents:\n  claude:\n    cmd: claude\n    subagents: [reviewer]\n  codex:\n    cmd: codex\n  reviewer:\n    cmd: claude\n");
    ledger.record("reviewer", { def: { cmd: "claude", kind: "agent", parent: "codex" }, cwd: ws, instance: { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true } });
    await manager.rehydrateFromLedger();
    const reviewer = (await manager.list()).find((a) => a.name === "reviewer");
    expect(reviewer?.declaredOwner).toBe("claude");
    expect(reviewer?.parent).toBe("codex");
    expect(manager.parentOf("reviewer")).toBe("codex");
    expect(await manager.liveDescendants("claude")).toEqual([]);
    // The pane is not live in this reload fixture, so the safety query has no live descendant.
    expect(await manager.liveDescendants("codex")).toEqual([]);
  });

  it("records the explicit parent for a Saved non-adapter instance", async () => {
    const { manager, ledger } = harness("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: sh\n");
    await manager.spawn("child", { parent: "boss" });
    expect(manager.parentOf("child")).toBe("boss");
    expect((await manager.list()).find((entry) => entry.name === "child")?.parent).toBe("boss");
    expect(ledger.get("child")?.def?.parent).toBe("boss");
  });

  it("keeps a stopped Temporary worktree child's parent in the listing", async () => {
    const worktree = { path: "/wt/child", branch: "tachyon/child", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t" };
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => ({ cwd: worktree.path, worktree }),
    });
    await manager.spawn("child", { cmd: "codex", parent: "boss" });

    await manager.kill("child");

    expect((await manager.list()).find((entry) => entry.name === "child")).toMatchObject({
      lifetime: "temporary",
      running: false,
      parent: "boss",
    });
  });

  it("does not carry a stopped instance's parent into a reused top-level name", async () => {
    const { manager } = harness("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: sh\n");
    await manager.spawn("child", { parent: "boss" });
    await manager.kill("child");

    await manager.spawn("child");

    expect(manager.parentOf("child")).toBeUndefined();
    expect((await manager.list()).find((entry) => entry.name === "child")?.parent).toBeUndefined();
  });

  it("Saved spawn/restart preserves explicit runtime lineage separately from declaredOwner", async () => {
    const { manager, ledger, cmds } = harness(
      "agents:\n  codex:\n    cmd: claude\n    subagents: [reviewer]\n  reviewer:\n    cmd: claude\n",
    );
    await manager.spawn("reviewer", { parent: "codex" });
    expect((await manager.list()).find((a) => a.name === "reviewer")).toMatchObject({
      parent: "codex",
      declaredOwner: "codex",
      lifetime: "saved",
    });
    expect(manager.parentOf("reviewer")).toBe("codex");
    expect(ledger.get("reviewer")?.def?.parent).toBe("codex");
    // Primer is embedded in the spawn command payload for claude.
    expect(cmds.some((c) => c.includes("spawned by \"codex\""))).toBe(true);
    expect(cmds.some((c) => c.includes("no delegator/parent on record"))).toBe(false);

    await manager.restart("reviewer", { stop: "force", session: "new" });
    expect(manager.parentOf("reviewer")).toBe("codex");
    expect((await manager.list()).find((a) => a.name === "reviewer")?.parent).toBe("codex");
    expect(ledger.get("reviewer")?.def?.parent).toBe("codex");
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

  it("t-f660d8: parented Temporary with explicit cwd fails closed", async () => {
    const { manager, ws } = harness("agents:\n  boss:\n    cmd: claude\n");
    await manager.spawn("boss");
    const other = path.join(ws, "other");
    fs.mkdirSync(other, { recursive: true });
    await expect(
      manager.spawn("kid", { cmd: "opencode", parent: "boss", cwd: other }),
    ).rejects.toThrow(PARENT_CWD_REFUSAL);
  });

  it("t-f660d8: missing spawn cwd fails closed", async () => {
    const { manager, ws } = harness("agents:\n  reviewer:\n    cmd: sh\n");
    await expect(
      manager.spawn("reviewer", { cwd: path.join(ws, "does-not-exist") }),
    ).rejects.toThrow(/not an existing directory/i);
  });

  /**
   * t-da80ed — the resolver's answer overrides the cwd resolved from the profile, unconditionally.
   * It could not see the declaration it was overriding, so a `workspace.cwd` an agent declared was
   * discarded with nothing able to report the loss. Handing it over is what lets the discard be
   * named; the precedence itself is unchanged.
   */
  it("t-da80ed: hands the resolver the declared cwd it is about to override — spawn and restart", async () => {
    const seen: (string | undefined)[] = [];
    const { manager, ws } = harness("agents:\n  reviewer:\n    cmd: claude\n    cwd: packages/api\n", {
      resolveSpawnCwd: async (ctx) => {
        seen.push(ctx.declaredCwd);
        return null;
      },
    });
    fs.mkdirSync(path.join(ws, "packages", "api"), { recursive: true });

    await manager.spawn("reviewer");
    await manager.restart("reviewer", { stop: "force", session: "new" });

    expect(seen).toEqual([
      path.join(ws, "packages", "api"),
      path.join(ws, "packages", "api"),
    ]);
  });

  it("t-da80ed: an agent that declares no cwd hands over nothing (the root is not a declaration)", async () => {
    // `resolveCwd` answers the workspace root for a blank cwd, so passing the resolved value blindly
    // would make every ordinary agent look like it had asked for the root.
    const seen: (string | undefined)[] = [];
    const { manager } = harness("agents:\n  reviewer:\n    cmd: claude\n", {
      resolveSpawnCwd: async (ctx) => {
        seen.push(ctx.declaredCwd);
        return null;
      },
    });

    await manager.spawn("reviewer");

    expect(seen).toEqual([undefined]);
  });

  it("rehydrate restores worktree:true so restart's resolver reuses the worktree (review fix)", async () => {
    const REC = { path: "/wt/h/w", branch: "tachyon/w", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    let seenWorktree: boolean | undefined;
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n", {
      resolveSpawnCwd: async (ctx) => {
        seenWorktree = asAgent(ctx.def)?.worktree;
        return null;
      },
    });
    ledger.record("w", { def: { cmd: "claude", kind: "agent" }, worktree: REC, cwd: REC.path, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    await manager.rehydrateFromLedger();
    void ws;
    await manager.restart("w", { stop: "force", session: "new" });
    expect(seenWorktree).toBe(true);
  });

  it("records the worktree for a declared NON-adapter agent (fix: was gated on temporary||adapter)", async () => {
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
    // SDD 478 M6 — a worktree is an Agent capability, so `kind: terminal` + `worktree: true` is now
    // refused. This case is about restart quarantine and the durable worktree ledger, which is agent
    // lifecycle; declaring the runtime name is the ratified headless double (tmux is faked here).
    const h = harness("agents:\n  dev:\n    cmd: claude\n    worktree: true\n", {
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

  // t-d29398 — the owner's measured launch: `git worktree add --lock` succeeds, preparation then fails
  // on a missing credential, and what he met on the SECOND attempt was the first attempt's own lock.
  it("compensates the fresh checkout it created when preparation fails, and says it discarded it", async () => {
    const REC = { path: "/wt/h/grok", branch: "tachyon/grok", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const rolledBack: unknown[][] = [];
    const notices: Array<{ message: string; level: string }> = [];
    const h = harness("agents:\n  grok:\n    cmd: grok\n    worktree: true\n", {
      resolveSpawnCwd: async () => ({
        cwd: REC.path,
        worktree: REC,
        created: true,
        preparationLocked: true,
        rollbackHeadSha: "b",
        preparationHeadBefore: "b",
        preparationHeadAfter: "b",
      }),
      // The discard succeeds, so this resolves — which is the whole behavioural change: it used to
      // throw "recovery state was preserved" for every failure, debris or not.
      rollbackPreparedWorktree: async (...args) => { rolledBack.push(args); },
      mintAgentToken: () => { throw new Error("no credentials at ~/.grok/auth.json — run grok login first"); },
      notify: (message, level) => { notices.push({ message, level }); },
    });

    const failure = await h.manager.spawn("grok").catch((error: unknown) => error);

    // The human is left holding the ACTIONABLE cause, not a second failure about preserved state.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("run grok login first");
    // Compensation ran on the created path — that flag is the measured distinction between this
    // attempt's debris and a checkout that already existed.
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0]?.[0]).toEqual(REC);
    expect(rolledBack[0]?.[4]).toBe(true);
    // And a directory Tachyon deleted is a directory Tachyon says it deleted.
    expect(notices.map((n) => n.message).join("\n")).toContain("discarded (/wt/h/grok)");
  });

  it("still reports a preserved checkout when the discard itself is refused", async () => {
    const REC = { path: "/wt/h/grok", branch: "tachyon/grok", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };
    const h = harness("agents:\n  grok:\n    cmd: grok\n    worktree: true\n", {
      resolveSpawnCwd: async () => ({
        cwd: REC.path,
        worktree: REC,
        created: true,
        preparationLocked: true,
        rollbackHeadSha: "b",
        preparationHeadBefore: "b",
        preparationHeadAfter: "b",
      }),
      rollbackPreparedWorktree: async () => {
        throw new Error("fresh worktree recovery state was preserved at /wt/h/grok: it contains modified or untracked files");
      },
      mintAgentToken: () => { throw new Error("no credentials at ~/.grok/auth.json — run grok login first"); },
    });

    const failure = await h.manager.spawn("grok").catch((error: unknown) => error);

    // Preservation is still a real outcome, and it still carries BOTH facts: what failed, and that
    // something is being kept. What changed is that it is no longer the only outcome.
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("run grok login first");
    expect((failure as Error).message).toContain("its worktree recovery state was preserved");
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
    ledger.record("rev", { def: { cmd: "opencode", kind: "agent" }, worktree: REC, cwd: REC.path, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    await expect(manager.spawn("helper", { cmd: "opencode", parent: "boss", cwd: REC.path }))
      .rejects.toThrow(PARENT_CWD_REFUSAL);
    expect(newSessionArgs).toHaveLength(0);
  });

  it("t-e2ebe3: parented opencode spawn delegates without requiring isolated worktree", async () => {
    const { manager, newSessionArgs } = harness("agents:\n  boss:\n    cmd: claude\n", {
      resolveSpawnCwd: async () => null,
    });
    // Parented Temporary children inherit the parent cwd — omit opts.cwd (product fails closed on explicit cwd).
    await manager.spawn("helper", { cmd: "opencode", parent: "boss" });
    expect(newSessionArgs).toHaveLength(1);
  });





  /**
   * t-55d4d0 — a deliberate preservation is a receipt, not a compensation failure.
   *
   * Both failed-launch compensators pushed their "recovery state was preserved" note into the same
   * list as real cleanup faults, and then keyed the verdict on that list being non-empty. So on the
   * paths where compensation had COMPLETELY succeeded, the operator was still told it was incomplete
   * (measured 2026-07-27 on a runtime_auth_rejected spawn) and could not tell "intervene, state is
   * unaccounted for" from "this checkout was kept on purpose".
   */
  describe("t-55d4d0 compensation receipts are not compensation failures", () => {
    const REC = { path: "/wt/h/reviewer", branch: "tachyon/reviewer", tachyonCreatedBranch: true, baseRef: "b", createdAt: "t" };

    /** tmux that refuses to create a session and reports none afterwards (compensation can complete). */
    function newSessionFails(): TmuxService {
      return new TmuxService(async (args: string[]): Promise<ExecResult> => {
        if (args.includes("new-session")) throw new Error("injected newSession failure");
        if (args[2] === "has-session") throw new Error("none");
        if (args[2] === "list-sessions") throw new Error("no server running");
        if (args[2] === "list-panes") throw new Error("no server running");
        return { stdout: "", stderr: "" };
      });
    }

    describe("session creation", () => {
      it("reports a withheld rollback as completed compensation, naming what was preserved", async () => {
        // No exact prepared HEAD to roll back TO — withholding is the safe choice, not a fault.
        const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
          tmux: newSessionFails(),
          resolveSpawnCwd: async () => ({ cwd: REC.path, worktree: REC, created: true }),
          rollbackPreparedWorktree: async () => { throw new Error("must not roll back without a prepared HEAD"); },
        });

        const failure = await manager.spawn("reviewer", { cmd: "claude" }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        const agg = failure as AggregateError;
        expect(agg.message).not.toContain("compensation was incomplete");
        expect(agg.message).toContain("compensation completed and recovery state was preserved for inspection");
        expect(agg.errors[0]).toMatchObject({ message: "injected newSession failure" });
        expect(agg.errors.map((entry: Error) => entry.message).join("\n"))
          .toContain("worktree recovery state was preserved deliberately");
      });

      it("still reports incomplete compensation when the rollback itself fails", async () => {
        const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
          tmux: newSessionFails(),
          resolveSpawnCwd: async () => ({
            cwd: REC.path, worktree: REC, preparationHeadBefore: "before", preparationHeadAfter: "after",
          }),
          rollbackPreparedWorktree: async () => { throw new Error("rollback exploded"); },
        });

        const failure = await manager.spawn("reviewer", { cmd: "claude" }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        const agg = failure as AggregateError;
        expect(agg.message).toContain("compensation was incomplete");
        expect(agg.errors.map((entry: Error) => entry.message).join("\n"))
          .toContain("instead of automatic cleanup");
      });

      it("leaves a fully-compensated launch throwing its original error alone", async () => {
        const rolledBack: string[] = [];
        const { manager } = harness("agents:\n  boss:\n    cmd: claude\n", {
          tmux: newSessionFails(),
          resolveSpawnCwd: async () => ({
            cwd: REC.path, worktree: REC, preparationHeadBefore: "before", preparationHeadAfter: "after",
          }),
          rollbackPreparedWorktree: async () => { rolledBack.push(REC.path); },
        });

        const failure = await manager.spawn("reviewer", { cmd: "claude" }).catch((error: unknown) => error);

        expect(rolledBack).toEqual([REC.path]);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect((failure as Error).message).toBe("injected newSession failure");
      });
    });
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


  it("rehydrates a re-discovered Temporary agent so it is restartable + re-nested", async () => {
    const { manager, ledger, ws, cmds } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("worker", { def: { cmd: "sh", kind: "terminal", parent: "claude" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    await manager.rehydrateFromLedger();
    const worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("claude"); // lineage restored
    await manager.restart("worker", { stop: "force", session: "new" }); // would throw "no stored definition" without rehydrate
    expect(cmds.at(-1)).toBe("sh");
  });

  it("does NOT rehydrate a name that is declared in config (no Temporary shadow)", async () => {
    const { manager, ledger, ws } = harness("agents:\n  claude:\n    cmd: claude\n");
    ledger.record("claude", { def: { cmd: "sh", kind: "terminal" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } }); // stale/odd
    await manager.rehydrateFromLedger();
    const claude = (await manager.list()).find((a) => a.name === "claude");
    expect(claude?.lifetime).toBe("saved"); // config wins, not the ledger shadow
  });

  it("kill removes a Temporary agent's ledger row (no resurrection); keeps a declared one's", async () => {
    const { manager, ledger } = harness("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("scratch", { cmd: "claude" }); // Temporary → recorded
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
      expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({
        running: true,
        stopFailed: true,
        // t-b103c5 — stage, measured reason, next deliberate action
        stopFailure: {
          stage: "await-exit",
          reason: "process still alive after graceful key sequence",
          nextAction: "Kill forced",
        },
      });
      expect((await manager.list()).find((a) => a.name === "a")).not.toMatchObject({ stopping: true });

      await manager.stopGracefully("a");
      expect(sentKeys).toHaveLength(6);
      expect((await manager.list()).find((a) => a.name === "a")).toMatchObject({ running: true, stopping: true });
      expect((await manager.list()).find((a) => a.name === "a")).not.toMatchObject({ stopFailed: true });
      expect((await manager.list()).find((a) => a.name === "a")?.stopFailure).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it("t-b103c5: Grok graceful stop uses delayed if-alive C-c so auth-prompt cancel does not swallow exit", async () => {
    const { manager, sentKeys } = makeManager("agents:\n  grok:\n    cmd: grok\n");
    await manager.spawn("grok");
    await manager.stopGracefully("grok");
    // First C-c is immediate (cancel tool-auth or first interrupt); the next two only fire while alive.
    expect(sentKeys).toEqual([
      { session: `tachyon-${HASH}-grok`, key: "C-c" },
      { session: `tachyon-${HASH}-grok`, key: "C-c" },
      { session: `tachyon-${HASH}-grok`, key: "C-c" },
    ]);
  });

  it("t-b103c5: Grok graceful stop skips remaining keys once the pane is dead", async () => {
    const { manager, sentKeys, dead } = makeManager("agents:\n  grok:\n    cmd: grok\n");
    await manager.spawn("grok");
    const session = `tachyon-${HASH}-grok`;
    // Die as soon as the first C-c is recorded so delayed if-alive steps skip.
    const originalPush = sentKeys.push.bind(sentKeys);
    sentKeys.push = ((...args: Array<{ session: string; key: string }>) => {
      const n = originalPush(...args);
      if (args[0]?.key === "C-c") dead.set(session, 0);
      return n;
    }) as typeof sentKeys.push;
    await manager.stopGracefully("grok");
    expect(sentKeys.filter((k) => k.session === session && k.key === "C-c")).toHaveLength(1);
  });

  it("t-b103c5: Kill forced on a declared Grok Saved Agent ends the session but keeps the profile row", async () => {
    // Same harness as the sibling kill/ledger test — declared agents stay resumable after kill.
    const { manager, ledger } = harness("agents:\n  grok-builder:\n    cmd: grok\n");
    await manager.spawn("grok-builder");
    expect(ledger.get("grok-builder")).toBeDefined();
    await manager.kill("grok-builder");
    expect(ledger.get("grok-builder")).toBeDefined();
    expect((await manager.list()).find((a) => a.name === "grok-builder")).toMatchObject({
      name: "grok-builder",
      lifetime: "saved",
      running: false,
    });
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

  it("retains a clean-exited Temporary postmortem across manager reload until explicit dismiss", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-211f6-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const ledger = new SessionLedger(ws);
    const ownedWorktree = { path: path.join(ws, "review-worktree"), branch: "tachyon/review", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "2026-08-01T00:00:00.000Z" };
    ledger.record("review", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, worktree: ownedWorktree, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } }); // clean exit
    ledger.record("boom", { def: { cmd: "codex exec", kind: "agent" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } }); // crashed
    const { tmux, sessions, dead, panes } = fakeTmux();
    const reviewSession = sessionName(hash, "review");
    const boomSession = sessionName(hash, "boom");
    sessions.add(reviewSession);
    sessions.add(boomSession);
    dead.set(reviewSession, 0);
    dead.set(boomSession, 137);
    panes.set(reviewSession, "durable postmortem");
    const opts = { tmux, wsHash: hash, workspaceRoot: ws, getConfig: () => configOf("agents:\n  decoy:\n    cmd: x\n"), ledger };
    const manager = new AgentManager(opts);
    await manager.rehydrateFromLedger();
    await expect(manager.dismissCleanExitPane("review")).resolves.toBe(true);
    expect(ledger.get("review")?.lifecycle).toMatchObject({ state: "clean-exited" });
    // Clean-exit reap is pane cleanup, not a fifth permanent-removal door: both the roster row and
    // its checkout ownership survive together for the explicit dismiss cascade.
    expect(ledger.get("review")?.worktree).toEqual(ownedWorktree);
    expect(ledger.get("boom")).toBeDefined();

    const reloaded = new AgentManager(opts);
    await reloaded.rehydrateFromLedger();
    expect((await reloaded.list()).find((a) => a.name === "review")).toMatchObject({
      cleanExited: true,
      running: false,
      dead: false,
    });
    reloaded.dismissTemporary("review");
    expect(ledger.get("review")).toBeUndefined();
    expect((await reloaded.list()).find((a) => a.name === "review")).toBeUndefined();
  });

  it("dismissTemporary forgets a sessionless stopped Temporary — def, lineage AND ledger row", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    await manager.rehydrateFromLedger();
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeDefined();
    manager.dismissTemporary("ghost");
    expect(ledger.get("ghost")).toBeUndefined(); // won't rehydrate after reload
    expect((await manager.list()).find((a) => a.name === "ghost")).toBeUndefined(); // gone from the live listing
  });

  it("dismissTemporary emits the lifecycle callback so Bridge callers refresh the sidebar", async () => {
    const killed: string[] = [];
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n", { onKilled: (name) => killed.push(name) });
    ledger.record("ghost", { def: { cmd: "codex exec", kind: "agent", parent: "claude" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    await manager.rehydrateFromLedger();
    manager.dismissTemporary("ghost");
    expect(killed).toEqual(["ghost"]);
  });

  it("rename rewrites a child's persisted parent in the ledger", async () => {
    const { manager, ledger, ws } = harness("agents:\n  decoy:\n    cmd: x\n");
    ledger.record("parent", { def: { cmd: "claude", kind: "agent" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
    ledger.record("child", { def: { cmd: "sh", kind: "terminal", parent: "parent" }, cwd: ws, instance: { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false } });
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
  it("persists def.env (the node nonce) and def.pipeline for a pipeline-node Temporary spawn", async () => {
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

  it("dismissTemporary revokes the token too (idempotent if kill already revoked it)", async () => {
    const { manager, registry } = registryBackedManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a", { cmd: "claude" });
    await manager.kill("a");
    expect(() => manager.dismissTemporary("a")).not.toThrow();
    expect(registry.isLive("a", SCOPE)).toBe(false);
  });

  it("restart remints a fresh token; prior token stays valid during supersede grace (kill hard-revokes)", async () => {
    const registry = new CallerIdentityRegistry(crypto.randomBytes(32));
    let lastMinted = "";
    const { tmux } = fakeTmux();
    const config = configOf("agents:\n  a:\n    cmd: x\n");
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => config,
      mintAgentToken: (name) => {
        lastMinted = registry.mint(name, SCOPE);
        return { TACHYON_AGENT_BRIDGE_TOKEN: lastMinted };
      },
      revokeAgentToken: (name) => registry.revoke(name, SCOPE),
    });
    await manager.spawn("a");
    const preRestartToken = lastMinted;
    await manager.restart("a", { stop: "force", session: "new" });
    // Dogfood: surviving pane with preRestartToken must not 401 during remint races.
    expect(registry.resolve(preRestartToken, SCOPE)).toEqual({ ok: true, snapshot: { kind: "agent", name: "a" } });
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
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
    });
    await manager.spawn("codex");
    expect(cmds.at(-1)).toContain('bearer_token_env_var="TACHYON_AGENT_BRIDGE_TOKEN"');
  });

  it("t-ab9b40: a later-dispatched read wins the lastAgentStates cache even if an earlier-dispatched one resolves after it", async () => {
    const config = configOf("agents:\n  a:\n    cmd: codex\n");
    const tmux = new TmuxService(async () => ({ stdout: "", stderr: "" }));
    const session = sessionName(HASH, "a");
    type SessionMap = Map<string, { dead: boolean; exitCode?: number }>;
    let resolveOlder!: (v: SessionMap | null) => void;
    let resolveNewer!: (v: SessionMap | null) => void;
    const older = new Promise<SessionMap | null>((r) => { resolveOlder = r; });
    const newer = new Promise<SessionMap | null>((r) => { resolveNewer = r; });
    const spy = vi
      .spyOn(tmux, "sessionStates")
      .mockImplementationOnce(() => older)
      .mockImplementationOnce(() => newer);
    const manager = new AgentManager({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => config });

    // Dispatch order: agentStates() (older) then runningAgentsStrict() (newer) — e.g. a
    // LifecycleMonitor poll racing the rebind coordinator's boot scan.
    const olderCall = manager.agentStates();
    const newerCall = manager.runningAgentsStrict();

    // Resolve OUT of dispatch order: the newer-dispatched read lands first.
    resolveNewer(new Map([[session, { dead: false }]]));
    await expect(newerCall).resolves.toEqual(["a"]);
    // The older-dispatched read resolves last and must NOT clobber the cache the newer read wrote.
    resolveOlder(new Map([[session, { dead: true, exitCode: 7 }]]));
    await expect(olderCall).resolves.toEqual(new Map([["a", { dead: true, exitCode: 7 }]]));

    // A third, ambiguous read (null) forces agentStates() to fall back to the cache — inspect it.
    spy.mockImplementationOnce(() => Promise.resolve(null));
    await expect(manager.agentStates()).resolves.toEqual(new Map([["a", { dead: false }]]));
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
      ledger,
      ...extra,
    });
    dirs.push(ws);
    return { manager, ledger, cmds, ws };
  }

  it("refuses AI Temporary spawn when Bridge URL is set but MCP materialization fails", async () => {
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
      ledger,
      resolveCurrentSession: async () => "11111111-1111-4111-8111-111111111111",
      fileExists: () => true,
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

  it("kill of an AD-HOC one-shot removes its durable transcript too (kill IS the forget for Temporary — spec 247 parity, not a new gap)", async () => {
    const { manager, ws } = pipeTranscriptHarness("agents:\n  decoy:\n    cmd: x\n");
    await manager.spawn("oneshot", { cmd: "claude" });
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

  /**
   * t-0ad300 — a refused agent must be on the roster, marked, not merely absent.
   *
   * The isolation from t-588644 deletes it from `config.agents`, which is what the legacy parser
   * needs and what made it indistinguishable from a name nobody ever wrote. It disappeared from the
   * sidebar, and with the row went the only route into Agent Studio — the one place the refusal
   * gets repaired. Measured in the real workspace: `codex` was gone from the sidebar, from Fleet and
   * from Control at the same time, with a banner naming it two surfaces away.
   */
  describe("refused agents", () => {
    function withRefused(refused: Record<string, string>) {
      const { tmux } = fakeTmux();
      const config = configOf("agents:\n  healthy:\n    cmd: sh\n");
      return new AgentManager({
        tmux,
        wsHash: HASH,
        workspaceRoot: WS,
        getConfig: () => config,
        getRefusedAgents: () => refused,
        launchPreflight: HERMETIC_PREFLIGHT,
      });
    }

    it("lists a declared-but-refused agent beside the healthy one, carrying the reason", async () => {
      const manager = withRefused({ broken: "profile/digest-mismatch: .tachyon/plugins/x: expected aa, consumed bb" });

      const rows = await manager.list();

      expect(rows.map((row) => row.name).sort()).toEqual(["broken", "healthy"]);
      const broken = rows.find((row) => row.name === "broken")!;
      // The reason rides with the row: "refused" alone sends the human to another surface to learn why.
      expect(broken.refused).toContain("profile/digest-mismatch");
      // Declared is declared — the human wrote it in tachyon.yml, so it is Saved, not a stray
      // Temporary instance that the sidebar would offer to dismiss.
      expect(broken.lifetime).toBe("saved");
      expect(rows.find((row) => row.name === "healthy")!.refused).toBeUndefined();
    });

    it("keeps a declared-but-refused agent in listAgents()", async () => {
      const manager = withRefused({ broken: "profile/digest-mismatch: .tachyon/plugins/x: expected aa, consumed bb" });

      expect((await manager.listAgents()).map((row) => row.name)).toContain("broken");
      expect((await manager.listTerminals()).map((row) => row.name)).toContain("healthy");
    });

    it("adds no row and no marker when nothing was refused", async () => {
      const rows = await withRefused({}).list();

      expect(rows.map((row) => row.name)).toEqual(["healthy"]);
      expect(rows.every((row) => row.refused === undefined)).toBe(true);
    });
  });
});

/**
 * t-9d76b1 — a stop TACHYON ASKED FOR must not be reported as a crash, in any runtime, and a real
 * crash must still be one even when it exits 130.
 *
 * The whole family of measurements this rests on: asked with `stopGracefully`, grok and hermes exit
 * 130 (128+SIGINT — the CORRECT exit of a process that honoured the Ctrl-C Tachyon sent) while codex,
 * opencode and pi exit 0 (`node scripts/dogfood/run.mjs stop-exit-codes`). So the exit code cannot carry the
 * intent, and no special case for one code could: it would fix two runtimes and break on the next.
 *
 * WHO CAN REACH THIS, and why the tests sit at `stopGracefully` rather than at each caller: every door
 * that asks a runtime to exit funnels through it — the sidebar's Stop (`agent.stop` in engineService),
 * a graceful `restart` (UI and Bridge `restart_agent`), and the Bridge-client rebind
 * (`clientRebind` → `deps.stopGracefully`). A forced Kill removes the whole tmux session, so it leaves
 * no dead pane and no row to misjudge. The door that stays uncovered by construction is a human typing
 * Ctrl-C into the pane themselves: Tachyon never asked, cannot observe the intent, and the row honestly
 * reads `crashed` — which is the second test below, from the other side.
 */
describe("AgentManager — a requested stop is not a crash (t-9d76b1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function stopHarness(yaml = "agents:\n  grok:\n    cmd: grok\n") {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-stopclean-"));
    dirs.push(ws);
    const hash = workspaceHash(ws);
    const { sessions, dead, tmux } = fakeTmux();
    const config = configOf(yaml);
    const ledger = new SessionLedger(ws);
    const manager = new AgentManager({
      tmux,
      wsHash: hash,
      workspaceRoot: ws,
      getConfig: () => config,
      ledger,
      launchPreflight: HERMETIC_PREFLIGHT,
    });
    const row = async (name: string) => (await manager.list()).find((entry) => entry.name === name)!;
    return {
      manager,
      ledger,
      sessions,
      dead,
      tmux,
      config,
      ws,
      hash,
      row,
      session: (name: string) => sessionName(hash, name),
    };
  }

  // The exit codes six real runtimes actually return to one identical requested stop. `undefined` is
  // the "we did not see the code" case, which is not assumed clean anywhere else either.
  const REQUESTED_STOP_EXITS = [
    { runtime: "grok", exitCode: 130 },
    { runtime: "hermes", exitCode: 130 },
    { runtime: "codex", exitCode: 0 },
    { runtime: "opencode", exitCode: 0 },
    { runtime: "pi", exitCode: 0 },
    { runtime: "other", exitCode: 143 },
    { runtime: "unknown-code", exitCode: undefined },
  ] as const;

  it("no requested stop is reported as a crash, whatever code the runtime chose", async () => {
    for (const { runtime, exitCode } of REQUESTED_STOP_EXITS) {
      const h = stopHarness(`agents:\n  ${runtime}:\n    cmd: grok\n`);
      await h.manager.spawn(runtime);
      await h.manager.stopGracefully(runtime);
      h.dead.set(h.session(runtime), exitCode as number); // fakeTmux omits the code when NaN/undefined

      const row = await h.row(runtime);
      expect(row.dead, runtime).toBe(true);
      expect(row.crashed, `${runtime} exit ${exitCode}`).toBe(false);
      expect(row.stopRequested, runtime).toBe(true);
      // The measured code is never hidden and never invented — it stays exactly what the pane said.
      expect(row.exitCode, runtime).toBe(exitCode);
    }
  });

  it("a crash nobody asked for is still a crash — including one that exits 130", async () => {
    for (const exitCode of [1, 130, 137]) {
      const h = stopHarness();
      await h.manager.spawn("grok");
      h.dead.set(h.session("grok"), exitCode); // died on its own; no stop was requested

      const row = await h.row("grok");
      expect(row.crashed, `exit ${exitCode}`).toBe(true);
      expect(row.stopRequested).toBeUndefined();
      expect(row.exitCode).toBe(exitCode);
    }
  });

  it("the intent belongs to the stopped instance, not to the name: a restart drops it", async () => {
    const h = stopHarness();
    await h.manager.spawn("grok");
    await h.manager.stopGracefully("grok");
    h.dead.set(h.session("grok"), 130);
    expect((await h.row("grok")).crashed).toBe(false);

    await h.manager.restart("grok", { stop: "force", session: "new" });
    expect(h.manager.wasStopRequested("grok")).toBe(false);
    // The NEW instance then dies on its own with the very same code — that is a crash.
    h.dead.set(h.session("grok"), 130);
    expect((await h.row("grok")).crashed).toBe(true);
  });

  it("survives a host reload: the durable row remembers what the dead pane cannot", async () => {
    const h = stopHarness();
    await h.manager.spawn("grok");
    await h.manager.stopGracefully("grok");
    h.dead.set(h.session("grok"), 130);
    await h.manager.list(); // the death is observed here — the one moment the intent is still in memory

    expect(h.ledger.get("grok")?.lifecycle).toMatchObject({ state: "stopped" });

    // A window reload: a brand-new manager with no memory of the request, and the dead pane still
    // there (remain-on-exit keeps it until dismiss/restart). This is where the row used to lie again.
    const reloaded = new AgentManager({
      tmux: h.tmux,
      wsHash: h.hash,
      workspaceRoot: h.ws,
      getConfig: () => h.config,
      ledger: h.ledger,
      launchPreflight: HERMETIC_PREFLIGHT,
    });
    const row = (await reloaded.list()).find((entry) => entry.name === "grok")!;
    expect(row.dead).toBe(true);
    expect(row.crashed).toBe(false);
    expect(row.stopRequested).toBe(true);
    expect(reloaded.wasStopRequested("grok")).toBe(true);
  });

  it("a restart clears the durable stamp too, so the next instance is judged on its own", async () => {
    const h = stopHarness();
    await h.manager.spawn("grok");
    await h.manager.stopGracefully("grok");
    h.dead.set(h.session("grok"), 130);
    await h.manager.list();
    expect(h.ledger.get("grok")?.lifecycle?.state).toBe("stopped");

    await h.manager.restart("grok", { stop: "force", session: "new" });
    expect(h.ledger.get("grok")?.lifecycle).toBeUndefined();
  });

});
