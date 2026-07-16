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
  canAdminManagedWorktree,
  canMutateManagedWorktree,
  defaultChangeBranch,
  findManagedEntry,
  isUnderWorkspaceManagedRoot,
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

  /**
   * Register a path that already exists as a worktree of THIS repo under
   * `<base>/<wsHash>/…`. Validates realpath, common-dir, and live branch.
   */
  async register(input: {
    kind: ManagedWorktreeKind;
    path: string;
    branch?: string;
    baseRef?: string;
    tachyonCreatedBranch?: boolean;
    agent?: string;
    taskId?: string;
    slug?: string;
    createdBy?: string;
    /** Caller for public Bridge registration (authority checks). */
    actor?: { kind: string; name?: string };
    /** When true, skip git probes (only for internal agent ensure that already validated). */
    trustedInternal?: boolean;
  }): Promise<ManagedWorktreeEntry> {
    if (input.kind === "agent" && !input.agent) {
      throw new Error("register kind=agent requires agent");
    }
    if (input.kind === "change" && !input.slug && !input.trustedInternal) {
      throw new Error("register kind=change requires slug");
    }

    const base = resolveBase(this.opts.getSettings());
    let abs: string;
    if (input.trustedInternal) {
      abs = path.resolve(this.opts.workspaceRoot, input.path);
    } else {
      if (!fs.existsSync(input.path)) throw new Error(`path does not exist: ${input.path}`);
      abs = fs.realpathSync(input.path);
      if (!isUnderWorkspaceManagedRoot(abs, base, this.opts.wsHash)) {
        throw new Error(`path is not under managed root '${path.join(base, this.opts.wsHash)}': ${abs}`);
      }

      // Authorization: agents may only register their own deterministic path; no peer adoption.
      const actor = input.actor ?? { kind: "legacy" };
      if (!canAdminManagedWorktree(actor)) {
        if (actor.kind !== "agent" || !actor.name) {
          throw new Error("register_worktree requires an agent or human caller");
        }
        if (input.kind === "agent") {
          if (input.agent !== actor.name) {
            throw new Error("register kind=agent may only claim the caller's own agent name");
          }
          const expected = path.resolve(pathFor(base, this.opts.wsHash, actor.name));
          if (abs !== expected) {
            throw new Error(`register kind=agent path must be the canonical path for '${actor.name}'`);
          }
        } else {
          const slug = assertManagedSlug(input.slug!);
          const expected = path.resolve(pathForChange(base, this.opts.wsHash, slug));
          if (abs !== expected) {
            throw new Error(`register kind=change path must be the canonical path for slug '${slug}'`);
          }
          const prior = findManagedEntry(this.load(), abs);
          if (prior && !canMutateManagedWorktree(prior, actor)) {
            throw new Error(`refused: path already registered to another owner (${prior.id})`);
          }
        }
      }

      const repoCommon = (await this.git(["rev-parse", "--git-common-dir"], this.opts.workspaceRoot)).stdout.trim();
      if (!repoCommon) throw new Error("cannot resolve repository common dir");
      const wtCommonProbe = await this.git(["rev-parse", "--git-common-dir"], abs);
      if (wtCommonProbe.code !== 0) throw new Error(`path is not a git worktree: ${abs}`);
      const repoCommonAbs = path.resolve(this.opts.workspaceRoot, repoCommon);
      const wtCommonAbs = path.resolve(abs, wtCommonProbe.stdout.trim());
      if (path.resolve(repoCommonAbs) !== path.resolve(wtCommonAbs)) {
        throw new Error(`path is not a worktree of this repository: ${abs}`);
      }
      const curProbe = await this.git(gitArgs.currentBranch(), abs);
      const liveBranch = curProbe.code === 0 ? curProbe.stdout.trim() : "";
      if (!liveBranch || liveBranch === "HEAD") throw new Error(`worktree is detached or branch unreadable: ${abs}`);
      if (input.branch && input.branch !== liveBranch) {
        throw new Error(`branch mismatch: registered '${input.branch}' but live is '${liveBranch}'`);
      }
      input = { ...input, branch: liveBranch };
    }

    const branch = input.branch;
    if (!branch) throw new Error("register requires branch");

    const slug = input.slug ? assertManagedSlug(input.slug) : undefined;
    const idKey = input.kind === "agent" ? input.agent! : (slug ?? path.basename(abs));
    const id = newManagedId(input.kind, idKey);
    const headProbe = await this.git(gitArgs.headRef(), abs).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // Preserve prior createdAt/createdBy when re-registering the same path by the same owner.
    const prior = findManagedEntry(this.load(), abs);
    const entry: ManagedWorktreeEntry = {
      id,
      kind: input.kind,
      path: abs,
      branch,
      baseRef: input.baseRef ?? (headProbe.code === 0 ? headProbe.stdout.trim() : "HEAD"),
      tachyonCreatedBranch: input.tachyonCreatedBranch ?? false,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(slug ? { slug } : {}),
      createdAt: prior?.createdAt ?? this.nowIso(),
      ...(input.createdBy || prior?.createdBy
        ? { createdBy: input.createdBy ?? prior?.createdBy }
        : {}),
      status: "active",
    };
    this.save(upsertManagedEntry(this.load(), entry));
    return entry;
  }

  /** Upsert from WorktreeManager agent ensure/fork/remove (path already validated by manager). */
  syncAgentRecord(agent: string, rec: WorktreeRecord | null): void {
    if (!rec) {
      const existing = this.list({ kind: "agent" }).find((e) => e.agent === agent);
      if (existing) this.save(removeManagedEntry(this.load(), existing.id));
      return;
    }
    const abs = path.resolve(rec.path);
    const entry: ManagedWorktreeEntry = {
      id: newManagedId("agent", agent),
      kind: "agent",
      path: abs,
      branch: rec.branch,
      baseRef: rec.baseRef,
      tachyonCreatedBranch: rec.tachyonCreatedBranch,
      agent,
      createdAt: rec.createdAt || this.nowIso(),
      status: "active",
    };
    this.save(upsertManagedEntry(this.load(), entry));
  }

  unregister(idOrPath: string, actor: { kind: string; name?: string }): boolean {
    const before = this.load();
    const found = findManagedEntry(before, idOrPath);
    if (!found) return false;
    if (!canMutateManagedWorktree(found, actor)) {
      throw new Error(`refused: caller cannot unregister worktree '${found.id}' (not owner/creator/privileged)`);
    }
    this.save(removeManagedEntry(before, found.id));
    return true;
  }

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

    return this.opts.manager.withPathLock(wtPath, async () => {
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

      try {
        return await this.register({
          kind: "change",
          path: wtPath,
          branch,
          baseRef,
          tachyonCreatedBranch: true,
          slug,
          taskId: input.taskId,
          createdBy: input.createdBy,
          trustedInternal: true,
        });
      } catch (regErr) {
        // Leave the checkout for recovery; surface both outcomes.
        throw new Error(
          `worktree created at ${wtPath} but registry failed: ${regErr instanceof Error ? regErr.message : String(regErr)}; ` +
            `adopt with register_worktree or remove with git worktree remove`,
        );
      }
    });
  }

  /** clean | dirty | unknown — unknown fails closed without confirmDirty. */
  async probeDirtiness(worktreePath: string): Promise<"clean" | "dirty" | "unknown"> {
    try {
      const status = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath);
      if (status.code !== 0) return "unknown";
      return status.stdout.trim().length > 0 ? "dirty" : "clean";
    } catch {
      return "unknown";
    }
  }

  async remove(
    idOrPath: string,
    opts: { deleteBranch?: boolean; confirmDirty?: boolean; actor: { kind: string; name?: string } },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { removed: false, branchDeleted: false, error: `managed worktree not found: ${idOrPath}` };
    if (!canMutateManagedWorktree(entry, opts.actor)) {
      return { removed: false, branchDeleted: false, error: `refused: caller cannot remove worktree '${entry.id}'` };
    }

    const rec: WorktreeRecord = {
      path: entry.path,
      branch: entry.branch,
      tachyonCreatedBranch: entry.tachyonCreatedBranch,
      baseRef: entry.baseRef,
      createdAt: entry.createdAt,
    };
    // Dirtiness probe runs inside manager.remove under the same path lock.
    const result = await this.opts.manager.remove(
      rec,
      opts.deleteBranch === true && entry.tachyonCreatedBranch,
      {
        force: opts.confirmDirty === true,
        refuseUnlessForceIfDirty: true,
      },
    );
    if (result.removed) this.save(removeManagedEntry(this.load(), entry.id));
    return result;
  }

  async removePath(
    worktreePath: string,
    opts?: {
      deleteBranch?: boolean;
      branch?: string;
      tachyonCreatedBranch?: boolean;
      baseRef?: string;
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

    if (entry) {
      return this.remove(entry.id, {
        deleteBranch: opts?.deleteBranch,
        confirmDirty: true,
        actor: { kind: "legacy" },
      });
    }
    return this.opts.manager.remove(rec, !!opts?.deleteBranch && !!opts?.tachyonCreatedBranch);
  }
}

export function agentWorktreePath(settings: TachyonConfig["settings"], wsHash: string, agent: string): string {
  return pathFor(resolveBase(settings), wsHash, agent);
}
