import type { PipelineDef } from "./loadPipeline.js";
import type { UpstreamHandoff } from "./nodePrompt.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";

/**
 * spec 230 — pure pipeline-run state machine. Immutable transitions (each returns a NEW run); the
 * executor (PipelineManager) owns side effects and persistence. The done-contract decides WHEN a node's
 * work is complete; this module tracks the node/run lifecycle and the gate (human approval) + failure
 * cascade (downstream blocked, never silently wedged).
 */

export type NodeStatus = "pending" | "running" | "blocked" | "awaiting-approval" | "done" | "failed";
export interface NodeState {
  status: NodeStatus;
  reason?: string;
}
export type RunStatus = "running" | "completed" | "failed" | "paused";

export interface PipelineRun {
  id: string;
  pipeline: PipelineDef;
  worktreeKey: string;
  /** Durable recovery handle for crashes before the first node owns a session ledger row. */
  worktree?: WorktreeRecord;
  /** False while the allocation's Git quarantine receipt has not been durably finalized. */
  worktreeReady: boolean;
  nodes: Record<string, NodeState>;
  /** spec 231 — the run input snapshot (the issue), read once at start; ledger-canonical at runtime. */
  input?: string;
  /** spec 231 — attributed handoff summaries accumulated as nodes complete (sanitized/capped upstream). */
  summaries: UpstreamHandoff[];
}

export function initRun(
  id: string,
  pipeline: PipelineDef,
  worktreeKey: string,
  input?: string,
  worktree?: WorktreeRecord,
  worktreeReady = true,
): PipelineRun {
  const nodes: Record<string, NodeState> = {};
  for (const nid of Object.keys(pipeline.nodes)) nodes[nid] = { status: "pending" };
  return {
    id,
    pipeline,
    worktreeKey,
    ...(worktree ? { worktree } : {}),
    worktreeReady,
    nodes,
    ...(input !== undefined ? { input } : {}),
    summaries: [],
  };
}

/**
 * spec 231 — record an attributed handoff summary for a completed node (immutable; replaces any prior
 * record for the same node so a re-run can't double-append). The summary must already be sanitized/capped.
 */
export function recordHandoff(run: PipelineRun, nodeId: string, summary: string): PipelineRun {
  const kept = (run.summaries ?? []).filter((h) => h.nodeId !== nodeId);
  return { ...run, summaries: [...kept, { nodeId, summary }] };
}

/** spec 231 — drop handoff summaries for the given node ids (used on rerunFrom: reset node + downstream). */
export function pruneHandoffs(run: PipelineRun, nodeIds: readonly string[]): PipelineRun {
  const drop = new Set(nodeIds);
  return { ...run, summaries: (run.summaries ?? []).filter((h) => !drop.has(h.nodeId)) };
}

/** spec 231 — upstream summaries for `nodeId`, in dependency order (for the node prompt). */
export function upstreamHandoffs(run: PipelineRun, nodeId: string): UpstreamHandoff[] {
  const order = Object.keys(run.pipeline.nodes);
  const deps = new Set(dependenciesOf(run, nodeId));
  return order
    .filter((id) => deps.has(id))
    .map((id) => (run.summaries ?? []).find((h) => h.nodeId === id))
    .filter((h): h is UpstreamHandoff => !!h && h.summary.trim().length > 0);
}

/** Transitive set of nodes that `nodeId` depends on (directly or indirectly). */
export function dependenciesOf(run: PipelineRun, nodeId: string): string[] {
  const out = new Set<string>();
  const stack = [...(run.pipeline.nodes[nodeId]?.needs ?? [])];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const d of run.pipeline.nodes[cur]?.needs ?? []) stack.push(d);
  }
  return [...out];
}

/** Node ids ready to start: pending AND every dependency is done. */
export function runnableNodes(run: PipelineRun): string[] {
  return Object.keys(run.nodes).filter((id) => {
    if (run.nodes[id].status !== "pending") return false;
    return run.pipeline.nodes[id].needs.every((dep) => run.nodes[dep]?.status === "done");
  });
}

/** Transitive set of nodes that (directly or indirectly) depend on `nodeId`. */
export function downstreamOf(run: PipelineRun, nodeId: string): string[] {
  const dependents = new Map<string, string[]>();
  for (const [id, def] of Object.entries(run.pipeline.nodes)) {
    for (const dep of def.needs) {
      const list = dependents.get(dep) ?? [];
      list.push(id);
      dependents.set(dep, list);
    }
  }
  const out = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const d of dependents.get(cur) ?? []) {
      if (!out.has(d)) {
        out.add(d);
        stack.push(d);
      }
    }
  }
  return [...out];
}

function set(run: PipelineRun, nodeId: string, state: NodeState): PipelineRun {
  return { ...run, nodes: { ...run.nodes, [nodeId]: state } };
}

/** pending → running. */
export function startNode(run: PipelineRun, nodeId: string): PipelineRun {
  return set(run, nodeId, { status: "running" });
}

/** running → done, OR awaiting-approval when the node carries `gate: approve`. */
export function completeNode(run: PipelineRun, nodeId: string): PipelineRun {
  const gate = run.pipeline.nodes[nodeId].gate;
  return set(run, nodeId, { status: gate === "approve" ? "awaiting-approval" : "done" });
}

/** awaiting-approval → done. */
export function approveNode(run: PipelineRun, nodeId: string): PipelineRun {
  return set(run, nodeId, { status: "done" });
}

/** Reset a node back to `pending` (re-run-from-a-step; the caller resets the node + its downstream). */
export function resetNode(run: PipelineRun, nodeId: string): PipelineRun {
  return set(run, nodeId, { status: "pending" });
}

/** Mark a node failed and block every (still-pending) downstream node with the upstream reason. */
export function failNode(run: PipelineRun, nodeId: string, reason: string): PipelineRun {
  let next = set(run, nodeId, { status: "failed", reason });
  for (const d of downstreamOf(run, nodeId)) {
    if (next.nodes[d].status === "pending") {
      next = set(next, d, { status: "blocked", reason: `upstream '${nodeId}' failed` });
    }
  }
  return next;
}

/** awaiting-approval → failed (+ downstream blocked). */
export function rejectNode(run: PipelineRun, nodeId: string): PipelineRun {
  return failNode(run, nodeId, "rejected at approval gate");
}

/** Derived run-level status. failed wins; then all-done = completed; then a human gate = paused; else running. */
export function runStatus(run: PipelineRun): RunStatus {
  const states = Object.values(run.nodes).map((n) => n.status);
  if (states.includes("failed")) return "failed";
  if (states.every((s) => s === "done")) return "completed";
  if (states.includes("awaiting-approval")) return "paused";
  return "running";
}
