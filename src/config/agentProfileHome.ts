import fs from "node:fs";
import path from "node:path";

/**
 * t-4a1f85 — the ONE removal policy for `.tachyon/agents/<name>/`, and the argument for it.
 *
 * Two helpers used to remove the last thing inside a profile home and leave the home itself behind:
 * `removeAgentProfileIfExact` unlinked `agent.yml` (rolling back a canonical create) and
 * `forgetAgent` removed `evolution/`. Both reported success. The residue was permanent — the
 * lifecycle journal is discarded precisely because the rollback converged on everything the journal
 * NAMES, and the directory is not one of those things; `forgetAgent` writes no journal at all.
 * Measured in `docs/specs/494-saved-agent-state-ownership/evidence/orphan-hunt-2026-08-07.md`
 * (origins O1, O2, O3).
 *
 * ## The policy: `rmdir`, never `rm -rf`
 *
 * `savedAgentState.ts` already states the rule these helpers have to obey — a profile directory may
 * hold work a human wants, and Tachyon never deletes it automatically. An EMPTY directory holds
 * nothing; a directory holding `SOUL.md` holds a great deal. So the only removal that is safe on
 * both paths is the one that refuses when anything is inside.
 *
 * `rmdir` is that removal, and its refusal is the guard itself rather than a check written in front
 * of one. "Read the directory, and if it is empty `rm -rf` it" is the same policy with a race in the
 * middle: between the read and the delete, a Soul import or an Evolution write can put bytes inside,
 * and the recursive delete would take them. The kernel's `ENOTEMPTY` cannot be raced.
 *
 * ## Why failing is never fatal here
 *
 * Both callers are cleanup tails whose real contract is elsewhere: the lifecycle compensation must
 * restore the profile/authority/config tuple, and `forgetAgent` must clear the per-agent footprints
 * it names. Turning an `EACCES`, an `EBUSY` or a non-empty home into a thrown error would fail a
 * rollback that already succeeded — and for the lifecycle path that failure lands on
 * `phase: "degraded"`, which every reconcile skips FOREVER (O6). Leaving the directory is strictly
 * better than that, and since t-8b58b3 leaving it is no longer silent: the sweep now reports it as
 * `orphan-home` with a reason, instead of `absent` / "there is nothing to remove".
 */

/** The profile home. Since t-ae221c this directory, with a readable `agent.yml` in it, IS the agent. */
export function agentProfileHome(workspaceRoot: string, agentName: string): string {
  return path.join(path.resolve(workspaceRoot), ".tachyon", "agents", agentName);
}

/**
 * Remove the profile home if — and only if — it is now an empty directory. Returns whether it went.
 *
 * Never throws. A symlink at that path is refused rather than followed: this product only ever
 * creates a real directory there (`publishAgentProfile`, `ensureAgentProfileDir`), so a symlink is
 * something else's, and `rmdir` on it would remove a link the workspace does not own.
 */
export function removeEmptyAgentProfileHome(workspaceRoot: string, agentName: string): boolean {
  const home = agentProfileHome(workspaceRoot, agentName);
  try {
    if (!fs.lstatSync(home).isDirectory()) return false;
    fs.rmdirSync(home);
  } catch {
    // ENOENT (already gone, which is the idempotent case every caller re-enters), ENOTEMPTY (the
    // guard doing its job), or a host refusal. None of them is this helper's to escalate.
    return false;
  }
  // Best-effort durability, matching the rename transaction's own `rmdir` tail. A crash before this
  // reaches disk brings the directory back, and the sweep reports it — it does not lose anything.
  try {
    const parent = fs.openSync(path.dirname(home), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch { /* platforms that refuse to fsync a directory */ }
  return true;
}
