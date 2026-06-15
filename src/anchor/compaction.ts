/**
 * spec 216 (Part C) — best-effort detection that an agent's CLI just compacted /
 * summarized its conversation, which is when it forgets its spawn-time role.
 *
 * Data-driven on purpose: the exact banners are CLI-version-specific, so they live in one
 * tunable table, are fixture-tested, and are treated as BEST-EFFORT — the manual "Re-anchor
 * agent" command and `.tachyon/ROLE.md` are the guarantee, this is the convenience. Coverage
 * is claude + codex only for v1 (decision D-C); other runtimes return false (documented gap,
 * per the runtime-agnostic rule — never a silent universal assumption).
 */

import { runtimeOf } from "../resume/adapters.js";

/** Per-runtime compaction/summarization markers. Tune against live panes; keep them specific
 *  enough not to fire on an agent merely discussing "compaction" in its output. */
const MARKERS: Partial<Record<string, RegExp[]>> = {
  claude: [/compacting conversation/i, /compacted conversation/i, /conversation compacted/i],
  codex: [/summarizing conversation/i, /conversation summarized/i, /summarizing context/i],
};

/** Runtimes with a compaction detector in v1 (claude + codex). */
export function compactionRuntimes(): string[] {
  return Object.keys(MARKERS);
}

/**
 * True when the pane tail shows a compaction/summarization event for the command's runtime.
 * Returns false for runtimes without a detector (documented gap) and for unrecognized commands.
 */
export function detectCompaction(cmd: string, paneTail: string): boolean {
  const rt = runtimeOf(cmd);
  if (!rt) return false;
  const markers = MARKERS[rt];
  if (!markers) return false;
  return markers.some((re) => re.test(paneTail));
}
