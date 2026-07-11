import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

function heldFixture() {
  const result = fixture();
  result.input.segments![0] = { ...result.input.segments![0]!, releasedAt: undefined, releasedHeadSha: undefined, outcome: undefined };
  result.input.lease = { state: "held", holder: { segmentId: "seg-0", executionAgent: "worker",
    process: { pid: 7, processStart: "10", bootId: "boot" }, executionNonce: "exec-0" }, expectedHeadSha: "b", changedAt: now };
  return result;
}

function handoffInput(worktree: string, operationId = "handoff") {
  return { deliveryId: "d-lease", canonicalWorktree: worktree, expectedFinalHeadSha: "b", role: "fixer" as const,
    executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId };
}

function service(store: DeliveryStore, worktree: string, fence = certifiedFence) {
  let lockDepth = 0;
  let events = 0;
  return new DeliveryLeaseService({
    store, processFence: fence,
    canonicalWorktreeFor: () => worktree,
    readHead: () => "b",
    inspectWorktree: () => ({ headSha: "b", clean: true }),
    isAncestor: (older, newer) => (older === "a" || older === "b") && newer === "b",
    withWorktreeLock: async (_path, fn) => { lockDepth += 1; try { return await fn(); } finally { lockDepth -= 1; } },
    now: () => now, nonce: () => "nonce", segmentId: () => "seg-1", eventId: () => `event-${++events}`,
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
    const retriedReservation = await lease.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor,
      ownsSubset: ["./src/feature", "src/feature/"], operationId: "reserve",
    });
    expect(retriedReservation).toEqual(reserved);
    expect(reserved.delivery.segments[1]?.ownsSubset).toEqual(["src/feature"]);
    const held = await lease.confirmHeld("d-lease", "nonce", {
      pid: 42, processStart: "100", bootId: "boot",
    }, "confirm");
    expect(await lease.confirmHeld("d-lease", "nonce", {
      pid: 42, processStart: "100", bootId: "boot",
    }, "confirm")).toEqual(held);
    expect(held.lease).toMatchObject({
      state: "held", holder: { executionAgent: "fixer", executionNonce: "nonce", process: { pid: 42, processStart: "100", bootId: "boot" } },
    });
    expect(held.lease.holder).not.toHaveProperty("reservationNonce");
  });

  it("hands a held lease to one pending successor and fences outside both locks", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    let lockDepth = 0;
    const calls: string[] = [];
    const fence: ProcessFencePort = {
      capability: () => ({ supported: true, domain: "test" }),
      freeze: async () => { expect(lockDepth).toBe(0); calls.push("freeze"); },
      terminate: async () => { expect(lockDepth).toBe(0); calls.push("terminate"); },
      proveEmpty: async () => { expect(lockDepth).toBe(0); calls.push("proveEmpty"); return { state: "proven_empty" }; },
    };
    const lease = new DeliveryLeaseService({
      store, processFence: fence, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => { lockDepth++; try { return await fn(); } finally { lockDepth--; } },
      now: () => now, nonce: () => "next-nonce", segmentId: () => "seg-1", eventId: () => `event-${calls.length}`,
    });
    const result = await lease.handoff({ deliveryId: "d-lease", canonicalWorktree: worktree, expectedFinalHeadSha: "b",
      role: "fixer", executionAgent: "fixer", ownsSubset: ["src/feature"], grantedBy: actor, operationId: "handoff" });
    expect(calls).toEqual(["freeze", "terminate", "proveEmpty"]);
    expect(result.reservationNonce).toBe("next-nonce");
    expect(result.delivery.lease).toMatchObject({ state: "pending", holder: { segmentId: "seg-1", reservationNonce: "next-nonce" } });
    expect(result.delivery.segments).toHaveLength(2);
    expect(result.delivery.segments[0]).toMatchObject({ releasedHeadSha: "b", outcome: "completed" });
    expect(await lease.handoff({ deliveryId: "d-lease", canonicalWorktree: worktree, expectedFinalHeadSha: "b",
      role: "fixer", executionAgent: "fixer", ownsSubset: ["src/feature"], grantedBy: actor, operationId: "handoff" })).toEqual(result);
    expect(calls).toHaveLength(3);
  });

  it("quarantines survivors without appending a successor", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const fence: ProcessFencePort = { ...certifiedFence, proveEmpty: async () => ({ state: "survivors", pids: [7] }) };
    const lease = new DeliveryLeaseService({ store, processFence: fence, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), now: () => now });
    await expect(lease.handoff({ deliveryId: "d-lease", canonicalWorktree: worktree, expectedFinalHeadSha: "b",
      role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: "survivor" }))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED", retryable: false });
    const delivery = await store.get("d-lease");
    expect(delivery?.lease.state).toBe("quarantined");
    expect(delivery?.segments).toHaveLength(1);
  });

  it("unavailable handoff mutates nothing and invokes no fence operation", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const calls: string[] = [];
    const fence: ProcessFencePort = { capability: () => ({ supported: false, reason: "no proof" }),
      freeze: async () => { calls.push("freeze"); }, terminate: async () => { calls.push("terminate"); },
      proveEmpty: async () => { calls.push("proveEmpty"); return { state: "proven_empty" }; } };
    await expect(service(store, worktree, fence).handoff(handoffInput(worktree, "unavailable")))
      .rejects.toMatchObject({ code: "DELIVERY_LEASE_UNAVAILABLE" });
    expect(calls).toEqual([]);
    expect((await store.get("d-lease"))?.lease.state).toBe("held");
  });

  it.each(["unknown", "freeze", "terminate"] as const)("quarantines a %s fence outcome even when proof is empty", async (failure) => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const fence: ProcessFencePort = { capability: () => ({ supported: true, domain: "test" }),
      freeze: async () => { if (failure === "freeze") throw new Error("freeze failed"); },
      terminate: async () => { if (failure === "terminate") throw new Error("terminate failed"); },
      proveEmpty: async () => failure === "unknown" ? { state: "unknown", reason: "uncertain" } : { state: "proven_empty" } };
    await expect(service(store, worktree, fence).handoff(handoffInput(worktree, `fence-${failure}`)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-lease"))?.lease.state).toBe("quarantined");
  });

  it.each(["dirty", "head"] as const)("quarantines post-fence %s drift", async (failure) => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    let inspections = 0;
    const lease = new DeliveryLeaseService({ store, processFence: certifiedFence, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => (++inspections === 1 ? { headSha: "b", clean: true }
        : failure === "dirty" ? { headSha: "b", clean: false } : { headSha: "c", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), now: () => now });
    await expect(lease.handoff(handoffInput(worktree, `drift-${failure}`))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-lease"))?.lease.state).toBe("quarantined");
  });

  it("allows at most one concurrent draining/reservation path", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const results = await Promise.allSettled([
      service(store, worktree).handoff(handoffInput(worktree, "race-a")),
      service(new DeliveryStore(store.workspaceRoot, { now: () => now }), worktree).handoff(handoffInput(worktree, "race-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason)
      .toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect((await store.get("d-lease"))?.segments).toHaveLength(2);
  });

  it("returns retryable WORKTREE_OCCUPIED to a contender starting after draining is durable", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    let announceDrain!: () => void;
    const draining = new Promise<void>((resolve) => { announceDrain = resolve; });
    let allowProof!: () => void;
    const proofAllowed = new Promise<void>((resolve) => { allowProof = resolve; });
    const fence: ProcessFencePort = { ...certifiedFence, proveEmpty: async () => {
      announceDrain(); await proofAllowed; return { state: "proven_empty" };
    } };
    const winner = service(store, worktree, fence).handoff(handoffInput(worktree, "durable-winner"));
    await draining;
    expect((await store.get("d-lease"))?.lease.state).toBe("draining");
    await expect(service(new DeliveryStore(store.workspaceRoot, { now: () => now }), worktree)
      .handoff(handoffInput(worktree, "durable-contender")))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    allowProof();
    await expect(winner).resolves.toMatchObject({ delivery: { lease: { state: "pending" } } });
  });

  it("never reserves a successor when the full predecessor holder changes during proveEmpty", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const fence: ProcessFencePort = { ...certifiedFence, proveEmpty: async () => {
      const draining = await store.get("d-lease");
      await store.update("d-lease", draining!.version, (record) => {
        record.lease.holder = { ...record.lease.holder!, executionAgent: "mutated-worker",
          process: { pid: 99, processStart: "changed", bootId: "other" } };
        return record;
      });
      return { state: "proven_empty" };
    } };
    const error = await service(store, worktree, fence).handoff(handoffInput(worktree, "holder-mutation")).catch((caught) => caught);
    expect(error instanceof AggregateError || error?.code === "DELIVERY_QUARANTINED").toBe(true);
    const delivery = await store.get("d-lease");
    expect(delivery?.segments).toHaveLength(1);
    expect(delivery?.lease.state).not.toBe("pending");
  });

  it("refuses invalid scope, path, state, and process identity before fencing", async () => {
    for (const kind of ["scope", "path", "state", "process"] as const) {
      const { store, worktree, input } = heldFixture();
      if (kind === "state") input.lease = { state: "free", changedAt: now };
      if (kind === "process") delete input.lease!.holder!.process;
      await store.create(input);
      let fenceCalls = 0;
      const fence: ProcessFencePort = { ...certifiedFence, freeze: async () => { fenceCalls++; }, terminate: async () => { fenceCalls++; },
        proveEmpty: async () => { fenceCalls++; return { state: "proven_empty" }; } };
      const request = handoffInput(kind === "path" ? path.join(worktree, "other") : worktree, `invalid-${kind}`);
      if (kind === "scope") request.ownsSubset = ["test"];
      await expect(service(store, worktree, fence).handoff(request)).rejects.toBeInstanceOf(DeliveryLeaseError);
      expect(fenceCalls).toBe(0);
    }
  });

  it("surfaces uncertain quarantine as AggregateError and retries from the durable drain receipt", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    let proveEmpty = false;
    let fenceCalls = 0;
    const fence: ProcessFencePort = { capability: () => ({ supported: true, domain: "test" }),
      freeze: async () => { fenceCalls++; }, terminate: async () => { fenceCalls++; },
      proveEmpty: async () => { fenceCalls++; return proveEmpty ? { state: "proven_empty" } : { state: "survivors", pids: [7] }; } };
    const lease = service(store, worktree, fence);
    const originalUpdate = store.update.bind(store);
    store.update = async (id, expectedVersion, mutate, options = {}) => {
      if (options.operationId === "resume:quarantine") throw new Error("quarantine storage unavailable");
      return originalUpdate(id, expectedVersion, mutate, options);
    };
    await expect(lease.handoff(handoffInput(worktree, "resume"))).rejects.toBeInstanceOf(AggregateError);
    expect((await store.get("d-lease"))?.lease.state).toBe("draining");

    store.update = originalUpdate;
    proveEmpty = true;
    const resumed = await lease.handoff(handoffInput(worktree, "resume"));
    expect(resumed.delivery.lease.state).toBe("pending");
    expect(resumed.delivery.segments).toHaveLength(2);
    expect(fenceCalls).toBe(6);
  });

  it("failPending requires the exact nonce and is receipt-idempotent", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const lease = service(store, worktree);
    await lease.acquire({ deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree, role: "fixer",
      executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "reserve-fail" });
    await expect(lease.failPending("d-lease", "wrong", "spawn failed", "fail-wrong")).rejects.toMatchObject({ code: "WORKTREE_OCCUPIED" });
    const failed = await lease.failPending("d-lease", "nonce", "spawn failed", "fail-right");
    expect(await lease.failPending("d-lease", "nonce", "spawn failed", "fail-right")).toEqual(failed);
    expect(failed.lease).toMatchObject({ state: "quarantined", reason: "spawn failed", holder: { reservationNonce: "nonce" } });
  });

  it("translates a real SQLite BEGIN IMMEDIATE collision into retryable WORKTREE_OCCUPIED", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const blocker = new DatabaseSync(store.databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const error = await service(store, worktree).acquire({
        deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
        role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "busy",
      }).catch((caught) => caught);
      expect(error).toBeInstanceOf(DeliveryLeaseError);
      expect(error).toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("concurrent confirmation grants held once and gives the CAS loser a structured retryable refusal", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const first = service(store, worktree);
    await first.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "reserve-race",
    });
    const second = service(new DeliveryStore(store.workspaceRoot, { now: () => now }), worktree);
    const process = { pid: 42, processStart: "100", bootId: "boot" };
    const results = await Promise.allSettled([
      first.confirmHeld("d-lease", "nonce", process, "confirm-a"),
      second.confirmHeld("d-lease", "nonce", process, "confirm-b"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect((await store.get("d-lease"))?.lease).toMatchObject({ state: "held", holder: { process } });
  });

  it("rechecks HEAD immediately before the Delivery CAS and refuses mid-acquire drift", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    let reads = 0;
    const lease = new DeliveryLeaseService({
      store, processFence: certifiedFence, canonicalWorktreeFor: () => worktree,
      readHead: () => (++reads === 1 ? "b" : "c"), inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), now: () => now,
    });
    await expect(lease.acquire({
      deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "drift",
    })).rejects.toMatchObject({ code: "DELIVERY_HEAD_CHANGED" });
    expect((await store.get("d-lease"))?.lease.state).toBe("free");
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
      inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => false, withWorktreeLock: async (_path, fn) => fn(), now: () => now,
    });
    await expect(nonLinear.acquire(base)).rejects.toMatchObject({ code: "DELIVERY_NON_LINEAR_HEAD" });
    expect((await store.get("d-lease"))?.lease.state).toBe("free");
  });
});
