import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
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

  constructor(workspaceRoot: string, private readonly opts: { now?: () => string; id?: () => string } = {}) {
    this.dir = path.join(workspaceRoot, ".tachyon", "git-deliveries");
  }

  async list(): Promise<GitDelivery[]> {
    return this.listWithCorrupt().then((r) => r.records);
  }

  async listWithCorrupt(): Promise<{ records: GitDelivery[]; corrupt: GitDeliveryCorruptRecord[] }> {
    if (!fs.existsSync(this.dir)) return { records: [], corrupt: [] };
    const records: GitDelivery[] = [];
    const corrupt: GitDeliveryCorruptRecord[] = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GitDelivery;
        if (!parsed || parsed.schemaVersion !== GIT_DELIVERY_SCHEMA_VERSION || typeof parsed.id !== "string" || typeof parsed.version !== "number") {
          throw new Error("invalid GitDelivery record shape");
        }
        records.push(parsed);
      } catch (err) {
        corrupt.push({ id: path.basename(name, ".json"), path: file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { records, corrupt };
  }

  async get(id: string): Promise<GitDelivery | undefined> {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as GitDelivery;
  }

  async open(input: GitDeliveryOpenInput): Promise<GitDelivery> {
    const existing = (await this.list()).find((d) => d.phase !== "pruned" && (d.branchRef === input.branchRef || path.resolve(d.worktreePath) === path.resolve(input.worktreePath)));
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
    this.write(rec);
    return rec;
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
    this.write(next);
    return next;
  }

  private write(record: GitDelivery): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(record.id);
    const tmp = path.join(this.dir, `.${record.id}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
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
