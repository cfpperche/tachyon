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
import { classifyManagedWorktree, type WorktreeClassification } from "./classify.js";
import {
  abandonMissingEntries,
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

  /**
   * Reconcile missing on-disk paths to `abandoned` (spec 392 P2-4).
   * A path that reappears later stays abandoned until re-register validates identity.
   */
  private reconcileStore(): ReturnType<typeof loadManagedWorktreeStore> {
    const loaded = this.load();
    const { store, changed } = abandonMissingEntries(loaded);
    if (changed) this.save(store);
    return store;
  }

  /**
   * spec 444 — `list()` plus a fail-closed classification per entry (see `classify.ts`). A single
   * entry's classifier throwing (a bug, not an ordinary probe failure — `classifyManagedWorktree`
   * already fail-closes probe failures to `needs-review` internally) never silently reports that
   * entry as safe: it renders as `needs-review` with a stated `classification failed` reason instead
   * of failing the whole batch.
   */
  async listClassified(filter?: {
    kind?: ManagedWorktreeKind;
    status?: ManagedWorktreeEntry["status"];
  }): Promise<Array<ManagedWorktreeEntry & { classification: WorktreeClassification }>> {
    const entries = this.list(filter);
    return Promise.all(
      entries.map(async (entry) => {
        try {
          const classification = await classifyManagedWorktree(entry, {
            git: this.git,
            status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
            occupancy: this.opts.occupancy,
          });
          return { ...entry, classification };
        } catch (err) {
          return {
            ...entry,
            classification: {
              state: "needs-review" as const,
              reasons: [`classification failed: ${err instanceof Error ? err.message : String(err)}`],
              pathExists: fs.existsSync(entry.path),
              dirty: true,
              aheadOfBase: 0,
              containedInBase: false,
            },
          };
        }
      }),
    );
  }

  list(filter?: { kind?: ManagedWorktreeKind; status?: ManagedWorktreeEntry["status"] }): ManagedWorktreeEntry[] {
    let entries = this.reconcileStore().entries;
    if (filter?.kind) entries = entries.filter((e) => e.kind === filter.kind);
    if (filter?.status) entries = entries.filter((e) => e.status === filter.status);
    return entries;
  }

  get(idOrPath: string): ManagedWorktreeEntry | undefined {
    return findManagedEntry(this.reconcileStore(), idOrPath);
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
  syncAgentRecord(agent: string, rec: WorktreeRecord | null, createdBy?: string): void {
    if (!rec) {
      const existing = this.list({ kind: "agent" }).find((e) => e.agent === agent);
      if (existing) this.save(removeManagedEntry(this.load(), existing.id));
      return;
    }
    const abs = path.resolve(rec.path);
    const prior = findManagedEntry(this.load(), abs);
    const entry: ManagedWorktreeEntry = {
      id: newManagedId("agent", agent),
      kind: "agent",
      path: abs,
      branch: rec.branch,
      baseRef: rec.baseRef,
      tachyonCreatedBranch: rec.tachyonCreatedBranch,
      agent,
      ...(createdBy || prior?.createdBy ? { createdBy: createdBy ?? prior?.createdBy } : {}),
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

  /**
   * Public Bridge removal: ownership + dirty policy.
   * - clean → soft git remove (no --force)
   * - dirty/unknown → require confirmDirty, then force
   */
  /**
   * spec 444 (adversarial-review blocker fix) — classification-gated removal for the hygiene UI
   * path. Re-runs the FULL classifier at execution time and refuses anything not
   * `ready-to-remove`, so ALL THREE safety signals (occupancy, dirtiness, base-containment) are
   * re-validated at the point of deletion — `remove()` alone re-checks only the first two, and a
   * render-time containment verdict must never be trusted at click time.
   */
  async removeClassified(
    idOrPath: string,
    opts: { deleteBranch?: boolean; actor: { kind: string; name?: string } },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { removed: false, branchDeleted: false, error: `managed worktree not found: ${idOrPath}` };
    const classification = await classifyManagedWorktree(entry, {
      git: this.git,
      status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
      occupancy: this.opts.occupancy,
    });
    if (classification.state !== "ready-to-remove") {
      const why = classification.reasons.join("; ") || classification.state;
      return { removed: false, branchDeleted: false, error: `refused: not ready-to-remove (${classification.state}: ${why})` };
    }
    return this.remove(idOrPath, { deleteBranch: opts.deleteBranch, actor: opts.actor });
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
    return this.removeEntryEngine(entry, {
      deleteBranch: opts.deleteBranch === true && entry.tachyonCreatedBranch,
      force: opts.confirmDirty === true,
      refuseUnlessForceIfDirty: true,
    });
  }

  /**
   * Trusted internal engine removal (GitDelivery prune, etc.) — no Bridge actor impersonation.
   * Occupancy + optional dirty policy still enforced via WorktreeManager.
   */
  async removePath(
    worktreePath: string,
    opts?: {
      deleteBranch?: boolean;
      branch?: string;
      tachyonCreatedBranch?: boolean;
      baseRef?: string;
      /** When true: force remove (abandon/data-loss). When false: soft + dirty refuse. */
      force?: boolean;
    },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const abs = path.resolve(worktreePath);
    const entry = findManagedEntry(this.load(), abs);
    if (entry) {
      return this.removeEntryEngine(entry, {
        deleteBranch: !!opts?.deleteBranch && entry.tachyonCreatedBranch,
        force: opts?.force === true,
        refuseUnlessForceIfDirty: opts?.force !== true,
      });
    }

    const rec: WorktreeRecord = {
      path: abs,
      branch: opts?.branch ?? "HEAD",
      tachyonCreatedBranch: opts?.tachyonCreatedBranch ?? false,
      baseRef: opts?.baseRef ?? "HEAD",
      createdAt: this.nowIso(),
    };
    // Unregistered path: preserve historical force default for delivery prune of non-catalog trees.
    return this.opts.manager.remove(rec, !!opts?.deleteBranch && !!opts?.tachyonCreatedBranch, {
      force: opts?.force !== false,
      refuseUnlessForceIfDirty: opts?.force === false,
    });
  }

  private async removeEntryEngine(
    entry: ManagedWorktreeEntry,
    opts: { deleteBranch: boolean; force: boolean; refuseUnlessForceIfDirty: boolean },
  ): Promise<{ removed: boolean; branchDeleted: boolean; error?: string }> {
    const rec: WorktreeRecord = {
      path: entry.path,
      branch: entry.branch,
      tachyonCreatedBranch: entry.tachyonCreatedBranch,
      baseRef: entry.baseRef,
      createdAt: entry.createdAt,
    };
    const result = await this.opts.manager.remove(rec, opts.deleteBranch, {
      force: opts.force,
      refuseUnlessForceIfDirty: opts.refuseUnlessForceIfDirty,
    });
    if (result.removed) this.save(removeManagedEntry(this.load(), entry.id));
    return result;
  }
}

export function agentWorktreePath(settings: TachyonConfig["settings"], wsHash: string, agent: string): string {
  return pathFor(resolveBase(settings), wsHash, agent);
}
