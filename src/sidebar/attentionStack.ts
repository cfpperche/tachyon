import type { FleetVM, NoticeVM } from "./types.js";

export const ATTENTION_VISIBLE_CAP = 6;

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
