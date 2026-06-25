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
}

export interface ProbeView {
  rows: ProbeViewRow[];
  total: number;
  running: number;
  completed: number;
  failed: number;
  empty: boolean;
}

/** A compact "Ns/Nm/Nh/Nd ago" relative label from an ISO timestamp. */
export function relativeAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function buildProbeView(records: ProbeRunRecord[], nowMs: number): ProbeView {
  const rows: ProbeViewRow[] = records.map((r) => ({
    runId: r.runId,
    shortId: r.runId.replace(/^probe-/, "").slice(0, 8),
    runtime: r.runtime,
    archetype: r.archetype ?? "—",
    caller: r.caller ?? "—",
    status: r.status,
    reason: r.reason ?? "—",
    ageLabel: relativeAge(r.createdAt, nowMs),
    excerpt: (r.excerpt ?? "").replace(/\s+/g, " ").trim(),
  }));
  return {
    rows,
    total: rows.length,
    running: rows.filter((r) => r.status === "running").length,
    completed: rows.filter((r) => r.status === "completed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    empty: rows.length === 0,
  };
}
