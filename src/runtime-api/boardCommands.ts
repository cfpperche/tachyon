import {
  isTaskPriority,
  isTaskStatus,
  TASK_ID_RE,
  type TaskPriority,
  type TaskStatus,
  type TaskUpdateExpect,
} from "../tasks/types.js";
import { isValidationOutcome, VALIDATION_ID_RE, type ValidationOutcome } from "../validations/types.js";

export interface BoardTaskPatchV1 {
  status?: TaskStatus;
  priority?: TaskPriority | null;
  rank?: string | null;
  assignee?: string | null;
  expect?: TaskUpdateExpect;
}

export interface BoardTaskUpdateInputV1 {
  id: string;
  patch: BoardTaskPatchV1;
}

export interface BoardTaskReorderInputV1 {
  status: TaskStatus;
  priority?: TaskPriority;
  orderedIds: string[];
  expect: Record<string, string>;
}

export interface BoardValidationCloseInputV1 {
  id: string;
  outcome: ValidationOutcome;
  result_note: string;
}

export interface BoardValidationAssignInputV1 {
  id: string;
  assignee: string;
  expect?: { assignee?: string | null; updatedAt?: string };
}

const TASK_PATCH_KEYS = [
  "status", "priority", "rank", "assignee", "expect",
] as const;

export function isBoardTaskUpdateInputV1(value: unknown): value is BoardTaskUpdateInputV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "patch"])
    || typeof value.id !== "string" || !TASK_ID_RE.test(value.id)
    || !isRecord(value.patch)) return false;
  const patch = value.patch;
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !(TASK_PATCH_KEYS as readonly string[]).includes(key))) return false;
  if (patch.status !== undefined && !isTaskStatus(patch.status)) return false;
  if (patch.priority !== undefined && patch.priority !== null && !isTaskPriority(patch.priority)) return false;
  if (!nullableBoundedText(patch.rank, 64)
    || !nullableBoundedText(patch.assignee, 64)) return false;
  return patch.expect === undefined || isTaskUpdateExpect(patch.expect);
}

export function isBoardTaskReorderInputV1(value: unknown): value is BoardTaskReorderInputV1 {
  if (!isRecord(value)) return false;
  const expected = ["status", "orderedIds", "expect"];
  if (value.priority !== undefined) expected.push("priority");
  if (!hasOnlyKeys(value, expected) || !isTaskStatus(value.status)
    || (value.priority !== undefined && !isTaskPriority(value.priority))
    || !isTaskIds(value.orderedIds, 500, false)
    || !isRecord(value.expect)) return false;
  const ids = value.orderedIds as string[];
  const expectations = value.expect;
  const expectationKeys = Object.keys(expectations);
  return expectationKeys.length === ids.length
    && expectationKeys.every((id) => ids.includes(id) && isTimestamp(expectations[id]));
}

export function isBoardValidationCloseInputV1(value: unknown): value is BoardValidationCloseInputV1 {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "outcome", "result_note"])
    && typeof value.id === "string"
    && VALIDATION_ID_RE.test(value.id)
    && isValidationOutcome(value.outcome)
    && boundedText(value.result_note, 1, 4_000);
}

export function isBoardValidationAssignInputV1(value: unknown): value is BoardValidationAssignInputV1 {
  if (!isRecord(value)) return false;
  const expected = ["id", "assignee"];
  if (value.expect !== undefined) expected.push("expect");
  if (!hasOnlyKeys(value, expected)
    || typeof value.id !== "string" || !VALIDATION_ID_RE.test(value.id)
    || !boundedText(value.assignee, 1, 64)) return false;
  if (value.expect === undefined) return true;
  if (!isRecord(value.expect) || !hasOnlyKeys(value.expect, ["assignee", "updatedAt"])) return false;
  return nullableBoundedText(value.expect.assignee, 64)
    && (value.expect.updatedAt === undefined || isTimestamp(value.expect.updatedAt));
}

function isTaskUpdateExpect(value: unknown): value is TaskUpdateExpect {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "assignee" && key !== "status" && key !== "updatedAt")) return false;
  if (value.assignee !== undefined && value.assignee !== null && !boundedText(value.assignee, 1, 64)) return false;
  if (value.status !== undefined && !isTaskStatus(value.status)) return false;
  return value.updatedAt === undefined || isTimestamp(value.updatedAt);
}

function isTaskIds(value: unknown, max: number, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)
    || value.some((id) => typeof id !== "string" || !TASK_ID_RE.test(id))) return false;
  return new Set(value).size === value.length;
}

function nullableBoundedText(value: unknown, max: number): boolean {
  return value === undefined || value === null || boundedText(value, 1, max);
}

function boundedText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const length = [...value].length;
  return length >= min && length <= max;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
