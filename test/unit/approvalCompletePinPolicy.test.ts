import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  APPROVAL_CHANNEL_COMPANION_HTTP,
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  buildApprovalRequest,
  readApprovalRequest,
  resolveApproval,
  writeApprovalRequest,
} from "../../src/bridge/approvalRequest.js";

/**
 * t-7a306a — completing the pin is a SECONDARY step, and both halves of that were wrong.
 *
 * Failing the call would tell a human their approval did not go through and invite them to retry a
 * decision already written to disk. Swallowing the failure whole — which is what happened, in both
 * channels — leaves the pin they were looking at open with nothing to say why.
 */
function pendingRequest(workspaceRoot: string, pinId?: string) {
  const request = {
    ...buildApprovalRequest({
      requester: "ada",
      session: "tachyon-h-ada",
      reason: "needs a human",
      proposedAction: "delete the guard",
      risk: "high",
      exactPrompt: "may I?",
      id: "a-abc123",
    }),
    ...(pinId ? { pinId } : {}),
  };
  writeApprovalRequest(workspaceRoot, request);
  return request;
}

const inject = async () => ({ receipt: "tmux:tachyon-h-ada" });

describe("t-7a306a — a failing pin completion never undoes the approval, and never goes quiet", () => {
  it("keeps the approval resolved when completePin throws", async () => {
    const workspaceRoot = makeTempDir("approval-pin-fail-");
    pendingRequest(workspaceRoot, "p-abc123");

    const result = await resolveApproval({
      workspaceRoot,
      id: "a-abc123",
      decision: "approved",
      resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND,
      inject,
      completePin: () => { throw new Error("pin store is read-only"); },
    });

    // The decision is the primary effect and it stands, in the returned record AND on disk.
    expect(result.request.status).toBe("resolved");
    expect(result.request.resolution?.decision).toBe("approved");
    expect(readApprovalRequest(workspaceRoot, "a-abc123").status).toBe("resolved");
  });

  it("reports the failure instead of discarding it", async () => {
    const workspaceRoot = makeTempDir("approval-pin-observable-");
    pendingRequest(workspaceRoot, "p-abc123");

    const result = await resolveApproval({
      workspaceRoot,
      id: "a-abc123",
      decision: "denied",
      resolvedBy: APPROVAL_CHANNEL_COMPANION_HTTP,
      inject,
      completePin: () => { throw new Error("pin store is read-only"); },
    });

    // Same shape `injectError` already uses for a secondary failure: it travels with the result.
    expect(result.pinError).toBe("pin store is read-only");
  });

  it("still completes the pin when it can, and says nothing when there is nothing to say", async () => {
    const workspaceRoot = makeTempDir("approval-pin-ok-");
    pendingRequest(workspaceRoot, "p-abc123");
    const completePin = vi.fn();

    const result = await resolveApproval({
      workspaceRoot, id: "a-abc123", decision: "approved", resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND, inject, completePin,
    });

    expect(completePin).toHaveBeenCalledWith("p-abc123", "approved");
    expect(result).not.toHaveProperty("pinError");
  });

  it("says nothing about a pin when the request never carried one", async () => {
    // Most requests have no pin at all; a `pinError` key there would invent a failure.
    const workspaceRoot = makeTempDir("approval-pin-none-");
    pendingRequest(workspaceRoot);
    const completePin = vi.fn(() => { throw new Error("never reached"); });

    const result = await resolveApproval({
      workspaceRoot, id: "a-abc123", decision: "approved", resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND, inject, completePin,
    });

    expect(completePin).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("pinError");
  });

  it("keeps the two secondary failures apart", async () => {
    // An inject failure and a pin failure are different facts about different steps; one field
    // carrying both would make a reader guess which happened.
    const workspaceRoot = makeTempDir("approval-pin-both-");
    pendingRequest(workspaceRoot, "p-abc123");

    const result = await resolveApproval({
      workspaceRoot,
      id: "a-abc123",
      decision: "approved",
      resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND,
      inject: async () => { throw new Error("session is gone"); },
      completePin: () => { throw new Error("pin store is read-only"); },
    });

    expect(result.injectError).toBe("session is gone");
    expect(result.pinError).toBe("pin store is read-only");
    expect(result.request.status).toBe("resolved");
  });
});
