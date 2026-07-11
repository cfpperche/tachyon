import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryInvariantError, DeliveryStore, DeliveryStoreUnsupportedError } from "../../src/delivery/store.js";
import type { Delivery } from "../../src/delivery/types.js";

describe("container-generated delegation behavior", () => {
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
