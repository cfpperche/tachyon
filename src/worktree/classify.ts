/**
 * spec 444 — fail-closed classification for a ManagedWorktreeEntry, composing signals already
 * proven at spec 392/365/398 (path existence, dirty/ahead-of-base, occupancy, branch ownership,
 * base-containment) into one of four algorithmic states. "active" (the registry's own `status`
 * field, spec 392) stays a separate, unchanged axis shown alongside — see notes.md.
 *
 * Deliberately does NOT import from the retired `git-delivery/classify` module: that module's containment check
 * is coupled to the `GitDelivery` type. The underlying git operation is small and stable enough to
 * port against primitive `(cwd, baseRef)` args instead of widening spec 365's shipped code for a
 * spec 444 concern.
 */

import fs from "node:fs";
import type { GitExec, WorktreeOccupancy, WorktreeStatus } from "./WorktreeManager.js";
import { defaultGitExec } from "./WorktreeManager.js";
import type { ManagedWorktreeEntry } from "./managedWorktree.js";

export type WorktreeClassificationState = "record-only" | "ready-to-remove" | "needs-review" | "occupied";

export interface WorktreeClassification {
  state: WorktreeClassificationState;
  /** Human-readable reasons backing `state` — always non-empty for `needs-review`. */
  reasons: string[];
  pathExists: boolean;
  dirty: boolean;
  aheadOfBase: number;
  /**
   * t-6ae9a8 — HISTORICAL AND INFORMATIONAL ONLY. `baseRef` is the ref the worktree was CREATED from,
   * so it goes stale the moment anything lands on the trunk: a fully-landed worktree reads as "N
   * commits not contained in base" purely because the trunk moved past its birth point. Kept for
   * diagnostics; never the basis of a safety decision.
   */
  containedInBase: boolean;
  /**
   * t-6ae9a8 — the AUTHORITATIVE containment signal: is HEAD contained in the CURRENT trunk. This is
   * the question a removal decision actually depends on — "has this work arrived where it was going",
   * not "was it born recently". Fail-closed: an unresolvable trunk reads as NOT contained.
   */
  containedInTrunk: boolean;
  /**
   * The trunk ref containment was measured against, so a reason line can name it. When several
   * candidates were tried (t-24e28d), this is the one that PROVED containment, or the first that was
   * looked at when none did — a refusal that names a ref nobody has is worse than useless.
   */
  trunkRef: string;
  occupant?: WorktreeOccupancy;
  /**
   * t-d29398 — the Git worktree lock, when one is held, with the reason git recorded. Tachyon's own
   * quarantine reads `added with --lock`; a human's `git worktree lock --reason` reads whatever they
   * wrote.
   *
   * It has to be part of the classification rather than a detail the UI probes on the side, for the
   * reason every other signal here is: a lock changes what may be DONE with the row. Git refuses to
   * remove a locked checkout even with `--force`, so before this existed a locked-but-otherwise-clean
   * worktree classified `ready-to-remove` and offered a Remove button that could only ever fail.
   */
  lock?: { reason?: string };
}

export interface ClassifyWorktreeDeps {
  git?: GitExec;
  /**
   * t-6ae9a8 — the trunk to measure containment against. An explicit value OVERRIDES discovery and
   * is the only ref tried, so a test can pin it and a fork can name one that no heuristic would find.
   */
  trunkRef?: string;
  /**
   * t-24e28d — pre-resolved trunk candidates, for a caller classifying many entries against one
   * repository (`ManagedWorktreeService.listClassified`) that would rather resolve once than per row.
   * Ignored when `trunkRef` is given. Absent, each call discovers its own via `resolveTrunkRefs`.
   */
  trunkRefs?: string[];
  /** Dirty/ahead-of-base probe — the same signature as `WorktreeManager.status`. */
  status: (cwd: string, baseRef: string) => Promise<WorktreeStatus>;
  /** Live-agent occupancy probe — the same signature as `AgentManager.worktreeOccupant`. */
  occupancy?: (worktreePath: string) => Promise<WorktreeOccupancy | undefined>;
  /**
   * t-d29398 — Git lock probe, the same signature as `WorktreeManager.lockState`. `undefined` from it
   * means UNKNOWN (git could not answer), and unwired means the caller never asked; neither is read as
   * "unlocked", so an unmeasured lock costs a row nothing and claims nothing.
   */
  lockState?: (worktreePath: string) => Promise<{ locked: boolean; reason?: string } | undefined>;
  pathExists?: (p: string) => boolean;
}

/** Mirrors git-delivery/classify.ts's patchesAllInBase: every `git cherry` line is an already-equivalent ('-') patch. */
function patchesAllInBase(cherry: { code: number; stdout: string }): boolean {
  return cherry.code === 0 && cherry.stdout.split("\n").every((line) => line.trim() === "" || !line.trim().startsWith("+"));
}

/**
 * Is `cwd`'s HEAD contained in `baseRef` — either as a real ancestor (the common case, already
 * known from `status.aheadOfBase === 0`) or, when it has commits ahead, because every one of those
 * commits' patches is already present in base (cherry-picked/squash-merged without a fast-forward).
 * Best-effort: any probe failure reads as NOT contained (fail-closed — never claims safety it can't prove).
 */
async function isContainedInBase(git: GitExec, cwd: string, baseRef: string, aheadOfBase: number): Promise<boolean> {
  if (aheadOfBase === 0) return true;
  try {
    const head = await git(["rev-parse", "HEAD"], cwd);
    if (head.code !== 0 || !head.stdout.trim()) return false;
    const cherry = await git(["cherry", baseRef, head.stdout.trim()], cwd);
    return patchesAllInBase(cherry);
  } catch {
    return false;
  }
}

/**
 * t-6ae9a8 — is HEAD contained in `ref` RIGHT NOW, resolving the ref itself rather than trusting a
 * recorded one.
 *
 * This is the question that decides whether a worktree is discardable, and the reason the previous
 * check answered the wrong one: it compared against the CREATION baseRef, which every landing makes
 * older. Measured on this host — eight clean worktrees whose commits were all in `main` were each
 * reported as "N commits not contained in base", so nothing could reclaim them and they accumulated
 * with a full `node_modules` apiece.
 *
 * Two ways to be contained, both accepted: a true ancestor (the fast-forward case), or every commit's
 * patch already present (squash-merged or cherry-picked, where no ancestry survives). The second is
 * why `git cherry` is used rather than `merge-base --is-ancestor` alone.
 *
 * FAIL-CLOSED at every exit. An unresolvable ref, a failed probe, a thrown call — all read as NOT
 * contained, because the entire value of this signal is that it never claims a safety it cannot
 * demonstrate. Loosening that would turn a cleanup into data loss.
 */
async function isContainedInRef(git: GitExec, cwd: string, ref: string): Promise<boolean> {
  try {
    const resolved = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (resolved.code !== 0 || !resolved.stdout.trim()) return false;
    const head = await git(["rev-parse", "HEAD"], cwd);
    if (head.code !== 0 || !head.stdout.trim()) return false;
    const ancestor = await git(["merge-base", "--is-ancestor", head.stdout.trim(), resolved.stdout.trim()], cwd);
    if (ancestor.code === 0) return true;
    const cherry = await git(["cherry", resolved.stdout.trim(), head.stdout.trim()], cwd);
    return patchesAllInBase(cherry);
  } catch {
    return false;
  }
}

/**
 * t-24e28d — WHICH ref is "the trunk", answered by asking the repository instead of assuming.
 *
 * t-6ae9a8 fixed the QUESTION containment asks — is the work in the trunk, not is it in the ref this
 * worktree was born from — and then hardcoded the answer to the literal string `main`. On this host
 * that string happens to be right, so the hardcode was invisible; it is wrong in two measured ways
 * that both regenerate the original symptom, a clean and fully-landed worktree reported as "N
 * commit(s) not contained in base":
 *
 *   · a repository whose trunk is `master` (or `trunk`, or anything a fork chose). `main` never
 *     resolves, the fail-closed default says "not contained", and EVERY landed worktree is stuck at
 *     needs-review permanently — the accumulation t-6ae9a8 set out to stop, restored in full;
 *   · a machine where `origin/main` has been fetched past a local `main` nobody has merged yet. The
 *     work is in the trunk by any honest reading of the word; only a local pointer has not moved.
 *
 * WHICH REF WAS ELECTED, and why, since the three plausible answers diverge on a developer box:
 *
 *   · NOT the workspace's checked-out branch. It is whatever a human or agent last checked out — on
 *     this host, routinely a `tachyon/change/*` branch. Letting an incidental checkout define the
 *     trunk makes a safety verdict depend on where someone happens to be standing, and could name a
 *     change branch as the thing that proves change branches disposable.
 *   · NOT `origin/<trunk>` alone. Tachyon lands into the LOCAL trunk and does not push, so the remote
 *     lags by every landed commit; measured here 2026-08-01, `main` and `origin/main` agreed at
 *     4834b958, but they agree only because nothing had landed since the last push. Requiring the
 *     remote would refuse every worktree landed since — this bug, rebuilt.
 *   · THE LOCAL TRUNK BRANCH, whatever it is called, AND its remote counterpart, with EITHER proof
 *     sufficient. That is deliberately the same shape as t-6ae9a8's base-or-trunk rule, and rests on
 *     the same argument: containment asks whether removal loses the commits, and a commit reachable
 *     from any durable long-lived ref is not lost. Two refs that can each lag the other in practice
 *     mean accepting both loses nothing and refuses less.
 *
 * The trunk's NAME is taken from `refs/remotes/origin/HEAD` first — the remote's own declaration of
 * its default branch, which is what `git clone` records and `git remote set-head` refreshes, and the
 * only statement in the repository that is actually authoritative. Conventional names are tried only
 * when there is no remote to ask.
 *
 * FAIL-CLOSED throughout. Discovery widens where we LOOK, never what counts as proof: a candidate is
 * only ever a ref to test HEAD against, and `isContainedInRef` still demands real ancestry or a real
 * patch match. When nothing resolves at all this returns `["main"]` rather than an empty list, so the
 * refusal can still name what it went looking for — an empty list would read as "no candidate failed".
 */
export async function resolveTrunkRefs(git: GitExec, cwd: string): Promise<string[]> {
  const resolves = async (ref: string): Promise<boolean> => {
    try {
      const r = await git(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
      return r.code === 0 && r.stdout.trim() !== "";
    } catch {
      return false;
    }
  };
  let declared: string | undefined;
  try {
    const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    // "origin/main" → "main". A remote HEAD pointing anywhere else is not a name we can localize.
    if (head.code === 0 && head.stdout.trim().startsWith("origin/")) declared = head.stdout.trim().slice("origin/".length);
  } catch {
    /* no remote, or a remote that never had its HEAD set — fall through to the conventional names */
  }
  for (const name of [...(declared ? [declared] : []), "main", "master", "trunk"]) {
    const local = await resolves(name);
    const remote = await resolves(`origin/${name}`);
    if (local || remote) return [...(local ? [name] : []), ...(remote ? [`origin/${name}`] : [])];
  }
  return ["main"];
}

export async function classifyManagedWorktree(
  entry: ManagedWorktreeEntry,
  deps: ClassifyWorktreeDeps,
): Promise<WorktreeClassification> {
  const pathExists = (deps.pathExists ?? fs.existsSync)(entry.path);
  if (!pathExists) {
    return {
      state: "record-only",
      // t-dcdb7f — name the reachable exit: missing path is registry residue, not a checkout to force.
      reasons: [
        "path does not exist; list worktrees to reconcile the registry to abandoned, or drop the row from the host UI",
      ],
      pathExists: false,
      dirty: false,
      aheadOfBase: 0,
      containedInBase: false,
      containedInTrunk: false,
      // No checkout to run git in, so no discovery is possible here; naming the override or the
      // conventional default is the honest answer for a record that was never probed.
      trunkRef: deps.trunkRef ?? deps.trunkRefs?.[0] ?? "main",
    };
  }

  const git = deps.git ?? defaultGitExec;
  const occupant = await deps.occupancy?.(entry.path).catch(() => undefined);
  const lockProbe = await deps.lockState?.(entry.path).catch(() => undefined);
  const lock = lockProbe?.locked ? { ...(lockProbe.reason ? { reason: lockProbe.reason } : {}) } : undefined;
  const status = await deps.status(entry.path, entry.baseRef).catch(
    (): WorktreeStatus => ({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      detached: false,
      branch: null,
      aheadOfBase: -1, // sentinel: probe failed — never treat as "0 ahead / safe"
      unpushed: 0,
      hasUpstream: false,
    }),
  );
  // Two distinct probe-failure shapes, both fail-closed (adversarial-review blocker): the status()
  // PROMISE rejecting (our own -1 sentinel above), and status() RESOLVING with aheadProbeFailed —
  // WorktreeManager.status never rejects when `rev-list baseRef..HEAD` itself fails (unresolvable/
  // deleted baseRef); it best-effort-coerces aheadOfBase to 0, which must never read as "contained".
  const probeFailed = status.aheadOfBase < 0 || status.aheadProbeFailed === true;
  const dirty = probeFailed || status.staged > 0 || status.unstaged > 0 || status.untracked > 0 || status.conflicts > 0;
  const aheadOfBase = Math.max(0, status.aheadOfBase);
  const containedInBase = !probeFailed && (await isContainedInBase(git, entry.path, entry.baseRef, aheadOfBase));
  // t-6ae9a8 — measured against the CURRENT trunk, and deliberately NOT gated on `probeFailed`. That
  // flag means the recorded baseRef could not be resolved or `status` failed against it, which says
  // nothing about the trunk: a worktree whose birth ref was deleted can still be entirely landed.
  // Keeping the trunk probe independent is what lets a stale baseRef stop blocking cleanup.
  // t-24e28d — an explicit trunkRef is an override and stays the ONLY candidate; otherwise the
  // repository is asked what its trunk is called (and whether a remote counterpart exists).
  const candidates = deps.trunkRef
    ? [deps.trunkRef]
    : deps.trunkRefs?.length
      ? deps.trunkRefs
      : await resolveTrunkRefs(git, entry.path);
  let provenBy: string | undefined;
  for (const candidate of candidates) {
    if (await isContainedInRef(git, entry.path, candidate)) {
      provenBy = candidate;
      break;
    }
  }
  const containedInTrunk = provenBy !== undefined;
  // Report the ref that carried the proof; with none, the first candidate — the one a reader should
  // check first to understand the refusal.
  const trunkRef = provenBy ?? candidates[0] ?? "main";

  if (occupant) {
    return {
      state: "occupied",
      // t-dcdb7f — occupancy is the blocking condition; name who to stop, not only who is there.
      reasons: [
        `occupied by '${occupant.agent}' (${occupant.state}); stop agent '${occupant.agent}' (kill_agent) or wait until it leaves this worktree`,
      ],
      pathExists: true,
      dirty,
      aheadOfBase,
      containedInBase,
      containedInTrunk,
      trunkRef,
      occupant,
      ...(lock ? { lock } : {}),
    };
  }

  // t-dcdb7f — reasons are ordered by what the caller should resolve first (dirty/status before
  // containment). Each line names a reachable exit after the why, matching hygieneAuthority.
  // Callers that surface a refusal should report reasons[0] only when one condition blocks the rest.
  const reasons: string[] = [];
  // t-d29398 — FIRST, because it blocks every other exit. Git refuses to remove a locked worktree at
  // all (measured: `remove --force` fails the same way as a soft remove; only `-f -f` overrides), so a
  // reason list that led with dirtiness or containment would send a reader to fix something that would
  // not have unblocked them anyway. It also names the door: this line is what the human reads instead
  // of the old "unlock explicitly" that pointed at nothing.
  if (lock) {
    reasons.push(
      `held by a Git worktree lock${lock.reason ? ` (${lock.reason})` : ""}` +
        (lock.reason === "added with --lock"
          ? " — an interrupted launch left its quarantine behind; release it from Control → Worktrees, then remove or relaunch"
          : " — release it from Control → Worktrees once you know why it was locked, then remove or relaunch"),
    );
  }
  const statusRejected = status.aheadOfBase < 0;
  const genuinelyDirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0 || status.conflicts > 0;
  // A `git status` that could not run at all still blocks: without it we do not know whether there is
  // uncommitted work, and that is a data-loss question no containment result can answer.
  if (statusRejected) {
    reasons.push(
      "git status probe failed — treated as unsafe; fix git/permissions so dirtiness can be measured, or force-remove as owner with confirmDirty=true if you accept unknown dirtiness",
    );
  }
  if (!statusRejected && genuinelyDirty) {
    reasons.push(
      "worktree has uncommitted changes; commit or discard them, or force-remove as owner with confirmDirty=true",
    );
  }
  // t-6ae9a8 — the ONE containment reason, and it names the trunk. An unresolvable creation baseRef is
  // no longer a blocker on its own: it is a fact about where the worktree was born, and being born
  // from a ref that has since been deleted says nothing about whether the work arrived. What blocks is
  // failing to prove the work is IN the trunk.
  // t-6ae9a8 — EITHER proof is sufficient, and that is the whole fix. Two independent ways for removal
  // to lose nothing:
  //   · contained in the recorded base — the work is present in the ref this worktree branched from;
  //   · contained in the current trunk — the work has since landed where it was going.
  // The old check demanded the first and only the first, so every landing made a clean worktree look
  // MORE unsafe rather than less. Requiring both would be stricter than the safety argument needs;
  // requiring only the stale one is what accumulated eight of them here.
  const contained = containedInBase || containedInTrunk;
  // When `git status` itself failed we do not know how many commits are ahead, so appending a
  // containment count would be noise on top of the one fact that matters: the probe did not run.
  // The status failure already blocks, and it is the actionable line.
  if (!contained && !statusRejected) {
    // Only now does an unresolvable base matter: with no trunk proof either, nothing establishes that
    // the commits are recoverable, and that is exactly when the classifier must refuse.
    if (!statusRejected && status.aheadProbeFailed === true) {
      reasons.push(
        `base ref '${entry.baseRef}' could not be resolved and HEAD is not in '${trunkRef}' — ancestry unknown, treated as unsafe; restore a resolvable base or prove HEAD is in '${trunkRef}' before removing`,
      );
    } else {
      reasons.push(
        `${aheadOfBase} commit(s) not contained in base or in '${trunkRef}'; land or integrate them into the trunk before removing`,
      );
    }
  }

  const shape = { pathExists: true, dirty, aheadOfBase, containedInBase, containedInTrunk, trunkRef, ...(lock ? { lock } : {}) } as const;
  if (reasons.length === 0) return { state: "ready-to-remove", reasons: [], ...shape };
  return { state: "needs-review", reasons, ...shape };
}
