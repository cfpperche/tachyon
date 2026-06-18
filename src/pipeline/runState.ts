import type { PipelineDef } from "./loadPipeline.js";

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
  nodes: Record<string, NodeState>;
}

export function initRun(id: string, pipeline: PipelineDef, worktreeKey: string): PipelineRun {
  const nodes: Record<string, NodeState> = {};
  for (const nid of Object.keys(pipeline.nodes)) nodes[nid] = { status: "pending" };
  return { id, pipeline, worktreeKey, nodes };
}

/** Node ids ready to start: pending AND every dependency is done. */
export function runnableNodes(run: PipelineRun): string[] {
  return Object.keys(run.nodes).filter((id) => {
    if (run.nodes[id].status !== "pending") return false;
    return run.pipeline.nodes[id].needs.every((dep) => run.nodes[dep]?.status === "done");
  });
}

/** Transitive set of nodes that (directly or indirectly) depend on `nodeId`. */
function downstreamOf(run: PipelineRun, nodeId: string): string[] {
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
