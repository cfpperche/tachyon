import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { CallerSnapshot } from "../bridge/callerIdentity.js";
import type { GitDeliveryStore } from "../git-delivery/store.js";
import type { GitDelivery } from "../git-delivery/types.js";
import { DeliveryLeaseError } from "./leaseService.js";
import { DeliveryStore, DeliveryStoreBusyError, DeliveryVersionConflictError } from "./store.js";
import { LEASE_DISPOSITION } from "./types.js";
import type { Delivery, DeliveryActor, DeliveryLease, DeliveryLeaseHolder, DeliveryVerificationIntent } from "./types.js";
import { resolveOperationalSegment } from "./verificationSubject.js";

const execFileP = promisify(execFile);
const DISABLED_GIT_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export interface DeliveryVerificationEvidence {
  refSha: string;
  treeSha: string;
  verdict: "accept" | "blocked";
  integrityHash: string;
  recordPath: string;
}

export interface PreparedDeliveryVerification<T> {
  publish(): Promise<{ result: T; evidence: DeliveryVerificationEvidence }>;
}

export interface DeliveryVerificationContext {
  delivery: Delivery;
  worktreePath: string;
  deliveredHeadSha: string;
  runAtSha<T>(sha: string, fn: () => Promise<T>): Promise<T>;
}

export interface DeliveryVerificationLeaseServiceDeps {
  store: DeliveryStore;
  gitDeliveries: Pick<GitDeliveryStore, "get">;
  ownerEpoch: string;
  withPathLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T>;
  isAgentRunning(agent: string): Promise<boolean>;
  establishTailAbsence?(input: {
    deliveryId: string;
    canonicalWorktree: string;
    holder: DeliveryLeaseHolder;
  }): Promise<"proven_empty" | "root_gone_best_effort">;
  now?: () => string;
  nonce?: () => string;
  operationId?: () => string;
  eventId?: () => string;
}

export class DeliveryVerificationLeaseService {
  constructor(private readonly deps: DeliveryVerificationLeaseServiceDeps) {}

  async run<T>(
    deliveryId: string,
    caller: { kind: CallerSnapshot["kind"]; name?: string },
    execute: (context: DeliveryVerificationContext) => Promise<PreparedDeliveryVerification<T>>,
  ): Promise<T> {
    this.deps.store.assertVerificationAuthorityReady();
    const initial = await this.requireDelivery(deliveryId);
    const projection = await this.requireProjection(initial);
    const lockPath = this.realpath(projection.worktreePath);
    const setup = await this.deps.withPathLock(lockPath, async () => {
      let current = await this.requireDelivery(deliveryId);
      let linked = await this.requireProjection(current);
      try {
        this.assertProjection(current, linked, lockPath);
      } catch (error) {
        if (current.lease.state === "verifying" && current.lease.verification?.ownerEpoch !== this.deps.ownerEpoch) {
          try {
            await this.persistQuarantine(current, current.lease.verification!, `interrupted verification projection drift: ${this.message(error)}`, lockPath);
          } catch (quarantineError) {
            throw new AggregateError([error, quarantineError], "interrupted verification projection drifted and quarantine persistence is uncertain");
          }
          throw new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "interrupted verification projection drifted", { deliveryId });
        }
        throw error;
      }

      if (current.lease.state === "verifying") {
        if (current.lease.verification?.ownerEpoch === this.deps.ownerEpoch) {
          throw this.occupied(current, "system verification is already active in this Workspace epoch");
        }
        await this.recoverInterrupted(current, linked, lockPath);
        throw this.occupied(current, "interrupted system verification was restored; retry deliberately");
      }

      if (current.lease.state === "abandoned") {
        throw new DeliveryLeaseError("DELIVERY_ABANDONED", false, "Delivery is permanently abandoned", { deliveryId: current.id });
      }

      // t-c5c204 — early canonical gated spawns persisted principal on their sole
      // segment but omitted the identical attribution field on the holder. Repair
      // only that attested writer shape; never infer a principal for joins/imports.
      current = await this.repairCanonicalSpawnPrincipal(current);
      linked = await this.requireProjection(current);
      this.assertProjection(current, linked, lockPath);

      const tail = resolveOperationalSegment(current);
      if (current.lease.state !== "free" && current.lease.state !== "held") {
        throw this.occupied(current, `Delivery lease state '${current.lease.state}' cannot be repurposed for verification`);
      }
      if (current.lease.holder && (current.lease.holder.segmentId !== tail.id
        || current.lease.holder.executionAgent !== tail.executionAgent
        || current.lease.holder.principal !== tail.principal)) {
        throw this.occupied(current, "current lease holder does not exactly match the tail segment");
      }
      if (current.lease.state === "held" && (!current.lease.holder?.process || !current.lease.holder.executionNonce)) {
        throw new DeliveryLeaseError("DELIVERY_PROCESS_IDENTITY_MISSING", false,
          "held verification tail lacks exact process identity or execution nonce", { deliveryId: current.id });
      }
      const controlledHeldStop = current.lease.state === "held" && !!this.deps.establishTailAbsence;
      if (!controlledHeldStop && await this.deps.isAgentRunning(tail.executionAgent)) {
        throw this.occupied(current, `tail execution '${tail.executionAgent}' is still live`, {
          next: { action: "kill_agent", name: tail.executionAgent, then: "retry verify_task with the same delivery_id" },
        });
      }
      const inspected = await this.inspect(lockPath);
      const deliveredHeadSha = await this.revParse(lockPath, current.contract.taskRef);
      if (!inspected.clean || inspected.branch !== current.contract.taskRef || inspected.head !== deliveredHeadSha) {
        throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "canonical worktree must be clean on its immutable taskRef at the delivered HEAD", {
          deliveryId, clean: inspected.clean, branch: inspected.branch, head: inspected.head, deliveredHeadSha,
        });
      }
      linked = await this.requireProjection(current);
      this.assertProjection(current, linked, lockPath);

      const priorLease = structuredClone(current.lease) as DeliveryLease;
      const intent: DeliveryVerificationIntent = {
        nonce: this.deps.nonce?.() ?? randomBytes(16).toString("hex"),
        ownerEpoch: this.deps.ownerEpoch,
        actor: this.actor(caller),
        subjectSegmentId: tail.id,
        deliveredHeadSha,
        startedAt: this.now(),
        operationId: this.deps.operationId?.() ?? `verify-${randomBytes(12).toString("hex")}`,
        priorLease: priorLease as DeliveryVerificationIntent["priorLease"],
      };
      try {
        current = await this.deps.store.update(current.id, current.version, (record) => {
          if (record.lease.state !== priorLease.state) throw this.occupied(record, "Delivery changed before verification CAS");
          record.lease = {
            state: "verifying",
            ...(priorLease.holder ? { holder: structuredClone(priorLease.holder) } : {}),
            ...(priorLease.expectedHeadSha ? { expectedHeadSha: priorLease.expectedHeadSha } : {}),
            changedAt: this.now(),
            verification: structuredClone(intent),
          };
          record.events.push({ id: this.eventId(), at: this.now(), type: "verification_started", by: this.actor(caller),
            detail: { operationId: intent.operationId, subjectSegmentId: tail.id, deliveredHeadSha } });
          return record;
        });
      } catch (error) {
        if (error instanceof DeliveryVersionConflictError) throw this.occupied(current, "another contender won the verification CAS");
        if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
        throw error;
      }

      return {
        current,
        linked,
        tail: structuredClone(tail),
        intent,
        deliveredHeadSha,
        holderToRelease: controlledHeldStop ? structuredClone(priorLease.holder!) : undefined,
      };
    });

    let { current, linked, intent } = setup;
    const { tail, deliveredHeadSha, holderToRelease } = setup;

    if (holderToRelease) {
      try {
        await this.deps.establishTailAbsence!({
          deliveryId,
          canonicalWorktree: lockPath,
          holder: structuredClone(holderToRelease),
        });
      } catch (error) {
        const refusal = new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "verification could not stop the exact tail safely", {
          deliveryId,
          error: this.message(error),
        });
        try {
          await this.deps.withPathLock(lockPath, async () => {
            await this.persistQuarantine(current, intent, `verification could not stop the exact tail: ${this.message(error)}`, lockPath);
          });
        } catch (quarantineError) {
          throw new AggregateError([error, quarantineError], "verification tail stop failed and quarantine persistence is uncertain");
        }
        throw refusal;
      }

      try {
        await this.deps.withPathLock(lockPath, async () => {
          current = await this.requireDelivery(deliveryId);
          linked = await this.requireProjection(current);
          this.assertProjection(current, linked, lockPath);
          this.assertIntent(current, intent);
          if (!isDeepStrictEqual(current.lease.holder, holderToRelease)) {
            throw this.occupied(current, "verification holder changed after exact tail stop");
          }
          const first = await this.inspect(lockPath);
          const second = await this.inspect(lockPath);
          if (!first.clean || !second.clean || first.branch !== current.contract.taskRef || second.branch !== current.contract.taskRef
            || first.head !== deliveredHeadSha || second.head !== deliveredHeadSha) {
            throw new DeliveryLeaseError("DELIVERY_INVALID_STATE", false, "canonical worktree changed while the verification tail stopped", {
              deliveryId,
              first,
              second,
              deliveredHeadSha,
            });
          }
          const releasedAt = this.now();
          const releasedPriorLease: DeliveryVerificationIntent["priorLease"] = { state: "free", changedAt: releasedAt };
          const releasedIntent: DeliveryVerificationIntent = { ...structuredClone(intent), priorLease: releasedPriorLease };
          current = await this.deps.store.update(current.id, current.version, (record) => {
            this.assertIntent(record, intent);
            if (!isDeepStrictEqual(record.lease.holder, holderToRelease)) {
              throw this.occupied(record, "verification holder changed before tail release");
            }
            const openTail = record.segments.at(-1);
            if (!openTail || openTail.id !== tail.id || openTail.releasedAt) {
              throw this.occupied(record, "verification tail changed before release");
            }
            openTail.releasedAt = releasedAt;
            openTail.releasedHeadSha = deliveredHeadSha;
            openTail.outcome = "completed";
            record.lease = {
              state: "verifying",
              changedAt: releasedAt,
              verification: structuredClone(releasedIntent),
            };
            record.events.push({
              id: this.eventId(),
              at: releasedAt,
              type: "verification_tail_released",
              by: { kind: "system" },
              detail: {
                operationId: intent.operationId,
                subjectSegmentId: tail.id,
                deliveredHeadSha,
                evidence: "exact_root_gone",
              },
            });
            return record;
          });
          intent = releasedIntent;
        });
      } catch (error) {
        const refusal = new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "verification tail release could not be persisted safely", {
          deliveryId,
          error: this.message(error),
        });
        try {
          await this.deps.withPathLock(lockPath, async () => {
            const latest = await this.requireDelivery(deliveryId);
            const persistedIntent = latest.lease.state === "verifying" && latest.lease.verification?.nonce === intent.nonce
              ? latest.lease.verification
              : intent;
            await this.persistQuarantine(latest, persistedIntent, `verification tail release could not be persisted: ${this.message(error)}`, lockPath);
          });
        } catch (quarantineError) {
          throw new AggregateError([error, quarantineError], "verification tail release failed and quarantine persistence is uncertain");
        }
        throw refusal;
      }
    }

    return this.deps.withPathLock(lockPath, async () => {
      current = await this.requireDelivery(deliveryId);
      linked = await this.requireProjection(current);
      this.assertProjection(current, linked, lockPath);
      this.assertIntent(current, intent);
      const ready = await this.inspect(lockPath);
      if (!ready.clean || ready.branch !== current.contract.taskRef || ready.head !== deliveredHeadSha) {
        const refusal = new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "canonical worktree changed before verification execution", {
          deliveryId,
          ready,
          deliveredHeadSha,
        });
        try {
          await this.persistQuarantine(current, intent, "canonical worktree changed before verification execution", lockPath);
        } catch (quarantineError) {
          throw new AggregateError([refusal, quarantineError], "verification precondition failed and quarantine persistence is uncertain");
        }
        throw refusal;
      }

      const runAtSha = async <R>(sha: string, fn: () => Promise<R>): Promise<R> => {
        intent.temporaryCheckoutSha = sha;
        current = await this.persistTemporaryCheckout(current, intent, sha);
        await this.git(lockPath, ["checkout", "--detach", "--force", sha]);
        return fn();
      };

      let prepared: PreparedDeliveryVerification<T>;
      try {
        prepared = await execute({ delivery: structuredClone(current), worktreePath: lockPath, deliveredHeadSha, runAtSha });
        await this.restoreDelivered(current, linked, lockPath, intent);
      } catch (error) {
        await this.interruptOrAggregate(current, linked, lockPath, intent, error);
        throw error;
      }

      let published: { result: T; evidence: DeliveryVerificationEvidence };
      try {
        published = await prepared.publish();
      } catch (error) {
        await this.interruptOrAggregate(current, linked, lockPath, intent, error);
        throw error;
      }

      try {
        await this.deps.store.update(current.id, current.version, (record) => {
          this.assertIntent(record, intent);
          record.lease = { ...structuredClone(intent.priorLease), changedAt: this.now() };
          record.events.push({ id: this.eventId(), at: this.now(), type: "verification_completed", by: this.actor(caller),
            detail: { refSha: published.evidence.refSha, treeSha: published.evidence.treeSha,
              verdict: published.evidence.verdict, integrityHash: published.evidence.integrityHash,
              recordPath: published.evidence.recordPath } });
          return record;
        });
      } catch (error) {
        try {
          await this.persistQuarantine(current, intent, "verification record was published but lease completion could not be persisted", lockPath);
        } catch (quarantineError) {
          throw new AggregateError([error, quarantineError], "verification completion and quarantine persistence both failed after record publication");
        }
        throw new AggregateError([error], "verification completion persistence failed after record publication");
      }
      return published.result;
    });
  }

  private async persistTemporaryCheckout(current: Delivery, intent: DeliveryVerificationIntent, sha: string): Promise<Delivery> {
    return this.deps.store.update(current.id, current.version, (record) => {
      this.assertIntent(record, intent);
      record.lease.verification = { ...record.lease.verification!, temporaryCheckoutSha: sha };
      return record;
    });
  }

  private async recoverInterrupted(current: Delivery, projection: GitDelivery, worktreePath: string): Promise<void> {
    const intent = current.lease.verification!;
    try {
      await this.restoreDelivered(current, projection, worktreePath, intent);
      await this.deps.store.update(current.id, current.version, (record) => {
        this.assertIntent(record, intent);
        record.lease = { ...structuredClone(intent.priorLease), changedAt: this.now() };
        record.events.push({ id: this.eventId(), at: this.now(), type: "verification_interrupted", by: { kind: "system" },
          detail: { retryable: true, priorOwnerEpoch: intent.ownerEpoch, operationId: intent.operationId } });
        return record;
      });
    } catch (error) {
      try {
        await this.persistQuarantine(current, intent, `interrupted verification recovery failed: ${this.message(error)}`, worktreePath);
      } catch (quarantineError) {
        throw new AggregateError([error, quarantineError], "interrupted verification recovery failed and quarantine persistence is uncertain");
      }
      throw new DeliveryLeaseError("DELIVERY_QUARANTINED", false, "interrupted verification could not be restored safely", { deliveryId: current.id });
    }
  }

  private async interruptOrAggregate(current: Delivery, projection: GitDelivery, worktreePath: string, intent: DeliveryVerificationIntent, original: unknown): Promise<void> {
    try {
      await this.restoreDelivered(current, projection, worktreePath, intent);
      await this.deps.store.update(current.id, current.version, (record) => {
        this.assertIntent(record, intent);
        record.lease = { ...structuredClone(intent.priorLease), changedAt: this.now() };
        record.events.push({ id: this.eventId(), at: this.now(), type: "verification_interrupted", by: intent.actor,
          detail: { retryable: true, operationId: intent.operationId, error: this.message(original) } });
        return record;
      });
    } catch (restoreError) {
      try {
        await this.persistQuarantine(current, intent, `verification restore failed: ${this.message(restoreError)}`, worktreePath);
      } catch (quarantineError) {
        throw new AggregateError([original, restoreError, quarantineError], "verification failed, restoration failed, and quarantine persistence is uncertain");
      }
      throw new AggregateError([original, restoreError], "verification failed and safe restoration did not complete");
    }
  }

  private async restoreDelivered(current: Delivery, projection: GitDelivery, worktreePath: string, intent: DeliveryVerificationIntent): Promise<void> {
    const latestDelivery = await this.requireDelivery(current.id);
    const latestProjection = await this.requireProjection(latestDelivery);
    this.assertProjection(latestDelivery, latestProjection, worktreePath);
    if (latestProjection.id !== projection.id) throw new Error("linked GitDelivery changed during verification");
    const observed = await this.inspect(worktreePath);
    if (!observed.clean || (observed.head !== intent.deliveredHeadSha && observed.head !== intent.temporaryCheckoutSha)) {
      throw new Error(`worktree is not a clean recorded verification checkout (head ${observed.head})`);
    }
    const branchHead = await this.revParse(worktreePath, latestDelivery.contract.taskRef);
    if (branchHead !== intent.deliveredHeadSha) throw new Error("immutable taskRef moved during verification");
    await this.git(worktreePath, ["reset", "--hard"]);
    await this.git(worktreePath, ["clean", "-fd"]);
    await this.git(worktreePath, ["checkout", "--force", latestDelivery.contract.taskRef]);
    const restored = await this.inspect(worktreePath);
    if (!restored.clean || restored.head !== intent.deliveredHeadSha || restored.branch !== latestDelivery.contract.taskRef) {
      throw new Error("delivered branch restoration could not be proved");
    }
  }

  private async persistQuarantine(current: Delivery, intent: DeliveryVerificationIntent, reason: string, worktreePath: string): Promise<void> {
    const latest = await this.requireDelivery(current.id);
    const observed = await this.inspect(worktreePath).catch(() => undefined);
    await this.deps.store.update(latest.id, latest.version, (record) => {
      this.assertIntent(record, intent);
      record.lease = {
        state: "quarantined",
        ...(record.lease.holder ? { holder: structuredClone(record.lease.holder) } : {}),
        ...(record.lease.expectedHeadSha ? { expectedHeadSha: record.lease.expectedHeadSha } : {}),
        changedAt: this.now(),
        reason,
      };
      record.events.push({ id: this.eventId(), at: this.now(), type: "verification_quarantined", by: { kind: "system" },
        detail: { reason, worktreePath, observedHead: observed?.head, clean: observed?.clean,
          operationId: intent.operationId, subjectSegmentId: intent.subjectSegmentId,
          deliveredHeadSha: intent.deliveredHeadSha, temporaryCheckoutSha: intent.temporaryCheckoutSha,
          ownerEpoch: intent.ownerEpoch, verificationActor: structuredClone(intent.actor),
          startedAt: intent.startedAt, priorLeaseState: intent.priorLease.state } });
      return record;
    });
  }

  private assertIntent(delivery: Delivery, intent: DeliveryVerificationIntent): void {
    const actual = delivery.lease.verification;
    if (delivery.lease.state !== "verifying" || !actual || actual.nonce !== intent.nonce
      || actual.ownerEpoch !== intent.ownerEpoch || actual.subjectSegmentId !== intent.subjectSegmentId
      || actual.deliveredHeadSha !== intent.deliveredHeadSha
      || !isDeepStrictEqual(actual.priorLease, intent.priorLease)) {
      throw this.occupied(delivery, "verification intent changed before mutation");
    }
  }

  private async requireDelivery(id: string): Promise<Delivery> {
    const delivery = await this.deps.store.get(id);
    if (!delivery) throw new Error(`Delivery '${id}' was not found`);
    return delivery;
  }

  private async requireProjection(delivery: Delivery): Promise<GitDelivery> {
    if (!delivery.gitDeliveryId) throw new Error(`Delivery '${delivery.id}' has no linked GitDelivery`);
    const projection = await this.deps.gitDeliveries.get(delivery.gitDeliveryId);
    if (!projection) throw new Error(`linked GitDelivery '${delivery.gitDeliveryId}' was not found`);
    return projection;
  }

  private async repairCanonicalSpawnPrincipal(delivery: Delivery): Promise<Delivery> {
    const principal = this.canonicalSpawnPrincipalOmission(delivery);
    if (!principal) return delivery;
    try {
      return await this.deps.store.update(delivery.id, delivery.version, (record) => {
        const currentPrincipal = this.canonicalSpawnPrincipalOmission(record);
        if (currentPrincipal !== principal || !record.lease.holder) {
          throw this.occupied(record, "Delivery changed before canonical spawn identity repair");
        }
        record.lease.holder = { ...record.lease.holder, principal };
        record.events.push({
          id: this.eventId(),
          at: this.now(),
          type: "canonical_spawn_principal_repaired",
          by: { kind: "system" },
          detail: { principal, reason: "canonical gated spawn omitted holder principal" },
        });
        return record;
      });
    } catch (error) {
      if (error instanceof DeliveryVersionConflictError) {
        const latest = await this.requireDelivery(delivery.id);
        if (!this.canonicalSpawnPrincipalOmission(latest)) return latest;
        throw this.occupied(latest, "Delivery changed before canonical spawn identity repair");
      }
      if (error instanceof DeliveryStoreBusyError) throw this.busy(error);
      throw error;
    }
  }

  private canonicalSpawnPrincipalOmission(delivery: Delivery): string | undefined {
    if (!delivery.id.startsWith("d-spawn-") || delivery.lease.state !== "held" || delivery.segments.length !== 1) return undefined;
    const holder = delivery.lease.holder;
    const tail = delivery.segments[0];
    if (!holder || holder.principal !== undefined || !tail || tail.releasedAt || tail.role !== "implementer"
      || !tail.principal || tail.principal !== tail.executionAgent || holder.segmentId !== tail.id
      || holder.executionAgent !== tail.executionAgent) return undefined;
    const attested = delivery.events.some((event) => {
      const payload = event.detail?.payload;
      return event.type === "projection.intent" && !!payload && typeof payload === "object"
        && event.detail?.action === "open" && event.detail?.gitDeliveryId === delivery.gitDeliveryId
        && (payload as Record<string, unknown>).reason === "canonical gated spawn";
    });
    return attested ? tail.principal : undefined;
  }

  private assertProjection(delivery: Delivery, projection: GitDelivery, worktreePath: string): void {
    if (projection.id !== delivery.gitDeliveryId || projection.deliveryId !== delivery.id
      || projection.workspaceId !== delivery.workspaceId || projection.branchRef !== delivery.contract.taskRef
      || this.realpath(projection.worktreePath) !== worktreePath) {
      throw new Error(`GitDelivery projection drift for Delivery '${delivery.id}'`);
    }
  }

  private async inspect(cwd: string): Promise<{ clean: boolean; head: string; branch: string | null }> {
    const status = await this.git(cwd, ["status", "--porcelain"]);
    const head = await this.revParse(cwd, "HEAD");
    const branch = (await this.git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])).trim() || null;
    return { clean: !status.trim(), head, branch };
  }

  private async revParse(cwd: string, ref: string): Promise<string> { return (await this.git(cwd, ["rev-parse", ref])).trim(); }
  private async git(cwd: string, args: string[], ok = [0]): Promise<string> {
    try {
      const { stdout } = await execFileP("git", ["-c", `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, ...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const e = error as Error & { code?: number; stderr?: string; stdout?: string };
      if (typeof e.code === "number" && ok.includes(e.code)) return e.stdout ?? "";
      throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
    }
  }

  private realpath(value: string): string { return fs.realpathSync(path.resolve(value)); }
  private actor(caller: { kind: CallerSnapshot["kind"]; name?: string }): DeliveryActor { return { kind: caller.kind, ...(caller.name ? { name: caller.name } : {}) }; }
  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private eventId(): string { return this.deps.eventId?.() ?? `event-${randomBytes(8).toString("hex")}`; }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  /**
   * t-cc6495 — every refusal names the way forward, from the declared per-state disposition rather
   * than a list inlined here. The inlined version covered `held` and `quarantined` only, while the
   * guard above refuses EVERY state that is not `free`/`held`: a caller blocked by a `pending` or
   * `draining` lease got a dead end, and the next move out of a dead end is raw git (t-0cbcbd).
   * A transitional state now says so, which is a different answer from saying nothing.
   */
  private occupied(delivery: Delivery, message: string, detail: Record<string, unknown> = {}): DeliveryLeaseError {
    const disposition = LEASE_DISPOSITION[delivery.lease.state];
    const next = disposition.kind === "action"
      ? { next: { action: disposition.action, deliveryId: delivery.id } }
      : disposition.kind === "transitional"
        ? { next: { retry: true, why: disposition.why } }
        : {};
    return new DeliveryLeaseError("WORKTREE_OCCUPIED", true, message, {
      deliveryId: delivery.id, version: delivery.version, state: delivery.lease.state,
      ...next,
      ...detail,
    });
  }

  private busy(error: DeliveryStoreBusyError): DeliveryLeaseError {
    return new DeliveryLeaseError("WORKTREE_OCCUPIED", true, "Delivery mutation is contended by another process", { storeCode: error.code });
  }
}
