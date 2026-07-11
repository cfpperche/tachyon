import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DelegationRecord } from "../bridge/delegationRecord.js";
import type { GitDelivery } from "../git-delivery/types.js";
import { DeliveryInvariantError, type DeliveryStore } from "./store.js";
import { GitDeliveryVersionConflictError } from "../git-delivery/store.js";
import type { DelegationSegment, Delivery, DeliveryCreateInput } from "./types.js";

export type LegacyImportRefusalCode =
  | "MISSING_WORKTREE"
  | "WORKTREE_UNAVAILABLE"
  | "AMBIGUOUS_GIT_PROJECTION"
  | "GIT_PROJECTION_DRIFT"
  | "NON_LINEAR_HISTORY"
  | "INVALID_FIXER_SCOPE"
  | "STALE_PREVIEW";

export interface LegacyImportRefusal {
  ok: false;
  code: LegacyImportRefusalCode;
  message: string;
  candidates?: string[];
}

export interface LegacyImportPlan {
  ok: true;
  fingerprint: string;
  intentFingerprint: string;
  delivery: DeliveryCreateInput & { id: string };
  gitProjection?: { id: string; expectedVersion: number };
}

export type LegacyImportPreview = LegacyImportPlan | LegacyImportRefusal;

export interface LegacyImportPreviewInput {
  workspaceId: string;
  sourcePath?: string;
  record: DelegationRecord;
  gitDeliveries?: readonly GitDelivery[];
}

export interface LegacyImportDependencies {
  realpath?: (value: string) => string;
  isAncestor: (older: string, newer: string) => boolean | Promise<boolean>;
  now?: () => string;
}

export interface LegacyImportGitStore {
  list(): Promise<GitDelivery[]>;
  get(id: string): Promise<GitDelivery | undefined>;
  update(id: string, version: number, mutate: (record: GitDelivery) => GitDelivery): Promise<GitDelivery>;
  reserveLegacyImport(input: {
    projectionId: string; expectedVersion: number; deliveryId: string; operationId: string; intentFingerprint: string;
    branchRef: string; worktreePath: string;
  }): Promise<{ ok: true; projection: GitDelivery } | { ok: false; code: "AMBIGUOUS_GIT_PROJECTION" | "GIT_PROJECTION_DRIFT" | "STALE_PREVIEW"; candidates?: string[] }>;
}

export interface LegacyImportApplyInput extends LegacyImportPreviewInput {
  fingerprint: string;
  operationId: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonical(value: string, realpath: (value: string) => string): string | undefined {
  try { return realpath(path.resolve(value)); } catch { return undefined; }
}

function subset(requested: readonly string[], owns: readonly string[]): boolean {
  const authority = new Set(owns.map((entry) => path.normalize(entry)));
  return requested.every((entry) => authority.has(path.normalize(entry)));
}

function matchesPlannedDelivery(existing: Delivery, planned: DeliveryCreateInput & { id: string }): boolean {
  const comparable = ({ id, workspaceId, createdBy, contract, lease, segments, events, gitDeliveryId, legacy }: DeliveryCreateInput & { id: string }) =>
    ({ id, workspaceId, createdBy, contract, lease, segments, events, gitDeliveryId, legacy });
  return stableJson(comparable(existing)) === stableJson(comparable(planned));
}

export async function previewLegacyImport(input: LegacyImportPreviewInput, deps: LegacyImportDependencies): Promise<LegacyImportPreview> {
  const { record } = input;
  if (!record.worktreePath) return { ok: false, code: "MISSING_WORKTREE", message: "legacy delegation has no durable worktree path" };
  const realpath = deps.realpath ?? fs.realpathSync.native;
  const worktree = canonical(record.worktreePath, realpath);
  if (!worktree) return { ok: false, code: "WORKTREE_UNAVAILABLE", message: `cannot canonicalize legacy worktree '${record.worktreePath}'` };

  const candidates = input.gitDeliveries ?? [];
  const exact = candidates.filter((candidate) => candidate.branchRef === record.taskRef
    && canonical(candidate.worktreePath, realpath) === worktree);
  if (exact.length !== 1) return { ok: false, code: "AMBIGUOUS_GIT_PROJECTION", message: exact.length === 0 ? "no GitDelivery record exactly matches the legacy branch/worktree" : "multiple GitDelivery records exactly match the legacy branch/worktree", candidates: exact.map((d) => d.id).sort() };
  const partial = candidates.filter((candidate) => (candidate.branchRef === record.taskRef || canonical(candidate.worktreePath, realpath) === worktree) && !exact.includes(candidate));
  if (partial.length > 0) return { ok: false, code: "GIT_PROJECTION_DRIFT", message: "GitDelivery branch/worktree projections disagree with the legacy record", candidates: partial.map((d) => d.id).sort() };
  const git = exact[0];
  const seed = { workspaceId: input.workspaceId, sourcePath: input.sourcePath, record, gitId: git.id };
  const deliveryId = `d-${hash(seed).slice(0, 24)}`;
  if (git.agent !== record.agent || git.workspaceId !== input.workspaceId || (git.deliveryId !== undefined && git.deliveryId !== deliveryId)) {
    return { ok: false, code: "GIT_PROJECTION_DRIFT", message: `GitDelivery '${git.id}' conflicts with legacy provenance`, candidates: [git.id] };
  }

  const attempts = record.fixerAttempts ?? [];
  for (const attempt of attempts) {
    if (!subset(attempt.requestedOwnsSubset, record.owns)) return { ok: false, code: "INVALID_FIXER_SCOPE", message: `fixer '${attempt.occupantAgent}' requests authority outside the original contract` };
  }
  const boundaries = [record.baseSha, ...attempts.map((attempt) => attempt.branchHeadAtGrant), ...(git?.currentHeadSha ? [git.currentHeadSha] : [])];
  const ancestry: Array<{ older: string; newer: string; observed: boolean }> = [];
  for (let i = 0; i + 1 < boundaries.length; i += 1) {
    const observed = await deps.isAncestor(boundaries[i], boundaries[i + 1]);
    ancestry.push({ older: boundaries[i], newer: boundaries[i + 1], observed });
    if (!observed) return { ok: false, code: "NON_LINEAR_HISTORY", message: `legacy boundary '${boundaries[i]}' is not an ancestor of '${boundaries[i + 1]}'` };
  }

  const actors = { kind: "system" as const };
  const agents = [record.agent, ...attempts.map((attempt) => attempt.occupantAgent)];
  const grants = [record.createdAt, ...attempts.map((attempt) => attempt.grantedAt)];
  const heads = [record.baseSha, ...attempts.map((attempt) => attempt.branchHeadAtGrant)];
  const scopes = [record.owns, ...attempts.map((attempt) => attempt.requestedOwnsSubset)];
  const segments: DelegationSegment[] = agents.map((agent, index) => {
    // A Git projection's observed head has no corresponding legacy release timestamp. Keep the
    // final segment open instead of fabricating a closure; the head remains preserved by the projection.
    const releasedHeadSha = index + 1 < heads.length ? heads[index + 1] : undefined;
    const releasedAt = index + 1 < grants.length ? grants[index + 1] : undefined;
    return {
      id: `seg-${hash({ deliveryId, index, agent, grant: grants[index] }).slice(0, 24)}`,
      index,
      role: index === 0 ? "implementer" : "fixer",
      executionAgent: agent,
      grantedBy: actors,
      ownsSubset: [...scopes[index]],
      grantedHeadSha: heads[index],
      grantedAt: grants[index],
      ...(releasedHeadSha ? { releasedHeadSha } : {}),
      ...(releasedAt ? { releasedAt } : {}),
      ...(releasedHeadSha ? { outcome: "completed" as const } : {}),
    };
  });
  const importedAt = deps.now?.() ?? record.createdAt;
  const delivery: DeliveryCreateInput & { id: string } = {
    id: deliveryId, workspaceId: input.workspaceId,
    createdBy: record.delegator ? { kind: "agent", name: record.delegator } : actors,
    contract: { ...(record.taskId ? { taskId: record.taskId } : {}), baseSha: record.baseSha, behaviorTest: record.behaviorTest, owns: [...record.owns], taskRef: record.taskRef, ...(record.stubPath ? { stubPath: record.stubPath } : {}) },
    lease: { state: "free", changedAt: importedAt }, segments,
    events: [{ id: `event-${hash({ deliveryId, type: "legacy_import" }).slice(0, 24)}`, at: importedAt, type: "legacy_import", by: actors, detail: { archived: record.archived === true } }],
    ...(git ? { gitDeliveryId: git.id } : {}),
    legacy: { ...(record.id ? { delegationId: record.id } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), importedAt },
  };
  const intent = {
    delivery,
    identity: {
      workspace: canonical(input.workspaceId, realpath) ?? path.resolve(input.workspaceId),
      worktree,
      source: input.sourcePath ? (canonical(input.sourcePath, realpath) ?? path.resolve(input.sourcePath)) : undefined,
      branchRef: record.taskRef,
      baseSha: record.baseSha,
      projectionHead: git.currentHeadSha,
    },
    ancestry,
    gitProjection: { id: git.id },
  };
  const intentFingerprint = hash(intent);
  // The preview fingerprint additionally serializes the observed projection version. The intent
  // fingerprint deliberately does not: reserving this exact intent increments that version.
  const fingerprint = hash({ intent, gitProjection: { id: git.id, expectedVersion: git.version } });
  return { ok: true, fingerprint, intentFingerprint, delivery, ...(git ? { gitProjection: { id: git.id, expectedVersion: git.version } } : {}) };
}

export async function applyLegacyImport(input: LegacyImportApplyInput, stores: { delivery: DeliveryStore; git?: LegacyImportGitStore }, deps: LegacyImportDependencies): Promise<Delivery | LegacyImportRefusal> {
  if (!stores.git) return { ok: false, code: "STALE_PREVIEW", message: "live GitDelivery inventory is unavailable" };
  const live = await stores.git.list();
  const plan = await previewLegacyImport({ ...input, gitDeliveries: live }, deps);
  if (!plan.ok) return plan;
  const alreadyCreated = await stores.delivery.get(plan.delivery.id);
  const linked = plan.gitProjection ? await stores.git.get(plan.gitProjection.id) : undefined;
  // A completed prior attempt is authoritative even though linking increments the Git projection
  // version and therefore intentionally changes the preview fingerprint.
  if (alreadyCreated && !matchesPlannedDelivery(alreadyCreated, plan.delivery)) {
    return { ok: false, code: "GIT_PROJECTION_DRIFT", message: `Delivery '${plan.delivery.id}' conflicts with the canonical legacy intent` };
  }
  if (alreadyCreated && linked?.deliveryId === alreadyCreated.id) return alreadyCreated;
  const pending = linked?.legacyImport as { operationId?: string; deliveryId?: string; intentFingerprint?: string; state?: string } | undefined;
  const resumesIdenticalReservation = pending?.state === "pending" && pending.deliveryId === plan.delivery.id
    && pending.intentFingerprint === plan.intentFingerprint;
  if (plan.fingerprint !== input.fingerprint && !resumesIdenticalReservation) return { ok: false, code: "STALE_PREVIEW", message: "legacy import inputs changed after preview" };
  let reserved: GitDelivery | undefined;
  if (plan.gitProjection) {
    const current = await stores.git.get(plan.gitProjection.id);
    if (current?.deliveryId === plan.delivery.id) {
      const replayed = await stores.delivery.get(plan.delivery.id);
      if (replayed) return replayed;
    }
    const reservation = await stores.git.reserveLegacyImport({
      projectionId: plan.gitProjection.id, expectedVersion: plan.gitProjection.expectedVersion,
      deliveryId: plan.delivery.id, operationId: input.operationId, intentFingerprint: plan.intentFingerprint,
      branchRef: input.record.taskRef, worktreePath: input.record.worktreePath!,
    });
    if (!reservation.ok) return {
      ok: false, code: reservation.code,
      message: reservation.code === "AMBIGUOUS_GIT_PROJECTION" ? "multiple live GitDelivery records exactly match the legacy branch/worktree"
        : reservation.code === "GIT_PROJECTION_DRIFT" ? "live GitDelivery branch/worktree projections disagree with the legacy record"
          : "GitDelivery changed after preview",
      ...(reservation.candidates ? { candidates: reservation.candidates } : {}),
    };
    reserved = reservation.projection;
  }
  // A prior caller may have committed create and crashed before linking. The deterministic id plus
  // full intent comparison makes that Delivery the idempotent create result for any identical retry.
  let delivery: Delivery;
  try {
    delivery = await stores.delivery.createLegacyImport({ ...plan.delivery, operationId: input.operationId });
  } catch (error) {
    if (error instanceof DeliveryInvariantError) {
      return { ok: false, code: "GIT_PROJECTION_DRIFT", message: error.message };
    }
    throw error;
  }
  if (plan.gitProjection && reserved) {
    try {
      await stores.git.update(plan.gitProjection.id, reserved.version, (record) => ({ ...record, deliveryId: delivery.id, legacyImport: { operationId: input.operationId, deliveryId: delivery.id, intentFingerprint: plan.intentFingerprint, state: "linked" } }));
    } catch (error) {
      if (!(error instanceof GitDeliveryVersionConflictError)) throw error;
      const winner = await stores.git.get(plan.gitProjection.id);
      const linkedImport = winner?.legacyImport as { deliveryId?: string; intentFingerprint?: string; state?: string } | undefined;
      if (winner?.deliveryId !== delivery.id || linkedImport?.state !== "linked" || linkedImport.deliveryId !== delivery.id
        || linkedImport.intentFingerprint !== plan.intentFingerprint) throw error;
    }
  }
  return delivery;
}

/** Explicit names used by Bridge-facing adapters; the short names remain convenient for internal callers. */
export const previewLegacyDeliveryImport = previewLegacyImport;
export const applyLegacyDeliveryImport = applyLegacyImport;
