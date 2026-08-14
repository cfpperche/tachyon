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
const MARKERS: Partial<Record<string, { detection: RegExp[]; compact: string; fresh: string }>> = {
  claude: {
    detection: [/compacting conversation/i, /compacted conversation/i, /conversation compacted/i],
    compact: "/compact",
    fresh: "/clear",
  },
  codex: {
    detection: [/summarizing conversation/i, /conversation summarized/i, /summarizing context/i],
    compact: "/compact",
    fresh: "/new",
  },
  grok: { detection: [], compact: "/compact", fresh: "/new" },
};

/** Runtimes with a compaction detector in v1 (claude + codex). */
export function compactionRuntimes(): string[] {
  return Object.entries(MARKERS).filter(([, entry]) => (entry?.detection.length ?? 0) > 0).map(([runtime]) => runtime);
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
  return markers.detection.some((re) => re.test(paneTail));
}

export type ContextRenewalMode = "compact" | "fresh";

/** The only measured runtime→gesture table. Unknown runtimes deliberately have no fallback. */
export function contextRenewalGesture(cmd: string, mode: ContextRenewalMode): string | undefined {
  const runtime = runtimeOf(cmd);
  return runtime ? MARKERS[runtime]?.[mode] : undefined;
}
