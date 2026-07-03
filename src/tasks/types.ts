export const TASK_STATUSES = ["inbox", "triaged", "active", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [0, 1, 2, 3] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface ArtifactRef {
  type: string;
  ref: string;
}

export interface Task {
  id: string;
  title: string;
  body?: string;
  status: TaskStatus;
  priority?: TaskPriority;
  rank?: string;
  kind?: string;
  author: string;
  assignee?: string;
  artifact_refs?: ArtifactRef[];
  deps?: string[];
  createdAt: string;
  updatedAt: string;
}

export type SddStatus = "draft" | "in-progress" | "shipped" | "shipped-partial" | "superseded" | "abandoned" | "deferred";

export interface SddDerivedStage {
  type: "sdd";
  ref: string;
  status?: SddStatus;
  missing?: boolean;
}

export interface TaskDerived {
  sdd?: SddDerivedStage;
}

export type TaskAttentionCode =
  | "dangling_dep"
  | "missing_sdd_spec"
  | "ready_to_close"
  | "sdd_needs_retriage"
  | "corrupt_task";

export interface TaskAttention {
  code: TaskAttentionCode;
  message: string;
  ref?: string;
}

export interface TaskView {
  task: Task;
  derived?: TaskDerived;
  attention?: TaskAttention[];
}

export type TaskEmptyReason = "no-tasks" | "all-blocked" | "all-assigned-elsewhere";

export type NextTaskResult =
  | { task: Task; derived?: TaskDerived; attention?: TaskAttention[] }
  | { empty: true; reason: TaskEmptyReason };

export interface TaskUpdateExpect {
  assignee?: string | null;
  status?: TaskStatus;
  updatedAt?: string;
}

export interface TaskCreateInput {
  title: string;
  author: string;
  body?: string;
  priority?: TaskPriority;
  rank?: string;
  kind?: string;
  assignee?: string;
  artifact_refs?: ArtifactRef[];
  deps?: string[];
  now?: string;
}

export interface TaskUpdateInput {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  rank?: string | null;
  kind?: string | null;
  assignee?: string | null;
  artifact_refs?: ArtifactRef[] | null;
  deps?: string[] | null;
  expect?: TaskUpdateExpect;
  now?: string;
}

export const TASK_ID_RE = /^t-[0-9a-f]{6}$/;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return Number.isInteger(value) && (TASK_PRIORITIES as readonly number[]).includes(value as number);
}

