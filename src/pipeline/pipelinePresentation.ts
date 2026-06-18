import type { NodeStatus, RunStatus } from "./runState.js";

/**
 * spec 230 — PURE presentation helpers for the pipeline sidebar (contextValue + icon mapping). Kept out
 * of the vscode-bound TreeItem so the menu-gating contract is unit-tested (the vscode-layer-escapes-CI
 * rule): the package.json `view/item/context` `when` clauses must match these exact strings.
 */

export const runContextValue = (status: RunStatus): string => `pipeline-run-${status}`;
export const nodeContextValue = (status: NodeStatus): string => `pipeline-node-${status}`;

/** A run may be cancelled while it is still progressing (running) or paused at a human gate. */
export const runCancellable = (status: RunStatus): boolean => status === "running" || status === "paused";

/** Approve/Reject apply ONLY to a node parked at a human approval gate. */
export const nodeApprovable = (status: NodeStatus): boolean => status === "awaiting-approval";

export function runIcon(status: RunStatus): string {
  switch (status) {
    case "running":
      return "sync~spin";
    case "paused":
      return "debug-pause";
    case "completed":
      return "pass-filled";
    case "failed":
      return "error";
  }
}

export function nodeIcon(status: NodeStatus): string {
  switch (status) {
    case "pending":
      return "circle-outline";
    case "running":
      return "sync~spin";
    case "blocked":
      return "circle-slash";
    case "awaiting-approval":
      return "question";
    case "done":
      return "check";
    case "failed":
      return "error";
  }
}
