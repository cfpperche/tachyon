/**
 * The persisted instance row and the questions asked of it (t-29c3de).
 *
 * This is the durable record of one instance: how to restart it, how to resume
 * its conversation, and whether those things are still possible. SessionLedger
 * reads and writes `.tachyon/sessions.json`; it does not own this shape.
 */
import type { AgentInstancePolicy } from "@tachyon/shared/resume/agentInstance.js";
import { adapterForRuntime, type ResumeRuntime } from "@tachyon/shared/resume/adapters.js";
import type { EntryKind } from "@tachyon/shared/config/entry.js";
import type { WorktreeRecord } from "../worktree/worktreeRecord.js";
import type { SpawnContract } from "../agents/spawnContract.js";
import type { AgentSecretEnvironment } from "../config/loadConfig.js";
import type { TemporaryAgentScope } from "../agents/temporaryAgentScope.js";

/** How to reconstruct/restart a Temporary instance's definition after a host restart. */
export interface SessionDef {
  cmd: string; // the ORIGINAL spawn command (no minted-id injection)
  kind: EntryKind;
  instructions?: string;
  taskBrief?: string;
  /** Explicit Temporary-agent native reasoning selector, retained for audit and reload. */
  reasoningEffort?: string;
  /** t-21e115 — fixed-policy heartbeat. Epoch fences reused names; cursor is the last accepted idle episode. */
  heartbeat?: { event: "agent.child-idle"; epoch: number; cursor?: string };
  parent?: string; // lineage — who spawned it
  /** spec 362 — the Bridge-resolved requester of a GATED delegation (t-bae303). Gated spawns force
   *  `parent` undefined and record this instead; persisted here so it survives a reload — rehydrate
   *  used to only rebuild lineage from `parent`, orphaning a gated agent's sidebar nesting. */
  delegator?: string;
  /** env to re-apply on restart/resume (e.g. an ANTHROPIC_BASE_URL model-swap) — persisted so a
   *  rehydrated Temporary/forked instance keeps it after a reload (spec 225 fork inherits the source's env). */
  env?: Record<string, string>;
  /** Temporary Agent environment references; values are resolved only at launch. */
  environment?: { values?: Record<string, string>; secrets?: AgentSecretEnvironment };
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
  /** Durable systemd-user identity for the process scope containing this Temporary instance. */
  processScope?: TemporaryAgentScope;
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

/** A row may drive resume only when it has a runtime AND that runtime still has an adapter. */
export function isResumable(rec: SessionRecord): boolean {
  return !!rec.resume?.runtime && adapterForRuntime(rec.resume.runtime) !== undefined;
}

/** spec 364 — missing pre-364 `boundGeneration` is treated as 0 (upgrade rebind). */
export function durableBoundGeneration(rec: SessionRecord | undefined): number {
  return rec?.bridgeClient?.boundGeneration ?? 0;
}
