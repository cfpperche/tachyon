/**
 * spec 350 T1/T2 — panel restore decisions (dueto F7, folded into the base contract after being missing
 * from the draft entirely). Pure: given a captured snapshot and the current load outcome, decide whether to
 * restore the unsaved patch, restore a clean re-load, or discard. The risk note in plan.md is load-bearing
 * here: "when in doubt, restore LESS — losing a draft is better than resurrecting a stale one silently."
 */

import type { StudioRestoreSnapshot } from "@tachyon/webview-ui/webview/shared/studio/protocol";

export type RestoreAction = "restore-patch" | "restore-clean" | "discard";

export interface RestoreDecisionInput<TEntityId, TPatch> {
  /** whether the adapter permits restoring an unsaved patch at all (StudioHostAdapter.allowPatchRestore). */
  allowPatchRestore: boolean;
  snapshot: StudioRestoreSnapshot<TEntityId, TPatch> | null | undefined;
  /** true when the current load attempt for the snapshot's entity failed (not-found/error). */
  currentLoadFailed: boolean;
}

export function decideRestore<TEntityId, TPatch>(input: RestoreDecisionInput<TEntityId, TPatch>): RestoreAction {
  if (!input.snapshot) return "discard";
  // Fail-closed: a failed load means we have nothing trustworthy to patch on top of — restore LESS.
  if (input.currentLoadFailed) return "discard";
  if (input.allowPatchRestore && input.snapshot.patch !== undefined) return "restore-patch";
  return "restore-clean";
}
