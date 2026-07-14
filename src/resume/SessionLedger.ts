import fs from "node:fs";
import path from "node:path";
import { adapterForRuntime, type ResumeRuntime } from "./adapters.js";
import { inferKind, type EntryKind } from "../config/loadConfig.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";
import { appendCapped, replaceVerifySet, EVIDENCE_SCHEMA_VERSION, type WorktreeEvidence, type Severity } from "../worktree/evidence.js";
import type { VerifyState } from "../worktree/verify.js";
import type { SpawnContract } from "../bridge/spawnContract.js";
import type { Role } from "../roles/templates.js";
import type { SoulSnapshot } from "../agents/promptLayers.js";

/**
 * Per-workspace session ledger (spec 209 + 211): `agentName -> SessionRecord`,
 * persisted to `.tachyon/sessions.json` so an agent survives the death of its
 * process/window. Tolerant of a missing OR corrupt file — a broken ledger must
 * never block activation, so it reads as empty rather than throwing.
 *
 * Spec 211 split the record into two concerns so a non-resumable row can't be
 * mistaken for a resumable one:
 *   - `def`    — how to RESTART the agent (every ad-hoc agent, incl. non-AI `sh`);
 *                also carries lineage (`parent`). Drives rehydration after a restart.
 *   - `resume` — how to RESUME the CONVERSATION (adapter-backed runtimes only).
 * Use `isResumable(record)` — NEVER "the row exists" — to decide resume affordances.
 */

/** How to reconstruct/restart an ad-hoc agent's definition after a host restart. */
export interface SessionDef {
  cmd: string; // the ORIGINAL spawn command (no minted-id injection)
  kind: EntryKind;
  instructions?: string;
  role?: Role;
  soul?: boolean;
  taskBrief?: string;
  parent?: string; // lineage — who spawned it
  /** spec 362 — the Bridge-resolved requester of a GATED delegation (t-bae303). Gated spawns force
   *  `parent` undefined and record this instead; persisted here so it survives a reload — rehydrate
   *  used to only rebuild lineage from `parent`, orphaning a gated agent's sidebar nesting. */
  delegator?: string;
  /** env to re-apply on restart/resume (e.g. an ANTHROPIC_BASE_URL model-swap) — persisted so a
   *  rehydrated ad-hoc/forked agent keeps it after a reload (spec 225 fork inherits the source's env). */
  env?: Record<string, string>;
  /** spec 226/364 — persisted marker/config for isolated/ad-hoc harness agents, used during reload/rebind recovery. */
  harness?: unknown;
  /**
   * spec 225 — a forked sibling agent. PERSISTENT: unlike an ordinary ad-hoc agent, its ledger row +
   * in-memory def survive a Stop (so it stays listed and resumable) and are dropped only on an explicit
   * Dismiss. Durable (lives in the ledger), so the persistence holds across a window reload too.
   */
  fork?: boolean;
  /**
   * spec 230 — set when this ad-hoc agent is a NODE of a pipeline run owned by a PipelineManager. The
   * generic activation resume/offer path skips rows carrying this (the run reconciles its own nodes);
   * a TYPED field (not an untyped tag) so it survives `parseDef` across a reload (codex S4 M4).
   */
  pipeline?: { runId: string; nodeId: string };
  /** spec 246 — the structured delegation contract this child was spawned under (Bridge spawn-contract gate).
   *  Persisted as TYPED metadata (D8) so it survives a reload and is queryable for audit / the future verify
   *  increment — not just flattened into the delivered instructions. */
  contract?: SpawnContract;
  /** spec 246 (D6) — the reason given when the contract gate was bypassed (`skip_contract_reason`); persisted
   *  so the bypass is auditable after a reload, not just a transient notify. */
  contractSkipReason?: string;
}

/** How to resume the prior conversation — adapter-backed runtimes only. */
export interface SessionResume {
  runtime: ResumeRuntime;
  /** minted by us, or captured from the runtime (may be "" until first resolve). */
  sessionId: string;
  /** spec 240 — the claude config HOME the session was written under (CLAUDE_CONFIG_DIR, or `~/.claude`).
   *  Persisted so transcript lookup survives a later `isolate`/`harness` toggle or rename (config-home drift);
   *  absent on pre-240 rows → the caller derives it. */
  configHome?: string;
}

/**
 * spec 364 — durable Bridge-client binding for host-driven rebind after extension-host reload.
 * Written on every successful Tachyon spawn/resume that materializes the Bridge MCP client.
 * After reload, mark-suspect reads only these fields (never pure in-memory maps).
 */
export interface BridgeClientBinding {
  /** Generation stamped at last successful Tachyon spawn/resume of this process. Absent/pre-364 ⇒ treat as 0. */
  boundGeneration: number;
  /** True when Tachyon applied Bridge materialization on that spawn/resume. */
  wired: boolean;
}

/**
 * SDD 368 T14 — defensive reverse index from one runtime ledger row to one Delivery segment.
 * DeliveryStore remains the lease authority; this never grants occupancy by itself.
 * A valid marker has non-empty deliveryId + segmentId, and executionNonce when sequential identity exists.
 */
export interface SessionDeliveryBinding {
  deliveryId: string;
  segmentId: string;
  /** Confirmed reservation/execution nonce when sequential identity was established; may be omitted for pre-sequential gated spawn. */
  executionNonce?: string;
}

/**
 * Explicit invalid sentinel for a malformed persisted delivery marker.
 * Must survive parse so the row is never mistaken for an ordinary resumable agent.
 */
export type SessionDeliveryMarker = SessionDeliveryBinding | { readonly invalid: true };

export function isInvalidDeliveryMarker(marker: SessionDeliveryMarker | undefined): marker is { readonly invalid: true } {
  return !!marker && (marker as { invalid?: unknown }).invalid === true;
}

export function isValidDeliveryBinding(marker: SessionDeliveryMarker | undefined): marker is SessionDeliveryBinding {
  return !!marker && !isInvalidDeliveryMarker(marker)
    && typeof (marker as SessionDeliveryBinding).deliveryId === "string"
    && (marker as SessionDeliveryBinding).deliveryId.length > 0
    && typeof (marker as SessionDeliveryBinding).segmentId === "string"
    && (marker as SessionDeliveryBinding).segmentId.length > 0;
}

/** True when the row carries any Delivery marker (valid or invalid) — generic resume/restart must refuse it. */
export function hasDeliveryMarker(rec: SessionRecord | undefined): boolean {
  return rec?.delivery !== undefined;
}

export function sameDeliveryBinding(a: SessionDeliveryBinding, b: SessionDeliveryBinding): boolean {
  return a.deliveryId === b.deliveryId
    && a.segmentId === b.segmentId
    && (a.executionNonce ?? undefined) === (b.executionNonce ?? undefined);
}

export interface SessionRecord {
  /** present for every ad-hoc agent; absent for a declared agent's resume-only row. */
  def?: SessionDef;
  /** present only for adapter-backed runtimes. */
  resume?: SessionResume;
  /** spec 210 — the agent's git worktree (path/branch/ownership/baseRef); cleanup + C2 read this, never recompute from drifted config. */
  worktree?: WorktreeRecord;
  /** absolute cwd the agent ran in — resume respawns here, transcript resolves here. */
  cwd: string;
  /** declared (tachyon.yml) vs ad-hoc — declared+autostart auto-resumes, others are offered. */
  declared: boolean;
  /** spec 364 — durable Bridge-client generation stamp for rebind after host reload. */
  bridgeClient?: BridgeClientBinding;
  /**
   * SDD 368 T14 — Delivery/segment reverse binding (or explicit invalid sentinel).
   * Presence of any marker excludes generic auto-resume/offer/restart.
   */
  delivery?: SessionDeliveryMarker;
  identity?: SessionIdentity;
  updatedAt: string;
}

export interface SessionIdentity {
  soul: SoulSnapshot;
  health: "offered" | "identity-degraded";
  degradedAt?: string;
  degradedCode?: string;
}

/** A row may drive resume only when it has a runtime AND that runtime still has an adapter. */
export function isResumable(rec: SessionRecord): boolean {
  return !!rec.resume?.runtime && adapterForRuntime(rec.resume.runtime) !== undefined;
}

type LedgerFile = { sessions?: Record<string, unknown> };

export class SessionLedger {
  constructor(private readonly workspaceRoot: string) {}

  get path(): string {
    return path.join(this.workspaceRoot, ".tachyon", "sessions.json");
  }

  /** All records; empty on missing/corrupt/shape-mismatch (never throws). */
  all(): Map<string, SessionRecord> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as LedgerFile;
      const sessions = parsed?.sessions;
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return new Map();
      const out = new Map<string, SessionRecord>();
      for (const [name, r] of Object.entries(sessions)) {
        const rec = normalize(r);
        if (rec) out.set(name, rec);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  get(name: string): SessionRecord | undefined {
    return this.all().get(name);
  }

  /** Insert/replace one agent's record (timestamp stamped here). */
  record(name: string, rec: Omit<SessionRecord, "updatedAt"> & { updatedAt?: string }): void {
    const all = this.all();
    all.set(name, stripDeclaredParent({ ...rec, updatedAt: rec.updatedAt ?? new Date().toISOString() }));
    this.write(all);
  }

  remove(name: string): void {
    const all = this.all();
    if (all.delete(name)) this.write(all);
  }

  /**
   * spec 210 — drop the worktree block after the worktree is removed, keeping the row, AND
   * reset cwd off the now-deleted worktree path back to the workspace root (review fix:
   * resume() uses record.cwd directly, so a stale worktree cwd would spawn in a deleted dir).
   */
  clearWorktree(name: string): void {
    const all = this.all();
    const rec = all.get(name);
    if (rec?.worktree) {
      delete rec.worktree;
      rec.cwd = this.workspaceRoot;
      all.set(name, rec);
      this.write(all);
    }
  }

  /**
   * spec 214 — record the verify-gate result on the agent's worktree block (no-op if the agent
   * has no worktree row; verify is worktree-scoped). Keeps the rest of the record untouched.
   */
  recordVerify(name: string, verify: VerifyState): void {
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.worktree) return;
    rec.worktree = { ...rec.worktree, verify };
    all.set(name, rec);
    this.write(all);
  }

  /** spec 273 — the worktree's evidence records (empty if none / no worktree). Returns a COPY so a caller
   *  mutating the array can't bypass caps/replacement/write discipline. */
  getEvidence(name: string): WorktreeEvidence[] {
    return [...(this.get(name)?.worktree?.evidence ?? [])];
  }

  /**
   * spec 273 — append one evidence record to the agent's worktree block (no-op if no worktree;
   * evidence is worktree-scoped like verify). SYNCHRONOUS read→mutate→write, so concurrent
   * producers in the extension process are serialized by the event loop — no lost-write race
   * (the "racy array RMW" risk applies only to async/multi-process writers, which this is not).
   */
  appendEvidence(name: string, record: WorktreeEvidence): void {
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.worktree) return;
    rec.worktree = { ...rec.worktree, evidence: appendCapped(rec.worktree.evidence ?? [], record) };
    all.set(name, rec);
    this.write(all);
  }

  /**
   * spec 273 — replace the built-in verify step-result set (dedup on re-run), preserving all other
   * evidence. No-op if the agent has no worktree.
   */
  replaceVerifyEvidence(name: string, stepRecords: readonly WorktreeEvidence[]): void {
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.worktree) return;
    rec.worktree = { ...rec.worktree, evidence: replaceVerifySet(rec.worktree.evidence ?? [], stepRecords) };
    all.set(name, rec);
    this.write(all);
  }

  /**
   * SDD 368 T14 — idempotent exact-bind of a Delivery reverse marker.
   * Merges only the delivery field; preserves def/resume/worktree/cwd/declared/bridgeClient.
   * Refuses to overwrite a different or invalid binding. Requires an existing ledger row.
   */
  bindDelivery(name: string, binding: SessionDeliveryBinding): void {
    if (!isValidDeliveryBinding(binding)) {
      throw new Error(`cannot bind Delivery for '${name}': binding requires non-empty deliveryId and segmentId`);
    }
    const normalized: SessionDeliveryBinding = {
      deliveryId: binding.deliveryId,
      segmentId: binding.segmentId,
      ...(binding.executionNonce !== undefined && binding.executionNonce.length > 0
        ? { executionNonce: binding.executionNonce }
        : {}),
    };
    const all = this.all();
    const rec = all.get(name);
    if (!rec) throw new Error(`cannot bind Delivery for '${name}': no session ledger row`);
    if (rec.delivery !== undefined) {
      if (isInvalidDeliveryMarker(rec.delivery)) {
        throw new Error(`cannot bind Delivery for '${name}': existing binding is invalid and must be cleared exactly`);
      }
      if (sameDeliveryBinding(rec.delivery, normalized)) return; // idempotent exact-bind
      throw new Error(`cannot bind Delivery for '${name}': existing binding differs`);
    }
    all.set(name, stripDeclaredParent({
      ...rec,
      delivery: normalized,
      updatedAt: new Date().toISOString(),
    }));
    this.write(all);
  }

  /**
   * SDD 368 T14 — clear a Delivery reverse marker only when the caller's expected binding matches exactly.
   * There is no name-only clear.
   */
  clearDelivery(name: string, expected: SessionDeliveryBinding): void {
    if (!isValidDeliveryBinding(expected)) {
      throw new Error(`cannot clear Delivery for '${name}': expected binding requires non-empty deliveryId and segmentId`);
    }
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.delivery) return;
    if (isInvalidDeliveryMarker(rec.delivery) || !sameDeliveryBinding(rec.delivery, expected)) {
      throw new Error(`cannot clear Delivery for '${name}': expected binding does not match`);
    }
    const { delivery: _drop, ...rest } = rec;
    all.set(name, stripDeclaredParent({ ...rest, updatedAt: new Date().toISOString() }));
    this.write(all);
  }

  private write(all: Map<string, SessionRecord>): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const sessions = Object.fromEntries(all);
    fs.writeFileSync(this.path, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  }
}

/**
 * Accept the 211 shape, OR migrate a pre-211 flat record
 * (`{runtime, sessionId, cwd, cmd, declared}`) into it. Returns null on garbage.
 */
function normalize(r: unknown): SessionRecord | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (typeof o.cwd !== "string") return null;
  const declared = o.declared === true;
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : new Date(0).toISOString();

  // New (211) shape: a def and/or resume object (+ spec 210 worktree + spec 364 bridgeClient + SDD 368 T14 delivery).
  if (o.def !== undefined || o.resume !== undefined || o.worktree !== undefined || o.bridgeClient !== undefined || o.delivery !== undefined || o.identity !== undefined) {
    const def = parseDef(o.def);
    const resume = parseResume(o.resume);
    const worktree = parseWorktree(o.worktree);
    const bridgeClient = parseBridgeClient(o.bridgeClient);
    // delivery field present → always keep a marker (valid or invalid); never drop it into an ordinary row.
    const delivery = o.delivery !== undefined ? parseDeliveryMarker(o.delivery) : undefined;
    const identity = parseIdentity(o.identity);
    if (!def && !resume && !worktree && !bridgeClient && delivery === undefined && !identity) return null;
    return stripDeclaredParent({ def, resume, worktree, bridgeClient, delivery, identity, cwd: o.cwd, declared, updatedAt });
  }

  // Pre-211 flat record → migrate.
  if (typeof o.cmd === "string" && typeof o.runtime === "string") {
    return stripDeclaredParent({
      def: { cmd: o.cmd, kind: inferKind(o.cmd) },
      resume: { runtime: o.runtime as ResumeRuntime, sessionId: typeof o.sessionId === "string" ? o.sessionId : "" },
      cwd: o.cwd,
      declared,
      updatedAt,
    });
  }
  return null;
}

function stripDeclaredParent<T extends SessionRecord>(rec: T): T {
  if (!rec.declared || !rec.def?.parent) return rec;
  const { parent: _parent, ...def } = rec.def;
  return { ...rec, def } as T;
}

function parseDef(d: unknown): SessionDef | undefined {
  if (typeof d !== "object" || d === null) return undefined;
  const o = d as Record<string, unknown>;
  if (typeof o.cmd !== "string") return undefined;
  const kind: EntryKind = o.kind === "agent" || o.kind === "terminal" ? o.kind : inferKind(o.cmd);
  return {
    cmd: o.cmd,
    kind,
    ...(typeof o.instructions === "string" ? { instructions: o.instructions } : {}),
    ...(o.role === "coder" || o.role === "reviewer" || o.role === "tester" || o.role === "orchestrator" || o.role === "custom" ? { role: o.role } : {}),
    ...(o.soul === true ? { soul: true as const } : {}),
    ...(typeof o.taskBrief === "string" ? { taskBrief: o.taskBrief } : {}),
    ...(typeof o.parent === "string" ? { parent: o.parent } : {}),
    ...(typeof o.delegator === "string" ? { delegator: o.delegator } : {}),
    ...(isStringMap(o.env) ? { env: o.env as Record<string, string> } : {}),
    ...(o.fork === true ? { fork: true } : {}), // spec 225 — persistent forked sibling
    ...(isPipelineRef(o.pipeline) ? { pipeline: o.pipeline as { runId: string; nodeId: string } } : {}), // spec 230
    ...(isSpawnContract(o.contract) ? { contract: o.contract as SpawnContract } : {}), // spec 246
    ...(typeof o.contractSkipReason === "string" ? { contractSkipReason: o.contractSkipReason } : {}), // spec 246 D6
  };
}

function parseIdentity(value: unknown): SessionIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.soul !== "object" || o.soul === null || (o.health !== "offered" && o.health !== "identity-degraded")) return undefined;
  const s = o.soul as Record<string, unknown>;
  if (typeof s.profileId !== "string" || !/^[0-9a-f-]{36}$/i.test(s.profileId) ||
      typeof s.source !== "string" || !/^\.tachyon\/agents\/[a-zA-Z][a-zA-Z0-9_-]*\/SOUL\.md$/.test(s.source) ||
      typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.sha256) ||
      !Number.isInteger(s.chars) || (s.chars as number) < 1 || (s.chars as number) > 20_000 ||
      !Number.isInteger(s.bytes) || (s.bytes as number) < 1 || (s.bytes as number) > 65_536 ||
      typeof s.offeredAt !== "string" || s.state !== "offered" ||
      (s.channel !== "startup-argument" && s.channel !== "tui-prefill" && s.channel !== "reanchor-pointer")) return undefined;
  return {
    soul: { profileId: s.profileId, source: s.source, sha256: s.sha256, chars: s.chars as number, bytes: s.bytes as number,
      offeredAt: s.offeredAt, channel: s.channel, state: "offered" },
    health: o.health,
    ...(typeof o.degradedAt === "string" ? { degradedAt: o.degradedAt } : {}),
    ...(typeof o.degradedCode === "string" && /^soul\/[a-z-]+$/.test(o.degradedCode) ? { degradedCode: o.degradedCode } : {}),
  };
}

/** A persisted spawn-contract (spec 246) — the three required string slots + the deliverable/done_when pair. */
function isSpawnContract(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.task === "string" && typeof o.context === "string" && typeof o.constraints === "string";
}

/** A persisted pipeline-node owner ref `{runId, nodeId}` (spec 230). */
function isPipelineRef(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.runId === "string" && typeof o.nodeId === "string";
}

/** A plain object whose values are all strings (env map) — defensive parse of a persisted SessionDef.env. */
function isStringMap(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

function parseWorktree(w: unknown): WorktreeRecord | undefined {
  if (typeof w !== "object" || w === null) return undefined;
  const o = w as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.branch !== "string") return undefined;
  return {
    path: o.path,
    branch: o.branch,
    tachyonCreatedBranch: o.tachyonCreatedBranch === true,
    baseRef: typeof o.baseRef === "string" ? o.baseRef : "",
    ...(typeof o.baseBranch === "string" ? { baseBranch: o.baseBranch } : {}), // spec 223
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date(0).toISOString(),
    ...(parseVerify(o.verify) ? { verify: parseVerify(o.verify) } : {}),
    ...((): { evidence?: WorktreeEvidence[] } => {
      const ev = parseEvidenceArray(o.evidence);
      return ev.length > 0 ? { evidence: ev } : {};
    })(),
  };
}

const SEVERITIES: readonly Severity[] = ["info", "warn", "error"];

/** Defensive parse of a persisted evidence array — drops malformed records, never throws. */
function parseEvidenceArray(a: unknown): WorktreeEvidence[] {
  if (!Array.isArray(a)) return [];
  const out: WorktreeEvidence[] = [];
  for (const r of a) {
    const rec = parseEvidence(r);
    if (rec) out.push(rec);
  }
  return out;
}

function parseEvidence(r: unknown): WorktreeEvidence | undefined {
  if (typeof r !== "object" || r === null) return undefined;
  const o = r as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string";
  if (!str(o.id) || !str(o.targetAgent) || !str(o.producer) || !str(o.atCommit) || !str(o.producedAt)) return undefined;
  if (!str(o.kind) || !str(o.summary)) return undefined;
  if (!SEVERITIES.includes(o.severity as Severity)) return undefined;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: o.id,
    targetAgent: o.targetAgent,
    producer: o.producer,
    ...(str(o.onBehalfOf) ? { onBehalfOf: o.onBehalfOf } : {}),
    ...(str(o.sourceRunId) ? { sourceRunId: o.sourceRunId } : {}),
    atCommit: o.atCommit,
    ...(typeof o.worktreeDirtyAtProduction === "boolean" ? { worktreeDirtyAtProduction: o.worktreeDirtyAtProduction } : {}),
    producedAt: o.producedAt,
    kind: o.kind,
    severity: o.severity as Severity,
    summary: o.summary,
    ...(str(o.detail) ? { detail: o.detail } : {}),
    ...(o.data && typeof o.data === "object" && !Array.isArray(o.data) ? { data: o.data as Record<string, unknown> } : {}),
    ...(Array.isArray(o.artifacts) ? { artifacts: o.artifacts.filter(str) } : {}),
  };
}

function parseVerify(v: unknown): VerifyState | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.command !== "string" || typeof o.atCommit !== "string") return undefined;
  return {
    command: o.command,
    passed: o.passed === true,
    atCommit: o.atCommit,
    ranAt: typeof o.ranAt === "string" ? o.ranAt : new Date(0).toISOString(),
  };
}

function parseResume(r: unknown): SessionResume | undefined {
  if (typeof r !== "object" || r === null) return undefined;
  const o = r as Record<string, unknown>;
  if (typeof o.runtime !== "string") return undefined;
  return {
    runtime: o.runtime as ResumeRuntime,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : "",
    ...(typeof o.configHome === "string" ? { configHome: o.configHome } : {}), // spec 240
  };
}

/** spec 364 — defensive parse of durable Bridge-client binding; drops malformed blocks. */
function parseBridgeClient(v: unknown): BridgeClientBinding | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.boundGeneration !== "number" || !Number.isFinite(o.boundGeneration) || o.boundGeneration < 0) return undefined;
  if (typeof o.wired !== "boolean") return undefined;
  return { boundGeneration: Math.floor(o.boundGeneration), wired: o.wired };
}

/**
 * SDD 368 T14 — parse a persisted delivery marker.
 * Malformed values become the explicit invalid sentinel (never omitted when the field was present).
 */
function parseDeliveryMarker(v: unknown): SessionDeliveryMarker {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { invalid: true };
  const o = v as Record<string, unknown>;
  if (o.invalid === true) return { invalid: true };
  if (typeof o.deliveryId !== "string" || o.deliveryId.length === 0) return { invalid: true };
  if (typeof o.segmentId !== "string" || o.segmentId.length === 0) return { invalid: true };
  // Reject unknown extra authority-looking fields that could confuse equality; keep only known keys.
  if (o.executionNonce !== undefined && o.executionNonce !== null) {
    if (typeof o.executionNonce !== "string" || o.executionNonce.length === 0) return { invalid: true };
    return { deliveryId: o.deliveryId, segmentId: o.segmentId, executionNonce: o.executionNonce };
  }
  return { deliveryId: o.deliveryId, segmentId: o.segmentId };
}

/** spec 364 — missing pre-364 `boundGeneration` is treated as 0 (upgrade rebind). */
export function durableBoundGeneration(rec: SessionRecord | undefined): number {
  return rec?.bridgeClient?.boundGeneration ?? 0;
}
