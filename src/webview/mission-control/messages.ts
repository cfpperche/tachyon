/**
 * spec 335 — the SHARED host↔webview envelope for the Mission Control board. Pure module (no vscode, no
 * preact): imported by the host (MissionControlPanel), the webview (mission-control/main.tsx), and the dev
 * preview harness. Mirrors the handoff/pin-studio message-envelope convention (spec 278/280).
 */

import type { BoardSnapshot } from "../../tasks/boardSnapshot";
import type { TaskCreateInput, TaskUpdateInput } from "../../tasks/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export interface MissionControlVM {
  folder: string;
  wsHash: string;
  snapshot: BoardSnapshot;
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
  | { type: "createTask"; input: TaskCreateInput }
  | { type: "openTask"; id: string };

export const requestSnapshotAction = (): MissionControlAction => ({ type: "requestSnapshot" });
export const updateTaskAction = (id: string, patch: TaskUpdateInput): MissionControlAction => ({ type: "updateTask", id, patch });
export const createTaskAction = (input: TaskCreateInput): MissionControlAction => ({ type: "createTask", input });
export const openTaskAction = (id: string): MissionControlAction => ({ type: "openTask", id });
