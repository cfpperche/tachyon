/**
 * t-96c1b3 — project a Claude session plan onto the canonical internal-plan type.
 *
 * Channel: `{configHome}/tasks/<sessionId>/<id>.json` (the runtime store).
 * TaskCreated is create-only — TaskUpdate emits no hook, so a hook-only reader loses
 * status and blockedBy. The TaskCreate tool_result in the measured stream is a success
 * string, not the snapshot. The store is the only channel that keeps id + status +
 * blockedBy after addBlockedBy.
 *
 * `Task` / `TaskOutput` / `TaskStop` in init.tools are the subagent family, not this plan.
 */
import fs from "node:fs";
import path from "node:path";
import {
  isInternalChecklistStatus,
  type InternalChecklistItem,
  type InternalChecklistRead,
  type InternalChecklistStatus,
} from "./internalChecklist.js";

/** Plan-channel tools. Distinct from the subagent family `Task` / `TaskOutput` / `TaskStop`. */
export const CLAUDE_INTERNAL_CHECKLIST_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;
export const CLAUDE_SUBAGENT_TOOLS = ["Task", "TaskOutput", "TaskStop"] as const;

export function claudeInternalChecklistToolsPresent(initTools: readonly string[]): boolean {
  return CLAUDE_INTERNAL_CHECKLIST_TOOLS.every((name) => initTools.includes(name));
}

const STATUS_ALIASES: Record<string, InternalChecklistStatus> = {
  pending: "pending",
  completed: "completed",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  inProgress: "in-progress",
};

export function readClaudeInternalChecklist(input: {
  configHome: string;
  sessionId: string;
}): InternalChecklistRead {
  const sessionDir = claudeTaskStoreDir(input.configHome, input.sessionId);
  if (!sessionDir || !fs.existsSync(sessionDir)) return { state: "mute" };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return { state: "mute" };
  }
  const items: InternalChecklistItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const item = readStoreItem(path.join(sessionDir, entry.name));
    if (item) items.push(item);
  }
  items.sort(compareChecklistItems);
  return { state: "snapshot", items };
}

export function claudeTaskStoreDir(configHome: string, sessionId: string): string | undefined {
  if (!configHome || !sessionId) return undefined;
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId === ".." || sessionId === ".") {
    return undefined;
  }
  return path.join(configHome, "tasks", sessionId);
}

function readStoreItem(file: string): InternalChecklistItem | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const row = parsed as Record<string, unknown>;
  const text = typeof row.subject === "string" ? row.subject.trim() : "";
  if (!text) return undefined;
  const status = mapStatus(row.status);
  if (!status) return undefined;
  const item: InternalChecklistItem = { text, status };
  if (typeof row.id === "string" && row.id.length > 0) {
    return { ...item, id: row.id, ...blockedByField(row.blockedBy) };
  }
  return { ...item, ...blockedByField(row.blockedBy) };
}

function mapStatus(value: unknown): InternalChecklistStatus | undefined {
  if (typeof value !== "string") return undefined;
  const mapped = STATUS_ALIASES[value];
  if (mapped) return mapped;
  return isInternalChecklistStatus(value) ? value : undefined;
}

function blockedByField(value: unknown): Pick<InternalChecklistItem, "blockedBy"> | {} {
  if (!Array.isArray(value)) return {};
  const ids = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return ids.length > 0 ? { blockedBy: ids } : {};
}

function compareChecklistItems(a: InternalChecklistItem, b: InternalChecklistItem): number {
  const aId = a.id ?? "";
  const bId = b.id ?? "";
  const aNum = Number(aId);
  const bNum = Number(bId);
  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aId !== "" && bId !== "") return aNum - bNum;
  return aId.localeCompare(bId);
}
