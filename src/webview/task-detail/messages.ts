/**
 * spec 335 — the SHARED host↔webview envelope for the Task Detail panel. Pure module (no vscode, no preact):
 * imported by the host (TaskDetailPanel), the webview (task-detail/main.tsx), and the dev preview harness.
 */

import type { JournalEntry, TaskAttention, TaskStatus, TaskUpdateInput } from "../../tasks/types";
import type { TaskPrototypeListVM } from "../task-prototype/types";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export interface TaskDepVM {
  id: string;
  title?: string;
  status?: TaskStatus;
  missing: boolean;
}

export interface TaskDetailTaskVM {
  id: string;
  title: string;
  body?: string;
  status: TaskStatus;
  priority?: number;
  kind?: string;
  author: string;
  assignee?: string;
  artifact_refs?: { type: string; ref: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailVM {
  wsHash: string;
  id: string;
  /** true once the task file disappeared or became unparseable — `task` (if present) is the LAST KNOWN state. */
  tombstone: boolean;
  task?: TaskDetailTaskVM;
  journal: JournalEntry[];
  attention?: TaskAttention[];
  deps: TaskDepVM[];
  prototypes?: TaskPrototypeListVM;
}

/** host → webview: the task snapshot (re-posted on refresh / onViewsChanged("tasks")), keyed by task id — the
 *  panel subscribes by id independently of any board filter (dueto F8). */
export const TASK = "task" as const;
export interface TaskMessage {
  type: typeof TASK;
  vm: TaskDetailVM;
}
export function taskMessage(vm: TaskDetailVM): TaskMessage {
  return { type: TASK, vm };
}

export const TASK_DETAIL_ERROR = "taskError" as const;
export interface TaskDetailErrorMessage {
  type: typeof TASK_DETAIL_ERROR;
  message: string;
}
export function taskDetailErrorMessage(message: string): TaskDetailErrorMessage {
  return { type: TASK_DETAIL_ERROR, message };
}

export type TaskDetailHostMessage = TaskMessage | TaskDetailErrorMessage;

/** webview → host actions. */
export type TaskDetailAction =
  | { type: "ready" }
  | { type: "requestSnapshot" }
  | { type: "updateTask"; patch: TaskUpdateInput }
  | { type: "openTask"; id: string }
  | { type: "approvePrototype"; prototypeId: string; expectUpdatedAt: string; review?: string }
  | { type: "rejectPrototype"; prototypeId: string; expectUpdatedAt: string; review?: string }
  | { type: "notePrototype"; prototypeId: string; expectUpdatedAt: string; review: string }
  /** spec 339 — opens Task Studio for THIS panel's own task (the detail tab's "Open in Studio" button). */
  | { type: "openTaskStudio" }
  | { type: "setTaskDocumentMode"; mode: TaskDocumentMode };

export type TaskDocumentMode = "read" | "edit";
export const TASK_DOCUMENT_MODE = "taskDocumentMode" as const;
export const taskDocumentModeMessage = (mode: TaskDocumentMode) => ({ type: TASK_DOCUMENT_MODE, mode });
export const setTaskDocumentModeAction = (mode: TaskDocumentMode): TaskDetailAction => ({ type: "setTaskDocumentMode", mode });

export const requestSnapshotAction = (): TaskDetailAction => ({ type: "requestSnapshot" });
export const updateTaskAction = (patch: TaskUpdateInput): TaskDetailAction => ({ type: "updateTask", patch });
export const openTaskAction = (id: string): TaskDetailAction => ({ type: "openTask", id });
export const openTaskStudioAction = (): TaskDetailAction => ({ type: "openTaskStudio" });
export const approvePrototypeAction = (prototypeId: string, expectUpdatedAt: string, review?: string): TaskDetailAction => ({ type: "approvePrototype", prototypeId, expectUpdatedAt, ...(review ? { review } : {}) });
export const rejectPrototypeAction = (prototypeId: string, expectUpdatedAt: string, review?: string): TaskDetailAction => ({ type: "rejectPrototype", prototypeId, expectUpdatedAt, ...(review ? { review } : {}) });
export const notePrototypeAction = (prototypeId: string, expectUpdatedAt: string, review: string): TaskDetailAction => ({ type: "notePrototype", prototypeId, expectUpdatedAt, review });
