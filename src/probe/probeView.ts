/**
 * Spec 257 (D9) — the PURE view-model for the probe observability inspector. The webview is a thin
 * renderer; all the formatting/derivation logic lives here so it is unit-tested rather than trapped
 * in the vscode layer. Given the stored run records (the ledger), produce render-ready rows + counts.
 */

import type { ProbeRunRecord } from "./ProbeStore.js";
import type { ProbeStatus } from "./taxonomy.js";

export interface ProbeViewRow {
  runId: string;
  shortId: string;
  runtime: string;
  archetype: string;
  caller: string;
  status: ProbeStatus;
  reason: string;
  ageLabel: string;
  excerpt: string;
  /** SDD 473 — the model explicitly requested for this run, or "—" when none was. */
  requestedModel: string;
  /** SDD 473 — whether the effective model was shown to be the requested one. */
  modelProof: string;
  /**
   * SDD 475 — what the model cell SAYS. Only ever an effective identifier, the literal `unproven`,
   * or `—`. A requested identifier is never rendered here; that is the invariant this column exists
   * to make visible.
   */
  model: string;
  /** Closed set driving the cell's styling, so copy changes never silently change colour. */
  modelState: "proven" | "mismatch" | "unproven" | "reported" | "none";
  /** Hover context — names the requested model where it matters, without printing it in the cell. */
  modelTitle: string;
}

/**
 * SDD 475 — turn a stored run's provenance into one unambiguous cell.
 *
 * The four shapes come straight from SDD 473's verdict. The rule that matters: when nothing can be
 * proven, the cell says so rather than borrowing the requested identifier, because a table that
 * shows the requested model in the effective position re-creates exactly the silent-fallback
 * confusion those specs exist to remove.
 */
export function modelCell(row: {
  status: ProbeStatus;
  requestedModel?: string;
  effectiveModel?: string;
  modelProof?: string;
}): { model: string; modelState: ProbeViewRow["modelState"]; modelTitle: string } {
  const effective = row.effectiveModel?.trim();
  const requested = row.requestedModel?.trim();
  // A run still in flight has no verdict yet; asserting one would read as a finished judgement.
  if (row.status === "running") {
    return { model: "—", modelState: "none", modelTitle: requested ? `requested ${requested}; still running` : "still running" };
  }
  if (row.modelProof === "mismatch" && effective) {
    return {
      model: effective,
      modelState: "mismatch",
      modelTitle: requested ? `requested ${requested} — the runtime reported ${effective}` : `unexpected model ${effective}`,
    };
  }
  if (row.modelProof === "proven" && effective) {
    return { model: effective, modelState: "proven", modelTitle: `requested and confirmed ${effective}` };
  }
  if (row.modelProof === "unproven") {
    return {
      model: "unproven",
      modelState: "unproven",
      // The requested model belongs in the tooltip, never in the cell.
      modelTitle: requested
        ? `requested ${requested}; the runtime reported no effective model`
        : "the runtime reported no effective model",
    };
  }
  // not-requested (or an older row with no verdict): still show what the runtime reported, if any —
  // nobody asked for a model, but the runtime told us what it used and that is a real fact.
  if (effective) return { model: effective, modelState: "reported", modelTitle: `reported ${effective}; no model was requested` };
  return { model: "—", modelState: "none", modelTitle: "no model requested and none reported" };
}

export interface ProbeView {
  rows: ProbeViewRow[];
  total: number;
  running: number;
  completed: number;
  failed: number;
  empty: boolean;
  /** spec 322 — set when this view is filtered to one launching agent (drives the per-agent title/empty state). */
  caller?: string;
}

/** A compact "Ns/Nm/Nh/Nd ago" relative label from an ISO timestamp. */
export function relativeAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000)); // floor: don't round 59s up to "1m ago" (codex UI #9)
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const EXCERPT_CAP = 240; // bound what reaches the webview, even if the store handed us more (codex UI #11)

export function buildProbeView(records: ProbeRunRecord[], nowMs: number, caller?: string): ProbeView {
  // spec 322 — per-agent view: the ONE shared filter point (probe dueto F5) — every consumer derives rows
  // AND counts from the same filtered set. A caller-less record only appears in the unfiltered view.
  const scoped = caller === undefined ? records : records.filter((r) => r.caller === caller);
  // Sort in the PURE model so the inspector never depends on the store's iteration order (codex UI #10):
  // newest-first by createdAt, original index as a stable tie-breaker.
  const ordered = scoped
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt) || a.i - b.i)
    .map((x) => x.r);
  const rows: ProbeViewRow[] = ordered.map((r) => ({
    runId: r.runId,
    shortId: r.runId.replace(/^probe-/, "").slice(0, 8),
    runtime: r.runtime,
    archetype: r.archetype ?? "—",
    caller: r.caller ?? "—",
    status: r.status,
    reason: r.reason ?? "—",
    ageLabel: relativeAge(r.createdAt, nowMs),
    excerpt: (r.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_CAP),
    requestedModel: r.requestedModel ?? "—",
    modelProof: r.modelProof ?? "unproven",
    ...modelCell(r),
  }));
  return {
    rows,
    total: rows.length,
    running: rows.filter((r) => r.status === "running").length,
    completed: rows.filter((r) => r.status === "completed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    empty: rows.length === 0,
    ...(caller !== undefined ? { caller } : {}),
  };
}
