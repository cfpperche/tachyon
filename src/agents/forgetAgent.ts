import path from "node:path";
import { deleteActivityLog } from "../activity/logStore.js";
import { removeEmptyAgentProfileHome } from "../config/agentProfileHome.js";
import { removeSessionOwnerRows, removeSpawnSettings, sessionOwnersFile } from "../activity/sessionOwners.js";
import type { SessionLedger } from "../resume/SessionLedger.js";
import { removeDerivedAgentFiles } from "./derivedFile.js";
import { removePaneTranscript } from "./paneTranscript.js";

export const FORGET_AGENT_FOOTPRINTS = [
  "session ledger row",
  "activity log and writer state",
  "session-owner ledger rows",
  "private runtime-home credentials",
  "private bridge-mcp runtime artifacts",
  "legacy/idempotent Pi session subtree",
  "per-spawn settings file",
  "generated spawn brief",
  "durable pane transcript",
  "emptied Agent Profile home",
] as const;

export interface ForgetAgentDeps {
  workspaceRoot: string;
  ledger?: SessionLedger;
  removeHarnessHome?: (name: string) => void;
  /**
   * Private `bridge-mcp/<name>.json` / `.opencode.json` configs plus the
   * `bridge-mcp/<name>.<runtime>/` home a non-harness grok/hermes agent runs out of. Distinct from
   * `removeHarnessHome` (which retires credentials only), and it must run AFTER that one: a home
   * withheld for being occupied still has to have lost its credential.
   */
  removeBridgeRuntimeHome?: (name: string) => void;
  removePiSessionDir?: (name: string) => void;
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
  attempt(() => deps.removeBridgeRuntimeHome?.(name));
  attempt(() => deps.removePiSessionDir?.(name));
  attempt(() => removeSpawnSettings(deps.workspaceRoot, name));
  attempt(() => removeDerivedAgentFiles(deps.workspaceRoot, name));
  attempt(() => removePaneTranscript(deps.workspaceRoot, name));
  // t-4a1f85 — LAST, and only if everything above emptied it. Removing an agent's subtrees and
  // keeping its parent left an `.tachyon/agents/<name>/` nobody would ever list again: this helper
  // writes no journal, so no reconcile revisits it. `removeEmptyAgentProfileHome` states why the removal is
  // `rmdir` and not `rm -rf`; the short version is that this function is also reached for names that
  // may still own a canonical `agent.yml` or a human-authored profile data — the declared-terminal delete
  // (`deleteConfiguredAgent`) and the startup ledger GC (`Workspace.gcLedger`) — and the kernel
  // refusing a non-empty directory is the guard that keeps those bytes, unraceably.
  attempt(() => removeEmptyAgentProfileHome(deps.workspaceRoot, name));
  if (failures.length) throw new AggregateError(failures, `failed to remove agent '${name}' footprints`);
}
