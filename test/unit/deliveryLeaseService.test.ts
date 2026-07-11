import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessFencePort } from "../../src/agents/processFence.js";
import { UnavailableProcessFence } from "../../src/agents/processFence.js";
import { DeliveryLeaseError, DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryCreateInput } from "../../src/delivery/types.js";

const now = "2026-07-11T14:00:00.000Z";
const actor = { kind: "agent" as const, name: "coordinator" };
const certifiedFence: ProcessFencePort = {
  capability: () => ({ supported: true, domain: "unit-test-complete-containment" }),
  freeze: async () => undefined,
  terminate: async () => undefined,
  proveEmpty: async () => ({ state: "proven_empty" }),
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-lease-"));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  const store = new DeliveryStore(root, { now: () => now });
  const input: DeliveryCreateInput = {
    id: "d-lease", workspaceId: "ws", createdBy: actor,
    contract: { baseSha: "a", behaviorTest: "behavior", owns: ["src"], taskRef: "task" },
    segments: [{
      id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
      ownsSubset: ["src"], grantedHeadSha: "a", grantedAt: now,
      releasedAt: now, releasedHeadSha: "b", outcome: "completed",
    }],
    events: [],
  };
  return { root, worktree, store, input };
}

function service(store: DeliveryStore, worktree: string, fence = certifiedFence) {
  let lockDepth = 0;
  return new DeliveryLeaseService({
    store, processFence: fence,
    canonicalWorktreeFor: () => worktree,
    readHead: () => "b",
    isAncestor: (older, newer) => older === "b" && newer === "b",
    withWorktreeLock: async (_path, fn) => { lockDepth += 1; try { return await fn(); } finally { lockDepth -= 1; } },
    now: () => now, nonce: () => "nonce", segmentId: () => "seg-1", eventId: () => `event-${lockDepth}`,
  });
}

describe("DeliveryLeaseService (SDD 368 T5)", () => {
  it("concurrent acquire grants one pending lease and returns retryable WORKTREE_OCCUPIED to the loser", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const firstService = service(store, worktree);
    const secondService = service(new DeliveryStore(store.workspaceRoot, { now: () => now }), worktree);
    const acquire = (lease: DeliveryLeaseService, agent: string, operationId: string) => lease.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: agent, grantedBy: actor, ownsSubset: ["src/feature"], operationId,
    });

    const results = await Promise.allSettled([
      acquire(firstService, "fixer-a", "acquire-a"),
      acquire(secondService, "fixer-b", "acquire-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    const delivery = await store.get("d-lease");
    expect(delivery?.lease.state).toBe("pending");
    expect(delivery?.segments).toHaveLength(2);
  });

  it("normalizes authority, pins HEAD and records durable process identity on confirmation", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const lease = service(store, worktree);
    const reserved = await lease.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor,
      ownsSubset: ["src/feature/", "./src/feature"], operationId: "reserve",
    });
    expect(reserved.delivery.segments[1]?.ownsSubset).toEqual(["src/feature"]);
    const held = await lease.confirmHeld("d-lease", "nonce", {
      pid: 42, processStart: "100", bootId: "boot",
    }, "confirm");
    expect(held.lease).toMatchObject({
      state: "held", holder: { executionAgent: "fixer", process: { pid: 42, processStart: "100", bootId: "boot" } },
    });
  });

  it("fails closed before mutation when the production fence capability is unavailable", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const lease = service(store, worktree, new UnavailableProcessFence());
    const error = await lease.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "blocked",
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(DeliveryLeaseError);
    expect(error).toMatchObject({ code: "DELIVERY_LEASE_UNAVAILABLE", retryable: false });
    expect((await store.get("d-lease"))?.lease.state).toBe("free");
  });

  it("refuses scope widening, HEAD drift, non-linear ancestry and non-canonical worktrees without mutation", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const base = {
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer" as const, executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "x",
    };
    await expect(service(store, worktree).acquire({ ...base, ownsSubset: ["test"] }))
      .rejects.toMatchObject({ code: "DELIVERY_OWNS_WIDENING" });
    await expect(service(store, worktree).acquire({ ...base, expectedHeadSha: "other" }))
      .rejects.toMatchObject({ code: "DELIVERY_HEAD_CHANGED" });
    await expect(service(store, worktree).acquire({ ...base, canonicalWorktree: path.join(worktree, "other") }))
      .rejects.toMatchObject({ code: "DELIVERY_WORKTREE_MISMATCH" });
    const nonLinear = new DeliveryLeaseService({
      store, processFence: certifiedFence, canonicalWorktreeFor: () => worktree, readHead: () => "b",
      isAncestor: () => false, withWorktreeLock: async (_path, fn) => fn(), now: () => now,
    });
    await expect(nonLinear.acquire(base)).rejects.toMatchObject({ code: "DELIVERY_NON_LINEAR_HEAD" });
    expect((await store.get("d-lease"))?.lease.state).toBe("free");
  });
});
