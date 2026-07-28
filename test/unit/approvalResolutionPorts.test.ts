import { describe, expect, it, vi } from "vitest";
import { approvalResolutionPorts } from "../../src/bridge/approvalResolutionPorts.js";

/**
 * t-a77fe6 — the two approval-resolution wirings shared byte-identical closures.
 *
 * `resolveApproval` was called from the editor path (`resolvedBy: "vscode"`) and the Companion path
 * (`resolvedBy: "companion"`), each building its own `currentSessionOwner` and `inject`. Identical
 * code in two places is a drift waiting to happen — and it already had, one rung over: the two
 * disagree about whether a failing pin completion is fatal.
 */
describe("t-a77fe6 — shared approval resolution ports", () => {
  const entries = [
    { session: "tachyon-h-ada", running: true, name: "ada" },
    { session: "tachyon-h-dead", running: false, name: "dead" },
  ];

  it("attributes a session to the agent currently running it", async () => {
    const ports = approvalResolutionPorts({ listEntries: async () => entries, sendSubmittedLine: async () => {} });

    expect(await ports.currentSessionOwner("tachyon-h-ada")).toBe("ada");
  });

  it("does not attribute a session whose entry is no longer running", async () => {
    // A stopped entry still holds the name; treating it as the owner would credit a decision to an
    // agent that is not there to have made it.
    const ports = approvalResolutionPorts({ listEntries: async () => entries, sendSubmittedLine: async () => {} });

    expect(await ports.currentSessionOwner("tachyon-h-dead")).toBeUndefined();
    expect(await ports.currentSessionOwner("tachyon-h-nobody")).toBeUndefined();
  });

  it("submits the line and returns the receipt naming where it landed", async () => {
    const sendSubmittedLine = vi.fn(async () => {});
    const ports = approvalResolutionPorts({ listEntries: async () => entries, sendSubmittedLine });

    expect(await ports.inject("tachyon-h-ada", "approved")).toEqual({ receipt: "tmux:tachyon-h-ada" });
    expect(sendSubmittedLine).toHaveBeenCalledWith("tachyon-h-ada", "approved");
  });

  it("carries no opinion about who resolved, or about pin failure", () => {
    // Both stay per-caller on purpose. `resolvedBy` is a different FACT on each path, and the two
    // paths disagree about whether a failing pin completion is fatal — settling that here would
    // change behaviour on one of them under cover of a deduplication.
    const ports = approvalResolutionPorts({ listEntries: async () => [], sendSubmittedLine: async () => {} });

    expect(Object.keys(ports).sort()).toEqual(["currentSessionOwner", "inject"]);
  });
});
