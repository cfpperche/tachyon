import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadManagedWorktreeStore, managedWorktreeStorePath } from "../worktree/managedWorktree.js";
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
  TASK_STATUSES,
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

export interface ReturnUnavailableAgentClaimsInput {
  evidence: string;
  actor?: string;
  now?: string;
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

interface TaskDerivationBatch {
  managedSddWorkspaceRoots?: string[];
}

const SDD_STATUSES = new Set<SddStatus>(["draft", "in-progress", "shipped", "shipped-partial", "superseded", "abandoned", "deferred"]);
const RETRIAGE_SDD = new Set<SddStatus>(["superseded", "abandoned", "deferred"]);
const TASK_AUTHORING_LIMIT_FIELDS = new Set<string>(["title", "body", "kind", "artifact_refs", "artifact_refs.type", "artifact_refs.ref"]);

// spec 335 — hoisted so the Board snapshot can compute per-task drag affordances from the SAME
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
  private readonly listCache = new Map<string, { signature: TaskFileSignature; read: TaskRead }>();
  private cachedListing: Task[] | undefined;
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

  /**
   * t-c2882f — `unknown task` is reserved for a task that is genuinely NOT THERE.
   *
   * A record that exists on disk and cannot be served says exactly that, and names the file and the
   * defect. The old message was factually false for the three tasks this was filed on: valid ids,
   * valid statuses, whole content, and an answer that sent every reader looking for something that
   * was never created instead of at the file sitting in the tasks directory.
   */
  get(id: string): Task {
    assertTaskId(id);
    const read = this.loadTask(id);
    if (read.ok) return read.task;
    if (read.absent) throw new Error(`unknown task '${id}'`);
    throw new Error(unservableTaskMessage(id, this.pathFor(id), read.defect));
  }

  /** Read one task when it exists, without turning absence into an error or scanning the board. */
  find(id: string): Task | undefined {
    assertTaskId(id);
    const read = this.loadTask(id);
    if (read.ok) return read.task;
    if (read.absent) return undefined;
    throw new Error(unservableTaskMessage(id, this.pathFor(id), read.defect));
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
    const present = new Set<string>();
    let changed = false;
    for (const name of names) {
      if (name.includes(".tmp.")) continue;
      if (!/^t-[0-9a-f]{6}\.json$/.test(name)) continue;
      const id = name.slice(0, -".json".length);
      const signature = this.fileSignature(id);
      if (signature === undefined) continue;
      present.add(id);
      let cached = this.listCache.get(id);
      if (!cached || !sameTaskFileSignature(cached.signature, signature)) {
        cached = { signature, read: freezeSuccessfulRead(this.loadTask(id)) };
        this.listCache.set(id, cached);
        changed = true;
      }
    }
    for (const id of this.listCache.keys()) {
      if (!present.has(id)) {
        this.listCache.delete(id);
        changed = true;
      }
    }
    if (!changed && this.cachedListing) return this.cachedListing;
    const tasks: Task[] = [];
    for (const cached of this.listCache.values()) {
      if (cached.read.ok) tasks.push(cached.read.task);
    }
    tasks.sort(compareTasksForListing);
    this.cachedListing = Object.freeze(tasks) as Task[];
    return this.cachedListing;
  }

  listViews(limit = 100, options: TaskListOptions = {}): TaskView[] {
    const tasks = this.listRaw();
    const filtered = options.status ? tasks.filter((task) => task.status === options.status) : tasks;
    const offset = clampOffset(options.offset);
    const derivationBatch: TaskDerivationBatch = {};
    return filtered.slice(offset, offset + clampLimit(limit)).map((task) => this.viewFor(task, tasks, {}, derivationBatch));
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
      // t-f33480 — a status move is a weighty mutation; leave author + reason in the journal the same
      // way reconcile does. Without this, triage (and every other lane change) only moved updatedAt,
      // so "who triaged, and why" was invisible even when the Bridge had a resolved caller. Journal
      // first: if the cap refuses, the status has not moved.
      if (next.status !== current.status) {
        const reasonParts = [`status ${current.status} -> ${next.status}`];
        if ("priority" in input && input.priority !== undefined) {
          const fromPri = current.priority === undefined ? "none" : String(current.priority);
          const toPri = input.priority === null ? "none" : String(input.priority);
          if (fromPri !== toPri) reasonParts.push(`priority ${fromPri} -> ${toPri}`);
        }
        this.journal.append(id, {
          author: input.actor ?? "human",
          text: reasonParts.join("; "),
        });
      }
      this.writeTask(next);
      this.emitMutation({ before: current, after: next, ...(input.actor ? { actor: input.actor } : {}) });
      return next;
    });
  }

  /**
   * Return every active claim held by an agent that is no longer executing.
   *
   * This is a lifecycle reconciliation, not completion: process death proves only that this agent is
   * no longer working the claim. The task stays active, its assignee is cleared, and the reason is
   * journalled before the task write. Active-without-assignee means "claimed work, nobody executing";
   * it is claimable again without asserting that the work was or was not delivered. Keeping this in
   * the store gives crash observation, deliberate stop and startup recovery one serialized door.
   */
  async returnUnavailableAgentClaims(agent: string, input: ReturnUnavailableAgentClaimsInput): Promise<Task[]> {
    return this.withMutation(async () => {
      const assignee = boundedString(agent, "assignee", 64);
      const evidence = boundedString(input.evidence, "evidence", 2000);
      const actor = boundedString(input.actor ?? "tachyon", "actor", 64);
      const now = input.now ?? new Date().toISOString();
      const current = this.listRaw().filter((task) => task.status === "active" && task.assignee === assignee);
      const returned: Task[] = [];

      for (const task of current) {
        const next: Task = { ...task, updatedAt: now };
        delete next.assignee;
        this.journal.append(task.id, {
          author: actor,
          text: `ownership released; status remains active; assignee '${assignee}' cleared: ${evidence}`,
        });
        this.writeTask(next);
        this.emitMutation({ before: task, after: next, actor });
        returned.push(next);
      }

      return returned;
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
    const derivationBatch: TaskDerivationBatch = {};
    for (const task of tasks) {
      const d = this.derive(task, derivationBatch);
      if (d) derived[task.id] = d;
    }
    const result = nextTask({ tasks, agent, derived });
    if ("task" in result) {
      const view = this.viewFor(result.task, tasks, {}, derivationBatch);
      return { task: result.task, ...(view.derived ? { derived: view.derived } : {}), ...(view.attention?.length ? { attention: view.attention } : {}) };
    }
    return result;
  }

  pathFor(id: string): string {
    assertTaskId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /**
   * t-c2882f — a single read that distinguishes ABSENT from UNSERVABLE.
   *
   * The old shape caught every failure into one `null`, so "no such file" and "this record broke the
   * reader" arrived at the caller as the same word. They are different facts and the caller does
   * different things with them.
   */
  private loadTask(id: string): TaskRead {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathFor(id), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, absent: true };
      return { ok: false, absent: false, defect: `the file could not be read (${code ?? "unknown error"})` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, absent: false, defect: "the file is not valid JSON" };
    }
    const result = normalizeTask(parsed, id);
    return "task" in result ? { ok: true, task: result.task } : { ok: false, absent: false, defect: result.defect };
  }

  private fileSignature(id: string): TaskFileSignature | undefined {
    try {
      const stat = fs.statSync(this.pathFor(id), { bigint: true });
      return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
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

  private viewFor(task: Task, allTasks: Task[], options: TaskViewOptions = {}, derivationBatch?: TaskDerivationBatch): TaskView {
    const derived = this.derive(task, derivationBatch);
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

  private derive(task: Task, derivationBatch?: TaskDerivationBatch): TaskDerived | undefined {
    const sddRef = task.artifact_refs?.find((ref) => ref.type === "sdd" && artifactRefRole(ref) === "deliverable");
    if (!sddRef) return undefined;
    const specPath = this.resolveSddSpec(sddRef.ref, derivationBatch);
    if (!specPath) return { sdd: { type: "sdd", ref: sddRef.ref, missing: true } };
    const status = readSddStatus(specPath);
    return { sdd: { type: "sdd", ref: sddRef.ref, ...(status ? { status } : {}) } };
  }

  private managedSddWorkspaceRoots(): string[] {
    try {
      const registry = loadManagedWorktreeStore(managedWorktreeStorePath(this.workspaceRoot));
      return registry.entries.map((entry) => entry.path);
    } catch {
      // A missing or unreadable registry cannot prove that a spec exists outside this checkout.
      return [];
    }
  }

  private resolveSddSpec(ref: string, derivationBatch?: TaskDerivationBatch): string | null {
    const clean = ref.trim().replace(/^docs\/specs\//, "").replace(/\/spec\.md$/, "").replace(/\/$/, "");
    const primary = resolveSddSpecInWorkspace(this.workspaceRoot, clean);
    if (primary) return primary;
    const managedRoots = derivationBatch
      ? (derivationBatch.managedSddWorkspaceRoots ??= this.managedSddWorkspaceRoots())
      : this.managedSddWorkspaceRoots();
    for (const workspaceRoot of managedRoots) {
      const specPath = resolveSddSpecInWorkspace(workspaceRoot, clean);
      if (specPath) return specPath;
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

/**
 * t-ee0a19 — list_tasks projection for orchestrator board sweeps.
 *
 * Measured on the live board (limit=200, 2026-08-06): full `taskSummary` rows were
 * 115,871 chars; the decision columns alone were 35,742 (3.24x). Freight was mostly
 * `artifact_refs`, timestamps, `author`, and `journalCount` — useful sometimes, never
 * all at once for triage / prioritization / dispatch. Compact keeps what those three
 * uses need and drops the rest; `get_task` remains the door for body and journal.
 */
export type TaskListFields = "compact" | "full";

export type CompactTaskSummary = {
  id: string;
  title: string;
  status: Task["status"];
  priority?: Task["priority"];
  kind?: string;
  assignee?: string;
  deps?: string[];
};

export function compactTaskSummary(view: TaskView): CompactTaskSummary {
  const t = view.task;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    ...(t.priority !== undefined ? { priority: t.priority } : {}),
    ...(t.kind !== undefined ? { kind: t.kind } : {}),
    ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
    ...(t.deps && t.deps.length > 0 ? { deps: t.deps } : {}),
  };
}

export function projectTaskListRow(view: TaskView, fields: TaskListFields = "full"): CompactTaskSummary | ReturnType<typeof taskSummary> {
  return fields === "compact" ? compactTaskSummary(view) : taskSummary(view);
}

/** spec 339 — exported so Task Studio can reserve a provisional id for its attachment namespace BEFORE the
 * task exists (staged create transaction); `TaskStore.create({ id })` then uses that exact id. */
export function mintTaskId(): string {
  return `t-${crypto.randomBytes(3).toString("hex")}`;
}

function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id '${id}'`);
}

/** t-c2882f — what one read of a task file found. `absent` and `unservable` are DIFFERENT answers. */
type TaskRead =
  | { ok: true; task: Task }
  | { ok: false; absent: true }
  | { ok: false; absent: false; defect: string };

interface TaskFileSignature {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function sameTaskFileSignature(a: TaskFileSignature, b: TaskFileSignature): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Cached records are shared between listings, so freeze their complete JSON-shaped graph once. */
function freezeSuccessfulRead(read: TaskRead): TaskRead {
  if (!read.ok) return read;
  return { ok: true, task: deepFreeze(read.task) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * t-c2882f — a task that EXISTS and cannot be served says so, and names a way forward.
 *
 * The message states what a read actually requires, because that is the repair: the reader enforces
 * STRUCTURE only, so any defect it reports is in the record's shape and never in how much the record
 * contains.
 */
function unservableTaskMessage(id: string, file: string, defect: string): string {
  return (
    `task '${id}' exists at ${file} but its record cannot be read: ${defect}. ` +
    "Reading applies no authoring limit, so this is a defect in the record's shape rather than its size — " +
    "a readable record needs an id matching its filename, a known status, and string title, author, createdAt and updatedAt. " +
    "Repair the file or move it out of the tasks directory."
  );
}

/**
 * t-c2882f — READING a persisted Task is not AUTHORING one.
 *
 * This used to call `boundedString`/`optionalStringField` — the create/update validators — on every
 * field it read back, which made an authoring cap retroactive. Three tasks written in July 2026 with
 * bodies of 11511, 6489 and 4238 code points threw here, `readTask` swallowed the throw, and the
 * store answered `unknown task` for records whose JSON was valid and whose content was whole. Nothing
 * announced it, and lowering a write limit would have erased more of the board the same silent way.
 *
 * So the split is: STRUCTURE is enforced on read — is this a task record at all — and POLICY is not.
 * How long a body may be is a question for the door the body came in through; `create` and `update`
 * still ask it, unchanged. Reading is never more restrictive than writing.
 *
 * A field the reader cannot type at all is DROPPED (the shape `optionalEvolutionCompletion` already
 * used), never escalated into suppressing the row: losing one malformed sub-object is recoverable,
 * losing the task is what this task exists about.
 */
function normalizeTask(input: unknown, expectedId: string): { task: Task } | { defect: string } {
  if (!input || typeof input !== "object") return { defect: "the record is not a JSON object" };
  const row = input as Partial<Task>;
  if (row.id !== expectedId) return { defect: `its recorded id is ${describeRejectedValue(row.id)}, which does not match the filename id '${expectedId}'` };
  if (!isTaskStatus(row.status)) return { defect: `its status is ${describeRejectedValue(row.status)}, which is not one of ${TASK_STATUSES.join(", ")}` };
  if (typeof row.title !== "string") return { defect: `its title is ${describeRejectedValue(row.title)}, which is not a string` };
  if (typeof row.author !== "string") return { defect: `its author is ${describeRejectedValue(row.author)}, which is not a string` };
  if (typeof row.createdAt !== "string") return { defect: `its createdAt is ${describeRejectedValue(row.createdAt)}, which is not a string` };
  if (typeof row.updatedAt !== "string") return { defect: `its updatedAt is ${describeRejectedValue(row.updatedAt)}, which is not a string` };
  if (row.priority !== undefined && !isTaskPriority(row.priority)) return { defect: `its priority is ${describeRejectedValue(row.priority)}, which is not an integer 0..3` };
  // PRESENCE, not size. `title` and `author` are required and every downstream projection types them
  // as non-empty, so an empty one is a record without a title rather than a record with a small one —
  // and letting it through would hand the board a row it cannot render, which is the failure this
  // whole change is about, arriving from the other side.
  const title = row.title.trim();
  const author = row.author.trim();
  if (!title) return { defect: "its title is empty, and a task record must carry one" };
  if (!author) return { defect: "its author is empty, and a task record must carry one" };
  return {
    task: {
      id: row.id,
      title,
      ...persistedStringField("body", row.body),
      status: row.status,
      ...(row.priority !== undefined ? { priority: row.priority } : {}),
      ...persistedStringField("rank", row.rank),
      ...persistedStringField("kind", row.kind),
      author,
      ...persistedStringField("assignee", row.assignee),
      ...persistedArtifactRefs(row.artifact_refs),
      ...persistedDeps(row.deps),
      // t-1339a8 — backward-compatible: task JSON written before this field existed just has no key here.
      ...(row.awaitingHuman !== undefined ? persistedAwaitingHuman(row.awaitingHuman) : {}),
      ...(row.evolutionCompletion !== undefined ? optionalEvolutionCompletion(row.evolutionCompletion) : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

/**
 * Bounded, non-echoing description of a value a read refused. Same rule `taskAuthoringLimitMessage`
 * follows: a reader needs the shape of what went wrong, never a paste of task material.
 */
function describeRejectedValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return value.length > 40 ? `a ${value.length}-character string` : JSON.stringify(value);
  return JSON.stringify(value) ?? typeof value;
}

/** t-c2882f — read-side string field: preserve what is persisted, cap nothing. */
function persistedStringField<K extends "body" | "rank" | "kind" | "assignee">(key: K, value: unknown): Pick<Task, K> | {} {
  if (typeof value !== "string") return {};
  const out = value.trim();
  return out ? ({ [key]: out } as Pick<Task, K>) : {};
}

/**
 * t-c2882f — read-side artifact refs. No count cap, no length cap, and duplicates are preserved as
 * persisted: rejecting them is the authoring door's job, and `optionalArtifactRefs` still does it.
 */
function persistedArtifactRefs(refs: unknown): Pick<Task, "artifact_refs"> | {} {
  if (!Array.isArray(refs)) return {};
  const out: ArtifactRef[] = [];
  for (const entry of refs) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Partial<ArtifactRef>;
    const type = typeof row.type === "string" ? row.type.trim() : "";
    const value = typeof row.ref === "string" ? row.ref.trim() : "";
    if (!type || !value) continue;
    const role = typeof row.role === "string" && (ARTIFACT_REF_ROLES as readonly string[]).includes(row.role) ? (row.role as ArtifactRefRole) : undefined;
    out.push({ type, ref: value, ...(role ? { role } : {}) });
  }
  return out.length ? { artifact_refs: out } : {};
}

/**
 * t-c2882f — read-side deps. No count cap; a malformed entry is dropped rather than escalated into
 * suppressing the task, which is the same rule the other read helpers here follow.
 *
 * A dep is a LINK, and `TASK_ID_RE` is what makes it one: both projections type `dependency.id` as a
 * task id, so a string that cannot be a task id cannot be rendered as a dependency by anything
 * downstream. Keeping it would trade one unreachable task for one unopenable Task Detail panel.
 */
function persistedDeps(deps: unknown): Pick<Task, "deps"> | {} {
  if (!Array.isArray(deps)) return {};
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dep of deps) {
    if (typeof dep !== "string") continue;
    const id = dep.trim();
    if (!TASK_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length ? { deps: out } : {};
}

/** t-c2882f — read-side awaitingHuman: a malformed marker is dropped, never promoted to a suppressed task. */
function persistedAwaitingHuman(value: unknown): Pick<Task, "awaitingHuman"> | {} {
  if (!value || typeof value !== "object") return {};
  const row = value as Partial<TaskAwaitingHuman>;
  if (typeof row.reason !== "string" || typeof row.since !== "string" || !isTaskAwaitingHumanKind(row.kind)) return {};
  const reason = row.reason.trim();
  if (!reason) return {};
  const candidate = row.subject as { type?: unknown; prototypeId?: unknown } | undefined;
  const subject: TaskAwaitingHuman["subject"] | undefined =
    candidate && typeof candidate === "object" && candidate.type === "task-prototype"
      && typeof candidate.prototypeId === "string" && /^p-[0-9a-f]{12}$/.test(candidate.prototypeId)
      ? { type: "task-prototype", prototypeId: candidate.prototypeId }
      : undefined;
  return { awaitingHuman: { reason, since: row.since, kind: row.kind, ...(subject ? { subject } : {}) } };
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

function resolveSddSpecInWorkspace(workspaceRoot: string, cleanRef: string): string | null {
  const specsDir = path.join(workspaceRoot, "docs", "specs");
  const exact = path.join(specsDir, cleanRef, "spec.md");
  if (fs.existsSync(exact)) return exact;
  if (/^[0-9]{3}$/.test(cleanRef)) {
    try {
      const match = fs.readdirSync(specsDir).find(
        (name) => name.startsWith(`${cleanRef}-`) && fs.existsSync(path.join(specsDir, name, "spec.md")),
      );
      return match ? path.join(specsDir, match, "spec.md") : null;
    } catch {
      return null;
    }
  }
  return null;
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
