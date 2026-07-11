import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { GIT_DELIVERY_SCHEMA_VERSION, type GitDelivery, type GitDeliveryCorruptRecord, type GitDeliveryOpenInput } from "./types.js";

export class GitDeliveryVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDeliveryVersionConflictError";
  }
}

export class GitDeliveryUniquenessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDeliveryUniquenessError";
  }
}

export class GitDeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`GitDelivery '${id}' not found`);
    this.name = "GitDeliveryNotFoundError";
  }
}

export class GitDeliveryStore {
  readonly dir: string;
  readonly databasePath: string;

  constructor(workspaceRoot: string, private readonly opts: { now?: () => string; id?: () => string } = {}) {
    this.dir = path.join(workspaceRoot, ".tachyon", "git-deliveries");
    this.databasePath = path.join(workspaceRoot, ".tachyon", "git-deliveries-v2.sqlite3");
  }

  async list(): Promise<GitDelivery[]> {
    return this.listWithCorrupt().then((r) => r.records);
  }

  async listWithCorrupt(): Promise<{ records: GitDelivery[]; corrupt: GitDeliveryCorruptRecord[] }> {
    const records = this.withDatabase((db) => (db.prepare("SELECT record_json FROM git_deliveries ORDER BY id").all() as Array<{ record_json: string }>).map((r) => JSON.parse(r.record_json) as GitDelivery));
    return { records, corrupt: [] };
  }

  async get(id: string): Promise<GitDelivery | undefined> {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT record_json FROM git_deliveries WHERE id = ?").get(id) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as GitDelivery : undefined;
    });
  }

  async open(input: GitDeliveryOpenInput): Promise<GitDelivery> {
    const normalizedPath = path.resolve(input.worktreePath);
    const existing = this.withDatabase((db) => {
      const row = db.prepare("SELECT record_json FROM git_deliveries WHERE active = 1 AND (branch_ref = ? OR worktree_path = ?)").get(input.branchRef, normalizedPath) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as GitDelivery : undefined;
    });
    if (existing) {
      if (existing.agent === input.agent && existing.branchRef === input.branchRef && path.resolve(existing.worktreePath) === path.resolve(input.worktreePath)) {
        if (input.deliveryId && existing.deliveryId && existing.deliveryId !== input.deliveryId) {
          throw new GitDeliveryUniquenessError(`GitDelivery '${existing.id}' is linked to Delivery '${existing.deliveryId}', not '${input.deliveryId}'`);
        }
        if (input.deliveryId && !existing.deliveryId) {
          return this.update(existing.id, existing.version, (record) => ({ ...record, deliveryId: input.deliveryId }));
        }
        return existing;
      }
      throw new GitDeliveryUniquenessError(`open GitDelivery '${existing.id}' already owns branch/worktree`);
    }
    const now = this.now();
    const rec: GitDelivery = {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      id: this.newId(),
      version: 1,
      workspaceId: input.workspaceId,
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      createdBy: input.createdBy,
      agent: input.agent,
      branchRef: input.branchRef,
      worktreePath: input.worktreePath,
      tachyonCreatedBranch: input.tachyonCreatedBranch,
      baseRef: input.baseRef,
      ...(input.currentHeadSha ? { currentHeadSha: input.currentHeadSha } : {}),
      phase: "open",
      taskLinks: input.taskLinks ?? [],
      transitions: [{ at: now, to: "open", by: input.createdBy, ...(input.reason ? { reason: input.reason } : {}) }],
      createdAt: now,
      updatedAt: now,
    };
    try {
      return this.withTransaction((db) => {
        const row = db.prepare("SELECT record_json FROM git_deliveries WHERE active = 1 AND (branch_ref = ? OR worktree_path = ?)").get(input.branchRef, normalizedPath) as { record_json: string } | undefined;
        if (row) {
          const winner = JSON.parse(row.record_json) as GitDelivery;
          if (winner.agent !== input.agent || winner.branchRef !== input.branchRef || path.resolve(winner.worktreePath) !== normalizedPath
            || (input.deliveryId && winner.deliveryId && winner.deliveryId !== input.deliveryId)) {
            throw new GitDeliveryUniquenessError("branch/worktree was claimed concurrently by a conflicting delivery");
          }
          if (input.deliveryId && !winner.deliveryId) {
            const linked = { ...winner, deliveryId: input.deliveryId, version: winner.version + 1, updatedAt: this.now() };
            db.prepare("UPDATE git_deliveries SET record_json = ? WHERE id = ?").run(JSON.stringify(linked), winner.id);
            return linked;
          }
          return winner;
        }
        db.prepare("INSERT INTO git_deliveries(id, branch_ref, worktree_path, active, record_json) VALUES (?, ?, ?, 1, ?)").run(rec.id, rec.branchRef, normalizedPath, JSON.stringify(rec));
        return rec;
      });
    } finally {
      const durable = await this.get(rec.id);
      if (durable) this.writeMirror(durable);
    }
  }

  async update(id: string, expectedVersion: number, mutate: (record: GitDelivery) => GitDelivery): Promise<GitDelivery> {
    const current = await this.get(id);
    if (!current) throw new GitDeliveryNotFoundError(id);
    if (current.version !== expectedVersion) {
      throw new GitDeliveryVersionConflictError(`GitDelivery '${id}' version conflict: expected ${expectedVersion}, found ${current.version}`);
    }
    const next = mutate(structuredClone(current));
    next.version = current.version + 1;
    next.updatedAt = this.now();
    this.withTransaction((db) => {
      const active = next.phase === "pruned" ? 0 : 1;
      const result = db.prepare("UPDATE git_deliveries SET branch_ref = ?, worktree_path = ?, active = ?, record_json = ? WHERE id = ? AND json_extract(record_json, '$.version') = ?")
        .run(next.branchRef, path.resolve(next.worktreePath), active, JSON.stringify(next), id, expectedVersion);
      if (Number(result.changes) !== 1) throw new GitDeliveryVersionConflictError(`GitDelivery '${id}' version conflict`);
    });
    this.writeMirror(next);
    return next;
  }

  private writeMirror(record: GitDelivery): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(record.id);
    const tmp = path.join(this.dir, `.${record.id}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  }

  private withDatabase<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const require = createRequire(path.join(process.cwd(), "tachyon-git-delivery-store-loader.cjs"));
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(this.databasePath, { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS git_deliveries (id TEXT PRIMARY KEY, branch_ref TEXT NOT NULL, worktree_path TEXT NOT NULL, active INTEGER NOT NULL, record_json TEXT NOT NULL) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS git_deliveries_active_branch ON git_deliveries(branch_ref) WHERE active = 1; CREATE UNIQUE INDEX IF NOT EXISTS git_deliveries_active_worktree ON git_deliveries(worktree_path) WHERE active = 1;");
      this.migrateLegacy(db);
      return fn(db);
    } finally { db.close(); }
  }

  /** Promote the JSON v1 store atomically. JSON remains a durable mirror after commit. */
  private migrateLegacy(db: import("node:sqlite").DatabaseSync): void {
    if (!fs.existsSync(this.dir)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const name of fs.readdirSync(this.dir).sort()) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(this.dir, name);
        let record: GitDelivery;
        try {
          record = JSON.parse(fs.readFileSync(file, "utf8")) as GitDelivery;
        } catch (error) {
          throw new Error(`refusing GitDelivery migration: corrupt legacy record '${file}': ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!record || record.schemaVersion !== GIT_DELIVERY_SCHEMA_VERSION || typeof record.id !== "string"
          || record.id !== path.basename(name, ".json") || typeof record.version !== "number"
          || typeof record.branchRef !== "string" || typeof record.worktreePath !== "string"
          || !Array.isArray(record.transitions) || typeof record.phase !== "string") {
          throw new Error(`refusing GitDelivery migration: invalid legacy record '${file}'`);
        }
        const existing = db.prepare("SELECT record_json FROM git_deliveries WHERE id = ?").get(record.id) as { record_json: string } | undefined;
        if (existing) {
          if (JSON.stringify(JSON.parse(existing.record_json)) !== JSON.stringify(record)) {
            throw new Error(`refusing GitDelivery migration: legacy/SQLite divergence for '${record.id}'`);
          }
          continue;
        }
        db.prepare("INSERT INTO git_deliveries(id, branch_ref, worktree_path, active, record_json) VALUES (?, ?, ?, ?, ?)")
          .run(record.id, record.branchRef, path.resolve(record.worktreePath), record.phase === "pruned" ? 0 : 1, JSON.stringify(record));
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  private withTransaction<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = fn(db); db.exec("COMMIT"); return result; }
      catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  private newId(): string {
    return this.opts.id?.() ?? `gd-${randomBytes(4).toString("hex")}`;
  }
}
