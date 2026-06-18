import type { NodeStatus } from "./runState.js";

/**
 * spec 230 (codex M1) — pure auth + state check for a `complete_node` Bridge call. The Bridge shares
 * ONE workspace token across all agents, so a node cannot be authenticated by the caller's identity —
 * it is authenticated by a per-node **nonce** minted into the node agent's env at spawn. This module is
 * the whole decision; the Bridge tool handler is a thin shell over it (vscode-layer-escapes-CI rule).
 */

export interface CompleteNodeInput {
  runId: string;
  nodeId: string;
  nonce: string;
}

/** The auth state the executor exposes for one node. */
export interface NodeAuthState {
  /** the secret nonce minted into the node agent's env at spawn */
  nonce: string;
  /** the node's current lifecycle status */
  status: NodeStatus;
  /** the node already accepted a completion signal (duplicate guard) */
  alreadySignalled: boolean;
}

/** runId+nodeId → auth state, or null for an unknown/closed run or unknown node. */
export type NodeAuthLookup = (runId: string, nodeId: string) => NodeAuthState | null;

export type CompleteNodeVerdict = { ok: true } | { ok: false; reason: string };

/** Constant-time string compare — avoids leaking the nonce via response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Validate a complete_node call. Check order is security-ordered: existence → nonce → status → dup, so
 * node status/dup details are never revealed to a caller without a valid nonce. Rejects: unknown/closed
 * run or node, a bad nonce, a node that isn't running, and a duplicate signal.
 */
export function validateCompleteNode(input: CompleteNodeInput, lookup: NodeAuthLookup): CompleteNodeVerdict {
  const st = lookup(input.runId, input.nodeId);
  if (!st) return { ok: false, reason: "unknown or closed pipeline run/node" };
  if (typeof input.nonce !== "string" || !timingSafeEqual(input.nonce, st.nonce)) {
    return { ok: false, reason: "invalid completion token" };
  }
  if (st.status !== "running") return { ok: false, reason: `node is '${st.status}', not awaiting completion` };
  if (st.alreadySignalled) return { ok: false, reason: "node already signalled completion" };
  return { ok: true };
}

export type { NodeStatus };
