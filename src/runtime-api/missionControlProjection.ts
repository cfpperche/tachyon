import type { BoardSnapshot } from "../tasks/boardSnapshot.js";
import {
  isTaskAwaitingHumanKind,
  isTaskPriority,
  isTaskStatus,
  TASK_ID_RE,
  type SddStatus,
  type Task,
  type TaskAttention,
  type TaskStatus,
  type TaskView,
} from "../tasks/types.js";
import { isValidationExecutor, isValidationOutcome, isValidationStatus, VALIDATION_ID_RE } from "../validations/types.js";
import type { ValidationSummary } from "../validations/ValidationStore.js";

const MAX_TASKS = 500;
const MAX_CHIPS = 512;
const MAX_VALIDATIONS = 500;
const MAX_CANDIDATES = 50;
const MAX_ATTENTION_ROWS = 16;
const SDD_STATUSES = new Set<SddStatus>(["draft", "in-progress", "shipped", "shipped-partial", "superseded", "abandoned", "deferred"]);
const ATTENTION_CODES = new Set<TaskAttention["code"]>([
  "dangling_dep", "missing_sdd_spec", "ready_to_close", "sdd_needs_retriage", "corrupt_task", "awaiting_human",
]);

export interface MissionControlChipV1 {
  agent: string;
  source: "declared" | "human" | "assignee";
  next: { taskId: string } | { empty: true; reason: "no-tasks" | "all-blocked" | "all-assigned-elsewhere" };
}

export interface MissionControlValidationV1 {
  id: string;
  title: string;
  type?: string;
  status: "pending" | "triaged" | "running" | "closed";
  executor: "human" | "agent" | "either";
  priority?: 0 | 1 | 2 | 3;
  assignee?: string;
  outcome?: "passed" | "failed" | "skipped";
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionControlBoardProjectionV1 {
  schemaVersion: 1;
  views: TaskView[];
  allowedDropStatuses: Record<string, TaskStatus[]>;
  chips: MissionControlChipV1[];
  validations?: {
    items: MissionControlValidationV1[];
    pendingCount: number;
    humanPendingCount: number;
    agentPendingCount: number;
    candidateCount: number;
    candidates: Array<{
      title: string;
      type?: string;
      executor: "human" | "agent" | "either";
      source_ref: { type: string; ref: string; role?: "deliverable" | "relation" };
      excerpt: string;
    }>;
  };
  attachmentCounts?: Record<string, number>;
}

export interface MissionControlViewV1 {
  schemaVersion: 1;
  board: MissionControlBoardProjectionV1;
}

export function projectMissionControlBoard(snapshot: BoardSnapshot): MissionControlBoardProjectionV1 {
  return parseMissionControlBoardProjectionV1({
    schemaVersion: 1,
    views: snapshot.views.map(projectTaskView),
    allowedDropStatuses: snapshot.allowedDropStatuses,
    chips: snapshot.chips.map((chip) => ({
      agent: chip.agent,
      source: chip.source,
      next: "task" in chip.next ? { taskId: chip.next.task.id } : { empty: true, reason: chip.next.reason },
    })),
    ...(snapshot.validations ? {
      validations: {
        items: snapshot.validations.items.filter((item) => item.status !== "closed").map((item) => ({
          id: item.id,
          title: item.title,
          ...(item.type ? { type: item.type } : {}),
          status: item.status,
          executor: item.executor,
          ...(item.priority !== undefined ? { priority: item.priority } : {}),
          ...(item.assignee ? { assignee: item.assignee } : {}),
          ...(item.currentRound?.outcome ? { outcome: item.currentRound.outcome } : {}),
          author: item.author,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        pendingCount: snapshot.validations.pendingCount,
        humanPendingCount: snapshot.validations.humanPendingCount,
        agentPendingCount: snapshot.validations.agentPendingCount,
        candidateCount: snapshot.validations.candidateCount,
        candidates: snapshot.validations.candidates,
      },
    } : {}),
    ...(snapshot.attachmentCounts ? { attachmentCounts: snapshot.attachmentCounts } : {}),
  });
}

export function parseMissionControlViewV1(value: unknown): MissionControlViewV1 {
  const input = exactRecord(value, ["schemaVersion", "board"], "Mission Control view");
  if (input.schemaVersion !== 1) throw invalid("Mission Control view schemaVersion is invalid");
  return {
    schemaVersion: 1,
    board: parseMissionControlBoardProjectionV1(input.board),
  };
}

export function isMissionControlViewV1(value: unknown): value is MissionControlViewV1 {
  try { parseMissionControlViewV1(value); return true; } catch { return false; }
}

export function parseMissionControlBoardProjectionV1(value: unknown): MissionControlBoardProjectionV1 {
  const input = record(value, "Mission Control board");
  const expected = ["schemaVersion", "views", "allowedDropStatuses", "chips"];
  if (input.validations !== undefined) expected.push("validations");
  if (input.attachmentCounts !== undefined) expected.push("attachmentCounts");
  assertOnlyKeys(input, expected, "Mission Control board");
  if (input.schemaVersion !== 1 || !Array.isArray(input.views) || input.views.length > MAX_TASKS) {
    throw invalid("Mission Control board task rows are invalid");
  }
  const views = input.views.map(parseTaskView);
  const ids = views.map((view) => view.task.id);
  if (new Set(ids).size !== ids.length) throw invalid("Mission Control board contains duplicate task ids");
  const idSet = new Set(ids);
  const allowedInput = record(input.allowedDropStatuses, "Mission Control allowed statuses");
  if (Object.keys(allowedInput).length !== ids.length || Object.keys(allowedInput).some((id) => !idSet.has(id))) {
    throw invalid("Mission Control allowed statuses do not match its task rows");
  }
  const allowedDropStatuses: Record<string, TaskStatus[]> = {};
  for (const id of ids) {
    const statuses = allowedInput[id];
    if (!Array.isArray(statuses) || new Set(statuses).size !== statuses.length || statuses.some((status) => !isTaskStatus(status))) {
      throw invalid(`Mission Control allowed statuses are invalid for '${id}'`);
    }
    allowedDropStatuses[id] = statuses as TaskStatus[];
  }
  if (!Array.isArray(input.chips) || input.chips.length > MAX_CHIPS) throw invalid("Mission Control chips are invalid");
  const chips = input.chips.map((chip) => parseChip(chip, idSet));
  if (new Set(chips.map((chip) => chip.agent)).size !== chips.length) throw invalid("Mission Control chips contain duplicate agents");
  const validations = input.validations === undefined ? undefined : parseValidations(input.validations);
  const attachmentCounts = input.attachmentCounts === undefined ? undefined : parseAttachmentCounts(input.attachmentCounts, idSet);
  return {
    schemaVersion: 1,
    views,
    allowedDropStatuses,
    chips,
    ...(validations ? { validations } : {}),
    ...(attachmentCounts ? { attachmentCounts } : {}),
  };
}

export function missionControlBoardSnapshot(projection: MissionControlBoardProjectionV1): BoardSnapshot {
  const byId = new Map(projection.views.map((view) => [view.task.id, view]));
  const validations = projection.validations
    ? {
        items: projection.validations.items.map((item): ValidationSummary => {
          const round = item.outcome ? { n: 1, outcome: item.outcome } : undefined;
          return {
            id: item.id,
            title: item.title,
            ...(item.type ? { type: item.type } : {}),
            status: item.status,
            executor: item.executor,
            ...(item.priority !== undefined ? { priority: item.priority } : {}),
            ...(item.assignee ? { assignee: item.assignee } : {}),
            rounds: round ? [round] : [],
            author: item.author,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            ...(round ? { currentRound: round } : {}),
          };
        }),
        pendingCount: projection.validations.pendingCount,
        humanPendingCount: projection.validations.humanPendingCount,
        agentPendingCount: projection.validations.agentPendingCount,
        candidateCount: projection.validations.candidateCount,
        candidates: projection.validations.candidates,
      }
    : undefined;
  return {
    views: projection.views,
    allowedDropStatuses: projection.allowedDropStatuses,
    chips: projection.chips.map((chip) => {
      if ("empty" in chip.next) return { agent: chip.agent, source: chip.source, next: chip.next };
      const view = byId.get(chip.next.taskId);
      if (!view) throw invalid(`Mission Control chip references missing task '${chip.next.taskId}'`);
      return {
        agent: chip.agent,
        source: chip.source,
        next: { task: view.task, ...(view.derived ? { derived: view.derived } : {}), ...(view.attention ? { attention: view.attention } : {}) },
      };
    }),
    ...(validations ? { validations } : {}),
    ...(projection.attachmentCounts ? { attachmentCounts: projection.attachmentCounts } : {}),
  };
}

function projectTaskView(view: TaskView): TaskView {
  return parseTaskView({
    task: {
      id: view.task.id,
      title: view.task.title,
      ...(view.task.body !== undefined ? { body: view.task.body } : {}),
      status: view.task.status,
      ...(view.task.priority !== undefined ? { priority: view.task.priority } : {}),
      ...(view.task.rank !== undefined ? { rank: view.task.rank } : {}),
      ...(view.task.kind !== undefined ? { kind: view.task.kind } : {}),
      author: view.task.author,
      ...(view.task.assignee !== undefined ? { assignee: view.task.assignee } : {}),
      ...(view.task.awaitingHuman !== undefined ? { awaitingHuman: view.task.awaitingHuman } : {}),
      createdAt: view.task.createdAt,
      updatedAt: view.task.updatedAt,
    },
    ...(view.journalCount !== undefined ? { journalCount: view.journalCount } : {}),
    ...(view.derived ? { derived: view.derived } : {}),
    ...(view.attention ? { attention: view.attention.slice(0, MAX_ATTENTION_ROWS) } : {}),
  });
}

function parseTaskView(value: unknown): TaskView {
  const input = record(value, "Mission Control task view");
  const expected = ["task"];
  if (input.journalCount !== undefined) expected.push("journalCount");
  if (input.derived !== undefined) expected.push("derived");
  if (input.attention !== undefined) expected.push("attention");
  assertOnlyKeys(input, expected, "Mission Control task view");
  const task = parseTask(input.task);
  const journalCount = input.journalCount === undefined ? undefined : safeInteger(input.journalCount, 0, 1_000_000, "task journalCount");
  const derived = input.derived === undefined ? undefined : parseDerived(input.derived);
  const attention = input.attention === undefined ? undefined : parseAttention(input.attention);
  return {
    task,
    ...(journalCount !== undefined ? { journalCount } : {}),
    ...(derived ? { derived } : {}),
    ...(attention ? { attention } : {}),
  };
}

function parseTask(value: unknown): Task {
  const input = record(value, "Mission Control task");
  const expected = ["id", "title", "status", "author", "createdAt", "updatedAt"];
  for (const key of ["body", "priority", "rank", "kind", "assignee", "awaitingHuman"]) {
    if (input[key] !== undefined) expected.push(key);
  }
  assertOnlyKeys(input, expected, "Mission Control task");
  if (typeof input.id !== "string" || !TASK_ID_RE.test(input.id) || !isTaskStatus(input.status)) {
    throw invalid("Mission Control task identity or status is invalid");
  }
  const task: Task = {
    id: input.id,
    title: text(input.title, 1, 300, "task title"),
    status: input.status,
    author: text(input.author, 1, 64, "task author"),
    createdAt: timestamp(input.createdAt, "task createdAt"),
    updatedAt: timestamp(input.updatedAt, "task updatedAt"),
  };
  if (input.body !== undefined) task.body = text(input.body, 1, 4_000, "task body");
  if (input.priority !== undefined) {
    if (!isTaskPriority(input.priority)) throw invalid("task priority is invalid");
    task.priority = input.priority;
  }
  if (input.rank !== undefined) task.rank = text(input.rank, 1, 64, "task rank");
  if (input.kind !== undefined) task.kind = text(input.kind, 1, 64, "task kind");
  if (input.assignee !== undefined) task.assignee = text(input.assignee, 1, 64, "task assignee");
  if (input.awaitingHuman !== undefined) task.awaitingHuman = parseAwaitingHuman(input.awaitingHuman);
  return task;
}

function parseAwaitingHuman(value: unknown): NonNullable<Task["awaitingHuman"]> {
  const input = record(value, "task awaitingHuman");
  const expected = ["reason", "since", "kind"];
  if (input.subject !== undefined) expected.push("subject");
  assertOnlyKeys(input, expected, "task awaitingHuman");
  if (!isTaskAwaitingHumanKind(input.kind)) throw invalid("task awaitingHuman kind is invalid");
  const subject = input.subject === undefined ? undefined : exactRecord(input.subject, ["type", "prototypeId"], "task awaitingHuman subject");
  if (subject && (subject.type !== "task-prototype" || typeof subject.prototypeId !== "string" || !/^p-[0-9a-f]{12}$/.test(subject.prototypeId))) {
    throw invalid("task awaitingHuman subject is invalid");
  }
  return {
    reason: text(input.reason, 1, 2_000, "task awaitingHuman reason"),
    since: timestamp(input.since, "task awaitingHuman since"),
    kind: input.kind,
    ...(subject ? { subject: { type: "task-prototype", prototypeId: subject.prototypeId as string } } : {}),
  };
}

function parseDerived(value: unknown): NonNullable<TaskView["derived"]> {
  const input = record(value, "task derived");
  if (input.sdd === undefined) {
    assertOnlyKeys(input, [], "task derived");
    return {};
  }
  assertOnlyKeys(input, ["sdd"], "task derived");
  const sdd = record(input.sdd, "task SDD projection");
  const expected = ["type", "ref"];
  if (sdd.status !== undefined) expected.push("status");
  if (sdd.missing !== undefined) expected.push("missing");
  assertOnlyKeys(sdd, expected, "task SDD projection");
  if (sdd.type !== "sdd" || (sdd.status !== undefined && !SDD_STATUSES.has(sdd.status as SddStatus))
    || (sdd.missing !== undefined && typeof sdd.missing !== "boolean")) {
    throw invalid("task SDD projection is invalid");
  }
  return { sdd: {
    type: "sdd",
    ref: text(sdd.ref, 1, 500, "task SDD ref"),
    ...(sdd.status !== undefined ? { status: sdd.status as SddStatus } : {}),
    ...(sdd.missing !== undefined ? { missing: sdd.missing } : {}),
  } };
}

function parseAttention(value: unknown): TaskAttention[] {
  if (!Array.isArray(value) || value.length > MAX_ATTENTION_ROWS) throw invalid("task attention is invalid");
  return value.map((row) => {
    const input = record(row, "task attention row");
    const expected = ["code", "message"];
    if (input.ref !== undefined) expected.push("ref");
    assertOnlyKeys(input, expected, "task attention row");
    if (!ATTENTION_CODES.has(input.code as TaskAttention["code"])) throw invalid("task attention code is invalid");
    return {
      code: input.code as TaskAttention["code"],
      message: text(input.message, 1, 2_000, "task attention message"),
      ...(input.ref !== undefined ? { ref: text(input.ref, 1, 500, "task attention ref") } : {}),
    };
  });
}

function parseChip(value: unknown, taskIds: Set<string>): MissionControlChipV1 {
  const input = exactRecord(value, ["agent", "source", "next"], "Mission Control chip");
  if (input.source !== "declared" && input.source !== "human" && input.source !== "assignee") {
    throw invalid("Mission Control chip source is invalid");
  }
  const next = record(input.next, "Mission Control chip next");
  if ("taskId" in next) {
    assertOnlyKeys(next, ["taskId"], "Mission Control chip task");
    if (typeof next.taskId !== "string" || !taskIds.has(next.taskId)) throw invalid("Mission Control chip task is missing");
    return { agent: text(input.agent, 1, 128, "Mission Control chip agent"), source: input.source, next: { taskId: next.taskId } };
  }
  assertOnlyKeys(next, ["empty", "reason"], "Mission Control empty chip");
  if (next.empty !== true || (next.reason !== "no-tasks" && next.reason !== "all-blocked" && next.reason !== "all-assigned-elsewhere")) {
    throw invalid("Mission Control empty chip is invalid");
  }
  return { agent: text(input.agent, 1, 128, "Mission Control chip agent"), source: input.source, next: { empty: true, reason: next.reason } };
}

function parseValidations(value: unknown): NonNullable<MissionControlBoardProjectionV1["validations"]> {
  const input = exactRecord(value, ["items", "pendingCount", "humanPendingCount", "agentPendingCount", "candidateCount", "candidates"], "Mission Control validations");
  if (!Array.isArray(input.items) || input.items.length > MAX_VALIDATIONS || !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    throw invalid("Mission Control validation rows are invalid");
  }
  const items = input.items.map(parseValidation);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw invalid("Mission Control validations contain duplicate ids");
  const pending = items.filter((item) => item.status !== "closed");
  const pendingCount = safeInteger(input.pendingCount, 0, MAX_VALIDATIONS, "validation pendingCount");
  const humanPendingCount = safeInteger(input.humanPendingCount, 0, MAX_VALIDATIONS, "validation humanPendingCount");
  const agentPendingCount = safeInteger(input.agentPendingCount, 0, MAX_VALIDATIONS, "validation agentPendingCount");
  const candidates = input.candidates.map(parseCandidate);
  const candidateCount = safeInteger(input.candidateCount, 0, MAX_CANDIDATES, "validation candidateCount");
  if (pendingCount !== pending.length
    || humanPendingCount !== pending.filter((item) => item.executor === "human").length
    || agentPendingCount !== pending.filter((item) => item.executor !== "human").length
    || candidateCount !== candidates.length) throw invalid("Mission Control validation counts contradict their rows");
  return { items, pendingCount, humanPendingCount, agentPendingCount, candidateCount, candidates };
}

function parseValidation(value: unknown): MissionControlValidationV1 {
  const input = record(value, "Mission Control validation");
  const expected = ["id", "title", "status", "executor", "author", "createdAt", "updatedAt"];
  for (const key of ["type", "priority", "assignee", "outcome"]) if (input[key] !== undefined) expected.push(key);
  assertOnlyKeys(input, expected, "Mission Control validation");
  if (typeof input.id !== "string" || !VALIDATION_ID_RE.test(input.id)
    || !isValidationStatus(input.status) || !isValidationExecutor(input.executor)
    || (input.outcome !== undefined && !isValidationOutcome(input.outcome))) {
    throw invalid("Mission Control validation identity or enum is invalid");
  }
  if (input.priority !== undefined && !isTaskPriority(input.priority)) throw invalid("Mission Control validation priority is invalid");
  return {
    id: input.id,
    title: text(input.title, 1, 300, "validation title"),
    ...(input.type !== undefined ? { type: text(input.type, 1, 64, "validation type") } : {}),
    status: input.status,
    executor: input.executor,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.assignee !== undefined ? { assignee: text(input.assignee, 1, 64, "validation assignee") } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    author: text(input.author, 1, 64, "validation author"),
    createdAt: timestamp(input.createdAt, "validation createdAt"),
    updatedAt: timestamp(input.updatedAt, "validation updatedAt"),
  };
}

function parseCandidate(value: unknown): NonNullable<MissionControlBoardProjectionV1["validations"]>["candidates"][number] {
  const input = record(value, "Mission Control validation candidate");
  const expected = ["title", "executor", "source_ref", "excerpt"];
  if (input.type !== undefined) expected.push("type");
  assertOnlyKeys(input, expected, "Mission Control validation candidate");
  if (!isValidationExecutor(input.executor)) throw invalid("Mission Control candidate executor is invalid");
  const source = record(input.source_ref, "Mission Control candidate source_ref");
  const sourceExpected = ["type", "ref"];
  if (source.role !== undefined) sourceExpected.push("role");
  assertOnlyKeys(source, sourceExpected, "Mission Control candidate source_ref");
  if (source.role !== undefined && source.role !== "deliverable" && source.role !== "relation") throw invalid("candidate source_ref role is invalid");
  return {
    title: text(input.title, 1, 300, "candidate title"),
    ...(input.type !== undefined ? { type: text(input.type, 1, 64, "candidate type") } : {}),
    executor: input.executor,
    source_ref: {
      type: text(source.type, 1, 64, "candidate source_ref type"),
      ref: text(source.ref, 1, 500, "candidate source_ref ref"),
      ...(source.role !== undefined ? { role: source.role } : {}),
    },
    excerpt: text(input.excerpt, 0, 4_000, "candidate excerpt"),
  };
}

function parseAttachmentCounts(value: unknown, taskIds: Set<string>): Record<string, number> {
  const input = record(value, "Mission Control attachment counts");
  const out: Record<string, number> = {};
  for (const [id, count] of Object.entries(input)) {
    if (!taskIds.has(id)) throw invalid(`attachment count references missing task '${id}'`);
    out[id] = safeInteger(count, 1, 100_000, "attachment count");
  }
  return out;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const input = record(value, label);
  assertOnlyKeys(input, keys, label);
  return input;
}

function assertOnlyKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw invalid(`${label} has unknown or missing fields`);
  }
}

function text(value: unknown, min: number, maxCodePoints: number, label: string): string {
  if (typeof value !== "string" || [...value].length < min || [...value].length > maxCodePoints) throw invalid(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const out = text(value, 1, 64, label);
  if (!Number.isFinite(Date.parse(out))) throw invalid(`${label} is invalid`);
  return out;
}

function safeInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`${label} is invalid`);
  return value as number;
}

function invalid(message: string): Error {
  return new Error(message);
}
