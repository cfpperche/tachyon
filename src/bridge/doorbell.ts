import fs from "node:fs";
import path from "node:path";

/**
 * spec 363 T1 — the Bridge WITNESSES the completion doorbell (`notify_agent`) by appending one line per call
 * to `.tachyon/doorbells.jsonl` in the SOURCE tree (never the calling agent's own worktree — tamper-resistant
 * like `loadVerifySettings`, since a gated agent cannot rewrite a file it never checks out).
 */

export interface DoorbellEvent {
  from: string;
  to: string;
  at: string;
  /** spec 493 — the notify_agent summary, carried alongside the witness so a busy recipient can read
   *  it back later instead of depending on having been idle at the moment it flushed to the pane. */
  summary?: string;
  /** spec 493 — the notify_agent pointer (task id / artifact ref), same reasoning as `summary`. */
  pointer?: string;
}

export const DOORBELLS_REL_PATH = path.join(".tachyon", "doorbells.jsonl");

export function appendDoorbellEvent(workspaceRoot: string, event: DoorbellEvent): void {
  const file = path.join(workspaceRoot, DOORBELLS_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
}

export function readDoorbellEvents(workspaceRoot: string): DoorbellEvent[] {
  const file = path.join(workspaceRoot, DOORBELLS_REL_PATH);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<DoorbellEvent>;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is DoorbellEvent => !!e && typeof e.from === "string" && typeof e.to === "string" && typeof e.at === "string");
}

/**
 * Did `agent` ring the doorbell (call `notify_agent`) at/after `sinceIso`? Matched against `delegator` when
 * known; falls back to any outgoing event from `agent` when the record has no delegator (e.g. a contract-
 * skipped spawn with no gate).
 */
export function hasDoorbellRung(workspaceRoot: string, agent: string, delegator: string | undefined, sinceIso: string): boolean {
  return readDoorbellEvents(workspaceRoot).some((e) => e.from === agent && e.at >= sinceIso && (delegator ? e.to === delegator : true));
}

/** spec 493 — the read door. Cap on a single call's returned window: a coordinator polls this cheaply,
 *  it never returns unboundedly many rows even for a workspace with a long-lived doorbells.jsonl. */
export const READ_NOTICES_MAX = 200;

export interface ReadNoticesResult {
  notices: DoorbellEvent[];
  returned: number;
  truncated: boolean;
}

/**
 * Notices rung FOR `agent` (i.e. `to === agent`), strictly after `sinceIso` when given, oldest-first,
 * capped at `READ_NOTICES_MAX`. Purely a read over the same durable, name-keyed log `hasDoorbellRung`
 * already reads — a recipient that was dismissed and respawned under the same name still sees notices
 * rung before the restart, and the caller owns its own `since` cursor (no server-side read-receipt).
 */
export function readDoorbellEventsFor(workspaceRoot: string, agent: string, sinceIso?: string): ReadNoticesResult {
  const matching = readDoorbellEvents(workspaceRoot)
    .filter((e) => e.to === agent && (sinceIso === undefined || e.at > sinceIso))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const truncated = matching.length > READ_NOTICES_MAX;
  return { notices: matching.slice(0, READ_NOTICES_MAX), returned: Math.min(matching.length, READ_NOTICES_MAX), truncated };
}
