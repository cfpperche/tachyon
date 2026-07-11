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
type DatabaseSync = import("node:sqlite").DatabaseSync;
type DatabaseSyncConstructor = new (location: string, options?: { timeout?: number }) => DatabaseSync;

const legacyMigrationKey = "legacy_json_migration";
const legacyMigrationComplete = "complete-v1";

function sameLegacyImportIntent(existing: Delivery, planned: DeliveryCreateInput & { id: string }): boolean {
  const comparable = (value: DeliveryCreateInput & { id: string }) => ({
    id: value.id, workspaceId: value.workspaceId, createdBy: value.createdBy, contract: value.contract,
    lease: value.lease, segments: value.segments, events: value.events, gitDeliveryId: value.gitDeliveryId,
    legacy: value.legacy,
  });
  return isDeepStrictEqual(comparable(existing), comparable(planned));
}

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
  private readonly Database: DatabaseSyncConstructor;

  constructor(readonly workspaceRoot: string, private readonly opts: DeliveryStoreOptions = {}) {
    this.databasePath = path.join(workspaceRoot, ".tachyon", "deliveries-v2.sqlite3");
    this.dir = path.dirname(this.databasePath);
    this.capability = this.validateCapability();
    this.Database = loadDatabaseSync();
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

  /** Read a committed operation result after a caller lost the response. The higher-level
   * service must validate its domain intent against durable event detail before replaying. */
  async getOperationResult(operationId: string, kind: "create" | "update", deliveryId: string): Promise<Delivery | undefined> {
    assertOperationId(operationId);
    assertDeliveryId(deliveryId);
    return this.withDatabase((db) => {
      const row = db.prepare(`
        SELECT operation_kind, delivery_id, result_json
        FROM delivery_operation_receipts WHERE operation_id = ?
      `).get(operationId) as SqlRow | undefined;
      if (!row) return undefined;
      if (row.operation_kind !== kind || row.delivery_id !== deliveryId) {
        throw new DeliveryInvariantError(`operation id '${operationId}' was already used for another mutation`);
      }
      return structuredClone(parseRecord(String(row.result_json)));
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
      const fingerprint = fingerprintIntent({ kind: "create", input: { ...input, operationId: undefined } });
      const replay = input.operationId && this.readReceipt(db, input.operationId, "create", fingerprint, input.id);
      if (replay) return replay;
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

  /** Atomic deterministic-id reconciliation reserved for the legacy importer. */
  async createLegacyImport(input: DeliveryCreateInput & { id: string }): Promise<Delivery> {
    assertDeliveryId(input.id);
    assertOperationId(input.operationId);
    const now = this.now();
    const record: Delivery = {
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      id: input.id,
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
      const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(input.id) as SqlRow | undefined;
      if (row) {
        const existing = parseRecord(String(row.record_json));
        if (!sameLegacyImportIntent(existing, input)) {
          throw new DeliveryInvariantError(`Delivery '${input.id}' conflicts with the canonical legacy intent`);
        }
        return structuredClone(existing);
      }
      db.prepare("INSERT INTO deliveries(id, record_json) VALUES (?, ?)").run(input.id, JSON.stringify(record));
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
    if (options.operationId !== undefined && options.intent === undefined) {
      throw new DeliveryInvariantError("an explicit serializable intent is required with an update operation id");
    }
    const fingerprint = fingerprintIntent({ kind: "update", id, expectedVersion, intent: options.intent });

    // The caller-controlled computation intentionally runs without a SQLite transaction.
    const observed = await this.get(id);
    if (!observed) throw new DeliveryNotFoundError(id);
    if (observed.version !== expectedVersion) {
      const replay = options.operationId && this.withDatabase((db) => this.readReceipt(db, options.operationId!, "update", fingerprint, id));
      if (replay) return replay;
      throw new DeliveryVersionConflictError(id, expectedVersion, observed.version);
    }
    const candidate = mutate(structuredClone(observed));
    assertAllowedMutation(observed, candidate);
    const updatedAt = this.now();

    return this.writeTransaction((db) => {
      const replay = options.operationId && this.readReceipt(db, options.operationId, "update", fingerprint, id);
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
      if (options.operationId) this.writeReceipt(db, options.operationId, "update", fingerprint, committed, committed.updatedAt);
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
      db = new this.Database(this.databasePath, { timeout: this.opts.busyTimeoutMs ?? 0 });
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
      this.migrateLegacyJson(db);
      return fn(db);
    } catch (error) {
      if (isBusyError(error)) throw new DeliveryStoreBusyError(this.databasePath);
      throw error;
    } finally {
      db?.close();
    }
  }

  private migrateLegacyJson(db: DatabaseSync): void {
    const legacyDir = path.join(this.workspaceRoot, ".tachyon", "deliveries");
    const archiveDir = path.join(this.workspaceRoot, ".tachyon", "deliveries.migrated-v1");
    const marker = db.prepare("SELECT value FROM delivery_store_metadata WHERE key = ?").get(legacyMigrationKey) as SqlRow | undefined;
    if (marker && marker.value !== legacyMigrationComplete) {
      throw new DeliveryInvariantError("legacy Delivery migration has an unsupported or partial state");
    }
    if (!marker) {
      const records = readLegacyRecords(legacyDir);
      db.exec("BEGIN IMMEDIATE");
      try {
        const lockedMarker = db.prepare("SELECT value FROM delivery_store_metadata WHERE key = ?")
          .get(legacyMigrationKey) as SqlRow | undefined;
        if (lockedMarker && lockedMarker.value !== legacyMigrationComplete) {
          throw new DeliveryInvariantError("legacy Delivery migration has an unsupported or partial state");
        }
        if (!lockedMarker) {
          const insert = db.prepare("INSERT INTO deliveries(id, record_json) VALUES (?, ?)");
          for (const record of records) insert.run(record.id, JSON.stringify(record));
          db.prepare("INSERT INTO delivery_store_metadata(key, value) VALUES (?, ?)")
            .run(legacyMigrationKey, legacyMigrationComplete);
        }
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw new DeliveryInvariantError(`legacy Delivery migration refused: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (fs.existsSync(legacyDir)) {
      verifyLegacyMatchesDatabase(db, legacyDir);
      if (fs.existsSync(archiveDir)) throw new DeliveryInvariantError("legacy Delivery migration archive already exists");
      try {
        fs.renameSync(legacyDir, archiveDir);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const completedMarker = db.prepare("SELECT value FROM delivery_store_metadata WHERE key = ?")
          .get(legacyMigrationKey) as SqlRow | undefined;
        if (completedMarker?.value !== legacyMigrationComplete || fs.existsSync(legacyDir) || !fs.existsSync(archiveDir)) {
          throw error;
        }
        verifyLegacyMatchesDatabase(db, archiveDir);
      }
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

  private readReceipt(db: DatabaseSync, operationId: string, kind: string, fingerprint: string, deliveryId?: string): Delivery | undefined {
    const row = db.prepare(`
      SELECT operation_kind, delivery_id, result_json, intent_fingerprint
      FROM delivery_operation_receipts WHERE operation_id = ?
    `).get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    if (row.operation_kind !== kind || row.intent_fingerprint !== fingerprint || (deliveryId !== undefined && row.delivery_id !== deliveryId)) {
      throw new DeliveryInvariantError(`operation id '${operationId}' was already used for another mutation`);
    }
    return structuredClone(parseRecord(String(row.result_json)));
  }

  private writeReceipt(db: DatabaseSync, operationId: string, kind: string, fingerprint: string, result: Delivery, committedAt: string): void {
    db.prepare(`
      INSERT INTO delivery_operation_receipts(operation_id, operation_kind, delivery_id, result_json, intent_fingerprint, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(operationId, kind, result.id, JSON.stringify(result), fingerprint, committedAt);
  }

  private now(): string { return this.opts.now?.() ?? new Date().toISOString(); }
  private newId(): string { return this.opts.id?.() ?? `d-${randomBytes(8).toString("hex")}`; }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function readLegacyRecords(legacyDir: string): Delivery[] {
  if (!fs.existsSync(legacyDir)) return [];
  const entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  const records: Delivery[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name === ".locks") continue;
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new DeliveryInvariantError(`unexpected legacy Delivery entry '${entry.name}'`);
    }
    const file = path.join(legacyDir, entry.name);
    let record: Delivery;
    try {
      record = parseRecord(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new DeliveryInvariantError(`corrupt legacy Delivery '${file}': ${error instanceof Error ? error.message : String(error)}`);
    }
    if (`${record.id}.json` !== entry.name) {
      throw new DeliveryInvariantError(`legacy Delivery filename '${entry.name}' does not match id '${record.id}'`);
    }
    records.push(record);
  }
  return records;
}

function verifyLegacyMatchesDatabase(db: DatabaseSync, legacyDir: string): void {
  for (const legacy of readLegacyRecords(legacyDir)) {
    const row = db.prepare("SELECT record_json FROM deliveries WHERE id = ?").get(legacy.id) as SqlRow | undefined;
    if (!row || !same(parseRecord(String(row.record_json)), legacy)) {
      throw new DeliveryInvariantError(`legacy Delivery '${legacy.id}' does not match the durable migrated record`);
    }
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
