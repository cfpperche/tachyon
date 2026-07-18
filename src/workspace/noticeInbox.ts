import type { NotifyLevel } from "../bridge/tools.js";

/** t-7f94f2 / spec 397 — durable human-facing notice history (toast is attention only). */
export interface NoticeInboxEntry {
  id: string;
  message: string;
  level: NotifyLevel;
  at: string;
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

export function noticeDedupeKey(level: NotifyLevel, message: string): string {
  return `${level}\0${message.replace(/\s+/g, " ").trim()}`;
}
