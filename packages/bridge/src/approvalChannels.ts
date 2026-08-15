import type { ApprovalResolutionChannel } from "@tachyon/engine/approvals/approvalRequest.js";
import { APPROVAL_CHANNEL_VSCODE_COMMAND } from "@tachyon/engine/engine-service/extensionOperationChannels.js";

export { APPROVAL_CHANNEL_VSCODE_COMMAND } from "@tachyon/engine/engine-service/extensionOperationChannels.js";

/**
 * t-86e59a — channel constants identify the transport entry point, never an actor.
 *
 * The `unattributed:` prefix is load-bearing: the host can observe which door received a resolution,
 * but none of the three measured doors can prove which person acted. Keep each value at the adapter
 * that owns its door; the approval use case accepts the domain vocabulary without owning a transport.
 */
export const APPROVAL_CHANNEL_COMPANION_HTTP = "unattributed:companion-http" satisfies ApprovalResolutionChannel;

/** Every value a resolution path may record. The guard test enumerates call sites against this. */
export const APPROVAL_RESOLUTION_CHANNELS = [
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  APPROVAL_CHANNEL_COMPANION_HTTP,
] as const;
