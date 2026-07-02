// spec 245 inc D — PURE view-model helpers for the Project Handoff panel. No vscode / no DOM (unit-tested
// in node, the "logic in the vscode layer escapes CI" lesson). The host (HandoffPanel.ts) assembles a
// HandoffViewModel from the engine snapshot + notes and posts it; the Preact App renders it as-is.

import type { StalenessState } from "../../handoff/ProjectHandoffStore.js";
import type { HandoffDistillRuntimeVM } from "./distill.js";

/** A pending note as the panel renders it (the engine's HandoffNote shape, kept local so the webview bundle
 *  doesn't drag the engine's fs types). */
export interface HandoffNoteVM {
  ts: string;
  agent: string;
  kind: string;
  summary: string;
  evidence: string[];
}

export interface HandoffDistillTargetVM {
  name: string;
  description: string;
}

/** The single message payload the host posts to the webview. */
export interface HandoffViewModel {
  folder: string;
  exists: boolean;
  body: string;
  staleness: StalenessState;
  pendingCount: number;
  updatedAt: string; // ISO, "" when never written
  updatedBy: string; // human | agent | tachyon, "" when unknown
  revision: string; // short content hash, "" when none
  notes: HandoffNoteVM[]; // pending notes (newest of the lane), oldest→newest as stored
  distillTargets: HandoffDistillTargetVM[];
  distillRuntimes: HandoffDistillRuntimeVM[];
}

/** Staleness → {glyph, label, tone}. Glyph carries the meaning if a theme var is absent (accessibility:
 *  text + glyph, never color alone). `tone` maps to a CSS class the panel styles with `--vscode-*` accents. */
export function stalenessLabel(state: StalenessState): { glyph: string; label: string; tone: string } {
  switch (state) {
    case "needs_distill": return { glyph: "◆", label: "Needs distill", tone: "warn" };
    case "possibly_stale": return { glyph: "◷", label: "Possibly stale", tone: "info" };
    case "old": return { glyph: "✗", label: "Old", tone: "err" };
    case "fresh":
    default: return { glyph: "○", label: "Fresh", tone: "muted" };
  }
}

/** Note kind → glyph (✓ completed · ⊘ blocked · ◆ decision · ⚠ gotcha · → next). Unknown coerces to →. */
export function noteGlyph(kind: string): string {
  switch (kind) {
    case "completed": return "✓";
    case "blocked": return "⊘";
    case "decision": return "◆";
    case "gotcha": return "⚠";
    case "next":
    default: return "→";
  }
}

/** Relative time like "just now" / "5m ago" / "3h ago" / "2d ago" from an ISO timestamp. Empty / unparseable
 *  → "". PURE (now is injected so it's testable). */
export function relativeTime(iso: string, now: Date): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.round((now.getTime() - t) / 1000);
  if (sec < 0) return "just now"; // a clock-skewed future stamp reads as now, never "-3s ago"
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
