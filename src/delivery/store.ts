import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  DELIVERY_SCHEMA_VERSION,
  type DelegationSegment,
  type Delivery,
  type DeliveryCorruptRecord,
  type DeliveryCreateInput,
  type DeliveryMutationOptions,
  type DeliveryStoreCapability,
  type DeliveryStoreCapabilityContext,
  type DeliveryStoreCapabilityValidator,
  type StructuredDeliveryStoreError,
} from "./types.js";

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

  constructor(readonly databasePath: string) {
    super(`DeliveryStore is busy: '${databasePath}'`);
    this.name = "DeliveryStoreBusyError";
  }
}

export interface DeliveryStoreOptions {
  now?: () => string;
  id?: () => string;
  busyTimeoutMs?: number;
  capabilityValidator?: DeliveryStoreCapabilityValidator;
}

type SqlRow = Record<string, unknown>;

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
    committed_at TEXT NOT NULL
  ) STRICT;
`;

/**
 * SQLite is the sole physical exclusion and crash-recovery mechanism for this store.
 * Long-running work belongs before/after these methods, never inside their short write transaction.
 */
export class DeliveryStore {
  readonly databasePath: string;
  /** Kept as a compatibility alias for callers that displayed the old backing location. */
  readonly dir: string;
  private readonly capability: DeliveryStoreCapability;

  constructor(readonly workspaceRoot: string, private readonly opts: DeliveryStoreOptions = {}) {
    this.databasePath = path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3");
    this.dir = path.dirname(this.databasePath);
    this.capability = this.validateCapability();
  }

  async list(): Promise<Delivery[]> {
    return (await this.listWithCorrupt()).records;
  }

  async listWithCorrupt(): Promise<{ records: Delivery[]; corrupt: DeliveryCorruptRecord[] }> {
    return this.withDatabase((db) => {
      const records: Delivery[] = [];
      const corrupt: DeliveryCorruptRecord[] = [];
      const rows = db.prepare("SELECT id, record_json FROM deliveries ORDER BY id").all() as SqlRow[];
      for (const row of rows) {
        const id = String(row.id);
        try {
          records.push(parseRecord(String(row.record_json)));
        } catch (error) {
          corrupt.push({ id, path: this.databasePath, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { records, corrupt };
    });
  }

  async get(id: string): Promise<Delivery | undefined> {
    assertDeliveryId(id);
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(id) as SqlRow | undefined;
      return row ? structuredClone(parseRecord(String(row.record_json))) : undefined;
    });
  }

  async create(input: DeliveryCreateInput): Promise<Delivery> {
    const id = input.id ?? this.newId();
    assertDeliveryId(id);
    assertOperationId(input.operationId);
    const now = this.now();
    const record: Delivery = {
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
      ...(input.legacy ? { legacy: structuredClone(input.legacy) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    validateRecord(record);

    return this.writeTransaction((db) => {
      // When id was generated, the receipt is how a caller learns that id after response loss.
      const replay = input.operationId && this.readReceipt(db, input.operationId, "create", input.id);
      if (replay) return replay;
      try {
        db.prepare("INSERT INTO deliveries(id, record_json) VALUES (?, ?)").run(id, JSON.stringify(record));
      } catch (error) {
        if (isConstraintError(error)) throw new DeliveryInvariantError(`Delivery '${id}' already exists`);
        throw error;
      }
      if (input.operationId) this.writeReceipt(db, input.operationId, "create", record, now);
      return structuredClone(record);
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    mutate: (record: Delivery) => Delivery,
    options: DeliveryMutationOptions = {},
  ): Promise<Delivery> {
    assertDeliveryId(id);
    assertOperationId(options.operationId);

    // The caller-controlled computation intentionally runs without a SQLite transaction.
    const observed = await this.get(id);
    if (!observed) throw new DeliveryNotFoundError(id);
    if (observed.version !== expectedVersion) {
      const replay = options.operationId && this.withDatabase((db) => this.readReceipt(db, options.operationId!, "update", id));
      if (replay) return replay;
      throw new DeliveryVersionConflictError(id, expectedVersion, observed.version);
    }
    const candidate = mutate(structuredClone(observed));
    assertAllowedMutation(observed, candidate);
    const updatedAt = this.now();

    return this.writeTransaction((db) => {
      const replay = options.operationId && this.readReceipt(db, options.operationId, "update", id);
      if (replay) return replay;
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(id) as SqlRow | undefined;
      if (!row) throw new DeliveryNotFoundError(id);
      const current = parseRecord(String(row.record_json));
      if (current.version !== expectedVersion) throw new DeliveryVersionConflictError(id, expectedVersion, current.version);
      // Revalidate against the state protected by BEGIN IMMEDIATE, not only the earlier snapshot.
      assertAllowedMutation(current, candidate);
      const committed = structuredClone(candidate);
      committed.version = current.version + 1;
      committed.updatedAt = updatedAt;
      validateRecord(committed);
      const changed = db.prepare("UPDATE deliveries SET record_json = ? WHERE id = ?").run(JSON.stringify(committed), id);
      if (Number(changed.changes) !== 1) throw new DeliveryNotFoundError(id);
      if (options.operationId) this.writeReceipt(db, options.operationId, "update", committed, committed.updatedAt);
      return structuredClone(committed);
    });
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
    if (!this.capability.supported) throw new DeliveryStoreUnsupportedError("locking domain is unavailable");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.databasePath, { timeout: this.opts.busyTimeoutMs ?? 0 });
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      db.exec(STORE_SCHEMA);
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
      return fn(db);
    } catch (error) {
      if (isBusyError(error)) throw new DeliveryStoreBusyError(this.databasePath);
      throw error;
    } finally {
      db?.close();
    }
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

  private readReceipt(db: DatabaseSync, operationId: string, kind: string, deliveryId?: string): Delivery | undefined {
    const row = db.prepare(`
      SELECT operation_kind, delivery_id, result_json
      FROM delivery_operation_receipts WHERE operation_id = ?
    `).get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    if (row.operation_kind !== kind || (deliveryId !== undefined && row.delivery_id !== deliveryId)) {
      throw new DeliveryInvariantError(`operation id '${operationId}' was already used for another mutation`);
    }
    return structuredClone(parseRecord(String(row.result_json)));
  }

  private writeReceipt(db: DatabaseSync, operationId: string, kind: string, result: Delivery, committedAt: string): void {
    db.prepare(`
      INSERT INTO delivery_operation_receipts(operation_id, operation_kind, delivery_id, result_json, committed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(operationId, kind, result.id, JSON.stringify(result), committedAt);
  }

  private now(): string { return this.opts.now?.() ?? new Date().toISOString(); }
  private newId(): string { return this.opts.id?.() ?? `d-${randomBytes(8).toString("hex")}`; }
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
