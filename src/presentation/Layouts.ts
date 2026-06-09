import * as vscode from "vscode";
import type { GridShape, LayoutDef } from "../config/loadConfig.js";
import type { Terminals } from "./Terminals.js";

/**
 * Editor-grid shapes via the `vscode.setEditorLayout` command (command-API, not the
 * typed API — see plan risk: on failure we fall back to plain ViewColumn placement).
 * orientation 0 = groups side-by-side (columns), 1 = stacked (rows).
 */
const GRID_LAYOUTS: Record<GridShape, { orientation: number; groups: object[] }> = {
  "2up": { orientation: 0, groups: [{}, {}] },
  "3up": { orientation: 0, groups: [{}, {}, {}] },
  "2x2": {
    orientation: 0,
    groups: [
      { groups: [{}, {}], size: 0.5 },
      { groups: [{}, {}], size: 0.5 },
    ],
  },
};

export const GRID_CAPACITY: Record<GridShape, number> = { "2up": 2, "3up": 3, "2x2": 4 };

export async function applyLayout(
  layout: LayoutDef,
  terminals: Terminals,
  sessionOf: (agent: string) => string,
): Promise<void> {
  try {
    await vscode.commands.executeCommand("vscode.setEditorLayout", GRID_LAYOUTS[layout.grid]);
  } catch {
    // Fall back to plain ViewColumn placement below — columns still land side by side.
  }
  const capacity = GRID_CAPACITY[layout.grid];
  const agents = layout.agents.slice(0, capacity);
  for (let i = 0; i < agents.length; i++) {
    // ViewColumn.One is 1; groups created by setEditorLayout number in creation order.
    terminals.open(agents[i], sessionOf(agents[i]), (i + 1) as vscode.ViewColumn);
  }
}
