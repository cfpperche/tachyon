import type { ApprovalDecision } from "../../bridge/approvalRequest";
import type { ApprovalViewModel } from "./viewModel";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };

export const APPROVALS = "approvals" as const;
export const APPROVAL_ERROR = "approvalError" as const;

export interface ApprovalsMessage {
  type: typeof APPROVALS;
  vm: ApprovalViewModel;
}

export interface ApprovalErrorMessage {
  type: typeof APPROVAL_ERROR;
  id?: string;
  message: string;
}

export type ApprovalHostMessage = ApprovalsMessage | ApprovalErrorMessage;

export type ApprovalAction =
  | ReadyMessage
  | { type: "refresh" }
  | { type: "resolve"; id: string; decision: ApprovalDecision; wsHash: string };

export const approvalsMessage = (vm: ApprovalViewModel): ApprovalsMessage => ({ type: APPROVALS, vm });
export const approvalErrorMessage = (message: string, id?: string): ApprovalErrorMessage => ({ type: APPROVAL_ERROR, message, ...(id ? { id } : {}) });
export const refreshApprovalsAction = (): ApprovalAction => ({ type: "refresh" });
export const resolveApprovalAction = (id: string, decision: ApprovalDecision, wsHash: string): ApprovalAction => ({ type: "resolve", id, decision, wsHash });
