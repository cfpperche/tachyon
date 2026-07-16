import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("mechanism-only lease service preserves review completion semantics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-b2-lifecycle-"));
    const worktree = path.join(root, "one-worktree"); fs.mkdirSync(worktree);
    const store = new DeliveryStore(root, { now: () => "2026-07-12T00:00:00.000Z" });
    await store.create({
      id: "d-lifecycle", workspaceId: "ws", createdBy: { kind: "agent", name: "coordinator" },
      gitDeliveryId: "g-lifecycle", contract: { baseSha: "base", taskRef: "task", behaviorTest: "lifecycle", owns: ["src"] },
      lease: { state: "held", holder: { segmentId: "implement", executionAgent: "implementer", executionNonce: "n-implement", process: { pid: 11, processStart: "11", bootId: "boot" } }, expectedHeadSha: "base", changedAt: "2026-07-12T00:00:00.000Z" },
      segments: [{ id: "implement", index: 0, role: "implementer", executionAgent: "implementer", grantedBy: { kind: "agent", name: "coordinator" }, ownsSubset: ["src"], grantedHeadSha: "base", grantedAt: "2026-07-12T00:00:00.000Z" }],
    });
    const stopped: string[] = [];
    let nonce = 0;
    // Each transfer starts with a live root (stop once) then post-observe gone — preserves
    // sequential stop bookkeeping while remaining honest about the pre-observe algorithm.
    const liveThenGone = new Map<string, number>();
    const lease = new DeliveryLeaseService({
      store,
      exactExecutionStopper: { stop: async (input) => { stopped.push(input.executionAgent); } },
      processObserver: { observe: (identity) => {
        const key = `${identity.pid}:${identity.processStart}:${identity.bootId}`;
        const count = (liveThenGone.get(key) ?? 0) + 1;
        liveThenGone.set(key, count);
        return count === 1 ? { state: "alive" as const } : { state: "gone" as const };
      } }, canonicalWorktreeFor: (delivery) => { expect(delivery.gitDeliveryId).toBe("g-lifecycle"); return fs.realpathSync(worktree); },
      readHead: () => "base", inspectWorktree: () => ({ headSha: "base", clean: true }),
      inspectReviewWorktree: () => ({ headSha: "base", taskRefSha: "base", indexTreeSha: "tree", commitTreeSha: "tree", trackedClean: true }),
      isAncestor: () => true, withWorktreeLock: async (cwd, fn) => { expect(cwd).toBe(fs.realpathSync(worktree)); return fn(); },
      nonce: () => `nonce-${++nonce}`, segmentId: () => `seg-${nonce}`,
    });
    const handoff = await lease.handoff({ deliveryId: "d-lifecycle", canonicalWorktree: worktree, expectedFinalHeadSha: "base", role: "reviewer", executionAgent: "reviewer-1", ownsSubset: [], grantedBy: { kind: "agent", name: "coordinator" }, operationId: "review-1" });
    await lease.confirmHeld("d-lifecycle", handoff.reservationNonce, { pid: 12, processStart: "12", bootId: "boot" }, "review-1-confirm");
    const findings = await lease.completeReview({ deliveryId: "d-lifecycle", canonicalWorktree: worktree, expectedReviewedHeadSha: "base", verdict: "FINDINGS", actor: { kind: "agent", name: "coordinator" }, operationId: "findings" });
    expect(findings.lease.state).toBe("free");
    const fixer = await lease.acquire({ deliveryId: "d-lifecycle", canonicalWorktree: worktree, expectedHeadSha: "base", role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: { kind: "agent", name: "coordinator" }, operationId: "fix" });
    await lease.confirmHeld("d-lifecycle", fixer.reservationNonce, { pid: 13, processStart: "13", bootId: "boot" }, "fix-confirm");
    const second = await lease.handoff({ deliveryId: "d-lifecycle", canonicalWorktree: worktree, expectedFinalHeadSha: "base", role: "reviewer", executionAgent: "reviewer-2", ownsSubset: [], grantedBy: { kind: "agent", name: "coordinator" }, operationId: "review-2" });
    await lease.confirmHeld("d-lifecycle", second.reservationNonce, { pid: 14, processStart: "14", bootId: "boot" }, "review-2-confirm");
    const accepted = await lease.completeReview({ deliveryId: "d-lifecycle", canonicalWorktree: worktree, expectedReviewedHeadSha: "base", verdict: "ACCEPT", actor: { kind: "agent", name: "coordinator" }, operationId: "accept" });
    expect(accepted.lease.state).toBe("free");
    expect(stopped).toEqual(["implementer", "reviewer-1", "fixer", "reviewer-2"]);
    expect(fs.realpathSync(worktree)).toBe(fs.realpathSync(worktree));
  });
});
