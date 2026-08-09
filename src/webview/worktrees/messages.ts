import type { SectionsModel } from "../../sections/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollWorktrees" as const;
export const WORKTREES_MODEL = "worktreesModel" as const;
export const WORKTREES_ERROR = "worktreesError" as const;
/**
 * t-ea5425 — the host listed the changed files; the WEBVIEW picks one.
 *
 * Same shape the Activity share uses (`activity/messages.ts:74`): the host owns the candidate set
 * because only it can read git, the webview owns the chrome because the product's picker is ours, and
 * the host executes the choice. Nothing about the diff moves — VS Code's own diff editor stays the one
 * opener, reached from the one flow in the extension host.
 */
export const WORKTREE_REVIEW_FILES = "worktreeReviewFiles" as const;

/** One changed file, as the picker shows it. `status` is git's letter (A/M/D/R/C). */
export interface WorktreeReviewFile {
  path: string;
  status: string;
  /** Rename/copy origin, when the file arrived from somewhere else. */
  from?: string;
}

export interface WorktreeReviewFiles {
  /** The row the review belongs to — sent back with the choice. */
  id: string;
  /** What is being reviewed, in the human's words (the branch). */
  label: string;
  /** The two sides, already named by the host: no side is inferred in the webview. */
  base: string;
  current: string;
  files: WorktreeReviewFile[];
}

export const worktreeReviewFilesMessage = (review: WorktreeReviewFiles) =>
  ({ type: WORKTREE_REVIEW_FILES, review } as const);

export interface WorktreesStrings {
  worktreesTitle: string;
  worktreesHint: string;
  agent: string;
  change: string;
  branch: string;
  reveal: string;
  copyPath: string;
  noneListed: string;
  /**
   * t-7cb971 — the land block. Only the CHROME is localized: a check's `detail` and `fix` are the
   * engine's own sentences, carried through raw exactly as `classification.reasons` already are, so
   * the reason a human reads is the one the check produced rather than a translation of it that can
   * fall out of step with the code that decides.
   */
  landTitle: string;
  landIntro: string;
  landCommandLabel: string;
  landCopyCommand: string;
  landBlocked: string;
  landCheckWorktreeClean: string;
  landCheckVerifiedTree: string;
  landCheckFastForward: string;
  landCheckPrimaryOnTrunk: string;
  landCheckPrimaryClean: string;
  landFixLabel: string;
  landCommits: string;
  /**
   * SDD 501 — the two doors that were one room away from this decision. Both dispatch to commands that
   * already existed (spec 213/230 review, spec 223 PR); what is new here is only that they are offered
   * where the human is deciding. `landCompare` names the base, because a review at the land door reads
   * as evidence about what would land and must therefore say what it compared.
   */
  landReview: string;
  landPropose: string;
  /**
   * t-ea5425 — the in-webview file picker's own chrome. The candidate list is the host's; these three
   * lines are the surface's, and they are deliberately the SAME sentences the native quick pick used —
   * what changed is where the list is drawn, not what it says.
   */
  landReviewPickTitle: string;
  landReviewPickPlaceholder: string;
  landReviewPickEmpty: string;
  landCompare: string;
  landCompareBlocked: string;
  landCompareNoTrunk: string;
  wtAgentGone: string;
  wtAgentOwned: string;
  wtAlsoDeleteBranch: string;
  wtBlocked: string;
  wtCancel: string;
  wtClearSelection: string;
  wtConfirmBody: string;
  wtConfirmRun: string;
  wtConfirmTitle: string;
  wtEngineUnavailable: string;
  wtForgetRecord: string;
  /**
   * t-d29398 — the preserved-and-quarantined group and its one gesture. `Release lock` is the door the
   * refusal now names; the `wtInside*` strings are the facts it shows FIRST, because "release the
   * debris of a failed launch" and "release someone's unfinished work" are the same button until the
   * row says how many commits and whether the tree is dirty.
   */
  wtLockedTitle: string;
  wtLockedDesc: string;
  wtReleaseLock: string;
  wtInsideLabel: string;
  wtInsideClean: string;
  wtInsideDirty: string;
  wtInsideCommits: string;
  wtInsideUnknown: string;
  wtOccupiedBy: string;
  wtOccupiedDesc: string;
  wtOccupiedTitle: string;
  wtReadyDesc: string;
  wtReadyTitle: string;
  wtRecordDesc: string;
  wtRecordTitle: string;
  wtRemoveCheckout: string;
  wtReviewConfirm: string;
  wtReviewDesc: string;
  wtReviewTitle: string;
  wtSelectAll: string;
  wtSelected: string;
  wtShowAll: string;
}

export type WorktreesAction =
  | ReadyMessage
  | { type: typeof POLL }
  | { type: "revealPath"; path: string }
  | { type: "copyText"; text: string }
  | { type: "worktreeRemove"; id: string; deleteBranch?: boolean; wsHash?: string }
  | { type: "worktreeForgetRecord"; id: string; wsHash?: string }
  | { type: "worktreeReleaseLock"; id: string; wsHash?: string }
  /** SDD 501 — the host dispatches these to `tachyon.reviewWorktreeItem` / `tachyon.createWorktreePrItem`. */
  | { type: "worktreeReviewDiff"; id: string; wsHash?: string }
  /** t-ea5425 — the file the in-webview picker chose; the host opens its diff. */
  | { type: "worktreeOpenReviewFile"; id: string; path: string }
  | { type: "worktreeCreatePr"; id: string; wsHash?: string }
  | { type: "worktreeBatchCleanup"; items: Array<{ id: string; op: "remove" | "forget"; wsHash?: string }> };

export const pollWorktreesAction = (): WorktreesAction => ({ type: POLL });
export const worktreesModelMessage = (model: SectionsModel) => ({ type: WORKTREES_MODEL, model } as const);
export const worktreesErrorMessage = (message: string) => ({ type: WORKTREES_ERROR, message } as const);
