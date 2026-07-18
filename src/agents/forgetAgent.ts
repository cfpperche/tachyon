import path from "node:path";
import { deleteActivityLog } from "../activity/logStore.js";
import { removeSessionOwnerRows, removeSpawnSettings, sessionOwnersFile } from "../activity/sessionOwners.js";
import type { SessionLedger } from "../resume/SessionLedger.js";
import { removeDerivedAgentFiles } from "./derivedFile.js";
import { removePaneTranscript } from "./paneTranscript.js";

export const FORGET_AGENT_FOOTPRINTS = [
  "session ledger row",
  "activity log and writer state",
  "session-owner ledger rows",
  "private harness/config home",
  "per-spawn settings file",
  "generated spawn brief and soul anchor",
  "durable pane transcript",
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
  const failures: unknown[] = [];
  const attempt = (remove: () => void) => {
    try { remove(); } catch (error) { failures.push(error); }
  };
  // Each footprint is independently idempotent. Never let a corrupt early artifact
  // strand later credentials or private state.
  attempt(() => deps.ledger?.remove(name));
  attempt(() => deleteActivityLog(path.join(deps.workspaceRoot, ".tachyon", "activity"), name));
  attempt(() => removeSessionOwnerRows(sessionOwnersFile(deps.workspaceRoot), name));
  attempt(() => deps.removeHarnessHome?.(name));
  attempt(() => removeSpawnSettings(deps.workspaceRoot, name));
  attempt(() => removeDerivedAgentFiles(deps.workspaceRoot, name));
  attempt(() => removePaneTranscript(deps.workspaceRoot, name));
  if (failures.length) throw new AggregateError(failures, `failed to remove agent '${name}' footprints`);
}
