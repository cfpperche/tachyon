import type { NotifyLevel } from "./EngineHost.js";
import type { NoticeActionRoute } from "./EngineHost.js";

/**
 * t-ee2f19 — the ONLY commands a persisted notice may carry back across a restart.
 *
 * A restored notice is read from state.json, which is not a trusted input. Without a closed list, the
 * durable-route feature would turn the notice inbox into a place where writing a file makes the editor
 * run a command — so the list is checked on the way out AND on the way in, and anything unrecognised
 * restores as an inert history row exactly like today.
 *
 * All three are pure navigation: they open a view on something the human was already told about. An
 * action with an EFFECT (restart an agent, resume the fleet, run doctor) is deliberately absent —
 * re-arming that from disk is a different decision, and not one this task needs to make.
 */
export const DURABLE_NOTICE_COMMANDS: readonly string[] = [
  "tachyon.openControlTask",
  "tachyon.openHumanInbox",
  "tachyon.openApprovals",
];

/** Bounds a restored route: enough for the widest live caller (wsHash + a target object), no more. */
const MAX_ROUTE_ARGS = 4;

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
  /**
   * Labels only (history). Live action ids while still invokable.
   *
   * t-ee2f19 — `route` rides along when the action's destination is expressible as data, which is what
   * lets it be rebuilt after the closure that first backed it is gone.
   */
  actions: Array<{ id: string; label: string; route?: NoticeActionRoute }>;
  /** false until human opens/marks the strip (auto-dismiss does NOT mark read). */
  read: boolean;
  /** True while a live run() is still registered for at least one action. */
  actionsLive: boolean;
}

/**
 * t-ee2f19 — accept a persisted route only if it is one we would have written ourselves.
 *
 * Deliberately shallow on the ARGS: every allowed command is a view-opener whose own handler already
 * validates what it got (`byHash` rejects an unknown workspace, the Inbox handler accepts three kinds
 * and falls back to the list). Re-deriving those rules here would be a second copy free to disagree
 * with the first — see t-b4a799. What must be enforced HERE is the part no downstream handler can
 * check: that the command is one of ours at all.
 */
export function restoreNoticeRoute(value: unknown): NoticeActionRoute | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.command !== "string" || !DURABLE_NOTICE_COMMANDS.includes(value.command)) return undefined;
  if (!Array.isArray(value.args) || value.args.length > MAX_ROUTE_ARGS) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value.args);
  } catch {
    return undefined;
  }
  // A cyclic or otherwise unserialisable arg cannot have come from us, and JSON.stringify silently
  // drops undefined rather than failing — so round-trip instead of trusting the value in hand.
  if (typeof json !== "string" || json.length > 4_096) return undefined;
  return { command: value.command, args: JSON.parse(json) as unknown[] };
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
      || !isUuid(row.id) || seen.has(row.id)
      || typeof row.message !== "string" || row.message.length === 0 || row.message.length > 4_096
      || (row.level !== "info" && row.level !== "warn" && row.level !== "error")
      || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
      || !Number.isSafeInteger(row.collapsedCount) || (row.collapsedCount as number) < 1
      || !Array.isArray(row.actions) || row.actions.length > 8) continue;
    const actions: Array<{ id: string; label: string; route?: NoticeActionRoute }> = [];
    let valid = true;
    for (const action of row.actions) {
      if (!isRecord(action)
        || !isUuid(action.id)
        || typeof action.label !== "string" || action.label.length === 0 || action.label.length > 128) {
        valid = false;
        break;
      }
      // t-ee2f19 — a rejected route drops to a label-only history row; it never invalidates the notice.
      const route = restoreNoticeRoute(action.route);
      actions.push({ id: action.id, label: action.label, ...(route ? { route } : {}) });
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
      // t-ee2f19 — closures are still process-local, so this stays FALSE unless a route survived.
      // "Live" has always meant one thing to the webview: pressing this does something. A restored
      // route means exactly that again; a restored label alone still does not, and must not claim to.
      actionsLive: actions.some((action) => action.route !== undefined),
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

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
