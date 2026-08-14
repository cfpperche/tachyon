import { type PipelineRun, runnableNodes, completeNode, failNode } from "./runState.js";
import { evaluateDone, type NodeSignals } from "./doneContract.js";

/**
 * spec 230 — the PURE driver. Given the current run + per-node signals, it (1) applies the
 * signal-driven transitions for RUNNING nodes (done/failed via the done-contract) and (2) returns the
 * side-effect actions the executor (PipelineManager) should perform: spawn newly-runnable nodes.
 * No side effects.
 */

export type DriverAction = { type: "spawn"; nodeId: string };

export interface AdvanceResult {
  run: PipelineRun;
  actions: DriverAction[];
}

export function advance(
  run: PipelineRun,
  signals: Record<string, NodeSignals>,
): AdvanceResult {
  let next = run;
  const actions: DriverAction[] = [];

  // 1) resolve every running node from its signals
  for (const nodeId of Object.keys(next.nodes)) {
    if (next.nodes[nodeId].status !== "running") continue;
    const verdict = evaluateDone(next.pipeline.nodes[nodeId].done, signals[nodeId] ?? {});
    if (verdict.status === "done") {
      next = completeNode(next, nodeId);
    } else if (verdict.status === "failed") {
      next = failNode(next, nodeId, verdict.reason);
    }
  }

  // 2) spawn newly-runnable nodes (pending + all deps done)
  for (const nodeId of runnableNodes(next)) {
    actions.push({ type: "spawn", nodeId });
  }

  return { run: next, actions };
}
