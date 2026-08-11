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
  type WorktreeRemovalResult,
  defaultGitExec,
  gitArgs,
  pathFor,
  resolveBase,
} from "./WorktreeManager.js";
import { classifyManagedWorktree, localTrunkRef, resolveTrunkRefs, type WorktreeClassification } from "./classify.js";
import type { ChangedFile } from "./review.js";
import { probeLandSuggestion, probePrimaryCheckout, type LandSuggestion, type PrimaryCheckoutState } from "./land.js";
import { landAct, type LandResult } from "./landAct.js";
import {
  resolveHygieneAuthority,
  type HygieneAuthorityDecision,
  type HygieneAuthorityGranted,
  type HygieneLineageSource,
  type HygieneRelation,
  type OwnerPresence,
} from "./hygieneAuthority.js";
import {
  describeToolingProjection,
  projectPluginTooling,
  resolveAuthorityRoot,
  type ProjectionResult,
} from "../plugins/worktreeProjection.js";
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
import { scanOrphanedWorktreeProcesses, type OrphanProcessHygieneReport } from "./orphanProcessHygiene.js";

export interface ManagedWorktreeServiceOpts {
  workspaceRoot: string;
  wsHash: string;
  getSettings: () => TachyonConfig["settings"];
  manager: WorktreeManager;
  git?: GitExec;
  occupancy?: WorktreeOccupancyProbe;
  now?: () => string;
  onRegistryChanged?: () => void;
  /** t-36182f — surface the plugin-tooling projection outcome for a linked worktree (best-effort). */
  notify?: (message: string) => void;
  /**
   * t-e74631 — who spawned whom, for hygiene authority. `AgentManager.parentOf` satisfies it.
   * Optional: absent means lineage is UNKNOWN, not that everyone is an orphan, and the authority
   * module refuses ancestor claims accordingly rather than granting them.
   */
  lineage?: HygieneLineageSource;
  /**
   * t-05dff5 — an `agent` entry is a claim recorded in TWO places: this registry and the session
   * ledger's `worktree` block. Removing the checkout through Control → Worktrees used to clear only
   * this one, leaving the ledger owning a directory that no longer existed — a state no governed
   * action could then undo (forget refused "still owns a worktree", and the agent-card removal
   * failed on `git worktree remove` before it ever reached the ledger).
   *
   * So the registry tells the ledger. Optional because a headless/test service has no ledger to
   * tell; `Workspace` always wires it to `SessionLedger.clearWorktree`.
   */
  onAgentWorktreeRemoved?: (agent: string) => void;
  /**
   * t-621613 — does the agent an `agent` entry belongs to still exist ANYWHERE Tachyon knows
   * (declared in tachyon.yml, live in tmux, present in the session ledger, retained by a forget
   * receipt)? Asked only to decide whether that entry is an ORPHAN — a home with no inhabitant.
   *
   * Optional, and its absence is not "everyone is gone": an unwired seam answers `unknown`, which
   * the authority module treats exactly like `present`. That is what keeps a headless/test service,
   * and every caller that predates this, at the pre-t-621613 refusal.
   */
  ownerPresence?: (agent: string) => Promise<OwnerPresence>;
}

/** Where hygiene removals are recorded. Gitignored `.tachyon/`, so the shared checkout stays clean. */
export const HYGIENE_AUDIT_REL = path.join(".tachyon", "worktree-hygiene.jsonl");

export interface HygieneRemovalResult {
  removed: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Present once authority was evaluated; absent when the entry was not found at all. */
  authority?: HygieneAuthorityDecision;
}

export interface HygieneReconcileOutcome {
  id: string;
  path: string;
  branch: string;
  taskId?: string;
  relation?: HygieneRelation;
  branchDeleted?: boolean;
  /** Why this entry was left alone. Always present on a refusal — a silent skip is the old bug. */
  reason?: string;
}

export interface HygieneReconcileReport {
  scanned: number;
  removed: HygieneReconcileOutcome[];
  refused: HygieneReconcileOutcome[];
  dryRun: boolean;
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

  /** Read-only process residue report for this workspace's managed worktree namespace. */
  processHygiene(procRoot = "/proc"): OrphanProcessHygieneReport {
    const root = path.join(resolveBase(this.opts.getSettings()), this.opts.wsHash);
    return scanOrphanedWorktreeProcesses(root, procRoot);
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
   *
   * t-7cb971 — a row also carries a `land` suggestion when, and only when, it has work the trunk does
   * not contain. That condition comes free from the classification just computed, so a landed or empty
   * checkout costs no extra probe at all: there is nothing to land, and offering a command for it
   * would be the "suggestion that reads as authority" this is meant to replace.
   */
  async listClassified(filter?: {
    kind?: ManagedWorktreeKind;
    status?: ManagedWorktreeEntry["status"];
  }): Promise<Array<ManagedWorktreeEntry & {
    classification: WorktreeClassification;
    ownerPresence: OwnerPresence;
    land?: LandSuggestion;
  }>> {
    const entries = this.list(filter);
    // t-24e28d — the trunk is a property of the REPOSITORY, so it is discovered once per sweep against
    // the workspace root rather than re-probed inside every entry's checkout. Resolving it here also
    // means a row whose path has gone missing is still described against the same trunk as its peers.
    const trunkRefs = await resolveTrunkRefs(this.git, this.opts.workspaceRoot);
    // t-7cb971 — only a LOCAL branch can be fast-forwarded, so the land suggestion needs the local
    // name out of the candidate list rather than whichever candidate proved containment (which may be
    // `origin/<trunk>`). No local trunk at all is an honest null: the suggestion then refuses by name.
    const localTrunk = localTrunkRef(trunkRefs);
    // t-7cb971 — and so is the primary checkout, for both of the reasons the trunk is: three
    // subprocesses per row otherwise, and two rows in one refresh must not disagree about which
    // branch it has checked out. Probed lazily: a sweep with nothing to land never pays for it.
    // Memoizes the PROMISE, not its result: the rows below run concurrently under `Promise.all`, so
    // caching after the await would let every row start its own probe before the first one finished
    // and defeat the whole point.
    let primaryProbe: Promise<PrimaryCheckoutState> | undefined;
    const primaryOnce = (): Promise<PrimaryCheckoutState> =>
      (primaryProbe ??= probePrimaryCheckout(this.git, this.opts.workspaceRoot));
    return Promise.all(
      entries.map(async (entry) => {
        // t-621613 — carried on every row because a reader deciding what to DO with an agent entry
        // needs it: the surfaces that offer a removal gate on `kind === "agent"`, and without this
        // they cannot tell a home with somebody in it from residue nobody can otherwise reach.
        const ownerPresence = await this.ownerPresenceOf(entry);
        try {
          const classification = await classifyManagedWorktree(entry, {
            git: this.git,
            status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
            occupancy: this.opts.occupancy,
            lockState: (worktreePath) => this.opts.manager.lockState(worktreePath),
            trunkRefs,
          });
          // t-7cb971 — nothing to land once the trunk already contains the work, and nothing to probe
          // when the checkout is gone. A `land` that threw is dropped rather than reported half-built:
          // a partial precondition list is the one output shape worse than none.
          const land = classification.pathExists && !classification.containedInTrunk
            ? await primaryOnce()
              .then((primary) => probeLandSuggestion({
                git: this.git,
                worktreePath: entry.path,
                trunkRef: localTrunk,
                primary,
                dirty: classification.dirty,
                commits: classification.aheadOfBase,
              }))
              // Inside the catch on purpose: a failed primary probe must cost this row its land
              // block, never its CLASSIFICATION — the outer handler would report the whole row as
              // `classification failed`, which is a false statement about a classification that ran.
              .catch(() => undefined)
            : undefined;
          return { ...entry, classification, ownerPresence, ...(land ? { land } : {}) };
        } catch (err) {
          return {
            ...entry,
            ownerPresence,
            classification: {
              state: "needs-review" as const,
              reasons: [`classification failed: ${err instanceof Error ? err.message : String(err)}`],
              pathExists: fs.existsSync(entry.path),
              dirty: true,
              aheadOfBase: 0,
              containedInBase: false,
              // t-6ae9a8 — a classifier that THREW proves nothing about containment, so both signals
              // stay false. This is the same fail-closed shape the rest of the fallback already uses.
              containedInTrunk: false,
              trunkRef: trunkRefs[0] ?? "main",
            },
          };
        }
      }),
    );
  }

  /**
   * SDD 501 — what a human standing at the land block would be looking at, resolved by the REGISTRY id
   * the row already carries.
   *
   * The two identities `worktree.review` already accepted are an agent name and a pipeline run; this
   * is the third, and it exists because the land block renders for `change` rows too — a door keyed on
   * an agent name would silently skip half the rows that have something to land.
   *
   * The comparison is `trunkRef..head` — COMMITTED history, the commits the land command would
   * introduce (notes.md § D2). `base` falls back to the ref the worktree was forked from only when the
   * repository has no local trunk at all, which is a state the land block itself already refuses by
   * name; the base is returned either way so the surface can say which one it used rather than let a
   * reader assume.
   */
  async landReview(id: string): Promise<{
    record: WorktreeRecord;
    base: string;
    head: string;
    changedFiles: ChangedFile[];
  } | null> {
    const entry = findManagedEntry(this.reconcileStore(), id);
    if (!entry || !fs.existsSync(entry.path)) return null;
    const trunkRefs = await resolveTrunkRefs(this.git, this.opts.workspaceRoot);
    const base = localTrunkRef(trunkRefs) ?? entry.baseRef;
    const { headRef } = await this.opts.manager.headState(entry.path);
    // No readable HEAD is an unborn or unreadable checkout: there is no committed content to compare,
    // and answering with the working tree instead would be the substitution this whole decision avoids.
    if (!headRef) return null;
    return {
      record: {
        path: entry.path,
        branch: entry.branch,
        tachyonCreatedBranch: entry.tachyonCreatedBranch,
        baseRef: entry.baseRef,
        createdAt: entry.createdAt,
      },
      base,
      head: headRef,
      changedFiles: await this.opts.manager.changedFiles(entry.path, base, headRef),
    };
  }

  /**
   * SDD 498 (t-7cb971) — LAND. Re-measure the five preconditions and, only if they are all green
   * NOW, fast-forward the trunk onto this delivery's head in the primary checkout.
   *
   * The re-measure is `probeLandSuggestion` — the same function `listClassified` calls to DRAW the
   * block. That identity is the point of the whole door: the thing that decides at the click is the
   * thing the human was shown, so a rendered green can never authorize an act the fresh facts refuse.
   * A second copy of any of the five conditions here would reintroduce exactly the divergence this
   * replaces (plan.md D3).
   *
   * All-or-nothing comes free with it: `landSuggestion` withholds `command` unless every check passed,
   * so "did the fresh probe hand me a command" IS the precondition, and the refusal is the first red
   * check's own words — the same sentence the block renders, never a second vocabulary (plan.md D4).
   *
   * Human-initiated only. The Worktrees tab is an Interface surface and no Bridge tool dispatches
   * extension operations; `landDoorHasNoAgentDoor.test.ts` holds that line.
   */
  async land(id: string): Promise<LandResult & { checks?: LandSuggestion["checks"] }> {
    const entry = findManagedEntry(this.reconcileStore(), id);
    if (!entry) {
      return {
        ok: false,
        code: "not-ready",
        reason: `managed worktree not found: ${id}`,
        fix: "refresh the Worktrees tab — this row is no longer in the registry, so there is nothing to land from it",
      };
    }
    if (!fs.existsSync(entry.path)) {
      return {
        ok: false,
        code: "not-ready",
        reason: `the checkout for '${entry.branch}' is no longer on disk at ${entry.path}`,
        fix: "refresh the Worktrees tab; a checkout that is gone cannot be verified, and nothing may land from it",
      };
    }

    const trunkRefs = await resolveTrunkRefs(this.git, this.opts.workspaceRoot);
    const localTrunk = localTrunkRef(trunkRefs);
    const classification = await classifyManagedWorktree(entry, {
      git: this.git,
      status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
      occupancy: this.opts.occupancy,
      lockState: (worktreePath) => this.opts.manager.lockState(worktreePath),
      trunkRefs,
    });
    const suggestion = await probeLandSuggestion({
      git: this.git,
      worktreePath: entry.path,
      trunkRef: localTrunk,
      dirty: classification.dirty,
      commits: classification.aheadOfBase,
    });

    if (!suggestion.command || !suggestion.primaryPath) {
      const blocked = suggestion.checks.find((c) => !c.ok);
      return {
        ok: false,
        code: "not-ready",
        // The checks travel with the refusal so the block re-renders from the FRESH measurement rather
        // than the stale one it was drawn from — the human sees why it changed under their click.
        checks: suggestion.checks,
        reason: blocked?.detail ?? "a precondition is not proved",
        fix: blocked?.fix ?? "refresh the Worktrees tab and read the preconditions again",
      };
    }

    return {
      ...(await landAct({
        git: this.git,
        primaryPath: suggestion.primaryPath,
        trunkRef: suggestion.trunkRef,
        head: suggestion.head,
      })),
      checks: suggestion.checks,
    };
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
    await this.projectPluginTooling(abs);
    return entry;
  }

  /**
   * t-36182f — reach the workspace's plugin tooling from a linked worktree.
   *
   * Best-effort BY DESIGN: a worktree whose tooling could not be projected is still a valid worktree,
   * and failing creation over a symlink would trade a Visual QA gap for a lost checkout. It is never
   * silent though — the outcome is reported, because the whole defect this fixes was a missing tool
   * that looked like an uninstalled one.
   *
   * Idempotent, so it runs on every register and every agent ensure: that is what covers restart, and
   * what repairs a link a human deleted.
   */
  private async projectPluginTooling(worktreePath: string): Promise<ProjectionResult | undefined> {
    try {
      const probe = await this.git(["rev-parse", "--git-common-dir"], worktreePath);
      if (probe.code !== 0) return undefined;
      const commonAbs = path.resolve(worktreePath, probe.stdout.trim());
      const authorityRoot = resolveAuthorityRoot(worktreePath, commonAbs);
      if (!authorityRoot) return undefined; // this IS the authority — nothing to project
      const result = projectPluginTooling({ worktreeRoot: worktreePath, authorityRoot });
      this.opts.notify?.(`worktree tooling — ${describeToolingProjection(result)}`);
      return result;
    } catch (err) {
      this.opts.notify?.(
        `worktree tooling projection skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * t-62f599 — reproject EVERY registered worktree, on workspace activation.
   *
   * The gap this closes was measured on this workspace and it is the whole reason the method exists:
   * `syncAgentRecord` fires on spawn, fork and dismiss, and a reload with agents already alive does
   * none of those. It re-DISCOVERS them. So a policy change that withdraws something from a worktree
   * reached only agents somebody happened to restart afterwards — and the live fleet, which is the
   * population the policy was written for, kept what the change was meant to take away.
   *
   * Idempotent and best-effort, like the per-worktree call it wraps. A worktree whose path is gone is
   * skipped rather than reported: the store reconciles those separately, and a missing checkout is not
   * a projection failure.
   */
  async reprojectRegisteredWorktrees(): Promise<void> {
    for (const entry of this.list()) {
      if (!fs.existsSync(entry.path)) continue;
      try {
        await this.projectPluginTooling(entry.path);
      } catch {
        // per-worktree failure is already surfaced by projectPluginTooling's own notify
      }
    }
  }

  /** Upsert from WorktreeManager agent ensure/fork/remove (path already validated by manager). */
  syncAgentRecord(agent: string, rec: WorktreeRecord | null, createdBy?: string): void {
    if (!rec) {
      const existing = this.list({ kind: "agent" }).find((e) => e.agent === agent);
      if (existing) this.save(removeManagedEntry(this.load(), existing.id));
      return;
    }
    const abs = path.resolve(rec.path);
    // t-36182f — an agent worktree needs the same tooling reach a change worktree does. This is a
    // sync API, so fire and report; a projection failure must never break the record upsert.
    void this.projectPluginTooling(abs).catch(() => undefined);
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
  /**
   * t-e74631 — this is also the ONLY path that grants lineage authority, and the two facts are the
   * same fact. A delegating parent may ask here precisely because everything below the ask is still
   * proved at execution time: the widest thing a wrongly-granted ancestor can do is request a removal
   * this classifier then refuses. `remove()` keeps the narrower owner-only rule because it can force
   * past dirtiness, and force is not something an ancestor inherits.
   */
  async removeClassified(
    idOrPath: string,
    opts: { deleteBranch?: boolean; actor: { kind: string; name?: string } },
  ): Promise<HygieneRemovalResult> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { removed: false, branchDeleted: false, error: `managed worktree not found: ${idOrPath}` };
    // Authority first: it is the cheap check, and a caller with no standing should not learn the
    // dirtiness of a worktree it may not touch.
    const authority = resolveHygieneAuthority(entry, opts.actor, this.lineage(), await this.ownerPresenceOf(entry));
    if (!authority.allowed) return { removed: false, branchDeleted: false, error: `refused: ${authority.reason}` };
    const classification = await classifyManagedWorktree(entry, {
      git: this.git,
      status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
      occupancy: this.opts.occupancy,
      lockState: (worktreePath) => this.opts.manager.lockState(worktreePath),
    });
    if (classification.state !== "ready-to-remove") {
      // t-dcdb7f — reasons are priority-ordered; name the blocking condition (and its exit), not the list.
      const why = classification.reasons[0] || classification.state;
      return {
        removed: false,
        branchDeleted: false,
        error: `refused: not ready-to-remove (${classification.state}: ${why})`,
        authority,
      };
    }
    const result = await this.removeEntryEngine(entry, {
      deleteBranch: opts.deleteBranch === true && entry.tachyonCreatedBranch,
      force: false,
      refuseUnlessForceIfDirty: true,
    });
    // The audit line is emitted only for a removal that actually happened, and it carries the proofs
    // rather than a verdict: a later reader can disagree with the decision, but not with what it saw.
    if (result.removed) this.recordHygieneRemoval(entry, authority, classification, result.branchDeleted);
    return { ...result, authority };
  }

  /**
   * t-e74631 — sweep every change entry the actor may act on and remove the ones that are provably
   * safe, reporting the refusals rather than swallowing them.
   *
   * The point of the sweep is that it does not wait for anybody. Hygiene used to depend on the
   * creating agent waking up and remembering, which is exactly the thing a finished agent never does
   * — so residue accumulated until a human noticed. A parent (or the workspace) can now run this
   * immediately over the whole registry.
   *
   * Agent worktrees are never swept: an agent's working home is not residue, and the filter is here
   * rather than in the authority module so that a caller cannot opt into sweeping them at all.
   *
   * t-621613 — that stays true for ORPHAN agent entries too, which the authority module now grants
   * on. The grant is deliberately reachable only by NAMING an entry (`removeClassified`, i.e. the
   * Bridge's `remove_worktree` and Control → Worktrees), never by this sweep. The sweep runs
   * unattended at activation, which is exactly when a spawning agent's registry entry can exist
   * before its ledger row does; a roster read in that window says "absent" about an agent that is
   * seconds old. Naming the entry is a deliberate act by someone who looked at it, and that is the
   * difference between cleaning residue and racing a spawn.
   */
  async reconcileHygiene(opts: {
    actor: { kind: string; name?: string };
    deleteBranch?: boolean;
    /** Report what WOULD happen without touching anything. */
    dryRun?: boolean;
  }): Promise<HygieneReconcileReport> {
    const entries = this.list({ kind: "change", status: "active" });
    const removed: HygieneReconcileOutcome[] = [];
    const refused: HygieneReconcileOutcome[] = [];
    for (const entry of entries) {
      if (opts.dryRun) {
        const decision = await this.previewHygiene(entry, opts.actor);
        (decision.wouldRemove ? removed : refused).push(decision.outcome);
        continue;
      }
      const result = await this.removeClassified(entry.id, { actor: opts.actor, deleteBranch: opts.deleteBranch });
      const outcome: HygieneReconcileOutcome = {
        id: entry.id,
        path: entry.path,
        branch: entry.branch,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        ...(result.authority?.allowed ? { relation: result.authority.relation } : {}),
        ...(result.error ? { reason: result.error } : {}),
        ...(result.branchDeleted ? { branchDeleted: true } : {}),
      };
      (result.removed ? removed : refused).push(outcome);
    }
    return { scanned: entries.length, removed, refused, dryRun: opts.dryRun === true };
  }

  /** What `reconcileHygiene` would do to one entry, without doing it. */
  private async previewHygiene(
    entry: ManagedWorktreeEntry,
    actor: { kind: string; name?: string },
  ): Promise<{ wouldRemove: boolean; outcome: HygieneReconcileOutcome }> {
    const base: HygieneReconcileOutcome = {
      id: entry.id,
      path: entry.path,
      branch: entry.branch,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
    };
    const authority = resolveHygieneAuthority(entry, actor, this.lineage(), await this.ownerPresenceOf(entry));
    if (!authority.allowed) return { wouldRemove: false, outcome: { ...base, reason: `refused: ${authority.reason}` } };
    let classification: WorktreeClassification;
    try {
      classification = await classifyManagedWorktree(entry, {
        git: this.git,
        status: (cwd, baseRef) => this.opts.manager.status(cwd, baseRef),
        occupancy: this.opts.occupancy,
        lockState: (worktreePath) => this.opts.manager.lockState(worktreePath),
      });
    } catch (err) {
      // A classifier that threw proves nothing, so the preview must not claim it would remove.
      return {
        wouldRemove: false,
        outcome: {
          ...base,
          relation: authority.relation,
          // t-dcdb7f — a failed classifier proves nothing; never invent a force path that does not exist.
          reason:
            `refused: classification failed: ${this.messageOf(err)}` +
            "; retry after classification can run — a failed classifier never authorizes removal",
        },
      };
    }
    if (classification.state !== "ready-to-remove") {
      // t-dcdb7f — same primary-block rule as removeClassified (reasons are priority-ordered).
      const why = classification.reasons[0] || classification.state;
      return {
        wouldRemove: false,
        outcome: { ...base, relation: authority.relation, reason: `refused: not ready-to-remove (${classification.state}: ${why})` },
      };
    }
    return { wouldRemove: true, outcome: { ...base, relation: authority.relation } };
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * t-621613 — whether this entry's home still has an inhabitant.
   *
   * Only an `agent` entry has one, so everything else answers `unknown` and reaches the authority
   * module unchanged. Every failure mode collapses to `unknown` as well — no seam, no recorded
   * agent, a probe that threw — because the grant this feeds is destructive and absence that was
   * not measured is not absence.
   */
  async ownerPresenceOf(entry: ManagedWorktreeEntry): Promise<OwnerPresence> {
    if (entry.kind !== "agent" || !entry.agent || !this.opts.ownerPresence) return "unknown";
    try {
      return await this.opts.ownerPresence(entry.agent);
    } catch {
      return "unknown";
    }
  }

  private lineage(): HygieneLineageSource {
    // A workspace with no lineage seam wired is not a workspace where everyone is an orphan: it is one
    // where lineage is UNKNOWN. Answering `undefined` is correct for that — `resolveHygieneAuthority`
    // then proves no ancestor relation and refuses, leaving owner and human authority intact.
    return this.opts.lineage ?? { parentOf: () => undefined };
  }

  /**
   * Durable audit for one hygiene removal: who asked, whose it was, by what relation, and which
   * proofs were true at the moment it happened. Best-effort by design — a failed audit write must not
   * roll back a removal that already succeeded, and the removal is observable in the registry anyway.
   */
  private recordHygieneRemoval(
    entry: ManagedWorktreeEntry,
    authority: HygieneAuthorityGranted,
    classification: WorktreeClassification,
    branchDeleted: boolean,
  ): void {
    try {
      const line = JSON.stringify({
        at: this.nowIso(),
        id: entry.id,
        path: entry.path,
        branch: entry.branch,
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        actor: authority.actor,
        relation: authority.relation,
        ...(authority.owner ? { owner: authority.owner } : {}),
        ...(authority.lineage ? { lineage: authority.lineage } : {}),
        branchDeleted,
        proofs: {
          state: classification.state,
          dirty: classification.dirty,
          aheadOfBase: classification.aheadOfBase,
          containedInBase: classification.containedInBase,
          containedInTrunk: classification.containedInTrunk,
          trunkRef: classification.trunkRef,
          tachyonCreatedBranch: entry.tachyonCreatedBranch,
        },
      });
      const file = path.join(this.opts.workspaceRoot, HYGIENE_AUDIT_REL);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      /* audit is evidence, not a gate */
    }
  }

  /**
   * t-d29398 — release the Git quarantine on a preserved checkout, and ONLY that.
   *
   * The gesture the product was missing. A launch that failed after `git worktree add --lock` left a
   * lock nothing in the UI could clear, and every retry was refused with an instruction ("unlock
   * explicitly") that required a terminal and knowledge of `git worktree unlock`. The owner hit this
   * on 2026-08-07 and was stuck with a clean, commit-free checkout he could not reuse.
   *
   * It is deliberately NOT a removal, and that is what keeps it honest about preserved work: unlocking
   * deletes no file and rewrites no ref. Whatever is inside is still inside afterwards — the caller can
   * then relaunch into it, or remove it through the classification-gated door that re-proves clean,
   * unoccupied and contained. So the surface can show what is in there and let the human decide,
   * without this call ever being the thing that loses it.
   *
   * Refused while a live agent occupies the checkout: there the lock may be a launch still in flight,
   * and taking its quarantine out from under it is a race nobody asked for.
   */
  async releaseLock(
    idOrPath: string,
    opts: { actor: { kind: string; name?: string } },
  ): Promise<{ released: boolean; error?: string; lockReason?: string; authority?: HygieneAuthorityDecision }> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { released: false, error: `managed worktree not found: ${idOrPath}` };
    // Same authority model as removal, which grants the host human unconditionally. Reusing it rather
    // than inventing a second one is deliberate: a caller who may not ask for a removal has no better
    // claim to lift the quarantine that stands in front of one.
    const authority = resolveHygieneAuthority(entry, opts.actor, this.lineage(), await this.ownerPresenceOf(entry));
    if (!authority.allowed) return { released: false, error: `refused: ${authority.reason}`, authority };
    if (!fs.existsSync(entry.path)) {
      return { released: false, error: `checkout is missing at ${entry.path}; forget the record instead`, authority };
    }
    const occupant = await this.opts.occupancy?.(entry.path).catch(() => undefined);
    if (occupant) {
      return {
        released: false,
        error:
          `refused: agent '${occupant.agent}' occupies this checkout (${occupant.state})` +
          `; its lock may belong to a launch still in progress — stop agent '${occupant.agent}' (kill_agent) first`,
        authority,
      };
    }
    const state = await this.opts.manager.lockState(entry.path);
    const result = await this.opts.manager.releaseLock(entry.path);
    return {
      released: result.released,
      ...(result.error ? { error: result.error } : {}),
      ...(state?.reason ? { lockReason: state.reason } : {}),
      authority,
    };
  }

  async remove(
    idOrPath: string,
    opts: { deleteBranch?: boolean; confirmDirty?: boolean; actor: { kind: string; name?: string } },
  ): Promise<WorktreeRemovalResult> {
    const entry = findManagedEntry(this.load(), idOrPath);
    if (!entry) return { removed: false, branchDeleted: false, error: `managed worktree not found: ${idOrPath}` };
    if (!canMutateManagedWorktree(entry, opts.actor)) {
      // t-dcdb7f — owner-only force path; name who may act and the clean lineage alternative.
      const owner = entry.createdBy ?? entry.agent;
      return {
        removed: false,
        branchDeleted: false,
        error: owner
          ? `refused: caller cannot remove worktree '${entry.id}'; only owner '${owner}' or the host human may force-remove` +
            " — drop confirmDirty to retry via lineage hygiene, or call as the owner"
          : `refused: caller cannot remove worktree '${entry.id}'; only the host human may remove an entry with no recorded owner`,
      };
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
  ): Promise<WorktreeRemovalResult> {
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
  ): Promise<WorktreeRemovalResult> {
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
    // A checkout that was already absent is as gone as one we just deleted, so the registry must
    // stop claiming it either way — a removal that leaves a record behind is the divergence again.
    if (result.removed || result.absent) {
      this.save(removeManagedEntry(this.load(), entry.id));
      // t-05dff5 — and so must the ledger, for an agent entry. One removal, one owner, one truth.
      if (entry.kind === "agent" && entry.agent) this.opts.onAgentWorktreeRemoved?.(entry.agent);
    }
    return result;
  }
}

export function agentWorktreePath(settings: TachyonConfig["settings"], wsHash: string, agent: string): string {
  return pathFor(resolveBase(settings), wsHash, agent);
}
