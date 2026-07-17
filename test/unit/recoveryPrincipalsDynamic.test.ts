import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessFencePort } from "../../src/agents/processFence.js";
import { DeliveryLeaseService, type DeliveryRecoveryInventory } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryCreateInput } from "../../src/delivery/types.js";

const roots: string[] = [];
const now = "2026-07-17T12:00:00.000Z";
const inventory: DeliveryRecoveryInventory = { headSha: "head", dirtyPaths: [], uniqueCommits: ["head"] };
const fence: ProcessFencePort = {
  capability: () => ({ supported: true, domain: "dynamic-principals-test" }),
  freeze: async () => undefined,
  terminate: async () => undefined,
  proveEmpty: async () => ({ state: "proven_empty" }),
};

function quarantinedDelivery(id: string, holder = "worker"): DeliveryCreateInput {
  return {
    id,
    workspaceId: "ws",
    createdBy: { kind: "agent", name: "creator" },
    contract: { baseSha: "base", behaviorTest: "cmd:test", owns: ["src"], taskRef: "t-dynamic-principals" },
    lease: {
      state: "quarantined",
      expectedHeadSha: "head",
      changedAt: now,
      reason: "dead holder",
      holder: { segmentId: `seg-${id}`, executionAgent: holder, executionNonce: `nonce-${id}` },
    },
    segments: [{
      id: `seg-${id}`,
      index: 0,
      role: "implementer",
      executionAgent: holder,
      grantedBy: { kind: "agent", name: "creator" },
      ownsSubset: ["src"],
      grantedHeadSha: "head",
      grantedAt: now,
    }],
    events: [],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dynamic recovery principals", () => {
  it("uses current principals while preserving untrusted-caller and holder denials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-principals-dynamic-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(worktree);
    const store = new DeliveryStore(root, { now: () => now });
    await store.create(quarantinedDelivery("d-authorized"));
    await store.create(quarantinedDelivery("d-untrusted"));
    await store.create(quarantinedDelivery("d-holder", "rescuer"));

    let config: { prunePrincipals: readonly string[] } | undefined;
    const lease = new DeliveryLeaseService({
      store,
      processFence: fence,
      recoveryPrincipals: () => config?.prunePrincipals ?? [],
      canonicalWorktreeFor: () => worktree,
      readHead: () => "head",
      inspectWorktree: () => ({ headSha: "head", clean: true }),
      inspectRecoveryWorktree: () => ({ inventory }),
      isAncestor: () => true,
      withWorktreeLock: async (_cwd, fn) => fn(),
      now: () => now,
      nonce: () => "reservation",
      segmentId: () => "seg-recovery",
      eventId: () => `event-${Math.random()}`,
    });

    config = { prunePrincipals: ["rescuer"] };
    await expect(lease.salvageQuarantine({
      deliveryId: "d-authorized", canonicalWorktree: worktree, actor: { kind: "agent", name: "rescuer" },
      operationId: "authorized", expectedHeadSha: "head", expectedInventory: inventory,
      executionAgent: "fixer", ownsSubset: ["src"],
    })).resolves.toMatchObject({ delivery: { lease: { state: "pending" } } });

    await expect(lease.salvageQuarantine({
      deliveryId: "d-untrusted", canonicalWorktree: worktree, actor: { kind: "agent", name: "peer" },
      operationId: "untrusted", expectedHeadSha: "head", expectedInventory: inventory,
      executionAgent: "fixer", ownsSubset: ["src"],
    })).rejects.toThrow("caller is not authorized to recover this Delivery");

    await expect(lease.salvageQuarantine({
      deliveryId: "d-holder", canonicalWorktree: worktree, actor: { kind: "agent", name: "rescuer" },
      operationId: "holder", expectedHeadSha: "head", expectedInventory: inventory,
      executionAgent: "fixer", ownsSubset: ["src"],
    })).rejects.toThrow("the lease holder cannot authorize its own recovery");
  });
});
