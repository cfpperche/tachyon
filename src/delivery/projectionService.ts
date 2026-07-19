/**
 * SDD 368 T15 — canonical GitDelivery projection service.
 *
 * Owns intent append, application, and reconciliation under the durable per-Delivery
 * projection claim + canonical worktree mutex. `integrate` is record-only: it records
 * integrated only after live Git proves containment; it never runs a main-mutating Git command.
 *
 * Lock order: Delivery projection claim → worktree mutex → live checks → GitDelivery transaction.
 */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CallerSnapshot } from "../bridge/callerIdentity.js";
import {
  containedInBase,
  classifyDelivery,
  type DeliveryLiveness,
} from "../git-delivery/classify.js";
import {
  canIntegrateLinkedGitDelivery,
  canPruneLinkedGitDelivery,
} from "../git-delivery/policy.js";
import { assessPruneDelivery, pruneDeliveryRecord, type PruneDeps, type PruneInput, type PruneResult } from "../git-delivery/prune.js";
import type { DeliveryRecoveryApproval } from "./leaseService.js";
import {
  deterministicGitDeliveryId,
  type GitDeliveryStore,
} from "../git-delivery/store.js";
import type {
  GitDelivery,
  GitDeliveryActor,
  GitDeliverySettings,
} from "../git-delivery/types.js";
import type { GitExec, WorktreeOccupancyProbe } from "../worktree/WorktreeManager.js";
import {
  reconcileDeliveryReload,
  type LinkedGitProjection,
  type ObservedProcess,
  type ReloadDeliveryClassification,
  type ReloadReconciliationSnapshot,
} from "./reloadReconciliation.js";
import {
  DeliveryInvariantError,
  DeliveryNotFoundError,
  DeliveryProjectionClaimError,
  type DeliveryStore,
} from "./store.js";
import type {
  Delivery,
  DeliveryActor,
  DeliveryEvent,
  DeliveryProjectionAction,
  DeliveryProjectionClaimCapability,
  DeliveryProjectionIntentDetail,
} from "./types.js";
import { PROJECTION_INTENT_EVENT_TYPE } from "./types.js";

/**
 * t-2dd637 §4: the narrow governed base-repair action. It lives beside the canonical actions
 * rather than in `DeliveryProjectionAction` because the shared type is owned elsewhere; the
 * intent log, sequence allocation and reconcile loop below all treat it as a first-class action.
 */
export const RECONCILE_BASE_ACTION = "reconcile_base" as const;

type ProjectionAction = DeliveryProjectionAction | typeof RECONCILE_BASE_ACTION;

/** Widened locally so a reconcile_base intent is a real, sequence-consuming projection intent. */
type ProjectionIntentDetail = Omit<DeliveryProjectionIntentDetail, "action"> & { action: ProjectionAction };

/** Full 40-hex object name — the shape a pinned-SHA base always has (t-2dd637 §1.2). */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Digest bound by the base-repair approval. Covers exactly the four fields the report names,
 * plus an action label for domain separation so this receipt can never authorize another action.
 */
export function baseRepairActionDigest(input: {
  gitDeliveryId: string;
  currentBaseRef: string;
  proposedBaseRef: string;
  currentHeadSha: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      action: RECONCILE_BASE_ACTION,
      gitDeliveryId: input.gitDeliveryId,
      currentBaseRef: input.currentBaseRef,
      proposedBaseRef: input.proposedBaseRef,
      currentHeadSha: input.currentHeadSha,
    }))
    .digest("hex");
}

export class DeliveryProjectionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "PROJECTION_BUSY"
      | "PROJECTION_REFUSED"
      | "PROJECTION_UNAUTHORIZED"
      | "PROJECTION_DRIFT"
      | "PROJECTION_SEQUENCE"
      | "PROJECTION_NOT_FOUND"
      | "PROJECTION_UNSAFE",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DeliveryProjectionError";
  }
}

export interface DeliveryProjectionServiceDeps {
  deliveries: DeliveryStore;
  gitDeliveries: GitDeliveryStore;
  workspaceRoot: string;
  workspaceId: string;
  git: GitExec;
  liveness: DeliveryLiveness;
  worktreeOccupancy?: WorktreeOccupancyProbe;
  /** Keep spec 392's managed registry authoritative when canonical prune removes a worktree. */
  removeManagedWorktree?: PruneDeps["removeManagedWorktree"];
  /** Canonical worktree path lock (never reverse with the projection claim). */
  withWorktreeLock: <T>(canonicalWorktree: string, fn: () => Promise<T>) => Promise<T>;
  settings: () => GitDeliverySettings;
  /**
   * Bounded T14 snapshot loader. Prefer a full recompute; tests may inject a fixed snapshot.
   * Must not mutate stores.
   */
  loadReloadSnapshot: (deliveryId: string) => Promise<ReloadReconciliationSnapshot>;
  /**
   * t-2dd637 §4: the workspace's configured target branch. The base repair may only ever widen a
   * pinned SHA to this exact branch, so an absent probe makes the repair unavailable rather than
   * letting the caller name its own base.
   */
  targetBranch?: () => string | Promise<string>;
  /** t-2dd637 §4: resolves the approval bound to `baseRepairActionDigest`. Absent → unavailable. */
  resolveBaseRepairApproval?: (
    approvalId: string,
    actor: DeliveryActor,
    actionDigest: string,
  ) => DeliveryRecoveryApproval | Promise<DeliveryRecoveryApproval>;
  now?: () => string;
  operationId?: () => string;
  eventId?: () => string;
}

export interface CanonicalOpenInput {
  deliveryId: string;
  agent: string;
  branchRef: string;
  worktreePath: string;
  tachyonCreatedBranch: boolean;
  baseRef: string;
  currentHeadSha?: string;
  actor: DeliveryActor;
  operationId?: string;
  reason?: string;
}

export interface CanonicalIntegrateInput {
  deliveryId: string;
  gitDeliveryId: string;
  expectedGitVersion: number;
  expectedHeadSha: string;
  actor: DeliveryActor;
  /** Bridge-resolved caller identity is mandatory for linked projection mutations. */
  caller: Pick<CallerSnapshot, "kind" | "name">;
  operationId?: string;
  integrationKind?: "ancestor" | "patch-id" | "manual";
}

export interface CanonicalPruneInput {
  deliveryId: string;
  gitDeliveryId: string;
  expectedGitVersion: number;
  actor: DeliveryActor;
  /** Bridge-resolved caller identity is mandatory for linked projection mutations. */
  caller: Pick<CallerSnapshot, "kind" | "name">;
  abandon?: boolean;
  forceLoseCommits?: boolean;
  doomedShas?: string[];
  operationId?: string;
}

/** t-2dd637 §4: narrow, governed, defect-class-only repair of a pinned-SHA projection base. */
export interface CanonicalReconcileBaseInput {
  deliveryId: string;
  gitDeliveryId: string;
  expectedGitVersion: number;
  /** Must equal the workspace target branch; the caller cannot choose an arbitrary base. */
  proposedBaseRef: string;
  approvalId: string;
  actor: DeliveryActor;
  /** Bridge-resolved caller identity is mandatory for linked projection mutations. */
  caller: Pick<CallerSnapshot, "kind" | "name">;
  operationId?: string;
}

export class DeliveryProjectionService {
  constructor(private readonly deps: DeliveryProjectionServiceDeps) {}

  /**
   * Canonical gated open: claim → intent → deterministic projection open → backlink repair.
   * Crash after any phase converges on reconcile/replay.
   */
  async openCanonical(input: CanonicalOpenInput): Promise<{ delivery: Delivery; projection: GitDelivery }> {
    const operationId = input.operationId ?? this.newOperationId("open");
    const gitDeliveryId = deterministicGitDeliveryId(input.deliveryId);
    const worktreePath = path.resolve(input.worktreePath);

    return this.withClaim(input.deliveryId, async (claim) => {
      return this.deps.withWorktreeLock(worktreePath, async () => {
        const delivery = await this.requireDelivery(input.deliveryId);
        // Bootstrap open is allowed for the exact newly-created Delivery; it grants no cleanup authority.
        const existingIntents = listProjectionIntents(delivery);
        const existingOpen = existingIntents.find((i) => i.action === "open" && i.operationId === operationId);
        let sequence: number;
        let afterIntent = delivery;

        if (existingOpen) {
          this.assertReplayIntent(existingOpen, {
            gitDeliveryId,
            action: "open",
            actor: input.actor,
            expected: { branchRef: input.branchRef, worktreePath, baseRef: input.baseRef, headSha: input.currentHeadSha },
            payload: { agent: input.agent, tachyonCreatedBranch: input.tachyonCreatedBranch, reason: input.reason ?? "canonical open" },
          });
          sequence = existingOpen.projectionSequence;
        } else {
          sequence = nextProjectionSequence(delivery);
          const detail: DeliveryProjectionIntentDetail = {
            projectionSequence: sequence,
            operationId,
            gitDeliveryId,
            action: "open",
            expected: {
              deliveryVersion: delivery.version,
              branchRef: input.branchRef,
              worktreePath,
              baseRef: input.baseRef,
              headSha: input.currentHeadSha,
            },
            actor: input.actor,
            payload: {
              agent: input.agent,
              tachyonCreatedBranch: input.tachyonCreatedBranch,
              reason: input.reason ?? "canonical open",
            },
          };
          afterIntent = await this.appendIntent(claim, delivery, detail);
        }

        const projection = await this.deps.gitDeliveries.open({
          id: gitDeliveryId,
          workspaceId: this.deps.workspaceId,
          createdBy: toGitActor(input.actor),
          deliveryId: input.deliveryId,
          agent: input.agent,
          branchRef: input.branchRef,
          worktreePath,
          tachyonCreatedBranch: input.tachyonCreatedBranch,
          baseRef: input.baseRef,
          ...(input.currentHeadSha ? { currentHeadSha: input.currentHeadSha } : {}),
          reason: input.reason ?? "canonical open",
        });
        this.assertCanonicalOpenProjection(projection, {
          id: gitDeliveryId,
          workspaceId: this.deps.workspaceId,
          deliveryId: input.deliveryId,
          createdBy: toGitActor(input.actor),
          agent: input.agent,
          branchRef: input.branchRef,
          worktreePath,
          tachyonCreatedBranch: input.tachyonCreatedBranch,
          baseRef: input.baseRef,
        });

        // Apply open intent onto projection if not yet applied (idempotent).
        let applied = projection;
        if ((projection.lastAppliedProjectionSequence ?? 0) < sequence) {
          applied = await this.deps.gitDeliveries.applyCanonicalIntent({
            id: projection.id,
            expectedVersion: projection.version,
            sequence,
            operationId,
            deliveryId: input.deliveryId,
            mutate: (record) => ({
              ...record,
              deliveryId: input.deliveryId,
              ...(input.currentHeadSha ? { currentHeadSha: input.currentHeadSha } : {}),
            }),
          });
        } else if (
          projection.lastAppliedProjectionSequence === sequence
          && projection.lastAppliedOperationId
          && projection.lastAppliedOperationId !== operationId
        ) {
          throw new DeliveryProjectionError(
            `open sequence collision at ${sequence}`,
            "PROJECTION_SEQUENCE",
          );
        }

        // Repair Delivery backlink under the claim.
        const linked = await this.repairOpenBacklink(claim, afterIntent, applied, operationId);
        return { delivery: linked, projection: applied };
      });
    });
  }

  /**
   * Record-only integrate: prove live tip equals expected head and is contained in base,
   * then append/apply one integration intent. Failure leaves both records unchanged.
   */
  async integrate(input: CanonicalIntegrateInput): Promise<{ delivery: Delivery; projection: GitDelivery }> {
    const settings = this.deps.settings();
    const actor = toGitActor(input.actor);
    if (!canIntegrateLinkedGitDelivery(actor, settings.integratePrincipals, input.caller)) {
      throw new DeliveryProjectionError(
        "integrate refused: caller is not a privileged human/system/master or configured integratePrincipal",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    const operationId = input.operationId ?? this.newOperationId("integrate");

    return this.withClaim(input.deliveryId, async (claim) => {
      const projection0 = await this.requireProjection(input.gitDeliveryId, input.deliveryId);
      const worktreePath = path.resolve(projection0.worktreePath);

      return this.deps.withWorktreeLock(worktreePath, async () => {
        await this.assertSafeForMutation(input.deliveryId, "integrate");

        const delivery = await this.requireDelivery(input.deliveryId);
        const projection = await this.requireProjection(input.gitDeliveryId, input.deliveryId);
        const replayIntent = listProjectionIntents(delivery).find((i) => i.operationId === operationId && i.action === "integrate");
        if (replayIntent) {
          this.assertReplayIntent(replayIntent, {
            gitDeliveryId: projection.id, action: "integrate", actor: input.actor,
            expected: { gitDeliveryVersion: input.expectedGitVersion, headSha: input.expectedHeadSha },
            payload: { integrationKind: input.integrationKind ?? "ancestor" },
          });
        }
        if (projection.version !== input.expectedGitVersion) {
          // Idempotent replay of a committed integrate.
          if (replayIntent && (projection.lastAppliedProjectionSequence ?? 0) >= replayIntent.projectionSequence) {
            return { delivery, projection };
          }
          throw new DeliveryProjectionError(
            `GitDelivery version conflict: expected ${input.expectedGitVersion}, found ${projection.version}`,
            "PROJECTION_DRIFT",
          );
        }

        // Live proof before any intent/write.
        const live = await classifyDelivery(projection, {
          workspaceRoot: this.deps.workspaceRoot,
          git: this.deps.git,
          liveness: this.deps.liveness,
        });
        if (!live.currentHeadSha || live.currentHeadSha !== input.expectedHeadSha) {
          throw new DeliveryProjectionError(
            `live branch tip does not equal expected head '${input.expectedHeadSha}' (live=${live.currentHeadSha ?? "missing"})`,
            "PROJECTION_REFUSED",
          );
        }
        const contained = await containedInBase(projection, live.currentHeadSha, {
          workspaceRoot: this.deps.workspaceRoot,
          git: this.deps.git,
        });
        if (!contained) {
          throw new DeliveryProjectionError(
            "live branch tip is not contained in the resolved base",
            "PROJECTION_REFUSED",
          );
        }

        const existing = replayIntent;
        let sequence: number;
        let afterIntent = delivery;
        if (existing) {
          sequence = existing.projectionSequence;
        } else {
          this.assertNoUnappliedProjectionLag(delivery, projection);
          sequence = nextProjectionSequence(delivery);
          const detail: DeliveryProjectionIntentDetail = {
            projectionSequence: sequence,
            operationId,
            gitDeliveryId: projection.id,
            action: "integrate",
            expected: {
              deliveryVersion: delivery.version,
              gitDeliveryVersion: projection.version,
              headSha: input.expectedHeadSha,
              baseRef: projection.baseRef,
              phase: projection.phase,
            },
            actor: input.actor,
            payload: {
              integrationKind: input.integrationKind ?? "ancestor",
              integratedSha: live.currentHeadSha,
            },
          };
          afterIntent = await this.appendIntent(claim, delivery, detail);
        }

        const at = this.now();
        const applied = await this.deps.gitDeliveries.applyCanonicalIntent({
          id: projection.id,
          expectedVersion: projection.version,
          sequence,
          operationId,
          deliveryId: input.deliveryId,
          mutate: (record) => ({
            ...record,
            phase: "integrated",
            currentHeadSha: live.currentHeadSha,
            integratedSha: live.currentHeadSha,
            integration: {
              kind: input.integrationKind ?? "ancestor",
              at,
              by: actor,
              integratedSha: live.currentHeadSha,
              evidence: { proof: "live-contained-in-base" },
            },
            transitions: [
              ...record.transitions,
              { at, from: record.phase, to: "integrated", by: actor, reason: "record-only integrate after live containment proof" },
            ],
          }),
        });
        return { delivery: afterIntent, projection: applied };
      });
    });
  }

  /**
   * t-2dd637 §4 — narrow governed base repair.
   *
   * A recovery-reuse spawn with no prior ledger row degraded the projection base from a symbolic
   * branch ref to a pinned commit SHA, which makes `containedInBase` monotonically unsatisfiable:
   * the branch tip is a descendant of the pin, never an ancestor, and every new commit moves it
   * further away. Resolving a SHA base "up" to the target branch at integrate time was rejected as
   * the shipped rule — it would let ambient workspace state decide a containment proof for every
   * record. This repairs the durable field instead, visibly and under approval, with refusals that
   * provably restrict it to the defect class: the stored base must NOT be an existing branch and
   * must be a real commit SHA, the proposal must be the workspace target branch, and the stored SHA
   * must already be an ancestor of it — so the repair only ever widens to the true fork lineage.
   * Afterwards the ordinary integrate closes the record with its own oracle fully intact.
   */
  async reconcileBase(input: CanonicalReconcileBaseInput): Promise<{ delivery: Delivery; projection: GitDelivery }> {
    const settings = this.deps.settings();
    const actor = toGitActor(input.actor);
    if (!canIntegrateLinkedGitDelivery(actor, settings.integratePrincipals, input.caller)) {
      throw new DeliveryProjectionError(
        "reconcile_base refused: caller is not a privileged human/system/master or configured integratePrincipal",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    const operationId = input.operationId ?? this.newOperationId("reconcile-base");

    return this.withClaim(input.deliveryId, async (claim) => {
      const projection0 = await this.requireProjection(input.gitDeliveryId, input.deliveryId);
      const worktreePath = path.resolve(projection0.worktreePath);

      return this.deps.withWorktreeLock(worktreePath, async () => {
        await this.assertSafeForMutation(input.deliveryId, RECONCILE_BASE_ACTION);

        const delivery = await this.requireDelivery(input.deliveryId);
        const projection = await this.requireProjection(input.gitDeliveryId, input.deliveryId);
        const currentBaseRef = projection.baseRef;
        const replayIntent = listProjectionIntents(delivery)
          .find((i) => i.operationId === operationId && i.action === RECONCILE_BASE_ACTION);
        if (replayIntent) {
          this.assertReplayIntent(replayIntent, {
            gitDeliveryId: projection.id, action: RECONCILE_BASE_ACTION, actor: input.actor,
            expected: { gitDeliveryVersion: input.expectedGitVersion },
            payload: { proposedBaseRef: input.proposedBaseRef },
          });
        }
        if (projection.version !== input.expectedGitVersion) {
          if (replayIntent && (projection.lastAppliedProjectionSequence ?? 0) >= replayIntent.projectionSequence) {
            return { delivery, projection };
          }
          throw new DeliveryProjectionError(
            `GitDelivery version conflict: expected ${input.expectedGitVersion}, found ${projection.version}`,
            "PROJECTION_DRIFT",
          );
        }

        // Every refusal below runs before any intent is minted, so a refused repair never
        // orphans a projection sequence.
        await this.assertBaseRepairIsDefectClass(currentBaseRef, input.proposedBaseRef);

        const live = await classifyDelivery(projection, {
          workspaceRoot: this.deps.workspaceRoot,
          git: this.deps.git,
          liveness: this.deps.liveness,
        });
        if (!live.currentHeadSha) {
          throw new DeliveryProjectionError(
            "reconcile_base refused: the live branch tip could not be resolved",
            "PROJECTION_REFUSED",
          );
        }
        const actionDigest = baseRepairActionDigest({
          gitDeliveryId: projection.id,
          currentBaseRef,
          proposedBaseRef: input.proposedBaseRef,
          currentHeadSha: live.currentHeadSha,
        });
        // Resolved unconditionally, BEFORE the replay branch: a replay may never dodge the approval
        // check. A replaying second caller must therefore present its own approval bound to this same
        // digest, but the durable intent keeps the ORIGINAL payload — the receipt names the approval
        // that first authorized the repair, not the one just re-verified (rev nit N3).
        const approval = await this.resolveBaseRepairApproval(input, actionDigest);

        let sequence: number;
        let afterIntent = delivery;
        if (replayIntent) {
          sequence = replayIntent.projectionSequence;
        } else {
          this.assertNoUnappliedProjectionLag(delivery, projection);
          sequence = nextProjectionSequence(delivery);
          const detail: ProjectionIntentDetail = {
            projectionSequence: sequence,
            operationId,
            gitDeliveryId: projection.id,
            action: RECONCILE_BASE_ACTION,
            expected: {
              deliveryVersion: delivery.version,
              gitDeliveryVersion: projection.version,
              headSha: live.currentHeadSha,
              baseRef: currentBaseRef,
              phase: projection.phase,
            },
            actor: input.actor,
            payload: {
              proposedBaseRef: input.proposedBaseRef,
              approvalId: input.approvalId,
              actionDigest,
              payloadHash: approval.payloadHash,
              resolvedAt: approval.resolvedAt,
              ...(approval.resolvedBy ? { resolvedBy: approval.resolvedBy } : {}),
            },
          };
          afterIntent = await this.appendIntent(claim, delivery, detail);
        }

        const at = this.now();
        const applied = await this.deps.gitDeliveries.applyCanonicalIntent({
          id: projection.id,
          expectedVersion: projection.version,
          sequence,
          operationId,
          deliveryId: input.deliveryId,
          // §4 scopes the repair to `baseRef` alone, so the direct path mutates exactly the field
          // the reconcile-loop replay does (rev nit N1). The stored `currentHeadSha` is derived
          // state that `classifyDelivery` re-reads from live Git on every use and only falls back
          // to when no live tip was resolvable — refreshing it here would make the two paths write
          // different field sets for the same approved repair.
          mutate: (record) => ({
            ...record,
            baseRef: input.proposedBaseRef,
            transitions: [
              ...record.transitions,
              {
                at,
                from: record.phase,
                to: record.phase,
                by: actor,
                reason: `governed base repair: pinned SHA '${currentBaseRef}' restored to target branch '${input.proposedBaseRef}'`,
              },
            ],
          }),
        });
        return { delivery: afterIntent, projection: applied };
      });
    });
  }

  /**
   * Fail-closed proof that this record is the pinned-SHA defect class and that the proposal only
   * widens to the true fork lineage. Note that `git check-ref-format --branch` is NOT sufficient
   * on its own: a 40-hex object name is a syntactically valid branch name and passes it. The
   * load-bearing discriminator is that the stored base does not exist as a branch but does resolve
   * as a commit.
   */
  private async assertBaseRepairIsDefectClass(currentBaseRef: string, proposedBaseRef: string): Promise<void> {
    if (!this.deps.targetBranch) {
      throw new DeliveryProjectionError(
        "reconcile_base refused: the workspace target branch is not resolvable on this projection service",
        "PROJECTION_REFUSED",
      );
    }
    let targetBranch: string;
    try { targetBranch = await this.deps.targetBranch(); }
    catch (error) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: target branch resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        "PROJECTION_REFUSED",
      );
    }
    if (!targetBranch || proposedBaseRef !== targetBranch) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: proposed base '${proposedBaseRef}' is not the workspace target branch '${targetBranch}'`,
        "PROJECTION_REFUSED",
      );
    }
    if (await this.gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${currentBaseRef}`])) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: stored base '${currentBaseRef}' is already a symbolic branch ref, not the pinned-SHA defect class`,
        "PROJECTION_REFUSED",
      );
    }
    if (!FULL_SHA.test(currentBaseRef) || !await this.gitOk(["rev-parse", "--verify", "--quiet", `${currentBaseRef}^{commit}`])) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: stored base '${currentBaseRef}' is neither a branch nor a resolvable commit; this is not the repairable defect class`,
        "PROJECTION_REFUSED",
      );
    }
    if (!await this.gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${proposedBaseRef}`])) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: proposed base branch '${proposedBaseRef}' does not exist`,
        "PROJECTION_REFUSED",
      );
    }
    if (!await this.gitOk(["merge-base", "--is-ancestor", currentBaseRef, proposedBaseRef])) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: stored base '${currentBaseRef}' is not an ancestor of '${proposedBaseRef}'; the repair would retarget an unrelated base`,
        "PROJECTION_REFUSED",
      );
    }
  }

  private async gitOk(args: string[]): Promise<boolean> {
    const out = await this.deps.git(args, this.deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return out.code === 0;
  }

  private async resolveBaseRepairApproval(
    input: CanonicalReconcileBaseInput,
    actionDigest: string,
  ): Promise<DeliveryRecoveryApproval> {
    if (!this.deps.resolveBaseRepairApproval || !input.approvalId) {
      throw new DeliveryProjectionError(
        "reconcile_base refused: a bound human approval is required and no approval resolver is available",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    let approval: DeliveryRecoveryApproval;
    try { approval = await this.deps.resolveBaseRepairApproval(input.approvalId, input.actor, actionDigest); }
    catch (error) {
      throw new DeliveryProjectionError(
        `reconcile_base refused: approval resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        "PROJECTION_UNAUTHORIZED",
      );
    }
    if (approval?.decision !== "approved" || approval.actionDigest !== actionDigest
      || !approval.payloadHash || !approval.resolvedAt) {
      throw new DeliveryProjectionError(
        "reconcile_base refused: approval is not an exact approved receipt bound to this action digest",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    if (input.actor.kind === "agent" && approval.requester !== input.actor.name) {
      throw new DeliveryProjectionError(
        "reconcile_base refused: approval was requested by a different principal",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    return approval;
  }

  /**
   * Authorized prune: intent first, re-check live predicates under both locks, safe removal, apply pruned.
   * Retry after crash re-observes live Git and completes idempotently.
   */
  async prune(input: CanonicalPruneInput): Promise<{ delivery: Delivery; projection: GitDelivery; result: PruneResult }> {
    const settings = this.deps.settings();
    const actor = toGitActor(input.actor);
    if (!canPruneLinkedGitDelivery(actor, settings.prunePrincipals, input.caller)) {
      throw new DeliveryProjectionError(
        "prune refused: caller is not a privileged human/system/master or configured prunePrincipal",
        "PROJECTION_UNAUTHORIZED",
      );
    }
    if (input.forceLoseCommits && !input.abandon) {
      throw new DeliveryProjectionError(
        "forceLoseCommits requires the authorized abandon prune path",
        "PROJECTION_REFUSED",
      );
    }
    const operationId = input.operationId ?? this.newOperationId("prune");

    return this.withClaim(input.deliveryId, async (claim) => {
      const projection0 = await this.requireProjection(input.gitDeliveryId, input.deliveryId);
      const worktreePath = path.resolve(projection0.worktreePath);

      return this.deps.withWorktreeLock(worktreePath, async () => {
        await this.assertSafeForMutation(input.deliveryId, input.abandon ? "prune_abandon" : "prune");

        const delivery = await this.requireDelivery(input.deliveryId);
        let projection = await this.requireProjection(input.gitDeliveryId, input.deliveryId);

        // Idempotent completion if already applied.
        const existing = listProjectionIntents(delivery).find((i) => i.operationId === operationId && i.action === "prune");
        if (existing) {
          this.assertReplayIntent(existing, {
            gitDeliveryId: projection.id, action: "prune", actor: input.actor,
            expected: { gitDeliveryVersion: input.expectedGitVersion, abandon: input.abandon, forceLoseCommits: input.forceLoseCommits, doomedShas: input.doomedShas },
            payload: {},
          });
        }
        if (existing && (projection.lastAppliedProjectionSequence ?? 0) >= existing.projectionSequence && projection.phase === "pruned") {
          return {
            delivery,
            projection,
            result: { ok: true, removedWorktree: false, deletedBranch: false, message: "prune already applied (idempotent)" },
          };
        }

        if (projection.version !== input.expectedGitVersion && !(existing && projection.phase === "pruned")) {
          // After crash, Git may already be removed while version advanced or not — re-check live.
          if (!existing) {
            throw new DeliveryProjectionError(
              `GitDelivery version conflict: expected ${input.expectedGitVersion}, found ${projection.version}`,
              "PROJECTION_DRIFT",
            );
          }
        }

        if (input.forceLoseCommits && delivery.lease.state !== "abandoned") {
          throw new DeliveryProjectionError(
            "forceLoseCommits requires canonical abandoned lease state",
            "PROJECTION_REFUSED",
          );
        }

        const pruneInput: PruneInput = {
          id: projection.id,
          expectedVersion: projection.version,
          abandon: input.abandon,
          forceLoseCommits: input.forceLoseCommits,
          doomedShas: input.doomedShas,
        };
        const pruneDeps = {
          workspaceRoot: this.deps.workspaceRoot,
          git: this.deps.git,
          liveness: this.deps.liveness,
          worktreeOccupancy: this.deps.worktreeOccupancy,
          removeManagedWorktree: this.deps.removeManagedWorktree,
          now: () => this.now(),
        };
        // t-b3242a: fail closed on prune guards BEFORE appending a canonical intent.
        if (!existing) {
          const assessment = await assessPruneDelivery(projection, pruneInput, pruneDeps);
          if (!assessment.ok) {
            throw new DeliveryProjectionError(
              `prune refused:\n- ${assessment.reasons.join("\n- ")}`,
              "PROJECTION_REFUSED",
            );
          }
          this.assertNoUnappliedProjectionLag(delivery, projection);
        }

        let sequence: number;
        let afterIntent = delivery;
        if (existing) {
          sequence = existing.projectionSequence;
        } else {
          sequence = nextProjectionSequence(delivery);
          const detail: DeliveryProjectionIntentDetail = {
            projectionSequence: sequence,
            operationId,
            gitDeliveryId: projection.id,
            action: "prune",
            expected: {
              deliveryVersion: delivery.version,
              gitDeliveryVersion: projection.version,
              phase: projection.phase,
              abandon: input.abandon,
              forceLoseCommits: input.forceLoseCommits,
              doomedShas: input.doomedShas,
            },
            actor: input.actor,
            payload: {},
          };
          afterIntent = await this.appendIntent(claim, delivery, detail);
        }

        // Re-observe live Git under both locks (mutate only after intent).
        const pruned = await pruneDeliveryRecord(projection, pruneInput, actor, pruneDeps);

        if (!pruned.result.ok) {
          // If intent was for missing-ref and live still shows absence of both, allow only when
          // pruneDeliveryRecord already said ok. Otherwise refuse without applying.
          throw new DeliveryProjectionError(
            `prune refused:\n- ${pruned.result.reasons.join("\n- ")}`,
            "PROJECTION_REFUSED",
          );
        }

        if (!pruned.next) {
          throw new DeliveryProjectionError("prune produced no next record", "PROJECTION_REFUSED");
        }

        const applied = await this.deps.gitDeliveries.applyCanonicalIntent({
          id: projection.id,
          expectedVersion: projection.version,
          sequence,
          operationId,
          deliveryId: input.deliveryId,
          mutate: () => {
            const next = structuredClone(pruned.next!);
            // Preserve identity fields; pruneDeliveryRecord already transitions phase.
            return next;
          },
        });
        return { delivery: afterIntent, projection: applied, result: pruned.result };
      });
    });
  }

  /**
   * Read the canonical intent log and apply pending intents in order under claim/worktree lock.
   */
  async reconcile(deliveryId: string): Promise<{ delivery: Delivery; projection?: GitDelivery; applied: number }> {
    return this.withClaim(deliveryId, async (claim) => {
      const delivery = await this.requireDelivery(deliveryId);
      const intents = listProjectionIntents(delivery);
      if (intents.length === 0) return { delivery, applied: 0 };

      const gitId = delivery.gitDeliveryId ?? intents[0]!.gitDeliveryId;
      let projection = await this.deps.gitDeliveries.get(gitId);
      const worktreePath = path.resolve(
        projection?.worktreePath
          ?? (intents.find((i) => i.expected.worktreePath)?.expected.worktreePath as string | undefined)
          ?? this.deps.workspaceRoot,
      );

      return this.deps.withWorktreeLock(worktreePath, async () => {
        let currentDelivery = await this.requireDelivery(deliveryId);
        let currentProjection = await this.deps.gitDeliveries.get(gitId);
        let applied = 0;
        const ordered = listProjectionIntents(currentDelivery).sort((a, b) => a.projectionSequence - b.projectionSequence);

        for (const intent of ordered) {
          const last = currentProjection?.lastAppliedProjectionSequence ?? 0;
          if (intent.projectionSequence < last) {
            continue;
          }
          if (intent.projectionSequence === last) {
            if (
              currentProjection?.lastAppliedOperationId
              && currentProjection.lastAppliedOperationId !== intent.operationId
            ) {
              throw new DeliveryProjectionError(
                `sequence ${intent.projectionSequence} collision during reconcile`,
                "PROJECTION_SEQUENCE",
              );
            }
            // Crash after projection apply but before Delivery backlink: repair open link only.
            if (intent.action === "open" && currentProjection) {
              currentDelivery = await this.repairOpenBacklink(claim, currentDelivery, currentProjection, intent.operationId);
              if (currentDelivery.gitDeliveryId === currentProjection.id) applied += 1;
            }
            continue;
          }
          if (intent.projectionSequence !== last + 1) {
            throw new DeliveryProjectionError(
              `projection sequence gap during reconcile: expected ${last + 1}, found ${intent.projectionSequence}`,
              "PROJECTION_SEQUENCE",
            );
          }

          if (intent.action === "open") {
            const branchRef = String(intent.expected.branchRef ?? currentDelivery.contract.taskRef);
            const wt = path.resolve(String(intent.expected.worktreePath ?? worktreePath));
            const agent = String(intent.payload.agent ?? "unknown");
            currentProjection = await this.deps.gitDeliveries.open({
              id: intent.gitDeliveryId,
              workspaceId: this.deps.workspaceId,
              createdBy: toGitActor(intent.actor),
              deliveryId,
              agent,
              branchRef,
              worktreePath: wt,
              tachyonCreatedBranch: Boolean(intent.payload.tachyonCreatedBranch ?? true),
              baseRef: String(intent.expected.baseRef ?? "HEAD"),
              ...(intent.expected.headSha ? { currentHeadSha: String(intent.expected.headSha) } : {}),
              reason: String(intent.payload.reason ?? "reconcile open"),
            });
            this.assertCanonicalOpenProjection(currentProjection, {
              id: intent.gitDeliveryId,
              workspaceId: this.deps.workspaceId,
              deliveryId,
              createdBy: toGitActor(intent.actor),
              agent,
              branchRef,
              worktreePath: wt,
              tachyonCreatedBranch: Boolean(intent.payload.tachyonCreatedBranch ?? true),
              baseRef: String(intent.expected.baseRef ?? "HEAD"),
            });
            currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
              id: currentProjection.id,
              expectedVersion: currentProjection.version,
              sequence: intent.projectionSequence,
              operationId: intent.operationId,
              deliveryId,
              mutate: (record) => ({ ...record, deliveryId }),
            });
            currentDelivery = await this.repairOpenBacklink(claim, currentDelivery, currentProjection, intent.operationId);
            applied += 1;
            continue;
          }

          if (!currentProjection) {
            throw new DeliveryProjectionError(
              `missing GitDelivery '${intent.gitDeliveryId}' for pending ${intent.action}`,
              "PROJECTION_NOT_FOUND",
            );
          }

          if (intent.action === "integrate") {
            const expectedHead = String(intent.expected.headSha ?? "");
            const live = await classifyDelivery(currentProjection, {
              workspaceRoot: this.deps.workspaceRoot,
              git: this.deps.git,
              liveness: this.deps.liveness,
            });
            if (!live.currentHeadSha || live.currentHeadSha !== expectedHead) {
              throw new DeliveryProjectionError(
                "reconcile integrate refused: live head does not match intent",
                "PROJECTION_REFUSED",
              );
            }
            const contained = await containedInBase(currentProjection, live.currentHeadSha, {
              workspaceRoot: this.deps.workspaceRoot,
              git: this.deps.git,
            });
            if (!contained) {
              throw new DeliveryProjectionError(
                "reconcile integrate refused: live tip not contained in base",
                "PROJECTION_REFUSED",
              );
            }
            const at = this.now();
            const gitActor = toGitActor(intent.actor);
            currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
              id: currentProjection.id,
              expectedVersion: currentProjection.version,
              sequence: intent.projectionSequence,
              operationId: intent.operationId,
              deliveryId,
              mutate: (record) => ({
                ...record,
                phase: "integrated",
                currentHeadSha: live.currentHeadSha,
                integratedSha: live.currentHeadSha,
                integration: {
                  kind: (intent.payload.integrationKind as "ancestor") ?? "ancestor",
                  at,
                  by: gitActor,
                  integratedSha: live.currentHeadSha,
                  evidence: { proof: "live-contained-in-base", reconcile: true },
                },
                transitions: [
                  ...record.transitions,
                  { at, from: record.phase, to: "integrated", by: gitActor, reason: "reconcile record-only integrate" },
                ],
              }),
            });
            applied += 1;
            continue;
          }

          if (intent.action === RECONCILE_BASE_ACTION) {
            // The intent is the durable authority for the repair (as it is for integrate), so the
            // approval is not re-resolved here. The defect-class predicates ARE re-checked against
            // live Git; if they no longer hold, advance the sequence without touching baseRef so a
            // stale repair intent cannot wedge every later intent behind it.
            const proposedBaseRef = String(intent.payload.proposedBaseRef ?? "");
            const at = this.now();
            const gitActor = toGitActor(intent.actor);
            let repair: ((record: GitDelivery) => GitDelivery) | undefined;
            let noOpReason: string;
            if (!proposedBaseRef) {
              noOpReason = "the intent carries no proposed base ref";
            } else if (currentProjection.baseRef === proposedBaseRef) {
              noOpReason = `the base is already the symbolic ref '${proposedBaseRef}'`;
            } else {
              const stillDefective = await this.assertBaseRepairIsDefectClass(currentProjection.baseRef, proposedBaseRef)
                .then(() => true).catch(() => false);
              if (stillDefective) {
                noOpReason = "";
                repair = (record) => ({
                  ...record,
                  baseRef: proposedBaseRef,
                  transitions: [
                    ...record.transitions,
                    { at, from: record.phase, to: record.phase, by: gitActor, reason: "reconcile governed base repair" },
                  ],
                });
              } else {
                noOpReason = `stored base '${currentProjection.baseRef}' is no longer the repairable defect class`;
              }
            }
            // An APPROVED repair that turns out to be a stale no-op must still leave a durable trace
            // (rev nit N2): without one, the only record is the original intent, which reads as
            // applied. The sequence advances either way, so this audits the no-op without
            // reintroducing the wedge the comment above guards against.
            currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
              id: currentProjection.id,
              expectedVersion: currentProjection.version,
              sequence: intent.projectionSequence,
              operationId: intent.operationId,
              deliveryId,
              mutate: repair ?? ((record) => ({
                ...record,
                transitions: [
                  ...record.transitions,
                  {
                    at,
                    from: record.phase,
                    to: record.phase,
                    by: gitActor,
                    reason: `reconcile governed base repair no-op (operation '${intent.operationId}'): ${noOpReason}`,
                  },
                ],
              })),
            });
            applied += 1;
            continue;
          }

          if (intent.action === "prune") {
            // Re-observe live; complete idempotently.
            if (currentProjection.phase === "pruned") {
              // Ensure sequence is marked applied if a prior crash applied phase but not sequence (shouldn't happen).
              if ((currentProjection.lastAppliedProjectionSequence ?? 0) < intent.projectionSequence) {
                currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
                  id: currentProjection.id,
                  expectedVersion: currentProjection.version,
                  sequence: intent.projectionSequence,
                  operationId: intent.operationId,
                  deliveryId,
                  mutate: (record) => record,
                });
              }
              applied += 1;
              continue;
            }
            const pruneInput: PruneInput = {
              id: currentProjection.id,
              expectedVersion: currentProjection.version,
              abandon: Boolean(intent.expected.abandon),
              forceLoseCommits: Boolean(intent.expected.forceLoseCommits),
              doomedShas: intent.expected.doomedShas,
            };
            const pruned = await pruneDeliveryRecord(currentProjection, pruneInput, toGitActor(intent.actor), {
              workspaceRoot: this.deps.workspaceRoot,
              git: this.deps.git,
              liveness: this.deps.liveness,
              worktreeOccupancy: this.deps.worktreeOccupancy,
              removeManagedWorktree: this.deps.removeManagedWorktree,
              now: () => this.now(),
            });
            if (!pruned.result.ok || !pruned.next) {
              // t-b3242a: unapplied prune intent that still fails guards would wedge forever.
              // Advance the projection sequence without side effects so later intents can apply.
              currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
                id: currentProjection.id,
                expectedVersion: currentProjection.version,
                sequence: intent.projectionSequence,
                operationId: intent.operationId,
                deliveryId,
                mutate: (record) => record,
              });
              applied += 1;
              continue;
            }
            currentProjection = await this.deps.gitDeliveries.applyCanonicalIntent({
              id: currentProjection.id,
              expectedVersion: currentProjection.version,
              sequence: intent.projectionSequence,
              operationId: intent.operationId,
              deliveryId,
              mutate: () => structuredClone(pruned.next!),
            });
            applied += 1;
          }
        }

        return { delivery: currentDelivery, projection: currentProjection, applied };
      });
    });
  }

  private async withClaim<T>(deliveryId: string, fn: (claim: DeliveryProjectionClaimCapability) => Promise<T>): Promise<T> {
    let claim: DeliveryProjectionClaimCapability;
    try {
      claim = await this.deps.deliveries.claimProjection(deliveryId);
    } catch (error) {
      if (error instanceof DeliveryProjectionClaimError) {
        throw new DeliveryProjectionError(error.message, "PROJECTION_BUSY", true);
      }
      throw error;
    }
    try {
      return await fn(claim);
    } finally {
      await this.deps.deliveries.releaseProjection(claim).catch(() => undefined);
    }
  }

  private async appendIntent(
    claim: DeliveryProjectionClaimCapability,
    delivery: Delivery,
    detail: ProjectionIntentDetail,
  ): Promise<Delivery> {
    const event: DeliveryEvent = {
      id: this.newEventId(detail.projectionSequence),
      at: this.now(),
      type: PROJECTION_INTENT_EVENT_TYPE,
      by: detail.actor,
      detail: detail as unknown as Record<string, unknown>,
    };
    return this.deps.deliveries.updateUnderProjectionClaim(
      claim,
      delivery.version,
      (record) => {
        // Guard against concurrent intent append races under the claim.
        const existing = listProjectionIntents(record).find((i) => i.operationId === detail.operationId);
        if (existing) {
          if (!sameIntent(existing, detail)) {
            throw new DeliveryProjectionError(
              `operationId '${detail.operationId}' was used for a different projection intent`,
              "PROJECTION_SEQUENCE",
            );
          }
          return record;
        }
        const nextSeq = nextProjectionSequence(record);
        if (detail.projectionSequence !== nextSeq) {
          throw new DeliveryProjectionError(
            `projection sequence race: expected ${nextSeq}, got ${detail.projectionSequence}`,
            "PROJECTION_SEQUENCE",
          );
        }
        return { ...record, events: [...record.events, event] };
      },
      {
        operationId: `proj-intent:${detail.operationId}`,
        intent: detail,
      },
    );
  }

  /** t-b3242a: refuse minting a new intent while the projection lags unapplied canonical intents. */
  private assertNoUnappliedProjectionLag(delivery: Delivery, projection: GitDelivery): void {
    const maxIntent = maxProjectionIntentSequence(delivery);
    const applied = projection.lastAppliedProjectionSequence ?? 0;
    if (maxIntent > applied) {
      throw new DeliveryProjectionError(
        `projection has unapplied intent(s) (lastApplied=${applied}, latestIntent=${maxIntent}); call reconcile first`,
        "PROJECTION_SEQUENCE",
      );
    }
  }

  /** Refuse reuse of an operation id unless every caller-controlled persisted field matches. */
  private assertReplayIntent(
    existing: ProjectionIntentDetail,
    replay: Pick<ProjectionIntentDetail, "gitDeliveryId" | "action" | "actor"> & {
      expected: Record<string, unknown>;
      payload: Record<string, unknown>;
    },
  ): void {
    const expected = existing.expected as Record<string, unknown>;
    const expectedMatches = Object.entries(replay.expected)
      .every(([key, value]) => isDeepStrictEqual(expected[key], value));
    const payloadMatches = Object.entries(replay.payload)
      .every(([key, value]) => isDeepStrictEqual(existing.payload[key], value));
    if (existing.gitDeliveryId !== replay.gitDeliveryId || existing.action !== replay.action
      || !isDeepStrictEqual(existing.actor, replay.actor) || !expectedMatches || !payloadMatches) {
      throw new DeliveryProjectionError(
        `operationId '${existing.operationId}' was retried with altered projection intent`,
        "PROJECTION_SEQUENCE",
      );
    }
  }

  private async assertSafeForMutation(
    deliveryId: string,
    action: "integrate" | "prune" | "prune_abandon" | typeof RECONCILE_BASE_ACTION,
  ): Promise<void> {
    let snapshot: ReloadReconciliationSnapshot;
    try {
      snapshot = await this.deps.loadReloadSnapshot(deliveryId);
    } catch (error) {
      throw new DeliveryProjectionError(
        `T14 snapshot read failed: ${error instanceof Error ? error.message : String(error)}`,
        "PROJECTION_UNSAFE",
      );
    }
    const delivery = await this.requireDelivery(deliveryId);
    const classif = snapshot.byId.get(deliveryId);
    if (!classif) {
      throw new DeliveryProjectionError("T14 snapshot missing delivery classification", "PROJECTION_UNSAFE");
    }

    // Reciprocal link required for linked mutations.
    if (!delivery.gitDeliveryId) {
      // open is the only special action; integrate/prune require an existing link.
      throw new DeliveryProjectionError("Delivery has no linked GitDelivery", "PROJECTION_DRIFT");
    }
    const projection = await this.deps.gitDeliveries.get(delivery.gitDeliveryId);
    if (!projection || projection.deliveryId !== delivery.id) {
      throw new DeliveryProjectionError("missing or non-reciprocal GitDelivery link", "PROJECTION_DRIFT");
    }

    // A reload snapshot predating salvage can still describe the former held lease. Re-establish
    // terminal safety from live occupancy at the mutation boundary; unknown/live observations fail closed.
    let safetyClass = classif.class;
    let safetyReason = classif.reason;
    if ((delivery.lease.state === "free" || delivery.lease.state === "abandoned") && safetyClass !== "terminal"
      && this.deps.worktreeOccupancy) {
      const [liveState, occupant] = await Promise.all([
        this.deps.liveness(projection.agent).catch((): "unknown" => "unknown"),
        this.deps.worktreeOccupancy(projection.worktreePath).catch(() => ({ state: "live" as const, agent: "unknown", cwd: projection.worktreePath })),
      ]);
      if (liveState === "not_live" && !occupant) {
        safetyClass = "terminal";
        safetyReason = `current ${delivery.lease.state} lease has no live agent or worktree occupant`;
      }
    }

    if (safetyClass === "held" || safetyClass === "quarantined" || safetyClass === "unavailable") {
      throw new DeliveryProjectionError(
        `linked Delivery safety class '${safetyClass}' refuses ${action}: ${safetyReason}`,
        "PROJECTION_UNSAFE",
      );
    }
    if (safetyClass !== "terminal") {
      throw new DeliveryProjectionError(
        `unknown T14 classification '${safetyClass}' refuses ${action}`,
        "PROJECTION_UNSAFE",
      );
    }

    // reconcile_base is a precondition for a normal integrate and carries the same lease
    // requirement: it may only touch a released, terminal record.
    if (action === "integrate" || action === RECONCILE_BASE_ACTION) {
      if (delivery.lease.state !== "free") {
        throw new DeliveryProjectionError(
          `${action} requires free lease (found ${delivery.lease.state})`,
          "PROJECTION_UNSAFE",
        );
      }
      return;
    }

    if (action === "prune") {
      if (delivery.lease.state !== "free") {
        throw new DeliveryProjectionError(
          `normal prune requires free lease (found ${delivery.lease.state})`,
          "PROJECTION_UNSAFE",
        );
      }
      return;
    }

    // prune_abandon
    if (delivery.lease.state !== "abandoned") {
      throw new DeliveryProjectionError(
        `abandon prune requires abandoned lease (found ${delivery.lease.state})`,
        "PROJECTION_UNSAFE",
      );
    }
  }

  private async repairOpenBacklink(
    claim: DeliveryProjectionClaimCapability,
    delivery: Delivery,
    projection: GitDelivery,
    operationId: string,
  ): Promise<Delivery> {
    if (delivery.gitDeliveryId === projection.id) return delivery;
    if (delivery.gitDeliveryId && delivery.gitDeliveryId !== projection.id) {
      throw new DeliveryProjectionError("backlink drift during reconcile", "PROJECTION_DRIFT");
    }
    const intent = { gitDeliveryId: projection.id, action: "open-backlink" as const };
    const tryUpdate = async (opId: string) => this.deps.deliveries.updateUnderProjectionClaim(
      claim,
      delivery.version,
      (record) => ({ ...record, gitDeliveryId: projection.id }),
      { operationId: opId, intent },
    );
    try {
      return await tryUpdate(`${operationId}:backlink`);
    } catch (error) {
      // A prior successful backlink receipt may exist while the durable row was later repaired;
      // allow a versioned recovery operation id without widening authority.
      if (error instanceof DeliveryInvariantError && /operation id/.test(error.message)) {
        return tryUpdate(`${operationId}:backlink:r${delivery.version}`);
      }
      throw error;
    }
  }

  private async requireDelivery(id: string): Promise<Delivery> {
    const d = await this.deps.deliveries.get(id);
    if (!d) throw new DeliveryNotFoundError(id);
    return d;
  }

  private async requireProjection(gitDeliveryId: string, deliveryId: string): Promise<GitDelivery> {
    const p = await this.deps.gitDeliveries.get(gitDeliveryId);
    if (!p) {
      throw new DeliveryProjectionError(`GitDelivery '${gitDeliveryId}' not found`, "PROJECTION_NOT_FOUND");
    }
    if (p.deliveryId !== deliveryId) {
      throw new DeliveryProjectionError(
        `GitDelivery '${gitDeliveryId}' is linked to '${p.deliveryId}', not '${deliveryId}'`,
        "PROJECTION_DRIFT",
      );
    }
    return p;
  }

  /** Defense in depth at the cross-store boundary: a replay may never retarget authority. */
  private assertCanonicalOpenProjection(
    projection: GitDelivery,
    expected: Pick<GitDelivery,
      | "id"
      | "workspaceId"
      | "deliveryId"
      | "createdBy"
      | "agent"
      | "branchRef"
      | "worktreePath"
      | "tachyonCreatedBranch"
      | "baseRef"
    >,
  ): void {
    const actual = {
      id: projection.id,
      workspaceId: projection.workspaceId,
      deliveryId: projection.deliveryId,
      createdBy: projection.createdBy,
      agent: projection.agent,
      branchRef: projection.branchRef,
      worktreePath: path.resolve(projection.worktreePath),
      tachyonCreatedBranch: projection.tachyonCreatedBranch,
      baseRef: projection.baseRef,
    };
    const normalizedExpected = { ...expected, worktreePath: path.resolve(expected.worktreePath) };
    if (!isDeepStrictEqual(actual, normalizedExpected)) {
      throw new DeliveryProjectionError(
        `canonical open returned a projection that does not match immutable intent for '${expected.deliveryId}'`,
        "PROJECTION_DRIFT",
      );
    }
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private newOperationId(kind: string): string {
    return this.deps.operationId?.() ?? `proj-${kind}-${randomBytes(8).toString("hex")}`;
  }

  private newEventId(seq: number): string {
    return this.deps.eventId?.() ?? `proj-evt-${seq}-${randomBytes(4).toString("hex")}`;
  }
}

export function maxProjectionIntentSequence(delivery: Delivery): number {
  const intents = listProjectionIntents(delivery);
  if (intents.length === 0) return 0;
  return intents[intents.length - 1]!.projectionSequence;
}

export function listProjectionIntents(delivery: Delivery): ProjectionIntentDetail[] {
  const out: ProjectionIntentDetail[] = [];
  for (const event of delivery.events) {
    if (event.type !== PROJECTION_INTENT_EVENT_TYPE || !event.detail) continue;
    const detail = event.detail as unknown as ProjectionIntentDetail;
    if (
      typeof detail.projectionSequence === "number"
      && typeof detail.operationId === "string"
      && typeof detail.gitDeliveryId === "string"
      && (detail.action === "open" || detail.action === "integrate" || detail.action === "prune"
        || detail.action === RECONCILE_BASE_ACTION)
    ) {
      out.push(detail);
    }
  }
  return out.sort((a, b) => a.projectionSequence - b.projectionSequence);
}

export function nextProjectionSequence(delivery: Delivery): number {
  const intents = listProjectionIntents(delivery);
  if (intents.length === 0) return 1;
  return intents[intents.length - 1]!.projectionSequence + 1;
}

function sameIntent(a: ProjectionIntentDetail, b: ProjectionIntentDetail): boolean {
  return isDeepStrictEqual(
    {
      projectionSequence: a.projectionSequence,
      operationId: a.operationId,
      gitDeliveryId: a.gitDeliveryId,
      action: a.action,
      expected: a.expected,
      payload: a.payload,
      actor: a.actor,
    },
    {
      projectionSequence: b.projectionSequence,
      operationId: b.operationId,
      gitDeliveryId: b.gitDeliveryId,
      action: b.action,
      expected: b.expected,
      payload: b.payload,
      actor: b.actor,
    },
  );
}

function toGitActor(actor: DeliveryActor): GitDeliveryActor {
  return actor.kind === "agent" ? { kind: "agent", name: actor.name } : { kind: actor.kind, ...(actor.name ? { name: actor.name } : {}) };
}

/**
 * Build a minimal T14 snapshot for one Delivery from store contents (tests / service default).
 * Production Workspace may inject a fuller recompute.
 */
export async function buildSingleDeliveryReloadSnapshot(input: {
  delivery: Delivery;
  projection?: GitDelivery;
  sessions?: ReadonlyMap<string, import("../resume/SessionLedger.js").SessionRecord>;
  processByAgent?: ReadonlyMap<string, ObservedProcess>;
}): Promise<ReloadReconciliationSnapshot> {
  const linked: LinkedGitProjection[] = [];
  if (input.projection?.deliveryId && input.projection.worktreePath) {
    linked.push({
      gitDeliveryId: input.projection.id,
      deliveryId: input.projection.deliveryId,
      worktreePath: input.projection.worktreePath,
    });
  }
  return reconcileDeliveryReload({
    deliveries: [input.delivery],
    linkedProjections: linked,
    sessions: input.sessions ?? new Map(),
    processByAgent: input.processByAgent ?? new Map(),
  });
}

/** Fingerprint helper for tests / diagnostics. */
export function projectionIntentFingerprint(detail: DeliveryProjectionIntentDetail): string {
  return createHash("sha256").update(JSON.stringify(detail)).digest("hex");
}

export type { ReloadDeliveryClassification };
