import fs from "node:fs";
import type { AgentInstancePolicy } from "@tachyon/shared/resume/agentInstance.js";
export type { AgentInstanceLifetime, AgentInstancePolicy, AgentInstanceResumePolicy } from "@tachyon/shared/resume/agentInstance.js";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { adapterForRuntime, type ResumeRuntime } from "@tachyon/shared/resume/adapters.js";
import { type EntryKind } from "../config/loadConfig.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";
import { appendCapped, EVIDENCE_SCHEMA_VERSION, type WorktreeEvidence, type Severity } from "../worktree/evidence.js";
import type { SharedDependencyState } from "../worktree/dependencySharing.js";
import { spawnContractCompletion, type SpawnContract } from "../agents/spawnContract.js";

/**
 * Per-workspace session ledger (spec 209 + 211): `agentName -> SessionRecord`,
 * persisted to `.tachyon/sessions.json` so an agent survives the death of its
 * process/window. Tolerant of a missing OR corrupt file — a broken ledger must
 * never block activation, so it reads as empty rather than throwing.
 *
 * Spec 211 split the record into two concerns so a non-resumable row can't be
 * mistaken for a resumable one:
 *   - `def`    — how to RESTART the agent (every Temporary instance, incl. non-AI `sh`);
 *                also carries lineage (`parent`). Drives rehydration after a restart.
 *   - `resume` — how to RESUME the CONVERSATION (adapter-backed runtimes only).
 * Use `isResumable(record)` — NEVER "the row exists" — to decide resume affordances.
 */

/** How to reconstruct/restart a Temporary instance's definition after a host restart. */
export interface SessionDef {
  cmd: string; // the ORIGINAL spawn command (no minted-id injection)
  kind: EntryKind;
  instructions?: string;
  taskBrief?: string;
  parent?: string; // lineage — who spawned it
  /** spec 362 — the Bridge-resolved requester of a GATED delegation (t-bae303). Gated spawns force
   *  `parent` undefined and record this instead; persisted here so it survives a reload — rehydrate
   *  used to only rebuild lineage from `parent`, orphaning a gated agent's sidebar nesting. */
  delegator?: string;
  /** env to re-apply on restart/resume (e.g. an ANTHROPIC_BASE_URL model-swap) — persisted so a
   *  rehydrated Temporary/forked instance keeps it after a reload (spec 225 fork inherits the source's env). */
  env?: Record<string, string>;
  /** spec 226/364 — persisted marker/config for isolated/Temporary harness agents, used during reload/rebind recovery. */
  harness?: unknown;
  /**
   * spec 225 — a forked sibling agent. PERSISTENT: unlike an ordinary Temporary instance, its ledger row +
   * in-memory def survive a Stop (so it stays listed and resumable) and are dropped only on an explicit
   * Dismiss. Durable (lives in the ledger), so the persistence holds across a window reload too.
   */
  fork?: boolean;
  /**
   * t-53e485 — the agent this fork was forked FROM, and the reason it is a separate field from
   * `parent`: a fork is a SIBLING, not a child, so recording it as lineage would nest it under its
   * source in the sidebar and in every descendant query.
   *
   * It exists because the fork's GRANT has to be re-derivable. `commitFork` copies the source's
   * `profileCapabilities` into the live fork definition, but `temporaryDefinitionFrom` rebuilds a
   * Temporary's definition from this row, and the row has no field for a capability projection — so
   * the moment anything re-derived the definition, the fork resolved as grantless. Measured
   * 2026-08-11: `claude-fork-1` runs with 3 skills in its private home while `definitionOf` reported
   * it holding none, and its delegated child `anchorrace` inherited zero. Recording the EDGE rather
   * than the payload keeps the row small and re-resolves the grant from the source's live profile,
   * which is the authority — a frozen copy in the ledger would be a second place for it to go stale.
   */
  forkOf?: string;
  /**
   * spec 230 — set when this Temporary instance is a NODE of a pipeline run owned by a PipelineManager. The
   * generic activation resume/offer path skips rows carrying this (the run reconciles its own nodes);
   * a TYPED field (not an untyped tag) so it survives `parseDef` across a reload (codex S4 M4).
   */
  pipeline?: { runId: string; nodeId: string };
  /** spec 246 — the structured delegation contract this child was spawned under (Bridge spawn-contract gate).
   *  Persisted as TYPED metadata (D8) so it survives a reload and is queryable for audit — not just
   *  flattened into the delivered instructions. */
  contract?: SpawnContract;
  /** t-c8949c — a persisted contract field existed but failed structural validation. Content-free
   *  sentinel: restart must refuse it rather than silently treating it as no structured contract. */
  contractInvalid?: "invalid-shape";
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
 * t-04052d — the ratified vocabulary of the Agent Instance cut.
 *
 * `lifetime` answers the only question about the DEFINITION: does it outlive the process? That is the
 * question `declared` was answering by proxy, through which store the definition happened to sit in,
 * and it is now declared data rather than an inference.
 *
 * `resumePolicy` is a SEPARATE axis, and keeping the two apart is mandatory rather than stylistic. A
 * fork is `temporary` — no durable Profile behind it — AND `restartable`, because it owns a resume
 * block. One value would have to lie about one of the two, most likely about the fork surviving,
 * which is the reload this cut must not break.
 *
 * The second axis is RENAMED rather than left alone: it used to be called `lifetime`, and leaving two
 * fields one rename apart is how a reader ends up configuring the one they did not mean.
 */
export interface SessionRecord {
  /** present for every Temporary instance; absent for a declared agent's resume-only row. */
  def?: SessionDef;
  /** present only for adapter-backed runtimes. */
  resume?: SessionResume;
  /** spec 210 — the agent's git worktree (path/branch/ownership/baseRef); cleanup + C2 read this, never recompute from drifted config. */
  worktree?: WorktreeRecord;
  /** absolute cwd the agent ran in — resume respawns here, transcript resolves here. */
  cwd: string;
  /*
   * t-5e1113 (SDD 482, ratified decision 5) — `def.parent` used to be stripped from DECLARED records
   * on every write, so a Saved agent's runtime lineage died with the extension host while a Temporary
   * agent's survived. That asymmetry was measured, mis-stated in the first draft of the SDD, and then
   * resolved by the human the other way: lineage is durable for BOTH, for the life of the instance.
   * Profile ownership (`declaredOwner`, derived from `subagents`) is a different edge and is still
   * never derived from this one, nor this one from it.
   */
  /** spec 364 — durable Bridge-client generation stamp for rebind after host reload. */
  bridgeClient?: BridgeClientBinding;
  /**
   * SDD 482 phase 2 — the declared Agent Instance policy. Optional because rows written before the
   * split have no honest value: absent means "predates the split", and inventing one from `declared`
   * at read time would re-create the inference this replaces.
   */
  instance?: AgentInstancePolicy;
  /** Explicit terminal state for a row that remains visible until dismiss/restart. */
  lifecycle?: SessionLifecycle;
  updatedAt: string;
}

/**
 * How THIS instance ended, durably — the fact the tmux pane cannot carry.
 *
 * `clean-exited`: the process exited 0 and Tachyon collected its postmortem pane.
 * `stopped` (t-9d76b1): TACHYON ASKED IT TO EXIT — a graceful Stop, a graceful restart, a Bridge-client
 * rebind. Written at the observed death, because the exit code cannot say who asked and the in-memory
 * record of the request dies with the extension host while the dead pane outlives it. Without it a
 * window reload turns a stop the human ordered back into `crashed`.
 *
 * Terminal, and instance-scoped: spawn writes a fresh record, restart and resume strip this field, so
 * one instance's ending can never describe the next one.
 */
export interface SessionLifecycle {
  state: "clean-exited" | "stopped";
  exitedAt: string;
}

/** A row may drive resume only when it has a runtime AND that runtime still has an adapter. */
export function isResumable(rec: SessionRecord): boolean {
  return !!rec.resume?.runtime && adapterForRuntime(rec.resume.runtime) !== undefined;
}

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
    all.set(name, withoutSelfParent(name, { ...rec, updatedAt: rec.updatedAt ?? new Date().toISOString() }));
    this.write(all);
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


  private write(all: Map<string, SessionRecord>): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const sessions = Object.fromEntries(all);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
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
  if (o.def !== undefined || o.resume !== undefined || o.worktree !== undefined || o.bridgeClient !== undefined || o.lifecycle !== undefined) {
    const def = parseDef(o.def);
    const resume = parseResume(o.resume);
    const worktree = parseWorktree(o.worktree);
    const bridgeClient = parseBridgeClient(o.bridgeClient);
    const lifecycle = parseLifecycle(o.lifecycle);
    const instance = parseInstancePolicy(o.instance);
    if (!def && !resume && !worktree && !bridgeClient) return null;
    // t-04052d — a row whose `instance` did not parse is KEPT, not dropped. Dropping it would delete
    // the very evidence the activation gate refuses on, turning its ledger check into a no-op and
    // discarding a pre-cut operator's rows without telling them. It survives here and is refused
    // there; no reader can get a policy answer out of it in the meantime.
    return { def, resume, worktree, bridgeClient, lifecycle, instance, cwd: o.cwd, updatedAt };
  }

  // SDD 478 M4 — the pre-211 flat record (`{runtime, sessionId, cwd, cmd, declared}`) predates the
  // stored `kind` entirely, so migrating it required SYNTHESIZING one from the command string. That
  // is the inference this step removes, and there is no honest substitute: the fact was never
  // written. Such a record is refused rather than guessed, which drops a shape that has not been
  // written since spec 211.
  return null;
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
  return {
    cmd: o.cmd,
    kind,
    ...(typeof o.instructions === "string" ? { instructions: o.instructions } : {}),
    ...(typeof o.taskBrief === "string" ? { taskBrief: o.taskBrief } : {}),
    ...(typeof o.parent === "string" ? { parent: o.parent } : {}),
    ...(typeof o.delegator === "string" ? { delegator: o.delegator } : {}),
    ...(isStringMap(o.env) ? { env: o.env as Record<string, string> } : {}),
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

/** spec 364 — missing pre-364 `boundGeneration` is treated as 0 (upgrade rebind). */
export function durableBoundGeneration(rec: SessionRecord | undefined): number {
  return rec?.bridgeClient?.boundGeneration ?? 0;
}
