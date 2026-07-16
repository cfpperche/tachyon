/**
 * spec 392 — product façade over WorktreeManager git engine + durable registry.
 */

import fs from "node:fs";
import path from "node:path";
import type { TachyonConfig } from "../config/loadConfig.js";
import {
  WorktreeManager,
  type GitExec,
  type WorktreeOccupancyProbe,
  type WorktreeRecord,
  defaultGitExec,
  gitArgs,
  pathFor,
  resolveBase,
} from "./WorktreeManager.js";
import {
  assertManagedSlug,
  defaultChangeBranch,
  findManagedEntry,
  loadManagedWorktreeStore,
  managedWorktreeStorePath,
  newManagedId,
  pathForChange,
  removeManagedEntry,
  saveManagedWorktreeStore,
  type ManagedWorktreeEntry,
  type ManagedWorktreeKind,
  upsertManagedEntry,
} from "./managedWorktree.js";

export interface ManagedWorktreeServiceOpts {
  workspaceRoot: string;
  wsHash: string;
  getSettings: () => TachyonConfig["settings"];
  manager: WorktreeManager;
  git?: GitExec;
  occupancy?: WorktreeOccupancyProbe;
  now?: () => string;
  /** Called after registry mutates (e.g. VS Code reveal). */
  onRegistryChanged?: () => void;
}

export class ManagedWorktreeService {
  constructor(private readonly opts: ManagedWorktreeServiceOpts) {}

  private get git(): GitExec {
    return this.opts.git ?? defaultGitExec;
  }

  private nowIso(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }

  private storePath(): string {
    return managedWorktreeStorePath(this.opts.workspaceRoot);
  }

  private load() {
    return loadManagedWorktreeStore(this.storePath());
  }

  private save(store: ReturnType<typeof loadManagedWorktreeStore>): void {
    saveManagedWorktreeStore(this.storePath(), store);
    this.opts.onRegistryChanged?.();
  }

  list(filter?: { kind?: ManagedWorktreeKind; status?: ManagedWorktreeEntry["status"] }): ManagedWorktreeEntry[] {
    let entries = this.load().entries;
    if (filter?.kind) entries = entries.filter((e) => e.kind === filter.kind);
    if (filter?.status) entries = entries.filter((e) => e.status === filter.status);
    return entries;
  }

  get(idOrPath: string): ManagedWorktreeEntry | undefined {
    return findManagedEntry(this.load(), idOrPath);
  }

  /** Register an existing path under the managed base (or already-created agent path). */
  register(input: {
    kind: ManagedWorktreeKind;
    path: string;
    branch: string;
    baseRef?: string;
    tachyonCreatedBranch?: boolean;
    agent?: string;
    taskId?: string;
    slug?: string;
    createdBy?: string;
  }): ManagedWorktreeEntry {
    const abs = path.resolve(input.path);
    const base = resolveBase(this.opts.getSettings());
    if (!abs.startsWith(path.resolve(base) + path.sep) && abs !== path.resolve(base)) {
      // Allow agent paths that used a prior base only if already registered; otherwise require under base.
      const prior = findManagedEntry(this.load(), abs);
      if (!prior) {
        throw new Error(`path is not under managed worktree base '${base}': ${abs}`);
      }
    }
    const slug = input.slug ? assertManagedSlug(input.slug) : undefined;
    const id =
      input.kind === "agent" && input.agent
        ? newManagedId("agent", input.agent)
        : newManagedId("change", slug ?? path.basename(abs));
    const entry: ManagedWorktreeEntry = {
      id,
      kind: input.kind,
      path: abs,
      branch: input.branch,
      baseRef: input.baseRef ?? "HEAD",
      tachyonCreatedBranch: input.tachyonCreatedBranch ?? false,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(slug ? { slug } : {}),
      createdAt: this.nowIso(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      status: "active",
    };
    this.save(upsertManagedEntry(this.load(), entry));
    return entry;
  }

  /** Upsert from WorktreeManager agent ensure/fork/remove. */
  syncAgentRecord(agent: string, rec: WorktreeRecord | null): void {
    if (!rec) {
      const existing = this.list({ kind: "agent" }).find((e) => e.agent === agent);
      if (existing) this.save(removeManagedEntry(this.load(), existing.id));
      return;
    }
    this.register({
      kind: "agent",
      path: rec.path,
      branch: rec.branch,
      baseRef: rec.baseRef,
      tachyonCreatedBranch: rec.tachyonCreatedBranch,
      agent,
    });
  }

  unregister(idOrPath: string): boolean {
    const before = this.load();
    const found = findManagedEntry(before, idOrPath);
    if (!found) return false;
    this.save(removeManagedEntry(before, found.id));
    return true;
  }

  /**
   * Create a change worktree (task/implementation isolation) via git worktree add.
   * Does not use launch quarantine locks (not an agent spawn path).
   */
  async createChange(input: {
    slug: string;
    branch?: string;
    baseRef?: string;
    taskId?: string;
    createdBy?: string;
  }): Promise<ManagedWorktreeEntry> {
    const slug = assertManagedSlug(input.slug);
    const base = resolveBase(this.opts.getSettings());
    const wtPath = pathForChange(base, this.opts.wsHash, slug);
    const branch = input.branch ?? defaultChangeBranch(slug);
    if (fs.existsSync(wtPath)) throw new Error(`change worktree path already exists: ${wtPath}`);

    const fmt = await this.git(gitArgs.checkRefFormat(branch), this.opts.workspaceRoot);
    if (fmt.code !== 0) throw new Error(`invalid branch name '${branch}'`);

    await this.git(gitArgs.prune(), this.opts.workspaceRoot);
    if ((await this.git(gitArgs.branchExists(branch), this.opts.workspaceRoot)).code === 0) {
      throw new Error(`branch '${branch}' already exists`);
    }

    const startRef = input.baseRef ?? "HEAD";
    const baseRefProbe = await this.git(["rev-parse", startRef], this.opts.workspaceRoot);
    if (baseRefProbe.code !== 0 || !baseRefProbe.stdout.trim()) {
      throw new Error(`cannot resolve base ref '${startRef}'`);
    }
    const baseRef = baseRefProbe.stdout.trim();
    const add = await this.git(gitArgs.addNewBranch(wtPath, branch, startRef), this.opts.workspaceRoot);
    if (add.code !== 0) {
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    return this.register({
      kind: "change",
      path: wtPath,
      branch,
      baseRef,
      tachyonCreatedBranch: true,
      slug,
      taskId: input.taskId,
      createdBy: input.createdBy,
    });
  }

  /**
   * Remove worktree via WorktreeManager.remove (occupancy fail-closed) and drop registry entry.
   */
  async remove(
    idOrPath: string,
    opts?: { deleteBranch?: boolean },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { removed: false, branchDeleted: false, error: `managed worktree not found: ${idOrPath}` };

    const rec: WorktreeRecord = {
      path: entry.path,
      branch: entry.branch,
      tachyonCreatedBranch: entry.tachyonCreatedBranch,
      baseRef: entry.baseRef,
      createdAt: entry.createdAt,
    };
    const result = await this.opts.manager.remove(rec, opts?.deleteBranch === true && entry.tachyonCreatedBranch);
    if (result.removed) this.save(removeManagedEntry(this.load(), entry.id));
    return result;
  }

  /**
   * Engine entry for product callers (e.g. GitDelivery prune) that previously shelled
   * `git worktree remove` directly. Occupancy-checked via manager.remove unless `force`.
   */
  async removePath(
    worktreePath: string,
    opts?: {
      deleteBranch?: boolean;
      branch?: string;
      tachyonCreatedBranch?: boolean;
      baseRef?: string;
      /** Delivery abandon/force: skip occupancy probe (caller already recorded override). */
      force?: boolean;
    },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const abs = path.resolve(worktreePath);
    const entry = findManagedEntry(this.load(), abs);
    const rec: WorktreeRecord = entry
      ? {
          path: entry.path,
          branch: entry.branch,
          tachyonCreatedBranch: entry.tachyonCreatedBranch,
          baseRef: entry.baseRef,
          createdAt: entry.createdAt,
        }
      : {
          path: abs,
          branch: opts?.branch ?? "HEAD",
          tachyonCreatedBranch: opts?.tachyonCreatedBranch ?? false,
          baseRef: opts?.baseRef ?? "HEAD",
          createdAt: this.nowIso(),
        };

    if (opts?.force) {
      const rm = await this.git(gitArgs.remove(rec.path), this.opts.workspaceRoot);
      if (rm.code !== 0) return { removed: false, branchDeleted: false, error: rm.stderr.trim() || rm.stdout.trim() };
      let branchDeleted = false;
      if (opts.deleteBranch && rec.tachyonCreatedBranch && rec.branch !== "HEAD") {
        const del = await this.git(gitArgs.deleteBranch(rec.branch), this.opts.workspaceRoot);
        branchDeleted = del.code === 0;
      }
      await this.git(gitArgs.prune(), this.opts.workspaceRoot);
      if (entry) this.save(removeManagedEntry(this.load(), entry.id));
      return { removed: true, branchDeleted };
    }

    if (entry) return this.remove(entry.id, { deleteBranch: opts?.deleteBranch });
    return this.opts.manager.remove(rec, !!opts?.deleteBranch && !!opts?.tachyonCreatedBranch);
  }
}

/** Deterministic agent path (same as WorktreeManager.pathForAgent). */
export function agentWorktreePath(settings: TachyonConfig["settings"], wsHash: string, agent: string): string {
  return pathFor(resolveBase(settings), wsHash, agent);
}
