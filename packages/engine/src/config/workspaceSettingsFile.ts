import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import { scanScheduleDeclarations, upsertScheduleDeclaration } from "./scheduleDeclarations.js";
import { scanTerminalDeclarations } from "./terminalDeclarations.js";
import { upsertTerminalDeclaration } from "./terminalDeclarations.js";

/**
 * t-a65335 — tachyon.yml retires. What it used to carry, by kind:
 *
 *   settings:   the ONLY block that was actually configuration → `.tachyon/settings.yml`,
 *               whose top level IS the settings mapping (no `settings:` wrapper).
 *   schedules:  declarations → `.tachyon/schedules/<name>.yml` (scheduleDeclarations.ts).
 *   terminals:  declarations → `.tachyon/terminals/<name>.yml` (already canonical there).
 *   agents:     already gone (`.tachyon/agents/<name>/agent.yml`).
 *   layouts:    retired since spec 234; dies with the file.
 *
 * The internal composition contract (parseConfig / loadProfileAwareConfig taking one document with
 * `settings:` + `schedules:`) is untouched: `composeWorkspaceConfigText` synthesizes that document
 * from the new homes, so every downstream consumer and its error vocabulary stay as they are.
 */

export const WORKSPACE_SETTINGS_FILE = ".tachyon/settings.yml";
/** Retired workspace-root config files: read only by the migration, never by the loader. */
export const LEGACY_CONFIG_FILENAMES = ["tachyon.yml", "tachyon.yaml"] as const;

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

export interface LegacyConfigMigration {
  migrated: boolean;
  /** what moved where, one line each — for the single load-time notice. */
  actions: string[];
  warnings: string[];
}

/**
 * One-shot, idempotent projection of a legacy workspace-root tachyon.yml into the new homes. Every
 * block lands only where nothing exists yet — a new-home file always wins over the legacy block,
 * matching the terminals precedent. The original text is preserved byte-exact inside `.tachyon/`
 * before the root file is removed, because this file was gitignored: the copy Tachyon keeps is the
 * only one anywhere.
 */
export function migrateLegacyWorkspaceConfig(workspaceRoot: string): LegacyConfigMigration {
  const legacyPath = LEGACY_CONFIG_FILENAMES
    .map((name) => path.join(workspaceRoot, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!legacyPath) return { migrated: false, actions: [], warnings: [] };

  const actions: string[] = [];
  const warnings: string[] = [];
  const text = fs.readFileSync(legacyPath, "utf8");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    // An unreadable legacy file cannot be projected; leave it in place and say so, loudly, once.
    return {
      migrated: false,
      actions: [],
      warnings: [`${path.basename(legacyPath)} is not parseable (${doc.errors[0]!.message}); fix or remove it — the loader no longer reads it`],
    };
  }
  const raw = (doc.toJS() ?? {}) as Record<string, unknown>;

  const settingsTarget = workspaceSettingsPath(workspaceRoot);
  const settings = raw.settings;
  const hasSettingsBlock = !!settings && typeof settings === "object" && !Array.isArray(settings) && Object.keys(settings).length > 0;
  if (fs.existsSync(settingsTarget)) {
    if (hasSettingsBlock) warnings.push(`settings: block kept out of ${WORKSPACE_SETTINGS_FILE} — the file already exists and wins`);
  } else {
    // ALWAYS materialize the settings file, even when the legacy document carried no settings:
    // block — its PRESENCE is what marked the workspace as configured, and settings.yml is that
    // marker now. A legacy workspace holding only terminals must not migrate into an unconfigured
    // one (caught by vsix-smoke on 0.93.30: engine up, roster empty).
    fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
    fs.writeFileSync(
      settingsTarget,
      hasSettingsBlock ? stringify(settings) : "# Tachyon workspace settings — migrated from tachyon.yml, which carried no settings block.\n",
      "utf8",
    );
    actions.push(`settings → ${WORKSPACE_SETTINGS_FILE}`);
  }

  for (const [blockName, upsert] of [
    ["schedules", (name: string, def: Record<string, unknown>) => {
      upsertScheduleDeclaration(workspaceRoot, name, def);
      return `.tachyon/schedules/${name}.yml`;
    }],
    ["terminals", (name: string, def: Record<string, unknown>) => {
      upsertTerminalDeclaration(workspaceRoot, name, { ...def, kind: "terminal" });
      return `.tachyon/terminals/${name}.yml`;
    }],
  ] as const) {
    const block = raw[blockName];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [name, def] of Object.entries(block as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        warnings.push(`${blockName}.${name}: not a mapping — dropped by the migration`);
        continue;
      }
      try {
        actions.push(`${blockName}.${name} → ${upsert(name, def as Record<string, unknown>)}`);
      } catch (error) {
        warnings.push(`${blockName}.${name}: ${error instanceof Error ? error.message : String(error)} — left to the existing declaration`);
      }
    }
  }

  // Byte-exact copy inside .tachyon, then the root file goes. The stateBackup replica and this
  // copy are the only records of a file git never tracked.
  const preserved = path.join(workspaceRoot, ".tachyon", `${path.basename(legacyPath)}.pre-migration`);
  fs.mkdirSync(path.dirname(preserved), { recursive: true });
  fs.writeFileSync(preserved, text, "utf8");
  fs.unlinkSync(legacyPath);
  actions.push(`${path.basename(legacyPath)} removed (original preserved at .tachyon/${path.basename(preserved)})`);

  return { migrated: true, actions, warnings };
}
