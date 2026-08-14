import type { ApprovalResolutionChannel } from "../approvals/approvalRequest.js";

/** The engine-control adapter's approval entry point, supplied as data to the operation use case. */
export const APPROVAL_CHANNEL_VSCODE_COMMAND =
  "unattributed:vscode-command" satisfies ApprovalResolutionChannel;
