import * as vscode from "vscode";
import type { LayoutDef } from "../config/loadConfig.js";
import type { Terminals } from "./Terminals.js";
import { buildLayout, layoutsEqual, leafCount, normalizeLayout, type EditorLayout } from "./layoutLogic.js";

/**
 * Applies a layout: editor grid via `vscode.setEditorLayout` (proportional sizes
 * supported — see layoutLogic), then agents into the groups in leaf order.
 *
 * Robustness (F22): stopped agents are started first (no dead tabs over missing
 * sessions), a re-apply that matches the current grid skips setEditorLayout
 * (no flicker, idempotent), and the first agent gets focus at the end. Tabs are
 * never closed — files living in a rearranged group stay there as tabs.
 */
export async function applyLayout(
  layout: LayoutDef,
  terminals: Terminals,
  sessionOf: (agent: string) => string,
  opts?: {
    /** start a stopped agent before opening its pane (skip-on-error handled inside) */
    ensureRunning?: (agent: string) => Promise<void>;
  },
): Promise<void> {
  const target = buildLayout(layout);
  try {
    const current = (await vscode.commands.executeCommand("vscode.getEditorLayout")) as {
      orientation: number;
      groups: unknown[];
    };
    if (!layoutsEqual(normalizeLayout(current), target)) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", target);
    }
  } catch {
    // get/set unavailable — fall back to plain ViewColumn placement below.
  }

  const agents = layout.agents.slice(0, capacityOf(target));
  for (const agent of agents) {
    await opts?.ensureRunning?.(agent);
  }
  for (let i = 0; i < agents.length; i++) {
    // groups created by setEditorLayout number in leaf (visual) order.
    terminals.open(agents[i], sessionOf(agents[i]), (i + 1) as vscode.ViewColumn);
  }
  if (agents.length > 1) {
    // last open() stole focus — hand it to the first agent (the layout's "main").
    terminals.open(agents[0], sessionOf(agents[0]), vscode.ViewColumn.One);
  }
}

export function capacityOf(layout: EditorLayout): number {
  return leafCount(layout.groups);
}
