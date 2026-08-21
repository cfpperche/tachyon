import fs from "node:fs";
import type { AgentInstancePolicy } from "@tachyon/shared/resume/agentInstance.js";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type ResumeRuntime } from "@tachyon/shared/resume/adapters.js";
import type { EntryKind } from "@tachyon/shared/config/entry.js";
import type { WorktreeRecord } from "../worktree/worktreeRecord.js";
import { appendCapped, parseWorktreeEvidence, type WorktreeEvidence } from "../worktree/evidence.js";
import type { SharedDependencyState } from "../worktree/dependencySharing.js";
import { spawnContractCompletion, type SpawnContract } from "../agents/spawnContract.js";
import type { BridgeClientBinding, SessionDef, SessionLifecycle, SessionRecord, SessionResume } from "./sessionRecord.js";

/**
 * Per-workspace session ledger (spec 209 + 211): `agentName -> SessionRecord`,
 * persisted to `.tachyon/sessions.json` so an agent survives the death of its
 * process/window. Tolerant of a missing OR corrupt file — a broken ledger must
 * never block activation, so it reads as empty rather than throwing.
 *
 * The row shape and `isResumable` live in `sessionRecord.ts`. This file reads
 * and writes the JSON.
 */

/**
 * Agent-side view of persisted session rows.
 *
 * A row without `def` is a declared agent's resume-only row, so it remains in this collection. This
 * deliberately preserves the ledger consumers' existing fallback and does not settle the older
 * kindless-record contradiction at the persistence boundary.
 */
export function agentSessionRecordsOf(
  records: ReadonlyMap<string, SessionRecord>,
): Map<string, SessionRecord> {
  return new Map([...records].filter(([, record]) => record.def?.kind !== "terminal"));
}

type LedgerFile = { sessions?: Record<string, unknown>; heartbeatEpochs?: Record<string, number> };

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
    all.set(name, withoutSelfParent(name, { ...rec, updatedAt: rec.updatedAt ?? new Date().toISOString() }));
    this.write(all);
  }

  /** A dismissed name can be reused, so the fencing counter deliberately outlives its session row. */
  allocateHeartbeatEpoch(name: string): number {
    const all = this.all();
    const epochs = this.heartbeatEpochs();
    const epoch = (epochs[name] ?? 0) + 1;
    epochs[name] = epoch;
    this.write(all, epochs);
    return epoch;
  }

  /** Claim an idle delta before delivery. False means no delta or a stale incarnation. */
  advanceHeartbeatCursor(name: string, epoch: number, cursor: string): boolean {
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.def?.heartbeat || rec.def.heartbeat.epoch !== epoch || rec.def.heartbeat.cursor === cursor) return false;
    rec.def = { ...rec.def, heartbeat: { ...rec.def.heartbeat, cursor } };
    all.set(name, { ...rec, updatedAt: new Date().toISOString() });
    this.write(all);
    return true;
  }

  remove(name: string): void {
    const all = this.all();
    if (all.delete(name)) this.write(all);
  }

  /** Content-only custody token for a name-scoped row; does not disclose stored env or prompts. */
  recordDigest(name: string): string | null {
    const record = this.get(name);
    return record ? crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex") : null;
  }

  /** Remove only the exact row captured before a canonical identity retirement. */
  removeExactDigest(name: string, expectedDigest: string | null): void {
    const all = this.all();
    const record = all.get(name);
    const actual = record ? crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex") : null;
    if (actual === null) {
      if (expectedDigest !== null) return; // acknowledges the transaction's prior exact removal
      return;
    }
    if (expectedDigest === null || actual !== expectedDigest) {
      throw new Error(`session ledger row for '${name}' changed outside the retirement transaction`);
    }
    all.delete(name);
    this.write(all);
  }

  /**
   * Move one exact owner row and every persisted child reference in one ledger replacement.
   * Replay acknowledges an already-moved exact row only when no old lineage references remain.
   */
  renameExact(oldName: string, newName: string, expected: SessionRecord | null): void {
    if (oldName === newName) return;
    const all = this.all();
    const source = all.get(oldName);
    const destination = all.get(newName);
    if (expected === null) {
      if (source || destination) throw new Error(`session ledger rename '${oldName}' -> '${newName}' conflicts with an unexpected owner row`);
      return;
    }
    if (!source) {
      const staleReference = [...all.values()].some((record) => record.def?.parent === oldName || record.def?.delegator === oldName);
      if (!isDeepStrictEqual(destination, expected) || staleReference) {
        throw new Error(`session ledger rename '${oldName}' -> '${newName}' is ambiguous`);
      }
      return;
    }
    if (!isDeepStrictEqual(source, expected) || destination) {
      throw new Error(`session ledger rename '${oldName}' -> '${newName}' changed outside the transaction`);
    }
    all.delete(oldName);
    all.set(newName, source);
    for (const [name, record] of all) {
      if (record.def?.parent !== oldName && record.def?.delegator !== oldName) continue;
      all.set(name, {
        ...record,
        def: {
          ...record.def,
          ...(record.def.parent === oldName ? { parent: newName } : {}),
          ...(record.def.delegator === oldName ? { delegator: newName } : {}),
        },
      });
    }
    this.write(all);
  }

  /**
   * t-6d09e6 — drop the resume block when cmd/runtime identity changes so the next start is a
   * fresh conversation on the new CLI. Keeps def/worktree/lineage; native sessions are not migrated.
   */
  clearResume(name: string): void {
    const all = this.all();
    const rec = all.get(name);
    if (!rec?.resume) return;
    const { resume: _drop, ...rest } = rec;
    all.set(name, withoutSelfParent(name, { ...rest, updatedAt: new Date().toISOString() }));
    this.write(all);
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

  /** spec 273 — the worktree's evidence records (empty if none / no worktree). Returns a COPY so a caller
   *  mutating the array can't bypass caps/replacement/write discipline. */
  getEvidence(name: string): WorktreeEvidence[] {
    return [...(this.get(name)?.worktree?.evidence ?? [])];
  }

  /**
   * spec 273 — append one evidence record to the agent's worktree block (no-op if no worktree;
   * evidence is worktree-scoped). SYNCHRONOUS read→mutate→write, so concurrent
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


  private heartbeatEpochs(): Record<string, number> {
    try {
      const value = (JSON.parse(fs.readFileSync(this.path, "utf8")) as LedgerFile).heartbeatEpochs;
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, epoch]) => Number.isSafeInteger(epoch) && epoch > 0));
    } catch { return {}; }
  }

  private write(all: Map<string, SessionRecord>, heartbeatEpochs = this.heartbeatEpochs()): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const sessions = Object.fromEntries(all);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ sessions, heartbeatEpochs }, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, this.path);
      let dirFd: number | undefined;
      try { dirFd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dirFd); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
      } finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* already renamed */ }
    }
  }
}

/**
 * Accept the 211 shape. Returns null on garbage — and, since SDD 478 M4, on a record whose kind was
 * never written: a persisted entry's kind is read back, never re-derived from its command string.
 */
function normalize(r: unknown): SessionRecord | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (typeof o.cwd !== "string") return null;
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : new Date(0).toISOString();

  // New (211) shape: a def and/or resume object (+ spec 210 worktree + spec 364 bridgeClient).
  if (o.def !== undefined || o.resume !== undefined || o.worktree !== undefined || o.bridgeClient !== undefined || o.lifecycle !== undefined || o.processScope !== undefined) {
    const def = parseDef(o.def);
    const resume = parseResume(o.resume);
    const worktree = parseWorktree(o.worktree);
    const bridgeClient = parseBridgeClient(o.bridgeClient);
    const lifecycle = parseLifecycle(o.lifecycle);
    const instance = parseInstancePolicy(o.instance);
    const processScope = parseTemporaryAgentScope(o.processScope);
    if (!def && !resume && !worktree && !bridgeClient) return null;
    // t-04052d — a row whose `instance` did not parse is KEPT, not dropped. Dropping it would delete
    // the very evidence the activation gate refuses on, turning its ledger check into a no-op and
    // discarding a pre-cut operator's rows without telling them. It survives here and is refused
    // there; no reader can get a policy answer out of it in the meantime.
    return { def, resume, worktree, bridgeClient, lifecycle, instance, processScope, cwd: o.cwd, updatedAt };
  }

  // SDD 478 M4 — the pre-211 flat record (`{runtime, sessionId, cwd, cmd, declared}`) predates the
  // stored `kind` entirely, so migrating it required SYNTHESIZING one from the command string. That
  // is the inference this step removes, and there is no honest substitute: the fact was never
  // written. Such a record is refused rather than guessed, which drops a shape that has not been
  // written since spec 211.
  return null;
}

function parseTemporaryAgentScope(value: unknown): SessionRecord["processScope"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (o.capability === "unavailable" && typeof o.reason === "string") {
    return { capability: "unavailable", reason: o.reason };
  }
  if (
    o.capability === "available"
    && typeof o.unit === "string"
    && typeof o.invocationId === "string"
    && typeof o.bootId === "string"
  ) {
    return { capability: "available", unit: o.unit, invocationId: o.invocationId, bootId: o.bootId };
  }
  return undefined;
}

function parseLifecycle(value: unknown): SessionLifecycle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (o.state !== "clean-exited" && o.state !== "stopped") return undefined;
  if (typeof o.exitedAt !== "string" || !Number.isFinite(Date.parse(o.exitedAt))) return undefined;
  return { state: o.state, exitedAt: o.exitedAt };
}

/**
 * t-5e1113 — refuse a record that names itself as its own parent.
 *
 * This became reachable when decision 5 stopped stripping `def.parent` for declared rows. It is
 * enforced on WRITE rather than on read, because a cycle on disk outlives whatever read guard
 * happens to be in front of it — `AgentManager.parentOf` reads the ledger directly when the
 * in-memory lineage map is cold, which is exactly the post-reload path this decision exists to fix.
 */
function withoutSelfParent<T extends SessionRecord>(name: string, rec: T): T {
  if (rec.def?.parent !== name) return rec;
  const { parent: _parent, ...def } = rec.def;
  return { ...rec, def } as T;
}

/**
 * SDD 482 phase 2 — parse the declared instance policy, fail-closed. An unrecognised value is dropped
 * rather than coerced: a row that says something this build does not understand must not be read as
 * one of the two values it happens to know.
 */
function parseInstancePolicy(value: unknown): AgentInstancePolicy | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const lifetime = o.lifetime === "saved" || o.lifetime === "temporary" ? o.lifetime : undefined;
  const resumePolicy = o.resumePolicy === "restartable" || o.resumePolicy === "collected" ? o.resumePolicy : undefined;
  // A PRE-CUT row carries `identity` and no `resumePolicy`, so it yields undefined here rather than
  // being half-read. That is fail-closed, not reinterpretation: t-fab832's activation gate refuses
  // the workspace before this parser is ever reached with one.
  if (!lifetime || !resumePolicy) return undefined;
  return typeof o.lifecycleHooks === "boolean"
    ? { lifetime, resumePolicy, lifecycleHooks: o.lifecycleHooks }
    : { lifetime, resumePolicy };
}

function parseDef(d: unknown): SessionDef | undefined {
  if (typeof d !== "object" || d === null) return undefined;
  const o = d as Record<string, unknown>;
  if (typeof o.cmd !== "string") return undefined;
  // SDD 478 M4 — the kind is a STORED fact, read back as written. It used to fall back to the
  // command-string kind suggestion, which made a change to a 15-element array silently reclassify
  // data already on disk, retroactively and with no human in the loop. A record that does not carry
  // a kind is refused: the def is dropped, and a row that held nothing else is dropped with it.
  if (o.kind !== "agent" && o.kind !== "terminal") return undefined;
  const kind: EntryKind = o.kind;
  const contract = parseSpawnContract(o.contract);
  const heartbeat = parseHeartbeat(o.heartbeat);
  return {
    cmd: o.cmd,
    kind,
    ...(typeof o.instructions === "string" ? { instructions: o.instructions } : {}),
    ...(typeof o.taskBrief === "string" ? { taskBrief: o.taskBrief } : {}),
    ...(typeof o.reasoningEffort === "string" ? { reasoningEffort: o.reasoningEffort } : {}),
    ...(heartbeat ? { heartbeat } : {}),
    ...(typeof o.parent === "string" ? { parent: o.parent } : {}),
    ...(typeof o.delegator === "string" ? { delegator: o.delegator } : {}),
    ...(isStringMap(o.env) ? { env: o.env as Record<string, string> } : {}),
    ...(parseEnvironment(o.environment) ? { environment: parseEnvironment(o.environment) } : {}),
    ...(o.fork === true ? { fork: true } : {}), // spec 225 — persistent forked sibling
    ...(typeof o.forkOf === "string" ? { forkOf: o.forkOf } : {}), // t-53e485 — the source whose grant this fork holds
    ...(isPipelineRef(o.pipeline) ? { pipeline: o.pipeline as { runId: string; nodeId: string } } : {}), // spec 230
    ...(contract ? { contract } : {}), // spec 246 + t-c8949c
    ...((o.contract !== undefined && !contract) || o.contractInvalid === "invalid-shape"
      ? { contractInvalid: "invalid-shape" as const }
      : {}),
    ...(typeof o.contractSkipReason === "string" ? { contractSkipReason: o.contractSkipReason } : {}), // spec 246 D6
  };
}

function parseHeartbeat(value: unknown): SessionDef["heartbeat"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (o.event !== "agent.child-idle" || !Number.isSafeInteger(o.epoch) || (o.epoch as number) < 1) return undefined;
  return { event: o.event, epoch: o.epoch as number, ...(typeof o.cursor === "string" ? { cursor: o.cursor } : {}) };
}

/** A persisted spawn-contract (spec 246) — required strings plus exactly one populated completion. */
function parseSpawnContract(v: unknown): SpawnContract | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.task !== "string" || typeof o.context !== "string" || typeof o.constraints !== "string") return undefined;
  if (o.deliverable !== undefined && typeof o.deliverable !== "string") return undefined;
  if (o.doneWhen !== undefined && typeof o.doneWhen !== "string") return undefined;
  const candidate: SpawnContract = {
    task: o.task,
    context: o.context,
    constraints: o.constraints,
    ...(typeof o.deliverable === "string" ? { deliverable: o.deliverable } : {}),
    ...(typeof o.doneWhen === "string" ? { doneWhen: o.doneWhen } : {}),
  };
  return spawnContractCompletion(candidate) ? candidate : undefined;
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

function parseEnvironment(v: unknown): SessionDef["environment"] | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const values = isStringMap(o.values) ? o.values as Record<string, string> : undefined;
  const secrets: Record<string, { provider: string; id: string; purpose: string }> = {};
  if (typeof o.secrets === "object" && o.secrets !== null && !Array.isArray(o.secrets)) {
    for (const [name, raw] of Object.entries(o.secrets as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
      const ref = raw as Record<string, unknown>;
      if (typeof ref.provider !== "string" || typeof ref.id !== "string" || typeof ref.purpose !== "string") return undefined;
      secrets[name] = { provider: ref.provider, id: ref.id, purpose: ref.purpose };
    }
  } else if (o.secrets !== undefined) return undefined;
  if (!values && Object.keys(secrets).length === 0) return undefined;
  return {
    ...(values ? { values } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
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
    ...((): { dependencies?: SharedDependencyState } => {
      const deps = parseDependencies(o.dependencies);
      return deps ? { dependencies: deps } : {};
    })(),
    ...((): { evidence?: WorktreeEvidence[] } => {
      const ev = parseEvidenceArray(o.evidence);
      return ev.length > 0 ? { evidence: ev } : {};
    })(),
  };
}

/**
 * t-3f93b4 — defensive parse of the dependency-sharing decision.
 *
 * It survives the round-trip because it is shown to the agent on later launches.
 *
 * A malformed or unrecognized mode yields undefined rather than a default: "I do not know what this
 * checkout's dependencies are" is a fact worth keeping, and every consumer already handles it by
 * saying nothing instead of claiming something.
 */
function parseDependencies(d: unknown): SharedDependencyState | undefined {
  if (typeof d !== "object" || d === null) return undefined;
  const o = d as Record<string, unknown>;
  if (o.mode !== "linked" && o.mode !== "absent" && o.mode !== "own") return undefined;
  if (typeof o.lockDigest !== "string" || o.lockDigest.length === 0) return undefined;
  return {
    mode: o.mode,
    lockDigest: o.lockDigest,
    ...(typeof o.target === "string" ? { target: o.target } : {}),
    reason: typeof o.reason === "string" ? o.reason : "",
    at: typeof o.at === "string" ? o.at : new Date(0).toISOString(),
  };
}

/** Defensive parse of a persisted evidence array — drops malformed records, never throws. */
function parseEvidenceArray(a: unknown): WorktreeEvidence[] {
  if (!Array.isArray(a)) return [];
  return a.map(parseWorktreeEvidence).filter((rec): rec is WorktreeEvidence => rec !== undefined);
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
