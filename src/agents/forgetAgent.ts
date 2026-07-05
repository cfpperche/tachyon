import path from "node:path";
import { deleteActivityLog } from "../activity/logStore.js";
import { removeSessionOwnerRows, removeSpawnSettings, sessionOwnersFile } from "../activity/sessionOwners.js";
import type { SessionLedger } from "../resume/SessionLedger.js";

export const FORGET_AGENT_FOOTPRINTS = [
  "tachyon.yml entry (removed by the declared-removal caller before durable cleanup)",
  "activity log and writer state",
  "session-owner ledger rows",
  "private harness/config home",
  "per-spawn settings file",
  "session ledger row",
] as const;

export interface ForgetAgentDeps {
  workspaceRoot: string;
  ledger?: SessionLedger;
  removeHarnessHome?: (name: string) => void;
}

/**
 * Canonical end-of-life cleanup for one Tachyon agent. Keep FORGET_AGENT_FOOTPRINTS in sync when adding
 * new per-agent state, then route every delete/dismiss path through this helper instead of wiring another
 * one-off cleanup at the call site.
 */
export function forgetAgent(name: string, deps: ForgetAgentDeps): void {
  deps.ledger?.remove(name);
  deleteActivityLog(path.join(deps.workspaceRoot, ".tachyon", "activity"), name);
  removeSessionOwnerRows(sessionOwnersFile(deps.workspaceRoot), name);
  deps.removeHarnessHome?.(name);
  removeSpawnSettings(deps.workspaceRoot, name);
}
