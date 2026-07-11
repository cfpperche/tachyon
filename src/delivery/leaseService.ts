import path from "node:path";
import { randomBytes } from "node:crypto";
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
  DeliveryProcessIdentity,
} from "./types.js";

export type DeliveryLeaseErrorCode =
  | "DELIVERY_LEASE_UNAVAILABLE"
  | "WORKTREE_OCCUPIED"
  | "DELIVERY_HEAD_CHANGED"
  | "DELIVERY_NON_LINEAR_HEAD"
  | "DELIVERY_OWNS_WIDENING"
  | "DELIVERY_WORKTREE_MISMATCH";

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

export interface DeliveryLeaseServiceDeps {
  store: DeliveryStore;
  processFence: ProcessFencePort;
  canonicalWorktreeFor(delivery: Delivery): string | Promise<string>;
  readHead(canonicalWorktree: string): string | Promise<string>;
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

  private assertAcquirable(delivery: Delivery): void {
    if (delivery.lease.state !== "free") throw this.occupied(delivery, "Delivery already has an occupant or reservation");
  }

  private occupied(delivery: Delivery, message: string): DeliveryLeaseError {
    return new DeliveryLeaseError("WORKTREE_OCCUPIED", true, message, {
      deliveryId: delivery.id,
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
