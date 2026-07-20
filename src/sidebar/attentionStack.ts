import type { FleetVM, NoticeVM } from "./types.js";

export const ATTENTION_VISIBLE_CAP = 6;

/**
 * t-8aeaac follow-up — display-only split of the author baked into `notice.message` text
 * (taskNotificationPolicy's "… by <agent>: title" / the generic notify tool's "[<agent>] …"
 * prefix), so the card can render it in its own footer slot instead of inline in the body.
 * Pure parse over the persisted string — no data model change, so it degrades harmlessly for
 * any notice that never carried an author (a plain non-task `host.notify` call, or history
 * predating this format).
 */
export function splitNoticeAuthor(message: string): { body: string; author?: string } {
  const bracket = /^\[([A-Za-z0-9][\w.-]*)\]\s(.*)$/s.exec(message);
  if (bracket) return { body: bracket[2]!, author: bracket[1]! };
  const byClause = /^(.*?)\sby\s([A-Za-z0-9][\w.-]*):\s(.*)$/s.exec(message);
  if (byClause) return { body: `${byClause[1]}: ${byClause[3]}`, author: byClause[2]! };
  return { body: message };
}

export interface AttentionRow {
  n: NoticeVM;
  hash?: string;
  folder?: string;
}

/** Global deterministic FIFO window over all open workspace-owned attention. */
export function attentionWindow(fleets: FleetVM[]): { rows: AttentionRow[]; visible: AttentionRow[]; queued: number } {
  const rows = fleets
    .flatMap((f) => (f.notices ?? []).filter((n) => !n.read).map((n): AttentionRow => ({
      n,
      ...(f.folder?.hash ? { hash: f.folder.hash } : {}),
      ...(f.folder?.name ? { folder: f.folder.name } : {}),
    })))
    .sort((a, b) => Date.parse(a.n.at) - Date.parse(b.n.at)
      || (a.hash ?? "").localeCompare(b.hash ?? "")
      || a.n.id.localeCompare(b.n.id));
  const visible = rows.slice(0, ATTENTION_VISIBLE_CAP);
  return { rows, visible, queued: rows.length - visible.length };
}
