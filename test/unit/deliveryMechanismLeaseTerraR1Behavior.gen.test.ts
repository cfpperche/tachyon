import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { ProcessFencePort } from "../../src/agents/processFence.js";

describe("container-generated delegation behavior", () => {
  it("mechanism-only lease policy never impersonates proven_empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-mechanism-only-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const store = new DeliveryStore(root, { now: () => "2026-07-12T00:00:00.000Z" });
    const actor = { kind: "agent" as const, name: "coordinator" };
    await store.create({ id: "d-mechanism", workspaceId: "ws", createdBy: actor,
      contract: { baseSha: "a", behaviorTest: "behavior", owns: ["src"], taskRef: "task" },
      segments: [{ id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: "2026-07-12T00:00:00.000Z" }],
      lease: { state: "held", holder: { segmentId: "seg-0", executionAgent: "worker", executionNonce: "execution-0", process: { pid: 7, processStart: "1", bootId: "boot" } }, expectedHeadSha: "b", changedAt: "2026-07-12T00:00:00.000Z" }, events: [] });
    const fence: ProcessFencePort = { capability: vi.fn(() => ({ supported: false as const, reason: "unavailable" })), freeze: vi.fn(), terminate: vi.fn(), proveEmpty: vi.fn() };
    const stop = vi.fn();
    // Pre-gone exact identity is valid absence; stopper must not run and ProcessFence must stay idle.
    const lease = new DeliveryLeaseService({ store, processFence: fence, handoffSafety: "mechanism-only",
      exactExecutionStopper: { stop }, processObserver: { observe: () => ({ state: "gone" }) }, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), nonce: () => "reservation", segmentId: () => "seg-1" });

    const result = await lease.handoff({ deliveryId: "d-mechanism", canonicalWorktree: worktree, expectedFinalHeadSha: "b", role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: "handoff" });

    expect(stop).not.toHaveBeenCalled();
    expect(fence.capability).not.toHaveBeenCalled();
    expect(fence.proveEmpty).not.toHaveBeenCalled();
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
  ])("mechanism-only %s transfer failure quarantines without ProcessFence effects", async (label, config) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-mechanism-failure-"));
    const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
    const store = new DeliveryStore(root);
    const actor = { kind: "agent" as const, name: "coordinator" };
    await store.create({ id: "d-failure", workspaceId: "ws", createdBy: actor, contract: { baseSha: "a", behaviorTest: "b", owns: ["src"], taskRef: "task" },
      segments: [{ id: "seg", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor, ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: "now" }],
      lease: { state: "held", holder: { segmentId: "seg", executionAgent: "worker", executionNonce: "exec", process: { pid: 7, processStart: "1", bootId: "boot" } }, expectedHeadSha: "b", changedAt: "now" }, events: [] });
    const fence: ProcessFencePort = { capability: vi.fn(() => ({ supported: false as const, reason: "unused" })), freeze: vi.fn(), terminate: vi.fn(), proveEmpty: vi.fn() };
    const stop = vi.fn(async () => { if ("stopThrows" in config && config.stopThrows) throw new Error("stop failed"); });
    let observationIndex = 0;
    const observe = vi.fn(() => {
      const next = config.sequence[observationIndex++] ?? { state: "gone" };
      return next as never;
    });
    const lease = new DeliveryLeaseService({ store, processFence: fence, handoffSafety: "mechanism-only", ...(config.hasStopper ? { exactExecutionStopper: { stop } } : {}),
      ...("omitObserver" in config && config.omitObserver ? {} : { processObserver: { observe } }), canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true, withWorktreeLock: async (_path, fn) => fn() });
    await expect(lease.handoff({ deliveryId: "d-failure", canonicalWorktree: worktree, expectedFinalHeadSha: "b", role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: `failure-${label.replace(/\s+/g, "-")}` }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-failure"))?.lease.state).toBe("quarantined");
    expect(fence.capability).not.toHaveBeenCalled(); expect(fence.freeze).not.toHaveBeenCalled(); expect(fence.terminate).not.toHaveBeenCalled(); expect(fence.proveEmpty).not.toHaveBeenCalled();
  });
});
