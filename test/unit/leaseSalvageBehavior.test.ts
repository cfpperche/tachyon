import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessFencePort } from "../../src/agents/processFence.js";
import { DeliveryLeaseService, type DeliveryRecoveryInventory } from "../../src/delivery/leaseService.js";
import { DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryActor, DeliveryCreateInput } from "../../src/delivery/types.js";

const roots: string[] = [];
const now = "2026-07-16T12:00:00.000Z";
const coordinator: DeliveryActor = { kind: "agent", name: "coordinator" };
const inventory: DeliveryRecoveryInventory = { headSha: "head", dirtyPaths: [], uniqueCommits: ["head"] };

function fixture(principal?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lease-salvage-")); roots.push(root);
  const worktree = path.join(root, "worktree"); fs.mkdirSync(worktree);
  const store = new DeliveryStore(root, { now: () => now });
  const input: DeliveryCreateInput = {
    id: "d-salvage", workspaceId: "ws", createdBy: coordinator,
    contract: { baseSha: "base", behaviorTest: "cmd:test", owns: ["src"], taskRef: "t-salvage" },
    lease: { state: "held", expectedHeadSha: "head", changedAt: now, holder: { segmentId: "seg-worker", executionAgent: "worker",
      ...(principal ? { principal } : {}), executionNonce: "execution", process: { pid: 999_999, processStart: "1", bootId: "boot" } } },
    segments: [{ id: "seg-worker", index: 0, role: "implementer", executionAgent: "worker", principal: principal ?? "legacy-principal",
      grantedBy: coordinator, ownsSubset: ["src"], grantedHeadSha: "head", grantedAt: now }], events: [],
  };
  return { root, worktree, store, input };
}

function service(store: DeliveryStore, worktree: string, fence: ProcessFencePort) {
  return new DeliveryLeaseService({ store, processFence: fence, recoveryPrincipals: ["coordinator"],
    canonicalWorktreeFor: () => worktree, readHead: () => "head", inspectWorktree: () => ({ headSha: "head", clean: true }),
    inspectRecoveryWorktree: () => ({ inventory }), isAncestor: () => true, processObserver: { observe: () => ({ state: "gone" }) },
    resolveRecoveryApproval: (_id, actor, digest) => ({ decision: "approved", requester: actor.name!, actionDigest: digest, payloadHash: "payload", resolvedAt: now }),
    withWorktreeLock: async (_cwd, fn) => fn(), now: () => now, nonce: () => "reservation", segmentId: () => "seg-recovery", eventId: () => `event-${Math.random()}` });
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("delivery lease salvage flagship behavior", () => {
  it.each([undefined, "worker-principal"])("enters from a dead held legacy boundary (%s), then salvages Case A", async (principal) => {
    const f = fixture(principal); await f.store.create(f.input);
    const fence: ProcessFencePort = { capability: () => ({ supported: true, domain: "boot:boot" }), freeze: async () => {}, terminate: async () => {}, proveEmpty: async () => ({ state: "proven_empty" }) };
    const lease = service(f.store, f.worktree, fence);
    const quarantined = await lease.quarantineHeld({ deliveryId: "d-salvage", canonicalWorktree: f.worktree, actor: coordinator, operationId: "enter" });
    expect(quarantined.lease.state).toBe("quarantined");
    const salvaged = await lease.salvageQuarantine({ deliveryId: "d-salvage", canonicalWorktree: f.worktree, actor: coordinator,
      operationId: "salvage", expectedHeadSha: "head", expectedInventory: inventory, executionAgent: "fixer", ownsSubset: ["src"] });
    expect(salvaged.delivery.lease.state).toBe("pending");
    expect(salvaged.delivery.events.at(-1)?.detail?.evidenceLevel).toBe("fence-proof");
  });

  it("uses bound approval when the fence is unavailable and disposes Case B without worktree inspection", async () => {
    const f = fixture(); f.input.lease = { ...f.input.lease!, state: "quarantined", reason: "dead holder" }; await f.store.create(f.input);
    fs.rmSync(f.worktree, { recursive: true });
    const fence: ProcessFencePort = { capability: () => ({ supported: false, reason: "unavailable" }), freeze: async () => {}, terminate: async () => {}, proveEmpty: async () => ({ state: "unknown", reason: "unavailable" }) };
    const abandoned = await service(f.store, f.worktree, fence).abandonWithoutWorktree({ deliveryId: "d-salvage", actor: coordinator, operationId: "case-b", approvalId: "a-approved" });
    expect(abandoned.lease.state).toBe("abandoned");
    expect(abandoned.events.at(-1)?.detail).toMatchObject({ evidenceLevel: "approval-only", approvalId: "a-approved" });
  });

  it("kill completion makes a held lease quarantined, never free", async () => {
    const f = fixture(); await f.store.create(f.input);
    const fence: ProcessFencePort = { capability: () => ({ supported: false, reason: "unused" }), freeze: async () => {}, terminate: async () => {}, proveEmpty: async () => ({ state: "unknown", reason: "unused" }) };
    const changed = await service(f.store, f.worktree, fence).quarantineKilledExecution("worker");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.lease.state).toBe("quarantined");
    expect(changed[0]!.events.at(-1)?.type).toBe("held_killed_quarantined");
  });

  it.each(["alive", "unknown"] as const)("never enters salvage while the holder is %s", async (state) => {
    const f = fixture(); await f.store.create(f.input);
    const fence: ProcessFencePort = { capability: () => ({ supported: false, reason: "unused" }), freeze: async () => {}, terminate: async () => {}, proveEmpty: async () => ({ state: "unknown", reason: "unused" }) };
    const lease = new DeliveryLeaseService({ store: f.store, processFence: fence, recoveryPrincipals: ["coordinator"],
      canonicalWorktreeFor: () => f.worktree, readHead: () => "head", inspectWorktree: () => ({ headSha: "head", clean: true }), isAncestor: () => true,
      processObserver: { observe: () => state === "alive" ? { state } : { state, reason: "ambiguous" } }, withWorktreeLock: async (_cwd, fn) => fn() });
    await expect(lease.quarantineHeld({ deliveryId: "d-salvage", canonicalWorktree: f.worktree, actor: coordinator, operationId: `refuse-${state}`, approvalId: "a" }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", detail: { next: { action: "delivery_salvage" } } });
    expect((await f.store.get("d-salvage"))!.lease.state).toBe("held");
  });
});
