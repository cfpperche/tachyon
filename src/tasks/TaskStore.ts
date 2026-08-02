import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sliceJournal, TaskJournalStore } from "./TaskJournalStore.js";
import { compareTasksForListing } from "./listOrder.js";
import { nextTask } from "./nextTask.js";
import { rebalancedRanks } from "./rank.js";
import {
  codePointLength,
  TASK_AUTHORING_LIMITS,
  taskAuthoringLimitMessage,
  type TaskAuthoringLimitField,
} from "./taskAuthoring.js";
import {
  isTaskAwaitingHumanKind,
  isTaskPriority,
  isTaskStatus,
  TASK_ID_RE,
  ARTIFACT_REF_ROLES,
  type ArtifactRef,
  type ArtifactRefRole,
  type NextTaskResult,
  type SddDerivedStage,
  type SddStatus,
  type Task,
  type TaskAttention,
  type TaskAwaitingHuman,
  type TaskCreateInput,
  type TaskDerived,
  type TaskPriority,
  type TaskReconcileInput,
  type TaskStatus,
  type TaskUpdateExpect,
  type TaskUpdateInput,
  type TaskView,
  type JournalMode,
} from "./types.js";

/** t-ab7708 — a journal read is either whole (`includeJournal`) or windowed (`journalWindow`). */
export interface TaskViewOptions {
  includeJournal?: boolean;
  journalWindow?: { mode: JournalMode; offset?: number; maxBytes?: number };
}

/** spec 335 (Gated v1.1) — input for `TaskStore.reorderLane`: the target lane's FULL membership in its final
 *  desired order (dragged task included), plus a per-task CAS `updatedAt` expectation from the snapshot the
 *  drag started from. Any mismatch (lane membership changed, or any task's `updatedAt` moved) rejects the
 *  WHOLE rebalance before a single byte is written — no partial writes (dueto F1/F2). */
export interface ReorderLaneInput {
  orderedIds: string[];
  expect: Record<string, string>;
  now?: string;
}

export interface TaskListOptions {
  offset?: number;
  status?: TaskStatus;
}

/** A committed update observation. Observers cannot change or fail the Task mutation result. */
export interface TaskMutationEvent {
  before: Task;
  after: Task;
  /**
   * t-57a00a — who made this change, when the caller knows. Never persisted on the Task: it exists so
   * a mutation sink can suppress notifying someone about their own action (spec 351's self-assign
   * rule), which is the one thing the Bridge handler knew and a store-level sink otherwise would not.
   * Absent for the UI writers, and correctly so — a human acting is never the assignee.
   */
  actor?: string;
}

export interface TaskStoreOptions {
  onMutation?: (event: TaskMutationEvent) => void | Promise<void>;
  evolutionCompletionFor?: (event: TaskMutationEvent) => Task["evolutionCompletion"];
}

const SDD_STATUSES = new Set<SddStatus>(["draft", "in-progress", "shipped", "shipped-partial", "superseded", "abandoned", "deferred"]);
const RETRIAGE_SDD = new Set<SddStatus>(["superseded", "abandoned", "deferred"]);
const TASK_AUTHORING_LIMIT_FIELDS = new Set<string>(["title", "body", "kind", "artifact_refs", "artifact_refs.type", "artifact_refs.ref"]);

// spec 335 — hoisted so the Mission Control board snapshot can compute per-task drag affordances from the SAME
// literal `assertTransition` enforces (one authority; the webview never re-encodes status-transition rules).
const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["triaged", "dropped"],
  // t-370286 — triaged → inbox returns a prematurely-triaged task for re-evaluation (real maintainer case,
  // first day of board use). Inbox's semantics relaxed from "never evaluated" to "needs (re-)evaluation";
  // the transition unscopes: the store clears `assignee` (forbidden in inbox) as part of the move.
  triaged: ["active", "dropped", "inbox"],
  active: ["landed", "done", "triaged", "dropped"],
  landed: ["done", "active", "triaged", "dropped"],
  done: ["triaged"],
  dropped: ["triaged"],
};

/** The statuses a task may transition to from `status`, per the store's transition authority. */
export function allowedTransitions(status: TaskStatus): TaskStatus[] {
  return TASK_STATUS_TRANSITIONS[status];
}

/**
 * t-f638bd — the RECONCILE table, deliberately not a relaxation of the one above.
 *
 * `TASK_STATUS_TRANSITIONS` describes work being driven: the lanes an operator walks a task
 * through, where `active` means a named someone is on it. Reconciling is the other operation —
 * recording that an outcome already happened elsewhere, with the evidence, when git drove the work
 * and the store is only keeping the books. Those need different tables because they answer
 * different questions, and collapsing them is what made bookkeeping require a false claim.
 *
 * What this table does NOT do is skip triage. `inbox` reconciles to nothing: a task nobody has
 * evaluated cannot be closed by asserting an outcome, because the question triage answers — is this
 * work we wanted? — is still open, and no SHA answers it. The lane structure survives; only the
 * assignee-and-active detour through it is removed. `landed -> done` stays reachable both ways since
 * both readings are honest there.
 */
const TASK_RECONCILE_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: [],
  triaged: ["landed", "done"],
  active: ["landed", "done"],
  landed: ["done"],
  done: [],
  dropped: [],
};

/** The outcomes that may be RECONCILED onto a task in `status` (see `TaskStore.reconcile`). */
export function allowedReconciliations(status: TaskStatus): TaskStatus[] {
  return TASK_RECONCILE_TRANSITIONS[status];
}

export class TaskStore {
  private mutation: Promise<void> = Promise.resolve();
  readonly journal: TaskJournalStore;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: TaskStoreOptions = {},
  ) {
    this.journal = new TaskJournalStore(workspaceRoot);
  }

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks");
  }

  async create(input: TaskCreateInput): Promise<Task> {
    return this.withMutation(async () => {
      const now = input.now ?? new Date().toISOString();
      const task: Omit<Task, "id"> = {
        title: boundedString(input.title, "title", TASK_AUTHORING_LIMITS.title),
        status: "inbox",
        author: boundedString(input.author || "human", "author", 64),
        createdAt: now,
        updatedAt: now,
        ...optionalStringField("body", input.body, TASK_AUTHORING_LIMITS.body),
        ...optionalPriority(input.priority),
        ...optionalStringField("rank", input.rank, 64),
        ...optionalStringField("kind", input.kind, TASK_AUTHORING_LIMITS.kind),
        ...optionalStringField("assignee", input.assignee, 64),
        ...optionalArtifactRefs(input.artifact_refs),
        ...optionalDeps(input.deps),
      };
      fs.mkdirSync(this.dir, { recursive: true });
      if (input.id !== undefined) {
        assertTaskId(input.id);
        return this.writeNewTask(input.id, task);
      }
      for (let i = 0; i < 20; i++) {
        try {
          return this.writeNewTask(mintTaskId(), task);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
      }
      throw new Error("could not mint a unique task id");
    });
  }

  private writeNewTask(id: string, task: Omit<Task, "id">): Task {
    const finalPath = this.pathFor(id);
    const tmp = `${finalPath}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ id, ...task }, null, 2)}\n`, "utf8");
    try {
      fs.linkSync(tmp, finalPath);
      fs.unlinkSync(tmp);
      return { id, ...task };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
      throw err;
    }
  }

  get(id: string): Task {
    assertTaskId(id);
    const task = this.readTask(id);
    if (!task) throw new Error(`unknown task '${id}'`);
    return task;
  }

  /**
   * `includeJournal` materializes the whole log — what Task Detail renders, because a human
   * scrolling a tab is not paying per token. `journalWindow` (t-ab7708) bounds it instead and says
   * what it withheld; that is the shape the Bridge tool reads through.
   */
  getView(id: string, options: TaskViewOptions = {}): TaskView {
    const task = this.get(id);
    return this.viewFor(task, this.listRaw(), options);
  }

  listRaw(): Task[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const tasks: Task[] = [];
    for (const name of names) {
      if (name.includes(".tmp.")) continue;
      if (!/^t-[0-9a-f]{6}\.json$/.test(name)) continue;
      const id = name.slice(0, -".json".length);
      const task = this.readTask(id);
      if (task) tasks.push(task);
    }
    tasks.sort(compareTasksForListing);
    return tasks;
  }

  listViews(limit = 100, options: TaskListOptions = {}): TaskView[] {
    const tasks = this.listRaw();
    const filtered = options.status ? tasks.filter((task) => task.status === options.status) : tasks;
    const offset = clampOffset(options.offset);
    return filtered.slice(offset, offset + clampLimit(limit)).map((task) => this.viewFor(task, tasks));
  }

  /** The store's true total, independent of any `listViews` limit/offset, so callers can page honestly. */
  count(options: Pick<TaskListOptions, "status"> = {}): number {
    const tasks = this.listRaw();
    return options.status ? tasks.filter((task) => task.status === options.status).length : tasks.length;
  }

  async update(id: string, input: TaskUpdateInput): Promise<Task> {
    return this.withMutation(async () => {
      assertTaskId(id);
      const current = this.get(id);
      assertExpect(current, input.expect);
      const next = applyUpdate(current, input);
      // t-370286 — returning a task to inbox unscopes it: assignee is forbidden in inbox, and forcing the
      // caller to clear it first would make the board's drop gesture fail on a task the user is explicitly
      // sending back for re-evaluation. The store clears it as part of the transition.
      if (next.status === "inbox" && current.status !== "inbox") delete next.assignee;
      // t-1339a8 — any status transition means the task advanced, so it is no longer waiting on the human;
      // clear the authored flag regardless of whether this same patch also tried to set/replace it.
      if (next.status !== current.status) delete next.awaitingHuman;
      if (next.status !== current.status) delete next.evolutionCompletion;
      if (current.status !== "done" && next.status === "done") {
        const marker = this.options.evolutionCompletionFor?.({ before: current, after: next });
        if (marker) next.evolutionCompletion = marker;
      }
      if (JSON.stringify({ ...current, updatedAt: next.updatedAt }) === JSON.stringify(next)) {
        throw new Error("update_task requires at least one changed field");
      }
      assertTransition(current, next, input);
      this.assertSddArtifactRefsUpdateAllowed(current, next, input);
      this.assertSddStatusUpdateAllowed(current, next, input);
      // spec 335 (Gated v1.1) — the board's reorder gesture is the only caller that ever sets a literal rank
      // string (a priority quick-edit always sends `rank:null`, dueto F5); guard against two concurrent drags
      // minting the identical midpoint between the same observed neighbors (dueto F2 — reject, never last-write).
      if (typeof input.rank === "string") this.assertNoRankCollision(next);
      this.writeTask(next);
      this.emitMutation({ before: current, after: next, ...(input.actor ? { actor: input.actor } : {}) });
      return next;
    });
  }

  /**
   * t-f638bd — record an outcome that already happened outside the store, with its evidence.
   *
   * The sibling of `update`, not a back door into it. It shares the write path, the CAS check, the
   * mutation event and the evolution marker, and differs in exactly the two ways the operation
   * differs: it consults `TASK_RECONCILE_TRANSITIONS` instead of the driving table, and it does not
   * require an assignee, because nobody is being asked to pick this up — it is already finished.
   * It touches no other field, so there is nothing here that `update` could not already refuse.
   *
   * The evidence is mandatory and journalled before the status moves, so a reconciliation that the
   * store accepts always leaves behind the reason it was accepted. A refusal names the state it
   * refused from; a compact receipt upstream must not turn that into silence.
   */
  async reconcile(id: string, input: TaskReconcileInput): Promise<Task> {
    return this.withMutation(async () => {
      assertTaskId(id);
      const current = this.get(id);
      assertExpect(current, input.expect);
      const evidence = boundedString(input.evidence, "evidence", 2000);
      if (current.status === input.status) {
        throw new Error(`task '${id}' is already '${input.status}'; nothing to reconcile`);
      }
      const allowed = allowedReconciliations(current.status);
      if (!allowed.includes(input.status)) {
        throw new Error(
          allowed.length === 0
            ? current.status === "inbox"
              ? `cannot reconcile an untriaged task: '${id}' is in inbox, and reconciling records an outcome rather than skipping triage — triage it first`
              : `cannot reconcile '${id}' from '${current.status}': it is already terminal`
            : `cannot reconcile '${id}' from '${current.status}' to '${input.status}'; allowed: ${allowed.join(", ")}`,
        );
      }
      const next: Task = { ...current, status: input.status, updatedAt: input.now ?? new Date().toISOString() };
      // Same two derived clears `update` performs on any status move: an advancing task is no longer
      // waiting on the human, and the completion marker is recomputed rather than carried.
      delete next.awaitingHuman;
      delete next.evolutionCompletion;
      if (input.status === "done") {
        const marker = this.options.evolutionCompletionFor?.({ before: current, after: next });
        if (marker) next.evolutionCompletion = marker;
      }
      // Journal first: if the cap rejects the evidence, the status has not moved and the caller is
      // told why, rather than getting a silent reconciliation with no record of what made it true.
      this.journal.append(id, { author: input.actor ?? "human", text: `reconciled ${current.status} -> ${input.status}: ${evidence}` });
      this.writeTask(next);
      this.emitMutation({ before: current, after: next, ...(input.actor ? { actor: input.actor } : {}) });
      return next;
    });
  }

  /** spec 335 (Gated v1.1) — store-owned rebalance: rewrites every rank in ONE status/priority lane atomically
   *  under the mutation lock, when the board's `between()` midpoint mint found no room between two neighbors.
   *  Validates lane membership and every task's CAS `updatedAt` BEFORE writing anything (dueto F1/F2/F3: a stale
   *  or changed lane rejects the whole operation, never a partial rewrite). */
  async reorderLane(status: TaskStatus, priority: TaskPriority | undefined, input: ReorderLaneInput): Promise<Task[]> {
    return this.withMutation(async () => {
      const tasks = this.listRaw();
      const lane = tasks.filter((t) => t.status === status && (t.priority ?? undefined) === priority);
      const laneIds = new Set(lane.map((t) => t.id));
      const requestedIds = new Set(input.orderedIds);
      if (requestedIds.size !== input.orderedIds.length || laneIds.size !== requestedIds.size || [...laneIds].some((id) => !requestedIds.has(id))) {
        throw new Error("precondition-failed: lane membership changed");
      }
      for (const task of lane) {
        if (input.expect[task.id] !== task.updatedAt) {
          throw new Error(`precondition-failed: updatedAt did not match for '${task.id}'`);
        }
      }
      const ranks = rebalancedRanks(input.orderedIds.length);
      const now = input.now ?? new Date().toISOString();
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const rewritten = input.orderedIds.map((id, i) => ({ ...byId.get(id)!, rank: ranks[i]!, updatedAt: now }));
      for (const task of rewritten) this.writeTask(task);
      return rewritten;
    });
  }

  next(agent: string): NextTaskResult {
    const tasks = this.listRaw();
    const derived: Record<string, TaskDerived> = {};
    for (const task of tasks) {
      const d = this.derive(task);
      if (d) derived[task.id] = d;
    }
    const result = nextTask({ tasks, agent, derived });
    if ("task" in result) {
      const view = this.viewFor(result.task, tasks);
      return { task: result.task, ...(view.derived ? { derived: view.derived } : {}), ...(view.attention?.length ? { attention: view.attention } : {}) };
    }
    return result;
  }

  pathFor(id: string): string {
    assertTaskId(id);
    return path.join(this.dir, `${id}.json`);
  }

  private readTask(id: string): Task | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pathFor(id), "utf8")) as unknown;
      return normalizeTask(parsed, id);
    } catch {
      return null;
    }
  }

  private writeTask(task: Task): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.pathFor(task.id);
    const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
  }

  private emitMutation(event: TaskMutationEvent): void {
    try {
      void Promise.resolve(this.options.onMutation?.(event)).catch(() => undefined);
    } catch {
      // The Task is already committed; evolution/notification observers are best-effort side effects.
    }
  }

  private viewFor(task: Task, allTasks: Task[], options: TaskViewOptions = {}): TaskView {
    const derived = this.derive(task);
    const attention = attentionFor(task, allTasks, derived);
    const wantsJournal = options.includeJournal || options.journalWindow !== undefined;
    // Read once: count and window come from the same materialization, so a concurrent append
    // cannot make the declared total disagree with the entries beside it.
    const entries = wantsJournal ? this.journal.read(task.id) : undefined;
    const journalCount = entries ? entries.length : this.journal.count(task.id);
    const sliced = entries && options.journalWindow ? sliceJournal(entries, options.journalWindow) : undefined;
    return {
      task,
      ...(entries ? { journal: sliced ? sliced.entries : entries } : {}),
      ...(sliced ? { journalWindow: sliced.window } : {}),
      journalCount,
      ...(derived ? { derived } : {}),
      ...(attention.length ? { attention } : {}),
    };
  }

  private derive(task: Task): TaskDerived | undefined {
    const sddRef = task.artifact_refs?.find((ref) => ref.type === "sdd" && artifactRefRole(ref) === "deliverable");
    if (!sddRef) return undefined;
    const specPath = this.resolveSddSpec(sddRef.ref);
    if (!specPath) return { sdd: { type: "sdd", ref: sddRef.ref, missing: true } };
    const status = readSddStatus(specPath);
    return { sdd: { type: "sdd", ref: sddRef.ref, ...(status ? { status } : {}) } };
  }

  private resolveSddSpec(ref: string): string | null {
    const clean = ref.trim().replace(/^docs\/specs\//, "").replace(/\/spec\.md$/, "").replace(/\/$/, "");
    const specsDir = path.join(this.workspaceRoot, "docs", "specs");
    const exact = path.join(specsDir, clean, "spec.md");
    if (fs.existsSync(exact)) return exact;
    if (/^[0-9]{3}$/.test(clean)) {
      try {
        const match = fs.readdirSync(specsDir).find((name) => name.startsWith(`${clean}-`) && fs.existsSync(path.join(specsDir, name, "spec.md")));
        return match ? path.join(specsDir, match, "spec.md") : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private assertSddStatusUpdateAllowed(current: Task, next: Task, input: TaskUpdateInput): void {
    if (input.status !== "done") return;
    for (const sdd of [this.sddStage(current), this.sddStage(next)]) {
      if (sdd?.status && sdd.status !== "shipped") throw new Error(`task '${next.id}' cannot be marked done while SDD artifact '${sdd.ref}' is ${sdd.status}`);
    }
  }

  private assertSddArtifactRefsUpdateAllowed(current: Task, next: Task, input: TaskUpdateInput): void {
    if (!("artifact_refs" in input)) return;
    const currentSdd = this.sddStage(current);
    const nextSdd = this.sddStage(next);
    if (currentSdd?.ref === nextSdd?.ref) return;
    if (currentSdd?.status && next.status !== "triaged") {
      throw new Error(`SDD artifact '${currentSdd.ref}' can be cleared or replaced only while task is triaged`);
    }
    if (nextSdd && next.status !== "triaged" && next.status !== "active") {
      throw new Error("SDD artifact refs can be set only while task is triaged or active");
    }
  }

  private sddStage(task: Task): SddDerivedStage | undefined {
    return this.derive(task)?.sdd;
  }

  private assertNoRankCollision(next: Task): void {
    const collision = this.listRaw().some(
      (t) => t.id !== next.id && t.status === next.status && (t.priority ?? undefined) === (next.priority ?? undefined) && t.rank === next.rank,
    );
    if (collision) {
      throw new Error(`precondition-failed: rank collision in ${next.status}${next.priority !== undefined ? `/p${next.priority}` : ""} lane`);
    }
  }

  private async withMutation<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function taskSummary(view: TaskView): Omit<Task, "body"> & { attention?: TaskAttention[]; derived?: TaskDerived; journalCount?: number } {
  const { body: _body, ...task } = view.task;
  return { ...task, ...(view.journalCount !== undefined ? { journalCount: view.journalCount } : {}), ...(view.derived ? { derived: view.derived } : {}), ...(view.attention?.length ? { attention: view.attention } : {}) };
}

/** spec 339 — exported so Task Studio can reserve a provisional id for its attachment namespace BEFORE the
 * task exists (staged create transaction); `TaskStore.create({ id })` then uses that exact id. */
export function mintTaskId(): string {
  return `t-${crypto.randomBytes(3).toString("hex")}`;
}

function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id '${id}'`);
}

function normalizeTask(input: unknown, expectedId: string): Task | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<Task>;
  if (row.id !== expectedId || !isTaskStatus(row.status) || typeof row.title !== "string" || typeof row.author !== "string" || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") return null;
  if (row.priority !== undefined && !isTaskPriority(row.priority)) return null;
  return {
    id: row.id,
    title: boundedString(row.title, "title", TASK_AUTHORING_LIMITS.title),
    ...(typeof row.body === "string" ? optionalStringField("body", row.body, TASK_AUTHORING_LIMITS.body) : {}),
    status: row.status,
    ...(row.priority !== undefined ? { priority: row.priority } : {}),
    ...(typeof row.rank === "string" ? optionalStringField("rank", row.rank, 64) : {}),
    ...(typeof row.kind === "string" ? optionalStringField("kind", row.kind, TASK_AUTHORING_LIMITS.kind) : {}),
    author: boundedString(row.author, "author", 64),
    ...(typeof row.assignee === "string" ? optionalStringField("assignee", row.assignee, 64) : {}),
    ...optionalArtifactRefs(row.artifact_refs),
    ...optionalDeps(row.deps),
    // t-1339a8 — backward-compatible: task JSON written before this field existed just has no key here.
    ...(row.awaitingHuman !== undefined ? optionalAwaitingHuman(row.awaitingHuman) : {}),
    ...(row.evolutionCompletion !== undefined ? optionalEvolutionCompletion(row.evolutionCompletion) : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function optionalEvolutionCompletion(value: unknown): Pick<Task, "evolutionCompletion"> {
  if (!value || typeof value !== "object") return {};
  const marker = value as { agent?: unknown; revision?: unknown };
  if (typeof marker.agent !== "string" || marker.agent.length === 0 || marker.agent.length > 64
    || typeof marker.revision !== "string" || !/^[0-9a-f]{64}$/.test(marker.revision)) return {};
  return { evolutionCompletion: { agent: marker.agent, revision: marker.revision } };
}

function applyUpdate(current: Task, input: TaskUpdateInput): Task {
  const now = input.now ?? new Date().toISOString();
  const next: Task = { ...current, updatedAt: now };
  if (input.title !== undefined) next.title = boundedString(input.title, "title", TASK_AUTHORING_LIMITS.title);
  if (input.body !== undefined) {
    if (input.body === null) delete next.body;
    else Object.assign(next, optionalStringField("body", input.body, TASK_AUTHORING_LIMITS.body));
  }
  if (input.status !== undefined) {
    if (!isTaskStatus(input.status)) throw new Error(`invalid task status '${String(input.status)}'`);
    next.status = input.status;
  }
  if (input.priority !== undefined) {
    if (input.priority === null) delete next.priority;
    else {
      if (!isTaskPriority(input.priority)) throw new Error("priority must be an integer 0..3");
      next.priority = input.priority;
    }
  }
  applyOptionalStringPatch(next, "rank", input.rank, 64);
  applyOptionalStringPatch(next, "kind", input.kind, TASK_AUTHORING_LIMITS.kind);
  applyOptionalStringPatch(next, "assignee", input.assignee, 64);
  if (input.artifact_refs !== undefined) {
    if (input.artifact_refs === null) delete next.artifact_refs;
    else Object.assign(next, optionalArtifactRefs(input.artifact_refs));
  }
  if (input.deps !== undefined) {
    if (input.deps === null) delete next.deps;
    else Object.assign(next, optionalDeps(input.deps));
  }
  if (input.awaitingHuman !== undefined) {
    if (input.awaitingHuman === null) delete next.awaitingHuman;
    else Object.assign(next, optionalAwaitingHuman(input.awaitingHuman));
  }
  return next;
}

function applyOptionalStringPatch<T extends "rank" | "kind" | "assignee">(task: Task, key: T, value: string | null | undefined, max: number): void {
  if (value === undefined) return;
  if (value === null) delete task[key];
  else Object.assign(task, optionalStringField(key, value, max));
}

function assertExpect(task: Task, expect?: TaskUpdateExpect): void {
  if (!expect) return;
  if ("assignee" in expect && (task.assignee ?? null) !== (expect.assignee ?? null)) throw new Error("precondition-failed: assignee did not match");
  if (expect.status !== undefined && task.status !== expect.status) throw new Error("precondition-failed: status did not match");
  if (expect.updatedAt !== undefined && task.updatedAt !== expect.updatedAt) throw new Error("precondition-failed: updatedAt did not match");
}

/**
 * t-57a00a — the keys of `TaskUpdateInput` that are CALL METADATA, not fields of the task.
 *
 * `assertTransition` counts everything else as a field edit, so a key added here without being listed
 * silently turns every update on a terminal task into a refusal. That is not hypothetical: adding
 * `actor` broke `landed -> done` for every agent caller, because the Bridge now attaches it to the
 * patch and the counter read it as "you are editing a landed task".
 */
const TASK_UPDATE_METADATA_KEYS: ReadonlySet<keyof TaskUpdateInput> = new Set(["now", "expect", "status", "actor"]);

function assertTransition(current: Task, next: Task, input: TaskUpdateInput): void {
  const mutable = new Set<TaskStatus>(["inbox", "triaged", "active"]);
  const changedFields = Object.keys(input).filter((key) => !TASK_UPDATE_METADATA_KEYS.has(key as keyof TaskUpdateInput));
  if (changedFields.length && !mutable.has(current.status)) throw new Error(`task fields are immutable while status is '${current.status}'`);
  if ("assignee" in input && next.status !== "triaged" && next.status !== "active") throw new Error("assignee is mutable only in triaged/active tasks");
  if (next.status === "active" && !next.assignee) throw new Error("active tasks require assignee");
  if (current.status === next.status) return;
  if (!allowedTransitions(current.status).includes(next.status)) throw new Error(`invalid status transition ${current.status} -> ${next.status}`);
}

function attentionFor(task: Task, allTasks: Task[], derived?: TaskDerived): TaskAttention[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const attention: TaskAttention[] = [];
  // t-1339a8 — authored-only signal (never heuristically derived): the coordinator's own `awaitingHuman`
  // field is the source of truth; this just projects it into the SAME attention rendering the board already
  // has for dangling_dep/ready_to_close/etc, so highlighting comes for free.
  if (task.awaitingHuman) attention.push({ code: "awaiting_human", message: task.awaitingHuman.reason });
  for (const dep of task.deps ?? []) {
    if (!byId.has(dep)) attention.push({ code: "dangling_dep", message: `dependency '${dep}' does not exist`, ref: dep });
  }
  const sdd = derived?.sdd;
  if (sdd?.missing) attention.push({ code: "missing_sdd_spec", message: `SDD artifact '${sdd.ref}' was not found`, ref: sdd.ref });
  if (task.status === "landed" && sdd?.status === "shipped") attention.push({ code: "ready_to_close", message: `SDD artifact '${sdd.ref}' is shipped; close the task explicitly`, ref: sdd.ref });
  if (task.status === "active" && sdd?.status && RETRIAGE_SDD.has(sdd.status)) {
    attention.push({ code: "sdd_needs_retriage", message: `SDD artifact '${sdd.ref}' is ${sdd.status}; retriage the task`, ref: sdd.ref });
  }
  return attention;
}

function readSddStatus(specPath: string): SddStatus | undefined {
  try {
    const text = fs.readFileSync(specPath, "utf8");
    const match = /^\*\*Status:\*\*\s*([a-z-]+)/m.exec(text);
    const status = match?.[1];
    return status && SDD_STATUSES.has(status as SddStatus) ? (status as SddStatus) : undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value: string, name: string, max: number): string {
  const out = value.trim();
  if (!out) throw new Error(`${name} must be non-empty`);
  const received = codePointLength(out);
  if (received > max) {
    if (isTaskAuthoringLimitField(name)) throw new Error(taskAuthoringLimitMessage(name, received, max));
    throw new Error(`${name} received ${received} code points; maximum ${max}`);
  }
  return out;
}

function isTaskAuthoringLimitField(name: string): name is TaskAuthoringLimitField {
  return TASK_AUTHORING_LIMIT_FIELDS.has(name);
}

function optionalStringField<K extends "body" | "rank" | "kind" | "assignee" | "author" | "title">(key: K, value: string | undefined, max: number): Pick<Task, K> | {} {
  if (value === undefined) return {};
  return { [key]: boundedString(value, key, max) } as Pick<Task, K>;
}

function optionalPriority(priority: TaskCreateInput["priority"]): Pick<Task, "priority"> | {} {
  if (priority === undefined) return {};
  if (!isTaskPriority(priority)) throw new Error("priority must be an integer 0..3");
  return { priority };
}

function optionalArtifactRefs(refs: ArtifactRef[] | undefined): Pick<Task, "artifact_refs"> | {} {
  if (refs === undefined) return {};
  if (!Array.isArray(refs)) throw new Error("artifact_refs must be an array");
  if (refs.length > TASK_AUTHORING_LIMITS.artifactRefs) {
    throw new Error(taskAuthoringLimitMessage("artifact_refs", refs.length, TASK_AUTHORING_LIMITS.artifactRefs));
  }
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw new Error("artifact_refs entries must be objects");
    const type = boundedString(String((ref as ArtifactRef).type ?? ""), "artifact_refs.type", TASK_AUTHORING_LIMITS.artifactRefType);
    const value = boundedString(String((ref as ArtifactRef).ref ?? ""), "artifact_refs.ref", TASK_AUTHORING_LIMITS.artifactRefValue);
    const role = optionalArtifactRefRole((ref as ArtifactRef).role);
    const key = `${type}\0${value}`;
    if (seen.has(key)) throw new Error(`duplicate artifact_ref '${type}:${value}'`);
    seen.add(key);
    out.push({ type, ref: value, ...(role ? { role } : {}) });
  }
  return out.length ? { artifact_refs: out } : {};
}

function artifactRefRole(ref: ArtifactRef): ArtifactRefRole {
  return ref.role ?? "deliverable";
}

function optionalArtifactRefRole(role: ArtifactRef["role"]): ArtifactRefRole | undefined {
  if (role === undefined) return undefined;
  if (typeof role !== "string" || !(ARTIFACT_REF_ROLES as readonly string[]).includes(role)) {
    throw new Error("artifact_refs.role must be 'deliverable' or 'relation'");
  }
  return role;
}

function optionalDeps(deps: string[] | undefined): Pick<Task, "deps"> | {} {
  if (deps === undefined) return {};
  if (!Array.isArray(deps)) throw new Error("deps must be an array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dep of deps) {
    const id = String(dep).trim();
    assertTaskId(id);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.length ? { deps: out } : {};
}

function optionalAwaitingHuman(value: unknown): Pick<Task, "awaitingHuman"> | {} {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new Error("awaitingHuman must be an object");
  const row = value as Partial<TaskAwaitingHuman>;
  if (typeof row.reason !== "string" || typeof row.since !== "string" || !isTaskAwaitingHumanKind(row.kind)) {
    throw new Error("awaitingHuman must be { reason: string, since: string, kind: 'decision'|'validation'|'dogfood' }");
  }
  let subject: TaskAwaitingHuman["subject"];
  if (row.subject !== undefined) {
    if (!row.subject || typeof row.subject !== "object") throw new Error("awaitingHuman.subject must be a task prototype subject");
    const candidate = row.subject as { type?: unknown; prototypeId?: unknown };
    if (candidate.type !== "task-prototype" || typeof candidate.prototypeId !== "string" || !/^p-[0-9a-f]{12}$/.test(candidate.prototypeId)) {
      throw new Error("awaitingHuman.subject must be { type: 'task-prototype', prototypeId: 'p-<12hex>' }");
    }
    subject = { type: "task-prototype", prototypeId: candidate.prototypeId };
  }
  return { awaitingHuman: { reason: boundedString(row.reason, "awaitingHuman.reason", 2000), since: row.since, kind: row.kind, ...(subject ? { subject } : {}) } };
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 500);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}
