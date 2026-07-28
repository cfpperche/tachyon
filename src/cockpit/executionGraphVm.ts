/**
 * SDD 480 Phase 4 — the Execution Graph view-model.
 *
 * DETERMINISTIC BY CONSTRUCTION, which the plan asks for before anything visual: no layout engine, no
 * physics, no randomness, no clock. The same events and filters always produce the same coordinates,
 * so the canvas can be asserted in a unit test rather than eyeballed, and a screenshot diff means a
 * real change rather than a re-run.
 *
 * ONE MODEL, TWO RENDERINGS. The canvas and the accessible table are built from this SAME structure —
 * not from two queries that happen to agree today. Semantic parity is the requirement, and the only
 * way to keep it true over time is to make divergence impossible to express: if a row exists in the
 * table it is because a node exists here, and vice versa.
 *
 * Read-only. Nothing in this module can mutate, kill, or retry anything — the surface offers no
 * destructive action because the model behind it cannot describe one.
 */

import type { ProjectedExecution, ExecutionProjection, ProjectedEdge } from "../executionGraph/executionProjection.js";
import type { ExecutionNodeKind, ExecutionState } from "../executionGraph/eventSchema.js";

/** Layout constants. Exported so the renderer cannot invent its own and drift from the tests. */
export const LANE_HEIGHT = 64;
export const COLUMN_WIDTH = 220;
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 40;

/**
 * The lanes, top to bottom. Ordered by causal depth rather than alphabetically: an agent's turn causes
 * a tool call, which causes a process. Reading down the canvas is reading the direction of causation.
 */
export const LANE_ORDER: readonly ExecutionNodeKind[] = [
  "Agent", "Session", "Turn", "ToolCall", "InternalOperation", "McpCall", "Process", "TmuxSession", "SystemdUnit",
];

export interface ExecutionGraphFilters {
  /** Restrict to one turn. Empty means every turn. */
  turnId?: string;
  /** Restrict to these lifecycle states. Empty means every state. */
  states?: readonly ExecutionState[];
  /** Restrict to these node kinds. Empty means every kind. */
  kinds?: readonly ExecutionNodeKind[];
  /** ISO instants; inclusive. A node is in range when its lifetime overlaps the window at all. */
  since?: string;
  until?: string;
  /** Restrict to one agent's claims. Empty means the whole workspace. */
  agentId?: string;
}

export interface ExecutionGraphNodeVm {
  executionId: string;
  kind: ExecutionNodeKind;
  state: ExecutionState;
  /** Short human label — the id is long and the canvas is narrow. */
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Facts the badge row shows without opening the detail panel. */
  shared: boolean;
  orphaned: boolean;
  unproven: boolean;
  exclusivelyOwned: boolean;
  agentIds: string[];
  /** How many executions this node stands for. > 1 when volume forced grouping. */
  groupSize: number;
  /** The ids this node stands for, so a grouped node can still be expanded or explained. */
  memberIds: string[];
}

export interface ExecutionGraphEdgeVm {
  from: string;
  to: string;
  kind: string;
  /** Both endpoints survived filtering; a dangling edge is dropped rather than drawn into nothing. */
  x1: number; y1: number; x2: number; y2: number;
}

/** One row of the accessible table. Same facts as the node, ordered for reading rather than drawing. */
export interface ExecutionGraphRowVm {
  executionId: string;
  kind: ExecutionNodeKind;
  state: ExecutionState;
  label: string;
  agents: string;
  attribution: "proven" | "shared" | "unproven";
  groupSize: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: string;
}

/** What the side panel shows for one selection. Every field is read-only evidence. */
export interface ExecutionGraphDetailVm {
  executionId: string;
  kind: ExecutionNodeKind;
  state: ExecutionState;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: string;
  agents: Array<{ agentId: string; attribution: "proven" | "unproven" }>;
  turnId?: string;
  toolCallId?: string;
  /** Where the work ran, when the ledger recorded it. Absent is shown as absent, never guessed. */
  cwd?: string;
  worktree?: string;
  /** Which tool started this, when it was a tool. */
  tool?: string;
  /** SDD 480's central claim, surfaced: how attribution was established, per agent. */
  identityProof: Array<{ agentId: string; provenance: string }>;
  memberIds: string[];
}

/**
 * The explicit states the section can be in.
 *
 * `no-telemetry` is deliberately NOT `empty`. An agent with the graph switched off and an agent that
 * genuinely did nothing look identical in an empty list, and telling a user "nothing ran" when the
 * truth is "nothing was recorded" is the confident-wrong-answer this spec exists to avoid.
 */
export type ExecutionGraphStatus = "ready" | "loading" | "empty" | "no-telemetry" | "error";

export interface ExecutionGraphVm {
  status: ExecutionGraphStatus;
  /** Present when status is `error`; already sanitized upstream. */
  errorDetail?: string;
  nodes: ExecutionGraphNodeVm[];
  edges: ExecutionGraphEdgeVm[];
  rows: ExecutionGraphRowVm[];
  /** Canvas extent, derived from the placed nodes so the renderer never guesses a viewBox. */
  width: number;
  height: number;
  /** Distinct values offered as filters, derived from the data actually present. */
  available: { turnIds: string[]; states: ExecutionState[]; kinds: ExecutionNodeKind[]; agentIds: string[] };
  /** How many executions matched before grouping — the honest total behind a grouped view. */
  matched: number;
  /** True when grouping collapsed anything, so the UI can say so rather than silently under-report. */
  grouped: boolean;
}

/** Beyond this many nodes in one lane, the tail is grouped so the canvas stays navigable. */
export const GROUP_THRESHOLD = 40;

function attributionOf(execution: ProjectedExecution): "proven" | "shared" | "unproven" {
  if (execution.shared) return "shared";
  return execution.unproven ? "unproven" : "proven";
}

function durationOf(execution: ProjectedExecution): number | undefined {
  const start = Date.parse(execution.firstSeenAt);
  const end = execution.exit ? Date.parse(execution.exit.at) : Date.parse(execution.lastSeenAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

/** A short, stable label. Never the raw id alone: `exec-<uuid>` tells a reader nothing. */
function labelOf(execution: ProjectedExecution): string {
  const tail = execution.executionId.replace(/^exec-/, "").slice(0, 8);
  return `${execution.node} ${tail}`;
}

function inWindow(execution: ProjectedExecution, since?: string, until?: string): boolean {
  const start = Date.parse(execution.firstSeenAt);
  const end = Date.parse(execution.lastSeenAt);
  if (since) {
    const from = Date.parse(since);
    // Overlap, not containment: an execution that started before the window but is still running
    // during it is very much part of what happened in that window.
    if (Number.isFinite(from) && Number.isFinite(end) && end < from) return false;
  }
  if (until) {
    const to = Date.parse(until);
    if (Number.isFinite(to) && Number.isFinite(start) && start > to) return false;
  }
  return true;
}

export function applyFilters(
  executions: readonly ProjectedExecution[],
  filters: ExecutionGraphFilters,
): ProjectedExecution[] {
  const states = filters.states?.length ? new Set(filters.states) : undefined;
  const kinds = filters.kinds?.length ? new Set(filters.kinds) : undefined;
  return executions.filter((execution) => {
    if (filters.turnId && execution.turnId !== filters.turnId) return false;
    if (states && !states.has(execution.state)) return false;
    if (kinds && !kinds.has(execution.node)) return false;
    if (filters.agentId && !execution.claims.some((claim) => claim.agentId === filters.agentId)) return false;
    return inWindow(execution, filters.since, filters.until);
  });
}

/**
 * Build the view-model.
 *
 * Placement is a pure function of (lane, index): lanes are rows in causal order, and within a lane
 * nodes are ordered by start time then id — the id tiebreak is what makes two executions that started
 * in the same millisecond land in a stable order instead of swapping between renders.
 */
export function buildExecutionGraphVm(input: {
  projection: ExecutionProjection;
  filters?: ExecutionGraphFilters;
  status?: ExecutionGraphStatus;
  errorDetail?: string;
  /** Details the ledger recorded per execution, keyed by id. Absent stays absent. */
  detailFor?: (executionId: string) => { cwd?: string; worktree?: string; tool?: string } | undefined;
  groupThreshold?: number;
}): ExecutionGraphVm {
  const { projection, filters = {}, status, errorDetail } = input;
  const threshold = input.groupThreshold ?? GROUP_THRESHOLD;

  const available = {
    turnIds: [...new Set(projection.executions.map((e) => e.turnId).filter((t): t is string => !!t))].sort(),
    states: [...new Set(projection.executions.map((e) => e.state))].sort() as ExecutionState[],
    kinds: [...new Set(projection.executions.map((e) => e.node))].sort() as ExecutionNodeKind[],
    agentIds: projection.agentIds,
  };

  if (status && status !== "ready") {
    return {
      status,
      ...(errorDetail ? { errorDetail } : {}),
      nodes: [], edges: [], rows: [], width: 0, height: 0, available, matched: 0, grouped: false,
    };
  }

  const matchedExecutions = applyFilters(projection.executions, filters);
  if (matchedExecutions.length === 0) {
    // `empty` here means "the filters matched nothing", which is a different statement from
    // "this workspace records no telemetry" — the caller supplies that one, because only it knows.
    return { status: "empty", nodes: [], edges: [], rows: [], width: 0, height: 0, available, matched: 0, grouped: false };
  }

  const byLane = new Map<ExecutionNodeKind, ProjectedExecution[]>();
  for (const execution of matchedExecutions) {
    const lane = byLane.get(execution.node) ?? [];
    lane.push(execution);
    byLane.set(execution.node, lane);
  }

  const nodes: ExecutionGraphNodeVm[] = [];
  const rows: ExecutionGraphRowVm[] = [];
  const placed = new Map<string, ExecutionGraphNodeVm>();
  let grouped = false;
  let laneIndex = 0;
  let widest = 0;

  for (const kind of LANE_ORDER) {
    const lane = byLane.get(kind);
    if (!lane || lane.length === 0) continue;
    // Start time then id: the tiebreak is what keeps two same-millisecond executions in a stable
    // order instead of swapping places between renders and producing a false visual diff.
    lane.sort((a, b) => (Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt)) || a.executionId.localeCompare(b.executionId));

    const shown = lane.slice(0, threshold);
    const overflow = lane.slice(threshold);
    let column = 0;
    for (const execution of shown) {
      const node = toNode(execution, column, laneIndex, 1, [execution.executionId]);
      nodes.push(node);
      placed.set(execution.executionId, node);
      rows.push(toRow(execution, 1));
      column += 1;
    }
    if (overflow.length > 0) {
      // The tail becomes ONE node that says how many it stands for. Silently truncating would make a
      // thousand-event graph look like a forty-event one, which is the failure mode of every naive
      // "top N" view: the picture stays readable and stops being true.
      grouped = true;
      const representative = overflow[0]!;
      const group = toNode(representative, column, laneIndex, overflow.length, overflow.map((e) => e.executionId));
      group.label = `${kind} +${overflow.length} more`;
      group.executionId = `group-${kind}-${laneIndex}`;
      nodes.push(group);
      rows.push({ ...toRow(representative, overflow.length), executionId: group.executionId, label: group.label });
      column += 1;
    }
    widest = Math.max(widest, column);
    laneIndex += 1;
  }

  const edges: ExecutionGraphEdgeVm[] = [];
  for (const edge of projection.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    // A dangling edge is dropped, never drawn to a phantom endpoint: a line into nothing reads as a
    // relationship to something the viewer cannot see, which is worse than no line.
    if (!from || !to) continue;
    edges.push({
      from: edge.from, to: edge.to, kind: edge.kind,
      x1: from.x + from.width / 2, y1: from.y + from.height / 2,
      x2: to.x + to.width / 2, y2: to.y + to.height / 2,
    });
  }

  return {
    status: "ready",
    nodes,
    edges,
    rows,
    width: Math.max(1, widest) * COLUMN_WIDTH,
    height: Math.max(1, laneIndex) * LANE_HEIGHT,
    available,
    matched: matchedExecutions.length,
    grouped,
  };

  function toNode(
    execution: ProjectedExecution,
    column: number,
    lane: number,
    groupSize: number,
    memberIds: string[],
  ): ExecutionGraphNodeVm {
    return {
      executionId: execution.executionId,
      kind: execution.node,
      state: execution.state,
      label: labelOf(execution),
      x: column * COLUMN_WIDTH,
      y: lane * LANE_HEIGHT,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      shared: execution.shared,
      orphaned: execution.orphaned,
      unproven: execution.unproven,
      exclusivelyOwned: execution.exclusivelyOwned,
      agentIds: execution.claims.map((claim) => claim.agentId),
      groupSize,
      memberIds,
    };
  }

  function toRow(execution: ProjectedExecution, groupSize: number): ExecutionGraphRowVm {
    const duration = durationOf(execution);
    return {
      executionId: execution.executionId,
      kind: execution.node,
      state: execution.state,
      label: labelOf(execution),
      agents: execution.claims.map((claim) => claim.agentId).join(", "),
      attribution: attributionOf(execution),
      groupSize,
      startedAt: execution.firstSeenAt,
      ...(execution.exit ? { endedAt: execution.exit.at } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(execution.exit?.code !== undefined ? { exitCode: execution.exit.code } : {}),
    };
  }
}

/** Build the side-panel detail for one execution, or undefined when it is not in the projection. */
export function buildExecutionDetailVm(
  projection: ExecutionProjection,
  executionId: string,
  detailFor?: (id: string) => { cwd?: string; worktree?: string; tool?: string } | undefined,
): ExecutionGraphDetailVm | undefined {
  const execution = projection.executions.find((e) => e.executionId === executionId);
  if (!execution) return undefined;
  const extra = detailFor?.(executionId) ?? {};
  const duration = durationOf(execution);
  return {
    executionId: execution.executionId,
    kind: execution.node,
    state: execution.state,
    startedAt: execution.firstSeenAt,
    ...(execution.exit ? { endedAt: execution.exit.at } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(execution.exit?.code !== undefined ? { exitCode: execution.exit.code } : {}),
    agents: execution.claims.map((claim) => ({
      agentId: claim.agentId,
      attribution: claim.provenance === "measured" ? "proven" as const : "unproven" as const,
    })),
    ...(execution.turnId ? { turnId: execution.turnId } : {}),
    ...(execution.toolCallId ? { toolCallId: execution.toolCallId } : {}),
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
    ...(extra.worktree ? { worktree: extra.worktree } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    // The proof itself, per agent, rather than one merged verdict — the same reason the projection
    // keeps provenance per claim (§4.3).
    identityProof: execution.claims.map((claim) => ({ agentId: claim.agentId, provenance: claim.provenance })),
    memberIds: [execution.executionId],
  };
}

/** Rows and nodes must describe the same set. Exported so the parity test can state it directly. */
export function semanticParity(vm: ExecutionGraphVm): { nodeIds: string[]; rowIds: string[]; equal: boolean } {
  const nodeIds = vm.nodes.map((n) => n.executionId).sort();
  const rowIds = vm.rows.map((r) => r.executionId).sort();
  return { nodeIds, rowIds, equal: nodeIds.length === rowIds.length && nodeIds.every((id, i) => id === rowIds[i]) };
}

export type { ProjectedEdge };
