import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { scanScheduleDeclarations } from "./scheduleDeclarations.js";
import { scanTerminalDeclarations } from "./terminalDeclarations.js";

/**
 * t-a65335 — tachyon.yml retires. What it used to carry, by kind:
 *
 *   settings:   the ONLY block that was actually configuration → `.tachyon/settings.yml`,
 *               whose top level IS the settings mapping (no `settings:` wrapper).
 *   schedules:  declarations → `.tachyon/schedules/<name>.yml` (scheduleDeclarations.ts).
 *   terminals:  declarations → `.tachyon/terminals/<name>.yml` (already canonical there).
 *   agents:     already gone (`.tachyon/agents/<name>/agent.yml`).
 *   layouts:    retired since spec 234; died with the file.
 *
 * t-987825 — the one-shot migration that projected a legacy `tachyon.yml` into these homes is gone
 * too. It existed for a single upgrade, every workspace that needed it took it, and a translation
 * layer nobody can reach is a second definition of the format waiting to disagree with the first.
 * A `tachyon.yml` at a workspace root is now simply a file the product does not read.
 *
 * The internal composition contract (parseConfig / loadProfileAwareConfig taking one document with
 * `settings:` + `schedules:`) is untouched: `composeWorkspaceConfigText` synthesizes that document
 * from the new homes, so every downstream consumer and its error vocabulary stay as they are.
 */

export const WORKSPACE_SETTINGS_FILE = ".tachyon/settings.yml";

export function workspaceSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, WORKSPACE_SETTINGS_FILE);
}

export interface ComposedWorkspaceConfig {
  /** One synthesized document (`settings:` + `schedules:`) for the existing parser pipeline. */
  yamlText: string;
  /** Malformed inputs dropped while composing (schedule files that refused to load, ...). */
  warnings: string[];
  errors: string[];
}

export interface ComposeOverrides {
  /** validate-before-write: use this text INSTEAD of the on-disk settings file. */
  settingsText?: string;
  /** validate-before-write: as if this schedule declaration were already on disk. */
  schedule?: { name: string; def: Record<string, unknown> };
}

/**
 * Read `.tachyon/settings.yml` + `.tachyon/schedules/*.yml` into ONE parser-ready document.
 * Overrides exist for the write gates: a candidate edit is composed AS IF saved, validated through
 * the ordinary parser, and only then written — the same refuse-before-persist discipline
 * mutateConfig always had (t-099be8).
 */
export function composeWorkspaceConfigText(workspaceRoot: string, overrides: ComposeOverrides = {}): ComposedWorkspaceConfig {
  const warnings: string[] = [];
  const errors: string[] = [];
  let settings: unknown;
  const settingsFile = workspaceSettingsPath(workspaceRoot);
  const settingsText = overrides.settingsText ?? (fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined);
  if (settingsText !== undefined) {
    const doc = parseDocument(settingsText, { uniqueKeys: true });
    if (doc.errors.length > 0) {
      errors.push(`${WORKSPACE_SETTINGS_FILE}: invalid YAML: ${doc.errors[0]!.message}`);
    } else {
      const value = doc.toJS() as unknown;
      if (value === null || value === undefined) settings = undefined;
      else if (typeof value !== "object" || Array.isArray(value)) errors.push(`${WORKSPACE_SETTINGS_FILE}: must be a mapping of setting -> value`);
      else settings = value;
    }
  }
  const schedules = scanScheduleDeclarations(workspaceRoot);
  warnings.push(...schedules.warnings);
  const declarations = { ...schedules.declarations };
  if (overrides.schedule) declarations[overrides.schedule.name] = overrides.schedule.def;
  // Terminals ride in the composed document too, so a syntax-only consumer (the editor-side Studio
  // read) sees the same workspace the engine does. The engine loader re-injects the same scan over
  // these keys — identical data, idempotent.
  const terminals = scanTerminalDeclarations(workspaceRoot);
  warnings.push(...terminals.warnings);
  const document: Record<string, unknown> = {};
  if (settings !== undefined) document.settings = settings;
  if (Object.keys(terminals.declarations).length > 0) document.terminals = terminals.declarations;
  if (Object.keys(declarations).length > 0) document.schedules = declarations;
  return { yamlText: stringify(document), warnings, errors };
}

