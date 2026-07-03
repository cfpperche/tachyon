import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nextTask } from "./nextTask.js";
import {
  isTaskPriority,
  isTaskStatus,
  TASK_ID_RE,
  type ArtifactRef,
  type NextTaskResult,
  type SddDerivedStage,
  type SddStatus,
  type Task,
  type TaskAttention,
  type TaskCreateInput,
  type TaskDerived,
  type TaskStatus,
  type TaskUpdateExpect,
  type TaskUpdateInput,
  type TaskView,
} from "./types.js";

const SDD_STATUSES = new Set<SddStatus>(["draft", "in-progress", "shipped", "shipped-partial", "superseded", "abandoned", "deferred"]);
const RETRIAGE_SDD = new Set<SddStatus>(["superseded", "abandoned", "deferred"]);

// spec 335 — hoisted so the Mission Control board snapshot can compute per-task drag affordances from the SAME
// literal `assertTransition` enforces (one authority; the webview never re-encodes status-transition rules).
const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["triaged", "dropped"],
  triaged: ["active", "dropped"],
  active: ["done", "triaged", "dropped"],
  done: ["triaged"],
  dropped: ["triaged"],
};

/** The statuses a task may transition to from `status`, per the store's transition authority. */
export function allowedTransitions(status: TaskStatus): TaskStatus[] {
  return TASK_STATUS_TRANSITIONS[status];
}

export class TaskStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks");
  }

  async create(input: TaskCreateInput): Promise<Task> {
    return this.withMutation(async () => {
      const now = input.now ?? new Date().toISOString();
      const task: Omit<Task, "id"> = {
        title: boundedString(input.title, "title", 300),
        status: "inbox",
        author: boundedString(input.author || "human", "author", 64),
        createdAt: now,
        updatedAt: now,
        ...optionalStringField("body", input.body, 4000),
        ...optionalPriority(input.priority),
        ...optionalStringField("rank", input.rank, 64),
        ...optionalStringField("kind", input.kind, 64),
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

  getView(id: string): TaskView {
    const task = this.get(id);
    return this.viewFor(task, this.listRaw());
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
    tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return tasks;
  }

  listViews(limit = 100): TaskView[] {
    const tasks = this.listRaw();
    return tasks.slice(0, clampLimit(limit)).map((task) => this.viewFor(task, tasks));
  }

  async update(id: string, input: TaskUpdateInput): Promise<Task> {
    return this.withMutation(async () => {
      assertTaskId(id);
      const current = this.get(id);
      assertExpect(current, input.expect);
      const next = applyUpdate(current, input);
      if (JSON.stringify({ ...current, updatedAt: next.updatedAt }) === JSON.stringify(next)) {
        throw new Error("update_task requires at least one changed field");
      }
      assertTransition(current, next, input);
      this.assertSddArtifactRefsUpdateAllowed(current, next, input);
      this.assertSddStatusUpdateAllowed(current, next, input);
      this.writeTask(next);
      return next;
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

  private viewFor(task: Task, allTasks: Task[]): TaskView {
    const derived = this.derive(task);
    const attention = attentionFor(task, allTasks, derived);
    return { task, ...(derived ? { derived } : {}), ...(attention.length ? { attention } : {}) };
  }

  private derive(task: Task): TaskDerived | undefined {
    const sddRef = task.artifact_refs?.find((ref) => ref.type === "sdd");
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

export function taskSummary(view: TaskView): Omit<Task, "body"> & { attention?: TaskAttention[]; derived?: TaskDerived } {
  const { body: _body, ...task } = view.task;
  return { ...task, ...(view.derived ? { derived: view.derived } : {}), ...(view.attention?.length ? { attention: view.attention } : {}) };
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
    title: boundedString(row.title, "title", 300),
    ...(typeof row.body === "string" ? optionalStringField("body", row.body, 4000) : {}),
    status: row.status,
    ...(row.priority !== undefined ? { priority: row.priority } : {}),
    ...(typeof row.rank === "string" ? optionalStringField("rank", row.rank, 64) : {}),
    ...(typeof row.kind === "string" ? optionalStringField("kind", row.kind, 64) : {}),
    author: boundedString(row.author, "author", 64),
    ...(typeof row.assignee === "string" ? optionalStringField("assignee", row.assignee, 64) : {}),
    ...optionalArtifactRefs(row.artifact_refs),
    ...optionalDeps(row.deps),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function applyUpdate(current: Task, input: TaskUpdateInput): Task {
  const now = input.now ?? new Date().toISOString();
  const next: Task = { ...current, updatedAt: now };
  if (input.title !== undefined) next.title = boundedString(input.title, "title", 300);
  if (input.body !== undefined) {
    if (input.body === null) delete next.body;
    else Object.assign(next, optionalStringField("body", input.body, 4000));
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
  applyOptionalStringPatch(next, "kind", input.kind, 64);
  applyOptionalStringPatch(next, "assignee", input.assignee, 64);
  if (input.artifact_refs !== undefined) {
    if (input.artifact_refs === null) delete next.artifact_refs;
    else Object.assign(next, optionalArtifactRefs(input.artifact_refs));
  }
  if (input.deps !== undefined) {
    if (input.deps === null) delete next.deps;
    else Object.assign(next, optionalDeps(input.deps));
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

function assertTransition(current: Task, next: Task, input: TaskUpdateInput): void {
  const mutable = new Set<TaskStatus>(["inbox", "triaged", "active"]);
  const changedFields = Object.keys(input).filter((key) => key !== "now" && key !== "expect" && key !== "status");
  if (changedFields.length && !mutable.has(current.status)) throw new Error(`task fields are immutable while status is '${current.status}'`);
  if ("assignee" in input && next.status !== "triaged" && next.status !== "active") throw new Error("assignee is mutable only in triaged/active tasks");
  if (next.status === "active" && !next.assignee) throw new Error("active tasks require assignee");
  if (current.status === next.status) return;
  if (!allowedTransitions(current.status).includes(next.status)) throw new Error(`invalid status transition ${current.status} -> ${next.status}`);
}

function attentionFor(task: Task, allTasks: Task[], derived?: TaskDerived): TaskAttention[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const attention: TaskAttention[] = [];
  for (const dep of task.deps ?? []) {
    if (!byId.has(dep)) attention.push({ code: "dangling_dep", message: `dependency '${dep}' does not exist`, ref: dep });
  }
  const sdd = derived?.sdd;
  if (sdd?.missing) attention.push({ code: "missing_sdd_spec", message: `SDD artifact '${sdd.ref}' was not found`, ref: sdd.ref });
  if (task.status === "active" && sdd?.status === "shipped") attention.push({ code: "ready_to_close", message: `SDD artifact '${sdd.ref}' is shipped; close the task explicitly`, ref: sdd.ref });
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
  if ([...out].length > max) throw new Error(`${name} must be at most ${max} code points`);
  return out;
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
  if (refs.length > 10) throw new Error("artifact_refs may contain at most 10 entries");
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw new Error("artifact_refs entries must be objects");
    const type = boundedString(String((ref as ArtifactRef).type ?? ""), "artifact_refs.type", 64);
    const value = boundedString(String((ref as ArtifactRef).ref ?? ""), "artifact_refs.ref", 500);
    const key = `${type}\0${value}`;
    if (seen.has(key)) throw new Error(`duplicate artifact_ref '${type}:${value}'`);
    seen.add(key);
    out.push({ type, ref: value });
  }
  return out.length ? { artifact_refs: out } : {};
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

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 500);
}
