/**
 * Worktree EVIDENCE channel (spec 273) — pure helpers. A neutral, non-binary companion to the
 * binary verify-gate (spec 214): producers attach structured evidence records to a worktree agent
 * (keyed to a commit); consumers (parent agents over the bridge, the UI) read them. This is
 * engine+format, NOT governance — Tachyon defines the record SHAPE, never what `kind`/`severity`
 * MEAN, and evidence NEVER gates (the verify badge stays the gate).
 *
 * This module owns the pure parts: the record shape, HEAD-only staleness, the write-side cap +
 * verify-set replacement, and the mechanical summary. The side-effecting persistence + the
 * artifact dir live on the host (EvidenceStore); the bridge tools live in the MCP layer. Impure
 * stamps (id, producedAt, derived producer) are applied by the host BEFORE these helpers see a
 * record — so everything here is unit-tested with no IO, no clock, no randomness.
 */

export type Severity = "info" | "warn" | "error";

/** The current record schema version. Bump ONLY on a breaking shape change. */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Max evidence records retained per agent (oldest dropped). */
export const MAX_EVIDENCE_PER_AGENT = 100;

/** The reserved producer + kind the built-in verify step-result producer uses (replace-on-rerun). */
export const VERIFY_PRODUCER = "verify";
export const STEP_RESULT_KIND = "step-result";

/** A single non-binary evidence record about a worktree agent. */
export interface WorktreeEvidence {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  /** unique within the agent's evidence log (host-stamped) */
  id: string;
  /** the worktree agent the evidence is ABOUT */
  targetAgent: string;
  /** who produced it — DERIVED by the host from the connected identity, NEVER client-supplied */
  producer: string;
  /** optional sub-context the producer acted for */
  onBehalfOf?: string;
  /** optional run/verify id that produced it (drives verify-set replacement) */
  sourceRunId?: string;
  /** worktree HEAD when produced → HEAD-only staleness */
  atCommit: string;
  /** recorded for context — NOT used to auto-stale (unrelated dirt must not invalidate evidence) */
  worktreeDirtyAtProduction?: boolean;
  /** ISO timestamp (host-stamped) */
  producedAt: string;
  /** NEUTRAL label ("step-result" | "advisory" | "judgment" | "artifact" | …) — Tachyon does not police the vocabulary */
  kind: string;
  severity: Severity;
  /** one-line, human/agent-readable */
  summary: string;
  /** optional durable text/log */
  detail?: string;
  /** NEUTRAL structured payload (e.g. per-step {index,step,cmd,exitCode,durationMs,state}) */
  data?: Record<string, unknown>;
  /** refs into the managed evidence artifact dir (resolved + traversal-checked by the host) */
  artifacts?: string[];
}

/**
 * HEAD-only staleness (DIVERGES from verify on purpose): evidence is stale when the worktree HEAD
 * moved past the commit it was produced against. Unlike verify, an unrelated DIRTY worktree does
 * NOT stale evidence — a visual judgment must not silently rot because of uncommitted scratch files.
 */
export function evidenceStale(record: Pick<WorktreeEvidence, "atCommit">, headRef: string): boolean {
  if (!record.atCommit) return true;
  return record.atCommit !== headRef;
}

/** A record annotated with its freshly-computed staleness (what consumers read). */
export type EvidenceView = WorktreeEvidence & { stale: boolean };

/** Annotate each record with HEAD-only staleness, newest-first. Pure. */
export function viewEvidence(records: readonly WorktreeEvidence[], headRef: string): EvidenceView[] {
  return [...records]
    .sort((a, b) => (a.producedAt < b.producedAt ? 1 : a.producedAt > b.producedAt ? -1 : 0))
    .map((r) => ({ ...r, stale: evidenceStale(r, headRef) }));
}

/**
 * The new full record set after appending one record: enforce the per-agent cap (drop OLDEST by
 * `producedAt`). Pure — the host persists the returned array atomically.
 */
export function appendCapped(
  existing: readonly WorktreeEvidence[],
  added: WorktreeEvidence,
  max: number = MAX_EVIDENCE_PER_AGENT,
): WorktreeEvidence[] {
  return capOldest([...existing, added], max);
}

/**
 * Replace the built-in verify step-result set (spec 273 producer dedup): a re-run at the same (or a
 * new) commit must REPLACE the prior verify-produced step records for this agent, never append a
 * second pile. All non-verify evidence is preserved untouched; the cap still applies. Pure.
 */
export function replaceVerifySet(
  existing: readonly WorktreeEvidence[],
  newStepRecords: readonly WorktreeEvidence[],
  max: number = MAX_EVIDENCE_PER_AGENT,
): WorktreeEvidence[] {
  const kept = existing.filter((r) => !(r.producer === VERIFY_PRODUCER && r.kind === STEP_RESULT_KIND));
  return capOldest([...kept, ...newStepRecords], max);
}

function capOldest(records: WorktreeEvidence[], max: number): WorktreeEvidence[] {
  if (records.length <= max) return records;
  // drop the OLDEST by producedAt; keep the newest `max`.
  return [...records].sort((a, b) => (a.producedAt < b.producedAt ? -1 : a.producedAt > b.producedAt ? 1 : 0)).slice(records.length - max);
}

/**
 * Validate an artifact ref BEFORE the host resolves it against the managed evidence dir: it must be
 * a relative path that stays inside the dir. Rejects empties, absolutes, `..` traversal, NUL bytes,
 * and backslash segments. Pure — the host joins a true ref onto `.tachyon/evidence/<agent>/` and
 * reports a missing file cleanly (a ref can be valid but its file gone after a worktree rebuild).
 */
export function isSafeArtifactRef(ref: string): boolean {
  if (!ref || ref.includes("\0")) return false;
  if (ref.startsWith("/") || /^[a-zA-Z]:/.test(ref)) return false; // absolute (posix or windows drive)
  const segments = ref.split(/[/\\]/);
  return !segments.some((s) => s === ".." || s === "");
}

/** A compact, MECHANICAL evidence summary for the verify handoff — neutral counts, NO privileged kind. */
export interface EvidenceSummary {
  total: number;
  fresh: number;
  stale: number;
  bySeverity: Record<Severity, number>;
  /** the latest N record summaries (newest-first), kind+severity+stale only — no semantic filtering */
  latest: { kind: string; severity: Severity; summary: string; stale: boolean }[];
}

/**
 * Mechanical summary folded into `verify_agent`/`list_agents`: total, fresh/stale, counts by
 * severity, and the latest N summaries. Deliberately neutral — it never special-cases a `kind`
 * (e.g. "judgment"), which would re-introduce opinion into a format meant to be opinion-free.
 */
export function summarizeEvidence(records: readonly WorktreeEvidence[], headRef: string, latestN = 3): EvidenceSummary {
  const views = viewEvidence(records, headRef);
  const bySeverity: Record<Severity, number> = { info: 0, warn: 0, error: 0 };
  let fresh = 0;
  let stale = 0;
  for (const v of views) {
    bySeverity[v.severity] += 1;
    if (v.stale) stale += 1;
    else fresh += 1;
  }
  return {
    total: views.length,
    fresh,
    stale,
    bySeverity,
    latest: views.slice(0, latestN).map((v) => ({ kind: v.kind, severity: v.severity, summary: v.summary, stale: v.stale })),
  };
}
