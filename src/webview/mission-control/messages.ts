/**
 * spec 335 — the SHARED host↔webview envelope for the Mission Control board. Pure module (no vscode, no
 * preact): imported by the host (MissionControlPanel), the webview (mission-control/main.tsx), and the dev
 * preview harness. Mirrors the handoff/pin-studio message-envelope convention (spec 278/280).
 */

import type { BoardSnapshot } from "../../tasks/boardSnapshot";
import type { TaskPriority, TaskStatus, TaskUpdateInput } from "../../tasks/types";
import type { ValidationOutcome } from "../../validations/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export interface MissionControlVM {
  folder: string;
  wsHash: string;
  workspaces: MissionControlWorkspaceOption[];
  snapshot: BoardSnapshot;
}

export interface MissionControlWorkspaceOption {
  hash: string;
  folder: string;
}

/** host → webview: the assembled board snapshot (re-posted on refresh / onViewsChanged("tasks")). */
export const SNAPSHOT = "snapshot" as const;
export interface SnapshotMessage {
  type: typeof SNAPSHOT;
  vm: MissionControlVM;
}
export function snapshotMessage(vm: MissionControlVM): SnapshotMessage {
  return { type: SNAPSHOT, vm };
}

/** host → webview: a rejected mutation (CAS failure, store invariant, etc) — toast + (for drags) no DOM move
 *  to snap back from in the first place, since the board never optimistically reorders (spec's "no optimistic
 *  divergence" requirement — a fresh snapshot is the only thing that ever moves a card). */
export const TASK_ERROR = "taskError" as const;
export interface TaskErrorMessage {
  type: typeof TASK_ERROR;
  taskId?: string;
  message: string;
}
export function taskErrorMessage(message: string, taskId?: string): TaskErrorMessage {
  return { type: TASK_ERROR, message, ...(taskId ? { taskId } : {}) };
}

export type MissionControlHostMessage = SnapshotMessage | TaskErrorMessage;

/** webview → host actions. */
export type MissionControlAction =
  | { type: "ready" }
  | { type: "requestSnapshot" }
  | { type: "updateTask"; id: string; patch: TaskUpdateInput }
  /** spec 335 (Gated v1.1) — the board-side `resolveReorder` fallback when `between()` found no midpoint:
   *  a store-owned rebalance of the WHOLE status/priority lane (`TaskStore.reorderLane`), CAS-guarded per task. */
  | { type: "reorderLane"; status: TaskStatus; priority?: TaskPriority; orderedIds: string[]; expect: Record<string, string> }
  | { type: "closeValidation"; id: string; outcome: ValidationOutcome; result_note: string }
  | { type: "openTask"; id: string }
  | { type: "copyTaskId"; id: string }
  | { type: "switchWorkspace"; wsHash: string }
  /** spec 339 — opens Task Studio; omit `id` for a new task, pass it to edit an existing one. Replaces the
   *  board's former inline quick-add (createTask/CreateForm) as every create path now opens the Studio. */
  | { type: "openTaskStudio"; id?: string };

export const requestSnapshotAction = (): MissionControlAction => ({ type: "requestSnapshot" });
export const updateTaskAction = (id: string, patch: TaskUpdateInput): MissionControlAction => ({ type: "updateTask", id, patch });
export const reorderLaneAction = (status: TaskStatus, priority: TaskPriority | undefined, orderedIds: string[], expect: Record<string, string>): MissionControlAction => ({
  type: "reorderLane",
  status,
  ...(priority !== undefined ? { priority } : {}),
  orderedIds,
  expect,
});
export const closeValidationAction = (id: string, outcome: ValidationOutcome, result_note: string): MissionControlAction => ({ type: "closeValidation", id, outcome, result_note });
export const openTaskAction = (id: string): MissionControlAction => ({ type: "openTask", id });
export const copyTaskIdAction = (id: string): MissionControlAction => ({ type: "copyTaskId", id });
export const switchWorkspaceAction = (wsHash: string): MissionControlAction => ({ type: "switchWorkspace", wsHash });
export const openTaskStudioAction = (id?: string): MissionControlAction => ({ type: "openTaskStudio", ...(id ? { id } : {}) });
