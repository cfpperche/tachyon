/**
 * SDD 479 phase 4 — the rows a card preview renders.
 *
 * The spec names the states the preview has to show: *healthy, attention, error, long names, no model,
 * narrow width*. Width is the preview's own concern; the other five are these rows.
 *
 * They live in `src/` rather than beside the dev harness's fixtures (`scripts/webview-preview/`) or the
 * equality matrix (`test/`) because the shipped Settings block needs them at runtime and can import
 * neither. What they must NOT be is a second opinion about what a card looks like: they are `AgentVM`
 * values, rendered by the same `AgentRow` the sidebar renders, so the preview cannot drift from the
 * card — only from the fleet, which is the point (a preview that depended on a live agent would be a
 * second failure mode for no gain).
 */
import type { AgentVM } from "./types.js";

export interface CardPreviewRow {
  /** stable id for keys and for a test to name the row that changed */
  id: string;
  /** what this row is here to show, in the words the settings surface uses */
  label: string;
  row: AgentVM;
}

export const CARD_PREVIEW_ROWS: readonly CardPreviewRow[] = [
  {
    id: "healthy",
    label: "Running normally",
    row: {
      name: "orchestrator",
      kind: "agent",
      runtime: "claude",
      model: "Opus 5",
      modelSource: "observed",
      status: "running",
      liveBranch: "main",
      worktreePath: "/ws",
      resources: { cpuPct: 12, memMb: 420 },
      focus: { text: "landing the card template", source: "task", taskId: "t-e494e1", full: "landing the card template" },
      continuity: "fresh",
    },
  },
  {
    id: "attention",
    label: "Wants a human",
    row: {
      name: "reviewer",
      kind: "agent",
      runtime: "codex",
      model: "GPT-5.1 Codex",
      modelSource: "declared",
      status: "needs",
      attention: "needs input",
      awaitingHuman: { reason: "approve the migration" },
      liveBranch: "tachyon/change/reviewer",
      worktree: "tachyon/change/reviewer",
      worktreePath: "/cache/reviewer",
      verify: "stale",
      harness: true,
      continuity: "stale",
    },
  },
  {
    id: "error",
    label: "Stopped and cannot recover",
    row: {
      name: "migration",
      kind: "agent",
      runtime: "claude",
      model: "Sonnet 5",
      modelSource: "profile",
      status: "idle",
      // The two states a template may never hide, so the preview shows re-admission actually happening.
      authRequired: { runtime: "claude", action: "run `claude login`" },
      verify: "fail",
      configInvalid: true,
      liveBranch: "main",
      evidence: { total: 4, stale: 1, warn: 1, error: 2 },
    },
  },
  {
    id: "no-model",
    label: "No model observed yet",
    row: {
      name: "docs-writer",
      kind: "agent",
      runtime: "opencode",
      status: "idle",
      liveBranch: "main",
      resumable: true,
    },
  },
  {
    id: "long",
    label: "Long name, long branch, long focus",
    row: {
      name: "a-very-long-agent-name-that-will-not-fit-the-narrow-sidebar",
      kind: "agent",
      runtime: "claude",
      model: "claude-opus-5-with-an-implausibly-long-label",
      modelSource: "declared",
      status: "running",
      sub: "a sub line long enough to wrap at the sidebar's minimum practical width",
      liveBranch: "tachyon/change/a-branch-name-that-is-also-far-too-long-to-fit",
      worktree: "tachyon/change/a-branch-name-that-is-also-far-too-long-to-fit",
      worktreePath: "/cache/long",
      focus: {
        text: "an unusually long focus line that has to truncate somewhere sensible",
        source: "continuity",
        full: "an unusually long focus line that has to truncate somewhere sensible",
      },
      resources: { cpuPct: 96, memMb: 3072 },
    },
  },
];

/**
 * The widths the preview renders at. The sidebar's real default and its narrowest practical width —
 * the spec's "narrow sidebar" criterion is about what a template can do to a card at that width, so
 * the preview has to show it rather than describe it.
 */
export const CARD_PREVIEW_WIDTHS: readonly { id: string; label: string; px: number }[] = [
  { id: "default", label: "Sidebar width", px: 320 },
  { id: "narrow", label: "Narrow", px: 220 },
];
