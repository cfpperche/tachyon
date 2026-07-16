import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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

export class GitDeliveryCanonicalSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDeliveryCanonicalSequenceError";
  }
}

export class GitDeliveryStore {
  readonly databasePath: string;

  constructor(workspaceRoot: string, private readonly opts: { now?: () => string } = {}) {
    this.databasePath = path.join(workspaceRoot, ".tachyon", "git-deliveries-v2.sqlite3");
  }

  async list(): Promise<GitDelivery[]> {
    return this.listWithCorrupt().then((r) => r.records);
  }

  async listWithCorrupt(): Promise<{ records: GitDelivery[]; corrupt: GitDeliveryCorruptRecord[] }> {
    const records = this.withDatabase((db) => (db.prepare("SELECT record_json FROM git_deliveries ORDER BY id").all() as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as Partial<GitDelivery>)
      // Old unlinked rows remain invisible to the product until the explicit retirement action
      // archives and removes them. They are never promoted into canonical authority.
      .filter((record): record is GitDelivery => typeof record.deliveryId === "string" && record.deliveryId.length > 0));
    return { records, corrupt: [] };
  }

  async get(id: string): Promise<GitDelivery | undefined> {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT record_json FROM git_deliveries WHERE id = ?").get(id) as { record_json: string } | undefined;
      if (!row) return undefined;
      const record = JSON.parse(row.record_json) as Partial<GitDelivery>;
      return typeof record.deliveryId === "string" && record.deliveryId.length > 0
        ? record as GitDelivery
        : undefined;
    });
  }

  async open(input: GitDeliveryOpenInput): Promise<GitDelivery> {
    const normalizedPath = path.resolve(input.worktreePath);
    if (!input.deliveryId.trim()) {
      throw new GitDeliveryUniquenessError("canonical Delivery id is required");
    }
    const requestedId = deterministicGitDeliveryId(input.deliveryId);
    if (input.id !== undefined && input.id !== requestedId) {
      throw new GitDeliveryUniquenessError(
        `expected deterministic id '${requestedId}' for Delivery '${input.deliveryId}', got '${input.id}'`,
      );
    }
    if (!/^gd-[0-9a-f]+$/.test(requestedId)) {
      throw new GitDeliveryUniquenessError(`invalid GitDelivery id '${requestedId}'`);
    }
    const existing = this.withDatabase((db) => {
      const byId = db.prepare("SELECT record_json FROM git_deliveries WHERE id = ?").get(requestedId) as { record_json: string } | undefined;
      if (byId) return JSON.parse(byId.record_json) as GitDelivery;
      const row = db.prepare("SELECT record_json FROM git_deliveries WHERE active = 1 AND (branch_ref = ? OR worktree_path = ?)").get(input.branchRef, normalizedPath) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as GitDelivery : undefined;
    });
    if (existing) {
      if (existing.agent === input.agent && existing.branchRef === input.branchRef && path.resolve(existing.worktreePath) === path.resolve(input.worktreePath)) {
        if (existing.id !== requestedId) {
          throw new GitDeliveryUniquenessError(`GitDelivery '${existing.id}' already owns branch/worktree; expected deterministic id '${requestedId}'`);
        }
        if (existing.deliveryId !== input.deliveryId) {
          throw new GitDeliveryUniquenessError(`GitDelivery '${existing.id}' is linked to Delivery '${existing.deliveryId}', not '${input.deliveryId}'`);
        }
        return existing;
      }
      throw new GitDeliveryUniquenessError(`open GitDelivery '${existing.id}' already owns branch/worktree`);
    }
    const now = this.now();
    const rec: GitDelivery = {
      schemaVersion: GIT_DELIVERY_SCHEMA_VERSION,
      id: requestedId,
      version: 1,
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
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
    return this.withTransaction((db) => {
      const byId = db.prepare("SELECT record_json FROM git_deliveries WHERE id = ?").get(requestedId) as { record_json: string } | undefined;
      if (byId) {
        const winner = JSON.parse(byId.record_json) as GitDelivery;
        if (winner.agent !== input.agent || winner.branchRef !== input.branchRef || path.resolve(winner.worktreePath) !== normalizedPath
          || winner.deliveryId !== input.deliveryId) {
          throw new GitDeliveryUniquenessError(`deterministic GitDelivery '${requestedId}' conflicts with an existing record`);
        }
        return winner;
      }
      const row = db.prepare("SELECT record_json FROM git_deliveries WHERE active = 1 AND (branch_ref = ? OR worktree_path = ?)").get(input.branchRef, normalizedPath) as { record_json: string } | undefined;
      if (row) {
        const winner = JSON.parse(row.record_json) as Partial<GitDelivery>;
        if (winner.agent !== input.agent || winner.branchRef !== input.branchRef || path.resolve(String(winner.worktreePath)) !== normalizedPath
          || winner.deliveryId !== input.deliveryId || winner.id !== requestedId) {
          throw new GitDeliveryUniquenessError("branch/worktree was claimed concurrently by a conflicting delivery");
        }
        return winner as GitDelivery;
      }
      db.prepare("INSERT INTO git_deliveries(id, branch_ref, worktree_path, active, record_json) VALUES (?, ?, ?, 1, ?)").run(rec.id, rec.branchRef, normalizedPath, JSON.stringify(rec));
      return rec;
    });
  }

  /**
   * Apply the next exact canonical projection sequence (SDD 368 T15).
   * Identical sequence+operationId replay is success; gaps, collisions, link/version drift refuse.
   */
  async applyCanonicalIntent(input: {
    id: string;
    expectedVersion: number;
    sequence: number;
    operationId: string;
    deliveryId: string;
    mutate: (record: GitDelivery) => GitDelivery;
  }): Promise<GitDelivery> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new GitDeliveryCanonicalSequenceError(`invalid projection sequence ${input.sequence}`);
    }
    if (!input.operationId) throw new GitDeliveryCanonicalSequenceError("operationId is required");
    const current = await this.get(input.id);
    if (!current) throw new GitDeliveryNotFoundError(input.id);
    const appliedSeq = current.lastAppliedProjectionSequence ?? 0;
    if (appliedSeq === input.sequence && current.lastAppliedOperationId === input.operationId) {
      // Idempotent identical replay.
      return current;
    }
    if (appliedSeq === input.sequence && current.lastAppliedOperationId !== input.operationId) {
      throw new GitDeliveryCanonicalSequenceError(
        `projection sequence ${input.sequence} already applied as operation '${current.lastAppliedOperationId}', not '${input.operationId}'`,
      );
    }
    if (input.sequence !== appliedSeq + 1) {
      throw new GitDeliveryCanonicalSequenceError(
        `projection sequence gap: expected ${appliedSeq + 1}, got ${input.sequence}`,
      );
    }
    if (current.version !== input.expectedVersion) {
      throw new GitDeliveryVersionConflictError(
        `GitDelivery '${input.id}' version conflict: expected ${input.expectedVersion}, found ${current.version}`,
      );
    }
    if (current.deliveryId !== input.deliveryId) {
      throw new GitDeliveryCanonicalSequenceError(
        `immutable deliveryId link drift: record has '${current.deliveryId}', intent has '${input.deliveryId}'`,
      );
    }
    const next = input.mutate(structuredClone(current));
    assertImmutableLink(current, next);
    if (next.deliveryId !== input.deliveryId) {
      throw new GitDeliveryCanonicalSequenceError(`mutate attempted to change deliveryId link`);
    }
    next.lastAppliedProjectionSequence = input.sequence;
    next.lastAppliedOperationId = input.operationId;
    next.version = current.version + 1;
    next.updatedAt = this.now();
    this.withTransaction((db) => {
      const active = next.phase === "pruned" ? 0 : 1;
      const result = db.prepare("UPDATE git_deliveries SET branch_ref = ?, worktree_path = ?, active = ?, record_json = ? WHERE id = ? AND json_extract(record_json, '$.version') = ?")
        .run(next.branchRef, path.resolve(next.worktreePath), active, JSON.stringify(next), input.id, input.expectedVersion);
      if (Number(result.changes) !== 1) throw new GitDeliveryVersionConflictError(`GitDelivery '${input.id}' version conflict`);
    });
    return next;
  }

  private withDatabase<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    const require = createRequire(path.join(process.cwd(), "tachyon-git-delivery-store-loader.cjs"));
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(this.databasePath, { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS git_deliveries (id TEXT PRIMARY KEY, branch_ref TEXT NOT NULL, worktree_path TEXT NOT NULL, active INTEGER NOT NULL, record_json TEXT NOT NULL) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS git_deliveries_active_branch ON git_deliveries(branch_ref) WHERE active = 1; CREATE UNIQUE INDEX IF NOT EXISTS git_deliveries_active_worktree ON git_deliveries(worktree_path) WHERE active = 1;");
      return fn(db);
    } finally { db.close(); }
  }

  private withTransaction<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = fn(db); db.exec("COMMIT"); return result; }
      catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    });
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

}

function assertImmutableLink(current: GitDelivery, next: GitDelivery): void {
  if (current.deliveryId !== next.deliveryId) {
    throw new GitDeliveryCanonicalSequenceError(
      `immutable deliveryId cannot change from '${current.deliveryId}' to '${next.deliveryId}'`,
    );
  }
  if (current.id !== next.id) {
    throw new GitDeliveryCanonicalSequenceError("GitDelivery id is immutable");
  }
  // workspaceId / branch / worktree may be mutated by deliberate test seams that inject
  // projection drift for verification recovery; lifecycle authority still lives in the
  // projection service. deliveryId link, once set, cannot retarget another Delivery.
}

/** Deterministic GitDelivery id derived from a Delivery identity (canonical gated open). */
export function deterministicGitDeliveryId(deliveryId: string): string {
  return `gd-${createHash("sha256").update(`delivery-projection:${deliveryId}`).digest("hex").slice(0, 12)}`;
}
