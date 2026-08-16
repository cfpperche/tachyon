/**
 * t-904de5 — project a Grok session plan onto the canonical internal-plan type.
 *
 * Channel: `{configHome}/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl`
 * Events: `sessionUpdate: "plan"` and `rawOutput.type == "Todo"` / `TodosUpdated`.
 * Activity tails a different session file; this reader does not.
 * Grok todo_write ids live in `TodosUpdated.state.todos` keys — preserve them.
 * Grok has no blockedBy — omit.
 *
 * Capture is live: Tachyon dismiss wipes the session directory (t-23ee99). A post-dismiss
 * read is mute and is not evidence that the turn had no plan.
 */
import fs from "node:fs";
import path from "node:path";
import {
  isInternalPlanStatus,
  type InternalPlanItem,
  type InternalPlanRead,
  type InternalPlanStatus,
} from "./internalPlan.js";

export const GROK_INTERNAL_PLAN_UPDATES = "updates.jsonl";

const STATUS_ALIASES: Record<string, InternalPlanStatus> = {
  pending: "pending",
  completed: "completed",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  inProgress: "in-progress",
};

export function grokInternalPlanUpdatesPath(input: {
  configHome: string;
  cwd: string;
  sessionId: string;
}): string | undefined {
  if (!input.configHome || !input.cwd || !input.sessionId) return undefined;
  if (!isSafePathSegment(input.sessionId)) return undefined;
  return path.join(
    input.configHome,
    "sessions",
    encodeURIComponent(input.cwd),
    input.sessionId,
    GROK_INTERNAL_PLAN_UPDATES,
  );
}

export function readGrokInternalPlan(input: {
  configHome: string;
  cwd: string;
  sessionId: string;
}): InternalPlanRead {
  const file = grokInternalPlanUpdatesPath(input);
  if (!file || !fs.existsSync(file)) return { state: "mute" };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "mute" };
  }
  let spoke = false;
  let items: InternalPlanItem[] = [];
  for (const line of text.split("\n")) {
    const projected = projectPlanLine(line);
    if (!projected) continue;
    spoke = true;
    items = carryIds(items, projected);
  }
  return spoke ? { state: "snapshot", items } : { state: "mute" };
}

function projectPlanLine(line: string): InternalPlanItem[] | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  const update = extractUpdate(parsed);
  if (!update) return undefined;
  const fromTodos = projectTodosUpdated(update);
  if (fromTodos !== undefined) return fromTodos;
  return projectPlanEntries(update);
}

function extractUpdate(record: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(record)) return undefined;
  if (isPlainObject(record.update)) return record.update;
  if (isPlainObject(record.params) && isPlainObject(record.params.update)) {
    return record.params.update;
  }
  if (typeof record.sessionUpdate === "string") return record;
  return undefined;
}

function projectTodosUpdated(update: Record<string, unknown>): InternalPlanItem[] | undefined {
  if (!isPlainObject(update.rawOutput)) return undefined;
  const raw = update.rawOutput;
  if (raw.type !== "Todo" || !isPlainObject(raw.TodosUpdated)) return undefined;
  const payload = raw.TodosUpdated;
  if (isPlainObject(payload.state) && isPlainObject(payload.state.todos)) {
    return projectTodoMap(payload.state.todos);
  }
  if (Array.isArray(payload.todos)) return projectTodoList(payload.todos);
  return [];
}

function projectPlanEntries(update: Record<string, unknown>): InternalPlanItem[] | undefined {
  if (update.sessionUpdate !== "plan") return undefined;
  if (update.entries === undefined) return [];
  if (!Array.isArray(update.entries)) return undefined;
  return projectTodoList(update.entries);
}

function projectTodoMap(todos: Record<string, unknown>): InternalPlanItem[] {
  const items: InternalPlanItem[] = [];
  for (const [id, row] of Object.entries(todos)) {
    const item = projectTodoRow(row);
    if (!item) continue;
    items.push(id.length > 0 ? { ...item, id } : item);
  }
  return items;
}

function projectTodoList(rows: readonly unknown[]): InternalPlanItem[] {
  const items: InternalPlanItem[] = [];
  for (const row of rows) {
    const item = projectTodoRow(row);
    if (item) items.push(item);
  }
  return items;
}

function projectTodoRow(value: unknown): InternalPlanItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const texto = typeof value.content === "string" ? value.content.trim() : "";
  if (!texto) return undefined;
  const status = mapStatus(value.status);
  if (!status) return undefined;
  const item: InternalPlanItem = { texto, status };
  if (typeof value.id === "string" && value.id.length > 0) {
    return { ...item, id: value.id };
  }
  return item;
}

function carryIds(previous: readonly InternalPlanItem[], next: InternalPlanItem[]): InternalPlanItem[] {
  if (previous.length !== next.length) return next;
  return next.map((item, index) => {
    if (item.id) return item;
    const prior = previous[index];
    if (prior?.id && prior.texto === item.texto && prior.status === item.status) {
      return { ...item, id: prior.id };
    }
    return item;
  });
}

function mapStatus(value: unknown): InternalPlanStatus | undefined {
  if (typeof value !== "string") return undefined;
  const mapped = STATUS_ALIASES[value];
  if (mapped) return mapped;
  return isInternalPlanStatus(value) ? value : undefined;
}

function isSafePathSegment(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && value !== ".." && value !== ".";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
