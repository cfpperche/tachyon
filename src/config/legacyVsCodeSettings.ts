import * as vscode from "vscode";
import type { LegacySettingValues } from "./settingsImport.js";

/**
 * t-aaad95 — the ONLY place left that reads a `tachyon.*` VS Code configuration section, and it exists
 * to read them for the last time.
 *
 * It lives in a file of its own so the inventory guard can allow exactly one site by NAME rather than
 * by a pattern that would also wave through a reader somebody adds later. When every install has run
 * the one-time import, this file and `settingsImport.ts` go together — until then it is migration
 * surface, not a fallback: nothing consults it after the marker is written.
 *
 * `inspect()` still reports what a person wrote even for keys nothing contributes any more, which is
 * what makes the clean removal survivable. Only explicitly written scopes are read; a contributed
 * default was never a choice anybody made.
 */
export function readLegacyVsCodeSettings(resource?: vscode.Uri): LegacySettingValues {
  const tachyon = vscode.workspace.getConfiguration("tachyon", resource);
  const written = (key: string): unknown => {
    const inspected = tachyon.inspect<unknown>(key);
    return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  };
  return {
    maxAgents: written("maxAgents"),
    agentMemoryMax: written("agentMemoryMax"),
    gitPath: written("gitPath"),
    activityCodeTheme: written("activity.codeTheme"),
    agentPaneEnabled: written("agentPane.enabled"),
    sidebarCardTemplate: written("sidebar.cardTemplate"),
    worktreesRevealInWorkspace: written("worktrees.revealInWorkspace"),
    taskNotifications: {
      enabled: written("taskNotifications.enabled"),
      events: written("taskNotifications.events"),
      suppressOwnChanges: written("taskNotifications.suppressOwnChanges"),
      dedupeWindowMs: written("taskNotifications.dedupeWindowMs"),
    },
  };
}
