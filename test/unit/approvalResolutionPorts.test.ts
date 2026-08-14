import { describe, expect, it, vi } from "vitest";
import { approvalResolutionPorts } from "@tachyon/engine/bridge/approvalResolutionPorts.js";
import type { NoticeDeliveryResult } from "@tachyon/engine/bridge/tools.js";

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
  const notified: NoticeDeliveryResult = { status: "notified" };
  const ports = (deliverNotice: (agent: string, line: string) => Promise<NoticeDeliveryResult>) =>
    approvalResolutionPorts({ listEntries: async () => entries, deliverNotice });

  it("attributes a session to the agent currently running it", async () => {
    expect(await ports(async () => notified).currentSessionOwner("tachyon-h-ada")).toBe("ada");
  });

  it("does not attribute a session whose entry is no longer running", async () => {
    // A stopped entry still holds the name; treating it as the owner would credit a decision to an
    // agent that is not there to have made it.
    const p = ports(async () => notified);

    expect(await p.currentSessionOwner("tachyon-h-dead")).toBeUndefined();
    expect(await p.currentSessionOwner("tachyon-h-nobody")).toBeUndefined();
  });

  it("carries no opinion about who resolved, or about pin failure", () => {
    // Both stay per-caller on purpose. `resolvedBy` is a different FACT on each path, and the two
    // paths disagree about whether a failing pin completion is fatal — settling that here would
    // change behaviour on one of them under cover of a deduplication.
    expect(Object.keys(ports(async () => notified)).sort()).toEqual(["currentSessionOwner", "inject"]);
  });
});

/**
 * t-d79534 — the decision must actually WAKE the requester.
 *
 * The port used to call `sendSubmittedLine` and return `tmux:<session>` no matter what. A requester
 * waiting on its own escalation is busy by construction, so the line landed in an occupied composer,
 * never started a turn, and the record still claimed delivery. The agent stayed parked until a human
 * came and poked it.
 */
describe("t-d79534 — approval delivery goes through the notice queue", () => {
  const entries = [{ session: "tachyon-h-ada", running: true, name: "ada" }];
  const ports = (deliverNotice: (agent: string, line: string) => Promise<NoticeDeliveryResult>) =>
    approvalResolutionPorts({ listEntries: async () => entries, deliverNotice });

  it("delivers by AGENT, not by raw session write", async () => {
    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "notified" }));

    expect(await ports(deliverNotice).inject("tachyon-h-ada", "approved")).toEqual({ receipt: "tmux:tachyon-h-ada" });
    // Agent-addressed because the queue is: a session name has no queue to flush on idle.
    expect(deliverNotice).toHaveBeenCalledWith("ada", "approved");
  });

  it("queues for a busy requester instead of typing into its composer", async () => {
    // The regression case. `queued` means the notice queue holds the line and flushes it when the
    // requester goes idle — the wake-up survives the fact that it was mid-turn.
    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "queued", queued: 1 }));

    expect(await ports(deliverNotice).inject("tachyon-h-ada", "approved")).toEqual({ receipt: "queued:ada" });
  });

  it("reports an unconfirmed submission as an error rather than a receipt", async () => {
    const deliverNotice = async (): Promise<NoticeDeliveryResult> =>
      ({ status: "submit-unconfirmed", submitReason: "composer occupied" });

    const result = await ports(deliverNotice).inject("tachyon-h-ada", "approved");

    expect(result.receipt).toBeUndefined();
    expect(result.error).toContain("composer occupied");
  });

  it("refuses to claim delivery when no running agent owns the session", async () => {
    const deliverNotice = vi.fn(async (): Promise<NoticeDeliveryResult> => ({ status: "notified" }));

    const result = await ports(deliverNotice).inject("tachyon-h-gone", "approved");

    expect(result.receipt).toBeUndefined();
    expect(result.error).toContain("no running agent owns session");
    expect(deliverNotice).not.toHaveBeenCalled();
  });
});
