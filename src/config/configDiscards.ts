/**
 * t-7d6013 — the durable record of what the parser DROPPED out of `tachyon.yml`.
 *
 * `ConfigFailure` next door answers "the file could not be loaded". This answers a different
 * question, and it is the one the owner's rule ("descarta o que está errado, mas alerta") leaves
 * unanswered: the file LOADED, and some of what a human wrote in it is not running. t-48dd8d turned
 * every unreadable key into a discard plus a warning, and the read path spent that warning on a
 * toast — so after it faded nothing in the product remembered. A `sandboxMode` typo on a delegated
 * codex agent falls back to `danger-full-access` (AgentManager.ts:2093-2094) with no trace at all.
 *
 * Deliberately NOT a failure:
 *  - it never sets `configValid: false`, which would drop spawn through `isLkgOnlySpawn` and mark a
 *    whole healthy fleet invalid over one typo;
 *  - it never blocks a load, a spawn, or a write. It is a record, not a gate.
 *
 * `signature` is what makes the surface DISMISSIBLE without becoming a sticker: the human dismisses
 * one exact set of discarded lines, so an unchanged file stays quiet across reloads while any change
 * to what was dropped brings the record back.
 */
import { createHash } from "node:crypto";

/**
 * Bound on the rows carried to the UI. The parser can emit one discard per malformed key, and an
 * unbounded array would ride the sidebar projection on every reload; the elision itself is reported
 * as the last row rather than silently dropped.
 */
export const CONFIG_DISCARD_ENTRY_LIMIT = 100;

/** Persistent record of the lines the last successful load discarded. */
export interface ConfigDiscards {
  /** absolute path of the file the lines came from */
  path: string;
  /** basename for short UI labels */
  file: string;
  /** one row per discarded declaration, in parse order */
  entries: string[];
  at: string;
  /** digest of `file` + `entries`; the identity a human's dismissal is keyed by */
  signature: string;
}

/** Webview payload for the discard banner. */
export interface ConfigDiscardsVM {
  file: string;
  path: string;
  entries: string[];
  /** first entry, pre-truncated for the banner */
  summary: string;
  /** echoed back by the dismiss gesture, so a dismissal can never land on a set the human never saw */
  signature: string;
}

export function configDiscardsSignature(file: string, entries: readonly string[]): string {
  return createHash("sha256").update([file, ...entries].join("\n"), "utf8").digest("hex").slice(0, 16);
}

/**
 * Builds the record, or `undefined` when the load discarded nothing — the absent case is the common
 * one and the caller stores it verbatim, so "no discards" is never an empty banner.
 */
export function makeConfigDiscards(input: {
  path: string;
  file: string;
  discarded: readonly string[];
  at: string;
}): ConfigDiscards | undefined {
  if (input.discarded.length === 0) return undefined;
  const entries = input.discarded.slice(0, CONFIG_DISCARD_ENTRY_LIMIT);
  if (input.discarded.length > CONFIG_DISCARD_ENTRY_LIMIT) {
    entries.push(`… and ${input.discarded.length - CONFIG_DISCARD_ENTRY_LIMIT} more discarded declaration(s)`);
  }
  return {
    path: input.path,
    file: input.file,
    entries,
    at: input.at,
    signature: configDiscardsSignature(input.file, entries),
  };
}

export function toConfigDiscardsVM(discards: ConfigDiscards): ConfigDiscardsVM {
  const first = discards.entries[0] ?? "a declaration was discarded";
  const more = discards.entries.length > 1 ? ` (+${discards.entries.length - 1} more)` : "";
  return {
    file: discards.file,
    path: discards.path,
    entries: discards.entries,
    summary: `${first}${more}`,
    signature: discards.signature,
  };
}
