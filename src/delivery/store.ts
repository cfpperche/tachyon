import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DELIVERY_SCHEMA_VERSION,
  type DelegationSegment,
  type Delivery,
  type DeliveryActor,
  type DeliveryCorruptRecord,
  type DeliveryCreateInput,
  type DeliveryLockOwner,
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

export class DeliveryLockUnavailableError extends Error {
  constructor(id: string, reason: "occupied" | "ambiguous" | "corrupt") {
    super(`Delivery '${id}' lock unavailable: ${reason}`);
    this.name = "DeliveryLockUnavailableError";
  }
}

export class DeliveryLockRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryLockRecoveryError";
  }
}

interface StoreOptions {
  now?: () => string;
  id?: () => string;
  nonce?: () => string;
  processIdentity?: () => { pid: number; processStart: string; bootId: string };
  authorizeLockRecovery?: (actor: DeliveryActor) => boolean;
}

export class DeliveryStore {
  readonly dir: string;
  private readonly locksDir: string;

  constructor(workspaceRoot: string, private readonly opts: StoreOptions = {}) {
    this.dir = path.join(workspaceRoot, ".tachyon", "deliveries");
    this.locksDir = path.join(this.dir, ".locks");
  }

  async list(): Promise<Delivery[]> {
    return (await this.listWithCorrupt()).records;
  }

  async listWithCorrupt(): Promise<{ records: Delivery[]; corrupt: DeliveryCorruptRecord[] }> {
    if (!fs.existsSync(this.dir)) return { records: [], corrupt: [] };
    const records: Delivery[] = [];
    const corrupt: DeliveryCorruptRecord[] = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        records.push(this.readAndValidate(file));
      } catch (error) {
        corrupt.push({ id: path.basename(name, ".json"), path: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { records, corrupt };
  }

  async get(id: string): Promise<Delivery | undefined> {
    assertDeliveryId(id);
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return undefined;
    return this.readAndValidate(file);
  }

  async create(input: DeliveryCreateInput): Promise<Delivery> {
    const id = input.id ?? this.newId();
    assertDeliveryId(id);
    return this.withLock(id, async () => {
      if (fs.existsSync(this.fileFor(id))) throw new DeliveryInvariantError(`Delivery '${id}' already exists`);
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
      this.write(record);
      return structuredClone(record);
    });
  }

  async update(id: string, expectedVersion: number, mutate: (record: Delivery) => Delivery): Promise<Delivery> {
    assertDeliveryId(id);
    return this.withLock(id, async () => {
      const current = await this.get(id);
      if (!current) throw new DeliveryNotFoundError(id);
      if (current.version !== expectedVersion) throw new DeliveryVersionConflictError(id, expectedVersion, current.version);
      const next = mutate(structuredClone(current));
      assertAllowedMutation(current, next);
      next.version = current.version + 1;
      next.updatedAt = this.now();
      validateRecord(next);
      this.write(next);
      return structuredClone(next);
    });
  }

  /**
   * Explicit escape hatch for an unreadable/unprovable lock owner. The injected policy is the authentication
   * boundary; matching the observed nonce prevents an operator from breaking a lock that changed since inspection.
   */
  inspectLockOwner(id: string): DeliveryLockOwner | undefined {
    assertDeliveryId(id);
    const owner = this.readLockOwner(this.lockDirFor(id));
    return owner ? structuredClone(owner) : undefined;
  }

  async recoverAmbiguousLock(input: { id: string; observedNonce: string; authenticatedBy: DeliveryActor }): Promise<void> {
    assertDeliveryId(input.id);
    if (!this.opts.authorizeLockRecovery?.(input.authenticatedBy)) {
      throw new DeliveryLockRecoveryError("ambiguous lock recovery requires an authenticated actor");
    }
    const lockDir = this.lockDirFor(input.id);
    const owner = this.readLockOwner(lockDir);
    if (!owner || owner.nonce !== input.observedNonce) {
      throw new DeliveryLockRecoveryError("lock owner changed or cannot be authenticated by nonce");
    }
    this.removeLockByRename(lockDir, input.id, owner.nonce);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const owner = this.currentOwner();
    fs.mkdirSync(this.locksDir, { recursive: true });
    const lockDir = this.lockDirFor(id);
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = this.readLockOwner(lockDir);
      if (!existing) throw new DeliveryLockUnavailableError(id, "corrupt");
      const state = ownerState(existing);
      if (state !== "dead") throw new DeliveryLockUnavailableError(id, state === "alive" ? "occupied" : "ambiguous");
      this.removeLockByRename(lockDir, id, existing.nonce);
      try {
        fs.mkdirSync(lockDir);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new DeliveryLockUnavailableError(id, "occupied");
        throw retryError;
      }
    }
    try {
      fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return await fn();
    } finally {
      const held = this.readLockOwner(lockDir);
      if (held?.nonce === owner.nonce) fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  private removeLockByRename(lockDir: string, id: string, expectedNonce: string): void {
    const tombstone = path.join(this.locksDir, `.${id}.${this.newNonce()}.stale`);
    try {
      fs.renameSync(lockDir, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DeliveryLockRecoveryError("lock changed during recovery");
      throw error;
    }
    const moved = this.readLockOwner(tombstone);
    if (moved?.nonce !== expectedNonce) {
      try {
        fs.renameSync(tombstone, lockDir);
      } catch {
        // Preserve the unexpectedly moved lock for authenticated inspection; never delete it.
      }
      throw new DeliveryLockRecoveryError("lock owner changed during recovery");
    }
    fs.rmSync(tombstone, { recursive: true, force: true });
  }

  private readLockOwner(lockDir: string): DeliveryLockOwner | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as DeliveryLockOwner;
      if (value?.schemaVersion !== 1 || typeof value.nonce !== "string" || !Number.isSafeInteger(value.pid)
        || typeof value.processStart !== "string" || typeof value.bootId !== "string") return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private currentOwner(): DeliveryLockOwner {
    const identity = this.opts.processIdentity?.() ?? currentProcessIdentity();
    return { schemaVersion: 1, nonce: this.newNonce(), ...identity, acquiredAt: this.now() };
  }

  private write(record: Delivery): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.fileFor(record.id);
    const tmp = path.join(this.dir, `.${record.id}.${process.pid}.${this.newNonce()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      fs.renameSync(tmp, target);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* rename succeeded or best-effort cleanup */ }
    }
  }

  private readAndValidate(file: string): Delivery {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Delivery;
    validateRecord(record);
    return record;
  }

  private fileFor(id: string): string { return path.join(this.dir, `${id}.json`); }
  private lockDirFor(id: string): string { return path.join(this.locksDir, `${id}.lock`); }
  private now(): string { return this.opts.now?.() ?? new Date().toISOString(); }
  private newId(): string { return this.opts.id?.() ?? `d-${randomBytes(8).toString("hex")}`; }
  private newNonce(): string { return this.opts.nonce?.() ?? randomBytes(12).toString("hex"); }
}

function currentProcessIdentity(): { pid: number; processStart: string; bootId: string } {
  const processStart = readProcessStart(process.pid) ?? "unavailable";
  let bootId = "unavailable";
  try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unavailable"; } catch { /* fail closed on reclamation */ }
  return { pid: process.pid, processStart, bootId };
}

function ownerState(owner: DeliveryLockOwner): "alive" | "dead" | "ambiguous" {
  if (owner.bootId === "unavailable" || owner.processStart === "unavailable") return "ambiguous";
  let bootId: string;
  try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "ambiguous"; }
  if (!bootId) return "ambiguous";
  if (bootId !== owner.bootId) return "dead";
  const start = readProcessStart(owner.pid);
  if (start === undefined) {
    try {
      process.kill(owner.pid, 0);
      return "ambiguous";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "ambiguous";
    }
  }
  return start === owner.processStart ? "alive" : "dead";
}

function readProcessStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    return stat.slice(close + 2).split(" ")[19];
  } catch {
    return undefined;
  }
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
  const stableCount = current.length === next.length ? Math.max(0, current.length - 1) : current.length;
  for (let i = 0; i < stableCount; i++) {
    if (!same(current[i], next[i])) throw new DeliveryInvariantError("completed segment history is immutable");
  }
  if (next.length === current.length + 1 && current.length && !current.at(-1)!.releasedAt) {
    throw new DeliveryInvariantError("a new segment requires the current tail to be closed");
  }
  if (current.length && next.length === current.length && !same(current.at(-1), next.at(-1))) {
    const before = current.at(-1)!;
    const after = next.at(-1)!;
    if (before.releasedAt || before.releasedHeadSha || before.outcome || !isTailClosure(before, after)) {
      throw new DeliveryInvariantError("only the open tail segment may be closed");
    }
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
  record.segments.forEach((segment, index) => {
    if (segment.index !== index || !segment.id) throw new DeliveryInvariantError("segment indexes must be contiguous and stable");
    if ((segment.releasedAt || segment.releasedHeadSha || segment.outcome)
      && !(segment.releasedAt && segment.releasedHeadSha && segment.outcome)) {
      throw new DeliveryInvariantError("segment closure fields must be recorded together");
    }
    if (index < record.segments.length - 1 && !segment.releasedAt) {
      throw new DeliveryInvariantError("only the tail segment may remain open");
    }
  });
  const ids = new Set<string>();
  for (const event of record.events) {
    if (!event.id || ids.has(event.id)) throw new DeliveryInvariantError("Delivery event ids must be unique");
    ids.add(event.id);
  }
}

function isPrefix<T>(before: T[], after: T[]): boolean {
  return after.length >= before.length && before.every((value, index) => same(value, after[index]));
}

function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }

function assertDeliveryId(id: string): void {
  if (!/^d-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new DeliveryInvariantError(`invalid Delivery id '${id}'`);
}
