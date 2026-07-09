export const TASK_STATUSES = ["inbox", "triaged", "active", "landed", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [0, 1, 2, 3] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const ARTIFACT_REF_ROLES = ["deliverable", "relation"] as const;
export type ArtifactRefRole = (typeof ARTIFACT_REF_ROLES)[number];

export interface ArtifactRef {
  type: string;
  ref: string;
  role?: ArtifactRefRole;
}

export const TASK_AWAITING_HUMAN_KINDS = ["decision", "validation", "dogfood"] as const;
export type TaskAwaitingHumanKind = (typeof TASK_AWAITING_HUMAN_KINDS)[number];

/** t-1339a8 — a first-class, AUTHORED (never derived) signal that a task is blocked on the human. Coexists
 *  with the Validations subsystem (a different, shipped-spec-audit workflow); this is honest-status-over-
 *  derive: the coordinator sets it when it hits a real block, `TaskStore.attentionFor` turns it into an
 *  `awaiting_human` attention so the board highlights via the existing rendering, and any status transition
 *  clears it automatically (a task that advances is no longer waiting). */
export interface TaskAwaitingHuman {
  reason: string;
  since: string;
  kind: TaskAwaitingHumanKind;
  /** Optional exact decision subject. Prototype decisions reconcile only this exact id; a generic decision
   * flag is never guessed to refer to whichever prototype happens to be visible. */
  subject?: { type: "task-prototype"; prototypeId: string };
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
  awaitingHuman?: TaskAwaitingHuman;
  createdAt: string;
  updatedAt: string;
}

export interface JournalEntry {
  id: string;
  ts: string;
  author: string;
  text: string;
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
  | "corrupt_task"
  | "awaiting_human";

export interface TaskAttention {
  code: TaskAttentionCode;
  message: string;
  ref?: string;
}

export interface TaskView {
  task: Task;
  journal?: JournalEntry[];
  journalCount?: number;
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
  /** spec 339 — pre-minted id for the Task Studio staged-create transaction; omit to auto-mint (default, unchanged). */
  id?: string;
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
  /** t-1339a8 — set/replace the authored human-blocked signal, or `null` to clear it explicitly. Any
   *  status transition in the same update (or a later one) clears it regardless — see `TaskStore.update`. */
  awaitingHuman?: TaskAwaitingHuman | null;
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

export function isTaskAwaitingHumanKind(value: unknown): value is TaskAwaitingHumanKind {
  return typeof value === "string" && (TASK_AWAITING_HUMAN_KINDS as readonly string[]).includes(value);
}
