/**
 * t-aaad95 — the GLOBAL Tachyon settings file: one authority for the per-person, per-machine
 * settings that used to be `contributes.configuration` keys in VS Code.
 *
 * Why a file and not VS Code settings (ratified in `docs/proposals/tachyon-settings-single-authority.md`):
 * these values must answer with **zero workspaces open** and must be readable by CLI/headless and by
 * the persistent engine, neither of which may depend on `vscode`. A plain file at a fixed, documented
 * path answers both, and it is the recovery surface when Control itself cannot open — the accepted
 * cost is the loss of Settings Sync for the card template (§5 of the proposal).
 *
 * Discipline, matching what `tachyon.yml` and the profile stores already do:
 * - **versioned schema** — `version: 1`; an unknown version is a refusal, never a silent reinterpretation;
 * - **fail-closed** — any invalid value refuses the WHOLE document with named errors; nothing is
 *   silently defaulted, because a silently-defaulted value is indistinguishable from a value that works;
 * - **last-known-good** — a refused document keeps serving the last document that parsed, so a typo
 *   degrades presentation rather than resetting a person's machine;
 * - **transactional write** — temp + rename, so a crashed write can never leave a half-document.
 *
 * The one rule that is NOT a preference (proposal §5/§7, and it survived ratification):
 * **`agentPane.enabled` fails toward ENABLED.** Recovery now depends on Tachyon's own surface, so a
 * bad value must never be able to hide the surface that would repair it. That is why `resolve()`
 * forces it true on refusal instead of inheriting the last-known-good — see `resolveGlobalSettings`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCardTemplate } from "../sidebar/cardTemplate.js";

export const GLOBAL_SETTINGS_SCHEMA_VERSION = 1 as const;
export const GLOBAL_SETTINGS_DIRNAME = ".tachyon";
export const GLOBAL_SETTINGS_FILENAME = "settings.json";

/** The documented, hand-editable path. Kept per-machine on purpose (`gitPath` is machine wiring). */
export function globalSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, GLOBAL_SETTINGS_DIRNAME, GLOBAL_SETTINGS_FILENAME);
}

export type ActivityCodeTheme = "auto" | "dark" | "light";

/** Every field resolved — callers never re-apply a default and so cannot disagree about one. */
export interface GlobalSettings {
  /** Syntax-highlight palette for Activity code blocks. `auto` follows the editor. */
  activityCodeTheme: ActivityCodeTheme;
  /** Layer-2 agent pane. Fails toward `true`; see the file header. */
  agentPaneEnabled: boolean;
  /**
   * This person's card layout, kept as the AUTHORED document rather than a parsed template.
   *
   * That is not laziness: `parseCardTemplate` resolves a silent region against whatever base it is
   * given, and the sidebar gives it THIS FOLDER's project template. Storing the resolved form would
   * pin every region against the default and silently end "a region you do not list keeps whatever
   * that project chose" — the exact inheritance SDD 479 phase 5 ratified. Absent = the project's wins
   * alone. Validated at load against the default base, so a broken document is still refused early.
   */
  sidebarCardTemplate?: unknown;
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
  sidebar?: { cardTemplate?: unknown };
  gitPath?: string;
}

export interface GlobalSettingsParse {
  /** Present only when the WHOLE document is valid. */
  settings?: GlobalSettings;
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

  const known = new Set(["version", "activity", "agentPane", "sidebar", "gitPath"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`${source}: unknown key '${key}' (expected ${[...known].join(", ")})`);
  }

  const settings: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };

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
        else settings.agentPaneEnabled = enabled;
      }
    }
  }

  if (raw.sidebar !== undefined) {
    if (!isPlainObject(raw.sidebar)) {
      errors.push(`${source}: 'sidebar' must be a mapping`);
    } else {
      for (const key of Object.keys(raw.sidebar)) {
        if (key !== "cardTemplate") errors.push(`${source}: sidebar: unknown key '${key}' (expected cardTemplate)`);
      }
      const written = raw.sidebar.cardTemplate;
      // `null` and `{}` are what a person leaves behind after clearing the key — neither is an
      // attempt to configure anything, so neither is a refusal. Same rule the VS Code key had.
      const cleared = written === undefined || written === null
        || (isPlainObject(written) && Object.keys(written).length === 0);
      if (!cleared) {
        // The SAME validator `tachyon.yml` uses. A second one that could disagree with it is the
        // failure SDD 479 phase 5 already exists to avoid.
        const parsed = parseCardTemplate(written, `${source}: sidebar.cardTemplate`);
        if (!parsed.config) errors.push(...parsed.errors);
        else settings.sidebarCardTemplate = written; // authored form; see the field's comment
      }
    }
  }

  if (raw.gitPath !== undefined) {
    if (typeof raw.gitPath !== "string") errors.push(`${source}: gitPath: must be a string`);
    else settings.gitPath = raw.gitPath;
  }

  return errors.length > 0 ? { errors } : { settings, errors: [] };
}

/** Serialize resolved settings back to the authored shape (what `write` puts on disk). */
export function toGlobalSettingsDocument(settings: GlobalSettings): GlobalSettingsDocument {
  return {
    version: GLOBAL_SETTINGS_SCHEMA_VERSION,
    activity: { codeTheme: settings.activityCodeTheme },
    agentPane: { enabled: settings.agentPaneEnabled },
    ...(settings.sidebarCardTemplate === undefined ? {} : { sidebar: { cardTemplate: settings.sidebarCardTemplate } }),
    gitPath: settings.gitPath,
  };
}

export interface GlobalSettingsState {
  /** What every reader must use. Never partially applied. */
  settings: GlobalSettings;
  /** Named errors when the document on disk was refused; absent when it parsed (or does not exist). */
  refusal?: { file: string; errors: string[] };
}

/**
 * Layer a refusal over the last-known-good.
 *
 * `agentPaneEnabled` deliberately does NOT inherit: a refused document must never be able to leave
 * the pane disabled, because with VS Code settings gone the pane is part of the repair surface.
 */
export function resolveGlobalSettings(lastKnownGood: GlobalSettings | undefined, refusal: { file: string; errors: string[] } | undefined): GlobalSettingsState {
  const base = lastKnownGood ?? DEFAULT_GLOBAL_SETTINGS;
  if (!refusal) return { settings: base };
  return { settings: { ...base, agentPaneEnabled: true }, refusal };
}

/**
 * The process-wide reader/writer for the global file.
 *
 * Deliberately synchronous: every consumer (webview render, sidebar push, git spawn) is on a
 * synchronous path today, and an async read would have forced a cache with a staleness question
 * nobody asked for. The document is tiny and read at most once per change.
 */
export class GlobalSettingsStore {
  private lastKnownGood: GlobalSettings | undefined;
  private state: GlobalSettingsState = { settings: DEFAULT_GLOBAL_SETTINGS };
  /** mtime+size of the document `state` was built from; `null` records "the file was absent". */
  private stamp: string | null = null;
  readonly file: string;

  constructor(homeDir: string = os.homedir()) {
    this.file = globalSettingsPath(homeDir);
    this.reload();
  }

  /**
   * Cheap staleness check so a hand edit takes effect without a watcher on every consumer.
   *
   * A `stat` per read is far less machinery than N watchers, and it removes the whole class of
   * "Control says one thing, the sidebar shows another" bugs that a cache without invalidation
   * invites. Callers are all on synchronous render/spawn paths where a stat is free.
   */
  private stampNow(): string | null {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /** Re-read from disk. Safe to call on a watch event; a refusal keeps the last good document. */
  reload(): GlobalSettingsState {
    this.stamp = this.stampNow();
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Absent is not broken: a person who never configured anything gets the defaults, and
        // `agentPane.enabled` absent therefore also means enabled.
        this.lastKnownGood = undefined;
        this.state = { settings: DEFAULT_GLOBAL_SETTINGS };
        return this.state;
      }
      this.state = resolveGlobalSettings(this.lastKnownGood, {
        file: this.file,
        errors: [`${this.file}: could not be read (${error instanceof Error ? error.message : String(error)})`],
      });
      return this.state;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.state = resolveGlobalSettings(this.lastKnownGood, {
        file: this.file,
        errors: [`${this.file}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`],
      });
      return this.state;
    }

    const parsed = parseGlobalSettings(raw, this.file);
    if (!parsed.settings) {
      this.state = resolveGlobalSettings(this.lastKnownGood, { file: this.file, errors: parsed.errors });
      return this.state;
    }
    this.lastKnownGood = parsed.settings;
    this.state = { settings: parsed.settings };
    return this.state;
  }

  /** The state to read, re-parsing first if the document changed underneath us. */
  read(): GlobalSettingsState {
    if (this.stampNow() !== this.stamp) return this.reload();
    return this.state;
  }

  current(): GlobalSettings { return this.read().settings; }
  refusal(): { file: string; errors: string[] } | undefined { return this.read().refusal; }

  /**
   * Apply a partial edit and persist it. Validates the RESULT through the same parser a hand edit
   * goes through, so Control can never write a document that the loader would then refuse.
   */
  update(patch: Partial<GlobalSettings>): GlobalSettingsState {
    const next: GlobalSettings = { ...this.current(), ...patch };
    const document = toGlobalSettingsDocument(next);
    const check = parseGlobalSettings(document, this.file);
    if (!check.settings) throw new Error(`refusing to write invalid Tachyon settings: ${check.errors.join("; ")}`);
    writeGlobalSettingsFile(this.file, document);
    this.lastKnownGood = check.settings;
    this.state = { settings: check.settings };
    this.stamp = this.stampNow();
    return this.state;
  }
}

/**
 * The process-wide store. One per process, because the file is one per machine and a second cache of
 * it is a second answer to the same question.
 */
let shared: GlobalSettingsStore | undefined;

export function sharedGlobalSettings(): GlobalSettingsStore {
  return (shared ??= new GlobalSettingsStore());
}

/** Point the process-wide store at another home. Tests use this; production never calls it. */
export function useGlobalSettingsHome(homeDir: string | undefined): GlobalSettingsStore | undefined {
  shared = homeDir === undefined ? undefined : new GlobalSettingsStore(homeDir);
  return shared;
}

/** temp + rename, so an interrupted write can never leave a half-document at the real path. */
export function writeGlobalSettingsFile(file: string, document: GlobalSettingsDocument): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}
