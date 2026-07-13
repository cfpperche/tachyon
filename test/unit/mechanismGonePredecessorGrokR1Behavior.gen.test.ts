import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryCreateInput } from "../../src/delivery/types.js";

/**
 * Canonical behavior gate for t-9d4605: mechanism-only handoff must treat an already-gone
 * exact predecessor as valid absence evidence and must not invoke the live-pane stopper.
 * (Dogfood 0.55.94: establishTransferAbsence used to call exactExecutionStopper first, and
 * panePid failed after a clean R1 exit, quarantining a reusable worktree.)
 */
describe("container-generated delegation behavior", () => {
  it("mechanism-only handoff accepts an already-gone exact predecessor without invoking stopper", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-gone-pred-"));
    try {
      const worktree = path.join(root, "worktree");
      fs.mkdirSync(worktree);
      const now = "2026-07-12T00:00:00.000Z";
      const actor = { kind: "agent" as const, name: "coordinator" };
      const store = new DeliveryStore(root, { now: () => now });
      const input: DeliveryCreateInput = {
        id: "d-gone-pred",
        workspaceId: "ws",
        createdBy: actor,
        contract: { baseSha: "a", behaviorTest: "gone predecessor", owns: ["src"], taskRef: "task" },
        segments: [{
          id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
          ownsSubset: ["src"], grantedHeadSha: "b", grantedAt: now,
        }],
        events: [],
        lease: {
          state: "held",
          holder: {
            segmentId: "seg-0",
            executionAgent: "worker",
            process: { pid: 4242, processStart: "100", bootId: "boot" },
            executionNonce: "exec-gone",
          },
          expectedHeadSha: "b",
          changedAt: now,
        },
      };
      await store.create(input);

      const stop = vi.fn(async () => {
        throw new Error("stopper must not run for an already-gone predecessor");
      });
      const observe = vi.fn(() => ({ state: "gone" as const }));
      const fence = {
        capability: vi.fn(() => ({ supported: false as const, reason: "unused" })),
        freeze: vi.fn(async () => { throw new Error("fence must not run"); }),
        terminate: vi.fn(async () => { throw new Error("fence must not run"); }),
        proveEmpty: vi.fn(async () => { throw new Error("fence must not run"); }),
      };

      const lease = new DeliveryLeaseService({
        store,
        processFence: fence,
        handoffSafety: "mechanism-only",
        exactExecutionStopper: { stop },
        processObserver: { observe },
        canonicalWorktreeFor: () => worktree,
        readHead: () => "b",
        inspectWorktree: () => ({ headSha: "b", clean: true }),
        isAncestor: () => true,
        withWorktreeLock: async (_path, fn) => fn(),
        now: () => now,
        nonce: () => "successor-nonce",
        segmentId: () => "seg-1",
      });

      const reserved = await lease.handoff({
        deliveryId: "d-gone-pred",
        canonicalWorktree: worktree,
        expectedFinalHeadSha: "b",
        role: "reviewer",
        executionAgent: "reviewer",
        ownsSubset: [],
        grantedBy: actor,
        operationId: "gone-predecessor-handoff",
      });

      expect(reserved.reservationNonce).toBe("successor-nonce");
      expect(reserved.delivery.lease.state).toBe("pending");
      expect(reserved.delivery.events.some((event) =>
        event.type === "handoff_reserved" && event.detail?.absenceEvidence === "root_gone_best_effort",
      )).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledWith({ pid: 4242, processStart: "100", bootId: "boot" });
      expect(fence.capability).not.toHaveBeenCalled();
      expect(fence.freeze).not.toHaveBeenCalled();
      expect(fence.terminate).not.toHaveBeenCalled();
      expect(fence.proveEmpty).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
