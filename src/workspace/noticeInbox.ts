import type { NotifyLevel } from "../bridge/tools.js";

/** t-7f94f2 / spec 397 — durable human-facing notice history (toast is attention only). */
export interface NoticeInboxEntry {
  id: string;
  message: string;
  level: NotifyLevel;
  at: string;
  /** Latest duplicate occurrence; `at` remains the FIFO insertion time. */
  lastOccurredAt?: string;
  /** Exact-duplicate collapses in the dedupe window. */
  collapsedCount: number;
  /** Labels only (history). Live action ids while still invokable. */
  actions: Array<{ id: string; label: string }>;
  /** false until human opens/marks the strip (auto-dismiss does NOT mark read). */
  read: boolean;
  /** True while a live run() is still registered for at least one action. */
  actionsLive: boolean;
}

export const NOTICE_INBOX_CAP = 100;
export const NOTICE_INBOX_STATE_KEY = "attention.noticeInbox.v1";

/** Parse daemon-owned persisted attention without trusting state.json shape. */
export function restoreNoticeInbox(value: unknown): NoticeInboxEntry[] {
  if (!Array.isArray(value)) return [];
  const restored: NoticeInboxEntry[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!isRecord(row)
      || typeof row.id !== "string" || row.id.length === 0 || row.id.length > 128 || seen.has(row.id)
      || typeof row.message !== "string" || row.message.length === 0 || row.message.length > 4_096
      || (row.level !== "info" && row.level !== "warn" && row.level !== "error")
      || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
      || !Number.isSafeInteger(row.collapsedCount) || (row.collapsedCount as number) < 1
      || !Array.isArray(row.actions) || row.actions.length > 8) continue;
    const actions: Array<{ id: string; label: string }> = [];
    let valid = true;
    for (const action of row.actions) {
      if (!isRecord(action)
        || typeof action.id !== "string" || action.id.length === 0 || action.id.length > 128
        || typeof action.label !== "string" || action.label.length === 0 || action.label.length > 128) {
        valid = false;
        break;
      }
      actions.push({ id: action.id, label: action.label });
    }
    if (!valid) continue;
    seen.add(row.id);
    const lastOccurredAt = typeof row.lastOccurredAt === "string" && Number.isFinite(Date.parse(row.lastOccurredAt))
      ? new Date(row.lastOccurredAt).toISOString()
      : new Date(row.at).toISOString();
    restored.push({
      id: row.id,
      message: row.message,
      level: row.level,
      at: new Date(row.at).toISOString(),
      lastOccurredAt,
      collapsedCount: row.collapsedCount as number,
      actions,
      read: false,
      // Callback closures are process-local. Never imply restored actions are executable.
      actionsLive: false,
    });
    if (restored.length >= NOTICE_INBOX_CAP) break;
  }
  return restored;
}

export function noticeDedupeKey(level: NotifyLevel, message: string): string {
  return `${level}\0${message.replace(/\s+/g, " ").trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
