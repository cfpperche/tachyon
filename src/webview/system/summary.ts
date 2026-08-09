import type { ControlInspectorWorkspaceRow } from "../../control-inspector/model";

/**
 * SDD 500 D3 — the summary System shows, derived from the ROWS System draws.
 *
 * This is the structural point the whole spec is built on, and it is worth stating plainly because the
 * code it replaces looked correct: `model.ts` set `enginesAttached: control.summary.attachedEngines`,
 * and `control.summary` is itself computed from `control.workspaces` in the same function — so the
 * counter and the cards were two reads of one object, consistent by construction *today*. Nothing held
 * them together, though; they were consistent because one function happened to build both, and either
 * could move.
 *
 * On two separate screens that was invisible. On ONE screen a disagreement is a visible bug: the
 * number at the top would contradict the card underneath it, and a human would have no way to tell
 * which one lied. So the number is computed here, from the array the cards iterate, and there is no
 * state in which they can disagree — not because they are checked, but because there is one source.
 *
 * What is NOT here, and why: `inboxPending` and `worktreesActive` are workspace-wide counts with no
 * per-row source at all (`model.ts` builds them from approvals/validations and the classified worktree
 * rows). They are not derivable this way, which is exactly why they keep their own sources rather than
 * being forced through this function for symmetry.
 */
export interface SystemRowSummary {
  /** workspaces WITH A CARD ON SCREEN — never the window's count. See `SystemSummaryProps` in App.tsx. */
  workspaces: number;
  enginesAttached: number;
  enginesError: number;
  agentsRunning: number;
  agentsTotal: number;
}

export function summariseWorkspaceRows(rows: readonly ControlInspectorWorkspaceRow[]): SystemRowSummary {
  const summary: SystemRowSummary = {
    workspaces: rows.length,
    enginesAttached: 0,
    enginesError: 0,
    agentsRunning: 0,
    agentsTotal: 0,
  };
  for (const row of rows) {
    if (row.engine.state === "attached") summary.enginesAttached += 1;
    if (row.engine.state === "error") summary.enginesError += 1;
    // A row whose projection carried no agent counts contributes nothing rather than a zero it cannot
    // vouch for — the same fail-quiet rule `buildControlInspectorModel` already applies one layer down.
    summary.agentsRunning += row.agents?.running ?? 0;
    summary.agentsTotal += row.agents?.total ?? 0;
  }
  return summary;
}
