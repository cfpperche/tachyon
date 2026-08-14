import type { ApprovalViewModel } from "@tachyon/webview-ui/webview/approval/viewModel";
import type { Fixture } from "../routes";

export const approvalFixtures: Record<string, Fixture<ApprovalViewModel>> = {
  pending: {
    provenance: "synthetic-edge",
    vm: {
      folder: "tachyon",
      wsHash: "preview",
      approvals: [
        {
          id: "a-123abc",
          requester: "cxApproval2",
          session: "tachyon-preview-cxApproval2",
          createdAt: "2026-07-09T00:00:00.000Z",
          tampered: false,
          payload: {
            reason: "Need host authorization for a guarded action.",
            proposedAction: "Run the requested command after human approval.",
            risk: "The action changes local workspace state.",
            exactPrompt: "<b>Approve?</b>\nThis must render as text, not HTML.",
          },
        },
        {
          id: "a-bad999",
          requester: "agent",
          session: "tachyon-preview-agent",
          createdAt: "2026-07-09T00:01:00.000Z",
          tampered: true,
          warning: "approval record 'a-bad999' is corrupt - payloadHash no longer matches the child-authored payload",
          payload: {
            reason: "Tampered reason",
            proposedAction: "Blocked action",
            risk: "Unknown",
            exactPrompt: "Do not enable controls.",
          },
        },
      ],
    },
  },
};
