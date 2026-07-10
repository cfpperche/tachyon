import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeliveryInvariantError,
  DeliveryLockUnavailableError,
  DeliveryStore,
  DeliveryVersionConflictError,
} from "../../src/delivery/store.js";
import type { DeliveryCreateInput, DeliveryLockOwner } from "../../src/delivery/types.js";

const actor = { kind: "agent" as const, name: "coordinator" };
const now = "2026-07-10T12:00:00.000Z";

function root(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-delivery-")); }

function input(id = "d-test"): DeliveryCreateInput {
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
  };
}

describe("DeliveryStore (spec 368)", () => {
  it("writes atomically and enforces CAS plus immutable contract", async () => {
    const workspace = root();
    const store = new DeliveryStore(workspace, { now: () => now, processIdentity: () => ({ pid: process.pid, processStart: "self", bootId: "boot" }) });
    const created = await store.create(input());
    expect(created.version).toBe(1);
    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries", "d-test.json"))).toBe(true);
    await expect(store.update(created.id, 2, (record) => record)).rejects.toBeInstanceOf(DeliveryVersionConflictError);
    await expect(store.update(created.id, 1, (record) => ({ ...record, contract: { ...record.contract, baseSha: "other" } }))).rejects.toBeInstanceOf(DeliveryInvariantError);
  });

  it("permits only tail closure and append-only segments/events", async () => {
    const store = new DeliveryStore(root(), { now: () => now, processIdentity: () => ({ pid: process.pid, processStart: "self", bootId: "boot" }) });
    const created = await store.create(input());
    const closed = await store.update(created.id, 1, (record) => {
      record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "head-1", outcome: "completed" };
      record.events.push({ id: "event-1", at: now, type: "released", by: actor });
      return record;
    });
    const appended = await store.update(closed.id, 2, (record) => {
      record.segments.push({ id: "seg-1", index: 1, role: "reviewer", executionAgent: "reviewer", grantedBy: actor, ownsSubset: [], grantedHeadSha: "head-1", grantedAt: now });
      return record;
    });
    expect(appended.segments.map((segment) => segment.id)).toEqual(["seg-0", "seg-1"]);
    await expect(store.update(appended.id, 3, (record) => {
      record.segments[0] = { ...record.segments[0]!, executionAgent: "rewritten" };
      return record;
    })).rejects.toBeInstanceOf(DeliveryInvariantError);
    await expect(store.update(appended.id, 3, (record) => ({ ...record, events: [] }))).rejects.toBeInstanceOf(DeliveryInvariantError);
  });

  it("DeliveryStore recovers a provably stale lock while preserving immutable append-only state", async () => {
    const workspace = root();
    const options = { now: () => now, processIdentity: () => ({ pid: process.pid, processStart: "self", bootId: "current-boot" }) };
    const store = new DeliveryStore(workspace, options);
    const created = await store.create(input("d-stale"));
    const lockDir = path.join(workspace, ".tachyon", "deliveries", ".locks", "d-stale.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const stale: DeliveryLockOwner = { schemaVersion: 1, nonce: "dead-owner", pid: process.pid, processStart: "old", bootId: "definitely-an-old-boot", acquiredAt: now };
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(stale));

    const next = await store.update(created.id, 1, (record) => {
      record.events.push({ id: "event-1", at: now, type: "recovered-update", by: actor });
      return record;
    });

    expect(next.version).toBe(2);
    expect(next.contract).toEqual(created.contract);
    expect(next.segments).toEqual(created.segments);
    expect(next.events.map((event) => event.id)).toEqual(["event-0", "event-1"]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("fails closed when lock-owner liveness is ambiguous", async () => {
    const workspace = root();
    const store = new DeliveryStore(workspace, { now: () => now, processIdentity: () => ({ pid: process.pid, processStart: "self", bootId: "boot" }) });
    const created = await store.create(input("d-ambiguous"));
    const lockDir = path.join(workspace, ".tachyon", "deliveries", ".locks", "d-ambiguous.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, nonce: "broken" }));
    await expect(store.update(created.id, 1, (record) => record)).rejects.toBeInstanceOf(DeliveryLockUnavailableError);
  });

  it("breaks an ambiguous lock only through the authenticated recovery seam and observed nonce", async () => {
    const workspace = root();
    const baseOptions = { now: () => now, processIdentity: () => ({ pid: process.pid, processStart: "self", bootId: "boot" }) };
    const denied = new DeliveryStore(workspace, baseOptions);
    await denied.create(input("d-recovery"));
    const lockDir = path.join(workspace, ".tachyon", "deliveries", ".locks", "d-recovery.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const ambiguous: DeliveryLockOwner = { schemaVersion: 1, nonce: "observed", pid: process.pid, processStart: "unavailable", bootId: "unavailable", acquiredAt: now };
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(ambiguous));
    await expect(denied.recoverAmbiguousLock({ id: "d-recovery", observedNonce: "observed", authenticatedBy: actor })).rejects.toThrow("authenticated actor");

    const authorized = new DeliveryStore(workspace, { ...baseOptions, authorizeLockRecovery: (candidate) => candidate.kind === "agent" && candidate.name === "coordinator" });
    await expect(authorized.recoverAmbiguousLock({ id: "d-recovery", observedNonce: "wrong", authenticatedBy: actor })).rejects.toThrow("changed");
    await authorized.recoverAmbiguousLock({ id: "d-recovery", observedNonce: "observed", authenticatedBy: actor });
    expect(authorized.inspectLockOwner("d-recovery")).toBeUndefined();
  });
});
