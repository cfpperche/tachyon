import type { CockpitModel } from "../../sections/model";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollWorktrees" as const;
export const WORKTREES_MODEL = "worktreesModel" as const;
export const WORKTREES_ERROR = "worktreesError" as const;

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
  | { type: "worktreeBatchCleanup"; items: Array<{ id: string; op: "remove" | "forget"; wsHash?: string }> };

export const pollWorktreesAction = (): WorktreesAction => ({ type: POLL });
export const worktreesModelMessage = (model: CockpitModel) => ({ type: WORKTREES_MODEL, model } as const);
export const worktreesErrorMessage = (message: string) => ({ type: WORKTREES_ERROR, message } as const);
