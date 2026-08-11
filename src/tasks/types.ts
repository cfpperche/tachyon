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
  /** Read-time compatibility alias of currentAssignee. Never persisted. */
  assignee?: string;
  /** Agent on the one open attempt, computed from the attempt ledger. Never persisted. */
  currentAssignee?: string;
  /** Agent on the most recent delivered attempt, computed from the attempt ledger. Never persisted. */
  lastDeliverer?: string;
  artifact_refs?: ArtifactRef[];
  deps?: string[];
  awaitingHuman?: TaskAwaitingHuman;
  createdAt: string;
  updatedAt: string;
}

export type TaskAttemptEndType = "released" | "delivered" | "dropped";
interface TaskAttemptEventBase {
  attemptId: string;
  agent: string;
  ts: string;
  evidence: string;
  /** Observed events are the default. Backfill explicitly identifies inference from a legacy field. */
  origin?: "observed" | "backfill";
  /** Backfill provenance only; this timestamp is not represented as the event observation time. */
  inferredFromUpdatedAt?: string;
}
export type TaskAttemptEvent =
  | (TaskAttemptEventBase & { type: "claimed" })
  | (TaskAttemptEventBase & { type: TaskAttemptEndType });

export interface JournalEntry {
  id: string;
  ts: string;
  author: string;
  text: string;
}

export type JournalMode = "tail" | "all" | "none";

/**
 * t-ab7708 — what a reader got, and what it did not get. `get_task` used to materialize every
 * journal entry unconditionally; measured across the harness transcripts the journal was 66.6% of
 * the tool's total cost and 90%+ of its worst calls. A window that bounds the payload is only
 * honest if the response says so, so this rides along with every journal read: `total` and
 * `returned` always, `truncated` whenever anything was withheld, and a `note` naming the argument
 * that fetches the rest.
 */
export interface JournalWindow {
  mode: JournalMode;
  /** entries in this response */
  returned: number;
  /** entries the journal holds */
  total: number;
  /** index of the first returned entry within the full journal */
  offset: number;
  truncated: boolean;
  /** byte ceiling applied to this window; absent when no ceiling was in play */
  maxBytes?: number;
  /** present only when something was withheld; names how to reach it */
  note?: string;
}

export type TaskAttentionCode =
  | "dangling_dep"
  | "corrupt_task"
  | "awaiting_human";

export interface TaskAttention {
  code: TaskAttentionCode;
  message: string;
  ref?: string;
}

/** Opaque transient stage bag (not persisted). */
export type TaskDerived = Record<string, unknown>;

export interface TaskView {
  task: Task;
  journal?: JournalEntry[];
  journalCount?: number;
  journalWindow?: JournalWindow;
  /** Present only on store/list paths; Board and Task Detail projections omit this. */
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
  /**
   * t-57a00a — who is making this change. NOT a field of the Task and never written to disk
   * (`applyUpdate` copies field by field, so it cannot leak); it only rides along to the mutation
   * event so a sink can tell "someone assigned this to you" from "you assigned it to yourself".
   */
  actor?: string;
}

/**
 * t-f638bd — the input to RECONCILING a task, which is not the input to transitioning one.
 *
 * `update` drives work: it moves a task through the lanes an operator walks. `active` means the work
 * has been selected for execution; an assignee, when present, names who is executing it now, while
 * active-without-assignee remains visible and claimable after ownership is released. Reconciling
 * records an outcome that already happened somewhere else — the branch landed, the SHA is in the
 * journal — and the store is being told about it, not asked to schedule it. Forcing that through
 * `update` made bookkeeping require a false active detour for work that was already over. Hence a
 * separate verb with its own, narrower table.
 */
export interface TaskReconcileInput {
  /** The outcome being recorded. Only the terminal-ish states — reconciling never re-opens work. */
  status: Extract<TaskStatus, "landed" | "done">;
  /** What makes this true outside the store: a SHA, a PR, a path. Required, and journalled verbatim. */
  evidence: string;
  expect?: TaskUpdateExpect;
  now?: string;
  /** As on TaskUpdateInput: who is recording this. Never persisted on the Task. */
  actor?: string;
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
