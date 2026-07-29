/**
 * t-aaad95 — the file-backed store for the global Tachyon settings document.
 *
 * The document's schema, validation and defaults live in `globalSettingsDocument.ts`, which is pure so
 * the webview can share it. THIS file is everything that touches a filesystem: where the document
 * lives, reading it with last-known-good on refusal, and writing it transactionally.
 *
 * Discipline the store owns:
 * - **last-known-good** — a refused document keeps serving the last one that parsed, so a typo degrades
 *   presentation rather than resetting a person's machine;
 * - **transactional write** — temp + rename, so a crashed write can never leave a half-document;
 * - **never overwrite what it could not read** — see `update`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_GLOBAL_SETTINGS,
  parseGlobalSettings,
  resolveGlobalSettings,
  toGlobalSettingsDocument,
  type GlobalSettings,
  type GlobalSettingsDocument,
  type GlobalSettingsField,
  type GlobalSettingsState,
} from "./globalSettingsDocument.js";

export * from "./globalSettingsDocument.js";

export const GLOBAL_SETTINGS_DIRNAME = ".tachyon";
export const GLOBAL_SETTINGS_FILENAME = "settings.json";

/** The documented, hand-editable path. Kept per-machine on purpose (`gitPath` is machine wiring). */
export function globalSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, GLOBAL_SETTINGS_DIRNAME, GLOBAL_SETTINGS_FILENAME);
}

/**
 * Redirect the file to a disposable home, the way `TACHYON_DEV_HOST_PROFILE_HOME` already redirects a
 * runtime home.
 *
 * This is isolation, not a preference: without it a dev-host session and the test suite both read the
 * REAL `~/.tachyon/settings.json`, so a person who has set a card template on their own machine gets
 * different test results from CI — a flake whose cause is invisible from the failure.
 */
export const GLOBAL_SETTINGS_HOME_ENV_VAR = "TACHYON_GLOBAL_SETTINGS_HOME";

function defaultHomeDir(): string {
  const override = process.env[GLOBAL_SETTINGS_HOME_ENV_VAR];
  return override && override.trim().length > 0 ? override : os.homedir();
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
  private state: GlobalSettingsState = { settings: DEFAULT_GLOBAL_SETTINGS, authored: [] };
  /** mtime+size of the document `state` was built from; `null` records "the file was absent". */
  private stamp: string | null = null;
  readonly file: string;

  constructor(homeDir: string = defaultHomeDir()) {
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
        this.state = { settings: DEFAULT_GLOBAL_SETTINGS, authored: [] };
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
    this.state = { settings: parsed.settings, authored: parsed.authored ?? [] };
    return this.state;
  }

  /** The state to read, re-parsing first if the document changed underneath us. */
  read(): GlobalSettingsState {
    if (this.stampNow() !== this.stamp) return this.reload();
    return this.state;
  }

  current(): GlobalSettings { return this.read().settings; }
  refusal(): { file: string; errors: string[] } | undefined { return this.read().refusal; }
  /** Fields the document on disk actually wrote; empty when refused or absent. */
  authored(): GlobalSettingsField[] { return this.read().authored; }

  /**
   * Apply a partial edit and persist it. Validates the RESULT through the same parser a hand edit
   * goes through, so Control can never write a document that the loader would then refuse.
   */
  update(patch: Partial<GlobalSettings>): GlobalSettingsState {
    // Refuse to write over a document this build could not read. `current()` is the last known good
    // (or the defaults), so writing it back would DESTROY the very file a person is mid-way through
    // repairing — and that file is the documented recovery surface. Fix it first, then edit.
    const refusal = this.refusal();
    if (refusal) {
      throw new Error(`refusing to overwrite Tachyon settings that could not be read — fix ${this.file} first: ${refusal.errors.join("; ")}`);
    }
    const next: GlobalSettings = { ...this.current(), ...patch };
    const document = toGlobalSettingsDocument(next);
    const check = parseGlobalSettings(document, this.file);
    if (!check.settings) throw new Error(`refusing to write invalid Tachyon settings: ${check.errors.join("; ")}`);
    writeGlobalSettingsFile(this.file, document);
    this.lastKnownGood = check.settings;
    this.state = { settings: check.settings, authored: check.authored ?? [] };
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
