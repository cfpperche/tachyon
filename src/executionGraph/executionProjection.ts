/**
 * SDD 480 Phase 3 — the projection / read API over the execution ledger.
 *
 * A PURE fold over sealed events. It reads; it never writes, never spawns, and never invents. The
 * ledger stays the single source of truth — this module holds no state of its own, so there is no
 * second place for the graph to disagree with itself.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: `shared`, `orphaned` and `unproven` must survive the
 * fold. They are the three facts a naive projection destroys, and each is destroyed differently:
 *
 *  - `shared` dies to LAST-WRITE-WINS. Two agents claim one daemon; the later event's state overwrites
 *    the earlier and the node reads as if one agent owned it. So sharing is DERIVED from the set of
 *    claimants, never read off a state field that the next event can clobber.
 *  - `unproven` dies to AGGREGATION. Agent A proved its claim, agent B did not; collapsing to one
 *    provenance either promotes B's guess or demotes A's measurement. So provenance is kept PER CLAIM.
 *  - `orphaned` dies to RECENCY. It is a lasting fact about an execution that lost its parent, not a
 *    transient status, so a later routine event must not quietly bury it.
 *
 * Spec §5 is the reason all three matter: a graph that draws a confident wrong parent is worse than no
 * graph, because it will be believed.
 */

import {
  isExclusivelyOwned,
  type ExecutionEdgeKind,
  type ExecutionNodeKind,
  type ExecutionProvenance,
  type ExecutionState,
  type SealedExecutionEvent,
} from "./eventSchema.js";

/** One agent's attribution of one execution, kept separate from every other agent's. */
export interface ExecutionClaim {
  agentId: string;
  /** How THIS agent's claim was established. Never merged with anyone else's (§4.3). */
  provenance: ExecutionProvenance;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ProjectedEdge {
  from: string;
  to: string;
  kind: ExecutionEdgeKind;
}

/** One execution as the read API presents it. */
export interface ProjectedExecution {
  executionId: string;
  node: ExecutionNodeKind;
  /** The most recent lifecycle state reported. */
  state: ExecutionState;
  /**
   * Every distinct state observed, in order of first appearance. `state` alone cannot answer "was this
   * ever shared / orphaned", and the answer to that is not recoverable once the fold has dropped it.
   */
  observedStates: ExecutionState[];
  /** Per-agent attribution. More than one entry IS the sharing; there is no `owner` field. */
  claims: ExecutionClaim[];
  /**
   * §4.3 — exactly one agent claims it AND that claim was proven. Derived, never written.
   *
   * STRICTER than `isExclusivelyOwned` in the schema, deliberately, because the two answer different
   * questions. That helper asks "is there exactly one claimant?" — a fact about sharing. This asks
   * "may a reader act as though this belongs to that agent?" — a fact about ownership. A single
   * unproven claim satisfies the first and not the second: one agent is the only one who mentioned it,
   * and we still never established that the execution was theirs.
   *
   * Fail-closed, like every other attribution in this spec: not provably owned reads as not owned.
   */
  exclusivelyOwned: boolean;
  /** Claimed by more than one agent, or explicitly reported `shared`. */
  shared: boolean;
  /** Reported `orphaned` and not superseded by a later terminal state. */
  orphaned: boolean;
  /** No claim on this execution was ever proven. */
  unproven: boolean;
  turnId?: string;
  toolCallId?: string;
  edges: ProjectedEdge[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Present once an `exit`/`fail` event recorded one (§3.4 gap 3). */
  exit?: { at: string; code?: string; state: ExecutionState };
}

export interface AgentProjection {
  agentId: string;
  /** Every execution this agent claims, shared ones included. */
  executions: ProjectedExecution[];
  /** The subset also claimed by someone else — the daemon case, surfaced rather than hidden. */
  shared: ProjectedExecution[];
  /** The subset this agent alone owns and has proven. */
  exclusivelyOwned: ProjectedExecution[];
}

export interface ExecutionProjection {
  executions: ProjectedExecution[];
  edges: ProjectedEdge[];
  /** Agents that appear anywhere in the ledger, sorted. */
  agentIds: string[];
}

/** States that end an execution's life. A later one of these supersedes `orphaned`. */
const TERMINAL: ReadonlySet<ExecutionState> = new Set(["completed", "failed", "killed"]);

/** What one execution contributes to the side panel's detail rows. */
export interface ExecutionDetailEntry {
  cwd?: string;
  worktree?: string;
  tool?: string;
}

/**
 * t-441b0f — the ONLY `detail` keys the panel reads.
 *
 * An event's `detail` is a `Record<string, string>` that the write boundary already redacted and
 * capped, so reading it here is reading sanitized output — not reopening a raw payload, which no
 * longer exists at this point by construction. Naming the three keys explicitly keeps it that way: a
 * seam that starts recording something new cannot reach the panel by accident, only by being added
 * here on purpose.
 */
const PANEL_DETAIL_KEYS = ["cwd", "worktree", "tool"] as const;

/**
 * Index the panel's detail keys by execution id.
 *
 * FIRST writer wins, deliberately. These three answer "where did this execution begin" — `cwd` and
 * `worktree` come from the spawn seam, `tool` from the Bridge seam that opened the call — so a later
 * event restating a key must not move the answer. Taking the last would let an `exit` recorded by a
 * different seam silently redefine where the work ran.
 *
 * An execution contributes an entry only when it actually carries one of these keys, and a blank
 * string is treated as absent: "" is not a working directory, and a present-but-empty row would read
 * as a fact when it is the absence of one. Absent stays absent, all the way to the panel.
 */
export function indexExecutionDetail(
  events: readonly SealedExecutionEvent[],
): ReadonlyMap<string, ExecutionDetailEntry> {
  const byId = new Map<string, ExecutionDetailEntry>();
  for (const event of events) {
    for (const key of PANEL_DETAIL_KEYS) {
      const value = event.detail[key];
      if (!value) continue;
      const id = event.correlation.executionId;
      let entry = byId.get(id);
      if (!entry) {
        entry = {};
        byId.set(id, entry);
      }
      if (entry[key] === undefined) entry[key] = value;
    }
  }
  return byId;
}

/**
 * Fold sealed events into the projection.
 *
 * Events are taken in the order the ledger returns them, which is append order. A corrupted or
 * unreadable record never reaches here — the ledger drops it at the read boundary — so this function
 * does not need to defend against malformed input, only against LOSSY interpretation of valid input.
 */
export function projectExecutions(events: readonly SealedExecutionEvent[]): ExecutionProjection {
  const byId = new Map<string, ProjectedExecution & { claimIndex: Map<string, ExecutionClaim> }>();
  const edges: ProjectedEdge[] = [];
  const seenEdge = new Set<string>();

  for (const event of events) {
    const id = event.correlation.executionId;
    const agentId = event.correlation.agentId;
    let node = byId.get(id);
    if (!node) {
      node = {
        executionId: id,
        node: event.node,
        state: event.state,
        observedStates: [],
        claims: [],
        claimIndex: new Map(),
        exclusivelyOwned: false,
        shared: false,
        orphaned: false,
        unproven: false,
        edges: [],
        firstSeenAt: event.at,
        lastSeenAt: event.at,
      };
      byId.set(id, node);
    }

    node.state = event.state;
    node.lastSeenAt = event.at;
    if (!node.observedStates.includes(event.state)) node.observedStates.push(event.state);

    const claim = node.claimIndex.get(agentId);
    if (claim) {
      claim.lastSeenAt = event.at;
      // A claim that was ever PROVEN stays proven: a later event that merely could not re-establish
      // attribution is not evidence against a measurement already taken. The reverse does not hold —
      // an unproven claim is never upgraded by anything except a real measurement.
      if (claim.provenance !== "measured" && event.provenance === "measured") claim.provenance = "measured";
    } else {
      const fresh: ExecutionClaim = { agentId, provenance: event.provenance, firstSeenAt: event.at, lastSeenAt: event.at };
      node.claimIndex.set(agentId, fresh);
      node.claims.push(fresh);
    }

    // §3.4 gap 3 — the exit, with its code and its time, readable rather than inferred from silence.
    if (event.kind === "exit" || event.kind === "fail") {
      node.exit = { at: event.at, state: event.state, ...(event.detail.exitCode !== undefined ? { code: event.detail.exitCode } : {}) };
    }
    // Correlation ids ride along on whichever event carried them; a later event lacking them must not
    // erase what an earlier one established.
    if (event.correlation.turnId) node.turnId = event.correlation.turnId;
    if (event.correlation.toolCallId) node.toolCallId = event.correlation.toolCallId;

    if (event.edge) {
      const key = `${id}\u0000${event.edge.toExecutionId}\u0000${event.edge.kind}`;
      if (!seenEdge.has(key)) {
        seenEdge.add(key);
        const projected = { from: id, to: event.edge.toExecutionId, kind: event.edge.kind };
        edges.push(projected);
        node.edges.push(projected);
      }
    }
  }

  const executions: ProjectedExecution[] = [];
  for (const node of byId.values()) {
    const { claimIndex: _claimIndex, ...rest } = node;
    const sharedByClaimants = node.claims.length > 1;
    const everShared = node.observedStates.includes("shared");
    // `orphaned` is a lasting fact, not a passing status — it only stops being true when the
    // execution actually ends. Letting a routine later event bury it is how the graph forgets that
    // something outlived its parent.
    const orphaned = node.observedStates.includes("orphaned") && !TERMINAL.has(node.state);
    executions.push({
      ...rest,
      claims: [...node.claims].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      shared: sharedByClaimants || everShared,
      orphaned,
      unproven: node.claims.length > 0 && node.claims.every((c) => c.provenance !== "measured"),
      // Single claimant AND that claim proven. The schema's `isExclusivelyOwned` is consulted for the
      // sharing half so the two cannot disagree about how many agents there are; the proof half is
      // added here because a reader of the projection is about to ACT on ownership, and an unproven
      // claim never established it. See the field's doc for why the stricter rule lives on this side.
      exclusivelyOwned: isExclusivelyOwned(events, node.executionId)
        && !sharedByClaimants
        && !everShared
        && node.claims.every((c) => c.provenance === "measured"),
    });
  }

  const agentIds = [...new Set(events.map((e) => e.correlation.agentId))].sort();
  return { executions, edges, agentIds };
}

/**
 * The per-agent view Phase 4 will render.
 *
 * A shared execution appears in BOTH `executions` and `shared` — it genuinely belongs to this agent's
 * picture, and hiding it from the main list to avoid double-counting would recreate the exact blindness
 * §4.3 is about. `exclusivelyOwned` is the narrower list: this agent's, alone, and proven.
 */
export function projectForAgent(events: readonly SealedExecutionEvent[], agentId: string): AgentProjection {
  const all = projectExecutions(events);
  const mine = all.executions.filter((execution) => execution.claims.some((claim) => claim.agentId === agentId));
  return {
    agentId,
    executions: mine,
    shared: mine.filter((execution) => execution.shared),
    exclusivelyOwned: mine.filter((execution) => execution.exclusivelyOwned),
  };
}

/**
 * Follow an execution back to what caused it.
 *
 * Returns the chain from `executionId` toward its origin, nearest first. Stops at a node with no
 * outgoing edge, and refuses to loop on a cycle — a malformed ledger must not hang a reader.
 */
export function causalChain(projection: ExecutionProjection, executionId: string): ProjectedExecution[] {
  const byId = new Map(projection.executions.map((execution) => [execution.executionId, execution]));
  const chain: ProjectedExecution[] = [];
  const seen = new Set<string>();
  let current = byId.get(executionId);
  while (current && !seen.has(current.executionId)) {
    seen.add(current.executionId);
    chain.push(current);
    const next = current.edges[0];
    current = next ? byId.get(next.to) : undefined;
  }
  return chain;
}
