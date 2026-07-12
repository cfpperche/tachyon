import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DeliveryInvariantError,
  DeliveryStore,
  DeliveryStoreBusyError,
  DeliveryStoreUnsupportedError,
  DeliveryVersionConflictError,
} from "../../src/delivery/store.js";
import type { Delivery, DeliveryCreateInput } from "../../src/delivery/types.js";

const actor = { kind: "agent" as const, name: "coordinator" };
const now = "2026-07-10T12:00:00.000Z";

function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-delivery-")); }

function input(id = "d-test", operationId?: string): DeliveryCreateInput {
  return {
    id,
    workspaceId: "ws",
    createdBy: actor,
    contract: { taskId: "t-0b5723", baseSha: "base", behaviorTest: "behavior", owns: ["src/a.ts"], taskRef: "refs/tachyon/task" },
    segments: [{
      id: "seg-0", index: 0, role: "implementer", executionAgent: "worker", grantedBy: actor,
      ownsSubset: ["src/a.ts"], grantedHeadSha: "base", grantedAt: now,
    }],
    events: [{ id: "event-0", at: now, type: "created", by: actor }],
    ...(operationId ? { operationId } : {}),
  };
}

describe("DeliveryStore SQLite (spec 368)", () => {
  it("validates the terminal abandoned lease shape and rejects unknown states", async () => {
    const store = new DeliveryStore(root(), { now: () => now });
    const created = await store.create(input("d-abandoned"));
    await expect(store.update(created.id, created.version, (record) => {
      record.lease = { state: "unknown" as never, changedAt: now }; return record;
    })).rejects.toThrow("invalid Delivery lease state");
    await expect(store.update(created.id, created.version, (record) => {
      record.lease = { state: "abandoned", changedAt: now }; return record;
    })).rejects.toThrow("abandoned lease requires closed history");
    const abandoned = await store.update(created.id, created.version, (record) => {
      record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "base", outcome: "rejected" };
      record.lease = { state: "abandoned", changedAt: now };
      return record;
    });
    expect(abandoned.lease.state).toBe("abandoned");
  });

  it("uses one workspace-local SQLite database and enforces CAS plus immutable creation", async () => {
    const workspace = root();
    const store = new DeliveryStore(workspace, { now: () => now });
    const created = await store.create(input());

    expect(created.version).toBe(1);
    expect(store.databasePath).toBe(path.join(workspace, ".tachyon", "deliveries-v2.sqlite3"));
    expect(fs.existsSync(store.databasePath)).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries"))).toBe(false);
    await expect(store.update(created.id, 2, (record) => record)).rejects.toBeInstanceOf(DeliveryVersionConflictError);
    await expect(store.update(created.id, 1, (record) => ({ ...record, contract: { ...record.contract, baseSha: "other" } })))
      .rejects.toBeInstanceOf(DeliveryInvariantError);
    await expect(store.update(created.id, 1, (record) => ({ ...record, createdBy: { kind: "system" } })))
      .rejects.toBeInstanceOf(DeliveryInvariantError);
  });

  it("atomically closes the tail and appends one unique segment while events stay append-only", async () => {
    const store = new DeliveryStore(root(), { now: () => now });
    const created = await store.create(input());
    const handedOff = await store.update(created.id, 1, (record) => {
      record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "head-1", outcome: "completed" };
      record.segments.push({
        id: "seg-1", index: 1, role: "reviewer", executionAgent: "reviewer", grantedBy: actor,
        ownsSubset: [], grantedHeadSha: "head-1", grantedAt: now,
      });
      record.events.push({ id: "event-1", at: now, type: "handoff", by: actor });
      return record;
    });

    expect(handedOff.segments.map((segment) => segment.id)).toEqual(["seg-0", "seg-1"]);
    await expect(store.update(handedOff.id, 2, (record) => {
      record.segments[0] = { ...record.segments[0]!, executionAgent: "rewritten" };
      return record;
    })).rejects.toBeInstanceOf(DeliveryInvariantError);
    await expect(store.update(handedOff.id, 2, (record) => {
      record.events.push({ ...record.events[0]! });
      return record;
    })).rejects.toThrow("event ids must be unique");
    await expect(store.update(handedOff.id, 2, (record) => {
      record.segments[1] = { ...record.segments[1]!, releasedAt: now, releasedHeadSha: "head-2", outcome: "completed" };
      record.segments.push({ ...record.segments[1]!, index: 2 });
      return record;
    })).rejects.toThrow("segment ids and indexes must be unique");
  });

  it("replays a committed operation receipt without invoking the mutation twice", async () => {
    const store = new DeliveryStore(root(), { now: () => now });
    const firstCreate = await store.create(input("d-retry", "op-create"));
    expect(await store.create(input("d-retry", "op-create"))).toEqual(firstCreate);
    await expect(store.create({ ...input("d-retry", "op-create"), contract: { ...input().contract, baseSha: "collision" } }))
      .rejects.toMatchObject({ name: "DeliveryInvariantError" });

    let calls = 0;
    const mutate = (record: Delivery) => {
      calls += 1;
      record.events.push({ id: "event-retry", at: now, type: "once", by: actor });
      return record;
    };
    const committed = await store.update("d-retry", 1, mutate, { operationId: "op-update", intent: { eventId: "event-retry" } });
    const replayed = await store.update("d-retry", 1, mutate, { operationId: "op-update", intent: { eventId: "event-retry" } });

    expect(replayed).toEqual(committed);
    expect(calls).toBe(1);
    expect(replayed.events.filter((event) => event.id === "event-retry")).toHaveLength(1);

    const generated = new DeliveryStore(root(), { now: () => now, id: () => `d-generated-${Math.random()}` });
    const generatedFirst = await generated.create({ ...input(undefined, "op-generated"), id: undefined });
    const generatedReplay = await generated.create({ ...input(undefined, "op-generated"), id: undefined });
    expect(generatedReplay.id).toBe(generatedFirst.id);
  });

  it("returns a structured retryable refusal under independent-store contention", async () => {
    const workspace = root();
    const first = new DeliveryStore(workspace, { now: () => now });
    const second = new DeliveryStore(workspace, { now: () => now });
    await first.create(input("d-busy"));
    const blocker = new DatabaseSync(first.databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const error = await second.update("d-busy", 1, (record) => record).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DeliveryStoreBusyError);
      expect(error).toMatchObject({ code: "DELIVERY_STORE_BUSY", retryable: true });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("fails closed through the capability seam for an uncertified locking domain", () => {
    const workspace = root();
    expect(() => new DeliveryStore(workspace, {
      capabilityValidator: () => ({ supported: false, reason: "remote or unknown filesystem" }),
    })).toThrowError(DeliveryStoreUnsupportedError);
    try {
      new DeliveryStore(workspace, { capabilityValidator: () => ({ supported: false, reason: "remote" }) });
    } catch (error) {
      expect(error).toMatchObject({ code: "DELIVERY_STORE_UNSUPPORTED", retryable: false, reason: "remote" });
    }
    expect(fs.existsSync(path.join(workspace, ".tachyon"))).toBe(false);
  });

  it("does not hold BEGIN IMMEDIATE while caller mutation work executes", async () => {
    const workspace = root();
    const first = new DeliveryStore(workspace, { now: () => now });
    const independent = new DeliveryStore(workspace, { now: () => now });
    await first.create(input("d-external"));
    await first.create(input("d-independent"));

    await first.update("d-external", 1, (record) => {
      const db = new DatabaseSync(independent.databasePath);
      db.exec("BEGIN IMMEDIATE; ROLLBACK");
      db.close();
      record.events.push({ id: "event-finished", at: now, type: "external-finished", by: actor });
      return record;
    });
  });
});
