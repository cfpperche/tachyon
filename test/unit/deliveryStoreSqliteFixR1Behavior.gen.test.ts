import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryInvariantError, DeliveryStore, DeliveryStoreUnsupportedError } from "../../src/delivery/store.js";
import type { Delivery } from "../../src/delivery/types.js";

describe("container-generated delegation behavior", () => {
  it("serializes two legacy migrators that both observed the missing marker", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-r2-concurrent-"));
    const legacyDir = path.join(workspace, ".tachyon", "deliveries");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = legacyRecord("d-race");
    fs.writeFileSync(path.join(legacyDir, "d-race.json"), JSON.stringify(legacy));
    const storeA = new DeliveryStore(workspace);
    const storeB = new DeliveryStore(workspace);
    const state = { marker: undefined as string | undefined, records: new Map<string, string>() };
    let ranB = false;
    const dbB = migrationDb(state);
    const dbA = migrationDb(state, () => {
      ranB = true;
      (storeB as unknown as { migrateLegacyJson(db: unknown): void }).migrateLegacyJson(dbB);
    });

    expect(() => (storeA as unknown as { migrateLegacyJson(db: unknown): void }).migrateLegacyJson(dbA)).not.toThrow();
    expect(ranB).toBe(true);
    expect(state.marker).toBe("complete-v1");
    expect([...state.records]).toEqual([[legacy.id, JSON.stringify(legacy)]]);
  });

  it("accepts rename ENOENT only after validating a concurrent winner's archive", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-r2-rename-"));
    const legacyDir = path.join(workspace, ".tachyon", "deliveries");
    const archiveDir = path.join(workspace, ".tachyon", "deliveries.migrated-v1");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = legacyRecord("d-rename");
    fs.writeFileSync(path.join(legacyDir, "d-rename.json"), JSON.stringify(legacy));
    const store = new DeliveryStore(workspace);
    const state = { marker: "complete-v1" as string | undefined, records: new Map([[legacy.id, JSON.stringify(legacy)]]) };
    const originalRename = fs.renameSync;
    fs.renameSync = ((from, to) => {
      originalRename(from, to);
      throw Object.assign(new Error("lost rename race"), { code: "ENOENT" });
    }) as typeof fs.renameSync;
    try {
      expect(() => (store as unknown as { migrateLegacyJson(db: unknown): void }).migrateLegacyJson(migrationDb(state))).not.toThrow();
    } finally {
      fs.renameSync = originalRename;
    }
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, "d-rename.json"))).toBe(true);

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "d-rename.json"), JSON.stringify(legacy));
    expect(() => (store as unknown as { migrateLegacyJson(db: unknown): void }).migrateLegacyJson(migrationDb(state)))
      .toThrowError(DeliveryInvariantError);
  });

  it("SQLite DeliveryStore migrates legacy JSON exactly once, refuses intent collisions, and fails closed on runtimes without node:sqlite", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-r1-"));
    const legacyDir = path.join(workspace, ".tachyon", "deliveries");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy: Delivery = {
      schemaVersion: 1, id: "d-legacy", version: 7, workspaceId: "ws",
      createdBy: { kind: "system" },
      contract: { baseSha: "base", behaviorTest: "gate", owns: ["src/a.ts"], taskRef: "refs/tachyon/task" },
      lease: { state: "free", changedAt: "2026-01-01T00:00:00.000Z" },
      segments: [], events: [{ id: "e-1", at: "2026-01-01T00:00:00.000Z", type: "legacy", by: { kind: "system" } }],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(legacyDir, "d-legacy.json"), JSON.stringify(legacy));
    const store = new DeliveryStore(workspace, { now: () => "2026-01-03T00:00:00.000Z" });
    expect(await store.get(legacy.id)).toEqual(legacy);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries.migrated-v1", "d-legacy.json"))).toBe(true);
    expect(await new DeliveryStore(workspace).list()).toEqual([legacy]);

    const create = {
      id: "d-intent", workspaceId: "ws", createdBy: { kind: "system" as const },
      contract: { baseSha: "a", behaviorTest: "gate", owns: [], taskRef: "refs/tachyon/task" }, operationId: "op-create",
    };
    const first = await store.create(create);
    expect(await store.create(create)).toEqual(first);
    await expect(store.create({ ...create, contract: { ...create.contract, baseSha: "b" } }))
      .rejects.toBeInstanceOf(DeliveryInvariantError);

    await store.update(first.id, 1, (record) => record, { operationId: "op-update", intent: { command: "keep" } });
    await expect(store.update(first.id, 1, (record) => record, { operationId: "op-update", intent: { command: "change" } }))
      .rejects.toMatchObject({ name: "DeliveryInvariantError" });

    const unsupportedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-r1-runtime-"));
    expect(() => new DeliveryStore(unsupportedWorkspace, {
      capabilityValidator: () => ({ supported: false, reason: "node:sqlite unavailable" }),
    })).toThrowError(DeliveryStoreUnsupportedError);
    const source = fs.readFileSync(path.join(process.cwd(), "src", "delivery", "store.ts"), "utf8");
    expect(source).not.toMatch(/import\s+[^;]*from\s+["']node:sqlite["']/);
  });
});

function legacyRecord(id: string): Delivery {
  return {
    schemaVersion: 1, id, version: 1, workspaceId: "ws", createdBy: { kind: "system" },
    contract: { baseSha: "base", behaviorTest: "gate", owns: [], taskRef: "refs/tachyon/task" },
    lease: { state: "free", changedAt: "2026-01-01T00:00:00.000Z" }, segments: [], events: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function migrationDb(
  state: { marker: string | undefined; records: Map<string, string> },
  afterBegin?: () => void,
): unknown {
  let began = false;
  return {
    get isTransaction() { return began; },
    exec(sql: string) {
      if (sql === "BEGIN IMMEDIATE") { began = true; afterBegin?.(); }
      else if (sql === "COMMIT" || sql === "ROLLBACK") began = false;
    },
    prepare(sql: string) {
      if (sql.includes("SELECT value FROM delivery_store_metadata")) return { get: () => state.marker ? { value: state.marker } : undefined };
      if (sql.includes("INSERT INTO deliveries")) return { run: (id: string, json: string) => {
        if (state.records.has(id)) throw new Error("duplicate");
        state.records.set(id, json);
      } };
      if (sql.includes("INSERT INTO delivery_store_metadata")) return { run: (_key: string, value: string) => { state.marker = value; } };
      if (sql.includes("SELECT record_json FROM deliveries WHERE id")) return { get: (id: string) => {
        const record_json = state.records.get(id);
        return record_json === undefined ? undefined : { record_json };
      } };
      if (sql.includes("SELECT id, record_json FROM deliveries")) return { all: () => [...state.records].map(([id, record_json]) => ({ id, record_json })) };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}
