import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  type DeliveryAuthorityHead,
  type DeliveryAuthorityHeadPort,
  DeliveryInvariantError,
  DeliveryStore,
  DeliveryStoreBusyError,
  DeliveryStoreUnsupportedError,
  DeliveryVersionConflictError,
} from "../../src/delivery/store.js";
import type { Delivery, DeliveryCreateInput } from "../../src/delivery/types.js";
import { makeTempDir } from "../helpers/tempDir.js";

const actor = { kind: "agent" as const, name: "coordinator" };
const now = "2026-07-10T12:00:00.000Z";
const AUTHORITY_KEY = Buffer.alloc(32, 0x42);

function root(): string { return makeTempDir("tachyon-delivery-"); }

function authorityHeadHarness(): {
  port: DeliveryAuthorityHeadPort;
  heads: Map<string, DeliveryAuthorityHead>;
  setPrepareHook(hook: ((id: string, next: DeliveryAuthorityHead) => Promise<void>) | undefined): void;
} {
  const heads = new Map<string, DeliveryAuthorityHead>();
  let prepareHook: ((id: string, next: DeliveryAuthorityHead) => Promise<void>) | undefined;
  return {
    heads,
    setPrepareHook(hook) { prepareHook = hook; },
    port: {
      async current(id) {
        const head = heads.get(id);
        return head ? { ...head } : undefined;
      },
      async prepare(id, next, expectedMac) {
        const current = heads.get(id);
        if (expectedMac === undefined ? current !== undefined : current?.mac !== expectedMac) {
          throw new Error("authority head compare-and-swap mismatch");
        }
        await prepareHook?.(id, next);
        heads.set(id, { ...next });
      },
    },
  };
}

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

  it.each(["holder", "expectedHead", "verification", "open-tail"] as const)("rejects malformed abandoned %s records", async (kind) => {
    const store = new DeliveryStore(root(), { now: () => now }); const created = await store.create(input(`d-abandoned-${kind}`));
    await expect(store.update(created.id, created.version, (record) => {
      if (kind !== "open-tail") record.segments[0] = { ...record.segments[0]!, releasedAt: now, releasedHeadSha: "base", outcome: "rejected" };
      record.lease = { state: "abandoned", changedAt: now,
        ...(kind === "holder" ? { holder: { segmentId: "seg-0", executionAgent: "x" } } : {}),
        ...(kind === "expectedHead" ? { expectedHeadSha: "base" } : {}),
        ...(kind === "verification" ? { verification: {} as never } : {}) };
      return record;
    })).rejects.toThrow();
  });

  it("rejects abandoned empty history on creation", async () => {
    const malformed = input("d-abandoned-empty"); malformed.segments = []; malformed.lease = { state: "abandoned", changedAt: now };
    await expect(new DeliveryStore(root(), { now: () => now }).create(malformed)).rejects.toThrow("abandoned lease requires closed history");
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

  it("fails closed when a host-authenticated Delivery is edited directly in SQLite", async () => {
    const workspace = root();
    const store = new DeliveryStore(workspace, {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
    });
    const created = await store.create(input("d-tampered-authority"));
    const database = new DatabaseSync(store.databasePath);
    try {
      const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(created.id) as
        | { record_json: string }
        | undefined;
      expect(row).toBeDefined();
      const record = JSON.parse(row!.record_json) as Record<string, unknown>;
      const contract = record.contract as Record<string, unknown>;
      contract.behaviorTest = "attacker-controlled verifier";
      contract.owns = ["."];
      database.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(JSON.stringify(record), created.id);
    } finally {
      database.close();
    }

    await expect(store.get(created.id)).rejects.toThrow("authority integrity check failed");
    await expect(store.listWithCorrupt()).resolves.toMatchObject({
      records: [],
      corrupt: [expect.objectContaining({ id: created.id, error: expect.stringContaining("authority integrity check failed") })],
    });
  });

  it("fails closed when a configured Delivery authority key becomes unavailable", async () => {
    const workspace = root();
    let key: Buffer | undefined = AUTHORITY_KEY;
    const store = new DeliveryStore(workspace, {
      now: () => now,
      authorityIntegrityKey: () => key,
    });
    const created = await store.create(input("d-missing-authority-key"));
    key = undefined;

    await expect(store.get(created.id)).rejects.toThrow("authority integrity key is unavailable");
    await expect(store.update(created.id, created.version, (record) => record))
      .rejects.toThrow("authority integrity key is unavailable");
  });

  it("rejects a valid host-authenticated Delivery replayed into another workspace", async () => {
    const source = new DeliveryStore(root(), {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
    });
    const target = new DeliveryStore(root(), {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
    });
    const sourceRecord = await source.create(input("d-cross-workspace-replay"));
    await target.create(input("d-cross-workspace-replay"));
    const sourceDatabase = new DatabaseSync(source.databasePath);
    const targetDatabase = new DatabaseSync(target.databasePath);
    try {
      const sourceRow = sourceDatabase.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(sourceRecord.id) as
        | { record_json: string }
        | undefined;
      expect(sourceRow).toBeDefined();
      targetDatabase.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?")
        .run(sourceRow!.record_json, sourceRecord.id);
    } finally {
      sourceDatabase.close();
      targetDatabase.close();
    }

    await expect(source.get(sourceRecord.id)).resolves.toMatchObject({ id: sourceRecord.id });
    await expect(target.get(sourceRecord.id)).rejects.toThrow("authority integrity check failed");
  });

  it("keeps historical receipts readable only while the current signed row matches its freshness head", async () => {
    const workspace = root();
    const authority = authorityHeadHarness();
    const store = new DeliveryStore(workspace, {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
      authorityHead: authority.port,
    });
    const created = await store.create(input("d-authority-rollback", "op-authority-create"));
    const database = new DatabaseSync(store.databasePath);
    let versionOneJson: string;
    try {
      const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(created.id) as
        | { record_json: string }
        | undefined;
      expect(row).toBeDefined();
      versionOneJson = row!.record_json;
    } finally {
      database.close();
    }
    const updated = await store.update(created.id, created.version, (record) => {
      record.events.push({ id: "event-version-two", at: now, type: "advanced", by: actor });
      return record;
    });
    expect(authority.heads.get(created.id)).toMatchObject({ revision: updated.version });
    await expect(store.getOperationResult("op-authority-create", "create", created.id))
      .resolves.toEqual(created);

    const attacker = new DatabaseSync(store.databasePath);
    try {
      attacker.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(versionOneJson, created.id);
    } finally {
      attacker.close();
    }

    await expect(store.get(created.id)).rejects.toThrow("authority head mismatch");
    await expect(store.getOperationResult("op-authority-create", "create", created.id))
      .rejects.toThrow("authority head mismatch");
  });

  it("rejects a valid signed payload stored under a different SQLite row id", async () => {
    const store = new DeliveryStore(root(), {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
    });
    const expected = await store.create(input("d-row-identity", "op-row-identity"));
    const alias = await store.create(input("d-payload-identity"));
    const database = new DatabaseSync(store.databasePath);
    try {
      const aliasRow = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(alias.id) as
        | { record_json: string }
        | undefined;
      database.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?")
        .run(aliasRow!.record_json, expected.id);
      database.prepare("UPDATE delivery_operation_receipts SET result_json = ? WHERE operation_id = ?")
        .run(aliasRow!.record_json, "op-row-identity");
    } finally {
      database.close();
    }

    await expect(store.get(expected.id)).rejects.toThrow(
      "row identity 'd-row-identity' does not match payload identity 'd-payload-identity'",
    );
    await expect(store.getOperationResult("op-row-identity", "create", expected.id)).rejects.toThrow(
      "row identity 'd-row-identity' does not match payload identity 'd-payload-identity'",
    );
  });

  it("rolls SQLite back when authority head prepare fails", async () => {
    const authority = authorityHeadHarness();
    const store = new DeliveryStore(root(), {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
      authorityHead: authority.port,
    });
    const created = await store.create(input("d-prepare-failure"));
    authority.setPrepareHook(async () => { throw new Error("host head unavailable"); });

    await expect(store.update(created.id, created.version, (record) => {
      record.events.push({ id: "event-must-not-commit", at: now, type: "rejected", by: actor });
      return record;
    })).rejects.toThrow("host head unavailable");

    authority.setPrepareHook(undefined);
    await expect(store.get(created.id)).resolves.toEqual(created);
    const database = new DatabaseSync(store.databasePath);
    try {
      const row = database.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(created.id) as
        | { record_json: string }
        | undefined;
      expect(JSON.parse(row!.record_json)).toMatchObject({ version: 1, events: [{ id: "event-0" }] });
    } finally {
      database.close();
    }
  });

  it("prepares the external head before INSERT and UPDATE while BEGIN IMMEDIATE remains held", async () => {
    const workspace = root();
    const authority = authorityHeadHarness();
    let store: DeliveryStore;
    const observations: Array<{ revision: number; sqlRevision: number | undefined; writerBlocked: boolean }> = [];
    authority.setPrepareHook(async (id, next) => {
      const observer = new DatabaseSync(store.databasePath, { timeout: 0 });
      try {
        const row = observer.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(id) as
          | { record_json: string }
          | undefined;
        let writerBlocked = false;
        try {
          observer.exec("BEGIN IMMEDIATE; ROLLBACK");
        } catch (error) {
          writerBlocked = error instanceof Error && /busy|locked/i.test(error.message);
        }
        observations.push({
          revision: next.revision,
          sqlRevision: row ? Number((JSON.parse(row.record_json) as { version: number }).version) : undefined,
          writerBlocked,
        });
      } finally {
        observer.close();
      }
    });
    store = new DeliveryStore(workspace, {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
      authorityHead: authority.port,
    });

    const created = await store.create(input("d-prepare-order"));
    await store.update(created.id, created.version, (record) => {
      record.events.push({ id: "event-prepare-order", at: now, type: "advanced", by: actor });
      return record;
    });

    expect(observations).toEqual([
      { revision: 1, sqlRevision: undefined, writerBlocked: true },
      { revision: 2, sqlRevision: 1, writerBlocked: true },
    ]);
  });

  it("leaves legacy JSON inert instead of promoting it into canonical authority", async () => {
    const workspace = root();
    const legacyDir = path.join(workspace, ".tachyon", "deliveries");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "d-legacy.json"), JSON.stringify({}), "utf8");
    const authority = authorityHeadHarness();
    const store = new DeliveryStore(workspace, {
      now: () => now,
      authorityIntegrityKey: () => AUTHORITY_KEY,
      authorityHead: authority.port,
    });

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.get("d-legacy")).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(legacyDir, "d-legacy.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries.migrated-v1"))).toBe(false);
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

  it("refuses a direct update replay once its authenticated receipt is historical", async () => {
    const store = new DeliveryStore(root(), { now: () => now });
    await store.create(input("d-historical-update"));
    const intent = { eventId: "event-authority-grant" };
    const committed = await store.update("d-historical-update", 1, (record) => {
      record.events.push({ id: "event-authority-grant", at: now, type: "authority_granted", by: actor });
      return record;
    }, { operationId: "op-authority-grant", intent });

    await expect(store.update("d-historical-update", 1, (record) => record, {
      operationId: "op-authority-grant", intent,
    })).resolves.toEqual(committed);

    await store.update("d-historical-update", committed.version, (record) => {
      record.events.push({ id: "event-authority-revoked", at: now, type: "authority_revoked", by: actor });
      return record;
    });
    let replayEffects = 0;
    await expect(store.update("d-historical-update", 1, (record) => {
      replayEffects += 1;
      return record;
    }, { operationId: "op-authority-grant", intent })).rejects.toThrow("historical receipt");

    expect(replayEffects).toBe(0);
    await expect(store.getOperationResult("op-authority-grant", "update", "d-historical-update"))
      .resolves.toEqual(committed);
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

  it("refuses ordinary update while a projection claim is held and accepts claim-capability updates", async () => {
    const store = new DeliveryStore(root(), { now: () => now });
    await store.create(input("d-proj-claim"));
    const claim = await store.claimProjection("d-proj-claim");
    await expect(store.update("d-proj-claim", 1, (record) => record)).rejects.toMatchObject({
      name: "DeliveryProjectionClaimError",
      retryable: true,
    });
    const updated = await store.updateUnderProjectionClaim(claim, 1, (record) => {
      record.events.push({ id: "event-proj", at: now, type: "projection-held", by: actor });
      return record;
    }, { operationId: "op-proj", intent: { k: 1 } });
    expect(updated.events.some((e) => e.id === "event-proj")).toBe(true);
    await store.releaseProjection(claim);
    await store.update("d-proj-claim", updated.version, (record) => {
      record.events.push({ id: "event-free", at: now, type: "free-again", by: actor });
      return record;
    });
  });
});
