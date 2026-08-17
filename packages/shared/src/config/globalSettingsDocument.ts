/**
 * t-aaad95 — the global Tachyon settings DOCUMENT: its schema, its validation and its defaults.
 *
 * Split from the file-backed store (`globalSettings.ts`) so the document stays pure: no `node:fs`
 * / `node:os` / `node:path`. The schema has exactly one definition that every side — shell, engine,
 * webview, CLI — can share.
 *
 * Why a file and not VS Code settings (ratified in `docs/proposals/tachyon-settings-single-authority.md`):
 * these values must answer with **zero workspaces open** and must be readable by CLI/headless and by
 * the persistent engine, neither of which may depend on `vscode`.
 *
 * Discipline, matching what `tachyon.yml` and the profile stores already do:
 * - **versioned schema** — `version: 1`; an unknown version is a refusal, never a silent reinterpretation;
 * - **fail-closed** — any invalid value refuses the WHOLE document with named errors; nothing is
 *   silently defaulted, because a silently-defaulted value is indistinguishable from a value that works.
 *
 * The one rule that is NOT a preference (proposal §5/§7, and it survived ratification):
 * **`agentPane.enabled` fails toward ENABLED.** Recovery now depends on Tachyon's own surface, so a
 * bad value must never be able to hide the surface that would repair it — see `resolveGlobalSettings`.
 */

export const GLOBAL_SETTINGS_SCHEMA_VERSION = 1 as const;
export const GLOBAL_SETTINGS_DIRNAME = ".tachyon";
export const GLOBAL_SETTINGS_FILENAME = "settings.json";

export type ActivityCodeTheme = "auto" | "dark" | "light";

/** Every field resolved — callers never re-apply a default and so cannot disagree about one. */
export interface GlobalSettings {
  /** Syntax-highlight palette for Activity code blocks. `auto` follows the editor. */
  activityCodeTheme: ActivityCodeTheme;
  /** Layer-2 agent pane. Fails toward `true`; see the file header. */
  agentPaneEnabled: boolean;
  /** Path to the git binary Tachyon spawns. Empty = fall back to `git.path`, then probing, then PATH. */
  gitPath: string;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  activityCodeTheme: "auto",
  agentPaneEnabled: true,
  gitPath: "",
};

/** The document as authored on disk. Only these keys exist; anything else is a refusal. */
export interface GlobalSettingsDocument {
  version: typeof GLOBAL_SETTINGS_SCHEMA_VERSION;
  activity?: { codeTheme?: ActivityCodeTheme };
  agentPane?: { enabled?: boolean };
  gitPath?: string;
}

/** The fields a document can author. Used to tell "unset" apart from "explicitly at the default". */
export type GlobalSettingsField = keyof GlobalSettings;

export interface GlobalSettingsParse {
  /** Present only when the WHOLE document is valid. */
  settings?: GlobalSettings;
  /**
   * Which fields the document actually WROTE, as opposed to which ones resolved to a value.
   *
   * Every field resolves to something — that is the point of `GlobalSettings`. But "the person never
   * mentioned `agentPane.enabled`" and "the person deliberately wrote `true`" are different facts,
   * and the one-time import has to tell them apart: without this it would overwrite a deliberate
   * choice with a legacy value merely because the choice happened to equal the default.
   */
  authored?: GlobalSettingsField[];
  /** Named, human-actionable refusals. Non-empty means `settings` is absent. */
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate one authored document. Fail-closed and WHOLE: the first invalid key does not fall back to
 * a default for that key, because a document that is half-honored is the two-sources-of-truth failure
 * this whole change exists to remove.
 */
export function parseGlobalSettings(raw: unknown, source: string): GlobalSettingsParse {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { errors: [`${source}: must be a JSON object`] };
  }

  if (raw.version !== GLOBAL_SETTINGS_SCHEMA_VERSION) {
    // Named rather than tolerated: a newer Tachyon may have written a shape this build would
    // misread, and misreading a person's machine wiring is worse than refusing to.
    return {
      errors: [`${source}: 'version' must be ${GLOBAL_SETTINGS_SCHEMA_VERSION} (found ${JSON.stringify(raw.version)}); this Tachyon does not understand that document`],
    };
  }

  const known = new Set(["version", "activity", "agentPane", "gitPath"]);
  // `sidebar` was the card-template override (SDD 479). The spec was abandoned; the key is ignored
  // so an old file does not refuse the whole document.
  for (const key of Object.keys(raw)) {
    if (key === "sidebar") continue;
    if (!known.has(key)) errors.push(`${source}: unknown key '${key}' (expected ${[...known].join(", ")})`);
  }

  const settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
  const authored = new Set<GlobalSettingsField>();

  if (raw.activity !== undefined) {
    if (!isPlainObject(raw.activity)) {
      errors.push(`${source}: 'activity' must be a mapping`);
    } else {
      for (const key of Object.keys(raw.activity)) {
        if (key !== "codeTheme") errors.push(`${source}: activity: unknown key '${key}' (expected codeTheme)`);
      }
      const theme = raw.activity.codeTheme;
      if (theme !== undefined) {
        if (theme !== "auto" && theme !== "dark" && theme !== "light") {
          errors.push(`${source}: activity.codeTheme: must be "auto", "dark", or "light"`);
        } else {
          settings.activityCodeTheme = theme;
          authored.add("activityCodeTheme");
        }
      }
    }
  }

  if (raw.agentPane !== undefined) {
    if (!isPlainObject(raw.agentPane)) {
      errors.push(`${source}: 'agentPane' must be a mapping`);
    } else {
      for (const key of Object.keys(raw.agentPane)) {
        if (key !== "enabled") errors.push(`${source}: agentPane: unknown key '${key}' (expected enabled)`);
      }
      const enabled = raw.agentPane.enabled;
      if (enabled !== undefined) {
        if (typeof enabled !== "boolean") errors.push(`${source}: agentPane.enabled: must be a boolean`);
        else {
          settings.agentPaneEnabled = enabled;
          authored.add("agentPaneEnabled");
        }
      }
    }
  }

  if (raw.gitPath !== undefined) {
    if (typeof raw.gitPath !== "string") errors.push(`${source}: gitPath: must be a string`);
    else {
      settings.gitPath = raw.gitPath;
      authored.add("gitPath");
    }
  }

  return errors.length > 0 ? { errors } : { settings, authored: [...authored], errors: [] };
}

/** Serialize resolved settings back to the authored shape (what `write` puts on disk). */
export function toGlobalSettingsDocument(settings: GlobalSettings): GlobalSettingsDocument {
  return {
    version: GLOBAL_SETTINGS_SCHEMA_VERSION,
    activity: { codeTheme: settings.activityCodeTheme },
    agentPane: { enabled: settings.agentPaneEnabled },
    gitPath: settings.gitPath,
  };
}

export interface GlobalSettingsState {
  /** What every reader must use. Never partially applied. */
  settings: GlobalSettings;
  /** Fields the document on disk actually wrote. Empty when it was refused or absent. */
  authored: GlobalSettingsField[];
  /** Named errors when the document on disk was refused; absent when it parsed (or does not exist). */
  refusal?: { file: string; errors: string[] };
}

/**
 * Layer a refusal over the last-known-good.
 *
 * `agentPaneEnabled` deliberately does NOT inherit: a refused document must never be able to leave
 * the pane disabled, because with VS Code settings gone the pane is part of the repair surface.
 */
export function resolveGlobalSettings(
  lastKnownGood: GlobalSettings | undefined,
  refusal: { file: string; errors: string[] } | undefined,
  authored: GlobalSettingsField[] = [],
): GlobalSettingsState {
  const base = lastKnownGood ?? DEFAULT_GLOBAL_SETTINGS;
  if (!refusal) return { settings: base, authored };
  // A refused document authored nothing this build can vouch for: `authored` is empty, so the
  // one-time import cannot mistake a last-known-good value for a choice the current file makes.
  return { settings: { ...base, agentPaneEnabled: true }, authored: [], refusal };
}
