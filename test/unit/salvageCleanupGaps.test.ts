import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessFencePort } from "../../src/agents/processFence.js";
import { sealAuthorityRecord, workspaceAuthorityDomain } from "../../src/delivery/authorityIntegrity.js";
import { DeliveryLeaseService } from "../../src/delivery/leaseService.js";
import { DeliveryProjectionService } from "../../src/delivery/projectionService.js";
import { type DeliveryAuthorityHead, type DeliveryAuthorityHeadPort, DeliveryStore } from "../../src/delivery/store.js";
import type { DeliveryActor, DeliveryCreateInput } from "../../src/delivery/types.js";
import { deterministicGitDeliveryId, GitDeliveryStore } from "../../src/git-delivery/store.js";
import type { GitExec, GitResult } from "../../src/worktree/WorktreeManager.js";

const roots: string[] = [];
const now = "2026-07-17T12:00:00.000Z";
const system: DeliveryActor = { kind: "system", name: "tachyon" };
const human: DeliveryActor = { kind: "human", name: "maintainer" };
const humanCaller = { kind: "human" as const, name: "maintainer" };
const key = Buffer.alloc(32, 0x57);

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "salvage-cleanup-gaps-"));
  roots.push(value);
  return value;
}

function input(id: string, held = false): DeliveryCreateInput {
  return {
    id, workspaceId: "ws", createdBy: system,
    contract: { baseSha: "base", behaviorTest: "cmd:test", owns: ["src"], taskRef: "t-salvage" },
    lease: held ? {
      state: "held", expectedHeadSha: "tip", changedAt: now,
      holder: { segmentId: "seg", executionAgent: "worker", executionNonce: "nonce",
        process: { pid: 999_999, processStart: "1", bootId: "boot" } },
    } : { state: "free", changedAt: now },
    segments: [{ id: "seg", index: 0, role: "implementer", executionAgent: "worker", grantedBy: system,
      ownsSubset: ["src"], grantedHeadSha: held ? "tip" : "base", grantedAt: now,
      ...(held ? {} : { releasedAt: now, releasedHeadSha: "tip", outcome: "completed" as const }) }],
    events: [],
  };
}

function ok(stdout = ""): GitResult { return { code: 0, stdout, stderr: "" }; }
function gitFor(worktree: string): GitExec {
  return async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse tachyon/worker") return ok("tip\n");
    if (command === "status --porcelain=v1 --untracked-files=all") return ok();
    if (command === "merge-base --is-ancestor tip main") return ok();
    if (command === "worktree list --porcelain") return ok(`worktree ${worktree}\nbranch refs/heads/tachyon/worker\n`);
    if (command === `worktree remove --force ${worktree}`) { fs.rmSync(worktree, { recursive: true, force: true }); return ok(); }
    return ok();
  };
}

/** Mirrors the real Workspace canonical authority-head port's CAS semantics (spec-397 t-headfix):
 *  `prepare` still pins a from-scratch head to revision 1, `establishInitial` is the migration-only
 *  path that may anchor a from-scratch head at any N >= 1. `failFor` simulates a per-id durable-write
 *  failure (e.g. a poisoned/foreign head) so per-row migration resilience can be proven precisely. */
function authorityHeadHarness(failFor: ReadonlySet<string> = new Set()): {
  port: DeliveryAuthorityHeadPort;
  heads: Map<string, DeliveryAuthorityHead>;
} {
  const heads = new Map<string, DeliveryAuthorityHead>();
  const port: DeliveryAuthorityHeadPort = {
    async current(id) {
      const head = heads.get(id);
      return head ? { ...head } : undefined;
    },
    async prepare(id, next, expectedMac) {
      if (failFor.has(id)) throw new Error(`simulated head failure for '${id}'`);
      const current = heads.get(id);
      if (expectedMac === undefined) {
        if (current) {
          if (current.revision === next.revision && current.mac === next.mac) return;
          throw new Error(`authority head '${id}' already exists with different state`);
        }
        if (next.revision !== 1) throw new Error(`initial authority head '${id}' must start at revision 1`);
      } else if (!current || current.mac !== expectedMac || next.revision !== current.revision + 1) {
        throw new Error(`authority head '${id}' changed or attempted a non-monotonic update`);
      }
      heads.set(id, { ...next });
    },
    async establishInitial(id, head) {
      if (failFor.has(id)) throw new Error(`simulated head failure for '${id}'`);
      const current = heads.get(id);
      if (current) {
        if (current.revision === head.revision && current.mac === head.mac) return;
        throw new Error(`authority head '${id}' already exists with different state`);
      }
      heads.set(id, { ...head });
    },
  };
  return { port, heads };
}

afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe("salvage cleanup gaps", () => {
  it("prunes a salvage-abandoned dead delivery from a stale snapshot but refuses a live occupant", async () => {
    const workspace = root();
    const worktree = path.join(workspace, "wt"); fs.mkdirSync(worktree);
    const deliveries = new DeliveryStore(workspace, { now: () => now });
    const gitDeliveries = new GitDeliveryStore(workspace, { now: () => now });
    const created = await deliveries.create(input("d-salvage-prune", true));
    const gd = await gitDeliveries.open({ id: deterministicGitDeliveryId(created.id), workspaceId: "ws", createdBy: system,
      deliveryId: created.id, agent: "worker", branchRef: "tachyon/worker", worktreePath: worktree,
      tachyonCreatedBranch: true, baseRef: "main", currentHeadSha: "tip" });
    await deliveries.update(created.id, created.version, (record) => ({ ...record, gitDeliveryId: gd.id }),
      { operationId: "link", intent: { gitDeliveryId: gd.id } });
    const projected = gd;
    const stale = {
      classifications: [{ deliveryId: created.id, class: "unavailable" as const, reason: "no exact session binding" }],
      byId: new Map([[created.id, { deliveryId: created.id, class: "unavailable" as const, reason: "no exact session binding" }]]),
      unavailableAgents: new Set(["worker"]),
    };
    const fence: ProcessFencePort = { capability: () => ({ supported: false, reason: "unavailable" }),
      freeze: async () => {}, terminate: async () => {}, proveEmpty: async () => ({ state: "unknown", reason: "unavailable" }) };
    const lease = new DeliveryLeaseService({ store: deliveries, processFence: fence, recoveryPrincipals: ["maintainer"],
      canonicalWorktreeFor: () => worktree, readHead: () => "tip",
      inspectWorktree: () => ({ headSha: "tip", clean: true }), isAncestor: () => true,
      processObserver: { observe: () => ({ state: "gone" }) },
      resolveRecoveryApproval: (_id, actor, digest) => ({ decision: "approved", requester: actor.name!, actionDigest: digest,
        payloadHash: "payload", resolvedAt: now }), withWorktreeLock: async (_path, fn) => fn(), now: () => now });
    const abandoned = await lease.abandonWithoutWorktree({ deliveryId: created.id, actor: { kind: "agent", name: "maintainer" },
      operationId: "salvage-abandon", approvalId: "approved" });
    expect(abandoned.lease.state).toBe("abandoned");

    const service = (live: "live" | "not_live", occupied: boolean) => new DeliveryProjectionService({
      deliveries, gitDeliveries, workspaceRoot: workspace, workspaceId: "ws", git: gitFor(worktree),
      liveness: async () => live, worktreeOccupancy: async () => occupied
        ? { state: "live", agent: "worker", cwd: worktree } : undefined,
      withWorktreeLock: async (_path, fn) => fn(), settings: () => ({ prunePrincipals: [], integratePrincipals: [] }),
      loadReloadSnapshot: async () => stale, now: () => now,
    });
    await expect(service("live", true).prune({ deliveryId: created.id, gitDeliveryId: gd.id,
      expectedGitVersion: projected.version, actor: human, caller: humanCaller, abandon: true, operationId: "live-refused" }))
      .rejects.toThrow(/safety class 'unavailable'/);
    const pruned = await service("not_live", false).prune({ deliveryId: created.id, gitDeliveryId: gd.id,
      expectedGitVersion: projected.version, actor: human, caller: humanCaller, abandon: true, operationId: "dead-pruned" });
    expect(pruned.projection.phase).toBe("pruned");
  });

  it("reseals only absent legacy integrity once and keeps freshness and tamper checks closed", async () => {
    const workspace = root();
    const legacy = new DeliveryStore(workspace, { now: () => now });
    await legacy.create(input("d-legacy"));
    const heads = new Map<string, DeliveryAuthorityHead>();
    const store = new DeliveryStore(workspace, { now: () => now, authorityIntegrityKey: () => key, authorityHead: {
      current: async (id) => heads.get(id),
      prepare: async (id, next, expectedMac) => {
        const current = heads.get(id);
        if (expectedMac === undefined ? current !== undefined : current?.mac !== expectedMac) throw new Error("head CAS mismatch");
        heads.set(id, { ...next });
      },
    } });
    const migrated = await store.get("d-legacy");
    expect(migrated?.authorityIntegrity?.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(heads.get("d-legacy")).toEqual({ revision: 1, mac: migrated!.authorityIntegrity!.mac });
    const db = new DatabaseSync(store.databasePath);
    try {
      expect(db.prepare("SELECT value FROM delivery_store_metadata WHERE key = 'authority_legacy_reseal_v1_complete'").get())
        .toEqual({ value: "1" });
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = 'd-legacy'").get() as { record_json: string };
      const unsigned = JSON.parse(row.record_json) as Record<string, unknown>;
      delete unsigned.authorityIntegrity;
      db.prepare("UPDATE deliveries SET record_json = ? WHERE id = 'd-legacy'").run(JSON.stringify(unsigned));
    } finally { db.close(); }
    await expect(store.get("d-legacy")).rejects.toThrow("authority integrity check failed");

    const tamperedRoot = root();
    const unsignedStore = new DeliveryStore(tamperedRoot, { now: () => now });
    await unsignedStore.create(input("d-invalid"));
    await unsignedStore.create(input("d-healthy"));
    const tamperDb = new DatabaseSync(unsignedStore.databasePath);
    try {
      const row = tamperDb.prepare("SELECT record_json FROM deliveries WHERE id = 'd-invalid'").get() as { record_json: string };
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      record.authorityIntegrity = { version: 1, algorithm: "hmac-sha256", mac: "0".repeat(64) };
      tamperDb.prepare("UPDATE deliveries SET record_json = ? WHERE id = 'd-invalid'").run(JSON.stringify(record));
    } finally { tamperDb.close(); }
    const guarded = new DeliveryStore(tamperedRoot, { now: () => now, authorityIntegrityKey: () => key });
    await expect(guarded.get("d-invalid")).rejects.toThrow("authority integrity check failed");
    await expect(guarded.get("d-healthy")).resolves.toMatchObject({ id: "d-healthy" });
    await expect(guarded.listWithCorrupt()).resolves.toMatchObject({
      records: [expect.objectContaining({ id: "d-healthy" })],
      corrupt: [expect.objectContaining({ id: "d-invalid", error: expect.stringContaining("authority integrity check failed") })],
    });
    const verifyDb = new DatabaseSync(guarded.databasePath);
    try {
      expect(verifyDb.prepare("SELECT value FROM delivery_store_metadata WHERE key = 'authority_legacy_reseal_v1_complete'").get())
        .toEqual({ value: "1" });
    } finally { verifyDb.close(); }

    const tornRoot = root();
    const tornLegacy = new DeliveryStore(tornRoot, { now: () => now });
    const torn = await tornLegacy.create(input("d-torn-head"));
    const sealed = sealAuthorityRecord(torn as typeof torn & Record<string, unknown>, key,
      workspaceAuthorityDomain("canonical-delivery", tornRoot));
    const tornHeads = new Map<string, DeliveryAuthorityHead>([[torn.id, {
      revision: torn.version, mac: sealed.authorityIntegrity!.mac,
    }]]);
    const resumed = new DeliveryStore(tornRoot, { now: () => now, authorityIntegrityKey: () => key, authorityHead: {
      current: async (id) => tornHeads.get(id),
      prepare: async () => { throw new Error("already-prepared head must not be prepared twice"); },
    } });
    await expect(resumed.get(torn.id)).resolves.toEqual(sealed);
  });

  it("reseals legacy records already at version > 1, anchoring the authority head at the record's own version", async () => {
    const workspace = root();
    const legacy = new DeliveryStore(workspace, { now: () => now });

    let recordV3 = await legacy.create(input("d-legacy-v3"));
    for (let i = 0; i < 2; i++) {
      recordV3 = await legacy.update(recordV3.id, recordV3.version, (record) => {
        record.events.push({ id: `bump-v3-${i}`, at: now, type: "advanced", by: system });
        return record;
      });
    }
    expect(recordV3.version).toBe(3);

    let recordV25 = await legacy.create(input("d-legacy-v25"));
    for (let i = 0; i < 24; i++) {
      recordV25 = await legacy.update(recordV25.id, recordV25.version, (record) => {
        record.events.push({ id: `bump-v25-${i}`, at: now, type: "advanced", by: system });
        return record;
      });
    }
    expect(recordV25.version).toBe(25);

    const { port, heads } = authorityHeadHarness();
    const store = new DeliveryStore(workspace, { now: () => now, authorityIntegrityKey: () => key, authorityHead: port });

    const migratedV3 = await store.get("d-legacy-v3");
    const migratedV25 = await store.get("d-legacy-v25");
    expect(migratedV3?.authorityIntegrity?.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(migratedV25?.authorityIntegrity?.mac).toMatch(/^[0-9a-f]{64}$/);
    // The initial head lands at the record's own version, not a fixed revision 1.
    expect(heads.get("d-legacy-v3")).toEqual({ revision: 3, mac: migratedV3!.authorityIntegrity!.mac });
    expect(heads.get("d-legacy-v25")).toEqual({ revision: 25, mac: migratedV25!.authorityIntegrity!.mac });
  });

  it("skips a legacy record whose head cannot be established without blocking the rest of the migration or its completion marker", async () => {
    const workspace = root();
    const legacy = new DeliveryStore(workspace, { now: () => now });
    await legacy.create(input("d-bad"));
    await legacy.create(input("d-good"));

    const { port, heads } = authorityHeadHarness(new Set(["d-bad"]));
    const store = new DeliveryStore(workspace, { now: () => now, authorityIntegrityKey: () => key, authorityHead: port });

    // "d-bad" sorts before "d-good", so this also proves an earlier row's failure does not
    // abort the rows that would have been processed after it in the same migration pass.
    await expect(store.get("d-bad")).rejects.toThrow("authority integrity check failed");
    const migratedGood = await store.get("d-good");
    expect(migratedGood?.authorityIntegrity?.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(heads.get("d-good")).toEqual({ revision: 1, mac: migratedGood!.authorityIntegrity!.mac });
    expect(heads.has("d-bad")).toBe(false);

    const db = new DatabaseSync(store.databasePath);
    try {
      // The migration still completed and marked itself done despite the one un-resealable row.
      expect(db.prepare("SELECT value FROM delivery_store_metadata WHERE key = 'authority_legacy_reseal_v1_complete'").get())
        .toEqual({ value: "1" });
      const badRow = db.prepare("SELECT record_json FROM deliveries WHERE id = 'd-bad'").get() as { record_json: string };
      expect(JSON.parse(badRow.record_json)).not.toHaveProperty("authorityIntegrity");
    } finally { db.close(); }
  });
});
