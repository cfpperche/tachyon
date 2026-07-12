import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ProcessFencePort } from "../../src/agents/processFence.js";
import { UnavailableProcessFence } from "../../src/agents/processFence.js";
import { DeliveryLeaseError, DeliveryLeaseService, waitForDeliveryLease } from "../../src/delivery/leaseService.js";
import { DeliveryStore, DeliveryStoreBusyError } from "../../src/delivery/store.js";
import type { Delivery, DeliveryCreateInput } from "../../src/delivery/types.js";

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
  result.input.segments![0] = { ...result.input.segments![0]!, grantedHeadSha: "b", releasedAt: undefined, releasedHeadSha: undefined, outcome: undefined };
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

function reviewFixture() {
  const result = fixture();
  result.input.segments![0] = { id: "seg-review", index: 0, role: "reviewer", executionAgent: "reviewer",
    principal: "review-principal", grantedBy: actor, ownsSubset: [], grantedHeadSha: "b", grantedAt: now };
  result.input.lease = { state: "held", holder: { segmentId: "seg-review", executionAgent: "reviewer", principal: "review-principal",
    process: { pid: 12, processStart: "20", bootId: "boot" }, executionNonce: "review-exec" }, expectedHeadSha: "b", changedAt: now };
  return result;
}

const cleanReviewInspection = { headSha: "b", taskRefSha: "b", indexTreeSha: "tree-b", commitTreeSha: "tree-b", trackedClean: true };

function reviewService(store: DeliveryStore, worktree: string, options: {
  fence?: ProcessFencePort;
  inspect?: () => typeof cleanReviewInspection;
  withLock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
} = {}) {
  let events = 0;
  return new DeliveryLeaseService({ store, processFence: options.fence ?? certifiedFence, canonicalWorktreeFor: () => worktree,
    readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }),
    inspectReviewWorktree: options.inspect ?? (() => cleanReviewInspection), isAncestor: () => true,
    withWorktreeLock: options.withLock ?? (async (_path, fn) => fn()), now: () => now,
    nonce: () => "review-nonce", segmentId: () => "seg-review", eventId: () => `review-event-${++events}` });
}

function completeReviewInput(worktree: string, verdict: "ACCEPT" | "FINDINGS" = "ACCEPT", operationId = "review-op") {
  return { deliveryId: "d-lease", canonicalWorktree: worktree, expectedReviewedHeadSha: "b", verdict, actor, operationId };
}

describe("DeliveryLeaseService (SDD 368 T5)", () => {
  it("treats a durable system verification lease as retryable occupancy", async () => {
    const { store, worktree, input } = fixture();
    input.lease = { state: "verifying", changedAt: now, verification: {
      nonce: "verification-nonce", ownerEpoch: "workspace-epoch", actor,
      subjectSegmentId: "seg-0", deliveredHeadSha: "b", startedAt: now,
      operationId: "verification-operation", priorLease: { state: "free", changedAt: now },
    } };
    await store.create(input);
    await expect(service(store, worktree).acquire({ deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "fixer", executionAgent: "fixer", grantedBy: actor, ownsSubset: ["src"], operationId: "contend-verification" }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true, detail: { state: "verifying" } });
  });

  it("wait_for_lease is bounded and cannot block an independent release", async () => {
    const { store, input } = heldFixture();
    await store.create(input);
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
    let sleepStarted!: () => void;
    const started = new Promise<void>((resolve) => { sleepStarted = resolve; });
    let clock = 0;
    const waiter = waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 100 }, {
      now: () => clock,
      pollMs: 10,
      sleep: async (ms) => { sleepStarted(); await sleeping; clock += ms; },
    });
    await started;
    const held = await store.get("d-lease");
    await store.update("d-lease", held!.version, (record) => {
      record.lease = { state: "free", changedAt: now };
      record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "b", outcome: "completed" };
      return record;
    });
    releaseSleep();
    const result = await waiter;
    expect(result).toMatchObject({ deliveryId: "d-lease", outcome: "released", state: "free" });
    expect(JSON.stringify(result)).not.toMatch(/holder|nonce|process|principal|reason/i);
  });

  it.each([
    ["free", "released"],
    ["quarantined", "quarantined"],
  ] as const)("returns immediate %s as %s without sleeping", async (state, outcome) => {
    const { store, input } = fixture();
    input.lease = state === "free" ? { state, changedAt: now } : { state, changedAt: now, reason: "secret evidence" };
    await store.create(input);
    const sleep = vi.fn(async () => undefined);
    await expect(waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 10 }, { now: () => 0, sleep, pollMs: 1 }))
      .resolves.toMatchObject({ outcome, state });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns disappeared immediately without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(waitForDeliveryLease({ get: async () => undefined }, { deliveryId: "missing", timeoutMs: 10 },
      { now: () => 0, sleep, pollMs: 1 })).resolves.toEqual({ deliveryId: "missing", outcome: "disappeared", waitedMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns changed immediately for an occupied version mismatch, including release/reacquire", async () => {
    const { store, input } = heldFixture();
    await store.create(input);
    const first = await store.get("d-lease");
    await store.update("d-lease", first!.version, (record) => {
      record.lease = { ...record.lease, changedAt: "release-and-reacquire", holder: { ...record.lease.holder!, executionAgent: "successor" } };
      return record;
    });
    await expect(waitForDeliveryLease(store, { deliveryId: "d-lease", afterVersion: first!.version, timeoutMs: 10 },
      { now: () => 0, sleep: async () => undefined, pollMs: 1 }))
      .resolves.toMatchObject({ outcome: "changed", version: first!.version + 1, state: "held", waitedMs: 0 });
  });

  it("caps the final sleep to the exact monotonic deadline and returns the last public observation", async () => {
    const { store, input } = heldFixture();
    await store.create(input);
    let clock = 0;
    const sleeps: number[] = [];
    const result = await waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 25 }, {
      now: () => clock,
      pollMs: 10,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    expect(sleeps).toEqual([10, 10, 5]);
    expect(result).toMatchObject({ outcome: "timeout", waitedMs: 25, state: "held", version: 1 });
  });

  it("retries transient store busy observations but surfaces other errors", async () => {
    const { store, input } = heldFixture();
    await store.create(input);
    const delivery = await store.get("d-lease") as Delivery;
    let reads = 0;
    let clock = 0;
    const result = await waitForDeliveryLease({ get: async () => {
      if (++reads < 3) throw new DeliveryStoreBusyError("busy.sqlite");
      return { ...delivery, lease: { state: "free", changedAt: now } };
    } }, { deliveryId: delivery.id, timeoutMs: 20 }, {
      now: () => clock, pollMs: 5, sleep: async (ms) => { clock += ms; },
    });
    expect(result).toMatchObject({ outcome: "released", waitedMs: 10 });
    const corruption = new Error("corrupt record");
    await expect(waitForDeliveryLease({ get: async () => { throw corruption; } },
      { deliveryId: delivery.id, timeoutMs: 20 })).rejects.toBe(corruption);
  });

  it("aborts a production sleep with exact timer/listener cleanup and no later reads", async () => {
    vi.useFakeTimers();
    try {
      const { store, input } = heldFixture();
      await store.create(input);
      const get = vi.spyOn(store, "get");
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const waiting = waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 1_000 }, undefined, controller.signal);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an abort between the sleep precheck and listener registration", async () => {
    vi.useFakeTimers();
    try {
      const { store, input } = heldFixture();
      await store.create(input);
      const get = vi.spyOn(store, "get");
      const controller = new AbortController();
      const add = controller.signal.addEventListener.bind(controller.signal);
      vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
        controller.abort();
        add(type, listener, options);
      });

      const waiting = waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 1_000 }, undefined, controller.signal);
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the AbortSignal to injected sleeps and checks abort before another read", async () => {
    const { store, input } = heldFixture();
    await store.create(input);
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => { expect(signal).toBe(controller.signal); controller.abort(); });
    const get = vi.spyOn(store, "get");
    await expect(waitForDeliveryLease(store, { deliveryId: "d-lease", timeoutMs: 10 },
      { now: () => 0, pollMs: 1, sleep }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid timeout and afterVersion values", async () => {
    const store = { get: async () => undefined };
    await expect(waitForDeliveryLease(store, { deliveryId: "d", timeoutMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(waitForDeliveryLease(store, { deliveryId: "d", timeoutMs: 300_001 })).rejects.toBeInstanceOf(RangeError);
    await expect(waitForDeliveryLease(store, { deliveryId: "d", timeoutMs: 1, afterVersion: -1 })).rejects.toBeInstanceOf(RangeError);
  });

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

  it("requires empty reviewer authority and pins a clean reviewer grant", async () => {
    const { store, worktree, input } = fixture();
    await store.create(input);
    const lease = reviewService(store, worktree);
    const base = { deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree, role: "reviewer" as const,
      executionAgent: "reviewer", grantedBy: actor, operationId: "review-grant" };
    await expect(lease.acquire({ ...base, ownsSubset: ["src"] })).rejects.toMatchObject({ code: "DELIVERY_OWNS_WIDENING" });
    const granted = await lease.acquire({ ...base, ownsSubset: [] });
    expect(granted.delivery.segments.at(-1)).toMatchObject({ role: "reviewer", ownsSubset: [], grantedHeadSha: "b" });
    expect(granted.delivery.lease).toMatchObject({ state: "pending", expectedHeadSha: "b" });
  });

  it("treats verifying as retryable exclusion for reviewer acquisition", async () => {
    const { store, worktree, input } = fixture();
    input.lease = { state: "verifying", changedAt: now, verification: { nonce: "n", ownerEpoch: "e", actor,
      subjectSegmentId: "seg-0", deliveredHeadSha: "b", startedAt: now, operationId: "verify",
      priorLease: { state: "free", changedAt: now } } };
    await store.create(input);
    await expect(reviewService(store, worktree).acquire({ deliveryId: "d-lease", expectedHeadSha: "b", canonicalWorktree: worktree,
      role: "reviewer", executionAgent: "reviewer", grantedBy: actor, ownsSubset: [], operationId: "review-blocked" }))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true, detail: { state: "verifying" } });
  });

  it.each(["ACCEPT", "FINDINGS"] as const)("completes a clean %s review exactly once and releases the lease", async (verdict) => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const lease = reviewService(store, worktree);
    const completed = await lease.completeReview(completeReviewInput(worktree, verdict));
    expect(completed.lease.state).toBe("free");
    expect(completed.segments.at(-1)).toMatchObject({ releasedHeadSha: "b", outcome: "completed" });
    expect(completed.events.filter((event) => event.type === "review_completed")).toHaveLength(1);
    expect(completed.events.at(-1)).toMatchObject({ type: "review_completed", detail: { verdict, reviewedHeadSha: "b" } });
    expect(await lease.completeReview(completeReviewInput(worktree, verdict))).toEqual(completed);
  });

  it("refuses reuse of a review operation id with a different intent", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const lease = reviewService(store, worktree);
    await lease.completeReview(completeReviewInput(worktree, "ACCEPT", "stable-review"));
    await expect(lease.completeReview(completeReviewInput(worktree, "FINDINGS", "stable-review")))
      .rejects.toThrow("does not match this review completion intent");
  });

  it.each([
    ["HEAD", { ...cleanReviewInspection, headSha: "moved" }],
    ["task ref", { ...cleanReviewInspection, taskRefSha: "moved" }],
    ["index", { ...cleanReviewInspection, indexTreeSha: "staged" }],
    ["tracked worktree", { ...cleanReviewInspection, trackedClean: false }],
  ] as const)("quarantines reviewer %s mutation without authoritative completion", async (_label, inspection) => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    await expect(reviewService(store, worktree, { inspect: () => inspection }).completeReview(completeReviewInput(worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    const invalid = (await store.get("d-lease"))!;
    expect(invalid.lease).toMatchObject({ state: "quarantined", holder: input.lease!.holder });
    expect(invalid.segments.at(-1)?.releasedAt).toBeUndefined();
    expect(invalid.events.some((event) => event.type === "review_completed")).toBe(false);
    expect(invalid.events.at(-1)?.type).toBe("review_invalid");
  });

  it("ignores an untracked-only file when tracked/index/ref postconditions remain exact", async () => {
    const { store, worktree, input } = reviewFixture();
    fs.writeFileSync(path.join(worktree, "untracked.txt"), "advisory only\n");
    await store.create(input);
    await expect(reviewService(store, worktree).completeReview(completeReviewInput(worktree))).resolves.toMatchObject({ lease: { state: "free" } });
  });

  it("inspects twice and quarantines a mutation appearing only in the second observation", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    let observations = 0;
    const lease = reviewService(store, worktree, { inspect: () => (++observations === 1
      ? cleanReviewInspection : { ...cleanReviewInspection, taskRefSha: "moved-second" }) });
    await expect(lease.completeReview(completeReviewInput(worktree))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(observations).toBe(2);
    expect((await store.get("d-lease"))!.events.some((event) => event.type === "review_completed")).toBe(false);
  });

  it("quarantines when exact review inspection is unavailable", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const lease = new DeliveryLeaseService({ store, processFence: certifiedFence, canonicalWorktreeFor: () => worktree,
      readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
      withWorktreeLock: async (_path, fn) => fn(), now: () => now });
    await expect(lease.completeReview(completeReviewInput(worktree))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-lease"))!.lease.state).toBe("quarantined");
  });

  it("quarantines holder drift and fence uncertainty while preserving the open reviewer", async () => {
    const drift = reviewFixture();
    await drift.store.create(drift.input);
    const driftingFence: ProcessFencePort = { ...certifiedFence, terminate: async () => {
      const current = await drift.store.get("d-lease");
      await drift.store.update("d-lease", current!.version, (record) => {
        record.lease.holder = { ...record.lease.holder!, principal: "drifted" }; return record;
      });
    } };
    await expect(reviewService(drift.store, drift.worktree, { fence: driftingFence }).completeReview(completeReviewInput(drift.worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await drift.store.get("d-lease"))!.lease).toMatchObject({ state: "quarantined", holder: { principal: "drifted" } });

    const uncertain = reviewFixture();
    await uncertain.store.create(uncertain.input);
    const unknownFence: ProcessFencePort = { ...certifiedFence, proveEmpty: async () => ({ state: "unknown", reason: "uncertain" }) };
    await expect(reviewService(uncertain.store, uncertain.worktree, { fence: unknownFence }).completeReview(completeReviewInput(uncertain.worktree)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await uncertain.store.get("d-lease"))!.segments.at(-1)?.releasedAt).toBeUndefined();
  });

  it.each(["drain", "complete"] as const)("replays a committed review %s after a lost response", async (phase) => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const update = store.update.bind(store);
    let lost = false;
    store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      const result = await update(...args);
      const operationId = args[3]?.operationId;
      if (!lost && operationId === `review-op:${phase}`) { lost = true; throw new Error(`${phase} response lost`); }
      return result;
    };
    const completed = await reviewService(store, worktree).completeReview(completeReviewInput(worktree));
    expect(completed.lease.state).toBe("free");
    expect(completed.events.filter((event) => event.type === "review_completed")).toHaveLength(1);
  });

  it("runs process-fence work outside Delivery/worktree locks", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    let lockDepth = 0;
    const outside = vi.fn(() => { expect(lockDepth).toBe(0); });
    const fence: ProcessFencePort = { capability: () => ({ supported: true, domain: "test" }),
      freeze: async () => { outside(); }, terminate: async () => { outside(); },
      proveEmpty: async () => { outside(); return { state: "proven_empty" }; } };
    const withLock = async <T>(_path: string, fn: () => Promise<T>) => { lockDepth += 1; try { return await fn(); } finally { lockDepth -= 1; } };
    await reviewService(store, worktree, { fence, withLock }).completeReview(completeReviewInput(worktree));
    expect(outside).toHaveBeenCalledTimes(3);
  });

  it("aggregates the postcondition cause with quarantine persistence failure", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const update = store.update.bind(store);
    store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      if (args[3]?.operationId === "review-op:quarantine") throw new Error("quarantine persistence failed");
      return update(...args);
    };
    const error = await reviewService(store, worktree, { inspect: () => ({ ...cleanReviewInspection, trackedClean: false }) })
      .completeReview(completeReviewInput(worktree)).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((entry: Error) => entry.message)).toEqual([
      expect.stringContaining("reviewer changed tracked worktree content"), "quarantine persistence failed",
    ]);
    expect((await store.get("d-lease"))!.lease.state).toBe("draining");
  });
});

describe("DeliveryLeaseService dead-holder reconciliation (SDD 368 T11)", () => {
  const request = (worktree: string, operationId = "reconcile") => ({
    deliveryId: "d-lease", canonicalWorktree: worktree, actor, operationId,
  });
  const makeService = (store: DeliveryStore, worktree: string, options: {
    observation?: { state: "alive" } | { state: "gone" } | { state: "unknown"; reason: string };
    observe?: (identity: unknown) => Promise<unknown>;
    omitObserver?: boolean;
    fence?: ProcessFencePort;
    inspect?: () => { headSha: string; clean: boolean };
    withLock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
  } = {}) => new DeliveryLeaseService({
    store,
    processFence: options.fence ?? certifiedFence,
    ...(options.omitObserver ? {} : { processObserver: {
      observe: async (identity: unknown) => await (options.observe ?? (async () => options.observation ?? { state: "gone" }))(identity) as never,
    } }),
    canonicalWorktreeFor: () => worktree,
    readHead: () => "b",
    inspectWorktree: options.inspect ?? (() => ({ headSha: "b", clean: true })),
    isAncestor: () => true,
    withWorktreeLock: options.withLock ?? (async (_path, fn) => fn()),
    now: () => now,
    eventId: () => `reconcile-event-${Math.random()}`,
  });
  const recoveryInventory = { headSha: "b", dirtyPaths: [{ path: "src/dirty.ts", status: "M" }], uniqueCommits: ["unique-b"] };
  const recoveryService = (store: DeliveryStore, worktree: string, options: {
    inventory?: typeof recoveryInventory;
    approval?: (id: string, digest: string) => unknown;
    recoveryPrincipals?: string[];
    fence?: ProcessFencePort;
    canonical?: () => string;
    withLock?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
  } = {}) => new DeliveryLeaseService({
    store, processFence: options.fence ?? certifiedFence, canonicalWorktreeFor: options.canonical ?? (() => worktree),
    readHead: () => "b", inspectWorktree: () => ({ headSha: "b", clean: true }), isAncestor: () => true,
    inspectRecoveryWorktree: () => ({ inventory: options.inventory ?? recoveryInventory }),
    recoveryPrincipals: options.recoveryPrincipals,
    resolveRecoveryApproval: async (id, resolved, digest) => options.approval?.(id, digest) as never ?? {
      decision: "approved", requester: resolved.name!, actionDigest: digest, payloadHash: "payload", resolvedAt: now, resolvedBy: "human",
    },
    withWorktreeLock: options.withLock ?? (async (_path, fn) => fn()), now: () => now,
    nonce: () => "recovery-nonce", segmentId: () => "recovery-segment", eventId: () => "recovery-event",
  });

  it("leaves an exact live identity unchanged without invoking the fence", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const fence: ProcessFencePort = { capability: vi.fn(() => ({ supported: true as const, domain: "test" })),
      freeze: vi.fn(), terminate: vi.fn(), proveEmpty: vi.fn() };
    const observe = vi.fn(async (identity) => { expect(identity).toEqual(input.lease!.holder!.process); return { state: "alive" as const }; });
    const result = await makeService(store, worktree, { observe, fence }).reconcileHolder(request(worktree));
    expect(result).toMatchObject({ outcome: "alive", delivery: { lease: { state: "held" } } });
    expect(fence.capability).not.toHaveBeenCalled();
    expect(fence.proveEmpty).not.toHaveBeenCalled();
    expect((await store.get("d-lease"))!.events).toHaveLength(0);
  });

  it("interrupts only after gone, proven-empty, and two exact clean HEAD observations", async () => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const inspect = vi.fn(() => ({ headSha: "b", clean: true }));
    const result = await makeService(store, worktree, { inspect }).reconcileHolder(request(worktree));
    expect(result.outcome).toBe("interrupted");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(result.delivery.lease.state).toBe("free");
    expect(result.delivery.segments[0]).toMatchObject({ outcome: "interrupted", releasedHeadSha: "b" });
    expect(result.delivery.events.map((event) => event.type)).toEqual(["holder_interrupted"]);
  });

  it("does not fabricate ACCEPT when a reviewer dies", async () => {
    const { store, worktree, input } = reviewFixture();
    await store.create(input);
    const result = await makeService(store, worktree).reconcileHolder(request(worktree));
    expect(result.delivery.segments[0]!.outcome).toBe("interrupted");
    expect(result.delivery.events.some((event) => event.type === "review_completed" || event.detail?.verdict === "ACCEPT")).toBe(false);
  });

  it.each(["missing", "malformed", "unknown", "throwing"] as const)("quarantines %s process identity observation", async (kind) => {
    const { store, worktree, input } = heldFixture();
    if (kind === "missing") delete input.lease!.holder!.process;
    if (kind === "malformed") input.lease!.holder!.process = { pid: 0, processStart: "", bootId: "" };
    await store.create(input);
    const observe = kind === "throwing" ? async () => { throw new Error("observer failed"); }
      : async () => kind === "unknown" ? { state: "unknown" as const, reason: "unavailable" } : { state: "gone" as const };
    await expect(makeService(store, worktree, { observe }).reconcileHolder(request(worktree, `identity-${kind}`)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-lease"))!.lease).toMatchObject({ state: "quarantined", holder: input.lease!.holder });
  });

  it.each(["unavailable", "throwing", "survivors", "unknown"] as const)("quarantines %s external fence proof", async (kind) => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    const fence: ProcessFencePort = {
      capability: () => kind === "unavailable" ? { supported: false, reason: "unsupported" } : { supported: true, domain: "test" },
      freeze: vi.fn(), terminate: vi.fn(),
      proveEmpty: async () => {
        if (kind === "throwing") throw new Error("fence failed");
        if (kind === "survivors") return { state: "survivors", pids: [8] };
        if (kind === "unknown") return { state: "unknown", reason: "uncertain" };
        return { state: "proven_empty" };
      },
    };
    await expect(makeService(store, worktree, { fence }).reconcileHolder(request(worktree, `fence-${kind}`)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(fence.freeze).not.toHaveBeenCalled();
    expect(fence.terminate).not.toHaveBeenCalled();
  });

  it.each([
    ["dirty", [{ headSha: "b", clean: false }]],
    ["untracked", [{ headSha: "b", clean: false }]],
    ["index", [{ headSha: "b", clean: false }]],
    ["committed HEAD", [{ headSha: "c", clean: true }]],
    ["second observation", [{ headSha: "b", clean: true }, { headSha: "b", clean: false }]],
  ] as const)("quarantines %s worktree state", async (_label, observations) => {
    const { store, worktree, input } = heldFixture();
    await store.create(input);
    let index = 0;
    await expect(makeService(store, worktree, { inspect: () => observations[Math.min(index++, observations.length - 1)]! })
      .reconcileHolder(request(worktree, `inspection-${_label.replace(/ /g, "-")}`))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
  });

  it("quarantines inspection errors", async () => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    await expect(makeService(store, worktree, { inspect: () => { throw new Error("git inspection failed"); } })
      .reconcileHolder(request(worktree, "inspect-error"))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
  });

  it("quarantines the current holder after holder drift but preserves competing owned state", async () => {
    const drift = heldFixture(); await drift.store.create(drift.input);
    const driftService = makeService(drift.store, drift.worktree, { observe: async () => {
      const current = await drift.store.get("d-lease");
      await drift.store.update("d-lease", current!.version, (record) => { record.lease.holder!.principal = "new-principal"; return record; });
      return { state: "gone" };
    } });
    await expect(driftService.reconcileHolder(request(drift.worktree, "holder-drift"))).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await drift.store.get("d-lease"))!.lease).toMatchObject({ state: "quarantined", holder: { principal: "new-principal" } });

    const competing = heldFixture(); await competing.store.create(competing.input);
    const competingService = makeService(competing.store, competing.worktree, { observe: async () => {
      const current = await competing.store.get("d-lease");
      await competing.store.update("d-lease", current!.version, (record) => { record.lease = { ...record.lease, state: "draining" }; return record; });
      return { state: "gone" };
    } });
    await expect(competingService.reconcileHolder(request(competing.worktree, "competing")))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect((await competing.store.get("d-lease"))!.lease.state).toBe("draining");
  });

  it("replays lost interrupted responses, rejects intent collisions, and emits one terminal event concurrently", async () => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const update = store.update.bind(store); let lost = false;
    store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      const result = await update(...args);
      if (!lost && args[3]?.operationId === "same:interrupt") { lost = true; throw new Error("response lost"); }
      return result;
    };
    const lease = makeService(store, worktree);
    const [first, second] = await Promise.all([
      lease.reconcileHolder(request(worktree, "same")), lease.reconcileHolder(request(worktree, "same")),
    ]);
    expect(first).toEqual(second);
    expect(first.delivery.events.filter((event) => event.type === "holder_interrupted")).toHaveLength(1);
    await expect(lease.reconcileHolder({ ...request(worktree, "same"), actor: { kind: "agent", name: "other" } }))
      .rejects.toThrow(/intent/);
  });

  it("replays quarantine refusal and aggregates the safety cause before persistence failure", async () => {
    const replay = heldFixture(); await replay.store.create(replay.input);
    const lease = makeService(replay.store, replay.worktree, { observation: { state: "unknown", reason: "uncertain" } });
    const first = await lease.reconcileHolder(request(replay.worktree, "quarantine-replay")).catch((error) => error);
    const second = await lease.reconcileHolder(request(replay.worktree, "quarantine-replay")).catch((error) => error);
    expect(first).toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(second).toMatchObject({ code: first.code, retryable: first.retryable, detail: first.detail });
    expect((await replay.store.get("d-lease"))!.events.filter((event) => event.type === "holder_reconcile_quarantined")).toHaveLength(1);

    const concurrent = heldFixture(); await concurrent.store.create(concurrent.input);
    const concurrentLease = makeService(concurrent.store, concurrent.worktree, { observation: { state: "unknown", reason: "uncertain" } });
    const refusals = await Promise.allSettled([
      concurrentLease.reconcileHolder(request(concurrent.worktree, "quarantine-concurrent")),
      concurrentLease.reconcileHolder(request(concurrent.worktree, "quarantine-concurrent")),
    ]);
    expect(refusals.every((result) => result.status === "rejected" && result.reason.code === "DELIVERY_QUARANTINED")).toBe(true);
    expect((await concurrent.store.get("d-lease"))!.events.filter((event) => event.type === "holder_reconcile_quarantined")).toHaveLength(1);

    const failed = heldFixture(); await failed.store.create(failed.input);
    const update = failed.store.update.bind(failed.store);
    failed.store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      if (args[3]?.operationId === "persist:quarantine") throw new Error("quarantine persistence failed");
      return update(...args);
    };
    const error = await makeService(failed.store, failed.worktree, { observation: { state: "unknown", reason: "primary safety failure" } })
      .reconcileHolder(request(failed.worktree, "persist")).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((entry: Error) => entry.message)).toEqual([
      expect.stringContaining("primary safety failure"), "quarantine persistence failed",
    ]);
    expect((await failed.store.get("d-lease"))!.lease.state).toBe("held");
  });

  it("replays the immutable quarantine reason when concurrent observers fail differently", async () => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    let observers = 0;
    let releaseWinner!: () => void;
    const bothObserved = new Promise<void>((resolve) => { releaseWinner = resolve; });
    let signalCommit!: () => void;
    const committed = new Promise<void>((resolve) => { signalCommit = resolve; });
    const update = store.update.bind(store);
    store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      const result = await update(...args);
      if (args[3]?.operationId === "same-operation:quarantine") signalCommit();
      return result;
    };
    const lease = makeService(store, worktree, { observe: async () => {
      observers++;
      if (observers === 1) {
        await bothObserved;
        return { state: "unknown" as const, reason: "winner" };
      }
      releaseWinner();
      await committed;
      return { state: "unknown" as const, reason: "loser" };
    } });
    const [first, second] = await Promise.all([
      lease.reconcileHolder(request(worktree, "same-operation")).catch((error) => error),
      lease.reconcileHolder(request(worktree, "same-operation")).catch((error) => error),
    ]);
    const delivery = (await store.get("d-lease"))!;
    const persisted = JSON.parse(delivery.lease.reason!) as Record<string, unknown>;
    expect(first).toMatchObject({ code: "DELIVERY_QUARANTINED", retryable: false, detail: { evidence: persisted } });
    expect(second).toEqual(first);
    expect(delivery.events.filter((event) => event.type === "holder_reconcile_quarantined")).toHaveLength(1);
  });

  it("rejects canonical mismatch before process observation and runs observation/proof outside the worktree lock", async () => {
    const mismatch = heldFixture(); await mismatch.store.create(mismatch.input);
    const observe = vi.fn(async () => ({ state: "gone" as const }));
    await expect(makeService(mismatch.store, mismatch.worktree, { observe }).reconcileHolder(request(path.join(mismatch.worktree, "other"))))
      .rejects.toMatchObject({ code: "DELIVERY_WORKTREE_MISMATCH" });
    expect(observe).not.toHaveBeenCalled();

    const outside = heldFixture(); await outside.store.create(outside.input);
    let lockDepth = 0;
    const assertOutside = vi.fn(() => expect(lockDepth).toBe(0));
    const fence: ProcessFencePort = { capability: () => ({ supported: true, domain: "test" }), freeze: vi.fn(), terminate: vi.fn(),
      proveEmpty: async () => { assertOutside(); return { state: "proven_empty" }; } };
    const withLock = async <T>(_path: string, fn: () => Promise<T>) => { lockDepth++; try { return await fn(); } finally { lockDepth--; } };
    await makeService(outside.store, outside.worktree, { fence, withLock, observe: async () => { assertOutside(); return { state: "gone" }; } })
      .reconcileHolder(request(outside.worktree, "outside"));
    expect(assertOutside).toHaveBeenCalledTimes(2);
    expect(fence.freeze).not.toHaveBeenCalled(); expect(fence.terminate).not.toHaveBeenCalled();
  });

  it.each(["missing-holder", "reservation-nonce", "grant-boundary"] as const)("quarantines invalid held boundary: %s", async (kind) => {
    const { store, worktree, input } = heldFixture();
    if (kind === "missing-holder") delete input.lease!.holder;
    if (kind === "reservation-nonce") input.lease!.holder!.reservationNonce = "stale-reservation";
    if (kind === "grant-boundary") input.segments![0]!.grantedHeadSha = "a";
    await store.create(input);
    await expect(makeService(store, worktree).reconcileHolder(request(worktree, `boundary-${kind}`)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    const delivery = await store.get("d-lease");
    expect(delivery!.lease.state).toBe("quarantined");
    expect(delivery!.lease.holder).toEqual(input.lease!.holder);
    expect(delivery!.segments[0]!.releasedAt).toBeUndefined();
  });

  it.each([
    ["missing observer", { omitObserver: true }],
    ["foreign observer state", { observe: async () => ({ state: "dead" }) }],
    ["blank unknown reason", { observe: async () => ({ state: "unknown", reason: "" }) }],
  ] as const)("quarantines %s without invoking proveEmpty", async (_label, observerOptions) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const fence: ProcessFencePort = { ...certifiedFence, proveEmpty: vi.fn() };
    await expect(makeService(store, worktree, { ...observerOptions, fence }).reconcileHolder(request(worktree, `observer-${_label.replace(/ /g, "-")}`)))
      .rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(fence.proveEmpty).not.toHaveBeenCalled();
  });

  it("detects a store-legal concurrent tail closure during live revalidation and replays it exactly", async () => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    let closed;
    const lease = makeService(store, worktree, { observe: async () => {
      const current = await store.get("d-lease");
      closed = await store.update("d-lease", current!.version, (record) => {
        record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "b", outcome: "interrupted" };
        return record;
      });
      return { state: "alive" };
    } });
    const first = await lease.reconcileHolder(request(worktree, "live-tail-drift")).catch((error) => error);
    expect(closed).toBeDefined();
    const second = await lease.reconcileHolder(request(worktree, "live-tail-drift")).catch((error) => error);
    expect(second).toMatchObject({ code: "DELIVERY_QUARANTINED", detail: first.detail });
    const delivery = (await store.get("d-lease"))!;
    expect(delivery.lease.state).toBe("quarantined");
    expect(delivery.events.filter((event) => event.type === "holder_reconcile_quarantined")).toHaveLength(1);
    expect(delivery.events.at(-1)!.detail!.tail).toEqual(delivery.segments.at(-1));
  });

  it.each(["live", "interrupt", "quarantine"] as const)("revalidates canonical authority during the %s locked phase", async (phase) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    let resolutions = 0;
    const deps = makeService(store, worktree, {
      observation: phase === "live" ? { state: "alive" } : phase === "quarantine" ? { state: "unknown", reason: "uncertain" } : { state: "gone" },
    });
    const internals = deps as unknown as { deps: { canonicalWorktreeFor: () => string } };
    internals.deps.canonicalWorktreeFor = () => ++resolutions === 1 ? worktree : path.join(worktree, "moved");
    await expect(deps.reconcileHolder(request(worktree, `canonical-${phase}`))).rejects.toMatchObject({ code: "DELIVERY_WORKTREE_MISMATCH" });
    expect((await store.get("d-lease"))!.lease.state).toBe("held");
  });

  it.each(["pending", "draining"] as const)("preserves a competing %s transition as retryable occupancy", async (state) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const lease = makeService(store, worktree, { observe: async () => {
      const current = await store.get("d-lease");
      await store.update("d-lease", current!.version, (record) => {
        record.lease = { ...record.lease, state };
        return record;
      });
      return { state: "gone" };
    } });
    await expect(lease.reconcileHolder(request(worktree, `inflight-${state}`))).rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect((await store.get("d-lease"))!.lease.state).toBe(state);
  });

  it.each(["alive", "gone"] as const)("replays a concurrent quarantined lease during %s revalidation", async (phase) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const evidence = { source: `${phase}-race`, exact: true };
    const quarantine = async () => {
      const current = await store.get("d-lease");
      await store.update("d-lease", current!.version, (record) => {
        record.lease = { ...record.lease, state: "quarantined", reason: JSON.stringify(evidence), changedAt: now };
        return record;
      });
    };
    const lease = makeService(store, worktree, phase === "alive"
      ? { observe: async () => { await quarantine(); return { state: "alive" as const }; } }
      : { observe: async () => ({ state: "gone" as const }), fence: { ...certifiedFence, proveEmpty: async () => {
        await quarantine(); return { state: "proven_empty" };
      } } });
    await expect(lease.reconcileHolder(request(worktree, `quarantined-${phase}`))).rejects.toMatchObject({
      code: "DELIVERY_QUARANTINED", retryable: false, detail: { evidence },
    });
    expect((await store.get("d-lease"))!.lease).toMatchObject({ state: "quarantined", reason: JSON.stringify(evidence) });
  });

  it("preserves a verifying in-flight state as retryable occupancy", async () => {
    const { store, worktree, input } = fixture();
    input.lease = { state: "verifying", changedAt: now, verification: {
      nonce: "verify-nonce", ownerEpoch: "epoch", actor, subjectSegmentId: "seg-0", deliveredHeadSha: "b",
      startedAt: now, operationId: "competing-verification", priorLease: { state: "free", changedAt: now },
    } };
    await store.create(input);
    await expect(makeService(store, worktree).reconcileHolder(request(worktree, "inflight-verifying")))
      .rejects.toMatchObject({ code: "WORKTREE_OCCUPIED", retryable: true });
    expect((await store.get("d-lease"))!.lease.state).toBe("verifying");
  });

  it.each(["principal", "segment-id", "missing-holder", "closed-tail"] as const)("replays lost quarantine response exactly for %s drift", async (drift) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const update = store.update.bind(store); let lost = false;
    const operationId = `drift-${drift}`;
    store.update = async (...args: Parameters<DeliveryStore["update"]>) => {
      const result = await update(...args);
      if (!lost && args[3]?.operationId === `${operationId}:quarantine`) { lost = true; throw new Error("quarantine response lost"); }
      return result;
    };
    const lease = makeService(store, worktree, { observe: async () => {
      const current = await store.get("d-lease");
      await update("d-lease", current!.version, (record) => {
        if (drift === "principal") record.lease.holder!.principal = "drifted";
        if (drift === "segment-id") record.lease.holder!.segmentId = "other-segment";
        if (drift === "missing-holder") delete record.lease.holder;
        if (drift === "closed-tail") record.segments[0] = {
          ...record.segments[0]!, releasedAt: now, releasedHeadSha: "b", outcome: "interrupted",
        };
        return record;
      });
      return { state: "gone" };
    } });
    const first = await lease.reconcileHolder(request(worktree, operationId)).catch((caught) => caught);
    const second = await lease.reconcileHolder(request(worktree, operationId)).catch((caught) => caught);
    expect(second).toMatchObject({ code: "DELIVERY_QUARANTINED", retryable: false, detail: first.detail });
    const delivery = (await store.get("d-lease"))!;
    expect(delivery.events.filter((event) => event.type === "holder_reconcile_quarantined")).toHaveLength(1);
    const event = delivery.events.at(-1)!;
    expect(event.detail!.holder).toEqual(delivery.lease.holder);
    expect(event.detail!.tail).toEqual(delivery.segments.at(-1));
  });

  it.each(["interrupt", "quarantine"] as const)("rejects malformed %s receipt projections", async (terminal) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const operationId = `receipt-${terminal}`;
    const lease = makeService(store, worktree, { observation: terminal === "interrupt" ? { state: "gone" } : { state: "unknown", reason: "uncertain" } });
    await lease.reconcileHolder(request(worktree, operationId)).catch(() => undefined);
    const getResult = store.getOperationResult.bind(store);
    store.getOperationResult = async (...args: Parameters<DeliveryStore["getOperationResult"]>) => {
      const result = await getResult(...args);
      if (result && args[0] === `${operationId}:${terminal}`) {
        const malformed = structuredClone(result);
        if (terminal === "interrupt") malformed.segments.at(-1)!.outcome = "completed";
        else malformed.events.find((event) => event.type === "holder_reconcile_quarantined")!.detail!.holder = { segmentId: "wrong" };
        return malformed;
      }
      return result;
    };
    await expect(lease.reconcileHolder(request(worktree, operationId))).rejects.toThrow(/does not match/);
  });

  it.each(["holder", "process", "nonce", "event-segment", "tail-agent", "grant-head", "release-head"] as const)("rejects interrupted receipt mutation: %s", async (mutation) => {
    const { store, worktree, input } = heldFixture(); await store.create(input);
    const operationId = `interrupt-receipt-${mutation}`;
    const lease = makeService(store, worktree);
    await lease.reconcileHolder(request(worktree, operationId));
    const getResult = store.getOperationResult.bind(store);
    store.getOperationResult = async (...args: Parameters<DeliveryStore["getOperationResult"]>) => {
      const result = await getResult(...args);
      if (!result || args[0] !== `${operationId}:interrupt`) return result;
      const malformed = structuredClone(result);
      const event = malformed.events.find((candidate) => candidate.type === "holder_interrupted")!;
      const holder = event.detail!.holder as Delivery["lease"]["holder"];
      if (mutation === "holder") holder!.principal = "wrong";
      if (mutation === "process") holder!.process!.processStart = "";
      if (mutation === "nonce") event.detail!.executionNonce = "wrong";
      if (mutation === "event-segment") event.detail!.segmentId = "wrong";
      if (mutation === "tail-agent") malformed.segments.at(-1)!.executionAgent = "wrong";
      if (mutation === "grant-head") malformed.segments.at(-1)!.grantedHeadSha = "wrong";
      if (mutation === "release-head") malformed.segments.at(-1)!.releasedHeadSha = "wrong";
      return malformed;
    };
    await expect(lease.reconcileHolder(request(worktree, operationId))).rejects.toThrow(/does not match/);
  });

  it("salvages an authorized recoverable quarantine as a dirty pending recovery segment", async () => {
    const { store, worktree, input } = heldFixture();
    input.lease = { ...input.lease!, state: "quarantined", reason: JSON.stringify({ cause: "fence" }) };
    await store.create(input);
    const result = await recoveryService(store, worktree).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: worktree,
      actor, operationId: "salvage", expectedHeadSha: "b", expectedInventory: recoveryInventory, executionAgent: "fixer", ownsSubset: ["src"] });
    expect(result).toMatchObject({ reservationNonce: "recovery-nonce", delivery: { lease: { state: "pending", holder: { segmentId: "recovery-segment" } } } });
    expect(result.delivery.segments.at(-1)).toMatchObject({ role: "recovery", grantedHeadSha: "b", ownsSubset: ["src"] });
    expect(result.delivery.events.at(-1)).toMatchObject({ type: "quarantine_salvaged", detail: { inventory: recoveryInventory } });
  });

  it("requires a bound approved receipt before abandoning and replays it without rerunning effects", async () => {
    const { store, worktree, input } = heldFixture();
    input.lease = { ...input.lease!, state: "quarantined", reason: JSON.stringify({ cause: "fence" }) };
    await store.create(input);
    let approvals = 0;
    const lease = recoveryService(store, worktree, { approval: (_id, digest) => {
      approvals++; return { decision: "approved", requester: actor.name!, actionDigest: digest, payloadHash: "payload", resolvedAt: now };
    } });
    const request = { deliveryId: "d-lease", canonicalWorktree: worktree, actor, operationId: "abandon", expectedHeadSha: "b", expectedInventory: recoveryInventory, approvalId: "a-1" };
    const first = await lease.abandonQuarantine(request);
    const replay = await lease.abandonQuarantine(request);
    expect(replay).toEqual(first); expect(approvals).toBe(1);
    expect(first).toMatchObject({ lease: { state: "abandoned" }, events: [expect.objectContaining({ type: "quarantine_abandoned" })] });
  });

  it("denies holder identity as recovery authority and leaves quarantine unchanged", async () => {
    const { store, worktree, input } = heldFixture();
    input.lease = { ...input.lease!, state: "quarantined", reason: JSON.stringify({ cause: "fence" }) };
    input.lease.holder!.executionAgent = "holder";
    await store.create(input);
    await expect(recoveryService(store, worktree).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: worktree,
      actor: { kind: "agent", name: "holder" }, operationId: "denied", expectedHeadSha: "b", expectedInventory: recoveryInventory,
      executionAgent: "fixer", ownsSubset: ["src"] })).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect((await store.get("d-lease"))!.lease.state).toBe("quarantined");
  });

  it("refuses acquisition of an abandoned Delivery as a terminal error", async () => {
    const { store, worktree, input } = fixture();
    input.segments![0] = { ...input.segments![0]!, releasedAt: now, releasedHeadSha: "b", outcome: "rejected" };
    input.lease = { state: "abandoned", changedAt: now };
    await store.create(input);
    await expect(makeService(store, worktree).acquire({ deliveryId: "d-lease", canonicalWorktree: worktree, expectedHeadSha: "b",
      role: "fixer", executionAgent: "fixer", ownsSubset: ["src"], grantedBy: actor, operationId: "abandoned-acquire" }))
      .rejects.toMatchObject({ code: "DELIVERY_ABANDONED", retryable: false });
  });

  it("allows configured recovery principals but rejects every untrusted actor before canonical or fence effects", async () => {
    const allowed = heldFixture(); allowed.input.lease = { ...allowed.input.lease!, state: "quarantined", reason: "q" }; await allowed.store.create(allowed.input);
    await expect(recoveryService(allowed.store, allowed.worktree, { recoveryPrincipals: ["rescuer"] }).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: allowed.worktree,
      actor: { kind: "agent", name: "rescuer" }, operationId: "configured", expectedHeadSha: "b", expectedInventory: recoveryInventory, executionAgent: "fixer", ownsSubset: ["src"] })).resolves.toMatchObject({ delivery: { lease: { state: "pending" } } });
    for (const actor of [{ kind: "agent", name: "peer" }, { kind: "legacy" }, { kind: "external" }] as const) {
      const denied = heldFixture(); denied.input.lease = { ...denied.input.lease!, state: "quarantined", reason: "q" }; await denied.store.create(denied.input);
      const canonical = vi.fn(() => denied.worktree); const fence: ProcessFencePort = { ...certifiedFence, proveEmpty: vi.fn() };
      await expect(recoveryService(denied.store, denied.worktree, { canonical, fence }).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: denied.worktree,
        actor: actor as never, operationId: `denied-${actor.kind}`, expectedHeadSha: "b", expectedInventory: recoveryInventory, executionAgent: "fixer", ownsSubset: ["src"] })).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
      expect(canonical).not.toHaveBeenCalled(); expect(fence.proveEmpty).not.toHaveBeenCalled();
    }
  });

  it.each(["unsupported", "unknown", "survivors", "throwing"] as const)("keeps quarantine byte-identical for %s recovery fence failure", async (kind) => {
    const { store, worktree, input } = heldFixture(); input.lease = { ...input.lease!, state: "quarantined", reason: "q" }; await store.create(input);
    const before = await store.get("d-lease");
    const fence: ProcessFencePort = { capability: () => kind === "unsupported" ? { supported: false, reason: "no" } : { supported: true, domain: "test" }, freeze: vi.fn(), terminate: vi.fn(),
      proveEmpty: async () => { if (kind === "throwing") throw new Error("boom"); if (kind === "unknown") return { state: "unknown", reason: "no" }; if (kind === "survivors") return { state: "survivors", pids: [1] }; return { state: "proven_empty" }; } };
    await expect(recoveryService(store, worktree, { fence }).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: worktree, actor, operationId: `fence-${kind}`, expectedHeadSha: "b", expectedInventory: recoveryInventory, executionAgent: "fixer", ownsSubset: ["src"] })).rejects.toMatchObject({ code: "DELIVERY_QUARANTINED" });
    expect(await store.get("d-lease")).toEqual(before); expect(fence.freeze).not.toHaveBeenCalled(); expect(fence.terminate).not.toHaveBeenCalled();
  });

  it.each(["head", "dirty", "commit", "malformed", "scope"] as const)("refuses %s recovery boundary without mutation", async (kind) => {
    const { store, worktree, input } = heldFixture(); input.lease = { ...input.lease!, state: "quarantined", reason: "q" }; await store.create(input); const before = await store.get("d-lease");
    const inventory = kind === "head" ? { ...recoveryInventory, headSha: "other" } : kind === "dirty" ? { ...recoveryInventory, dirtyPaths: [{ path: "other", status: "M" }] } : kind === "commit" ? { ...recoveryInventory, uniqueCommits: ["other"] } : kind === "malformed" ? { ...recoveryInventory, dirtyPaths: [{ path: "", status: "M" }] } : recoveryInventory;
    await expect(recoveryService(store, worktree, { inventory: inventory as typeof recoveryInventory }).salvageQuarantine({ deliveryId: "d-lease", canonicalWorktree: worktree, actor, operationId: `boundary-${kind}`, expectedHeadSha: "b", expectedInventory: recoveryInventory, executionAgent: "fixer", ownsSubset: kind === "scope" ? ["test"] : ["src"] })).rejects.toMatchObject({ code: kind === "scope" ? "DELIVERY_OWNS_WIDENING" : "DELIVERY_QUARANTINED" });
    expect(await store.get("d-lease")).toEqual(before);
  });
});
