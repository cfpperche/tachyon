import type { CockpitModel } from "../../cockpit/model";
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
  | { type: "worktreeBatchCleanup"; items: Array<{ id: string; op: "remove" | "forget"; wsHash?: string }> };

export const pollWorktreesAction = (): WorktreesAction => ({ type: POLL });
export const worktreesModelMessage = (model: CockpitModel) => ({ type: WORKTREES_MODEL, model } as const);
export const worktreesErrorMessage = (message: string) => ({ type: WORKTREES_ERROR, message } as const);
