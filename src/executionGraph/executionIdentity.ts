/**
 * SDD 480 Phase 2, slice 2 — minting execution identity, and carrying it into the child.
 *
 * The id is minted BEFORE the child exists and handed to it through its environment. That ordering is
 * the whole point: a process can lose its parent — measured, `t-41f496`, 73 processes reparented to
 * `systemd --user` after their launcher died — but it cannot lose an id it was born holding. PPID is
 * a fact about right now; the carried id is a fact about origin.
 *
 * Pure module. It mints, it renders the env carrier, and it reads one back. It does not spawn, and it
 * does not know which seam is calling — every seam in spec §3.1 uses the same three functions so the
 * correlation cannot drift between them.
 *
 * `attributionFor` is where the spec's fail-closed rule becomes code: a seam that cannot carry the
 * env says so, and gets `unproven`. It never gets to fall back on "well, the PPID looked right".
 */

import { randomUUID } from "node:crypto";
import type { ExecutionCorrelation, ExecutionProvenance } from "./eventSchema.js";

/** The env var the child is born holding. Read by the observer, never by the child's own logic. */
export const EXECUTION_ID_ENV = "TACHYON_EXECUTION_ID";
/** The agent the execution belongs to, carried alongside so a bare process is still attributable. */
export const EXECUTION_AGENT_ENV = "TACHYON_EXECUTION_AGENT";

/**
 * Whether a seam can hand environment to what it starts.
 *
 * `carried`: the child is started with an env we control. `absent`: the seam physically cannot — a
 * runtime that rejects extra env, an already-running daemon being attached to, a remote MCP call.
 * The distinction is declared by the seam, never guessed, because guessing it is what produces a
 * confident wrong parent.
 */
export type EnvCarrier = "carried" | "absent";

export interface MintedExecution {
  executionId: string;
  correlation: ExecutionCorrelation;
  /** Merge into the child's environment. Empty when the seam declared it cannot carry env. */
  env: Record<string, string>;
  /** How an observer will be able to attribute this execution once it is running. */
  provenance: ExecutionProvenance;
}

export interface MintExecutionInput {
  agentId: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  carrier: EnvCarrier;
  /** Injected for tests; production mints a v4 uuid. */
  newId?: () => string;
}

/**
 * Mint an execution identity for something about to start.
 *
 * Call this BEFORE the spawn, and merge `env` into the child's environment. Calling it after is not
 * a smaller version of the same thing — it is the bug, because the window between start and mint is
 * exactly where a fast child can exit, reparent or fork.
 */
export function mintExecution(input: MintExecutionInput): MintedExecution {
  const executionId = `exec-${(input.newId ?? randomUUID)()}`;
  const correlation: ExecutionCorrelation = {
    agentId: input.agentId,
    executionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  };
  const carried = input.carrier === "carried";
  return {
    executionId,
    correlation,
    env: carried ? { [EXECUTION_ID_ENV]: executionId, [EXECUTION_AGENT_ENV]: input.agentId } : {},
    // A seam that cannot carry the id can still record that the execution happened — it just cannot
    // prove, later, that a given process is this one. That is `unproven`, and it is a useful fact.
    provenance: carried ? "measured" : "unproven",
  };
}

/**
 * Read back the identity a running process is carrying, from its environment.
 *
 * Returns `undefined` when the process carries nothing — which is an answer, not a failure. The
 * caller must record `unproven` rather than reaching for PPID; that reach is the defect this whole
 * spec exists to prevent.
 */
export function readCarriedExecution(env: NodeJS.ProcessEnv): { executionId: string; agentId: string } | undefined {
  const executionId = env[EXECUTION_ID_ENV]?.trim();
  const agentId = env[EXECUTION_AGENT_ENV]?.trim();
  if (!executionId || !agentId) return undefined;
  return { executionId, agentId };
}

/**
 * Decide how a running process may be attributed.
 *
 * `measured` only when the process carries the id we minted AND it names the agent we expected.
 * A mismatch is deliberately NOT "close enough": two agents sharing a daemon is a real case
 * (spec §4.2 `shared`), and quietly preferring one of them is how false ownership gets recorded.
 */
export function attributionFor(
  expected: { executionId: string; agentId: string },
  observedEnv: NodeJS.ProcessEnv,
): ExecutionProvenance {
  const carried = readCarriedExecution(observedEnv);
  if (!carried) return "unproven";
  if (carried.executionId !== expected.executionId) return "unproven";
  return carried.agentId === expected.agentId ? "measured" : "unproven";
}
