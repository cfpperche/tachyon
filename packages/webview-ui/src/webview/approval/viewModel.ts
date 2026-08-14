import type { ApprovalCancellation, ApprovalPayload, ApprovalResolution, ApprovalStatus } from "@tachyon/engine/bridge/approvalRequest.js";
export interface ApprovalViewItem {
  id: string;
  requester: string;
  session: string;
  createdAt: string;
  payload: ApprovalPayload;
  tampered: boolean;
  warning?: string;
  /** Production readers always set this; optional only for legacy preview/test fixtures. */
  status?: ApprovalStatus;
  resolution?: ApprovalResolution;
  cancellation?: ApprovalCancellation;
}

export interface ApprovalViewModel {
  folder: string;
  wsHash: string;
  approvals: ApprovalViewItem[];
}
