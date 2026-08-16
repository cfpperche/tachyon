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
  isInternalChecklistStatus,
  type InternalChecklistItem,
  type InternalChecklistRead,
  type InternalChecklistStatus,
} from "./internalChecklist.js";

export const GROK_INTERNAL_PLAN_UPDATES = "updates.jsonl";

const STATUS_ALIASES: Record<string, InternalChecklistStatus> = {
  pending: "pending",
  completed: "completed",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  inProgress: "in-progress",
};

export function grokInternalChecklistUpdatesPath(input: {
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

export function readGrokInternalChecklist(input: {
  configHome: string;
  cwd: string;
  sessionId: string;
}): InternalChecklistRead {
  const file = grokInternalChecklistUpdatesPath(input);
  if (!file || !fs.existsSync(file)) return { state: "mute" };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "mute" };
  }
  let spoke = false;
  let items: InternalChecklistItem[] = [];
  for (const line of text.split("\n")) {
    const projected = projectChecklistLine(line);
    if (!projected) continue;
    spoke = true;
    items = carryIds(items, projected);
  }
  return spoke ? { state: "snapshot", items } : { state: "mute" };
}

function projectChecklistLine(line: string): InternalChecklistItem[] | undefined {
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
  return projectChecklistEntries(update);
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

function projectTodosUpdated(update: Record<string, unknown>): InternalChecklistItem[] | undefined {
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

function projectChecklistEntries(update: Record<string, unknown>): InternalChecklistItem[] | undefined {
  if (update.sessionUpdate !== "plan") return undefined;
  if (update.entries === undefined) return [];
  if (!Array.isArray(update.entries)) return undefined;
  return projectTodoList(update.entries);
}

function projectTodoMap(todos: Record<string, unknown>): InternalChecklistItem[] {
  const items: InternalChecklistItem[] = [];
  for (const [id, row] of Object.entries(todos)) {
    const item = projectTodoRow(row);
    if (!item) continue;
    items.push(id.length > 0 ? { ...item, id } : item);
  }
  return items;
}

function projectTodoList(rows: readonly unknown[]): InternalChecklistItem[] {
  const items: InternalChecklistItem[] = [];
  for (const row of rows) {
    const item = projectTodoRow(row);
    if (item) items.push(item);
  }
  return items;
}

function projectTodoRow(value: unknown): InternalChecklistItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const text = typeof value.content === "string" ? value.content.trim() : "";
  if (!text) return undefined;
  const status = mapStatus(value.status);
  if (!status) return undefined;
  const item: InternalChecklistItem = { text, status };
  if (typeof value.id === "string" && value.id.length > 0) {
    return { ...item, id: value.id };
  }
  return item;
}

function carryIds(previous: readonly InternalChecklistItem[], next: InternalChecklistItem[]): InternalChecklistItem[] {
  if (previous.length !== next.length) return next;
  return next.map((item, index) => {
    if (item.id) return item;
    const prior = previous[index];
    if (prior?.id && prior.text === item.text && prior.status === item.status) {
      return { ...item, id: prior.id };
    }
    return item;
  });
}

function mapStatus(value: unknown): InternalChecklistStatus | undefined {
  if (typeof value !== "string") return undefined;
  const mapped = STATUS_ALIASES[value];
  if (mapped) return mapped;
  return isInternalChecklistStatus(value) ? value : undefined;
}

function isSafePathSegment(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && value !== ".." && value !== ".";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
