import type { ApprovalResolutionChannel } from "../approvals/approvalRequest.js";

/**
 * t-86e59a — channel constants identify the transport entry point, never an actor.
 *
 * The `unattributed:` prefix is load-bearing: the host can observe which door received a resolution,
 * but none of the three measured doors can prove which person acted. Keep these values at their Bridge
 * adapters; the approval use case accepts the domain vocabulary without owning either transport door.
 */
export const APPROVAL_CHANNEL_VSCODE_COMMAND = "unattributed:vscode-command" satisfies ApprovalResolutionChannel;
export const APPROVAL_CHANNEL_COMPANION_HTTP = "unattributed:companion-http" satisfies ApprovalResolutionChannel;

/** Every value a resolution path may record. The guard test enumerates call sites against this. */
export const APPROVAL_RESOLUTION_CHANNELS = [
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  APPROVAL_CHANNEL_COMPANION_HTTP,
] as const;
