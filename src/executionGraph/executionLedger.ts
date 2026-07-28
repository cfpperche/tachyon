/**
 * SDD 480 Phase 2, slices 2.3 + 2.5 — the durable execution ledger, and the budget that keeps it fair.
 *
 * The two are one module because they are one decision. A ledger without a per-agent bound is the
 * failure this host already suffered: `ENOSPC` on a shared 7.9 GB `/tmp` took down a whole suite
 * mid-run (t-41f496), and spec §7.2 answers it with bytes-per-agent FIRST, age second.
 *
 * What the bound is actually for, stated precisely because it is easy to get wrong: the journal file
 * is ALREADY bounded — `EngineEventJournal` compacts at `maxEvents` and refuses past 16 MB. So the
 * per-agent budget is not there to stop the file growing. It is there to stop ONE agent from spending
 * the whole shared bound and pushing every other agent's history out through that compaction. The
 * limit buys fairness, not size, and a noisy agent is refused rather than allowed to evict its
 * neighbours.
 *
 * Refusals are COUNTED and readable (`droppedFor`). A retention policy that silently discards is
 * indistinguishable, from the outside, from a graph that never saw the event — and this whole spec
 * exists to stop the graph from looking more complete than it is.
 *
 * Age is the complement §7.2 asks for: it retires a quiet agent's old bytes so its budget frees up on
 * its own, instead of leaving an agent that ran once at noon holding its share all day.
 */

import path from "node:path";
import { EngineEventJournal } from "../engine-service/eventJournal.js";
import { isExclusivelyOwned, type ExecutionEdgeKind, type ExecutionNodeKind, type ExecutionProvenance, type ExecutionState, type SealedExecutionEvent } from "./eventSchema.js";

/** The event `kind` every execution event is stored under in the shared engine journal. */
export const EXECUTION_EVENT_KIND = "execution";

/**
 * The narrow slice of `EngineEventJournal` this ledger needs.
 *
 * Declared as a port rather than importing the class so the ledger can be tested against an in-memory
 * double without a real file, and so a caller may hand it any append-only log with these semantics.
 */
export interface ExecutionJournalPort {
  append(kind: string, payload: Record<string, unknown>, at?: string): unknown;
  readAfter(afterSeq: number, limit?: number): { events: Array<{ kind: string; payload: Record<string, unknown> }>; latestSeq: number };
}

export interface ExecutionLedgerOptions {
  journal: ExecutionJournalPort;
  /** §7.2 primary control. Bytes of sealed-event JSON one agent may hold before it is refused. */
  maxBytesPerAgent?: number;
  /** §7.2 complement. Events older than this stop counting against their agent's budget. */
  maxAgeMs?: number;
  /** Injected for tests; production reads the clock. */
  now?: () => number;
}

/** 256 KB per agent: large enough for a long session's lifecycle events, small enough that 64 noisy
 *  agents still cannot reach the journal's own 16 MB ceiling between compactions. */
export const DEFAULT_MAX_BYTES_PER_AGENT = 256 * 1024;
/** 24h — long enough that a day's work stays whole, short enough that yesterday's does not. */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One execution as the graph sees it, folded from every event that mentioned it. */
export interface ExecutionNode {
  executionId: string;
  node: ExecutionNodeKind;
  /** Every agent that claimed this execution. More than one is the `shared` case, not a conflict. */
  agentIds: string[];
  /** The most recent state reported for it. */
  state: ExecutionState;
  provenance: ExecutionProvenance;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ExecutionEdge {
  from: string;
  to: string;
  kind: ExecutionEdgeKind;
}

export interface ExecutionGraph {
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
}

interface Accounted {
  event: SealedExecutionEvent;
  bytes: number;
  atMs: number;
}

/**
 * Durable, fair, append-only record of everything Tachyon started.
 *
 * Writes go through `record`, which is the only admission point; reads rebuild the graph from the
 * journal so a restarted Control reconstructs the same graph rather than starting blind.
 */
export class ExecutionLedger {
  private readonly journal: ExecutionJournalPort;
  private readonly maxBytesPerAgent: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  /** Per-agent accounting for admission. Rebuilt from the journal on construction. */
  private readonly perAgent = new Map<string, Accounted[]>();
  private readonly dropped = new Map<string, number>();

  constructor(options: ExecutionLedgerOptions) {
    this.journal = options.journal;
    this.maxBytesPerAgent = options.maxBytesPerAgent ?? DEFAULT_MAX_BYTES_PER_AGENT;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    if (this.maxBytesPerAgent <= 0) throw new Error("execution ledger maxBytesPerAgent must be positive");
    if (this.maxAgeMs <= 0) throw new Error("execution ledger maxAgeMs must be positive");
    // Recover accounting from what is already on disk. Without this a restart would hand every agent a
    // fresh budget, and the bound would reset itself exactly when a crash loop needs it most.
    for (const event of this.readAll()) this.account(event);
  }

  /**
   * Admit one sealed event, or refuse it because its agent is over budget.
   *
   * Returns whether it was written. The caller does not have to check — every seam treats recording
   * as fire-and-forget — but the answer is available, and `droppedFor` keeps the refusals visible.
   */
  record(event: SealedExecutionEvent): boolean {
    const agentId = event.correlation.agentId;
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.expire(agentId);
    if (this.bytesFor(agentId) + bytes > this.maxBytesPerAgent) {
      this.dropped.set(agentId, (this.dropped.get(agentId) ?? 0) + 1);
      return false;
    }
    // The journal is the durable record; the in-memory accounting only mirrors it. Append FIRST so a
    // failed write never leaves an agent charged for bytes that were never stored.
    this.journal.append(EXECUTION_EVENT_KIND, event as unknown as Record<string, unknown>, event.at);
    this.account(event, bytes);
    return true;
  }

  /** How many events this agent has had refused for budget. Never silent: callers can surface it. */
  droppedFor(agentId: string): number {
    return this.dropped.get(agentId) ?? 0;
  }

  /** Bytes this agent currently holds, after age expiry. */
  bytesFor(agentId: string): number {
    this.expire(agentId);
    return (this.perAgent.get(agentId) ?? []).reduce((sum, entry) => sum + entry.bytes, 0);
  }

  /** Every execution event in the journal, oldest first. */
  readAll(): SealedExecutionEvent[] {
    const out: SealedExecutionEvent[] = [];
    let cursor = 0;
    // `readAfter` is capped at 200 per call, so page until the cursor stops moving. Guarding on
    // "no progress" rather than on a count keeps this terminating even if a batch comes back short.
    for (;;) {
      const batch = this.journal.readAfter(cursor, 200);
      if (batch.events.length === 0) break;
      for (const entry of batch.events) {
        if (entry.kind === EXECUTION_EVENT_KIND) out.push(entry.payload as unknown as SealedExecutionEvent);
      }
      const next = cursor + batch.events.length;
      if (next <= cursor) break;
      cursor = next;
      if (cursor >= batch.latestSeq) break;
    }
    return out;
  }

  /**
   * Fold the journal into nodes and edges.
   *
   * This is the criterion "a restarted Control rebuilds the same graph": the graph is a projection of
   * the log, never state held only in a live process, so nothing about it depends on having been
   * running when the events happened.
   */
  graph(): ExecutionGraph {
    const nodes = new Map<string, ExecutionNode & { agents: Set<string> }>();
    const edges: ExecutionEdge[] = [];
    const seenEdge = new Set<string>();
    for (const event of this.readAll()) {
      const id = event.correlation.executionId;
      const existing = nodes.get(id);
      if (existing) {
        existing.agents.add(event.correlation.agentId);
        // Last write wins for state: the newest event is the most recent thing known to be true.
        existing.state = event.state;
        existing.provenance = event.provenance;
        existing.lastSeenAt = event.at;
      } else {
        nodes.set(id, {
          executionId: id,
          node: event.node,
          agentIds: [],
          agents: new Set([event.correlation.agentId]),
          state: event.state,
          provenance: event.provenance,
          firstSeenAt: event.at,
          lastSeenAt: event.at,
        });
      }
      if (event.edge) {
        const key = `${id}\u0000${event.edge.toExecutionId}\u0000${event.edge.kind}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push({ from: id, to: event.edge.toExecutionId, kind: event.edge.kind });
        }
      }
    }
    return {
      nodes: [...nodes.values()].map(({ agents, ...node }) => ({ ...node, agentIds: [...agents].sort() })),
      edges,
    };
  }

  /**
   * Whether one execution belongs to exactly one agent.
   *
   * Delegates to the schema's derived rule rather than reading an `owner` field, because there is no
   * `owner` field to read: a shared daemon simply has more than one agent claiming it.
   */
  isExclusivelyOwned(executionId: string): boolean {
    return isExclusivelyOwned(this.readAll(), executionId);
  }

  private account(event: SealedExecutionEvent, bytes?: number): void {
    const agentId = event.correlation.agentId;
    const list = this.perAgent.get(agentId) ?? [];
    const atMs = Date.parse(event.at);
    list.push({
      event,
      bytes: bytes ?? Buffer.byteLength(JSON.stringify(event), "utf8"),
      // An unparseable timestamp cannot be aged out on a schedule, so treat it as present rather than
      // as infinitely old — expiring it immediately would quietly hand the agent free budget.
      atMs: Number.isFinite(atMs) ? atMs : this.now(),
    });
    this.perAgent.set(agentId, list);
  }

  /** Drop this agent's aged-out accounting. The journal keeps the events; only the budget frees up. */
  private expire(agentId: string): void {
    const list = this.perAgent.get(agentId);
    if (!list || list.length === 0) return;
    const cutoff = this.now() - this.maxAgeMs;
    const live = list.filter((entry) => entry.atMs >= cutoff);
    if (live.length !== list.length) this.perAgent.set(agentId, live);
  }
}

/**
 * Open the production execution ledger for one workspace.
 *
 * Deliberately NOT the engine's own per-instance journal. That one lives at
 * `events/<instanceId>.jsonl` with a fresh uuid per start, so reusing it would throw the graph away on
 * every restart — the exact opposite of the criterion that a restarted Control rebuilds the same
 * graph. This opens a SEPARATE `EngineEventJournal` on a STABLE, workspace-scoped stream, which keeps
 * every guarantee the spec wanted from that primitive (append-only, `schemaVersion`, 0600, contiguous
 * sequence) while surviving the restart it has to survive.
 *
 * The stream id is derived, not random, for the same reason: an id that changed per start would make
 * the journal reject its own history as foreign on the very next boot.
 */
export function openExecutionLedger(input: {
  storageRoot: string;
  workspaceHash: string;
  maxBytesPerAgent?: number;
  maxAgeMs?: number;
}): ExecutionLedger {
  // Padded so a short hash still clears the journal's 8-character minimum for a stream id.
  const streamId = `execution-graph-${input.workspaceHash}`.slice(0, 128);
  return new ExecutionLedger({
    journal: new EngineEventJournal({
      filePath: path.join(input.storageRoot, "events", "executions.jsonl"),
      engineInstanceId: streamId,
    }) as unknown as ExecutionJournalPort,
    ...(input.maxBytesPerAgent !== undefined ? { maxBytesPerAgent: input.maxBytesPerAgent } : {}),
    ...(input.maxAgeMs !== undefined ? { maxAgeMs: input.maxAgeMs } : {}),
  });
}
