/**
 * SDD 368 T14 — pure, read-only reload reconstruction of Delivery lease occupancy.
 *
 * Inputs are canonical Deliveries, exact linked GitDelivery projection records, parsed
 * session ledger rows, and exact live process observations. Output is an in-memory
 * snapshot only; it never mutates Delivery or GitDelivery. Later T15 consumes the
 * snapshot for projection cleanup safety.
 *
 * The snapshot also exposes an unavailable-agent deny set consumed by generic
 * spawn/resume/restart/autostart/planResume/readiness — including marker-less
 * cross-store crash rows (Delivery+projection durable, bindDelivery not yet written).
 */

import fs from "node:fs";
import path from "node:path";
import type { Delivery, DeliveryProcessIdentity } from "./types.js";
import {
  hasDeliveryMarker,
  isInvalidDeliveryMarker,
  isValidDeliveryBinding,
  type SessionRecord,
} from "../resume/SessionLedger.js";

export type ReloadLeaseClass = "held" | "quarantined" | "unavailable" | "terminal";

export interface ReloadDeliveryClassification {
  deliveryId: string;
  class: ReloadLeaseClass;
  reason: string;
  /** Agent name of the exact reconstructed holder when class is held. */
  holderAgent?: string;
}

/**
 * One exact linked GitDelivery projection row. Callers must pass every linked
 * record — never a last-wins path map that collapses duplicates.
 */
export interface LinkedGitProjection {
  gitDeliveryId: string;
  deliveryId: string;
  worktreePath: string;
}

export interface ReloadReconciliationSnapshot {
  classifications: ReloadDeliveryClassification[];
  byId: ReadonlyMap<string, ReloadDeliveryClassification>;
  /**
   * Agents that must be refused by every generic lifecycle entry point
   * (spawn/resume/restart/autostart/planResume/resumeReadiness). Includes
   * marker-less holders of unavailable Deliveries (crash window) and orphan
   * bindings to missing Deliveries. Explicit deliveryJoin remains allowed.
   */
  unavailableAgents: ReadonlySet<string>;
}

/**
 * Live process observation for one agent.
 * - exact: readable Linux identity that can match a durable holder
 * - gone: process definitively absent (ENOENT)
 * - unknown: unsupported/unreadable/malformed — never treated as gone
 */
export type ObservedProcess =
  | { state: "exact"; pid: number; processStart: string; bootId: string }
  | { state: "gone" }
  | { state: "unknown"; reason: string };

export interface ReloadReconcileInput {
  deliveries: readonly Delivery[];
  /**
   * Rows that the authority store could identify but could not authenticate.
   * Only the durable id is admitted here: callers must never deserialize or
   * infer holder authority from an untrusted payload.
   */
  untrustedDeliveries?: readonly { id: string }[];
  /** Exact linked GitDelivery records (duplicates preserved; no last-wins). */
  linkedProjections: readonly LinkedGitProjection[];
  /** agent name → session ledger row */
  sessions: ReadonlyMap<string, SessionRecord>;
  /** agent name → observed process (from pane pid + /proc) */
  processByAgent: ReadonlyMap<string, ObservedProcess>;
}

/**
 * Read Linux process identity for `pid`.
 * Parses `/proc/<pid>/stat` after the final `)` so spaces/parentheses in `comm` are safe,
 * and pairs it with `/proc/sys/kernel/random/boot_id`.
 * Unsupported/unreadable/malformed → unknown (never invents gone).
 */
export function readLinuxProcessIdentity(pid: number): ObservedProcess {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", reason: "invalid pid" };
  }
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "gone" };
    return { state: "unknown", reason: code ? `stat ${code}` : "stat unreadable" };
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return { state: "unknown", reason: "malformed stat (no closing paren)" };
  const after = stat.slice(close + 2).trimStart().split(/\s+/);
  // After comm: field 3=state … field 22=starttime → 0-based index 19.
  const processStart = after[19];
  if (!processStart || !/^\d+$/.test(processStart)) {
    return { state: "unknown", reason: "malformed process start time" };
  }
  let bootId: string;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "unknown", reason: code ? `boot_id ${code}` : "boot_id unreadable" };
  }
  if (!bootId) return { state: "unknown", reason: "boot_id empty" };
  return { state: "exact", pid, processStart, bootId };
}

/**
 * Canonical realpath of an existing path. Never falls back to path.resolve —
 * a missing/unreadable path is unavailable for exact-held reconstruction.
 */
function existingCanonicalPath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function pathsEqualExisting(a: string, b: string): boolean {
  const ca = existingCanonicalPath(a);
  const cb = existingCanonicalPath(b);
  if (ca === undefined || cb === undefined) return false;
  return ca === cb;
}

function processMatches(holder: DeliveryProcessIdentity, observed: ObservedProcess): boolean {
  if (observed.state !== "exact") return false;
  return observed.pid === holder.pid
    && observed.processStart === holder.processStart
    && observed.bootId === holder.bootId;
}

function validHolderProcess(process: DeliveryProcessIdentity | undefined): process is DeliveryProcessIdentity {
  return !!process
    && Number.isInteger(process.pid) && process.pid > 0
    && typeof process.processStart === "string" && process.processStart.length > 0
    && typeof process.bootId === "string" && process.bootId.length > 0;
}

/**
 * Both persisted worktree path AND spawn cwd must realpath to the same existing
 * linked canonical worktree. path.resolve fallback is forbidden — deleted or
 * never-created projections cannot reconstruct as exact-held.
 */
function sessionPathsExact(rec: SessionRecord, linkedWorktree: string): boolean {
  if (!rec.cwd || !rec.worktree?.path) return false;
  const linked = existingCanonicalPath(linkedWorktree);
  if (linked === undefined) return false;
  return pathsEqualExisting(rec.cwd, linked) && pathsEqualExisting(rec.worktree.path, linked);
}

function projectionsForDelivery(
  deliveryId: string,
  linkedProjections: readonly LinkedGitProjection[],
): LinkedGitProjection[] {
  return linkedProjections.filter((p) => p.deliveryId === deliveryId);
}

/**
 * Resolve the unique linked worktree for a Delivery, fail-closed on duplicates/conflicts.
 * When delivery.gitDeliveryId is set, the matching projection must be that exact record.
 */
function resolveUniqueLinkedWorktree(
  delivery: Delivery,
  linkedProjections: readonly LinkedGitProjection[],
): { ok: true; worktreePath: string; gitDeliveryId: string } | { ok: false; reason: string } {
  const matches = projectionsForDelivery(delivery.id, linkedProjections);
  if (matches.length === 0) {
    return { ok: false, reason: "missing linked GitDelivery worktree" };
  }
  if (matches.length > 1) {
    // Distinct ids or conflicting paths → unavailable; never last-wins by iteration order.
    const ids = new Set(matches.map((m) => m.gitDeliveryId));
    const pathKeys = new Set(
      matches.map((m) => existingCanonicalPath(m.worktreePath) ?? path.resolve(m.worktreePath)),
    );
    if (ids.size > 1 || pathKeys.size > 1) {
      return { ok: false, reason: "duplicate or conflicting linked GitDelivery projections" };
    }
    // Identical duplicate rows still fail closed (non-unique occupancy evidence).
    return { ok: false, reason: "duplicate linked GitDelivery projections" };
  }
  const only = matches[0]!;
  if (delivery.gitDeliveryId && delivery.gitDeliveryId !== only.gitDeliveryId) {
    return { ok: false, reason: "delivery.gitDeliveryId does not match linked projection" };
  }
  // Exact-held requires a uniquely existing realpathed canonical worktree.
  const realWorktree = existingCanonicalPath(only.worktreePath);
  if (realWorktree === undefined) {
    return { ok: false, reason: "linked GitDelivery worktree does not exist or is not realpathable" };
  }
  return { ok: true, worktreePath: realWorktree, gitDeliveryId: only.gitDeliveryId };
}

/** Every valid session binding that names this Delivery (any agent name). */
function bindingsForDelivery(
  deliveryId: string,
  sessions: ReadonlyMap<string, SessionRecord>,
): Array<{ agent: string; rec: SessionRecord }> {
  const out: Array<{ agent: string; rec: SessionRecord }> = [];
  for (const [agent, rec] of sessions) {
    if (!isValidDeliveryBinding(rec.delivery)) continue;
    if (rec.delivery.deliveryId !== deliveryId) continue;
    out.push({ agent, rec });
  }
  return out;
}

function classifyHeld(
  delivery: Delivery,
  linkedProjections: readonly LinkedGitProjection[],
  sessions: ReadonlyMap<string, SessionRecord>,
  processByAgent: ReadonlyMap<string, ObservedProcess>,
): ReloadDeliveryClassification {
  const holder = delivery.lease.holder;
  const tail = delivery.segments.at(-1);
  const expectedHead = delivery.lease.expectedHeadSha;

  if (!holder || !tail || tail.releasedAt || tail.id !== holder.segmentId) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "holder/open-tail mismatch" };
  }
  if (!expectedHead || expectedHead.length === 0) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "missing expected HEAD" };
  }
  // Mirror leaseService heldBoundaryFailure: open-tail grant HEAD must equal expected HEAD.
  if (tail.grantedHeadSha !== expectedHead) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "tail grantedHeadSha does not equal lease.expectedHeadSha" };
  }
  if (tail.executionAgent !== holder.executionAgent) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "tail executionAgent mismatch" };
  }
  // Principal equality only — never infer occupant authority from principal alone.
  if (tail.principal !== holder.principal) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "holder/tail principal mismatch" };
  }
  if (!holder.executionNonce || holder.executionNonce.length === 0) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "missing holder executionNonce" };
  }
  if (holder.reservationNonce !== undefined) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "holder still reserved (not confirmed)" };
  }
  if (!validHolderProcess(holder.process)) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "missing holder process identity" };
  }

  const linked = resolveUniqueLinkedWorktree(delivery, linkedProjections);
  if (!linked.ok) {
    return { deliveryId: delivery.id, class: "unavailable", reason: linked.reason };
  }

  // Gather EVERY binding to this Delivery — never search only the holder-named row.
  const allBindings = bindingsForDelivery(delivery.id, sessions);
  if (allBindings.length === 0) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "no exact session binding" };
  }
  if (allBindings.length > 1) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "duplicate session bindings" };
  }

  const { agent, rec } = allBindings[0]!;
  // The unique binding must name the exact holder execution + segment + nonce.
  if (agent !== holder.executionAgent) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "session binding agent is not the holder executionAgent" };
  }
  if (!isValidDeliveryBinding(rec.delivery)
    || rec.delivery.segmentId !== holder.segmentId
    || !rec.delivery.executionNonce
    || rec.delivery.executionNonce !== holder.executionNonce) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "session binding does not match holder segment/nonce" };
  }

  if (!sessionPathsExact(rec, linked.worktreePath)) {
    return {
      deliveryId: delivery.id,
      class: "unavailable",
      reason: "session cwd and worktree path must both resolve to the linked projection",
    };
  }

  const observed = processByAgent.get(agent);
  if (!observed) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "missing process observation" };
  }
  if (observed.state === "gone") {
    return { deliveryId: delivery.id, class: "unavailable", reason: "holder process gone" };
  }
  if (observed.state === "unknown") {
    return { deliveryId: delivery.id, class: "unavailable", reason: `process observation unknown: ${observed.reason}` };
  }
  if (!processMatches(holder.process, observed)) {
    return { deliveryId: delivery.id, class: "unavailable", reason: "process identity mismatch (pid reuse or stale)" };
  }

  return {
    deliveryId: delivery.id,
    class: "held",
    reason: "exact holder reconstructed",
    holderAgent: agent,
  };
}

/**
 * Free/abandoned without a stale binding are terminal (non-occupied).
 * A stale or orphan binding to them makes the Delivery unavailable.
 */
function classifyTerminalOrStale(
  delivery: Delivery,
  sessions: ReadonlyMap<string, SessionRecord>,
): ReloadDeliveryClassification {
  const stale = bindingsForDelivery(delivery.id, sessions);
  if (stale.length === 0) {
    return {
      deliveryId: delivery.id,
      class: "terminal",
      reason: `lease state '${delivery.lease.state}' with no stale binding is non-occupied`,
    };
  }
  return {
    deliveryId: delivery.id,
    class: "unavailable",
    reason: `stale binding(s) to ${delivery.lease.state} Delivery`,
  };
}

/**
 * Classify every Delivery for post-reload occupancy. Pure: no store writes.
 * Snapshot must be recomputed from one bounded set of inputs (caller supplies them).
 */
export function reconcileDeliveryReload(input: ReloadReconcileInput): ReloadReconciliationSnapshot {
  const classifications: ReloadDeliveryClassification[] = [];
  const byId = new Map<string, ReloadDeliveryClassification>();
  const unavailableAgents = new Set<string>();
  const knownDeliveryIds = new Set(input.deliveries.map((d) => d.id));

  for (const untrusted of input.untrustedDeliveries ?? []) {
    if (knownDeliveryIds.has(untrusted.id)) {
      throw new Error(`reload reconciliation received trusted and untrusted rows for Delivery '${untrusted.id}'`);
    }
    knownDeliveryIds.add(untrusted.id);
    const result: ReloadDeliveryClassification = {
      deliveryId: untrusted.id,
      class: "unavailable",
      reason: "canonical Delivery authority could not be validated",
    };
    classifications.push(result);
    byId.set(untrusted.id, result);
    for (const { agent } of bindingsForDelivery(untrusted.id, input.sessions)) {
      unavailableAgents.add(agent);
    }
  }

  for (const delivery of input.deliveries) {
    let result: ReloadDeliveryClassification;
    switch (delivery.lease.state) {
      case "quarantined":
        // Quarantine never downgrades regardless of missing runtime metadata.
        result = { deliveryId: delivery.id, class: "quarantined", reason: "quarantined remains quarantined" };
        break;
      case "pending":
      case "draining":
      case "verifying":
        result = {
          deliveryId: delivery.id,
          class: "unavailable",
          reason: `${delivery.lease.state} after reload until owning recovery path resolves`,
        };
        break;
      case "held":
        result = classifyHeld(
          delivery,
          input.linkedProjections,
          input.sessions,
          input.processByAgent,
        );
        break;
      case "free":
      case "abandoned":
        result = classifyTerminalOrStale(delivery, input.sessions);
        break;
      default:
        result = {
          deliveryId: delivery.id,
          class: "unavailable",
          reason: `lease state '${(delivery.lease as { state: string }).state}' is not a reconstructible holder`,
        };
        break;
    }
    classifications.push(result);
    byId.set(delivery.id, result);

    // Deny-set membership for this Delivery.
    if (result.class === "held" && result.holderAgent) {
      // Exact held holders remain Delivery-owned (also marker-bound); include for completeness.
      unavailableAgents.add(result.holderAgent);
    } else if (result.class === "unavailable" || result.class === "quarantined") {
      // Marker-less crash window: still deny the canonical holder executionAgent.
      const holderAgent = delivery.lease.holder?.executionAgent;
      if (holderAgent) unavailableAgents.add(holderAgent);
      // Every session binding naming this Delivery is also denied.
      for (const { agent } of bindingsForDelivery(delivery.id, input.sessions)) {
        unavailableAgents.add(agent);
      }
    } else if (result.class === "terminal") {
      // No occupancy — do not deny anyone from free/abandoned without stale binding.
    }
  }

  // Orphan / invalid markers: sessions that name a missing Delivery or carry an invalid sentinel.
  for (const [agent, rec] of input.sessions) {
    if (!hasDeliveryMarker(rec)) continue;
    if (isInvalidDeliveryMarker(rec.delivery)) {
      unavailableAgents.add(agent);
      continue;
    }
    if (isValidDeliveryBinding(rec.delivery) && !knownDeliveryIds.has(rec.delivery.deliveryId)) {
      unavailableAgents.add(agent);
    }
  }

  return { classifications, byId, unavailableAgents };
}
