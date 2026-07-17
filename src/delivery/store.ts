import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  DELIVERY_SCHEMA_VERSION,
  type DelegationSegment,
  type Delivery,
  type DeliveryCorruptRecord,
  type DeliveryCreateInput,
  type DeliveryMutationOptions,
  type DeliveryProjectionClaimCapability,
  type DeliveryProjectionOwnerIdentity,
  type DeliveryStoreCapability,
  type DeliveryStoreCapabilityContext,
  type DeliveryStoreCapabilityValidator,
  type StructuredDeliveryStoreError,
} from "./types.js";
import {
  sealAuthorityRecord,
  verifyAuthorityRecord,
  workspaceAuthorityDomain,
  type AuthorityHead,
  type AuthorityHeadPort,
} from "./authorityIntegrity.js";

export class DeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery '${id}' not found`);
    this.name = "DeliveryNotFoundError";
  }
}

export class DeliveryVersionConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Delivery '${id}' version conflict: expected ${expected}, found ${actual}`);
    this.name = "DeliveryVersionConflictError";
  }
}

export class DeliveryInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryInvariantError";
  }
}

export class DeliveryStoreUnsupportedError extends Error implements StructuredDeliveryStoreError {
  readonly code = "DELIVERY_STORE_UNSUPPORTED" as const;
  readonly retryable = false;

  constructor(readonly reason: string) {
    super(`DeliveryStore is unavailable: ${reason}`);
    this.name = "DeliveryStoreUnsupportedError";
  }
}

export class DeliveryStoreBusyError extends Error implements StructuredDeliveryStoreError {
  readonly code = "DELIVERY_STORE_BUSY" as const;
  readonly retryable = true;

  constructor(readonly databasePath: string, message?: string) {
    super(message ?? `DeliveryStore is busy: '${databasePath}'`);
    this.name = "DeliveryStoreBusyError";
  }
}

export class DeliveryProjectionClaimError extends Error implements StructuredDeliveryStoreError {
  readonly code = "DELIVERY_STORE_BUSY" as const;
  readonly retryable = true;

  constructor(readonly deliveryId: string, message: string) {
    super(message);
    this.name = "DeliveryProjectionClaimError";
  }
}

export type DeliveryAuthorityHead = AuthorityHead;
/** Host-custodied freshness anchor. It is deliberately outside the workspace database. */
export type DeliveryAuthorityHeadPort = AuthorityHeadPort;

export interface DeliveryStoreOptions {
  now?: () => string;
  id?: () => string;
  busyTimeoutMs?: number;
  capabilityValidator?: DeliveryStoreCapabilityValidator;
  /** Test seam: override owner identity used when claiming a projection lock. */
  projectionOwnerIdentity?: () => DeliveryProjectionOwnerIdentity;
  /** Test seam: classify an observed claim owner (alive / dead / ambiguous). */
  projectionOwnerStatus?: (owner: DeliveryProjectionOwnerIdentity) => "alive" | "dead" | "ambiguous";
  /** Host SecretStorage key. When configured, every authority read must verify and every write is resealed. */
  authorityIntegrityKey?: () => Buffer | undefined;
  /** Host-custodied anti-rollback head. Requires `authorityIntegrityKey`. */
  authorityHead?: DeliveryAuthorityHeadPort;
}

type SqlRow = Record<string, unknown>;
type DatabaseSync = import("node:sqlite").DatabaseSync;
type DatabaseSyncConstructor = new (location: string, options?: { timeout?: number }) => DatabaseSync;

const STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_store_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO delivery_store_metadata(key, value) VALUES ('schema_version', '1');
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS delivery_operation_receipts (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    intent_fingerprint TEXT NOT NULL,
    committed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS delivery_projection_claims (
    delivery_id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    owner_json TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  ) STRICT;
`;
const LEGACY_RESEAL_MARKER = "authority_legacy_reseal_v1_complete";

/**
 * SQLite is the physical exclusion and crash-recovery mechanism for workspace rows.
 * Caller-controlled work stays outside its short transactions; the host head prepare is the
 * deliberate exception because freshness must become durable before the row can commit.
 */
export class DeliveryStore {
  readonly databasePath: string;
  private readonly capability: DeliveryStoreCapability;
  private readonly Database: DatabaseSyncConstructor;
  private legacyReseal: Promise<void> | undefined;

  constructor(readonly workspaceRoot: string, private readonly opts: DeliveryStoreOptions = {}) {
    this.databasePath = path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3");
    this.capability = this.validateCapability();
    this.Database = loadDatabaseSync();
  }

  /** Canonical verification requires integrity and freshness together when authority is wired. */
  assertVerificationAuthorityReady(): void {
    if (!this.opts.authorityIntegrityKey && !this.opts.authorityHead) return;
    this.authorityKey();
    if (!this.opts.authorityHead) {
      throw new DeliveryInvariantError("Delivery authority freshness head is unavailable for verification");
    }
  }

  async list(): Promise<Delivery[]> {
    return (await this.listWithCorrupt()).records;
  }

  async listWithCorrupt(): Promise<{ records: Delivery[]; corrupt: DeliveryCorruptRecord[] }> {
    // This is the graceful-degradation API: migration trouble must remain per-record below.
    await this.ensureLegacyResealed().catch(() => undefined);
    return this.withDatabaseAsync(async (db) => {
      const records: Delivery[] = [];
      const corrupt: DeliveryCorruptRecord[] = [];
      const rows = db.prepare("SELECT id, record_json FROM deliveries ORDER BY id").all() as SqlRow[];
      for (const row of rows) {
        const id = String(row.id);
        try {
          records.push(await this.parseStoredRecord(String(row.record_json), id));
        } catch (error) {
          corrupt.push({ id, path: this.databasePath, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { records, corrupt };
    });
  }

  async get(id: string): Promise<Delivery | undefined> {
    assertDeliveryId(id);
    await this.ensureLegacyResealed();
    return this.withDatabaseAsync(async (db) => {
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(id) as SqlRow | undefined;
      if (row) return structuredClone(await this.parseStoredRecord(String(row.record_json), id));
      await this.assertAuthorityHeadAbsent(id);
      return undefined;
    });
  }

  /** Read a committed operation result after a caller lost the response. The higher-level
   * service must validate its domain intent against durable event detail before replaying. */
  async getOperationResult(operationId: string, kind: "create" | "update", deliveryId: string): Promise<Delivery | undefined> {
    assertOperationId(operationId);
    assertDeliveryId(deliveryId);
    await this.ensureLegacyResealed();
    return this.withDatabaseAsync(async (db) => {
      const row = db.prepare(`
        SELECT receipt.operation_kind, receipt.delivery_id, receipt.result_json,
               current.record_json AS current_json
        FROM delivery_operation_receipts AS receipt
        LEFT JOIN deliveries AS current ON current.id = receipt.delivery_id
        WHERE receipt.operation_id = ?
      `).get(operationId) as SqlRow | undefined;
      if (!row) return undefined;
      if (row.operation_kind !== kind || row.delivery_id !== deliveryId) {
        throw new DeliveryInvariantError(`operation id '${operationId}' was already used for another mutation`);
      }
      return structuredClone(await this.parseAuthenticatedReceipt(row, operationId, deliveryId));
    });
  }

  async create(input: DeliveryCreateInput): Promise<Delivery> {
    await this.ensureLegacyResealed();
    const id = input.id ?? this.newId();
    assertDeliveryId(id);
    assertOperationId(input.operationId);
    const now = this.now();
    const unsigned: Delivery = {
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      id,
      version: 1,
      workspaceId: input.workspaceId,
      createdBy: structuredClone(input.createdBy),
      contract: structuredClone(input.contract),
      lease: structuredClone(input.lease ?? { state: "free", changedAt: now }),
      segments: structuredClone(input.segments ?? []),
      events: structuredClone(input.events ?? []),
      ...(input.gitDeliveryId ? { gitDeliveryId: input.gitDeliveryId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    validateRecord(unsigned);
    const record = this.sealStoredRecord(unsigned);

    return this.writeAuthorityTransaction(async (db) => {
      // When id was generated, the receipt is how a caller learns that id after response loss.
      const fingerprint = fingerprintIntent({ kind: "create", input: { ...input, operationId: undefined } });
      const replay = input.operationId && await this.readReceipt(db, input.operationId, "create", fingerprint, input.id);
      if (replay) return replay;
      const existing = db.prepare("SELECT id FROM deliveries WHERE id = ?").get(id) as SqlRow | undefined;
      if (existing) throw new DeliveryInvariantError(`Delivery '${id}' already exists`);
      await this.prepareAuthorityHead(record);
      try {
        db.prepare("INSERT INTO deliveries(id, record_json) VALUES (?, ?)").run(id, JSON.stringify(record));
      } catch (error) {
        if (isConstraintError(error)) throw new DeliveryInvariantError(`Delivery '${id}' already exists`);
        throw error;
      }
      if (input.operationId) this.writeReceipt(db, input.operationId, "create", fingerprint, record, now);
      return structuredClone(record);
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    mutate: (record: Delivery) => Delivery,
    options: DeliveryMutationOptions = {},
  ): Promise<Delivery> {
    return this.updateInternal(id, expectedVersion, mutate, options, undefined);
  }

  /**
   * Canonical projection mutations under a held projection claim (SDD 368 T15).
   * Ordinary `update` is refused while a claim exists; only this path may mutate
   * a claimed Delivery, and only with the matching `(deliveryId, nonce)`.
   */
  async updateUnderProjectionClaim(
    claim: DeliveryProjectionClaimCapability,
    expectedVersion: number,
    mutate: (record: Delivery) => Delivery,
    options: DeliveryMutationOptions = {},
  ): Promise<Delivery> {
    assertDeliveryId(claim.deliveryId);
    if (!claim.nonce || typeof claim.nonce !== "string") {
      throw new DeliveryInvariantError("projection claim nonce is required");
    }
    return this.updateInternal(claim.deliveryId, expectedVersion, mutate, options, claim);
  }

  /**
   * Acquire the durable per-Delivery projection claim. Short BEGIN IMMEDIATE only.
   * Same-domain provably-dead owners are reclaimed; live/foreign/ambiguous owners busy-retry.
   */
  async claimProjection(deliveryId: string): Promise<DeliveryProjectionClaimCapability> {
    assertDeliveryId(deliveryId);
    await this.ensureLegacyResealed();
    const owner = this.currentProjectionOwner();
    const nonce = randomBytes(16).toString("hex");
    const claimedAt = this.now();
    return this.writeTransaction((db) => {
      const existing = db.prepare("SELECT delivery_id, nonce, owner_json, claimed_at FROM delivery_projection_claims WHERE delivery_id = ?")
        .get(deliveryId) as SqlRow | undefined;
      if (existing) {
        let existingOwner: DeliveryProjectionOwnerIdentity;
        try {
          existingOwner = parseProjectionOwner(String(existing.owner_json));
        } catch {
          throw new DeliveryProjectionClaimError(deliveryId, `Delivery '${deliveryId}' projection claim owner is malformed`);
        }
        const status = this.ownerStatus(existingOwner);
        if (status !== "dead") {
          throw new DeliveryProjectionClaimError(
            deliveryId,
            `Delivery '${deliveryId}' projection claim is held (${status === "alive" ? "live owner" : "ambiguous owner"})`,
          );
        }
        // Atomic replace of a same-domain provably-dead owner.
        db.prepare("DELETE FROM delivery_projection_claims WHERE delivery_id = ? AND nonce = ?")
          .run(deliveryId, String(existing.nonce));
      }
      const row = db.prepare("SELECT id FROM deliveries WHERE id = ?").get(deliveryId) as SqlRow | undefined;
      if (!row) throw new DeliveryNotFoundError(deliveryId);
      try {
        db.prepare("INSERT INTO delivery_projection_claims(delivery_id, nonce, owner_json, claimed_at) VALUES (?, ?, ?, ?)")
          .run(deliveryId, nonce, JSON.stringify(owner), claimedAt);
      } catch (error) {
        if (isConstraintError(error)) {
          throw new DeliveryProjectionClaimError(deliveryId, `Delivery '${deliveryId}' projection claim is held (concurrent claim)`);
        }
        throw error;
      }
      return { deliveryId, nonce };
    });
  }

  /**
   * Exact release: deletes only the matching `(deliveryId, nonce)`. A successor claim is never deleted.
   */
  async releaseProjection(claim: DeliveryProjectionClaimCapability): Promise<void> {
    assertDeliveryId(claim.deliveryId);
    await this.ensureLegacyResealed();
    if (!claim.nonce) throw new DeliveryInvariantError("projection claim nonce is required");
    this.writeTransaction((db) => {
      db.prepare("DELETE FROM delivery_projection_claims WHERE delivery_id = ? AND nonce = ?")
        .run(claim.deliveryId, claim.nonce);
    });
  }

  async getProjectionClaim(deliveryId: string): Promise<{ deliveryId: string; nonce: string; owner: DeliveryProjectionOwnerIdentity; claimedAt: string } | undefined> {
    assertDeliveryId(deliveryId);
    await this.ensureLegacyResealed();
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT delivery_id, nonce, owner_json, claimed_at FROM delivery_projection_claims WHERE delivery_id = ?")
        .get(deliveryId) as SqlRow | undefined;
      if (!row) return undefined;
      return {
        deliveryId: String(row.delivery_id),
        nonce: String(row.nonce),
        owner: parseProjectionOwner(String(row.owner_json)),
        claimedAt: String(row.claimed_at),
      };
    });
  }

  private async updateInternal(
    id: string,
    expectedVersion: number,
    mutate: (record: Delivery) => Delivery,
    options: DeliveryMutationOptions,
    claim: DeliveryProjectionClaimCapability | undefined,
  ): Promise<Delivery> {
    assertDeliveryId(id);
    await this.ensureLegacyResealed();
    assertOperationId(options.operationId);
    if (options.operationId !== undefined && options.intent === undefined) {
      throw new DeliveryInvariantError("an explicit serializable intent is required with an update operation id");
    }
    const fingerprint = fingerprintIntent({ kind: "update", id, expectedVersion, intent: options.intent });

    // The caller-controlled computation intentionally runs without a SQLite transaction.
    const observed = await this.get(id);
    if (!observed) throw new DeliveryNotFoundError(id);
    if (observed.version !== expectedVersion) {
      const replay = options.operationId && await this.withDatabaseAsync((db) => this.readReceipt(
        db, options.operationId!, "update", fingerprint, id, true,
      ));
      if (replay) return replay;
      throw new DeliveryVersionConflictError(id, expectedVersion, observed.version);
    }
    const candidate = mutate(structuredClone(observed));
    assertAllowedMutation(observed, candidate);
    const updatedAt = this.now();

    return this.writeAuthorityTransaction(async (db) => {
      const replay = options.operationId && await this.readReceipt(db, options.operationId, "update", fingerprint, id, true);
      if (replay) return replay;
      const claimRow = db.prepare("SELECT nonce FROM delivery_projection_claims WHERE delivery_id = ?").get(id) as SqlRow | undefined;
      if (claim) {
        if (!claimRow || String(claimRow.nonce) !== claim.nonce) {
          throw new DeliveryProjectionClaimError(id, `Delivery '${id}' projection claim is missing or nonce-mismatched`);
        }
      } else if (claimRow) {
        throw new DeliveryProjectionClaimError(
          id,
          `Delivery '${id}' has an active projection claim; ordinary update is refused`,
        );
      }
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new DeliveryNotFoundError(id);
      const current = await this.parseStoredRecord(String(row.record_json), id);
      if (current.version !== expectedVersion) throw new DeliveryVersionConflictError(id, expectedVersion, current.version);
      // Revalidate against the state protected by BEGIN IMMEDIATE, not only the earlier snapshot.
      assertAllowedMutation(current, candidate);
      const unsignedCommitted = structuredClone(candidate);
      unsignedCommitted.version = current.version + 1;
      unsignedCommitted.updatedAt = updatedAt;
      validateRecord(unsignedCommitted);
      const committed = this.sealStoredRecord(unsignedCommitted);
      await this.prepareAuthorityHead(committed, current);
      const changed = db.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(JSON.stringify(committed), id);
      if (Number(changed.changes) !== 1) throw new DeliveryNotFoundError(id);
      if (options.operationId) this.writeReceipt(db, options.operationId, "update", fingerprint, committed, committed.updatedAt);
      return structuredClone(committed);
    });
  }

  private currentProjectionOwner(): DeliveryProjectionOwnerIdentity {
    if (this.opts.projectionOwnerIdentity) return this.opts.projectionOwnerIdentity();
    return readLocalProjectionOwnerIdentity();
  }

  private ownerStatus(owner: DeliveryProjectionOwnerIdentity): "alive" | "dead" | "ambiguous" {
    if (this.opts.projectionOwnerStatus) return this.opts.projectionOwnerStatus(owner);
    return classifyProjectionOwner(owner);
  }

  private validateCapability(): DeliveryStoreCapability {
    let filesystemType: number;
    try {
      filesystemType = Number(fs.statfsSync(this.workspaceRoot).type);
    } catch (error) {
      throw new DeliveryStoreUnsupportedError(`workspace filesystem cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
    const context: DeliveryStoreCapabilityContext = {
      workspaceRoot: fs.realpathSync(this.workspaceRoot),
      databasePath: this.databasePath,
      runtimeNodeVersion: process.versions.node,
      filesystemType,
    };
    const capability = (this.opts.capabilityValidator ?? validateKnownLocalDomain)(context);
    if (!capability.supported) throw new DeliveryStoreUnsupportedError(capability.reason);
    return capability;
  }

  private withDatabase<T>(fn: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      db = this.openDatabase();
      return fn(db);
    } catch (error) {
      return this.rethrowDatabaseError(error);
    } finally {
      db?.close();
    }
  }

  private async withDatabaseAsync<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
    let db: DatabaseSync | undefined;
    try {
      db = this.openDatabase();
      return await fn(db);
    } catch (error) {
      return this.rethrowDatabaseError(error);
    } finally {
      db?.close();
    }
  }

  private openDatabase(): DatabaseSync {
    if (!this.capability.supported) throw new DeliveryStoreUnsupportedError("locking domain is unavailable");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const db = new this.Database(this.databasePath, { timeout: this.opts.busyTimeoutMs ?? 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      db.exec(STORE_SCHEMA);
      const receiptColumns = db.prepare("PRAGMA table_info(delivery_operation_receipts)").all() as SqlRow[];
      if (!receiptColumns.some((column) => column.name === "intent_fingerprint")) {
        const receiptCount = db.prepare("SELECT count(*) AS count FROM delivery_operation_receipts").get() as SqlRow;
        if (Number(receiptCount.count) !== 0) {
          throw new DeliveryInvariantError("existing operation receipts lack intent fingerprints");
        }
        db.exec("ALTER TABLE delivery_operation_receipts ADD COLUMN intent_fingerprint TEXT");
      }
      const settings = db.prepare(`
        SELECT
          (SELECT value FROM delivery_store_metadata WHERE key = 'schema_version') AS schema_version,
          (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
          (SELECT synchronous FROM pragma_synchronous) AS synchronous
      `).get() as SqlRow;
      if (settings.schema_version !== "1") throw new DeliveryInvariantError("unsupported DeliveryStore schema version");
      if (settings.journal_mode !== "delete" || Number(settings.synchronous) !== 2) {
        throw new DeliveryStoreUnsupportedError("SQLite DELETE journal with FULL synchronous durability could not be established");
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private rethrowDatabaseError(error: unknown): never {
    if (isBusyError(error)) throw new DeliveryStoreBusyError(this.databasePath);
    throw error;
  }

  private writeTransaction<T>(fn: (db: DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * Authority mutations intentionally hold SQLite's writer lock across the host
   * head prepare. The external freshness anchor becomes durable first; only
   * then may the workspace row and its receipt become visible atomically.
   */
  private async writeAuthorityTransaction<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
    return this.withDatabaseAsync(async (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** Implicit `update()` replay has no domain projection step of its own, so it may return only an
   * exact current receipt. Explicit historical recovery remains `getOperationResult()` plus the
   * caller's domain-specific current projection validation. */
  private async readReceipt(
    db: DatabaseSync,
    operationId: string,
    kind: string,
    fingerprint: string,
    deliveryId?: string,
    requireCurrentAuthority = false,
  ): Promise<Delivery | undefined> {
    const row = db.prepare(`
      SELECT receipt.operation_kind, receipt.delivery_id, receipt.result_json, receipt.intent_fingerprint,
             current.record_json AS current_json
      FROM delivery_operation_receipts AS receipt
      LEFT JOIN deliveries AS current ON current.id = receipt.delivery_id
      WHERE receipt.operation_id = ?
    `).get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    if (row.operation_kind !== kind || row.intent_fingerprint !== fingerprint || (deliveryId !== undefined && row.delivery_id !== deliveryId)) {
      throw new DeliveryInvariantError(`operation id '${operationId}' was already used for another mutation`);
    }
    return structuredClone(await this.parseAuthenticatedReceipt(
      row,
      operationId,
      String(row.delivery_id),
      requireCurrentAuthority,
    ));
  }

  /** A receipt is immutable historical proof, never a standalone freshness anchor. Before it
   * can be replayed, the same SQLite snapshot must also contain a currently authenticated row. */
  private async parseAuthenticatedReceipt(
    row: SqlRow,
    operationId: string,
    deliveryId: string,
    requireCurrentAuthority = false,
  ): Promise<Delivery> {
    if (row.current_json === undefined || row.current_json === null) {
      throw new DeliveryInvariantError(
        `operation id '${operationId}' refers to Delivery '${deliveryId}' without a current authority row`,
      );
    }
    const current = await this.parseStoredRecord(String(row.current_json), deliveryId);
    const receipt = await this.parseStoredRecord(String(row.result_json), deliveryId, true);
    if (requireCurrentAuthority && !same(current, receipt)) {
      throw new DeliveryInvariantError(
        `operation id '${operationId}' is a historical receipt that no longer matches current Delivery '${deliveryId}' authority`,
      );
    }
    return receipt;
  }

  private writeReceipt(db: DatabaseSync, operationId: string, kind: string, fingerprint: string, result: Delivery, committedAt: string): void {
    db.prepare(`
      INSERT INTO delivery_operation_receipts(operation_id, operation_kind, delivery_id, result_json, intent_fingerprint, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, kind, result.id, JSON.stringify(result), fingerprint, committedAt);
  }

  private authorityKey(): Buffer | undefined {
    if (!this.opts.authorityIntegrityKey) {
      if (this.opts.authorityHead) {
        throw new DeliveryInvariantError("Delivery authority head requires an authority integrity key");
      }
      return undefined;
    }
    const key = this.opts.authorityIntegrityKey();
    if (!key) throw new DeliveryInvariantError("Delivery authority integrity key is unavailable");
    return key;
  }

  private sealStoredRecord(record: Delivery): Delivery {
    const key = this.authorityKey();
    return key
      ? sealAuthorityRecord(record as Delivery & Record<string, unknown>, key, this.authorityDomain())
      : record;
  }

  private async parseStoredRecord(json: string, expectedId: string, historicalReceipt = false): Promise<Delivery> {
    const record = parseRecord(json);
    if (record.id !== expectedId) {
      throw new DeliveryInvariantError(
        `Delivery row identity '${expectedId}' does not match payload identity '${record.id}'`,
      );
    }
    const key = this.authorityKey();
    if (key && !verifyAuthorityRecord(record as Delivery & Record<string, unknown>, key, this.authorityDomain())) {
      throw new DeliveryInvariantError(`Delivery '${record.id}' authority integrity check failed`);
    }
    if (!historicalReceipt && this.opts.authorityHead) await this.assertAuthorityHead(record);
    return record;
  }

  /** One-time upgrade boundary for rows created before authority MACs existed. */
  private async ensureLegacyResealed(): Promise<void> {
    if (!this.opts.authorityIntegrityKey) return;
    this.legacyReseal ??= this.migrateLegacyUnsignedRecords();
    try {
      await this.legacyReseal;
    } catch (error) {
      this.legacyReseal = undefined;
      throw error;
    }
  }

  private async migrateLegacyUnsignedRecords(): Promise<void> {
    const key = this.authorityKey();
    if (!key) return;
    await this.writeAuthorityTransaction(async (db) => {
      const complete = db.prepare("SELECT value FROM delivery_store_metadata WHERE key = ?")
        .get(LEGACY_RESEAL_MARKER) as SqlRow | undefined;
      if (complete?.value === "1") return;

      const rows = db.prepare("SELECT id, record_json FROM deliveries ORDER BY id").all() as SqlRow[];
      const unsigned: Array<{ id: string; sealed: Delivery }> = [];
      for (const row of rows) {
        const id = String(row.id);
        let raw: unknown;
        try { raw = JSON.parse(String(row.record_json)); } catch { continue; }
        if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).authorityIntegrity !== undefined) continue;
        try {
          const record = parseRecord(String(row.record_json));
          if (record.id !== id) continue;
          unsigned.push({ id, sealed: sealAuthorityRecord(record as Delivery & Record<string, unknown>, key, this.authorityDomain()) });
        } catch {
          // Invalid legacy payloads remain isolated by parseStoredRecord/listWithCorrupt.
        }
      }

      for (const entry of unsigned) {
        try {
          const port = this.opts.authorityHead;
          if (port) {
            const next = this.headFor(entry.sealed);
            const current = await port.current(entry.id);
            if (current === undefined) {
              // A migrating record is already at its true version N (possibly > 1); establish the
              // first head there rather than through the ordinary create-only revision-1 path.
              if (port.establishInitial) await port.establishInitial(entry.id, next);
              else await port.prepare(entry.id, next);
              if (!sameAuthorityHead(await port.current(entry.id), next)) {
                throw new DeliveryInvariantError(`Delivery '${entry.id}' authority head prepare was not durable or exact`);
              }
            } else if (!sameAuthorityHead(current, next)) {
              // A foreign/mismatched head is corruption for this row, not a store-wide outage.
              continue;
            }
          }
          db.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?")
            .run(JSON.stringify(entry.sealed), entry.id);
        } catch {
          // One record's reseal/head-establish failure must never brick the rest of the store: leave
          // it unsigned (it still hard-fails on read via parseStoredRecord/listWithCorrupt, tamper-safe)
          // and continue so every other row and the completion marker below still land.
        }
      }
      db.prepare("INSERT INTO delivery_store_metadata(key, value) VALUES (?, '1')")
        .run(LEGACY_RESEAL_MARKER);
    });
  }

  private async prepareAuthorityHead(nextRecord: Delivery, expectedRecord?: Delivery): Promise<void> {
    const key = this.authorityKey();
    const port = this.opts.authorityHead;
    if (!port) return;
    if (!key) throw new DeliveryInvariantError("Delivery authority head requires an authority integrity key");

    const next = this.headFor(nextRecord);
    let expectedMac: string | undefined;
    if (expectedRecord) {
      await this.assertAuthorityHead(expectedRecord);
      expectedMac = this.headFor(expectedRecord).mac;
    } else if (await port.current(nextRecord.id) !== undefined) {
      throw new DeliveryInvariantError(`Delivery '${nextRecord.id}' authority head expected no current revision`);
    }

    await port.prepare(nextRecord.id, next, expectedMac);
    const prepared = await port.current(nextRecord.id);
    if (!sameAuthorityHead(prepared, next)) {
      throw new DeliveryInvariantError(`Delivery '${nextRecord.id}' authority head prepare was not durable or exact`);
    }
  }

  private async assertAuthorityHead(record: Delivery): Promise<void> {
    const port = this.opts.authorityHead;
    if (!port) return;
    const expected = this.headFor(record);
    if (!sameAuthorityHead(await port.current(record.id), expected)) {
      throw new DeliveryInvariantError(`Delivery '${record.id}' authority head mismatch (rollback or incomplete commit)`);
    }
  }

  private async assertAuthorityHeadAbsent(id: string): Promise<void> {
    const key = this.authorityKey();
    if (!this.opts.authorityHead) return;
    if (!key) throw new DeliveryInvariantError("Delivery authority head requires an authority integrity key");
    if (await this.opts.authorityHead.current(id) !== undefined) {
      throw new DeliveryInvariantError(`Delivery '${id}' is absent while its authority head still exists`);
    }
  }

  private headFor(record: Delivery): DeliveryAuthorityHead {
    const mac = record.authorityIntegrity?.mac;
    if (!mac || !/^[0-9a-f]{64}$/.test(mac)) {
      throw new DeliveryInvariantError(`Delivery '${record.id}' has no valid authority MAC for its freshness head`);
    }
    return { revision: record.version, mac };
  }

  private now(): string { return this.opts.now?.() ?? new Date().toISOString(); }
  private newId(): string { return this.opts.id?.() ?? `d-${randomBytes(8).toString("hex")}`; }
  private authorityDomain(): string { return workspaceAuthorityDomain("canonical-delivery", this.workspaceRoot); }
}

function sameAuthorityHead(actual: DeliveryAuthorityHead | undefined, expected: DeliveryAuthorityHead): boolean {
  return actual?.revision === expected.revision && actual.mac === expected.mac;
}

function validateKnownLocalDomain(context: DeliveryStoreCapabilityContext): DeliveryStoreCapability {
  const major = Number.parseInt(context.runtimeNodeVersion.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 22) {
    return { supported: false, reason: `node:sqlite requires a supported extension runtime (found ${context.runtimeNodeVersion})` };
  }
  // Explicit local-domain allowlist. Unknown and common remote filesystems are refused rather than guessed safe.
  const localFilesystems = new Map<number, string>([
    [0xef53, "ext2/ext3/ext4"],
    [0x01021994, "tmpfs"],
    [0x58465342, "xfs"],
    [0x9123683e, "btrfs"],
    [0x794c7630, "overlayfs"],
  ]);
  const domain = localFilesystems.get(context.filesystemType);
  return domain
    ? { supported: true, domain }
    : { supported: false, reason: `filesystem locking domain 0x${context.filesystemType.toString(16)} is not certified local` };
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    const require = createRequire(path.join(process.cwd(), "tachyon-delivery-store-loader.cjs"));
    const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseSyncConstructor };
    if (typeof sqlite.DatabaseSync !== "function") throw new Error("DatabaseSync is unavailable");
    return sqlite.DatabaseSync;
  } catch (error) {
    throw new DeliveryStoreUnsupportedError(`node:sqlite is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fingerprintIntent(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DeliveryInvariantError("operation intent must contain only finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new DeliveryInvariantError("operation intent must be JSON-serializable");
}

function parseRecord(json: string): Delivery {
  let record: Delivery;
  try {
    record = JSON.parse(json) as Delivery;
  } catch (error) {
    throw new DeliveryInvariantError(`invalid Delivery JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRecord(record);
  return record;
}

function assertAllowedMutation(current: Delivery, next: Delivery): void {
  if (next.id !== current.id || next.schemaVersion !== current.schemaVersion || next.workspaceId !== current.workspaceId
    || !same(next.createdBy, current.createdBy) || next.createdAt !== current.createdAt) {
    throw new DeliveryInvariantError("Delivery identity and creation provenance are immutable");
  }
  if (!same(next.contract, current.contract)) throw new DeliveryInvariantError("Delivery contract is immutable");
  if (next.version !== current.version || next.updatedAt !== current.updatedAt) {
    throw new DeliveryInvariantError("store-owned version/timestamps cannot be mutated");
  }
  if (!isPrefix(current.events, next.events)) throw new DeliveryInvariantError("Delivery events are append-only");
  assertSegmentMutation(current.segments, next.segments);
}

function assertSegmentMutation(current: DelegationSegment[], next: DelegationSegment[]): void {
  if (next.length < current.length || next.length > current.length + 1) {
    throw new DeliveryInvariantError("segment history may append only one segment per mutation");
  }
  const tailIndex = current.length - 1;
  for (let index = 0; index < Math.max(0, tailIndex); index++) {
    if (!same(current[index], next[index])) throw new DeliveryInvariantError("completed segment history is immutable");
  }
  if (current.length) {
    const before = current[tailIndex]!;
    const after = next[tailIndex]!;
    if (!same(before, after) && !(!before.releasedAt && isTailClosure(before, after))) {
      throw new DeliveryInvariantError("only the open tail segment may be closed");
    }
  }
  if (next.length === current.length + 1 && current.length && !next[tailIndex]!.releasedAt) {
    throw new DeliveryInvariantError("a new segment requires the current tail to be closed");
  }
}

function isTailClosure(before: DelegationSegment, after: DelegationSegment): boolean {
  const { releasedAt: _a, releasedHeadSha: _h, outcome: _o, ...beforeStable } = before;
  const { releasedAt, releasedHeadSha, outcome, ...afterStable } = after;
  return same(beforeStable, afterStable) && typeof releasedAt === "string" && typeof releasedHeadSha === "string" && typeof outcome === "string";
}

function validateRecord(record: Delivery): void {
  if (!record || record.schemaVersion !== DELIVERY_SCHEMA_VERSION || typeof record.id !== "string" || !Number.isSafeInteger(record.version)
    || record.version < 1 || typeof record.workspaceId !== "string" || !record.contract || !record.lease
    || !Array.isArray(record.segments) || !Array.isArray(record.events)) {
    throw new DeliveryInvariantError("invalid Delivery record shape");
  }
  assertDeliveryId(record.id);
  if (!["free", "pending", "held", "draining", "verifying", "quarantined", "abandoned"].includes(record.lease.state)) {
    throw new DeliveryInvariantError("invalid Delivery lease state");
  }
  if (!record.contract.baseSha || !record.contract.behaviorTest || !record.contract.taskRef || !Array.isArray(record.contract.owns)) {
    throw new DeliveryInvariantError("invalid Delivery contract");
  }
  const segmentIds = new Set<string>();
  record.segments.forEach((segment, index) => {
    if (segment.index !== index || !segment.id || segmentIds.has(segment.id)) {
      throw new DeliveryInvariantError("segment ids and indexes must be unique, contiguous, and stable");
    }
    segmentIds.add(segment.id);
    if ((segment.releasedAt || segment.releasedHeadSha || segment.outcome)
      && !(segment.releasedAt && segment.releasedHeadSha && segment.outcome)) {
      throw new DeliveryInvariantError("segment closure fields must be recorded together");
    }
    if (index < record.segments.length - 1 && !segment.releasedAt) {
      throw new DeliveryInvariantError("only the tail segment may remain open");
    }
  });
  const eventIds = new Set<string>();
  for (const event of record.events) {
    if (!event.id || eventIds.has(event.id)) throw new DeliveryInvariantError("Delivery event ids must be unique");
    eventIds.add(event.id);
  }
  const verification = record.lease.verification;
  if (record.lease.state === "verifying") {
    if (!verification || !verification.nonce || !verification.ownerEpoch || !verification.subjectSegmentId
      || !verification.deliveredHeadSha || !verification.startedAt || !verification.operationId
      || !["free", "held"].includes(verification.priorLease?.state)) {
      throw new DeliveryInvariantError("verifying lease requires a complete durable verification intent");
    }
    if (verification.priorLease.state === "held" && !verification.priorLease.holder) {
      throw new DeliveryInvariantError("held verification snapshot requires its exact prior holder");
    }
    if (verification.priorLease.state === "free" && verification.priorLease.holder) {
      throw new DeliveryInvariantError("free verification snapshot cannot carry a holder");
    }
    if (!same(record.lease.holder, verification.priorLease.holder)) {
      throw new DeliveryInvariantError("verifying lease must retain the exact prior held holder only");
    }
  } else if (verification) {
    throw new DeliveryInvariantError("verification intent is valid only while the lease is verifying");
  }
  if (record.lease.state === "abandoned") {
    if (record.lease.holder || record.lease.expectedHeadSha || record.lease.verification || record.segments.length === 0
      || record.segments.some((segment) => !segment.releasedAt)) {
      throw new DeliveryInvariantError("abandoned lease requires closed history and no active boundary");
    }
  }
}

function isPrefix<T>(before: T[], after: T[]): boolean {
  return after.length >= before.length && before.every((value, index) => same(value, after[index]));
}

function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }

function assertDeliveryId(id: string): void {
  if (!/^d-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new DeliveryInvariantError(`invalid Delivery id '${id}'`);
}

function assertOperationId(operationId: string | undefined): void {
  if (operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(operationId)) {
    throw new DeliveryInvariantError(`invalid operation id '${operationId}'`);
  }
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ERR_SQLITE_BUSY" || code === "SQLITE_BUSY" || /database (?:is )?(?:locked|busy)/i.test(error.message);
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ERR_SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT" || /constraint failed/i.test(error.message);
}

function parseProjectionOwner(json: string): DeliveryProjectionOwnerIdentity {
  let owner: DeliveryProjectionOwnerIdentity;
  try {
    owner = JSON.parse(json) as DeliveryProjectionOwnerIdentity;
  } catch {
    throw new DeliveryInvariantError("malformed projection claim owner JSON");
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.processStart !== "string" || !owner.processStart
    || typeof owner.bootId !== "string" || !owner.bootId
    || typeof owner.pidNamespace !== "string" || !owner.pidNamespace) {
    throw new DeliveryInvariantError("malformed projection claim owner identity");
  }
  return owner;
}

/** Read this process's durable projection-owner identity (PID, start, boot, PID-ns). */
export function readLocalProjectionOwnerIdentity(): DeliveryProjectionOwnerIdentity {
  const pid = process.pid;
  let processStart: string;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) throw new Error("malformed stat");
    const after = stat.slice(close + 2).trimStart().split(/\s+/);
    processStart = after[19] ?? "";
    if (!/^\d+$/.test(processStart)) throw new Error("malformed process start");
  } catch (error) {
    throw new DeliveryStoreUnsupportedError(
      `projection claim owner processStart unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let bootId: string;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    throw new DeliveryStoreUnsupportedError(
      `projection claim owner bootId unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!bootId) throw new DeliveryStoreUnsupportedError("projection claim owner bootId empty");
  let pidNamespace: string;
  try {
    pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  } catch (error) {
    throw new DeliveryStoreUnsupportedError(
      `projection claim owner pidNamespace unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!pidNamespace) throw new DeliveryStoreUnsupportedError("projection claim owner pidNamespace empty");
  return { pid, processStart, bootId, pidNamespace };
}

/**
 * Classify a durable claim owner. Same boot+PID-namespace with a missing process is dead and reclaimable.
 * Live, foreign domain, PID-reuse, unreadable, or malformed observations are ambiguous (busy).
 */
export function classifyProjectionOwner(owner: DeliveryProjectionOwnerIdentity): "alive" | "dead" | "ambiguous" {
  let currentBoot: string;
  let currentNs: string;
  try {
    currentBoot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    currentNs = fs.readlinkSync("/proc/self/ns/pid");
  } catch {
    return "ambiguous";
  }
  if (!currentBoot || !currentNs) return "ambiguous";
  if (owner.bootId !== currentBoot || owner.pidNamespace !== currentNs) return "ambiguous";

  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${owner.pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "dead";
    return "ambiguous";
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return "ambiguous";
  const after = stat.slice(close + 2).trimStart().split(/\s+/);
  const processStart = after[19];
  if (!processStart || !/^\d+$/.test(processStart)) return "ambiguous";
  if (processStart === owner.processStart) return "alive";
  // PID reused by a different process in the same domain — never auto-reclaim.
  return "ambiguous";
}
