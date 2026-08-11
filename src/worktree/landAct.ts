/**
 * SDD 498 (t-7cb971) — THE ACT. This is the only file in `src/` that runs a trunk-mutating git
 * command, and it runs it exactly once, in the primary checkout, under a human's click.
 *
 * WHY IT IS SEPARATE FROM `land.ts`. `land.ts` is read-only by construction and its header promises
 * that; every git call in it is a query. Keeping the mutating verb in its own file means a reader sees
 * the boundary without reading a 380-line module, and the guard test can name one address.
 *
 * WHAT IT IS NOT ALLOWED TO DECIDE. Nothing. The five preconditions live in `landSuggestion` and are
 * re-measured by the caller through `probeLandSuggestion` — the SAME function the panel called to draw
 * the block. This file is handed a sha that a fresh green suggestion just named, and its whole job is
 * to move the ref and report honestly what happened. If a second copy of any precondition ever appears
 * here, the thing that decides has become different from the thing that was shown, which is the defect
 * SDD 498 exists to prevent.
 *
 * THE WINDOW IT DOES NOT CLOSE, AND WHY IT READS THE TRUNK TWICE. Between the caller's re-measure and
 * git starting, another actor can change the primary checkout. Measured by the adversarial review on
 * git 2.53.0: the probe saw `main` and a green fast-forward, a `switch other` landed in the window, and
 * the same `git merge --ff-only <sha>` advanced `other` and left `main` untouched — git moves whatever
 * `HEAD` names when the command starts, because it does not know the intention "move the trunk".
 * Nothing here closes that race; a Tachyon mutex would not be respected by an external terminal
 * anyway. What this file does is make it LOUD: it reads the trunk before and after, and a trunk that
 * did not arrive at the sha we asked for is reported as a failure naming the branch that actually
 * moved and the `reset --hard` that undoes it — never counted as a successful land.
 */

import type { GitExec } from "./WorktreeManager.js";

export type LandRefusalCode =
  /** A precondition was not green when the act was asked for. Carries the check that blocked it. */
  | "not-ready"
  /** Git itself refused — lost the compare-and-swap race, a lock, a non-fast-forward. */
  | "git-refused"
  /** Git succeeded, but the trunk is not where we asked it to be. */
  | "moved-elsewhere"
  /** The trunk head could not be read, so nothing can be claimed about the act. */
  | "unmeasured";

export interface LandFailure {
  ok: false;
  code: LandRefusalCode;
  /** What is wrong. Never empty. */
  reason: string;
  /** What to do about it. Never empty — a refusal that names only the failure is the defect (t-2656d7). */
  fix: string;
  /** The trunk ref this was about, when it is known. */
  trunkRef?: string;
  /** Trunk head observed before the act, when it was read. */
  before?: string;
}

export interface LandSuccess {
  ok: true;
  trunkRef: string;
  primaryPath: string;
  /** The commit that landed — the same one every check described. */
  head: string;
  /** Trunk head before the act. This is the undo target, and it is also in git's own reflog. */
  before: string;
  /** Trunk head after the act. Equal to `head`, or this is not a success. */
  after: string;
}

export type LandResult = LandSuccess | LandFailure;

export interface LandActDeps {
  git: GitExec;
  /** The checkout the ref lives in and the only place a fast-forward leaves index and tree coherent. */
  primaryPath: string;
  /** LOCAL trunk branch name. Only a local branch can be fast-forwarded. */
  trunkRef: string;
  /** The commit to land, pinned by the caller's fresh suggestion. */
  head: string;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * Fast-forward the trunk onto `head`, in the primary checkout.
 *
 * The verb is assembled rather than written as one literal for the same reason `landCommand` does it:
 * the guard test scans argument arrays, and a reader should see the mutating words isolated in the one
 * place they are allowed to be.
 */
export async function landAct(deps: LandActDeps): Promise<LandResult> {
  const { git, primaryPath, trunkRef, head } = deps;

  const before = await revParse(git, primaryPath, trunkRef);
  if (!before) {
    return {
      ok: false,
      code: "unmeasured",
      trunkRef,
      reason: `'${trunkRef}' could not be read in ${primaryPath}, so nothing can be claimed about landing onto it`,
      fix: `check that git can run in ${primaryPath} and that '${trunkRef}' resolves there, then land again`,
    };
  }

  const merged = await git([...FAST_FORWARD, head], primaryPath);
  const after = await revParse(git, primaryPath, trunkRef);

  if (merged.code !== 0) {
    // Git's own words, unsummarised. The honest claim is about THIS invocation: it made no partial
    // update. It is NOT "the trunk is unchanged" — another invocation may have moved it, which is
    // exactly what losing the compare-and-swap race means.
    const said = (merged.stderr || merged.stdout).trim();
    return {
      ok: false,
      code: "git-refused",
      trunkRef,
      before,
      reason: said.length > 0 ? said : `git exited ${merged.code} without a message`,
      fix:
        "the trunk was not moved by this attempt. Refresh the row and look again — another actor may "
        + "have moved it, and the preconditions will say so",
    };
  }

  if (!after) {
    return {
      ok: false,
      code: "unmeasured",
      trunkRef,
      before,
      reason: `git reported success but '${trunkRef}' could not be read back in ${primaryPath}`,
      fix: `check '${trunkRef}' in ${primaryPath} by hand before landing anything else — this act cannot say where it left the trunk`,
    };
  }

  if (after !== head) {
    // The measured window. `after === before` is the branch-switch case: our merge advanced whatever
    // HEAD pointed at instead. Either way the trunk is not where we asked, so this is a failure with a
    // recovery, not a land.
    const movedBranch = await revParse(git, primaryPath, "--abbrev-ref HEAD");
    const origHead = await revParse(git, primaryPath, "ORIG_HEAD");
    const other = movedBranch && movedBranch !== trunkRef ? movedBranch : undefined;
    return {
      ok: false,
      code: "moved-elsewhere",
      trunkRef,
      before,
      reason: other
        ? `'${trunkRef}' is at ${short(after)}, not ${short(head)}: the merge advanced '${other}' instead, `
          + `because that is what HEAD pointed at in ${primaryPath} when it ran`
        : `'${trunkRef}' is at ${short(after)}, not the ${short(head)} this act asked for`,
      fix: origHead
        ? `put it back with \`git -C ${primaryPath} reset --hard ${short(origHead)}\`, check out '${trunkRef}' there, and land again`
        : `check what moved in ${primaryPath} using \`git -C ${primaryPath} reflog\`, restore it, check out '${trunkRef}' there, and land again`,
    };
  }

  return { ok: true, trunkRef, primaryPath, head, before, after };
}

/**
 * The mutating words, isolated. `land.ts` splits them the same way for the string it composes, and the
 * guard test reads argument arrays element by element so `merge-base` (which both modules legitimately
 * call) is a different word from `merge`.
 */
const FAST_FORWARD = ["merge", "--ff-only"] as const;

/**
 * `null` when git could not answer — never a made-up sha. Accepts a multi-word rev-parse form so the
 * branch read (`--abbrev-ref HEAD`) goes through the same failure handling as a sha read; a detached
 * HEAD answers the literal "HEAD", which is not a branch name and is filtered by the caller comparing
 * it against the trunk.
 */
async function revParse(git: GitExec, cwd: string, rev: string): Promise<string | null> {
  try {
    const r = await git(["rev-parse", ...rev.split(" ")], cwd);
    if (r.code !== 0) return null;
    const value = r.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
