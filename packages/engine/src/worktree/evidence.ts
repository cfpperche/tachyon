/**
 * Worktree EVIDENCE channel (spec 273) — pure helpers. A neutral, non-binary companion to the
 * evidence channel: producers attach structured evidence records to a worktree agent
 * (keyed to a commit); consumers (parent agents over the bridge, the UI) read them. This is
 * engine+format, NOT governance — Tachyon defines the record SHAPE, never what `kind`/`severity`
 * MEAN, and evidence never gates.
 *
 * This module owns the pure parts: the record shape, HEAD-only staleness, the write-side cap +
 * mechanical summary. The side-effecting persistence + the
 * artifact dir live on the host (EvidenceStore); the bridge tools live in the MCP layer. Impure
 * stamps (id, producedAt, derived producer) are applied by the host BEFORE these helpers see a
 * record — so everything here is unit-tested with no IO, no clock, no randomness.
 */

export type Severity = "info" | "warn" | "error";

/** spec 273 — the input to attach_evidence (producer is self-declared, per the bridge's caller model). */
export interface AttachEvidenceInput {
  targetAgent: string;
  producer: string;
  kind: string;
  severity: Severity;
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
  artifacts?: string[];
  onBehalfOf?: string;
  sourceRunId?: string;
}

/** The current record schema version. Bump ONLY on a breaking shape change. */
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Max evidence records retained per agent (oldest dropped). */
export const MAX_EVIDENCE_PER_AGENT = 100;

/** spec 274 — the managed evidence-artifact dir (workspace-relative, posix). Copied screenshots/logs live OUTSIDE
 *  the worktree (under `.tachyon/`, gitignored) so a verdict's artifact survives a worktree rebuild/removal. */
export const EVIDENCE_ARTIFACT_REL = ".tachyon/evidence";
export function evidenceArtifactRelDir(agent: string, id: string): string {
  return `${EVIDENCE_ARTIFACT_REL}/${agent}/${id}`;
}

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
  /** optional source run id that produced it */
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
  /** DURABLE artifact refs (spec 274): a producer attaches worktree-relative refs and `attachEvidence` COPIES them
   *  into the managed dir `.tachyon/evidence/<agent>/<id>/` (see `evidenceArtifacts.ts`), storing the managed,
   *  workspace-relative ref here — so the artifact survives a worktree rebuild/removal. (A symlink/non-regular-file
   *  source is rejected at copy time.) Consumers should still tolerate a missing file (manual deletion). */
  artifacts?: string[];
}

const SEVERITIES: readonly Severity[] = ["info", "warn", "error"];

/** Defensive parse of one persisted evidence record — drops malformed input, never throws. */
export function parseWorktreeEvidence(value: unknown): WorktreeEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string";
  if (!str(o.id) || !str(o.targetAgent) || !str(o.producer) || !str(o.atCommit) || !str(o.producedAt)) return undefined;
  if (!str(o.kind) || !str(o.summary)) return undefined;
  if (!SEVERITIES.includes(o.severity as Severity)) return undefined;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: o.id,
    targetAgent: o.targetAgent,
    producer: o.producer,
    ...(str(o.onBehalfOf) ? { onBehalfOf: o.onBehalfOf } : {}),
    ...(str(o.sourceRunId) ? { sourceRunId: o.sourceRunId } : {}),
    atCommit: o.atCommit,
    ...(typeof o.worktreeDirtyAtProduction === "boolean" ? { worktreeDirtyAtProduction: o.worktreeDirtyAtProduction } : {}),
    producedAt: o.producedAt,
    kind: o.kind,
    severity: o.severity as Severity,
    summary: o.summary,
    ...(str(o.detail) ? { detail: o.detail } : {}),
    ...(o.data && typeof o.data === "object" && !Array.isArray(o.data) ? { data: o.data as Record<string, unknown> } : {}),
    ...(Array.isArray(o.artifacts) ? { artifacts: o.artifacts.filter(str) } : {}),
  };
}

/**
 * HEAD-only staleness: evidence is stale when the worktree HEAD
 * moved past the commit it was produced against. An unrelated DIRTY worktree does
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

function capOldest(records: WorktreeEvidence[], max: number): WorktreeEvidence[] {
  const cap = Math.max(0, Math.floor(max));
  if (records.length <= cap) return records;
  // drop the OLDEST by producedAt; keep the newest `cap`.
  return [...records].sort((a, b) => (a.producedAt < b.producedAt ? -1 : a.producedAt > b.producedAt ? 1 : 0)).slice(records.length - cap);
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

/** A compact, MECHANICAL evidence summary for handoffs — neutral counts, NO privileged kind. */
export interface EvidenceSummary {
  total: number;
  fresh: number;
  stale: number;
  /** counts over ALL records (mechanical total) */
  bySeverity: Record<Severity, number>;
  /** counts over FRESH records only — what a current-signal consumer (the badge) should tint on */
  freshBySeverity: Record<Severity, number>;
  /** the latest N record summaries (newest-first), kind+severity+stale only — no semantic filtering */
  latest: { kind: string; severity: Severity; summary: string; stale: boolean }[];
}

/** A slim evidence indicator for the sidebar VM (counts only). */
export interface EvidenceBadgeCounts {
  total: number;
  stale: number;
  warn: number;
  error: number;
}

/** Distil a summary into the sidebar badge counts — undefined when there's nothing to show. Pure.
 *  total and warn/error reflect FRESH records only (a stale error must not keep lighting the badge). */
export function evidenceBadge(summary: EvidenceSummary | undefined): EvidenceBadgeCounts | undefined {
  // t-1d198e — the badge is "there is something you have not seen about the CURRENT tree".
  // Stale stays readable via list_evidence; it must not keep lighting the sidebar.
  if (!summary || summary.fresh === 0) return undefined;
  return { total: summary.fresh, stale: 0, warn: summary.freshBySeverity.warn, error: summary.freshBySeverity.error };
}

/**
 * Mechanical summary used by evidence consumers: total, fresh/stale, counts by
 * severity, and the latest N summaries. Deliberately neutral — it never special-cases a `kind`
 * (e.g. "judgment"), which would re-introduce opinion into a format meant to be opinion-free.
 */
export function summarizeEvidence(records: readonly WorktreeEvidence[], headRef: string, latestN = 3): EvidenceSummary {
  const views = viewEvidence(records, headRef);
  const bySeverity: Record<Severity, number> = { info: 0, warn: 0, error: 0 };
  const freshBySeverity: Record<Severity, number> = { info: 0, warn: 0, error: 0 };
  let fresh = 0;
  let stale = 0;
  for (const v of views) {
    bySeverity[v.severity] += 1;
    if (v.stale) stale += 1;
    else {
      fresh += 1;
      freshBySeverity[v.severity] += 1;
    }
  }
  const n = Math.max(0, Math.floor(latestN));
  return {
    total: views.length,
    fresh,
    stale,
    bySeverity,
    freshBySeverity,
    latest: views.slice(0, n).map((v) => ({ kind: v.kind, severity: v.severity, summary: v.summary, stale: v.stale })),
  };
}
