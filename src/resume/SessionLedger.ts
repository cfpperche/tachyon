import fs from "node:fs";
import path from "node:path";
import { adapterForRuntime, type ResumeRuntime } from "./adapters.js";
import { inferKind, type EntryKind } from "../config/loadConfig.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";
import { appendCapped, replaceVerifySet, EVIDENCE_SCHEMA_VERSION, type WorktreeEvidence, type Severity } from "../worktree/evidence.js";
import type { VerifyState } from "../worktree/verify.js";
import type { SpawnContract } from "../bridge/spawnContract.js";

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
  parent?: string; // lineage — who spawned it
  /** env to re-apply on restart/resume (e.g. an ANTHROPIC_BASE_URL model-swap) — persisted so a
   *  rehydrated ad-hoc/forked agent keeps it after a reload (spec 225 fork inherits the source's env). */
  env?: Record<string, string>;
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
  updatedAt: string;
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
    all.set(name, { ...rec, updatedAt: rec.updatedAt ?? new Date().toISOString() });
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

  /** spec 273 — the worktree's evidence records (empty if none / no worktree). */
  getEvidence(name: string): WorktreeEvidence[] {
    return this.get(name)?.worktree?.evidence ?? [];
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

  // New (211) shape: a def and/or resume object (+ spec 210 worktree).
  if (o.def !== undefined || o.resume !== undefined || o.worktree !== undefined) {
    const def = parseDef(o.def);
    const resume = parseResume(o.resume);
    const worktree = parseWorktree(o.worktree);
    if (!def && !resume && !worktree) return null;
    return { def, resume, worktree, cwd: o.cwd, declared, updatedAt };
  }

  // Pre-211 flat record → migrate.
  if (typeof o.cmd === "string" && typeof o.runtime === "string") {
    return {
      def: { cmd: o.cmd, kind: inferKind(o.cmd) },
      resume: { runtime: o.runtime as ResumeRuntime, sessionId: typeof o.sessionId === "string" ? o.sessionId : "" },
      cwd: o.cwd,
      declared,
      updatedAt,
    };
  }
  return null;
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
    ...(typeof o.parent === "string" ? { parent: o.parent } : {}),
    ...(isStringMap(o.env) ? { env: o.env as Record<string, string> } : {}),
    ...(o.fork === true ? { fork: true } : {}), // spec 225 — persistent forked sibling
    ...(isPipelineRef(o.pipeline) ? { pipeline: o.pipeline as { runId: string; nodeId: string } } : {}), // spec 230
    ...(isSpawnContract(o.contract) ? { contract: o.contract as SpawnContract } : {}), // spec 246
    ...(typeof o.contractSkipReason === "string" ? { contractSkipReason: o.contractSkipReason } : {}), // spec 246 D6
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
