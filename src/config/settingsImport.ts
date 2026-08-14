/**
 * t-aaad95 — the ONE-TIME import of values people had already written under the retired
 * `tachyon.*` VS Code settings.
 *
 * Why this exists, and precisely which case it protects: the measured precedence before the cut was
 * `tachyon.yml settings.maxAgents` > the VS Code key > the built-in default. So for anyone who had
 * configured `tachyon.yml`, removing the keys changes nothing — the value they observe already came
 * from the file. The case that WOULD break is the opposite one: somebody who configured only the VS
 * Code key silently drops to the default the moment the key stops being read. That person is who
 * this module is for.
 *
 * It is an import, not a dual-read. It runs once per scope, records that it ran, and after that the
 * new authority is the only authority — there is no permanent fallback to VS Code settings anywhere.
 *
 * The planning here is pure so it can be tested without a shell; `extension.ts` supplies the values
 * (only the shell can see VS Code settings) and performs the writes.
 */

import fs from "node:fs";
import path from "node:path";
import type { GlobalSettings, GlobalSettingsField } from "@tachyon/engine/config/globalSettings.js";

/** Values as authored under the retired keys. `undefined` = the person never wrote that key. */
export interface LegacySettingValues {
  maxAgents?: unknown;
  agentMemoryMax?: unknown;
  gitPath?: unknown;
  activityCodeTheme?: unknown;
  agentPaneEnabled?: unknown;
  sidebarCardTemplate?: unknown;
  worktreesRevealInWorkspace?: unknown;
  taskNotifications?: {
    enabled?: unknown;
    events?: unknown;
    suppressOwnChanges?: unknown;
    dedupeWindowMs?: unknown;
  };
}

/**
 * What to write into the global Tachyon file.
 *
 * Only keys the person actually authored under the old surface, and only where the new authority has
 * not been AUTHORED yet — presence, not value. Comparing values would conflate "never mentioned" with
 * "deliberately set to the same thing the default happens to be", and would then overwrite a real
 * choice: someone who wrote `agentPane.enabled: true` in the new file would have a stale legacy
 * `false` written over it, silently, during an upgrade.
 *
 * `authored` is empty for a REFUSED document, which is why the caller must refuse to import at all in
 * that case rather than rely on this — see `importLegacyGlobalSettings`.
 */
export function planGlobalImport(
  legacy: LegacySettingValues,
  authored: readonly GlobalSettingsField[],
): Partial<GlobalSettings> {
  const patch: Partial<GlobalSettings> = {};
  const alreadyAuthored = new Set<GlobalSettingsField>(authored);

  const theme = legacy.activityCodeTheme;
  if ((theme === "auto" || theme === "dark" || theme === "light") && !alreadyAuthored.has("activityCodeTheme")) {
    patch.activityCodeTheme = theme;
  }
  if (typeof legacy.agentPaneEnabled === "boolean" && !alreadyAuthored.has("agentPaneEnabled")) {
    patch.agentPaneEnabled = legacy.agentPaneEnabled;
  }
  if (typeof legacy.gitPath === "string" && legacy.gitPath.trim() !== "" && !alreadyAuthored.has("gitPath")) {
    patch.gitPath = legacy.gitPath;
  }
  // The card template is carried across in its AUTHORED form — the same reason `GlobalSettings`
  // stores it that way: a resolved template would pin regions the person never mentioned.
  const template = legacy.sidebarCardTemplate;
  const templateCleared = template === undefined || template === null
    || (typeof template === "object" && !Array.isArray(template) && Object.keys(template as object).length === 0);
  if (!templateCleared && !alreadyAuthored.has("sidebarCardTemplate")) {
    patch.sidebarCardTemplate = template;
  }
  return patch;
}

/** A `tachyon.yml` edit the import wants to make: a `settings.` path and the value to set. */
export interface YmlSettingWrite {
  /** path under `settings`, e.g. `["worktree", "revealInWorkspace"]` */
  keyPath: string[];
  value: string | number | boolean | string[];
}

/**
 * What to write into a workspace's `tachyon.yml`.
 *
 * `alreadySet` is asked per key rather than assumed, because these values are shared with the team
 * through a tracked file: importing over a value the project already declared would let one person's
 * local VS Code setting silently rewrite a project decision.
 */
export function planYmlImport(
  legacy: LegacySettingValues,
  alreadySet: (keyPath: string[]) => boolean,
): YmlSettingWrite[] {
  const writes: YmlSettingWrite[] = [];
  const push = (keyPath: string[], value: YmlSettingWrite["value"] | undefined): void => {
    if (value === undefined || alreadySet(keyPath)) return;
    writes.push({ keyPath, value });
  };

  push(["maxAgents"], Number.isInteger(legacy.maxAgents) && (legacy.maxAgents as number) >= 1 ? legacy.maxAgents as number : undefined);
  push(["agentMemoryMax"], typeof legacy.agentMemoryMax === "string" && legacy.agentMemoryMax.trim() !== "" ? legacy.agentMemoryMax.trim() : undefined);
  push(["worktree", "revealInWorkspace"], typeof legacy.worktreesRevealInWorkspace === "boolean" ? legacy.worktreesRevealInWorkspace : undefined);

  const tn = legacy.taskNotifications ?? {};
  push(["taskNotifications", "enabled"], typeof tn.enabled === "boolean" ? tn.enabled : undefined);
  push(["taskNotifications", "suppressOwnChanges"], typeof tn.suppressOwnChanges === "boolean" ? tn.suppressOwnChanges : undefined);
  push(["taskNotifications", "dedupeWindowMs"], Number.isInteger(tn.dedupeWindowMs) && (tn.dedupeWindowMs as number) >= 0 ? tn.dedupeWindowMs as number : undefined);
  push(
    ["taskNotifications", "events"],
    Array.isArray(tn.events) && tn.events.every((e) => typeof e === "string") ? tn.events as string[] : undefined,
  );

  return writes;
}

export const SETTINGS_IMPORT_MARKER_FILENAME = "vscode-settings-import.json";
export const SETTINGS_IMPORT_SCHEMA_VERSION = 1 as const;

export interface SettingsImportMarker {
  schemaVersion: typeof SETTINGS_IMPORT_SCHEMA_VERSION;
  importedAt: string;
  /** the `settings.` paths written, for the human who later asks why their yml changed */
  wrote: string[];
}

/**
 * Machine-local, beside the existing LKG snapshot under `.tachyon/`. Not the global file: the yml
 * import is per-workspace, so "did this already run" has to be answered per-workspace too.
 */
export function settingsImportMarkerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", SETTINGS_IMPORT_MARKER_FILENAME);
}

export function settingsImportAlreadyRan(markerPath: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<SettingsImportMarker>;
    return marker.schemaVersion === SETTINGS_IMPORT_SCHEMA_VERSION;
  } catch {
    // Unreadable or absent both mean "not proven to have run". Re-running is safe: every write is
    // guarded by `alreadySet`, so a second pass writes nothing.
    return false;
  }
}

export function recordSettingsImport(markerPath: string, wrote: string[], now = new Date()): void {
  const marker: SettingsImportMarker = {
    schemaVersion: SETTINGS_IMPORT_SCHEMA_VERSION,
    importedAt: now.toISOString(),
    wrote,
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, markerPath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}
