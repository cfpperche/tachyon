/**
 * SDD 504 — the six observable boot states, resolved in ONE place.
 *
 * Pure module (no preact, no vscode): the render imports it, the host does not need it, and the
 * tests assert against the same function the screen uses. That sharing is the point — the defect
 * this replaces was a rule (`!fleets.length` ⇒ absence) that lived inline at one render site and
 * therefore could not be stated, tested, or reviewed as a rule.
 *
 * `delayed` is deliberately NOT a lifecycle phase. It is derived from elapsed time against a folder
 * that is still `starting`, so nothing has to transition into it and nothing has to transition out:
 * the same facts render differently as the clock moves. Making it a phase would mean the host owned
 * a timer whose only product is a change of wording.
 */

import type { FleetVM, SidebarBootVM } from "@tachyon/shared/sidebar/types";

/**
 * When "Starting Tachyon…" becomes "taking longer than usual".
 *
 * A first value the plan asked the implementation to validate against a larger sample, NOT a failure
 * deadline — nothing gives up when it passes; the copy changes and a diagnostic path appears.
 *
 * The sample it is chosen from, activation → provider registration: 1,666 / 2,875 / 3,479 ms in the
 * plan's three reloads (2026-08-13) and 3,944 ms in a real reload with three live agents measured
 * for this task (2026-08-15, `exthost19`). Observed envelope 1.7–3.9 s, so 5 s still clears the
 * slowest ordinary boot on record without being so far out that a stuck window sits silent.
 *
 * What this threshold is NOT the answer to: the owner's 10–30 s report. That was measured to a
 * 24 s synchronous-I/O stall of the extension host occurring ~21 s AFTER activation completed
 * (`t-17674a`), which is a different window and a different defect. A larger threshold here would
 * only have delayed an honest message about a boot that was not actually slow.
 */
export const DELAYED_AFTER_MS = 5_000;

export type SidebarBootState =
  /** The host has not answered yet. The webview's own default — "not asked", never "no". */
  | "unknown"
  /** At least one folder has a Tachyon configuration and is still attaching. */
  | "configured-and-starting"
  /** Still attaching past the ordinary envelope. Not a failure; different words and a diagnostic. */
  | "delayed"
  /** Discovery found configuration and attach was rejected. Never falls back to absence. */
  | "failed"
  /** Every open folder was checked and none has a Tachyon configuration. The honest welcome. */
  | "confirmed-unconfigured"
  /** A fleet is available: show the real lists. */
  | "ready";

/**
 * Resolve what the sidebar shows INSTEAD of a fleet list (or `ready`, meaning: show the lists).
 *
 * Order is the contract, and each step earns its position:
 *
 * 1. A populated fleet wins over every notice. Real data beats any description of how it was
 *    obtained, and this is the readiness edge the plan names — the first successful projection.
 *    It is also what makes multi-root safe: one folder still starting can never blank a healthy
 *    one, because the presence of any fleet takes this branch. The still-starting folder is
 *    reported alongside the lists instead (see `pendingBootFolders`).
 * 2. Not discovered ⇒ `unknown`. Checked BEFORE any claim about folders, because an empty
 *    `folders` array on an undiscovered projection means "not asked", and reading it as "none open"
 *    is precisely the substitution this whole change exists to remove.
 * 3. `failed` outranks `starting`. A window with one failed and one attaching folder has something
 *    to act on now; the attaching one will resolve itself.
 * 4. `starting` ⇒ time decides the wording only.
 * 5. Everything checked, nothing configured, nothing failed ⇒ the honest welcome. Zero open folders
 *    lands here too, and correctly: "open a folder, then generate a tachyon.yml" is exactly right
 *    for an empty window, and it is reached only because discovery said so.
 */
export function resolveBootState(
  boot: SidebarBootVM | undefined,
  fleets: readonly FleetVM[],
  now: number,
): SidebarBootState {
  if (fleets.length > 0) return "ready";
  if (!boot?.discovered) return "unknown";
  if (boot.folders.some((f) => f.phase === "failed")) return "failed";
  const starting = boot.folders.filter((f) => f.phase === "starting");
  if (starting.length > 0) {
    // The OLDEST pending folder decides. A second folder added late must not reset the clock on the
    // one the reader has already been watching.
    const oldest = Math.min(...starting.map((f) => f.startedAt ?? now));
    return now - oldest >= DELAYED_AFTER_MS ? "delayed" : "configured-and-starting";
  }
  return "confirmed-unconfigured";
}

/**
 * Folders that still owe the reader something while a fleet is already on screen (multi-root).
 *
 * Empty in the single-root case that dominates, which is why the notice it drives is additive: the
 * normal sidebar is untouched unless a second folder is genuinely mid-flight or broken.
 */
export function pendingBootFolders(boot: SidebarBootVM | undefined): SidebarBootVM["folders"] {
  return (boot?.folders ?? []).filter((f) => f.phase === "starting" || f.phase === "failed");
}

/** Does anything on screen depend on the clock advancing? Drives the render's tick, nothing else. */
export function bootNeedsTick(boot: SidebarBootVM | undefined): boolean {
  return (boot?.folders ?? []).some((f) => f.phase === "starting");
}
