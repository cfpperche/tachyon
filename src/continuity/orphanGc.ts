import fs from "node:fs";
import path from "node:path";
import { deleteActivityLog } from "../activity/logStore.js";

/**
 * t-8310ca — GC continuity (+ optional activity) for agent names that no longer
 * exist anywhere Tachyon still knows about. Complements forgetAgent (dismiss/delete);
 * does not replace it. Never touches declared/live/ledger-known agents.
 */

export interface OrphanFootprintGcInput {
  workspaceRoot: string;
  /** Agent names that must be kept (declared ∪ manager.list ∪ ledger ∪ live sessions). */
  knownAgents: ReadonlySet<string>;
  dryRun?: boolean;
  /** Also delete activity jsonl/state for the same orphan names (default true). */
  activity?: boolean;
}

export interface OrphanFootprintGcResult {
  scanned: string[];
  orphans: string[];
  removedContinuity: string[];
  removedActivity: string[];
  dryRun: boolean;
}

/** Discover agent names that have continuity brief and/or state files. */
export function listContinuityAgentNames(continuityDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(continuityDir);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(".md") && !entry.endsWith(".tmp")) {
      names.add(entry.slice(0, -3));
      continue;
    }
    if (entry.endsWith(".state.json")) {
      names.add(entry.slice(0, -".state.json".length));
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function isOrphanAgent(name: string, knownAgents: ReadonlySet<string>): boolean {
  return name.length > 0 && !knownAgents.has(name);
}

/**
 * Remove continuity brief+state (and optionally activity logs) for orphan names.
 * Best-effort per name; never throws for missing files.
 */
export function gcOrphanAgentFootprints(input: OrphanFootprintGcInput): OrphanFootprintGcResult {
  const continuityDir = path.join(input.workspaceRoot, ".tachyon", "continuity");
  const activityDir = path.join(input.workspaceRoot, ".tachyon", "activity");
  const dryRun = input.dryRun === true;
  const doActivity = input.activity !== false;
  const scanned = listContinuityAgentNames(continuityDir);
  const orphans = scanned.filter((name) => isOrphanAgent(name, input.knownAgents));
  const removedContinuity: string[] = [];
  const removedActivity: string[] = [];

  for (const name of orphans) {
    if (dryRun) {
      removedContinuity.push(name);
      if (doActivity) removedActivity.push(name);
      continue;
    }
    try {
      fs.rmSync(path.join(continuityDir, `${name}.md`), { force: true });
    } catch { /* best-effort */ }
    try {
      fs.rmSync(path.join(continuityDir, `${name}.state.json`), { force: true });
    } catch { /* best-effort */ }
    removedContinuity.push(name);
    if (doActivity) {
      deleteActivityLog(activityDir, name);
      removedActivity.push(name);
    }
  }

  return { scanned, orphans, removedContinuity, removedActivity, dryRun };
}
