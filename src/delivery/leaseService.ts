import path from "node:path";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { isOwnsSubset } from "../agents/reuseWorktree.js";
import type { ProcessFencePort } from "../agents/processFence.js";
import {
  DeliveryInvariantError,
  DeliveryNotFoundError,
  DeliveryStore,
  DeliveryStoreBusyError,
  DeliveryVersionConflictError,
} from "./store.js";
import type {
  DelegationSegmentRole,
  Delivery,
  DeliveryActor,
  DeliveryLeaseHolder,
  DeliveryProcessIdentity,
  DeliveryLeaseState,
} from "./types.js";

export interface WaitForDeliveryLeaseInput {
  deliveryId: string;
  afterVersion?: number;
  timeoutMs: number;
}

export interface WaitForDeliveryLeaseResult {
  deliveryId: string;
  outcome: "released" | "quarantined" | "disappeared" | "changed" | "timeout";
  waitedMs: number;
  version?: number;
  state?: DeliveryLeaseState;
}

export interface DeliveryLeaseWaitTiming {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  pollMs: number;
}

const DEFAULT_LEASE_WAIT_POLL_MS = 100;
const MAX_LEASE_WAIT_MS = 300_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError")));
    timer = setTimeout(() => settle(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Read-only bounded observation of a Delivery lease. This deliberately uses only DeliveryStore.get. */
export async function waitForDeliveryLease(
  store: Pick<DeliveryStore, "get">,
  input: WaitForDeliveryLeaseInput,
  timing: DeliveryLeaseWaitTiming = {
    now: () => performance.now(),
    sleep: abortableSleep,
    pollMs: DEFAULT_LEASE_WAIT_POLL_MS,
  },
  signal?: AbortSignal,
): Promise<WaitForDeliveryLeaseResult> {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_LEASE_WAIT_MS) {
    throw new RangeError(`timeoutMs must be an integer between 1 and ${MAX_LEASE_WAIT_MS}`);
  }
  if (input.afterVersion !== undefined && (!Number.isInteger(input.afterVersion) || input.afterVersion < 0)) {
    throw new RangeError("afterVersion must be a non-negative integer");
  }
  if (!Number.isFinite(timing.pollMs) || timing.pollMs <= 0) throw new RangeError("pollMs must be positive");

  const startedAt = timing.now();
  const deadline = startedAt + input.timeoutMs;
  let baseline = input.afterVersion;
  let last: { version: number; state: DeliveryLeaseState } | undefined;
  const result = (outcome: WaitForDeliveryLeaseResult["outcome"], observed = last): WaitForDeliveryLeaseResult => ({
    deliveryId: input.deliveryId,
    outcome,
    waitedMs: Math.max(0, timing.now() - startedAt),
    ...(observed ? { version: observed.version, state: observed.state } : {}),
  });

  while (true) {
    signal?.throwIfAborted();
    try {
      const delivery = await store.get(input.deliveryId);
      signal?.throwIfAborted();
      if (!delivery) return {
        deliveryId: input.deliveryId,
        outcome: "disappeared",
        waitedMs: Math.max(0, timing.now() - startedAt),
      };
      last = { version: delivery.version, state: delivery.lease.state };
      if (delivery.lease.state === "quarantined") return result("quarantined");
      if (delivery.lease.state === "free") return result("released");
      if (baseline !== undefined && baseline !== delivery.version) return result("changed");
      baseline ??= delivery.version;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof DeliveryStoreBusyError)) throw error;
    }

    const remaining = deadline - timing.now();
    if (remaining <= 0) return result("timeout");
    signal?.throwIfAborted();
    await timing.sleep(Math.min(timing.pollMs, remaining), signal);
  }
}

export type DeliveryLeaseErrorCode =
  | "DELIVERY_LEASE_UNAVAILABLE"
  | "WORKTREE_OCCUPIED"
  | "DELIVERY_HEAD_CHANGED"
  | "DELIVERY_NON_LINEAR_HEAD"
  | "DELIVERY_OWNS_WIDENING"
  | "DELIVERY_WORKTREE_MISMATCH"
  | "DELIVERY_INVALID_STATE"
  | "DELIVERY_PROCESS_IDENTITY_MISSING"
  | "DELIVERY_WORKTREE_DIRTY"
  | "DELIVERY_FENCE_FAILED"
  | "DELIVERY_QUARANTINED";

export class DeliveryLeaseError extends Error {
  constructor(
    readonly code: DeliveryLeaseErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(detail ? `${code}: ${message} ${JSON.stringify(detail)}` : `${code}: ${message}`);
    this.name = "DeliveryLeaseError";
  }
}

export interface DeliveryLeaseAcquireInput {
  deliveryId: string;
  expectedVersion?: number;
  expectedHeadSha: string;
  canonicalWorktree: string;
  role: DelegationSegmentRole;
  executionAgent: string;
  principal?: string;
  grantedBy: DeliveryActor;
  ownsSubset: string[];
  operationId: string;
}

export interface DeliveryLeaseReservation {
  delivery: Delivery;
  reservationNonce: string;
}

export interface DeliveryLeaseHandoffInput {
  deliveryId: string;
  canonicalWorktree: string;
  expectedFinalHeadSha: string;
  role: DelegationSegmentRole;
  executionAgent: string;
  principal?: string;
  ownsSubset: string[];
  grantedBy: DeliveryActor;
  operationId: string;
}

export interface DeliveryWorktreeInspection {
  headSha: string;
  clean: boolean;
}

export interface DeliveryReviewInspection {
  headSha: string;
  taskRefSha: string;
  indexTreeSha: string;
  commitTreeSha: string;
  trackedClean: boolean;
}

export interface DeliveryCompleteReviewInput {
  deliveryId: string;
  canonicalWorktree: string;
  expectedReviewedHeadSha: string;
  verdict: "ACCEPT" | "FINDINGS";
  actor: DeliveryActor;
  operationId: string;
}

export type DeliveryProcessObservation =
  | { state: "alive" }
  | { state: "gone" }
  | { state: "unknown"; reason: string };

export interface DeliveryProcessObserver {
  observe(identity: DeliveryProcessIdentity): DeliveryProcessObservation | Promise<DeliveryProcessObservation>;
}

export interface DeliveryReconcileHolderInput {
  deliveryId: string;
  canonicalWorktree: string;
  actor: DeliveryActor;
  operationId: string;
}

export type DeliveryReconcileHolderResult =
  | { outcome: "alive"; delivery: Delivery }
  | { outcome: "interrupted"; delivery: Delivery };

export interface DeliveryLeaseServiceDeps {
  store: DeliveryStore;
  processFence: ProcessFencePort;
  processObserver?: DeliveryProcessObserver;
  canonicalWorktreeFor(delivery: Delivery): string | Promise<string>;
  readHead(canonicalWorktree: string): string | Promise<string>;
  inspectWorktree(canonicalWorktree: string): DeliveryWorktreeInspection | Promise<DeliveryWorktreeInspection>;
  inspectReviewWorktree?(canonicalWorktree: string, taskRef: string): DeliveryReviewInspection | Promise<DeliveryReviewInspection>;
  isAncestor(older: string, newer: string, canonicalWorktree: string): boolean | Promise<boolean>;
  withWorktreeLock<T>(canonicalWorktree: string, fn: () => Promise<T>): Promise<T>;
  now?: () => string;
  nonce?: () => string;
  segmentId?: () => string;
  eventId?: () => string;
}

/**
 * T5 acquisition slice. The durable SQLite CAS is the cross-process authority. The
 * process-local Delivery mutex is always acquired before the canonical worktree mutex;
 * no runtime spawn, waiting, or process-fence operation occurs under either lock.
 */
export class DeliveryLeaseService {
  private readonly deliveryLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: DeliveryLeaseServiceDeps) {}

  async reconcileHolder(input: DeliveryReconcileHolderInput): Promise<DeliveryReconcileHolderResult> {
    const canonicalWorktree = path.resolve(input.canonicalWorktree);
    const intent = { ...structuredClone(input), canonicalWorktree };
    const interruptedOperation = `${input.operationId}:interrupt`;
    const quarantineOperation = `${input.operationId}:quarantine`;
    const interruptedReplay = await this.replayReconcileInterrupted(interruptedOperation, input.deliveryId, intent);
    if (interruptedReplay) return { outcome: "interrupted", delivery: interruptedReplay };
    const quarantineReplay = await this.replayEvent(quarantineOperation, input.deliveryId,
      "holder_reconcile_quarantined", intent, "quarantined");
    if (quarantineReplay) throw this.reconcileRefusal(parseReason(quarantineReplay.lease.reason));

    let snapshot!: { lease: Delivery["lease"]; holder: DeliveryLeaseHolder; expectedHeadSha: string };
    let initialFailure: unknown;
    await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
      const current = await this.deps.store.get(input.deliveryId);
      if (!current) throw new DeliveryNotFoundError(input.deliveryId);
      const actualCanonical = path.resolve(await this.deps.canonicalWorktreeFor(current));
      if (actualCanonical !== canonicalWorktree) {
        throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "caller worktree is not the canonical Delivery worktree",
          { expected: actualCanonical, actual: canonicalWorktree });
      }
      if (["pending", "draining", "verifying"].includes(current.lease.state)) throw this.occupied(current, "Delivery has an owned in-flight operation");
      if (current.lease.state === "quarantined") throw this.reconcileRefusal(parseReason(current.lease.reason));
      if (current.lease.state !== "held" || !current.lease.holder) {
        throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "holder reconciliation requires a held lease");
      }
      const holder = structuredClone(current.lease.holder);
      const tail = current.segments.at(-1);
      snapshot = { lease: structuredClone(current.lease), holder, expectedHeadSha: current.lease.expectedHeadSha ?? "" };
      if (!tail || tail.releasedAt || tail.id !== holder.segmentId || tail.executionAgent !== holder.executionAgent
        || tail.principal !== holder.principal || !current.lease.expectedHeadSha || !validProcessIdentity(holder.process)
        || !holder.executionNonce) {
        initialFailure = new DeliveryLeaseError("DELIVERY_PROCESS_IDENTITY_MISSING", false,
          "held lease does not have an exact durable holder identity");
      }
    }));
    if (initialFailure) return this.quarantineReconcileAndThrow(input, intent, snapshot, initialFailure);

    let observation: DeliveryProcessObservation;
    try {
      observation = this.deps.processObserver
        ? await this.deps.processObserver.observe(structuredClone(snapshot.holder.process!))
        : { state: "unknown", reason: "exact process observation is unavailable" };
    } catch (error) {
      return this.quarantineReconcileAndThrow(input, intent, snapshot, error);
    }
    if (observation.state === "alive") {
      let liveDelivery: Delivery | undefined;
      let liveFailure: unknown;
      await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        if (["pending", "draining", "verifying"].includes(current.lease.state)) throw this.occupied(current, "another owned operation won reconciliation");
        if (current.lease.state !== "held") throw this.occupied(current, "held lease changed during reconciliation");
        if (!isDeepStrictEqual(current.lease, snapshot.lease)) liveFailure = new Error("held holder changed during live observation");
        else liveDelivery = current;
      }));
      if (liveFailure) return this.quarantineReconcileAndThrow(input, intent, snapshot, liveFailure);
      return { outcome: "alive", delivery: liveDelivery! };
    }
    if (observation.state === "unknown") {
      return this.quarantineReconcileAndThrow(input, intent, snapshot,
        new Error(`exact process identity is unknown: ${observation.reason}`));
    }

    let proof: Awaited<ReturnType<ProcessFencePort["proveEmpty"]>>;
    try {
      const capability = this.deps.processFence.capability();
      if (!capability.supported) throw new Error(capability.reason);
      proof = await this.deps.processFence.proveEmpty(snapshot.holder.executionNonce!, canonicalWorktree);
    } catch (error) {
      return this.quarantineReconcileAndThrow(input, intent, snapshot, error);
    }
    if (proof.state !== "proven_empty") {
      return this.quarantineReconcileAndThrow(input, intent, snapshot,
        new Error(`process fence proof was ${proof.state}${proof.state === "unknown" ? `: ${proof.reason}` : ""}`));
    }

    let terminalFailure: unknown;
    try {
      const delivery = await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        const actualCanonical = path.resolve(await this.deps.canonicalWorktreeFor(current));
        if (actualCanonical !== canonicalWorktree) throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "Delivery worktree changed during reconciliation");
        if (["pending", "draining", "verifying"].includes(current.lease.state)) throw this.occupied(current, "another owned operation won reconciliation");
        if (current.lease.state !== "held") throw this.occupied(current, "held lease changed during reconciliation");
        if (!isDeepStrictEqual(current.lease, snapshot.lease)) throw new Error("held holder changed during reconciliation");
        const tail = current.segments.at(-1);
        if (!tail || tail.releasedAt || tail.id !== snapshot.holder.segmentId || tail.executionAgent !== snapshot.holder.executionAgent
          || tail.principal !== snapshot.holder.principal) throw new Error("open holder segment changed during reconciliation");
        const first = await this.inspect(canonicalWorktree);
        this.assertReconcileInspection(first, snapshot.expectedHeadSha);
        const second = await this.inspect(canonicalWorktree);
        this.assertReconcileInspection(second, snapshot.expectedHeadSha);
        return this.deps.store.update(current.id, current.version, (record) => {
          if (!isDeepStrictEqual(record.lease, snapshot.lease)) throw new DeliveryVersionConflictError(current.id, current.version, record.version);
          const open = record.segments.at(-1);
          if (!open || open.releasedAt || open.id !== snapshot.holder.segmentId) throw new DeliveryInvariantError("reconciled holder tail changed");
          open.releasedAt = this.now(); open.releasedHeadSha = second.headSha; open.outcome = "interrupted";
          record.lease = { state: "free", changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "holder_interrupted", by: structuredClone(input.actor),
            detail: { operationId: input.operationId, intent, segmentId: open.id, executionNonce: snapshot.holder.executionNonce, headSha: second.headSha } });
          return record;
        }, { operationId: interruptedOperation, intent });
      }));
      return { outcome: "interrupted", delivery };
    } catch (error) {
      let replay: Delivery | undefined;
      try { replay = await this.replayReconcileInterrupted(interruptedOperation, input.deliveryId, intent); }
      catch (replayError) {
        if (!(replayError instanceof DeliveryInvariantError && replayError.message.startsWith("invalid operation id"))) throw replayError;
      }
      if (replay) return { outcome: "interrupted", delivery: replay };
      if (error instanceof DeliveryLeaseError && error.code === "WORKTREE_OCCUPIED") throw error;
      terminalFailure = error;
    }
    return this.quarantineReconcileAndThrow(input, intent, snapshot, terminalFailure);
  }

  async acquire(input: DeliveryLeaseAcquireInput): Promise<DeliveryLeaseReservation> {
    try { return await this.acquireInternal(input); }
    catch (error) {
      if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
      throw error;
    }
  }

  private async acquireInternal(input: DeliveryLeaseAcquireInput): Promise<DeliveryLeaseReservation> {
    const capability = this.deps.processFence.capability();
    if (!capability.supported) {
      throw new DeliveryLeaseError("DELIVERY_LEASE_UNAVAILABLE", false, capability.reason);
    }
    const ownsSubset = normalizeOwns(input.ownsSubset);
    if (input.role === "reviewer" && ownsSubset.length !== 0) {
      throw new DeliveryLeaseError("DELIVERY_OWNS_WIDENING", false, "reviewer authority must be exactly empty");
    }
    const intent = acquireIntent(input, path.resolve(input.canonicalWorktree), ownsSubset);
    const replay = await this.replayAcquire(input.operationId, input.deliveryId, intent);
    if (replay) return replay;
    return this.withDeliveryLock(input.deliveryId, async () => {
      const lockedReplay = await this.replayAcquire(input.operationId, input.deliveryId, intent);
      if (lockedReplay) return lockedReplay;
      const observed = await this.deps.store.get(input.deliveryId);
      if (!observed) throw new DeliveryNotFoundError(input.deliveryId);
      const canonicalWorktree = path.resolve(await this.deps.canonicalWorktreeFor(observed));
      if (path.resolve(input.canonicalWorktree) !== canonicalWorktree) {
        throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "caller worktree is not the canonical Delivery worktree", {
          expected: canonicalWorktree, actual: path.resolve(input.canonicalWorktree),
        });
      }
      return this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        this.assertAcquirable(current);
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          throw this.occupied(current, "Delivery changed before acquisition");
        }
        if (!isOwnsSubset(ownsSubset, current.contract.owns)) {
          throw new DeliveryLeaseError("DELIVERY_OWNS_WIDENING", false, "requested owns subset exceeds the immutable Delivery contract", {
            requested: ownsSubset, contract: current.contract.owns,
          });
        }
        const liveHead = await this.deps.readHead(canonicalWorktree);
        if (liveHead !== input.expectedHeadSha) {
          throw new DeliveryLeaseError("DELIVERY_HEAD_CHANGED", false, "canonical worktree HEAD changed before acquisition", {
            expected: input.expectedHeadSha, actual: liveHead,
          });
        }
        const predecessor = current.segments.at(-1);
        if (predecessor && !predecessor.releasedAt) {
          throw new DeliveryInvariantError("a successor acquisition requires a closed predecessor segment");
        }
        if (predecessor?.releasedHeadSha
          && !await this.deps.isAncestor(predecessor.releasedHeadSha, liveHead, canonicalWorktree)) {
          throw new DeliveryLeaseError("DELIVERY_NON_LINEAR_HEAD", false, "expected HEAD is not an ancestor-linear successor boundary", {
            predecessor: predecessor.releasedHeadSha, actual: liveHead,
          });
        }
        if (input.role === "reviewer") {
          const reviewInspection = await this.inspectReview(canonicalWorktree, current.contract.taskRef);
          this.assertReviewInspection(reviewInspection, input.expectedHeadSha);
        }
        const now = this.deps.now?.() ?? new Date().toISOString();
        const reservationNonce = this.deps.nonce?.() ?? randomBytes(16).toString("hex");
        const segmentId = this.deps.segmentId?.() ?? `seg-${randomBytes(8).toString("hex")}`;
        const eventId = this.deps.eventId?.() ?? `event-${randomBytes(8).toString("hex")}`;
        try {
          const recheckedHead = await this.deps.readHead(canonicalWorktree);
          if (recheckedHead !== liveHead) {
            throw new DeliveryLeaseError("DELIVERY_HEAD_CHANGED", false, "canonical worktree HEAD moved during acquisition", {
              expected: liveHead, actual: recheckedHead,
            });
          }
          if (input.role === "reviewer") {
            const recheckedReview = await this.inspectReview(canonicalWorktree, current.contract.taskRef);
            this.assertReviewInspection(recheckedReview, input.expectedHeadSha);
          }
          const delivery = await this.deps.store.update(current.id, current.version, (record) => {
            this.assertAcquirable(record);
            record.segments.push({
              id: segmentId,
              index: record.segments.length,
              role: input.role,
              executionAgent: input.executionAgent,
              ...(input.principal ? { principal: input.principal } : {}),
              grantedBy: structuredClone(input.grantedBy),
              ownsSubset,
              grantedHeadSha: liveHead,
              grantedAt: now,
            });
            record.lease = {
              state: "pending",
              holder: {
                segmentId,
                executionAgent: input.executionAgent,
                ...(input.principal ? { principal: input.principal } : {}),
                reservationNonce,
              },
              expectedHeadSha: liveHead,
              changedAt: now,
            };
            record.events.push({
              id: eventId, at: now, type: "lease_reserved", by: structuredClone(input.grantedBy),
              detail: { segmentId, executionAgent: input.executionAgent, role: input.role, operationId: input.operationId, intent },
            });
            return record;
          }, {
            operationId: input.operationId,
            intent,
          });
          return { delivery, reservationNonce };
        } catch (error) {
          if (error instanceof DeliveryVersionConflictError) {
            const winnerReplay = await this.replayAcquire(input.operationId, input.deliveryId, intent);
            if (winnerReplay) return winnerReplay;
            const winner = await this.deps.store.get(input.deliveryId);
            if (winner) throw this.occupied(winner, "another acquisition won the Delivery CAS");
          }
          if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
          throw error;
        }
      });
    });
  }

  async confirmHeld(deliveryId: string, reservationNonce: string, process: DeliveryProcessIdentity, operationId: string): Promise<Delivery> {
    try { return await this.confirmHeldInternal(deliveryId, reservationNonce, process, operationId); }
    catch (error) {
      if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
      throw error;
    }
  }

  private async confirmHeldInternal(deliveryId: string, reservationNonce: string, process: DeliveryProcessIdentity, operationId: string): Promise<Delivery> {
    const intent = { deliveryId, reservationNonce, process: structuredClone(process) };
    const replay = await this.replayConfirmation(operationId, deliveryId, intent);
    if (replay) return replay;
    return this.withDeliveryLock(deliveryId, async () => {
      const lockedReplay = await this.replayConfirmation(operationId, deliveryId, intent);
      if (lockedReplay) return lockedReplay;
      const current = await this.deps.store.get(deliveryId);
      if (!current) throw new DeliveryNotFoundError(deliveryId);
      if (current.lease.state !== "pending" || current.lease.holder?.reservationNonce !== reservationNonce) {
        throw this.occupied(current, "reservation is no longer pending for this nonce");
      }
      const now = this.deps.now?.() ?? new Date().toISOString();
      try {
        return await this.deps.store.update(deliveryId, current.version, (record) => {
          if (record.lease.state !== "pending" || record.lease.holder?.reservationNonce !== reservationNonce) {
            throw this.occupied(record, "reservation changed before confirmation");
          }
          const holder = record.lease.holder;
          record.lease = {
            ...record.lease,
            state: "held",
            holder: {
              segmentId: holder.segmentId,
              executionAgent: holder.executionAgent,
              ...(holder.principal ? { principal: holder.principal } : {}),
              process,
              executionNonce: reservationNonce,
            },
            changedAt: now,
          };
          record.events.push({
            id: this.deps.eventId?.() ?? `event-${randomBytes(8).toString("hex")}`,
            at: now, type: "lease_held", by: { kind: "system" },
            detail: { segmentId: record.lease.holder?.segmentId, operationId, intent },
          });
          return record;
        }, { operationId, intent });
      } catch (error) {
        if (error instanceof DeliveryVersionConflictError) {
          const winnerReplay = await this.replayConfirmation(operationId, deliveryId, intent);
          if (winnerReplay) return winnerReplay;
          const winner = await this.deps.store.get(deliveryId);
          if (winner) throw this.occupied(winner, "another confirmation changed the Delivery CAS");
        }
        if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
        throw error;
      }
    });
  }

  async failPending(deliveryId: string, reservationNonce: string, reason: string, operationId: string): Promise<Delivery> {
    const intent = { deliveryId, reservationNonce, reason };
    const replay = await this.replayEvent(operationId, deliveryId, "lease_pending_failed", intent, "quarantined");
    if (replay) return replay;
    return this.withDeliveryLock(deliveryId, async () => {
      const current = await this.deps.store.get(deliveryId);
      if (!current) throw new DeliveryNotFoundError(deliveryId);
      if (current.lease.state !== "pending" || current.lease.holder?.reservationNonce !== reservationNonce) {
        throw this.occupied(current, "pending reservation no longer matches this nonce");
      }
      return this.deps.store.update(deliveryId, current.version, (record) => {
        if (record.lease.state !== "pending" || record.lease.holder?.reservationNonce !== reservationNonce) {
          throw this.occupied(record, "pending reservation changed before failure compensation");
        }
        record.lease = { ...record.lease, state: "quarantined", reason, changedAt: this.now() };
        record.events.push({ id: this.eventId(), at: this.now(), type: "lease_pending_failed", by: { kind: "system" }, detail: { operationId, intent } });
        return record;
      }, { operationId, intent });
    });
  }

  async handoff(input: DeliveryLeaseHandoffInput): Promise<DeliveryLeaseReservation> {
    const capability = this.deps.processFence.capability();
    if (!capability.supported) throw new DeliveryLeaseError("DELIVERY_LEASE_UNAVAILABLE", false, capability.reason);
    const ownsSubset = normalizeOwns(input.ownsSubset);
    const canonicalWorktree = path.resolve(input.canonicalWorktree);
    const intent = { ...structuredClone(input), canonicalWorktree, ownsSubset };
    const replay = await this.replayHandoff(`${input.operationId}:reserve`, input.deliveryId, intent);
    if (replay) return replay;

    let predecessorHolder: DeliveryLeaseHolder | undefined;
    const committedDrain = await this.replayDrain(`${input.operationId}:drain`, input.deliveryId, input.operationId, intent);
    if (committedDrain) {
      predecessorHolder = committedDrain;
    } else try {
      await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        const actualCanonical = path.resolve(await this.deps.canonicalWorktreeFor(current));
        if (actualCanonical !== canonicalWorktree) {
          throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "caller worktree is not the canonical Delivery worktree", { expected: actualCanonical, actual: canonicalWorktree });
        }
        this.assertHandoffAuthority(current, input, ownsSubset, canonicalWorktree);
        predecessorHolder = structuredClone(current.lease.holder!);
        const inspection = await this.inspect(canonicalWorktree);
        await this.assertInspection(current, inspection, input.expectedFinalHeadSha, canonicalWorktree);
        await this.deps.store.update(current.id, current.version, (record) => {
          this.assertExactHolder(record, "held", predecessorHolder!);
          record.lease = { ...record.lease, state: "draining", changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "handoff_draining", by: structuredClone(input.grantedBy), detail: { operationId: input.operationId, executionNonce: predecessorHolder!.executionNonce, intent } });
          return record;
        }, { operationId: `${input.operationId}:drain`, intent });
      }));
    } catch (error) {
      const recovered = await this.replayDrain(`${input.operationId}:drain`, input.deliveryId, input.operationId, intent);
      if (recovered) {
        predecessorHolder = recovered;
      } else {
        if (error instanceof DeliveryVersionConflictError || error instanceof DeliveryStoreBusyError) {
          const winner = await this.deps.store.get(input.deliveryId);
          if (winner) throw this.occupied(winner, "another handoff won the draining CAS");
        }
        throw error;
      }
    }
    if (!predecessorHolder?.executionNonce) throw new DeliveryInvariantError("handoff predecessor holder was not durably established");

    let fenceError: unknown;
    let proof: Awaited<ReturnType<ProcessFencePort["proveEmpty"]>> = { state: "unknown", reason: "fence did not complete" };
    try { await this.deps.processFence.freeze(predecessorHolder.executionNonce); } catch (error) { fenceError = error; }
    try { await this.deps.processFence.terminate(predecessorHolder.executionNonce); } catch (error) { fenceError ??= error; }
    try { proof = await this.deps.processFence.proveEmpty(predecessorHolder.executionNonce, canonicalWorktree); } catch (error) { fenceError ??= error; }
    if (fenceError || proof.state !== "proven_empty") {
      return this.quarantineAndThrow(input, intent, predecessorHolder, {
        phase: "fence", proof, error: fenceError instanceof Error ? fenceError.message : fenceError === undefined ? undefined : String(fenceError),
      });
    }

    try {
      return await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        this.assertExactHolder(current, "draining", predecessorHolder!);
        const first = await this.inspect(canonicalWorktree);
        await this.assertInspection(current, first, input.expectedFinalHeadSha, canonicalWorktree);
        const second = await this.inspect(canonicalWorktree);
        await this.assertInspection(current, second, input.expectedFinalHeadSha, canonicalWorktree);
        const reservationNonce = this.deps.nonce?.() ?? randomBytes(16).toString("hex");
        const segmentId = this.deps.segmentId?.() ?? `seg-${randomBytes(8).toString("hex")}`;
        const delivery = await this.deps.store.update(current.id, current.version, (record) => {
          this.assertExactHolder(record, "draining", predecessorHolder!);
          const tail = record.segments.at(-1)!;
          tail.releasedAt = this.now(); tail.releasedHeadSha = second.headSha; tail.outcome = "completed";
          record.segments.push({ id: segmentId, index: record.segments.length, role: input.role, executionAgent: input.executionAgent,
            ...(input.principal ? { principal: input.principal } : {}), grantedBy: structuredClone(input.grantedBy), ownsSubset,
            grantedHeadSha: second.headSha, grantedAt: this.now() });
          record.lease = { state: "pending", holder: { segmentId, executionAgent: input.executionAgent,
            ...(input.principal ? { principal: input.principal } : {}), reservationNonce }, expectedHeadSha: second.headSha, changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "handoff_reserved", by: structuredClone(input.grantedBy), detail: { operationId: input.operationId, segmentId, reservationNonce, intent } });
          return record;
        }, { operationId: `${input.operationId}:reserve`, intent });
        return { delivery, reservationNonce };
      }));
    } catch (error) {
      const committed = await this.replayHandoff(`${input.operationId}:reserve`, input.deliveryId, intent);
      if (committed) return committed;
      if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
      return this.quarantineAndThrow(input, intent, predecessorHolder, { phase: "final", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async completeReview(input: DeliveryCompleteReviewInput): Promise<Delivery> {
    const canonicalWorktree = path.resolve(input.canonicalWorktree);
    const intent = { ...structuredClone(input), canonicalWorktree };
    const completedReplay = await this.replayReviewCompletion(`${input.operationId}:complete`, input.deliveryId, intent);
    if (completedReplay) return completedReplay;

    let reviewerHolder = await this.replayReviewDrain(`${input.operationId}:drain`, input.deliveryId, intent);
    if (!reviewerHolder) {
      try {
        await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
          const current = await this.deps.store.get(input.deliveryId);
          if (!current) throw new DeliveryNotFoundError(input.deliveryId);
          const actualCanonical = path.resolve(await this.deps.canonicalWorktreeFor(current));
          if (actualCanonical !== canonicalWorktree) {
            throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "caller worktree is not the canonical Delivery worktree");
          }
          reviewerHolder = this.assertReviewHolder(current, "held", input.expectedReviewedHeadSha);
          await this.deps.store.update(current.id, current.version, (record) => {
            this.assertExactHolder(record, "held", reviewerHolder!);
            this.assertReviewTail(record, input.expectedReviewedHeadSha);
            record.lease = { ...record.lease, state: "draining", changedAt: this.now() };
            record.events.push({ id: this.eventId(), at: this.now(), type: "review_draining", by: structuredClone(input.actor),
              detail: { operationId: input.operationId, intent, executionNonce: reviewerHolder!.executionNonce } });
            return record;
          }, { operationId: `${input.operationId}:drain`, intent });
        }));
      } catch (error) {
        reviewerHolder = await this.replayReviewDrain(`${input.operationId}:drain`, input.deliveryId, intent);
        if (!reviewerHolder) throw error;
      }
    }
    if (!reviewerHolder?.executionNonce) throw new DeliveryInvariantError("reviewer drain lacks durable execution identity");

    let fenceError: unknown;
    let proof: Awaited<ReturnType<ProcessFencePort["proveEmpty"]>> = { state: "unknown", reason: "fence did not complete" };
    try { await this.deps.processFence.freeze(reviewerHolder.executionNonce); } catch (error) { fenceError = error; }
    try { await this.deps.processFence.terminate(reviewerHolder.executionNonce); } catch (error) { fenceError ??= error; }
    try { proof = await this.deps.processFence.proveEmpty(reviewerHolder.executionNonce, canonicalWorktree); } catch (error) { fenceError ??= error; }
    if (fenceError || proof.state !== "proven_empty") {
      return this.quarantineReviewAndThrow(input, intent, {
        phase: "fence", proof, error: fenceError instanceof Error ? fenceError.message : fenceError === undefined ? undefined : String(fenceError),
      }, fenceError ?? new Error(`process fence proof was ${proof.state}`));
    }

    try {
      return await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(canonicalWorktree, async () => {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        const actualCanonical = path.resolve(await this.deps.canonicalWorktreeFor(current));
        if (actualCanonical !== canonicalWorktree) throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "review worktree is no longer canonical");
        this.assertExactHolder(current, "draining", reviewerHolder!);
        this.assertReviewTail(current, input.expectedReviewedHeadSha);
        const first = await this.inspectReview(canonicalWorktree, current.contract.taskRef);
        this.assertReviewInspection(first, input.expectedReviewedHeadSha);
        const second = await this.inspectReview(canonicalWorktree, current.contract.taskRef);
        this.assertReviewInspection(second, input.expectedReviewedHeadSha);
        return this.deps.store.update(current.id, current.version, (record) => {
          this.assertExactHolder(record, "draining", reviewerHolder!);
          const tail = this.assertReviewTail(record, input.expectedReviewedHeadSha);
          tail.releasedAt = this.now(); tail.releasedHeadSha = input.expectedReviewedHeadSha; tail.outcome = "completed";
          record.lease = { state: "free", changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "review_completed", by: structuredClone(input.actor),
            detail: { operationId: input.operationId, intent, verdict: input.verdict, reviewedHeadSha: input.expectedReviewedHeadSha } });
          return record;
        }, { operationId: `${input.operationId}:complete`, intent });
      }));
    } catch (error) {
      const replay = await this.replayReviewCompletion(`${input.operationId}:complete`, input.deliveryId, intent);
      if (replay) return replay;
      return this.quarantineReviewAndThrow(input, intent, { phase: "postcondition", error: error instanceof Error ? error.message : String(error) }, error);
    }
  }

  private assertReconcileInspection(inspection: DeliveryWorktreeInspection, expectedHeadSha: string): void {
    if (!inspection.clean) throw new DeliveryLeaseError("DELIVERY_WORKTREE_DIRTY", false, "canonical worktree is dirty");
    if (inspection.headSha !== expectedHeadSha) {
      throw new DeliveryLeaseError("DELIVERY_HEAD_CHANGED", false, "canonical worktree HEAD differs from the held lease",
        { expected: expectedHeadSha, actual: inspection.headSha });
    }
  }

  private async quarantineReconcileAndThrow(
    input: DeliveryReconcileHolderInput,
    intent: Record<string, unknown>,
    snapshot: { lease: Delivery["lease"]; holder: DeliveryLeaseHolder; expectedHeadSha: string },
    original: unknown,
  ): Promise<never> {
    const operationId = `${input.operationId}:quarantine`;
    const evidence = {
      error: original instanceof Error ? original.message : String(original),
      observedExecutionNonce: snapshot.holder.executionNonce,
      expectedHeadSha: snapshot.expectedHeadSha,
    };
    let refusalEvidence: unknown = evidence;
    let persistenceError: unknown;
    try {
      const replay = await this.replayEvent(operationId, input.deliveryId, "holder_reconcile_quarantined", intent, "quarantined");
      if (!replay) {
        await this.withDeliveryLock(input.deliveryId, async () => this.deps.withWorktreeLock(path.resolve(input.canonicalWorktree), async () => {
          const current = await this.deps.store.get(input.deliveryId);
          if (!current) throw new DeliveryNotFoundError(input.deliveryId);
          if (["pending", "draining", "verifying"].includes(current.lease.state)) {
            throw this.occupied(current, "another owned operation won reconciliation");
          }
          if (current.lease.state === "quarantined") throw this.reconcileRefusal(parseReason(current.lease.reason));
          if (current.lease.state !== "held" || !current.lease.holder) throw this.occupied(current, "held lease changed during reconciliation");
          const holder = structuredClone(current.lease.holder);
          const durableEvidence = { ...evidence, currentExecutionNonce: holder.executionNonce, expectedHeadSha: current.lease.expectedHeadSha };
          refusalEvidence = durableEvidence;
          await this.deps.store.update(current.id, current.version, (record) => {
            if (record.lease.state !== "held" || !isDeepStrictEqual(record.lease.holder, holder)) {
              throw new DeliveryVersionConflictError(current.id, current.version, record.version);
            }
            record.lease = { ...record.lease, state: "quarantined", reason: JSON.stringify(durableEvidence), changedAt: this.now() };
            record.events.push({ id: this.eventId(), at: this.now(), type: "holder_reconcile_quarantined", by: structuredClone(input.actor),
              detail: { operationId: input.operationId, intent, holder, expectedHeadSha: record.lease.expectedHeadSha, evidence: durableEvidence } });
            return record;
          }, { operationId, intent });
        }));
      }
    } catch (error) {
      if (error instanceof DeliveryLeaseError && error.code === "WORKTREE_OCCUPIED") throw error;
      if (error instanceof DeliveryLeaseError && error.code === "DELIVERY_QUARANTINED") throw error;
      persistenceError = error;
    }
    const refusal = this.reconcileRefusal(refusalEvidence);
    if (persistenceError) {
      throw new AggregateError([original, persistenceError], "holder reconciliation failed and quarantine persistence is uncertain");
    }
    throw refusal;
  }

  private reconcileRefusal(detail: unknown): DeliveryLeaseError {
    return new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "dead holder could not be safely reconciled", { evidence: detail });
  }

  private async replayReconcileInterrupted(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<Delivery | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "holder_interrupted" && isDeepStrictEqual(candidate.detail?.intent, intent));
    if (!event || delivery.lease.state !== "free") {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this holder reconciliation intent`);
    }
    return delivery;
  }

  private assertReviewHolder(delivery: Delivery, state: "held" | "draining", expectedHead: string): DeliveryLeaseHolder {
    const holder = delivery.lease.holder;
    const tail = this.assertReviewTail(delivery, expectedHead);
    if (delivery.lease.state !== state || !holder || !holder.process || !holder.executionNonce
      || holder.reservationNonce !== undefined || delivery.lease.expectedHeadSha !== expectedHead
      || holder.segmentId !== tail.id || holder.executionAgent !== tail.executionAgent || holder.principal !== tail.principal) {
      throw new DeliveryLeaseError("DELIVERY_PROCESS_IDENTITY_MISSING", false, "reviewer holder is not exact or lacks durable process identity");
    }
    return structuredClone(holder);
  }

  private assertReviewTail(delivery: Delivery, expectedHead: string): Delivery["segments"][number] {
    const tail = delivery.segments.at(-1);
    if (!tail || tail.role !== "reviewer" || tail.releasedAt || tail.ownsSubset.length !== 0 || tail.grantedHeadSha !== expectedHead) {
      throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "open tail is not the pinned empty-authority reviewer segment");
    }
    return tail;
  }

  private async inspectReview(canonicalWorktree: string, taskRef: string): Promise<DeliveryReviewInspection> {
    if (!this.deps.inspectReviewWorktree) {
      throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "review worktree inspection capability is unavailable");
    }
    return this.deps.inspectReviewWorktree(canonicalWorktree, taskRef);
  }

  private assertReviewInspection(inspection: DeliveryReviewInspection, expectedHead: string): void {
    if (inspection.headSha !== expectedHead || inspection.taskRefSha !== expectedHead) {
      throw new DeliveryLeaseError("DELIVERY_HEAD_CHANGED", false, "reviewed HEAD or immutable task ref moved", {
        expected: expectedHead, head: inspection.headSha, taskRef: inspection.taskRefSha,
      });
    }
    if (!inspection.trackedClean) throw new DeliveryLeaseError("DELIVERY_WORKTREE_DIRTY", false, "reviewer changed tracked worktree content");
    if (!inspection.indexTreeSha || !inspection.commitTreeSha || inspection.indexTreeSha !== inspection.commitTreeSha) {
      throw new DeliveryLeaseError("DELIVERY_WORKTREE_DIRTY", false, "reviewer index differs from the pinned commit tree");
    }
  }

  private async quarantineReviewAndThrow(input: DeliveryCompleteReviewInput, intent: Record<string, unknown>, evidence: Record<string, unknown>, original?: unknown): Promise<never> {
    let persistenceError: unknown;
    try {
      const operationId = `${input.operationId}:quarantine`;
      const replay = await this.replayEvent(operationId, input.deliveryId, "review_invalid", intent, "quarantined");
      if (!replay) {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        await this.deps.store.update(current.id, current.version, (record) => {
          if (record.lease.state !== "draining") throw this.occupied(record, "review lease is no longer draining");
          this.assertReviewTail(record, input.expectedReviewedHeadSha);
          record.lease = { ...record.lease, state: "quarantined", reason: JSON.stringify(evidence), changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "review_invalid", by: structuredClone(input.actor),
            detail: { operationId: input.operationId, intent, verdict: input.verdict, reviewedHeadSha: input.expectedReviewedHeadSha, evidence } });
          return record;
        }, { operationId, intent });
      }
    } catch (error) { persistenceError = error; }
    const refusal = new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "review postconditions could not be established", evidence);
    const primary = original ?? refusal;
    if (persistenceError) throw new AggregateError([primary, persistenceError], "review invalidation failed and quarantine persistence is uncertain");
    throw refusal;
  }

  private async replayReviewDrain(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<DeliveryLeaseHolder | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "review_draining" && isDeepStrictEqual(candidate.detail?.intent, intent));
    if (!event || delivery.lease.state !== "draining" || !delivery.lease.holder?.executionNonce) {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this review drain intent`);
    }
    return structuredClone(delivery.lease.holder);
  }

  private async replayReviewCompletion(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<Delivery | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "review_completed" && isDeepStrictEqual(candidate.detail?.intent, intent));
    if (!event || delivery.lease.state !== "free") throw new DeliveryInvariantError(`operation id '${operationId}' does not match this review completion intent`);
    return delivery;
  }

  private assertHandoffAuthority(delivery: Delivery, input: DeliveryLeaseHandoffInput, ownsSubset: string[], canonicalWorktree: string): void {
    const expected = path.resolve(input.canonicalWorktree);
    if (expected !== canonicalWorktree) throw new DeliveryLeaseError("DELIVERY_WORKTREE_MISMATCH", false, "caller worktree is not canonical");
    if (!isOwnsSubset(ownsSubset, delivery.contract.owns)) throw new DeliveryLeaseError("DELIVERY_OWNS_WIDENING", false, "successor authority exceeds the immutable contract");
    const holder = delivery.lease.holder;
    const tail = delivery.segments.at(-1);
    if (["draining", "pending", "verifying"].includes(delivery.lease.state)) throw this.occupied(delivery, "Delivery already has an occupant or handoff in progress");
    if (delivery.lease.state === "quarantined") throw new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "Delivery is quarantined", { deliveryId: delivery.id, reason: delivery.lease.reason });
    if (delivery.lease.state !== "held") throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "handoff requires a held predecessor");
    if (!holder || !tail || tail.releasedAt || tail.id !== holder.segmentId) throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "held predecessor does not match the open tail");
    if (!holder.process || !holder.executionNonce) throw new DeliveryLeaseError("DELIVERY_PROCESS_IDENTITY_MISSING", false, "held predecessor lacks durable process identity or execution nonce");
  }

  private assertExactHolder(delivery: Delivery, state: "held" | "draining", holder: DeliveryLeaseHolder): void {
    if (delivery.lease.state !== state || !isDeepStrictEqual(delivery.lease.holder, holder)) {
      throw this.occupied(delivery, `${state} predecessor holder changed`);
    }
  }

  private async inspect(canonicalWorktree: string): Promise<DeliveryWorktreeInspection> {
    return this.deps.inspectWorktree(canonicalWorktree);
  }

  private async assertInspection(delivery: Delivery, inspection: DeliveryWorktreeInspection, expectedHead: string, canonicalWorktree: string): Promise<void> {
    if (!inspection.clean) throw new DeliveryLeaseError("DELIVERY_WORKTREE_DIRTY", false, "canonical worktree is dirty");
    if (inspection.headSha !== expectedHead) throw new DeliveryLeaseError("DELIVERY_HEAD_CHANGED", false, "canonical worktree HEAD changed", { expected: expectedHead, actual: inspection.headSha });
    const tail = delivery.segments.at(-1);
    if (!tail || !await this.deps.isAncestor(tail.grantedHeadSha, inspection.headSha, canonicalWorktree)) {
      throw new DeliveryLeaseError("DELIVERY_NON_LINEAR_HEAD", false, "handoff HEAD is not ancestor-linear");
    }
  }

  private async quarantineAndThrow(input: DeliveryLeaseHandoffInput, intent: Record<string, unknown>, holder: DeliveryLeaseHolder, evidence: Record<string, unknown>): Promise<never> {
    const operationId = `${input.operationId}:quarantine`;
    let persistenceError: unknown;
    try {
      const replay = await this.replayEvent(operationId, input.deliveryId, "handoff_quarantined", intent, "quarantined");
      if (!replay) {
        const current = await this.deps.store.get(input.deliveryId);
        if (!current) throw new DeliveryNotFoundError(input.deliveryId);
        this.assertExactHolder(current, "draining", holder);
        await this.deps.store.update(current.id, current.version, (record) => {
          this.assertExactHolder(record, "draining", holder);
          record.lease = { ...record.lease, state: "quarantined", reason: JSON.stringify(evidence), changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "handoff_quarantined", by: structuredClone(input.grantedBy), detail: { operationId: input.operationId, executionNonce: holder.executionNonce, evidence, intent } });
          return record;
        }, { operationId, intent });
      }
    } catch (error) { persistenceError = error; }
    const refusal = new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "handoff could not establish a safe successor boundary", evidence);
    if (persistenceError) throw new AggregateError([refusal, persistenceError], "handoff failed and quarantine persistence is uncertain");
    throw refusal;
  }

  private async replayHandoff(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<DeliveryLeaseReservation | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "handoff_reserved" && candidate.detail?.operationId === operationId.slice(0, -8));
    const nonce = event?.detail?.reservationNonce;
    if (!event || !isDeepStrictEqual(event.detail?.intent, intent) || typeof nonce !== "string" || delivery.lease.holder?.reservationNonce !== nonce) {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this handoff intent`);
    }
    return { delivery, reservationNonce: nonce };
  }

  private async replayDrain(operationId: string, deliveryId: string, baseOperationId: string, intent: Record<string, unknown>): Promise<DeliveryLeaseHolder | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "handoff_draining" && candidate.detail?.operationId === baseOperationId);
    const holder = delivery.lease.holder;
    if (!event || !isDeepStrictEqual(event.detail?.intent, intent) || delivery.lease.state !== "draining" || !holder
      || typeof holder.executionNonce !== "string" || event.detail?.executionNonce !== holder.executionNonce) {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this handoff drain intent`);
    }
    return structuredClone(holder);
  }

  private async replayEvent(operationId: string, deliveryId: string, type: string, intent: Record<string, unknown>, state: string): Promise<Delivery | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === type && isDeepStrictEqual(candidate.detail?.intent, intent));
    if (!event || delivery.lease.state !== state) throw new DeliveryInvariantError(`operation id '${operationId}' does not match durable event intent`);
    return delivery;
  }

  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private eventId(): string { return this.deps.eventId?.() ?? `event-${randomBytes(8).toString("hex")}`; }

  private assertAcquirable(delivery: Delivery): void {
    if (delivery.lease.state !== "free") throw this.occupied(delivery, "Delivery already has an occupant or reservation");
  }

  private occupied(delivery: Delivery, message: string): DeliveryLeaseError {
    return new DeliveryLeaseError("WORKTREE_OCCUPIED", true, message, {
      deliveryId: delivery.id,
      version: delivery.version,
      state: delivery.lease.state,
      occupant: delivery.lease.holder?.executionAgent,
    });
  }

  private busy(error: DeliveryStoreBusyError): DeliveryLeaseError {
    return new DeliveryLeaseError("WORKTREE_OCCUPIED", true, "Delivery mutation is contended by another process", {
      storeCode: error.code,
    });
  }

  private async replayAcquire(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<DeliveryLeaseReservation | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "lease_reserved" && candidate.detail?.operationId === operationId);
    const holder = delivery.lease.holder;
    if (!event || !holder || !isDeepStrictEqual(event.detail?.intent, intent) || holder.segmentId !== event.detail?.segmentId
      || typeof holder.reservationNonce !== "string") {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this lease acquisition intent`);
    }
    return { delivery, reservationNonce: holder.reservationNonce };
  }

  private async replayConfirmation(operationId: string, deliveryId: string, intent: Record<string, unknown>): Promise<Delivery | undefined> {
    const delivery = await this.deps.store.getOperationResult(operationId, "update", deliveryId);
    if (!delivery) return undefined;
    const event = delivery.events.find((candidate) => candidate.type === "lease_held" && candidate.detail?.operationId === operationId);
    if (!event || !isDeepStrictEqual(event.detail?.intent, intent) || delivery.lease.state !== "held") {
      throw new DeliveryInvariantError(`operation id '${operationId}' does not match this lease confirmation intent`);
    }
    return delivery;
  }

  private async withDeliveryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const predecessor = this.deliveryLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => current);
    this.deliveryLocks.set(id, tail);
    await predecessor;
    try { return await fn(); }
    finally {
      release();
      if (this.deliveryLocks.get(id) === tail) this.deliveryLocks.delete(id);
    }
  }
}

function normalizeOwns(entries: string[]): string[] {
  const normalized = entries.map((entry) => path.posix.normalize(entry.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, ""));
  if (normalized.some((entry) => !entry || entry === "." || entry === ".." || entry.startsWith("../") || path.posix.isAbsolute(entry))) {
    throw new DeliveryLeaseError("DELIVERY_OWNS_WIDENING", false, "owns subset contains an invalid or escaping path");
  }
  return [...new Set(normalized)].sort();
}

function acquireIntent(input: DeliveryLeaseAcquireInput, canonicalWorktree: string, ownsSubset: string[]): Record<string, unknown> {
  return {
    deliveryId: input.deliveryId,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    expectedHeadSha: input.expectedHeadSha,
    canonicalWorktree,
    role: input.role,
    executionAgent: input.executionAgent,
    ...(input.principal ? { principal: input.principal } : {}),
    grantedBy: structuredClone(input.grantedBy),
    ownsSubset,
  };
}

function validProcessIdentity(identity: DeliveryProcessIdentity | undefined): identity is DeliveryProcessIdentity {
  return !!identity && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && typeof identity.processStart === "string" && identity.processStart.length > 0
    && typeof identity.bootId === "string" && identity.bootId.length > 0;
}

function parseReason(reason: string | undefined): unknown {
  if (!reason) return undefined;
  try { return JSON.parse(reason); } catch { return reason; }
}
