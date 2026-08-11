/**
 * t-7cb971 — SUGGEST AND COPY: the exact land command for a delivery that is ready, plus the state of
 * every precondition behind it. This module never lands anything. It composes a string a human runs.
 *
 * WHY IT EXISTS. Tachyon models the AUTHORITY to integrate but not the ACT: an agent isolated in a
 * worktree delivers to the edge of its own branch and stops, and a human then types a git command by
 * hand — without the preconditions the product already knows how to check. Measured 2026-08-06/07 on
 * this host: eight hand-run merges, three of which broke the trunk. Every one of those three failed on
 * a condition already computable here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never runs git in a mutating mode, and the string it produces
 * is only ever routed to the clipboard. `landCommandNeverExecuted.test.ts` holds that line for the
 * whole of `src/`: no git invocation anywhere in the product may pass `merge` or `--ff-only`.
 * The record-only posture is unchanged — this slice is the half of t-7cb971 that is correct under
 * BOTH answers to its open product question, because if the product may never mutate the trunk, the
 * task itself says the right move is "give the human the exact command, ready".
 *
 * THE COMMAND NAMES A COMMIT, NEVER A BRANCH. Every check below is evidence about one tree. A command
 * that said `merge --ff-only <branch>` would be evidence about the tree that existed when the panel
 * rendered, applied to whatever the branch points at when the human pastes it — which is exactly the
 * class of suggestion this exists to prevent. Naming the sha makes the command and its evidence
 * describe the same content, and it is also why a live agent still working in the checkout is NOT a
 * blocker: a new commit moves the branch, not the suggestion, and the attestation is keyed to the
 * tree, so a stale panel goes red rather than lying.
 *
 * ALL-OR-NOTHING. A blocked delivery gets no command at all, only the failed conditions and their
 * exits. Handing over a command that will fail wastes the human's time; handing over one that will
 * SUCCEED when it should not is the defect being fixed. A suggestion that does not check is worse
 * than no suggestion, because it reads as authority.
 *
 * WHAT IS NOT CHECKED, AND WHY, since t-7cb971's body lists five preconditions and two of them rest
 * on machinery that no longer exists:
 *
 *   · "principal autorizado (`integratePrincipals`)" — `settings.gitDelivery` is RETIRED and ignored
 *     (`src/config/loadConfig.ts`, `src/config/tachyon.schema.json`); the tools it authorized
 *     (`git_delivery_integrate`, `git_delivery_prune`, `delivery_salvage`) were removed with the
 *     Delivery subsystem. There is nothing left to call. Nor is there anything to authorize: this
 *     slice executes nothing, so the acting principal IS the human holding the keyboard, and a
 *     product-side authority check over a command the product does not run would be theatre.
 *   · "head contido — a prova que o integrate record-only já faz" — that tool is gone too. The
 *     containment PRIMITIVE survives in `classify.ts` (`isContainedInRef`, `resolveTrunkRefs`) and is
 *     what this module reuses, rather than a second implementation that would drift.
 *
 * And one the task lists that is a REMOVAL precondition rather than a landing one:
 *
 *   · "worktree desocupado" — an agent is normally still alive in its checkout at the moment its work
 *     is landed. Requiring the checkout to be empty would refuse every ordinary delivery. What the
 *     occupancy check protects against there — a moving HEAD — is answered here by pinning the sha.
 */

import path from "node:path";
import type { GitExec } from "./WorktreeManager.js";
import { readVerificationRecord } from "../workspace/verifyRecordReader.js";

/**
 * The five conditions, in the order a human hits them: their own checkout first, then the proof it
 * carries, then the shape of the landing, then the checkout the command runs in.
 */
export type LandCheckId =
  | "worktree-clean"
  | "verified-tree"
  | "fast-forward"
  | "primary-on-trunk"
  | "primary-clean";

export const LAND_CHECK_ORDER: readonly LandCheckId[] = [
  "worktree-clean",
  "verified-tree",
  "fast-forward",
  "primary-on-trunk",
  "primary-clean",
] as const;

export interface LandCheck {
  id: LandCheckId;
  ok: boolean;
  /**
   * Green: WHAT PROVED IT — the sha, the ref, the timestamp. A green with no evidence is
   * indistinguishable from a green that was never computed, which is the failure mode this whole
   * surface exists to remove. Red: why it is not proved. Never empty.
   */
  detail: string;
  /** The reachable exit. Present only when `ok` is false, and never a restatement of `detail`. */
  fix?: string;
}

export interface LandSuggestion {
  /** The commit the command lands — the same one every check above describes. */
  head: string;
  branch: string;
  /** Local trunk branch the fast-forward would move. */
  trunkRef: string;
  /** Checkout the command runs in, or null when this repository's topology could not be read. */
  primaryPath: string | null;
  /** Commits this delivery would add to the trunk, from the classifier's own count. */
  commits: number;
  checks: LandCheck[];
  /** Set ONLY when every check passed. */
  command?: string;
}

/**
 * The probed inputs. Every "could not tell" is a `null` rather than a `false` so the composer can say
 * *not measured* instead of *not true* — a refusal that names the wrong reason sends the human to fix
 * something that was never broken.
 */
export interface LandFacts {
  head: string | null;
  branch: string;
  /** Local trunk branch name (`main`, `master`, …), or null when the repository has no local trunk. */
  trunkRef: string | null;
  primaryPath: string | null;
  /** From the classifier — uncommitted changes in the delivering worktree. */
  dirty: boolean;
  commits: number;
  /** The per-tree verification record for the delivering worktree's HEAD, or null when there is none. */
  verified: { tree: string; at: string } | null;
  /** Is the local trunk an ancestor of HEAD — i.e. is a fast-forward possible at all. null = unmeasured. */
  trunkIsAncestorOfHead: boolean | null;
  /**
   * SDD 498 D6 — where the local trunk actually is. Only used to say *moved to what* when the
   * fast-forward check is red: after 2026-08-11 that is the operator's immediate next question, and
   * the incident was diagnosed by comparing hashes after the fact. null = unmeasured, and the message
   * then says only what it can prove.
   */
  trunkHead: string | null;
  /** Branch checked out in the primary checkout, or null when unreadable/detached. */
  primaryBranch: string | null;
  /** Uncommitted changes in the primary checkout. null = unmeasured. */
  primaryDirty: boolean | null;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * Pure composer. Fail-closed at every branch: anything that is not a positive, measured proof is a
 * blocked check with a reason, and one blocked check is enough to withhold the command.
 */
export function landSuggestion(facts: LandFacts): LandSuggestion {
  const head = facts.head ?? "";
  const trunk = facts.trunkRef ?? "";
  const checks: LandCheck[] = [];

  checks.push(
    facts.dirty
      ? {
        id: "worktree-clean",
        ok: false,
        detail: "the delivering worktree has uncommitted changes",
        fix: "commit or discard them — anything left behind is not in the tree that was verified, and not in the tree that would land",
      }
      : { id: "worktree-clean", ok: true, detail: "no uncommitted changes in the delivering worktree" },
  );

  // The gate's own record, keyed by TREE (scripts/verify-record.mjs) and read through the host reader
  // that already exists for it. Keyed by tree rather than commit is what makes this answer survive a
  // rebase or an amended message: it is the content that was verified.
  checks.push(
    facts.verified
      ? {
        id: "verified-tree",
        ok: true,
        detail: `tree ${short(facts.verified.tree)} verified at ${facts.verified.at}`,
      }
      : {
        id: "verified-tree",
        ok: false,
        detail: head
          ? `no verify record for the tree at ${short(head)} — this content has not been proved green here`
          : "no commit to attest",
        fix: "run the declared verify gate IN this worktree, and commit nothing after it — the tree you land must be the tree you verified",
      },
  );

  // ONE probe answering two of the task's preconditions at once: whether `--ff-only` can succeed, and
  // whether the trunk moved since this branch last integrated. They are the same question — a trunk
  // that moved is a trunk that is no longer an ancestor — and asking it once is what stops the two
  // answers from ever disagreeing.
  if (!trunk) {
    checks.push({
      id: "fast-forward",
      ok: false,
      detail: "this repository has no local trunk branch to fast-forward",
      fix: "create or check out the local trunk (a remote-only trunk cannot be fast-forwarded)",
    });
  } else if (facts.trunkIsAncestorOfHead === true) {
    checks.push({
      id: "fast-forward",
      ok: true,
      detail: `'${trunk}' is an ancestor of ${short(head)} — a fast-forward, no merge commit`,
    });
  } else if (facts.trunkIsAncestorOfHead === false) {
    checks.push({
      id: "fast-forward",
      ok: false,
      detail: facts.trunkHead
        ? `'${trunk}' has moved to ${short(facts.trunkHead)} and is no longer contained in ${short(head)}`
        : `'${trunk}' has moved past this branch's base — ${short(head)} does not contain it`,
      fix: `integrate '${trunk}' into this branch and re-run the verify gate; the combined tree is the one that lands, and nothing has verified it yet`,
    });
  } else {
    checks.push({
      id: "fast-forward",
      ok: false,
      detail: "ancestry could not be measured — treated as unsafe",
      fix: "check that git can run in this checkout and that the trunk ref resolves",
    });
  }

  // The primary checkout is where a fast-forward is mechanically safe: while it sits on the trunk,
  // advancing that ref from anywhere else leaves its index and working tree inconsistent with the new
  // HEAD. So the command names it explicitly, and these two checks are about THAT checkout.
  if (!facts.primaryPath) {
    checks.push({
      id: "primary-on-trunk",
      ok: false,
      detail: "the primary checkout could not be located from this worktree",
      fix: "run the land command yourself in the checkout that owns this repository's .git directory",
    });
  } else if (!trunk) {
    checks.push({
      id: "primary-on-trunk",
      ok: false,
      detail: "no local trunk to compare the primary checkout against",
      fix: "create or check out the local trunk",
    });
  } else if (facts.primaryBranch === trunk) {
    checks.push({ id: "primary-on-trunk", ok: true, detail: `the primary checkout has '${trunk}' checked out` });
  } else {
    checks.push({
      id: "primary-on-trunk",
      ok: false,
      detail: facts.primaryBranch
        ? `the primary checkout has '${facts.primaryBranch}' checked out, not '${trunk}'`
        : "the primary checkout is detached or its branch could not be read",
      fix: `check out '${trunk}' there first — a fast-forward run against the wrong branch moves the wrong ref, and this command would not fail while doing it`,
    });
  }

  if (facts.primaryDirty === false) {
    checks.push({ id: "primary-clean", ok: true, detail: "no uncommitted changes in the primary checkout" });
  } else if (facts.primaryDirty === true) {
    checks.push({
      id: "primary-clean",
      ok: false,
      detail: "the primary checkout has uncommitted changes",
      // SDD 498 D5 — "stash" was here and is deliberately gone. The stash stack belongs to the
      // REPOSITORY, not to a checkout, so on a host running parallel worktrees it is shared state:
      // docs/project-guidance records 2026-08-01, where one agent's `pop` restored a different
      // agent's work. The product should not hand a human shared-state advice as its first suggestion.
      fix: "commit or discard them there — a fast-forward carries them onto the trunk's new state, where nobody verified them",
    });
  } else {
    checks.push({
      id: "primary-clean",
      ok: false,
      detail: "the primary checkout's cleanliness could not be measured — treated as unsafe",
      fix: "check that git can run in the primary checkout",
    });
  }

  const ordered = LAND_CHECK_ORDER.map((id) => checks.find((c) => c.id === id)!);
  const ready = ordered.every((c) => c.ok) && head.length > 0 && facts.primaryPath !== null;
  return {
    head,
    branch: facts.branch,
    trunkRef: trunk,
    primaryPath: facts.primaryPath,
    commits: facts.commits,
    checks: ordered,
    ...(ready ? { command: landCommand(facts.primaryPath!, head) } : {}),
  };
}

/**
 * The one place the command text is built. Assembled from pieces so the literal `merge --ff-only`
 * never appears in the product's source as something a git invocation could be handed — the guard
 * test scans argument arrays, and a human reading this file should see the same separation.
 */
export function landCommand(primaryPath: string, head: string): string {
  const verb = ["merge", "--ff-only"].join(" ");
  return `git -C ${primaryPath} ${verb} ${head}`;
}

/**
 * `<primary>/.git` is what `--git-common-dir` resolves to from any worktree of a normal clone — the
 * same property `verifyRecordReader` relies on to read a record an agent's checkout wrote. Any other
 * shape (a bare repo, an externally-placed git dir) is a topology this suggestion cannot describe
 * honestly, so it answers null and the composer refuses rather than guessing a path into a command.
 */
export async function resolvePrimaryCheckout(git: GitExec, cwd: string): Promise<string | null> {
  const common = await gitLine(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!common) return null;
  return path.basename(common) === ".git" ? path.dirname(common) : null;
}

async function gitLine(git: GitExec, args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await git(args, cwd);
    if (r.code !== 0) return null;
    const value = r.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * `git merge-base --is-ancestor` reports its answer in the exit code, and only 0 and 1 are answers:
 * 0 is "yes", 1 is "no", anything else is git failing, which is not a "no". Collapsing the third case
 * into `false` would tell the human the trunk had moved when in fact nothing was measured.
 */
async function isAncestor(git: GitExec, cwd: string, ancestor: string, descendant: string): Promise<boolean | null> {
  try {
    const r = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    if (r.code === 0) return true;
    return r.code === 1 ? false : null;
  } catch {
    return null;
  }
}

/**
 * The primary checkout's state — a property of the REPOSITORY, identical for every row in a sweep.
 * Resolved once by the caller for the same two reasons `resolveTrunkRefs` already is: it costs three
 * subprocesses per row otherwise (measured 25ms per row at a 3s panel poll, half of it this), and two
 * rows in one refresh must never disagree about which branch the primary has checked out.
 */
export interface PrimaryCheckoutState {
  path: string | null;
  /** null when detached, unreadable, or there is no primary to read. */
  branch: string | null;
  /** null when `git status` could not run — never `false`, which would read as "measured clean". */
  dirty: boolean | null;
}

export async function probePrimaryCheckout(git: GitExec, cwd: string): Promise<PrimaryCheckoutState> {
  const primaryPath = await resolvePrimaryCheckout(git, cwd);
  if (!primaryPath) return { path: null, branch: null, dirty: null };
  const branch = await gitLine(git, ["rev-parse", "--abbrev-ref", "HEAD"], primaryPath);
  return {
    path: primaryPath,
    // A detached HEAD prints the literal "HEAD"; reading that as a branch name would let the
    // on-trunk check pass for a repository that is not on any branch at all.
    branch: branch === "HEAD" ? null : branch,
    dirty: await probeDirty(git, primaryPath),
  };
}

export interface ProbeLandDeps {
  git: GitExec;
  /** The delivering worktree. */
  worktreePath: string;
  /** Local trunk branch name, from `resolveTrunkRefs` — resolved once per sweep by the caller. */
  trunkRef: string | null;
  /** Resolved once per sweep too; absent means "probe it here" (the single-row and test paths). */
  primary?: PrimaryCheckoutState;
  /** From the classifier, so dirtiness and commit count have exactly one definition. */
  dirty: boolean;
  commits: number;
  readFile?: (file: string) => string;
}

/** Probe the per-delivery facts and compose. Read-only: every git call here is a query. */
export async function probeLandSuggestion(deps: ProbeLandDeps): Promise<LandSuggestion> {
  const { git, worktreePath, trunkRef } = deps;
  const head = await gitLine(git, ["rev-parse", "HEAD"], worktreePath);
  const branch = (await gitLine(git, ["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)) ?? "";
  const primary = deps.primary ?? (await probePrimaryCheckout(git, worktreePath));
  const record = head ? await readVerificationRecord(worktreePath, head, git, deps.readFile) : undefined;
  const trunkIsAncestorOfHead = trunkRef && head ? await isAncestor(git, worktreePath, trunkRef, head) : null;
  // SDD 498 D6 — read ONLY on the red path. This runs per row at a 3s poll (measured 13ms/row), and a
  // trunk that is an ancestor needs no "moved to what": the answer is only ever printed by the refusal.
  const trunkHead = trunkIsAncestorOfHead === false && trunkRef
    ? await gitLine(git, ["rev-parse", trunkRef], worktreePath)
    : null;

  return landSuggestion({
    head,
    branch,
    trunkRef,
    primaryPath: primary.path,
    dirty: deps.dirty,
    commits: deps.commits,
    verified: record ? { tree: record.tree, at: record.at } : null,
    trunkIsAncestorOfHead,
    trunkHead,
    primaryBranch: primary.branch,
    primaryDirty: primary.dirty,
  });
}

/** null when `git status` itself could not run — never `false`, which would read as "measured clean". */
async function probeDirty(git: GitExec, cwd: string): Promise<boolean | null> {
  try {
    const r = await git(["status", "--porcelain"], cwd);
    if (r.code !== 0) return null;
    return r.stdout.trim().length > 0;
  } catch {
    return null;
  }
}
