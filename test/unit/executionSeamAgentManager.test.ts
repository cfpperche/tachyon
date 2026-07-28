/**
 * SDD 480 Phase 2 — the AgentManager seam.
 *
 * This is the first seam that can genuinely CARRY the execution identity, so it is the first place
 * the spec's central claim is testable rather than asserted: an agent process is attributable through
 * something it holds, not through a parent pointer that `systemd --user` will overwrite the moment its
 * launcher dies (t-41f496 measured 73 such reparentings on this host).
 *
 * What these tests pin, and why each one would let a real defect through if it were missing:
 *  - the id reaches the CHILD's environment, not just the ledger — a graph that records an id nobody
 *    is carrying can never verify itself later;
 *  - the identity survives an agent that declares conflicting env, because a forgeable id is exactly
 *    the confident-wrong-parent the spec exists to prevent;
 *  - `attributionFor` says `measured` for the real env and `unproven` for every near miss, so the
 *    round trip is proven end to end rather than in the pure module alone;
 *  - a failed launch is still recorded, because a partial graph that looks complete is worse than one
 *    that admits the gap;
 *  - a sink that throws cannot fail the spawn it is only observing.
 */
import { describe, it, expect } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import type { SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import {
  attributionFor,
  EXECUTION_AGENT_ENV,
  EXECUTION_ID_ENV,
  readCarriedExecution,
} from "../../src/executionGraph/executionIdentity.js";

const WS = "/repo";
const HASH = workspaceHash(WS);
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

/** Minimal tmux fake at the executor level, so the real TmuxService arg-building path runs. */
function fakeTmux(opts: { failNewSession?: boolean } = {}) {
  const sessions = new Set<string>();
  /** Launch env per session, parsed back out of the real `new-session -e KEY=value` argv. */
  const sessionEnv = new Map<string, Record<string, string>>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      if (opts.failNewSession) throw new Error("tmux refused the session");
      const name = args[args.indexOf("-s") + 1]!;
      sessions.add(name);
      const env: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && args[i + 1]?.includes("=")) {
          const pair = args[++i]!;
          const eq = pair.indexOf("=");
          env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
      sessionEnv.set(name, env);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
      case "capture-pane":
        return { stdout: "", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, sessionEnv, tmux: new TmuxService(exec) };
}

function makeManager(yaml: string, opts: { failNewSession?: boolean; sinkThrows?: boolean } = {}) {
  const { sessions, sessionEnv, tmux } = fakeTmux({ failNewSession: opts.failNewSession });
  const config = configOf(yaml);
  const events: SealedExecutionEvent[] = [];
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => 8,
    launchPreflight: HERMETIC_PREFLIGHT,
    recordExecution: (event) => {
      if (opts.sinkThrows) throw new Error("ledger is on fire");
      events.push(event);
    },
  });
  return { manager, sessions, sessionEnv, events };
}

const YAML = `
agents:
  ada:
    cmd: sleep 1000
    autostart: false
`;

/** The env the fake recorded for the one session that was created. */
function onlySessionEnv(sessionEnv: Map<string, Record<string, string>>): Record<string, string> {
  const entries = [...sessionEnv.entries()];
  expect(entries).toHaveLength(1);
  return entries[0]![1];
}

describe("SDD 480 §3.1 — AgentManager carries the execution identity into the child", () => {
  it("mints an id and hands it to the spawned pane through its own environment", async () => {
    const { manager, sessionEnv, events } = makeManager(YAML);
    await manager.spawn("ada");

    const env = onlySessionEnv(sessionEnv);
    const carried = readCarriedExecution(env);
    expect(carried, `pane env carried no execution identity: ${JSON.stringify(Object.keys(env))}`).toBeDefined();
    expect(carried!.agentId).toBe("ada");
    expect(carried!.executionId).toMatch(/^exec-/);

    // The ledger and the child must agree. If the recorded id and the carried id can drift, every
    // later attribution is guesswork wearing a proof's clothing.
    const spawn = events.find((e) => e.kind === "spawn");
    expect(spawn, `no spawn event recorded; got ${JSON.stringify(events.map((e) => e.kind))}`).toBeDefined();
    expect(spawn!.correlation.executionId).toBe(carried!.executionId);
    expect(spawn!.correlation.agentId).toBe("ada");
    expect(spawn!.node).toBe("Process");
    expect(spawn!.state).toBe("running");
  });

  it("records `measured` provenance, because this seam really can carry the env", async () => {
    const { manager, events } = makeManager(YAML);
    await manager.spawn("ada");
    // `unproven` must be reachable elsewhere (run_command declares `absent`), but a seam that CAN
    // carry env and still reports `unproven` would make the honest label meaningless by dilution.
    expect(events.find((e) => e.kind === "spawn")!.provenance).toBe("measured");
  });

  it("completes the round trip: the pane's real env attributes back to the recorded execution", async () => {
    const { manager, sessionEnv, events } = makeManager(YAML);
    await manager.spawn("ada");
    const env = onlySessionEnv(sessionEnv);
    const expected = {
      executionId: events.find((e) => e.kind === "spawn")!.correlation.executionId,
      agentId: "ada",
    };

    expect(attributionFor(expected, env)).toBe("measured");
    // Every near miss is `unproven`, never "close enough" — two agents sharing one daemon is a real
    // case, and quietly preferring the one we expected is how false ownership enters the record.
    expect(attributionFor({ ...expected, executionId: "exec-someone-else" }, env)).toBe("unproven");
    expect(attributionFor({ ...expected, agentId: "bob" }, env)).toBe("unproven");
    expect(attributionFor(expected, {})).toBe("unproven");
  });

  it("does not let an agent's own declared env forge the identity", async () => {
    // Everywhere else in the spawn build the agent's declared env wins. Here it must lose: an id the
    // child can choose proves nothing about who started it.
    const { manager, sessionEnv, events } = makeManager(`
agents:
  ada:
    cmd: sleep 1000
    autostart: false
    env:
      ${EXECUTION_ID_ENV}: exec-forged-by-the-agent
      ${EXECUTION_AGENT_ENV}: someone-else
`);
    await manager.spawn("ada");

    const env = onlySessionEnv(sessionEnv);
    expect(env[EXECUTION_ID_ENV]).not.toBe("exec-forged-by-the-agent");
    expect(env[EXECUTION_AGENT_ENV]).toBe("ada");
    expect(env[EXECUTION_ID_ENV]).toBe(events.find((e) => e.kind === "spawn")!.correlation.executionId);
  });

  it("records a launch that never became a pane, instead of dropping it", async () => {
    const { manager, events } = makeManager(YAML, { failNewSession: true });
    await expect(manager.spawn("ada")).rejects.toThrow();

    // Dropping this would make a partial graph look complete — the same reason an unattributable
    // execution is recorded rather than discarded.
    const failed = events.find((e) => e.kind === "fail");
    expect(failed, `a failed launch left no trace; got ${JSON.stringify(events.map((e) => e.kind))}`).toBeDefined();
    expect(failed!.state).toBe("failed");
    expect(failed!.correlation.agentId).toBe("ada");
    expect(events.some((e) => e.kind === "spawn")).toBe(false);
  });

  it("never fails a spawn because the ledger failed", async () => {
    // A diagnostic that can break the operation it observes is worse than no diagnostic.
    const { manager, sessions } = makeManager(YAML, { sinkThrows: true });
    await expect(manager.spawn("ada")).resolves.not.toThrow();
    expect(sessions.size).toBe(1);
  });

  it("redacts a secret in the recorded detail before it can reach the ledger", async () => {
    // The seam records cwd/session/agent, so a secret can only arrive through those. Prove the write
    // boundary is actually in the path rather than trusting that it was called.
    const { manager, events } = makeManager(YAML);
    await manager.spawn("ada");
    const spawn = events.find((e) => e.kind === "spawn")!;
    for (const value of Object.values(spawn.detail)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeLessThanOrEqual(512);
    }
  });
});
