/**
 * t-0c963d — WHERE a runtime keeps what Tachyon handed it, separated from WHAT the rules say about it.
 *
 * `collectSessionInspection` used to hold both: Claude-shaped paths (two `--settings` JSON files, a
 * `spawn-settings` host layer) inline with the rules that classify origin, redact secrets and fold a
 * wrapped status line. Adding Codex by copying that function would have produced a second path to the
 * same effect — the defect class t-b4a799 catalogued after five instances in one day.
 *
 * So the split is: a reader per runtime answers "what did you find", and ONE collector applies the
 * rules to it. A rule fixed once is fixed for every runtime; a runtime that keeps its config somewhere
 * new writes a reader and nothing else.
 */

import type { InspectedHook } from "@tachyon/engine/runtimeOps/sessionInspection.js";

/** One settings entry as a reader found it, before the rules decide what it means. */
export interface FoundSetting {
  key: string;
  value: unknown;
  /**
   * True when Tachyon authored the layer this came from, rather than projecting it from the person's
   * own config. Claude splits the two across separate files; a runtime with one merged file leaves
   * this false and lets `classifySetting` decide from the key alone.
   */
  hostAuthored: boolean;
}

/** What a reader found for one session. Every field is best-effort: absent means "could not see". */
export interface SessionSources {
  settings: readonly FoundSetting[];
  /**
   * Keys present in the person's GLOBAL runtime config. This is the not-projected detector: a key
   * here that the family allowlist does not carry never reaches the agent, silently.
   */
  globalKeys: readonly string[];
  hooks: readonly InspectedHook[];
  mcpServers: readonly string[];
  /** The command the host status-line wrapper wraps, when it composed rather than replaced. */
  wrappedStatusLine?: string;
  /** What THIS runtime cannot show, in its own words. Stated, never silently omitted. */
  notExposed: readonly string[];
}

/** Which settings keys mean what, per runtime. Empty lists = we do not know, and say so. */
export interface SessionInspectionConfig {
  /** Keys the profile family allowlist can carry from the person's global config. */
  projectableKeys: readonly string[];
  /** Keys Tachyon writes itself. */
  hostKeys: readonly string[];
  /** Keys the agent profile owns directly (selectors). */
  agentOwnedKeys: readonly string[];
  /** Env keys worth showing beyond `TACHYON_*` — a runtime's config home, typically. */
  extraEnvKeys: readonly string[];
}

/** What a reader is given: the workspace, the agent, and the live process if there is one. */
export interface SessionReadContext {
  workspaceRoot: string;
  agent: string;
  env?: Record<string, string>;
  argv?: readonly string[];
}

export interface RuntimeSessionReader {
  config: SessionInspectionConfig;
  read: (ctx: SessionReadContext) => SessionSources;
}
