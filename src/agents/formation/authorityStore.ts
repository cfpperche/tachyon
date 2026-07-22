import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  evolutionActivationHeadV2Schema,
  formationDigest,
  formationGenerationHeadV1Schema,
  formationSessionSelectorV1Schema,
  formationSkillInventoryDigest,
  formationSnapshotManifestV1Schema,
  memoryActivationHeadV1Schema,
  profileActivationHeadV2Schema,
  validateFormationAuthorityVector,
  type FormationAuthorityVector,
  type FormationObject,
  type FormationNativeSuppressionEvidenceV1,
  type FormationSessionSelectorV1,
  type FormationSnapshotManifestV1,
} from "./domain.js";
import { FormationObjectStore } from "./objectStore.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;
type DatabaseConstructor = new (location: string, options?: { timeout?: number }) => DatabaseSync;
type SqlRow = Record<string, string | number | null>;

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS formation_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO formation_metadata(key, value) VALUES ('schema_version', '1');
  CREATE TABLE IF NOT EXISTS formation_generations (
    agent_id TEXT PRIMARY KEY,
    generation_digest TEXT NOT NULL,
    vector_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_publication_leases (
    operation_id TEXT PRIMARY KEY,
    intent_fingerprint TEXT NOT NULL,
    caller_principal TEXT NOT NULL,
    caller_kind TEXT NOT NULL CHECK (caller_kind IN ('human', 'system', 'agent')),
    owner_token TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    manifest_digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing', 'ready')),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_abandoned_operations (
    operation_id TEXT PRIMARY KEY,
    intent_fingerprint TEXT NOT NULL,
    abandoned_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_mutation_barriers (
    agent_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    mutation TEXT NOT NULL,
    caller_principal TEXT NOT NULL,
    caller_kind TEXT NOT NULL CHECK (caller_kind IN ('human', 'system', 'agent')),
    workspace_id TEXT NOT NULL,
    expected_generation_digest TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('prepared', 'source-published', 'authority-committed')),
    intent_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_mutation_receipts (
    operation_id TEXT PRIMARY KEY,
    mutation TEXT NOT NULL,
    caller_principal TEXT NOT NULL,
    caller_kind TEXT NOT NULL CHECK (caller_kind IN ('human', 'system', 'agent')),
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    prior_generation_digest TEXT NOT NULL,
    next_generation_digest TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'rolled-back')),
    completed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_snapshot_manifests (
    snapshot_id TEXT PRIMARY KEY,
    manifest_digest TEXT NOT NULL UNIQUE,
    manifest_json TEXT NOT NULL,
    committed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_session_selectors (
    session_id TEXT PRIMARY KEY,
    selector_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS formation_operation_receipts (
    operation_id TEXT PRIMARY KEY,
    operation_kind TEXT NOT NULL,
    intent_fingerprint TEXT NOT NULL,
    selector_json TEXT NOT NULL,
    committed_at TEXT NOT NULL
  ) STRICT;
`;

export class FormationAuthorityStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormationAuthorityStoreError";
  }
}

export interface FormationCaller {
  principal: string;
  kind: "human" | "system" | "agent";
}

export interface FormationLaunchAuthorizationInput {
  operation: "fresh" | "fork";
  caller: FormationCaller;
  workspaceId: string;
  agentId: string;
  agentName: string;
  runtimeTrustClass: string;
  parentSessionId?: string;
}

export type FormationVectorMutation = "bootstrap" | "profile-edit" | "evolution-promotion" | "memory-promotion" | "retire";

export interface FormationSkillPayload {
  path: string;
  bytes: Buffer | string;
  executable?: boolean;
}

export interface ResolvedFormationPayload {
  sourceVectorSha256: string;
  rendererContractsSha256: string;
  startupPrompt: Buffer | string;
  reanchorReminder: Buffer | string;
  evolutionLearnings?: Buffer | string;
  evolutionSkills?: readonly FormationSkillPayload[];
  selectedMemory?: readonly FormationSkillPayload[];
  nativeSuppression?: FormationNativeSuppressionEvidenceV1;
}

export interface FormationAuthorityStoreOptions {
  now?: () => string;
  uuid?: () => string;
  leaseTtlMs?: number;
  authorizeLaunch: (input: FormationLaunchAuthorizationInput) => boolean;
  authorizeMutation: (input: {
    operation: FormationVectorMutation;
    caller: FormationCaller;
    workspaceId: string;
    agentId: string;
  }) => boolean;
  authorizeSelectorRevocation: (input: {
    caller: FormationCaller;
    sessionId: string;
    rootSessionId: string;
    ownerPrincipal: string;
    workspaceId: string;
    agentId: string;
  }) => boolean;
  authorizeSelectorRead: (input: {
    access: "metadata" | "payload";
    caller: FormationCaller;
    sessionId: string;
    rootSessionId: string;
    ownerPrincipal: string;
    ownerKind: FormationCaller["kind"];
    workspaceId: string;
    agentId: string;
    runtimeTrustClass: string;
  }) => boolean;
  resolvePayload: (input: {
    operationId: string;
    vector: FormationAuthorityVector;
    workspaceId: string;
    agentId: string;
    agentName: string;
    runtimeTrustClass: string;
  }) => ResolvedFormationPayload;
  /** Rechecks host-keyed native-lane suppression at the publication boundary. */
  verifyNativeSuppression?: (input: {
    evidence: FormationNativeSuppressionEvidenceV1;
    vector: FormationAuthorityVector;
    operationId: string;
    runtimeTrustClass: string;
    /** Host timestamp that becomes the selector/manifest publication timestamp in this transaction. */
    verifiedAt: string;
  }) => boolean;
}

export interface PrepareFormationSnapshotInput {
  operationId: string;
  caller: FormationCaller;
  workspaceId: string;
  agentId: string;
  agentName: string;
  runtimeTrustClass: string;
  expectedGenerationSha256: string;
}

export interface FormationMutationBarrier {
  operationId: string;
  mutation: FormationVectorMutation;
  caller: FormationCaller;
  workspaceId: string;
  agentId: string;
  expectedGenerationSha256: string;
  phase: "prepared" | "source-published" | "authority-committed";
  intent: unknown;
  createdAt: string;
}

export interface FormationMutationReceipt {
  operationId: string;
  mutation: FormationVectorMutation;
  workspaceId: string;
  agentId: string;
  priorGenerationSha256: string;
  nextGenerationSha256?: string;
  outcome: "committed" | "rolled-back";
  completedAt: string;
}

interface StoredPayload {
  startupPrompt: string;
  reanchorReminder: string;
  evolutionLearnings?: string;
  evolutionSkills: Array<{ path: string; bytes: string; executable: boolean }>;
  selectedMemory?: Array<{ path: string; bytes: string }>;
}

function loadDatabase(): DatabaseConstructor {
  const require = createRequire(path.join(process.cwd(), "tachyon-formation-authority-loader.cjs"));
  const sqlite = require("node:sqlite") as { DatabaseSync?: DatabaseConstructor };
  if (typeof sqlite.DatabaseSync !== "function") throw new FormationAuthorityStoreError("node:sqlite DatabaseSync is unavailable");
  return sqlite.DatabaseSync;
}

function asBuffer(bytes: Buffer | string): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
}

function validPublicId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(value);
}

function assertOperationId(value: string): void {
  if (!validPublicId(value)) throw new FormationAuthorityStoreError("formation operation id is invalid");
}

function parseIso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new FormationAuthorityStoreError("formation clock returned an invalid instant");
  return parsed;
}

function ensurePrivateAuthorityRoot(hostRoot: string): void {
  const resolved = path.resolve(hostRoot);
  const existed = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(resolved) !== resolved) {
    throw new FormationAuthorityStoreError("formation authority root must be a real private directory");
  }
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new FormationAuthorityStoreError("formation authority root has unsafe ownership or permissions");
  }
  if (!existed) {
    const parent = fs.openSync(path.dirname(resolved), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { fs.fsyncSync(parent); }
    finally { fs.closeSync(parent); }
  }
}

function parseVector(raw: string): FormationAuthorityVector {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new FormationAuthorityStoreError("formation authority vector is corrupt"); }
  if (!value || typeof value !== "object") throw new FormationAuthorityStoreError("formation authority vector is invalid");
  const record = value as Record<string, unknown>;
  const profile = profileActivationHeadV2Schema.safeParse(record.profile);
  const generation = formationGenerationHeadV1Schema.safeParse(record.generation);
  const evolution = record.evolution === undefined ? undefined : evolutionActivationHeadV2Schema.safeParse(record.evolution);
  const memory = record.memory === undefined ? undefined : memoryActivationHeadV1Schema.safeParse(record.memory);
  if (!profile.success || !generation.success || (evolution && !evolution.success) || (memory && !memory.success)) {
    throw new FormationAuthorityStoreError("formation authority vector has an invalid schema");
  }
  const parsed: FormationAuthorityVector = {
    profile: profile.data,
    generation: generation.data,
    ...(evolution?.success ? { evolution: evolution.data } : {}),
    ...(memory?.success ? { memory: memory.data } : {}),
  };
  const errors = validateFormationAuthorityVector(parsed);
  if (errors.length > 0) throw new FormationAuthorityStoreError(`formation authority vector is incompatible: ${errors.join("; ")}`);
  return parsed;
}

function parseManifest(raw: string): FormationSnapshotManifestV1 {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new FormationAuthorityStoreError("formation snapshot manifest is corrupt"); }
  const parsed = formationSnapshotManifestV1Schema.safeParse(value);
  if (!parsed.success) throw new FormationAuthorityStoreError("formation snapshot manifest has an invalid schema");
  return parsed.data;
}

function parseManifestWithDigest(raw: string, expectedDigest: string): FormationSnapshotManifestV1 {
  const manifest = parseManifest(raw);
  if (formationDigest(manifest) !== expectedDigest) throw new FormationAuthorityStoreError("formation snapshot manifest failed integrity");
  return manifest;
}

function parseSelector(raw: string): FormationSessionSelectorV1 {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw new FormationAuthorityStoreError("formation session selector is corrupt"); }
  const parsed = formationSessionSelectorV1Schema.safeParse(value);
  if (!parsed.success) throw new FormationAuthorityStoreError("formation session selector has an invalid schema");
  return parsed.data;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return formationDigest(left) === formationDigest(right);
}

function exactRevisionAdvance(current: { revision: number }, next: { revision: number; priorRevision: number }): boolean {
  return next.revision === current.revision + 1 && next.priorRevision === current.revision;
}

function initialHead(head: { revision: number; priorRevision: number }): boolean {
  return head.revision === 1 && head.priorRevision === 0;
}

function validateVectorTransition(
  current: FormationAuthorityVector | undefined,
  next: FormationAuthorityVector,
  mutation: FormationVectorMutation,
): string[] {
  if (!current) {
    return mutation === "bootstrap"
      && next.generation.generation === 1 && next.generation.priorGeneration === 0 && !next.generation.retired
      && initialHead(next.profile) && (!next.evolution || initialHead(next.evolution)) && (!next.memory || initialHead(next.memory))
      ? [] : ["initial formation vector requires an active bootstrap generation 1"];
  }
  const errors: string[] = [];
  if (mutation === "bootstrap") errors.push("formation bootstrap cannot replace an existing vector");
  if (next.generation.generation !== current.generation.generation + 1
    || next.generation.priorGeneration !== current.generation.generation) errors.push("formation generation must advance current generation by exactly one");
  if (next.profile.workspaceId !== current.profile.workspaceId || next.profile.agentId !== current.profile.agentId
    || next.profile.agentName !== current.profile.agentName) errors.push("formation vector transition cannot change workspace or agent identity");
  if (current.generation.retired) errors.push("retired formation authority cannot be mutated");

  if (mutation === "profile-edit") {
    if (!exactRevisionAdvance(current.profile, next.profile)) errors.push("profile edit must advance the active profile revision by exactly one");
    for (const lane of ["evolution", "memory"] as const) {
      const currentHead = current[lane];
      const nextHead = next[lane];
      const nextLaneEnabled = next.profile.lanes[lane].mode === "profile";
      if (currentHead && nextLaneEnabled && !sameValue(currentHead, nextHead)) errors.push(`profile edit cannot replace active ${lane} authority`);
      if (!currentHead && nextHead && !initialHead(nextHead)) errors.push(`profile edit can enable ${lane} only at revision 1`);
      if (currentHead && !nextLaneEnabled && nextHead) errors.push(`disabled ${lane} lane must remove its authority head`);
    }
  }
  if (mutation === "evolution-promotion") {
    if (!sameValue(next.profile, current.profile) || !sameValue(next.memory, current.memory)) {
      errors.push("Evolution promotion may change only Evolution authority and formation generation");
    }
    if (!next.evolution || !(current.evolution ? exactRevisionAdvance(current.evolution, next.evolution) : initialHead(next.evolution))) {
      errors.push("Evolution promotion must initialize revision 1 or advance the active revision by exactly one");
    }
    if (next.profile.lanes.evolution.mode !== "profile") errors.push("Evolution promotion requires an enabled Evolution lane");
  }
  if (mutation === "memory-promotion") {
    if (!sameValue(next.profile, current.profile) || !sameValue(next.evolution, current.evolution)) {
      errors.push("memory promotion may change only memory authority and formation generation");
    }
    if (!next.memory || !(current.memory ? exactRevisionAdvance(current.memory, next.memory) : initialHead(next.memory))) {
      errors.push("memory promotion must initialize revision 1 or advance the active revision by exactly one");
    }
    if (next.profile.lanes.memory.mode !== "profile") errors.push("memory promotion requires an enabled memory lane");
    if (current.memory && next.memory && next.memory.activationId !== current.memory.activationId) {
      errors.push("memory promotion cannot replace the active activation identity");
    }
  }
  if (mutation === "retire") {
    if (!next.generation.retired || current.generation.retired) errors.push("retire requires one active-to-retired transition");
    if (!sameValue(next.profile, current.profile) || !sameValue(next.evolution, current.evolution) || !sameValue(next.memory, current.memory)) {
      errors.push("retire cannot mutate formation lane authority");
    }
  } else if (next.generation.retired) errors.push("only the retire operation may retire a formation generation");
  return errors;
}

function prepareFingerprint(input: PrepareFormationSnapshotInput): string {
  return formationDigest({
    kind: "fresh",
    caller: input.caller,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentName: input.agentName,
    runtimeTrustClass: input.runtimeTrustClass,
    expectedGenerationSha256: input.expectedGenerationSha256,
  });
}

export class FormationAuthorityStore {
  readonly databasePath: string;
  readonly objectStore: FormationObjectStore;
  private readonly Database: DatabaseConstructor;
  private readonly now: () => string;
  private readonly uuid: () => string;
  private readonly leaseTtlMs: number;

  constructor(readonly hostRoot: string, private readonly options: FormationAuthorityStoreOptions) {
    if (!path.isAbsolute(hostRoot)) throw new FormationAuthorityStoreError("formation authority root must be absolute");
    ensurePrivateAuthorityRoot(hostRoot);
    this.databasePath = path.join(hostRoot, "formation-authority.sqlite3");
    this.objectStore = new FormationObjectStore(path.join(hostRoot, "formation-objects"));
    this.Database = loadDatabase();
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) throw new FormationAuthorityStoreError("formation lease TTL must be a positive integer");
    this.withDatabase(() => undefined);
  }

  currentVector(agentId: string): FormationAuthorityVector | undefined {
    return this.withDatabase((db) => this.readCurrentVector(db, agentId));
  }

  replaceVector(input: {
    operationId: string;
    caller: FormationCaller;
    mutation: FormationVectorMutation;
    vector: FormationAuthorityVector;
    expectedGenerationSha256?: string;
  }): FormationAuthorityVector {
    assertOperationId(input.operationId);
    const errors = validateFormationAuthorityVector(input.vector);
    if (errors.length > 0) throw new FormationAuthorityStoreError(errors.join("; "));
    const fingerprint = formationDigest({ kind: "replace-vector", caller: input.caller, mutation: input.mutation, vector: input.vector, expected: input.expectedGenerationSha256 ?? null });
    return this.writeTransaction((db) => {
      const receipt = this.readReceipt(db, input.operationId, "replace-vector", fingerprint);
      if (receipt) return parseVector(receipt);
      if (!this.options.authorizeMutation({
        operation: input.mutation,
        caller: input.caller,
        workspaceId: input.vector.profile.workspaceId,
        agentId: input.vector.profile.agentId,
      })) throw new FormationAuthorityStoreError("formation authority mutation is not authorized for this caller");
      const currentRow = db.prepare("SELECT generation_digest, vector_json FROM formation_generations WHERE agent_id = ?")
        .get(input.vector.generation.agentId) as SqlRow | undefined;
      const barrierRow = db.prepare("SELECT * FROM formation_mutation_barriers WHERE agent_id = ?")
        .get(input.vector.generation.agentId) as SqlRow | undefined;
      if (barrierRow) {
        const barrier = this.parseMutationBarrier(barrierRow);
        const intent = barrier.intent as { nextVector?: unknown } | undefined;
        if (barrier.operationId !== input.operationId || !sameValue(barrier.caller, input.caller)
          || barrier.mutation !== input.mutation || barrier.agentId !== input.vector.profile.agentId
          || barrier.workspaceId !== input.vector.profile.workspaceId
          || barrier.expectedGenerationSha256 !== input.expectedGenerationSha256
          || !intent?.nextVector || !sameValue(intent.nextVector, input.vector)) {
          throw new FormationAuthorityStoreError("formation authority mutation does not match its prepared barrier intent");
        }
      }
      if (input.expectedGenerationSha256 === undefined ? currentRow !== undefined : currentRow?.generation_digest !== input.expectedGenerationSha256) {
        throw new FormationAuthorityStoreError("formation generation CAS mismatch");
      }
      const current = currentRow ? parseVector(String(currentRow.vector_json)) : undefined;
      const transitionErrors = validateVectorTransition(current, input.vector, input.mutation);
      if (transitionErrors.length > 0) throw new FormationAuthorityStoreError(transitionErrors.join("; "));
      const nextDigest = formationDigest(input.vector.generation);
      db.prepare(`INSERT INTO formation_generations(agent_id, generation_digest, vector_json) VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET generation_digest = excluded.generation_digest, vector_json = excluded.vector_json`)
        .run(input.vector.generation.agentId, nextDigest, JSON.stringify(input.vector));
      this.writeReceipt(db, input.operationId, "replace-vector", fingerprint, JSON.stringify(input.vector));
      return structuredClone(input.vector);
    });
  }

  prepareSnapshot(input: PrepareFormationSnapshotInput): FormationSnapshotManifestV1 {
    return this.prepareResolvedSnapshot(input);
  }

  /**
   * Async lane resolvers run outside this synchronous SQLite store, then hand their exact payload
   * back here. The store still re-reads and CAS-checks the complete vector before publication.
   */
  prepareResolvedSnapshot(
    input: PrepareFormationSnapshotInput,
    preResolved?: ResolvedFormationPayload,
  ): FormationSnapshotManifestV1 {
    assertOperationId(input.operationId);
    const intentFingerprint = prepareFingerprint(input);
    const replay = this.withDatabase((db) => {
      this.assertNotAbandoned(db, input.operationId, intentFingerprint);
      return this.readCommittedManifest(db, input.operationId, intentFingerprint);
    });
    if (replay) return replay;

    const vector = this.currentVector(input.agentId);
    this.assertFreshRequest(input, vector);
    const resolved = preResolved ?? this.options.resolvePayload({
      operationId: input.operationId,
      vector: structuredClone(vector!),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      runtimeTrustClass: input.runtimeTrustClass,
    });
    const { manifest, payload } = this.buildManifest(input, vector!, resolved);
    const ownerToken = this.uuid();
    const selected = this.writeTransaction((db) => {
      const committed = this.readCommittedManifest(db, input.operationId, intentFingerprint);
      if (committed) return { manifest: committed, payload: undefined, ownerToken: undefined };
      this.assertNotAbandoned(db, input.operationId, intentFingerprint);
      const now = this.now();
      const nowMs = parseIso(now);
      const existing = db.prepare("SELECT * FROM formation_publication_leases WHERE operation_id = ?").get(input.operationId) as SqlRow | undefined;
      if (existing) {
        if (existing.intent_fingerprint !== intentFingerprint) throw new FormationAuthorityStoreError("formation operation id was reused for another snapshot");
        if (existing.state === "ready") return {
          manifest: parseManifestWithDigest(String(existing.manifest_json), String(existing.manifest_digest)),
          payload: undefined,
          ownerToken: undefined,
        };
        if (Number(existing.expires_at_ms) > nowMs) throw new FormationAuthorityStoreError("formation snapshot preparation is already in progress");
        throw new FormationAuthorityStoreError("formation snapshot preparation lease expired and cannot be reused");
      }
      const current = this.readCurrentVector(db, input.agentId);
      this.assertFreshRequest(input, current, db);
      const expiresAtMs = nowMs + this.leaseTtlMs;
      db.prepare(`INSERT INTO formation_publication_leases
        (operation_id, intent_fingerprint, caller_principal, caller_kind, owner_token, expires_at_ms, manifest_digest, manifest_json, payload_json, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?)`)
        .run(input.operationId, intentFingerprint, input.caller.principal, input.caller.kind, ownerToken, expiresAtMs,
          formationDigest(manifest), JSON.stringify(manifest), JSON.stringify(payload), now);
      return { manifest, payload, ownerToken };
    });
    if (!selected.ownerToken || !selected.payload) return selected.manifest;
    this.materializePayload(input.operationId, selected.ownerToken, selected.manifest, selected.payload);
    const becameReady = this.writeTransaction((db) => {
      const now = this.now();
      const nowMs = parseIso(now);
      const result = db.prepare(`UPDATE formation_publication_leases SET state = 'ready', expires_at_ms = ?
        WHERE operation_id = ? AND owner_token = ? AND state = 'preparing' AND expires_at_ms > ?`)
        .run(nowMs + this.leaseTtlMs, input.operationId, selected.ownerToken, nowMs);
      if (result.changes === 1) return true;
      this.abandonOwnedLease(db, input.operationId, selected.ownerToken, intentFingerprint, now);
      return false;
    });
    if (!becameReady) throw new FormationAuthorityStoreError("formation snapshot preparation lease was abandoned");
    return selected.manifest;
  }

  commitFresh(input: { operationId: string; caller: FormationCaller }): FormationSessionSelectorV1 {
    assertOperationId(input.operationId);
    const committed = this.writeTransaction((db) => {
      const lease = db.prepare("SELECT * FROM formation_publication_leases WHERE operation_id = ?").get(input.operationId) as SqlRow | undefined;
      if (!lease) {
        const abandoned = db.prepare("SELECT operation_id FROM formation_abandoned_operations WHERE operation_id = ?")
          .get(input.operationId) as SqlRow | undefined;
        if (abandoned) throw new FormationAuthorityStoreError("formation snapshot operation was terminally abandoned");
        return this.readCommittedSelectorForCaller(db, input.operationId, "fresh", input.caller);
      }
      if (lease.state !== "ready") throw new FormationAuthorityStoreError("formation snapshot preparation is incomplete");
      if (lease.caller_principal !== input.caller.principal || lease.caller_kind !== input.caller.kind) {
        throw new FormationAuthorityStoreError("formation snapshot was prepared by another caller");
      }
      const now = this.now();
      if (Number(lease.expires_at_ms) <= parseIso(now)) {
        this.abandonOwnedLease(db, input.operationId, String(lease.owner_token), String(lease.intent_fingerprint), now);
        return undefined;
      }
      const manifest = parseManifestWithDigest(String(lease.manifest_json), String(lease.manifest_digest));
      const barrier = db.prepare("SELECT operation_id FROM formation_mutation_barriers WHERE agent_id = ?")
        .get(manifest.agentId) as SqlRow | undefined;
      if (barrier) throw new FormationAuthorityStoreError("fresh formation is blocked by an active authority mutation");
      const vector = this.readCurrentVector(db, manifest.agentId);
      if (!vector || formationDigest(vector.generation) !== manifest.formationGenerationSha256
        || vector.generation.retired || vector.generation.generation !== manifest.formationGeneration) {
        throw new FormationAuthorityStoreError("formation generation changed or retired before selector commit");
      }
      if (!this.options.authorizeLaunch({
        operation: "fresh",
        caller: input.caller,
        workspaceId: manifest.workspaceId,
        agentId: manifest.agentId,
        agentName: manifest.agentName,
        runtimeTrustClass: manifest.runtimeTrustClass,
      })) throw new FormationAuthorityStoreError("fresh formation is not authorized for this caller");
      for (const object of manifest.objects) {
        const bytes = this.objectStore.read(object.sha256);
        if (bytes.length !== object.bytes) throw new FormationAuthorityStoreError("formation snapshot object length failed integrity");
      }
      const publicationAt = this.now();
      const suppressionRequired = Object.values(vector.profile.lanes).some((lane) => lane.mode === "profile");
      if (suppressionRequired !== (manifest.nativeSuppression !== undefined)) {
        throw new FormationAuthorityStoreError(suppressionRequired
          ? "profile formation requires native suppression evidence at selector commit"
          : "disabled/legacy formation cannot commit native suppression evidence");
      }
      if (manifest.nativeSuppression && !this.options.verifyNativeSuppression?.({
        evidence: manifest.nativeSuppression,
        vector: structuredClone(vector),
        operationId: input.operationId,
        runtimeTrustClass: manifest.runtimeTrustClass,
        verifiedAt: publicationAt,
      })) throw new FormationAuthorityStoreError("native formation suppression expired before selector commit");
      const sessionId = this.uuid();
      const selector = formationSessionSelectorV1Schema.parse({
        schemaVersion: 1,
        sessionId,
        rootSessionId: sessionId,
        workspaceId: manifest.workspaceId,
        agentId: manifest.agentId,
        agentName: manifest.agentName,
        ownerPrincipal: input.caller.principal,
        ownerKind: input.caller.kind,
        runtimeTrustClass: manifest.runtimeTrustClass,
        snapshotId: manifest.snapshotId,
        snapshotSha256: String(lease.manifest_digest),
        formationGeneration: manifest.formationGeneration,
        formationGenerationSha256: manifest.formationGenerationSha256,
        createdAt: publicationAt,
      });
      db.prepare("INSERT INTO formation_snapshot_manifests(snapshot_id, manifest_digest, manifest_json, committed_at) VALUES (?, ?, ?, ?)")
        .run(manifest.snapshotId, lease.manifest_digest, JSON.stringify(manifest), publicationAt);
      db.prepare("INSERT INTO formation_session_selectors(session_id, selector_json) VALUES (?, ?)")
        .run(selector.sessionId, JSON.stringify(selector));
      this.writeReceipt(db, input.operationId, "fresh", String(lease.intent_fingerprint), JSON.stringify(selector));
      db.prepare("DELETE FROM formation_publication_leases WHERE operation_id = ? AND owner_token = ?")
        .run(input.operationId, lease.owner_token);
      return selector;
    });
    if (!committed) throw new FormationAuthorityStoreError("formation snapshot operation was terminally abandoned");
    return committed;
  }

  fork(input: { operationId: string; caller: FormationCaller; parentSessionId: string }): FormationSessionSelectorV1 {
    assertOperationId(input.operationId);
    const fingerprint = formationDigest({ kind: "fork", caller: input.caller, parentSessionId: input.parentSessionId });
    return this.writeTransaction((db) => {
      const receipt = this.readReceipt(db, input.operationId, "fork", fingerprint);
      if (receipt) {
        const selector = this.requireLiveLineage(db, parseSelector(receipt).sessionId);
        return selector;
      }
      const parent = this.requireLiveLineage(db, input.parentSessionId);
      if (parent.ownerPrincipal !== input.caller.principal || parent.ownerKind !== input.caller.kind) {
        throw new FormationAuthorityStoreError("formation fork cannot transfer owner");
      }
      if (!this.options.authorizeLaunch({
        operation: "fork",
        caller: input.caller,
        workspaceId: parent.workspaceId,
        agentId: parent.agentId,
        agentName: parent.agentName,
        runtimeTrustClass: parent.runtimeTrustClass,
        parentSessionId: parent.sessionId,
      })) throw new FormationAuthorityStoreError("formation fork is not authorized for this caller");
      const selector = formationSessionSelectorV1Schema.parse({
        ...parent,
        sessionId: this.uuid(),
        rootSessionId: parent.rootSessionId,
        parentSessionId: parent.sessionId,
        createdAt: this.now(),
        revokedAt: undefined,
      });
      db.prepare("INSERT INTO formation_session_selectors(session_id, selector_json) VALUES (?, ?)")
        .run(selector.sessionId, JSON.stringify(selector));
      this.writeReceipt(db, input.operationId, "fork", fingerprint, JSON.stringify(selector));
      return selector;
    });
  }

  getSelector(sessionId: string, caller: FormationCaller): FormationSessionSelectorV1 | undefined {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT selector_json FROM formation_session_selectors WHERE session_id = ?").get(sessionId) as SqlRow | undefined;
      if (!row) return undefined;
      const selector = parseSelector(String(row.selector_json));
      this.assertSelectorReadAuthorized(selector, caller, "metadata");
      return selector;
    });
  }

  revokeSelector(input: { operationId: string; sessionId: string; caller: FormationCaller }): FormationSessionSelectorV1 {
    assertOperationId(input.operationId);
    const fingerprint = formationDigest({ kind: "revoke-selector", caller: input.caller, sessionId: input.sessionId });
    return this.writeTransaction((db) => {
      const receipt = this.readReceipt(db, input.operationId, "revoke-selector", fingerprint);
      if (receipt) return parseSelector(receipt);
      const selectors = this.readAllSelectors(db);
      const target = selectors.get(input.sessionId);
      if (!target) throw new FormationAuthorityStoreError("formation session selector is unavailable");
      if (!this.options.authorizeSelectorRevocation({
        caller: input.caller,
        sessionId: target.sessionId,
        rootSessionId: target.rootSessionId,
        ownerPrincipal: target.ownerPrincipal,
        workspaceId: target.workspaceId,
        agentId: target.agentId,
      })) throw new FormationAuthorityStoreError("formation selector revocation is not authorized for this caller");
      const revokedAt = target.revokedAt ?? this.now();
      for (const selector of selectors.values()) {
        if (selector.rootSessionId !== target.rootSessionId || selector.revokedAt || !this.isDescendantOf(selector, target.sessionId, selectors)) continue;
        const revoked = formationSessionSelectorV1Schema.parse({ ...selector, revokedAt });
        db.prepare("UPDATE formation_session_selectors SET selector_json = ? WHERE session_id = ?")
          .run(JSON.stringify(revoked), revoked.sessionId);
      }
      const revokedTarget = parseSelector(String((db.prepare("SELECT selector_json FROM formation_session_selectors WHERE session_id = ?")
        .get(target.sessionId) as SqlRow).selector_json));
      this.writeReceipt(db, input.operationId, "revoke-selector", fingerprint, JSON.stringify(revokedTarget));
      return revokedTarget;
    });
  }

  snapshotPayload(sessionId: string, caller: FormationCaller): { manifest: FormationSnapshotManifestV1; objects: Map<string, Buffer> } {
    return this.withDatabase((db) => {
      const selector = this.requireLiveLineage(db, sessionId);
      this.assertSelectorReadAuthorized(selector, caller, "payload");
      const row = db.prepare("SELECT manifest_digest, manifest_json FROM formation_snapshot_manifests WHERE snapshot_id = ?")
        .get(selector.snapshotId) as SqlRow | undefined;
      if (!row || row.manifest_digest !== selector.snapshotSha256) throw new FormationAuthorityStoreError("formation snapshot manifest is unavailable");
      const manifest = parseManifestWithDigest(String(row.manifest_json), selector.snapshotSha256);
      const objects = new Map<string, Buffer>();
      for (const object of manifest.objects) {
        const bytes = this.objectStore.read(object.sha256);
        if (bytes.length !== object.bytes) throw new FormationAuthorityStoreError("formation snapshot object length failed integrity");
        objects.set(object.sha256, bytes);
      }
      return { manifest, objects };
    });
  }

  garbageCollect(): { abandonedOperations: string[]; removedObjects: string[] } {
    const nowMs = parseIso(this.now());
    const abandonedOperations = this.writeTransaction((db) => {
      const rows = db.prepare("SELECT operation_id, intent_fingerprint FROM formation_publication_leases WHERE expires_at_ms <= ? ORDER BY operation_id")
        .all(nowMs) as SqlRow[];
      const abandonedAt = this.now();
      const insert = db.prepare(`INSERT INTO formation_abandoned_operations(operation_id, intent_fingerprint, abandoned_at)
        VALUES (?, ?, ?) ON CONFLICT(operation_id) DO NOTHING`);
      for (const row of rows) insert.run(row.operation_id, row.intent_fingerprint, abandonedAt);
      db.prepare("DELETE FROM formation_publication_leases WHERE expires_at_ms <= ?").run(nowMs);
      return rows.map((row) => String(row.operation_id));
    });
    const removedObjects = this.writeTransaction((db) => {
      const reachable = new Set<string>();
      const manifests = [
        ...(db.prepare("SELECT manifest_digest, manifest_json FROM formation_snapshot_manifests").all() as SqlRow[]),
        ...(db.prepare("SELECT manifest_digest, manifest_json FROM formation_publication_leases").all() as SqlRow[]),
      ];
      for (const row of manifests) {
        for (const object of parseManifestWithDigest(String(row.manifest_json), String(row.manifest_digest)).objects) reachable.add(object.sha256);
      }
      return this.objectStore.collectUnreferenced(reachable);
    });
    return { abandonedOperations, removedObjects };
  }

  private assertFreshRequest(input: PrepareFormationSnapshotInput, vector: FormationAuthorityVector | undefined, db?: DatabaseSync): void {
    if (!vector || formationDigest(vector.generation) !== input.expectedGenerationSha256 || vector.generation.retired) {
      throw new FormationAuthorityStoreError("formation generation changed or retired before snapshot preparation");
    }
    const blocked = db
      ? db.prepare("SELECT operation_id FROM formation_mutation_barriers WHERE agent_id = ?").get(input.agentId) as SqlRow | undefined
      : this.withDatabase((database) => database.prepare("SELECT operation_id FROM formation_mutation_barriers WHERE agent_id = ?")
        .get(input.agentId) as SqlRow | undefined);
    if (blocked) throw new FormationAuthorityStoreError("fresh formation is blocked by a prepared authority mutation");
    if (vector.generation.workspaceId !== input.workspaceId || vector.profile.agentName !== input.agentName) {
      throw new FormationAuthorityStoreError("snapshot request does not match formation authority identity");
    }
    if (!this.options.authorizeLaunch({
      operation: "fresh",
      caller: input.caller,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      runtimeTrustClass: input.runtimeTrustClass,
    })) throw new FormationAuthorityStoreError("fresh formation is not authorized for this caller");
  }

  beginMutationBarrier(input: {
    operationId: string;
    mutation: FormationVectorMutation;
    caller: FormationCaller;
    workspaceId: string;
    agentId: string;
    expectedGenerationSha256: string;
    intent: unknown;
  }): FormationMutationBarrier {
    assertOperationId(input.operationId);
    const serialized = JSON.stringify(input.intent);
    if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) throw new FormationAuthorityStoreError("formation mutation intent is too large");
    if (!this.options.authorizeMutation({ operation: input.mutation, caller: input.caller, workspaceId: input.workspaceId, agentId: input.agentId })) {
      throw new FormationAuthorityStoreError("formation authority mutation is not authorized for this caller");
    }
    return this.writeTransaction((db) => {
      const terminal = db.prepare("SELECT agent_id, caller_principal, caller_kind FROM formation_mutation_receipts WHERE operation_id = ?")
        .get(input.operationId) as SqlRow | undefined;
      if (terminal) throw new FormationAuthorityStoreError("formation mutation operation is already terminal");
      const existing = db.prepare("SELECT * FROM formation_mutation_barriers WHERE agent_id = ? OR operation_id = ?")
        .get(input.agentId, input.operationId) as SqlRow | undefined;
      if (existing) {
        const parsed = this.parseMutationBarrier(existing);
        if (parsed.operationId !== input.operationId || parsed.mutation !== input.mutation
          || !sameValue(parsed.caller, input.caller) || parsed.workspaceId !== input.workspaceId
          || parsed.agentId !== input.agentId || parsed.expectedGenerationSha256 !== input.expectedGenerationSha256
          || !sameValue(parsed.intent, input.intent)) {
          throw new FormationAuthorityStoreError("formation mutation barrier conflicts with an active operation");
        }
        return parsed;
      }
      const current = db.prepare("SELECT generation_digest FROM formation_generations WHERE agent_id = ?").get(input.agentId) as SqlRow | undefined;
      if (!current || current.generation_digest !== input.expectedGenerationSha256) throw new FormationAuthorityStoreError("formation mutation barrier generation CAS mismatch");
      const createdAt = this.now();
      for (const lease of db.prepare("SELECT * FROM formation_publication_leases").all() as SqlRow[]) {
        const manifest = parseManifestWithDigest(String(lease.manifest_json), String(lease.manifest_digest));
        if (manifest.agentId !== input.agentId) continue;
        this.abandonOwnedLease(db, String(lease.operation_id), String(lease.owner_token), String(lease.intent_fingerprint), createdAt);
      }
      db.prepare(`INSERT INTO formation_mutation_barriers
        (agent_id, operation_id, mutation, caller_principal, caller_kind, workspace_id, expected_generation_digest, phase, intent_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
        .run(input.agentId, input.operationId, input.mutation, input.caller.principal, input.caller.kind,
          input.workspaceId, input.expectedGenerationSha256, serialized, createdAt);
      return { ...input, phase: "prepared", createdAt };
    });
  }

  mutationBarrier(agentId: string, caller: FormationCaller): FormationMutationBarrier | undefined {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM formation_mutation_barriers WHERE agent_id = ?").get(agentId) as SqlRow | undefined;
      if (!row) return undefined;
      const barrier = this.parseMutationBarrier(row);
      if (!sameValue(barrier.caller, caller)) throw new FormationAuthorityStoreError("formation mutation barrier belongs to another caller");
      return barrier;
    });
  }

  mutationReceipt(operationId: string, caller: FormationCaller): FormationMutationReceipt | undefined {
    assertOperationId(operationId);
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM formation_mutation_receipts WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
      if (!row) return undefined;
      if (row.caller_principal !== caller.principal || row.caller_kind !== caller.kind) {
        throw new FormationAuthorityStoreError("formation mutation receipt belongs to another caller");
      }
      return {
        operationId: String(row.operation_id),
        mutation: String(row.mutation) as FormationVectorMutation,
        workspaceId: String(row.workspace_id),
        agentId: String(row.agent_id),
        priorGenerationSha256: String(row.prior_generation_digest),
        ...(row.next_generation_digest ? { nextGenerationSha256: String(row.next_generation_digest) } : {}),
        outcome: String(row.outcome) as FormationMutationReceipt["outcome"],
        completedAt: String(row.completed_at),
      };
    });
  }

  advanceMutationBarrier(input: {
    operationId: string;
    caller: FormationCaller;
    expectedPhase: FormationMutationBarrier["phase"];
    phase: FormationMutationBarrier["phase"];
  }): FormationMutationBarrier {
    assertOperationId(input.operationId);
    const allowed = (input.expectedPhase === "prepared" && input.phase === "source-published")
      || (input.expectedPhase === "source-published" && input.phase === "authority-committed");
    if (!allowed) throw new FormationAuthorityStoreError("formation mutation barrier phase transition is invalid");
    return this.writeTransaction((db) => {
      const row = db.prepare("SELECT * FROM formation_mutation_barriers WHERE operation_id = ?").get(input.operationId) as SqlRow | undefined;
      if (!row) throw new FormationAuthorityStoreError("formation mutation barrier is unavailable");
      const current = this.parseMutationBarrier(row);
      if (!sameValue(current.caller, input.caller)) throw new FormationAuthorityStoreError("formation mutation barrier belongs to another caller");
      const result = db.prepare("UPDATE formation_mutation_barriers SET phase = ? WHERE operation_id = ? AND phase = ?")
        .run(input.phase, input.operationId, input.expectedPhase);
      if (result.changes !== 1) throw new FormationAuthorityStoreError("formation mutation barrier phase CAS mismatch");
      return { ...current, phase: input.phase };
    });
  }

  finishMutationBarrier(input: {
    operationId: string;
    caller: FormationCaller;
    outcome: "committed" | "rolled-back";
    nextGenerationSha256?: string;
  }): void {
    assertOperationId(input.operationId);
    this.writeTransaction((db) => {
      const row = db.prepare("SELECT * FROM formation_mutation_barriers WHERE operation_id = ?").get(input.operationId) as SqlRow | undefined;
      if (!row) return;
      const current = this.parseMutationBarrier(row);
      if (!sameValue(current.caller, input.caller)) throw new FormationAuthorityStoreError("formation mutation barrier belongs to another caller");
      const authority = this.readCurrentVector(db, current.agentId);
      const authorityDigest = authority ? formationDigest(authority.generation) : undefined;
      if (input.outcome === "committed") {
        if (current.phase !== "authority-committed" || !input.nextGenerationSha256 || authorityDigest !== input.nextGenerationSha256) {
          throw new FormationAuthorityStoreError("formation mutation cannot finish before committed authority is durable");
        }
      } else if ((current.phase !== "prepared" && current.phase !== "source-published")
        || authorityDigest !== current.expectedGenerationSha256 || input.nextGenerationSha256 !== undefined) {
        throw new FormationAuthorityStoreError("formation mutation rollback cannot finish before prior authority is restored");
      }
      db.prepare(`INSERT INTO formation_mutation_receipts
        (operation_id, mutation, caller_principal, caller_kind, workspace_id, agent_id, prior_generation_digest, next_generation_digest, outcome, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(current.operationId, current.mutation, current.caller.principal, current.caller.kind, current.workspaceId,
          current.agentId, current.expectedGenerationSha256, input.nextGenerationSha256 ?? null, input.outcome, this.now());
      db.prepare("DELETE FROM formation_mutation_barriers WHERE operation_id = ?").run(input.operationId);
    });
  }

  private parseMutationBarrier(row: SqlRow): FormationMutationBarrier {
    let intent: unknown;
    try { intent = JSON.parse(String(row.intent_json)) as unknown; }
    catch { throw new FormationAuthorityStoreError("formation mutation barrier intent is corrupt"); }
    const mutation = String(row.mutation) as FormationVectorMutation;
    if (!["bootstrap", "profile-edit", "evolution-promotion", "memory-promotion", "retire"].includes(mutation)) {
      throw new FormationAuthorityStoreError("formation mutation barrier kind is corrupt");
    }
    const kind = String(row.caller_kind);
    if (kind !== "human" && kind !== "system" && kind !== "agent") throw new FormationAuthorityStoreError("formation mutation barrier caller is corrupt");
    const phase = String(row.phase);
    if (phase !== "prepared" && phase !== "source-published" && phase !== "authority-committed") {
      throw new FormationAuthorityStoreError("formation mutation barrier phase is corrupt");
    }
    return {
      operationId: String(row.operation_id),
      mutation,
      caller: { principal: String(row.caller_principal), kind },
      workspaceId: String(row.workspace_id),
      agentId: String(row.agent_id),
      expectedGenerationSha256: String(row.expected_generation_digest),
      phase,
      intent,
      createdAt: String(row.created_at),
    };
  }

  private buildManifest(input: PrepareFormationSnapshotInput, vector: FormationAuthorityVector, resolved: ResolvedFormationPayload): {
    manifest: FormationSnapshotManifestV1;
    payload: StoredPayload;
  } {
    if (resolved.sourceVectorSha256 !== formationDigest(vector)) throw new FormationAuthorityStoreError("resolved formation payload belongs to another authority vector");
    if (resolved.rendererContractsSha256 !== vector.generation.rendererContractsSha256) {
      throw new FormationAuthorityStoreError("resolved formation payload uses another renderer contract set");
    }
    const suppressionRequired = Object.values(vector.profile.lanes).some((lane) => lane.mode === "profile");
    if (suppressionRequired !== (resolved.nativeSuppression !== undefined)) {
      throw new FormationAuthorityStoreError(suppressionRequired
        ? "profile formation requires native suppression evidence"
        : "disabled/legacy formation cannot publish native suppression evidence");
    }
    if (resolved.nativeSuppression) {
      if (!this.options.verifyNativeSuppression?.({
        evidence: resolved.nativeSuppression,
        vector: structuredClone(vector),
        operationId: input.operationId,
        runtimeTrustClass: input.runtimeTrustClass,
        verifiedAt: this.now(),
      })) throw new FormationAuthorityStoreError("native formation suppression is invalid at publication");
    }
    const skills = [...(resolved.evolutionSkills ?? [])].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const selectedMemory = [...(resolved.selectedMemory ?? [])].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const startup = this.objectStore.digest(resolved.startupPrompt);
    const reanchor = this.objectStore.digest(resolved.reanchorReminder);
    const objects: FormationObject[] = [
      { kind: "startup-prompt", ...startup },
      { kind: "reanchor-reminder", ...reanchor },
      ...(resolved.evolutionLearnings === undefined ? [] : [{
        kind: "evolution-learnings" as const,
        path: "evolution/LEARNINGS.md",
        ...this.objectStore.digest(resolved.evolutionLearnings),
      }]),
      ...skills.map((skill) => ({ kind: "evolution-skill" as const, path: skill.path, ...this.objectStore.digest(skill.bytes), executable: skill.executable === true })),
      ...selectedMemory.map((entry) => ({ kind: "selected-memory" as const, path: entry.path, ...this.objectStore.digest(entry.bytes) })),
    ];
    if (vector.profile.lanes.evolution.mode !== "profile" && (skills.length > 0 || resolved.evolutionLearnings !== undefined)) {
      throw new FormationAuthorityStoreError("disabled Evolution lane cannot publish active artifacts");
    }
    if (vector.profile.lanes.evolution.mode === "profile") {
      const learningObject = objects.find((object) => object.kind === "evolution-learnings");
      if (!vector.evolution || !learningObject || learningObject.sha256 !== vector.evolution.learningsSha256
        || formationSkillInventoryDigest(objects) !== vector.evolution.skillsInventorySha256) {
        throw new FormationAuthorityStoreError("Evolution skill inventory does not match active authority");
      }
    }
    if (vector.profile.lanes.memory.mode !== "profile" && selectedMemory.length > 0) {
      throw new FormationAuthorityStoreError("disabled memory lane cannot publish selected-memory artifacts");
    }
    if (vector.profile.lanes.memory.mode === "profile") {
      const memoryObjects = objects.filter((object) => object.kind === "selected-memory")
        .map(({ path, sha256, bytes }) => ({ path: path!, sha256, bytes }));
      if (!vector.memory || formationDigest(memoryObjects) !== vector.memory.contentInventorySha256
        || formationDigest(memoryObjects) !== formationDigest(vector.memory.contentInventory)) {
        throw new FormationAuthorityStoreError("selected-memory inventory does not match active authority");
      }
    }
    const manifest = formationSnapshotManifestV1Schema.parse({
      schemaVersion: 1,
      snapshotId: this.uuid(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      runtimeTrustClass: input.runtimeTrustClass,
      formationGeneration: vector.generation.generation,
      formationGenerationSha256: input.expectedGenerationSha256,
      ...(resolved.nativeSuppression ? { nativeSuppression: structuredClone(resolved.nativeSuppression) } : {}),
      objects,
      createdAt: this.now(),
    });
    return {
      manifest,
      payload: {
        startupPrompt: asBuffer(resolved.startupPrompt).toString("base64"),
        reanchorReminder: asBuffer(resolved.reanchorReminder).toString("base64"),
        ...(resolved.evolutionLearnings === undefined ? {} : { evolutionLearnings: asBuffer(resolved.evolutionLearnings).toString("base64") }),
        evolutionSkills: skills.map((skill) => ({ path: skill.path, bytes: asBuffer(skill.bytes).toString("base64"), executable: skill.executable === true })),
        selectedMemory: selectedMemory.map((entry) => ({ path: entry.path, bytes: asBuffer(entry.bytes).toString("base64") })),
      },
    };
  }

  private materializePayload(operationId: string, ownerToken: string, manifest: FormationSnapshotManifestV1, payload: StoredPayload): void {
    const sources = [
      Buffer.from(payload.startupPrompt, "base64"),
      Buffer.from(payload.reanchorReminder, "base64"),
      ...(payload.evolutionLearnings === undefined ? [] : [Buffer.from(payload.evolutionLearnings, "base64")]),
      ...payload.evolutionSkills.map((skill) => Buffer.from(skill.bytes, "base64")),
      ...(payload.selectedMemory ?? []).map((entry) => Buffer.from(entry.bytes, "base64")),
    ];
    if (sources.length !== manifest.objects.length) throw new FormationAuthorityStoreError("formation payload inventory mismatch");
    for (const [index, bytes] of sources.entries()) {
      this.renewLease(operationId, ownerToken);
      const stored = this.objectStore.put(bytes);
      const expected = manifest.objects[index]!;
      if (stored.sha256 !== expected.sha256 || stored.bytes !== expected.bytes) throw new FormationAuthorityStoreError("formation payload digest mismatch");
    }
  }

  private renewLease(operationId: string, ownerToken: string): void {
    this.writeTransaction((db) => {
      const now = this.now();
      const nowMs = parseIso(now);
      const result = db.prepare(`UPDATE formation_publication_leases SET expires_at_ms = ?
        WHERE operation_id = ? AND owner_token = ? AND state = 'preparing' AND expires_at_ms > ?`)
        .run(nowMs + this.leaseTtlMs, operationId, ownerToken, nowMs);
      if (result.changes !== 1) throw new FormationAuthorityStoreError("formation snapshot preparation lease was abandoned");
    });
  }

  private readCurrentVector(db: DatabaseSync, agentId: string): FormationAuthorityVector | undefined {
    const row = db.prepare("SELECT generation_digest, vector_json FROM formation_generations WHERE agent_id = ?").get(agentId) as SqlRow | undefined;
    if (!row) return undefined;
    const vector = parseVector(String(row.vector_json));
    if (formationDigest(vector.generation) !== row.generation_digest) throw new FormationAuthorityStoreError("formation generation digest is corrupt");
    return vector;
  }

  private readCommittedManifest(db: DatabaseSync, operationId: string, fingerprint: string): FormationSnapshotManifestV1 | undefined {
    const receipt = db.prepare("SELECT operation_kind, intent_fingerprint, selector_json FROM formation_operation_receipts WHERE operation_id = ?")
      .get(operationId) as SqlRow | undefined;
    if (!receipt) return undefined;
    if (receipt.operation_kind !== "fresh" || receipt.intent_fingerprint !== fingerprint) {
      throw new FormationAuthorityStoreError("formation operation id was reused for another snapshot");
    }
    const selector = parseSelector(String(receipt.selector_json));
    const row = db.prepare("SELECT manifest_digest, manifest_json FROM formation_snapshot_manifests WHERE snapshot_id = ?")
      .get(selector.snapshotId) as SqlRow | undefined;
    if (!row || row.manifest_digest !== selector.snapshotSha256) throw new FormationAuthorityStoreError("committed formation snapshot is unavailable");
    return parseManifestWithDigest(String(row.manifest_json), String(row.manifest_digest));
  }

  private assertNotAbandoned(db: DatabaseSync, operationId: string, fingerprint: string): void {
    const row = db.prepare("SELECT intent_fingerprint FROM formation_abandoned_operations WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    if (!row) return;
    if (row.intent_fingerprint !== fingerprint) throw new FormationAuthorityStoreError("formation operation id was reused for another snapshot");
    throw new FormationAuthorityStoreError("formation snapshot operation was terminally abandoned");
  }

  private abandonOwnedLease(db: DatabaseSync, operationId: string, ownerToken: string, fingerprint: string, abandonedAt: string): void {
    db.prepare(`INSERT INTO formation_abandoned_operations(operation_id, intent_fingerprint, abandoned_at)
      VALUES (?, ?, ?) ON CONFLICT(operation_id) DO NOTHING`).run(operationId, fingerprint, abandonedAt);
    db.prepare("DELETE FROM formation_publication_leases WHERE operation_id = ? AND owner_token = ?")
      .run(operationId, ownerToken);
  }

  private assertSelectorReadAuthorized(selector: FormationSessionSelectorV1, caller: FormationCaller, access: "metadata" | "payload"): void {
    if (!this.options.authorizeSelectorRead({
      access,
      caller,
      sessionId: selector.sessionId,
      rootSessionId: selector.rootSessionId,
      ownerPrincipal: selector.ownerPrincipal,
      ownerKind: selector.ownerKind,
      workspaceId: selector.workspaceId,
      agentId: selector.agentId,
      runtimeTrustClass: selector.runtimeTrustClass,
    })) throw new FormationAuthorityStoreError("formation selector read is not authorized for this caller");
  }

  private readCommittedSelectorForCaller(db: DatabaseSync, operationId: string, kind: string, caller: FormationCaller): FormationSessionSelectorV1 {
    const receipt = db.prepare("SELECT operation_kind, selector_json FROM formation_operation_receipts WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
    if (!receipt || receipt.operation_kind !== kind) throw new FormationAuthorityStoreError("formation snapshot is not prepared");
    const historical = parseSelector(String(receipt.selector_json));
    if (historical.ownerPrincipal !== caller.principal || historical.ownerKind !== caller.kind) {
      throw new FormationAuthorityStoreError("formation operation id was reused by another caller");
    }
    return this.requireLiveLineage(db, historical.sessionId);
  }

  private readAllSelectors(db: DatabaseSync): Map<string, FormationSessionSelectorV1> {
    const values = new Map<string, FormationSessionSelectorV1>();
    for (const row of db.prepare("SELECT selector_json FROM formation_session_selectors").all() as SqlRow[]) {
      const selector = parseSelector(String(row.selector_json));
      values.set(selector.sessionId, selector);
    }
    return values;
  }

  private requireLiveLineage(db: DatabaseSync, sessionId: string): FormationSessionSelectorV1 {
    const selectors = this.readAllSelectors(db);
    const target = selectors.get(sessionId);
    if (!target) throw new FormationAuthorityStoreError("formation session selector is unavailable");
    const seen = new Set<string>();
    let cursor: FormationSessionSelectorV1 | undefined = target;
    let reachedRoot = false;
    while (cursor) {
      if (seen.has(cursor.sessionId)) throw new FormationAuthorityStoreError("formation selector lineage is corrupt");
      seen.add(cursor.sessionId);
      if (cursor.rootSessionId !== target.rootSessionId) throw new FormationAuthorityStoreError("formation selector lineage crosses roots");
      if (cursor.revokedAt) throw new FormationAuthorityStoreError("formation session selector lineage is revoked");
      if (cursor.sessionId === target.rootSessionId) {
        if (cursor.parentSessionId) throw new FormationAuthorityStoreError("formation selector root has a parent");
        reachedRoot = true;
        break;
      }
      cursor = cursor.parentSessionId ? selectors.get(cursor.parentSessionId) : undefined;
    }
    if (!reachedRoot) throw new FormationAuthorityStoreError("formation selector lineage is incomplete");
    return target;
  }

  private isDescendantOf(selector: FormationSessionSelectorV1, ancestorId: string, selectors: Map<string, FormationSessionSelectorV1>): boolean {
    const seen = new Set<string>();
    let cursor: FormationSessionSelectorV1 | undefined = selector;
    while (cursor) {
      if (cursor.sessionId === ancestorId) return true;
      if (seen.has(cursor.sessionId)) throw new FormationAuthorityStoreError("formation selector lineage is corrupt");
      seen.add(cursor.sessionId);
      cursor = cursor.parentSessionId ? selectors.get(cursor.parentSessionId) : undefined;
    }
    return false;
  }

  private readReceipt(db: DatabaseSync, operationId: string, kind: string, fingerprint: string): string | undefined {
    const row = db.prepare("SELECT operation_kind, intent_fingerprint, selector_json FROM formation_operation_receipts WHERE operation_id = ?")
      .get(operationId) as SqlRow | undefined;
    if (!row) return undefined;
    if (row.operation_kind !== kind || row.intent_fingerprint !== fingerprint) {
      throw new FormationAuthorityStoreError("formation operation id was reused for another intent");
    }
    return String(row.selector_json);
  }

  private writeReceipt(db: DatabaseSync, operationId: string, kind: string, fingerprint: string, result: string): void {
    db.prepare(`INSERT INTO formation_operation_receipts
      (operation_id, operation_kind, intent_fingerprint, selector_json, committed_at) VALUES (?, ?, ?, ?, ?)`)
      .run(operationId, kind, fingerprint, result, this.now());
  }

  private withDatabase<T>(fn: (db: DatabaseSync) => T): T {
    const db = new this.Database(this.databasePath, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      db.exec(SCHEMA);
      const metadata = db.prepare("SELECT value FROM formation_metadata WHERE key = 'schema_version'").get() as SqlRow;
      if (metadata.value !== "1") throw new FormationAuthorityStoreError("unsupported formation authority schema version");
      return fn(db);
    } finally {
      db.close();
    }
  }

  private writeTransaction<T>(fn: (db: DatabaseSync) => T): T {
    return this.withDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}
