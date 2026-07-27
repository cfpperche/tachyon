import type { FleetVM, NoticeVM } from "./types.js";

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

/**
 * Every open workspace-owned attention item, in one deterministic FIFO order.
 *
 * `t-fde5b6` — this used to slice the list to a six-row cap and report the remainder as
 * `+N queued`, which gave the panel a second state the human had to drain. The cap bought nothing:
 * `.attention-stack` is already `max-height: min(64vh, 600px)` with `overflow: hidden`, and
 * `.attention-list` inside it is `overflow: auto`. The container was bounded and scrollable either
 * way, so the cap only decided whether an item was RENDERED — never how tall the panel got. Handing
 * back every row therefore keeps the exact same maximum height and the same scroll, and a burst
 * lands in the list as it is emitted instead of waiting behind a counter.
 */
export function attentionRows(fleets: FleetVM[]): AttentionRow[] {
  const rows = fleets
    .flatMap((f) => (f.notices ?? []).filter((n) => !n.read).map((n): AttentionRow => ({
      n,
      ...(f.folder?.hash ? { hash: f.folder.hash } : {}),
      ...(f.folder?.name ? { folder: f.folder.name } : {}),
    })))
    .sort((a, b) => Date.parse(a.n.at) - Date.parse(b.n.at)
      || (a.hash ?? "").localeCompare(b.hash ?? "")
      || a.n.id.localeCompare(b.n.id));
  return rows;
}
