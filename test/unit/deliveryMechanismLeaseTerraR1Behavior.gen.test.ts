import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";

describe("container-generated delegation behavior", () => {
  it("the canonical lease policy records exact-root absence honestly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-mechanism-only-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const store = new DeliveryStore(root, { now: () => "2026-07-12T00:00:00.000Z" });
    const actor = { kind: "agent" as const, name: "coordinator" };
    await store.create({ id: "d-mechanism", workspaceId: "ws", createdBy: actor,
      contract: { baseSha: "a", behaviorTest: "behavior", owns: ["src"], taskRef: "task" },
      segments: [{ id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: "2026-07-12T00:00:00.000Z" }],
      lease: { state: "held", holder: { segmentId: "seg-0", executionAgent: "worker", executionNonce: "execution-0", process: { pid: 7, processStart: "1", bootId: "boot" } }, expectedHeadSha: "b", changedAt: "2026-07-12T00:00:00.000Z" }, events: [] });
    const stop = vi.fn();
    // Pre-gone exact identity is valid absence; the stopper must not run.
    const lease = new DeliveryLeaseService({ store,
      exactExecutionStopper: { stop }, processObserver: { observe: () => ({ state: "gone" }) }, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), nonce: () => "reservation", segmentId: () => "seg-1" });

    const result = await lease.handoff({ deliveryId: "d-mechanism", canonicalWorktree: worktree, expectedFinalHeadSha: "b", role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: "handoff" });

    expect(stop).not.toHaveBeenCalled();
    expect(result.delivery.events.at(-1)?.detail).toMatchObject({ handoffSafety: "mechanism-only", absenceEvidence: "root_gone_best_effort" });
    expect(result.delivery.lease.state).toBe("pending");
  });

  it.each([
    ["alive", { sequence: [{ state: "alive" }, { state: "alive" }], hasStopper: true }],
    ["unknown", { sequence: [{ state: "unknown", reason: "cannot inspect" }], hasStopper: true }],
    ["malformed", { sequence: [{ state: "invalid" }], hasStopper: true }],
    ["missing observer", { sequence: [], hasStopper: true, omitObserver: true }],
    ["stopper throw", { sequence: [{ state: "alive" }], hasStopper: true, stopThrows: true }],
    ["missing stopper", { sequence: [{ state: "alive" }], hasStopper: false }],
  ])("canonical %s transfer failure quarantines", async (label, config) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-mechanism-failure-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const store = new DeliveryStore(root);
    const actor = { kind: "agent" as const, name: "coordinator" };
    await store.create({ id: "d-failure", workspaceId: "ws", createdBy: actor, contract: { baseSha: "a", behaviorTest: "b", owns: ["src"], taskRef: "task" },
      segments: [{ id: "seg", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: "now" }],
      lease: { state: "held", holder: { segmentId: "seg", executionAgent: "worker", executionNonce: "exec", process: { pid: 7, processStart: "1", bootId: "boot" } }, expectedHeadSha: "b", changedAt: "now" }, events: [] });
    const stop = vi.fn(async () => { if ("stopThrows" in config && config.stopThrows) throw new Error("stop failed"); });
    let observationIndex = 0;
    const observe = vi.fn(() => {
      const next = config.sequence[observationIndex++] ?? { state: "gone" };
      return next as never;
    });
    const lease = new DeliveryLeaseService({ store, ...(config.hasStopper ? { exactExecutionStopper: { stop } } : {}),
      ...("omitObserver" in config && config.omitObserver ? {} : { processObserver: { observe } }), canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true, withWorktreeLock: async (_path, fn) => fn() });
    await expect(lease.handoff({ deliveryId: "d-failure", canonicalWorktree: worktree, expectedFinalHeadSha: "b", role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: `failure-${label.replace(/\s+/g, "-")}` }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-failure"))?.lease.state).toBe("quarantined");
  });
});
