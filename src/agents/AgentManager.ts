import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexConfigCmd, codexFlagCmd, composeCommand, codexBridgeCmd, shellQuote, inferKind, type AgentDef, type EntryKind, type TachyonConfig } from "../config/loadConfig.js";
import { composeInstructions, withBridgeGuidance } from "../roles/templates.js";
import { TmuxService, sessionName, agentFromSession, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { adapterFor, adapterForRuntime, binaryOf, forkable, managesOwnSession, type ResumeAdapter, type ResumeRuntime } from "../resume/adapters.js";
import { URL_ENV_VAR } from "../bridge/token.js";
import { redactSecrets } from "../bridge/redact.js";
import type { WorktreeRecord } from "../worktree/WorktreeManager.js";
import { harnessHome, type MaterializedHarness } from "../harness/HarnessManager.js";
import type { SessionLedger, SessionRecord, SessionResume } from "../resume/SessionLedger.js";
import { moveActivityLog } from "../activity/logStore.js";
import type { SpawnContract } from "../bridge/spawnContract.js";
import { readLatestDelegationRecord, type DelegationGate } from "../bridge/delegationRecord.js";
import type { ResolvedCaptureSession } from "../resume/resolvers.js";
import { assertVerifiedTranscriptIsolation, isolationMechanismForCommand } from "../runtime/runtimeProfile.js";
import { forgetAgent } from "./forgetAgent.js";
import { wrapWithPrimer, renderPrimer } from "../bridge/primer.js";

export class MaxAgentsError extends Error {
  constructor(max: number) {
    super(`maxAgents limit reached (${max}); kill an agent or raise settings.maxAgents in tachyon.yml`);
    this.name = "MaxAgentsError";
  }
}

export class UnknownAgentError extends Error {
  constructor(name: string) {
    super(`unknown agent '${name}': not declared in tachyon.yml and not running`);
    this.name = "UnknownAgentError";
  }
}

export class AgentNotRunningError extends Error {
  constructor(name: string) {
    super(`agent '${name}' is not running`);
    this.name = "AgentNotRunningError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isCodexTurnActive(pane: string): boolean {
  return /\besc to interrupt\b/i.test(pane) || /(?:^|\n)\s*[•●]\s*(?:Working|Thinking|Reasoning)\b/i.test(pane);
}

/** Resume couldn't proceed (no id / transcript gone) — caller should fall back to a fresh spawn. */
export class ResumeUnavailableError extends Error {
  constructor(
    readonly agent: string,
    reason: string,
  ) {
    super(`cannot resume '${agent}': ${reason}`);
    this.name = "ResumeUnavailableError";
  }
}

/** spec 225 — fork couldn't proceed (runtime not forkable, live id unresolved, or worktree create failed). Fail-closed: never guesses a running agent's session id. */
export class ForkUnavailableError extends Error {
  constructor(
    readonly agent: string,
    reason: string,
  ) {
    super(`cannot fork '${agent}': ${reason}`);
    this.name = "ForkUnavailableError";
  }
}

export interface ManagedEntryInfo {
  name: string;
  session: string;
  /** alive process (a crashed dead-pane session is NOT running) */
  running: boolean;
  /** graceful Stop is in flight; user actions that contend for the pane should be held */
  stopping?: boolean;
  declared: boolean;
  /** dead pane present (process ended on its own; postmortem kept until dismiss/restart) */
  dead: boolean;
  /** dead with a NON-ZERO exit — a clean exit (0) is dead but not crashed */
  crashed: boolean;
  exitCode?: number;
  /** process exited 0 and Tachyon already cleared the tmux postmortem pane */
  cleanExited?: boolean;
  /** agent = AI CLI; terminal = server/shell/build. Inferred or declared in tachyon.yml. */
  kind: EntryKind;
  /** who spawned it (self-declared via spawn_agent's parent param; session-local memory) */
  parent?: string;
  /** Bridge-resolved agent that requested a gated delegation; display metadata, not runtime lineage. */
  delegator?: string;
  /** config-declared owner from tachyon.yml subagents; display metadata only, not runtime lineage */
  declaredOwner?: string;
}

/** Compatibility name for the unified managed-entry listing row. Prefer `ManagedEntryInfo`
 *  in new code; `AgentInfo` remains exported for existing imports and public surfaces. */
export type AgentInfo = ManagedEntryInfo;

export interface PostmortemOutput {
  text: string;
  truncated: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface SpawnOptions {
  /** present = ad-hoc agent (not declared in tachyon.yml) */
  cmd?: string;
  cwd?: string;
  /** role prompt for ad-hoc agents — delivered via composeCommand like declared ones */
  instructions?: string;
  /** lineage: the agent that requested this spawn (self-declared) */
  parent?: string;
  /** spec 362 — Bridge-resolved requester for a gated delegation. Separate from parent because gated agents spawn top-level. */
  delegator?: string;
  /** open + focus the editor terminal on spawn (default true). The Bridge passes false
   *  so an agent spawning a child doesn't yank the human's focus off the parent (F3). */
  reveal?: boolean;
  /** spec 210 — opt this ad-hoc spawn into git-worktree isolation (top-level only; a sub-agent inherits the parent's cwd). */
  worktree?: boolean;
  /** spec 230 — extra env merged into this ad-hoc spawn (e.g. a pipeline node's TACHYON_RUN_ID/NODE_ID/NODE_NONCE). Agent-declared env still wins on conflict via the spawn merge order. */
  env?: Record<string, string>;
  /** spec 230 — tag this ad-hoc spawn as a pipeline-run node; persisted to SessionDef.pipeline so the generic resume/offer path skips it (the run owns it). */
  pipeline?: { runId: string; nodeId: string };
  /** spec 230 — extra instructions appended to the agent's composed prompt (a pipeline node's task, added AFTER a declared agent's role/instructions so the specialist config is preserved). */
  appendInstructions?: string;
  /** spec 246 — the validated delegation contract this ad-hoc AI child was spawned under (Bridge spawn-contract
   *  gate); persisted as structured metadata on the ledger def (D8). The brief itself rides in `instructions`. */
  contract?: SpawnContract;
  /** spec 246 — set when the spawner bypassed the contract gate (`skip_contract_reason`); recorded for audit. */
  contractSkipReason?: string;
  /** spec 362 — a gated delegation must be born in an isolated worktree and later verified by behavior test. */
  gate?: DelegationGate;
}

export interface AgentManagerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  getMaxAgents: () => number;
  /** Env injected into every spawned session (e.g. TACHYON_BRIDGE_URL/TOKEN); agent-declared env wins on conflict. */
  getExtraEnv?: () => Record<string, string>;
  /** spec 351 — mint a fresh per-agent Bridge token for `name` (TACHYON_AGENT_BRIDGE_TOKEN), returning the
   *  env var(s) to merge; `{}` when no registry is wired (e.g. auth disabled). Called exactly ONCE per
   *  spawn/restart/resume — minting is NOT idempotent (each call revokes the prior live token for this
   *  name first, dueto F4 ordering), so calling it twice for one lifecycle transition would strand the
   *  first token before the process even starts using it. */
  mintAgentToken?: (name: string) => Record<string, string>;
  /** spec 351 — revoke `name`'s current live per-agent token (kill/dismiss) so a process still holding it
   *  gets `token_revoked` on its next Bridge call instead of a generic `token_unknown`. */
  revokeAgentToken?: (name: string) => void;
  /** spec 236 — write a non-harness claude agent's Bridge-only `--mcp-config` file, returning its path
   *  (undefined when the Bridge isn't up). Wired in Workspace where the Bridge URL/token live. */
  materializeBridgeMcp?: (name: string) => string | undefined;
  /** spec 243 — write a claude agent's per-spawn `--settings` file (the SessionStart ownership hook),
   *  returning its path; injected so activity follows a `/clear` on a shared cwd. Wired in Workspace. */
  materializeOwnershipSettings?: (name: string, opts?: { ownershipOnly?: boolean }) => string | undefined;
  /** spec 303 — write Codex-compatible hook scripts and return `key=value`
   *  config override values for session-scoped `-c` injection. */
  materializeCodexSessionStartHookConfig?: (name: string, opts?: { ownershipOnly?: boolean }) => string | string[] | undefined;
  /** spec 243 — the agent's CURRENT owned session, from the ownership ledger the hook writes (newest row
   *  for this agent+cwd). Lets the activity resolver follow a `/clear`/`/resume` rotation positively,
   *  never by guessing on a shared cwd. Wired in Workspace where the ledger path is known. */
  ownedSession?: (name: string, cwd: string) => { sessionId: string; transcriptPath: string } | undefined;
  /** spec 236 — surface a non-blocking advisory (e.g. a user `--strict-mcp-config` mutes Bridge injection). */
  notify?: (message: string, level: "warn") => void;
  /** spec 312 — lets Workspace tie pane-nudge suppression to the actual spawn-time hook outcome. */
  onSessionHooksInjected?: (name: string, injected: boolean) => void;
  onSpawned?: (name: string, reveal: boolean) => void;
  onStopping?: (name: string) => void;
  onKilled?: (name: string) => void;
  /** Fired at the START of a restart (before the session is killed) — lets the UI close the
   * old editor terminal synchronously, so the post-spawn onSpawned re-opens a fresh one
   * instead of reusing the now-dead terminal (which closes async when its tmux client dies). */
  onRestart?: (name: string) => void;
  /** Session-resume ledger (spec 209); absent = resume tracking disabled. */
  ledger?: SessionLedger;
  /** Session-id generator for mint runtimes (claude/gemini); default crypto UUID. */
  newSessionId?: () => string;
  /** Resolve a capture-runtime's session id from disk by cwd (codex/opencode/...); fills "" ledger entries. `configHome` (spec 226) scopes the scan to a harness agent's redirected claude config home. */
  resolveCaptureId?: (runtime: ResumeRuntime, cwd: string, configHome?: string) => Promise<string | null>;
  /** Resolve a capture-runtime session with its canonical transcript path when the runtime's file path is not derivable from id alone. */
  resolveCaptureSession?: (runtime: ResumeRuntime, cwd: string, configHome?: string, id?: string) => Promise<ResolvedCaptureSession | null>;
  /** spec 212 / A3 — resolve the session a cwd is CURRENTLY in (newest transcript), to refresh ownership at stop after an in-TUI /resume. `title` (spec 220) lets claude match by jsonl customTitle for an exact, shared-cwd-safe uuid. `configHome` (spec 226) scopes the scan to a harness agent's redirected claude config home. */
  resolveCurrentSession?: (runtime: ResumeRuntime, cwd: string, title?: string, configHome?: string) => Promise<string | null>;
  /** Transcript-existence probe (default fs.existsSync) — injected for tests. */
  fileExists?: (path: string) => boolean;
  /** Home dir resolver (default os.homedir) — injected for tests. */
  homeDir?: () => string;
  /**
   * spec 210 — resolve the cwd a session is born in (worktree isolation). Given the spawn
   * context, returns the cwd + an optional worktree record to persist, or null to use the
   * default (workspace root / def.cwd). Owned by Workspace (it has the WorktreeManager,
   * lineage, and the setup runner). Awaited by the async spawn/restart — never the UI thread.
   */
  resolveSpawnCwd?: (ctx: SpawnCwdContext) => Promise<{ cwd: string; worktree?: WorktreeRecord; delegationBaseSha?: string } | null>;
  /** spec 362 — persist the spawn-side delegation record after a gated agent successfully starts. */
  recordDelegation?: (input: { name: string; delegator?: string; gate: DelegationGate; contract: SpawnContract; worktree: WorktreeRecord; baseSha: string }) => void;
  /**
   * spec 225 — read-only "does the source worktree have uncommitted changes?" probe, for the fork's
   * dirty warning (those changes are NOT carried into the fork, which branches off committed HEAD).
   */
  worktreeDirty?: (rec: WorktreeRecord) => Promise<boolean>;
  /**
   * spec 225 — create a fresh worktree for a fork branched off the SOURCE worktree's committed HEAD
   * (its branch). Returns the new cwd + record, or null on any git failure (the caller fails the fork
   * closed rather than spawn it in the wrong cwd — claude `--resume` is project-dir/cwd-scoped).
   */
  createForkWorktree?: (forkName: string, source: WorktreeRecord) => Promise<{ cwd: string; worktree: WorktreeRecord } | null>;
  /**
   * spec 225 — copy `from`→`to` (the source session transcript into the fork cwd's project dir) and
   * RETURN whether the destination now exists. claude resolves `--resume <uuid>` ONLY within the
   * current cwd's encoded project dir (verified live 2026-06-16), so a fork in a NEW worktree cwd must
   * be seeded or it can't carry context — commitFork FAILS CLOSED (rolls back the worktree) on a false
   * return rather than spawn a context-less fork. Default = fs copy then existence check. Injectable for tests.
   */
  seedTranscript?: (from: string, to: string) => boolean;
  /** spec 225 — roll back a fork's freshly-created worktree when a later commit step fails (no orphan). */
  removeForkWorktree?: (worktree: WorktreeRecord) => Promise<void>;
  /**
   * spec 226 — materialize an agent's isolated harness (private config home + scoped MCP) and return
   * the spawn wiring (CLAUDE_CONFIG_DIR env + the strict-mcp args), or null when the agent has no
   * harness / the runtime doesn't support one. Owned by Workspace (it has the HarnessManager). Called
   * on EVERY spawn path (spawn/restart/resume/fork) so isolation never silently drops (H3).
   */
  materializeHarness?: (ctx: { name: string; def: AgentDef; cwd: string }) => MaterializedHarness | null;
  /** Remove a materialized per-agent runtime config home at the agent's end-of-life. */
  removeHarnessHome?: (name: string) => void;
}

/**
 * spec 225 — a resolved, side-effect-free plan to fork an agent. Built by planFork (which fail-closes
 * on an unresolvable live id) and handed to commitFork to actually spawn. Lets the UI confirm the
 * fork name + base + dirty warning BEFORE any worktree is created or session spawned.
 */
export interface ForkPlan {
  /** the agent being forked */
  source: string;
  /** the unique sibling name `<source>-fork-N` */
  forkName: string;
  /** the source session's RESOLVED live id (a real uuid) — the `--fork-session` resume target */
  sourceId: string;
  /** the source's recorded cwd (the fork shares it when the source has no worktree) */
  sourceCwd: string;
  /** the BASE spawn command the fork inherits (no `-n`/resume injection) */
  baseCmd: string;
  runtime: ResumeRuntime;
  instructions?: string;
  /** the source's worktree, if any — the fork gets its OWN worktree branched off this one's committed HEAD */
  sourceWorktree?: WorktreeRecord;
  /** true when the source worktree has uncommitted changes (NOT carried into the fork) */
  dirty: boolean;
}

/** Context handed to the worktree cwd resolver (spec 210). */
export interface SpawnCwdContext {
  name: string;
  def: AgentDef;
  /** lineage parent, if this is a sub-agent spawn (it inherits the parent's cwd) */
  parent?: string;
  /** ad-hoc (MCP-spawned) vs declared */
  adhoc: boolean;
  /** true on restart/resume — the resolver reuses the worktree and skips worktreeSetup */
  isRestart: boolean;
  /** spec 362 — present only when spawn_agent requested a verification gate; must fail closed without a worktree. */
  gate?: DelegationGate;
}

/**
 * Which declared autostart agents are NEWLY added (in `after` but not `before`) and not already
 * running — the set to auto-start after a live tachyon.yml edit (dogfood p-5a2a83 follow-up).
 * NEVER includes a pre-existing agent, so an intentionally-stopped one is left alone; the Studio
 * create path is covered separately and its synchronous reload means `before` already has the
 * new name (so this won't double-fire for it). Pure → unit-tested.
 */
export function newlyDeclaredAutostart(
  before: Set<string>,
  after: Record<string, { autostart: boolean }>,
  running: Set<string>,
): string[] {
  return Object.entries(after)
    .filter(([name, def]) => def.autostart && !before.has(name) && !running.has(name))
    .map(([name]) => name);
}

/**
 * Lifecycle orchestration over TmuxService. tmux is the source of truth for what's
 * running; the only in-memory state is the definition of ad-hoc (MCP-spawned) agents,
 * which does not survive an extension restart by design.
 */
export class AgentManager {
  static readonly STOPPING_FALLBACK_MS = 15_000;
  static readonly POSTMORTEM_MAX_LINES = 1000;
  static readonly POSTMORTEM_MAX_BYTES = 64 * 1024;
  private adhoc = new Map<string, AgentDef>();
  /** child -> parent. Like adhoc defs, lineage is session-local memory: tmux sessions
   * survive an extension restart, the genealogy does not (documented). */
  private lineage = new Map<string, string>();
  /** child -> delegator for gated delegations. Display-only; gated children intentionally have no runtime parent. */
  private delegators = new Map<string, string>();
  /** spec 221 perf — cache the resume-readiness badge per agent (validated by sessionId), so the
   *  sidebar probe doesn't re-resolve/scan on every tree refresh. Cleared on lifecycle changes. */
  private readinessCache = new Map<string, { sessionId: string; ready: boolean }>();
  private stoppingSince = new Map<string, number>();
  private cleanExited = new Set<string>();
  private postmortemOutput = new Map<string, PostmortemOutput>();
  /** Last known-good agentStates() result — served back when tmux.sessionStates() returns
   * null (an ambiguous list-panes error), so a transient tmux hiccup can't read as "every
   * agent vanished" (t-3a3a14). */
  private lastAgentStates = new Map<string, { dead: boolean; exitCode?: number }>();

  constructor(private readonly opts: AgentManagerOptions) {}

  private get prefix(): string {
    return `${SESSION_PREFIX}-${this.opts.wsHash}-`;
  }

  session(name: string): string {
    return sessionName(this.opts.wsHash, name);
  }

  private definitionOf(name: string): AgentDef | undefined {
    return this.opts.getConfig()?.agents[name] ?? this.adhoc.get(name);
  }

  /** Public read of an agent's definition (declared config wins, then ad-hoc) — spec 216 needs
   *  cmd/role/instructions to detect compaction and rebuild the role reminder. */
  defOf(name: string): AgentDef | undefined {
    return this.definitionOf(name);
  }

  /** An agent's kind (config wins, then ad-hoc def, else infer from a running session's
   *  command). Used to give ad-hoc TERMINALS terminal defaults (e.g. attention off) — F5. */
  kindOf(name: string): EntryKind {
    return this.definitionOf(name)?.kind ?? "agent";
  }

  /** spec 332 — the lineage parent recorded for this agent (session-local memory, same source as
   *  list()'s `parent` field), if any. Used by the death-poke wiring to find who to wake. */
  parentOf(name: string): string | undefined {
    return this.lineage.get(name);
  }

  /** spec 363 T3 — the gated delegation's delegator (Bridge-witnessed doorbell target from T1),
   *  same source as list()'s `delegator` field. Used to re-render the primer on re-anchor/resume. */
  delegatorOf(name: string): string | undefined {
    return this.delegators.get(name);
  }

  /**
   * spec 210 cleanup guard — transitive descendants of `name` whose session is currently
   * ALIVE. Removing a parent's worktree is blocked while any of these run (never yank a
   * running child's cwd); the caller must stop the subtree first.
   */
  async liveDescendants(name: string): Promise<string[]> {
    const running = new Set(await this.runningAgents());
    // Union in-memory lineage with persisted ledger parents (review fix): a DECLARED child
    // spawned with `parent` survives a reload but rehydrateFromLedger skips declared names,
    // so its link lives only in the ledger — without this the guard would miss it and a
    // running child's worktree/cwd could be yanked.
    const ledgerParent = new Map<string, string>();
    if (this.opts.ledger) for (const [c, r] of this.opts.ledger.all()) if (r.def?.parent) ledgerParent.set(c, r.def.parent);
    const childrenOf = (p: string): string[] => {
      const kids = new Set<string>();
      for (const [c, par] of this.lineage.entries()) if (par === p) kids.add(c);
      for (const [c, par] of ledgerParent.entries()) if (par === p) kids.add(c);
      return [...kids];
    };
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = childrenOf(name);
    while (stack.length > 0) {
      const c = stack.pop() as string;
      if (seen.has(c)) continue;
      seen.add(c);
      if (running.has(c)) out.push(c);
      stack.push(...childrenOf(c));
    }
    return out;
  }

  /**
   * Spec 211: after a host restart, rebuild the in-memory ad-hoc defs + lineage
   * from the ledger so a re-discovered ad-hoc agent is restartable and re-nests.
   * Only `def`-bearing rows whose name is NOT currently declared in config (config
   * is authoritative) and not already live in memory; idempotent; self-parent links
   * are dropped. Resume rows without a def (none today) are ignored.
   */
  rehydrateFromLedger(): void {
    if (!this.opts.ledger) return;
    const declared = new Set(Object.keys(this.opts.getConfig()?.agents ?? {}));
    for (const [name, rec] of this.opts.ledger.all()) {
      if (!rec.def || rec.declared || declared.has(name)) continue;
      if (!this.adhoc.has(name)) {
        this.adhoc.set(name, {
          cmd: rec.def.cmd,
          instructions: rec.def.instructions,
          ...(rec.def.env ? { env: rec.def.env } : {}), // spec 225 — a forked sibling's inherited env survives reload
          autostart: false,
          watch: [],
          attention: { enabled: true, silenceSec: 8, patterns: [] },
          restart: "never",
          kind: rec.def.kind,
          // spec 210 — a row with a worktree record means this agent runs in a worktree;
          // restore the flag so restart reuses it instead of falling back to the root
          // (review fix: rehydrated ad-hoc worktree agents lost worktree:true).
          worktree: !!rec.worktree,
        });
      }
      if (rec.def.parent && rec.def.parent !== name && !this.lineage.has(name)) {
        this.lineage.set(name, rec.def.parent);
      }
    }
    // spec 240 — backfill resume.configHome on pre-240 rows (derive from current config) so transcript lookup
    // is LOCKED before any later isolate/harness toggle. spec 305 follow-up: also repair rows whose persisted
    // home is a known default for the WRONG runtime (e.g. old codex rows stamped as ~/.claude).
    for (const [name, rec] of this.opts.ledger.all()) {
      if (rec.resume && (rec.resume.configHome === undefined || this.isWrongRuntimeDefaultHome(rec.resume.runtime, rec.resume.configHome))) {
        this.opts.ledger.record(name, { ...rec, resume: this.withConfigHome(name, this.definitionOf(name), rec.resume) });
      }
    }
  }

  /**
   * Per-agent session state for this workspace: alive, or dead pane with exit code.
   * A null from tmux.sessionStates() means the underlying list-panes call failed
   * ambiguously (not a confirmed "no server") — serve the last known-good snapshot
   * instead of an empty map, so callers (LifecycleMonitor included) don't read a
   * transient tmux error as every agent having vanished.
   */
  async agentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }>> {
    const sessions = await this.opts.tmux.sessionStates(this.prefix);
    if (sessions === null) return this.lastAgentStates;
    const out = new Map<string, { dead: boolean; exitCode?: number }>();
    for (const [session, state] of sessions) {
      const agent = agentFromSession(this.opts.wsHash, session);
      if (agent !== null) out.set(agent, state);
    }
    this.lastAgentStates = out;
    return out;
  }

  /** Agents whose process is ALIVE — crashed dead panes don't count. */
  async runningAgents(): Promise<string[]> {
    const states = await this.agentStates();
    return [...states.entries()].filter(([, s]) => !s.dead).map(([agent]) => agent);
  }

  async list(): Promise<ManagedEntryInfo[]> {
    const states = await this.agentStates();
    const config = this.opts.getConfig();
    const declared = Object.keys(config?.agents ?? {});
    const all = new Set([...declared, ...states.keys(), ...this.adhoc.keys(), ...this.cleanExited]);
    const now = Date.now();
    const infos = [...all].sort().map((name) => {
      const state = states.get(name);
      const stoppingAt = this.stoppingSince.get(name);
      const stopping = state !== undefined && !state.dead && stoppingAt !== undefined && now - stoppingAt < AgentManager.STOPPING_FALLBACK_MS;
      if ((state === undefined || state.dead || (stoppingAt !== undefined && now - stoppingAt >= AgentManager.STOPPING_FALLBACK_MS))) {
        this.stoppingSince.delete(name);
      }
      return {
        name,
        session: this.session(name),
        running: state !== undefined && !state.dead,
        ...(stopping ? { stopping: true } : {}),
        declared: declared.includes(name),
        dead: state?.dead ?? false,
        crashed: (state?.dead ?? false) && state?.exitCode !== 0,
        exitCode: state?.exitCode,
        ...(!state && this.cleanExited.has(name) ? { cleanExited: true } : {}),
        kind: this.definitionOf(name)?.kind ?? "agent",
        parent: this.lineage.get(name),
        delegator: this.delegators.get(name),
        declaredOwner: config?.declaredOwner[name],
      };
    });
    // F6 (spec 211 follow-up): a finished ad-hoc one-shot (clean exit 0) must not
    // survive a window reload as a zombie restartable row — drop its ledger entry
    // so rehydrate skips it. The dead pane stays in-session for postmortem until
    // dismissed; crashed (non-zero) ad-hocs ARE kept (restart/postmortem). remove()
    // is idempotent (writes only when the row existed), so this is render-safe.
    for (const info of infos) {
      // spec 225 — a PERSISTENT forked sibling is exempt: even a clean self-exit keeps its row so it
      // stays resumable until an explicit Dismiss (it's not a throwaway one-shot). Gated to the rare
      // clean-exit-adhoc case, so the ledger read here is not a per-refresh hot-path cost.
      if (!info.declared && info.dead && info.exitCode === 0 && this.opts.ledger?.get(info.name)?.def?.fork !== true) {
        this.opts.ledger?.remove(info.name);
      }
    }
    return infos;
  }

  /**
   * spec 216 — the launch command with role + Bridge guidance applied. The role template
   * composes with the agent's instructions (template first); a child spawned via the Bridge
   * (it has a parent) also gets the Bridge-coordination guidance, unless disabled. Resume does
   * NOT use this — a resumed session already carries its original instructions in its transcript.
   *
   * spec 363 T3 — the same composed instructions are then wrapped with the generated PRIMER
   * (prepended) + BEFORE-FINISHING block (appended), UNLESS there is nothing being delivered at
   * all (a bare declared entry with no role/instructions and no lineage — nothing to onboard
   * around, so the non-gated/non-declared byte-identical guard holds for that case).
   */
  private effectiveCmd(name: string, def: AgentDef, parent: string | undefined, primerCtx?: { delegator?: string; gate?: DelegationGate; freshWorktree?: boolean }): string {
    const guidance = !!parent && (this.opts.getConfig()?.settings.bridgeGuidance ?? true);
    const composed = withBridgeGuidance(composeInstructions(def.role, def.instructions), guidance);
    const spawner = primerCtx?.delegator ?? parent;
    const instructions = composed?.trim() || spawner || primerCtx?.gate
      ? wrapWithPrimer(composed ?? "", {
          agentName: name,
          delegator: primerCtx?.delegator,
          parent,
          gate: primerCtx?.gate,
          freshWorktree: primerCtx?.freshWorktree,
          verify: this.opts.getConfig()?.settings.verify,
        })
      : composed;
    return composeCommand({ cmd: def.cmd, instructions });
  }

  /**
   * spec 226 (H3) — the SINGLE place isolated-harness wiring is applied. Materializes the agent's
   * private config home (if any) and folds its CLAUDE_CONFIG_DIR env + strict-mcp args into the
   * spawn, so spawn/restart/resume/fork are all isolated identically. No-op for an agent without a
   * harness, or when no materializer is wired. Pass the ORIGINAL declared def (it carries `harness`).
   */
  private applyHarness(name: string, def: AgentDef | undefined, cwd: string, cmd: string, env: Record<string, string>): { cmd: string; env: Record<string, string> } {
    const isolation = def ? isolationMechanismForCommand(def.cmd) : undefined;
    // spec 357/profile 358 - private-home runtimes need a per-agent config home by default.
    const needsPrivateHome = !!def?.harness || def?.isolate === "transcript" || isolation?.mechanism === "private-home";
    if (!def || !needsPrivateHome || !this.opts.materializeHarness) return { cmd, env }; // spec 240: also for isolate
    const mat = this.opts.materializeHarness({ name, def, cwd });
    if (!mat) return { cmd, env };
    const cmdWithArgs = mat.args.length > 0 ? `${cmd} ${mat.args.join(" ")}` : cmd;
    return { cmd: cmdWithArgs, env: { ...env, ...mat.env } };
  }

  /**
   * spec 226 (H2) — the config home that holds this agent's claude transcripts (`<home>/projects/…`).
   * A harness agent's home is redirected to `.tachyon/harness/<name>` (its CLAUDE_CONFIG_DIR); every
   * other agent uses the OS home's `~/.claude`. The resume/readiness transcript checks must use THIS,
   * or a harness agent's transcript is invisible and resume falsely reports "no transcript".
   */
  private runtimeConfigHome(runtime: ResumeRuntime, name: string, def: AgentDef | undefined): string {
    if (def?.harness || def?.isolate === "transcript") return harnessHome(this.opts.workspaceRoot, name); // spec 226 / 240 / 298
    if (runtime === "codex" && this.opts.materializeHarness) return harnessHome(this.opts.workspaceRoot, name); // spec 357 - default private CODEX_HOME
    const home = (this.opts.homeDir ?? os.homedir)();
    if (runtime === "codex") return path.join(home, ".codex");
    return path.join(home, ".claude");
  }

  private isWrongRuntimeDefaultHome(runtime: ResumeRuntime, configHome: string | undefined): boolean {
    if (!configHome) return false;
    const home = (this.opts.homeDir ?? os.homedir)();
    if (runtime === "codex") return path.resolve(configHome) === path.resolve(path.join(home, ".claude"));
    if (runtime === "claude") return path.resolve(configHome) === path.resolve(path.join(home, ".codex"));
    return false;
  }

  /** spec 240 — the config home a session was written under: the PERSISTED value wins (drift-safe across a
   *  later isolate/harness toggle or rename); derive from today's config only when absent (pre-240 rows). */
  private effectiveHome(name: string, rec: SessionRecord | undefined): string {
    const runtime = rec?.resume?.runtime ?? "claude";
    const persisted = rec?.resume?.configHome;
    return persisted && !this.isWrongRuntimeDefaultHome(runtime, persisted) ? persisted : this.runtimeConfigHome(runtime, name, this.definitionOf(name));
  }

  /** spec 240 — stamp a resume block with its config home, PRESERVING an existing value (never drop it on a
   *  re-write — the invariant against config-home drift). Used at every resume-block write site. */
  private withConfigHome(name: string, def: AgentDef | undefined, resume: SessionResume): SessionResume {
    const keep = resume.configHome && !this.isWrongRuntimeDefaultHome(resume.runtime, resume.configHome);
    return { ...resume, configHome: keep ? resume.configHome : this.runtimeConfigHome(resume.runtime, name, def) };
  }

  /** Spawns a declared agent, or an ad-hoc one when `opts.cmd` is given. No-op error if already running. */
  async spawn(name: string, opts?: SpawnOptions): Promise<void> {
    this.readinessCache.delete(name); // spec 221: a (re)spawn changes the session → drop the cached badge
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    let def = this.definitionOf(name);
    if (opts?.cmd) {
      def = {
        cmd: opts.cmd,
        cwd: opts.cwd,
        instructions: opts.instructions,
        autostart: false,
        watch: [],
        attention: { enabled: true, silenceSec: 8, patterns: [] },
        restart: "never",
        kind: inferKind(opts.cmd),
        // spec 210 — MCP top-level spawn may opt into worktree isolation (uses the default
        // branch tachyon/<name>; ignored for a sub-agent, which inherits the parent's cwd).
        worktree: opts.worktree,
      };
    }
    if (!def) throw new UnknownAgentError(name);

    // spec 230 — a pipeline node appends its task AFTER the declared agent's role/instructions, so the
    // specialist's config (role/harness) is preserved and the task is delivered in the initial prompt.
    if (opts?.appendInstructions) {
      def = { ...def, instructions: [def.instructions, opts.appendInstructions].filter(Boolean).join("\n\n") };
    }

    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) {
      const state = (await this.agentStates()).get(name);
      if (state && state.dead) {
        // Spawning over a crashed agent replaces the dead postmortem pane.
        await this.opts.tmux.killSession(session);
      } else {
        throw new Error(`agent '${name}' is already running`);
      }
    }

    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max);

    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    const adhoc = !!opts?.cmd;
    // Runtime lineage is only for ad-hoc children. A tachyon.yml-declared name is
    // always a top-level managed entry; config subagents are exposed separately as
    // declaredOwner metadata and must not inherit stale ad-hoc-era parents.
    const parent = adhoc && !opts?.gate && opts?.parent && opts.parent !== name ? opts.parent : undefined;
    const delegator = opts?.gate && opts.delegator && opts.delegator !== name ? opts.delegator : undefined;
    // spec 210 — worktree isolation: Workspace resolves the cwd (its own worktree for a
    // top-level opt-in agent, the parent's cwd for a sub-agent, the root on any git
    // problem). Awaited here (off the UI thread); null = keep the default cwd.
    let worktree: WorktreeRecord | undefined;
    let delegationBaseSha: string | undefined;
    if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({ name, def, parent, adhoc, isRestart: false, gate: opts?.gate });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
        delegationBaseSha = resolved.delegationBaseSha;
      }
    }
    if (opts?.gate && !worktree) {
      throw new Error("gated delegation requires an isolated worktree; worktree creation was unavailable");
    }
    // Session-resume bookkeeping (spec 209): mint a session id for runtimes that
    // accept one (claude/gemini). The ORIGINAL cmd is kept for the ledger def +
    // adhoc map; the injected one is only what we spawn.
    const originalCmd = def.cmd;
    // A self-resuming cmd (the user already passed --resume/--continue/--session-id) is run verbatim:
    // we neither mint our own id (claude exits 1 on --session-id + --resume without --fork-session)
    // nor record a resume block (its own cmd resumes on restart). claude name-mints `-n <name>`,
    // gemini uuid-mints `--session-id` (spec 220 — see injectResumeId).
    const injected = this.injectResumeId(name, def);
    def = injected.def;
    const { adapter, resumeId, selfManaged } = injected;
    if (adhoc && adapter?.harness && !selfManaged && !def.harness && def.isolate === undefined) {
      def = { ...def, isolate: "transcript" };
    }
    if (parent && def.kind === "agent" && !def.harness) {
      assertVerifiedTranscriptIsolation(def.cmd, { name, isolatedWorktree: !!worktree });
    }

    // spec 230 — per-spawn env (a pipeline node's TACHYON_* nonce) is merged LAST so it reaches a
    // DECLARED agent too (not just the ad-hoc cmd path) and wins on any collision (codex B1).
    const spawnBuild = this.applyHarness(
      name,
      def,
      cwd,
      this.effectiveCmd(name, def, parent, { delegator, gate: opts?.gate, freshWorktree: !!worktree }),
      { ...this.opts.getExtraEnv?.(), ...this.opts.mintAgentToken?.(name), ...def.env, ...(opts?.env ?? {}), TACHYON_AGENT_NAME: name },
    );
    await this.opts.tmux.newSession({
      name: session,
      cmd: this.withSessionOwnership(name, def, this.withRuntimeBridge(name, def, spawnBuild.cmd), { declared: !adhoc }), // spec 236 Bridge + 243 ownership hook
      cwd,
      env: spawnBuild.env,
    });

    // Persist ONLY after a successful spawn (spec 211: no phantom rows). Record a
    // `def` for every ad-hoc agent (drives restart + lineage, incl. non-AI `sh`);
    // a `resume` block only for adapter-backed runtimes.
    // Record when ad-hoc (restart/lineage), adapter-backed (resume), running in a worktree,
    // OR it has a parent — the worktree case covers a declared terminal/unknown-runtime
    // agent, and `parent` persists a declared non-adapter sub-agent's lineage so the
    // cleanup descendant-guard sees it after a reload (review fixes).
    if (this.opts.ledger && (adhoc || adapter || worktree || parent)) {
      const defBlock = {
        cmd: originalCmd,
        kind: def.kind,
        ...(def.instructions ? { instructions: def.instructions } : {}),
        ...(parent ? { parent } : {}),
        ...(opts?.env ? { env: opts.env } : {}), // spec 230 — persist the node env so a restart re-applies the nonce
        ...(opts?.pipeline ? { pipeline: opts.pipeline } : {}), // spec 230 — pipeline-owned node (planResume skips it)
        ...(opts?.contract ? { contract: opts.contract } : {}), // spec 246 — structured delegation contract (D8)
        ...(opts?.contractSkipReason ? { contractSkipReason: opts.contractSkipReason } : {}), // spec 246 D6 — auditable bypass
      };
      const resumeBlock = adapter && !selfManaged ? this.withConfigHome(name, def, { runtime: adapter.runtime, sessionId: resumeId }) : undefined; // spec 240
      this.opts.ledger.record(name, { def: defBlock, resume: resumeBlock, worktree, cwd, declared: !adhoc });
    }
    if (opts?.gate) {
      if (!opts.contract) throw new Error("gated delegation requires a validated delegation contract");
      if (!worktree) throw new Error("gated delegation requires an isolated worktree");
      this.opts.recordDelegation?.({ name, delegator, gate: opts.gate, contract: opts.contract, worktree, baseSha: delegationBaseSha ?? worktree.baseRef });
    }
    if (adhoc) this.adhoc.set(name, { ...def, cmd: originalCmd });
    if (parent) this.lineage.set(name, parent);
    if (delegator) this.delegators.set(name, delegator);
    this.opts.onSpawned?.(name, opts?.reveal ?? true);
  }

  /**
   * spec 212 / A3 — before tearing a tracked agent down, refresh its ledger resume id to the
   * session its cwd is CURRENTLY in, so an in-TUI `/resume` is followed on the next ↻. Gated:
   * a `resume` block must exist; the cwd must be UNAMBIGUOUS (no other ledger row shares it —
   * a worktree cwd is inherently unique); and it only swaps the stored id for another VALID
   * on-disk id (transcript must exist when derivable). Never nulls a good id; never guesses on
   * a shared cwd. No-op without a ledger or a resolver.
   */
  /**
   * spec 220 — the deterministic claude session NAME for an agent: `tachyon-<workspace>-<agent>`.
   * Spawned via `-n <name>` and matched against the jsonl `customTitle` to capture the real uuid.
   * Sanitized to title-safe chars; the workspace basename keeps names distinct, and the customTitle
   * lookup is itself cwd-scoped so same-basename workspaces at different paths never collide.
   */
  private claudeSessionName(agent: string): string {
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
    return `tachyon-${safe(path.basename(this.opts.workspaceRoot))}-${safe(agent)}`;
  }

  /** spec 220 — a captured claude session id (a real uuid) vs an as-yet-uncaptured spawn NAME. */
  private isUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  /**
   * spec 209/220 — rewrite a mint-runtime def to pin its resume id at spawn: claude gets a
   * deterministic NAME via `-n <name>` (so its transcript carries `customTitle`), gemini a random
   * uuid via `--session-id`. Identity for capture/self-managed runtimes. Used by BOTH spawn and
   * restart so a RESTARTED claude session is named too — otherwise refreshOwnership/resume would match
   * the pre-restart session by title and resume the wrong (old) conversation (codex dueto MAJOR).
   */
  /**
   * spec 236 — the SINGLE place the Tachyon Bridge MCP is injected so EVERY Tachyon-spawned agent reaches
   * `complete_node`/`write_input` with zero workspace-file config. Operates on the FINAL composed command
   * (after effectiveCmd + applyHarness) and is applied identically at spawn + restart + resume:
   *   - harness agent → no-op: the Bridge is folded into its materialized --strict mcp file (mergeServers).
   *   - codex        → idempotent `-c mcp_servers.tachyon_bridge={…}` (token via bearer_token_env_var).
   *   - claude (non-harness) → append `--mcp-config <bridge file>` at the END (additive, no --strict; the
   *     trailing flag avoids claude's variadic --mcp-config swallowing the prompt positional). Token stays
   *     a `${TACHYON_BRIDGE_TOKEN}` ref in the file.
   * No-op when the Bridge URL is absent (self-heals on the next (re)start). Generalizes spec 232 (the
   * pipeline-node gate is dropped — all codex spawns get it via this one call).
   */
  private withRuntimeBridge(name: string, def: Pick<AgentDef, "cmd" | "harness">, cmd: string): string {
    if (def.harness) return cmd; // folded into the materialized --strict mcp file instead
    const url = this.opts.getExtraEnv?.()?.[URL_ENV_VAR];
    if (!url) return cmd;
    const binary = binaryOf(def.cmd);
    if (binary === "codex") return codexBridgeCmd(cmd, url);
    if (binary === "claude") {
      const file = this.opts.materializeBridgeMcp?.(name);
      if (!file) return cmd;
      // A user-supplied --strict-mcp-config makes claude ignore the project/global MCP; our injected file
      // still loads (Bridge works) but the additive-over-project promise is void → advise. --safe-mode
      // disables MCP entirely → injection can't help.
      if (/(^|\s)--strict-mcp-config(=|\s|$)/.test(def.cmd)) {
        this.opts.notify?.(`agent '${name}': its command sets --strict-mcp-config, so only Tachyon's injected Bridge + your --mcp-config files load (the project .mcp.json is ignored)`, "warn");
      }
      if (/(^|\s)--safe-mode(=|\s|$)/.test(def.cmd)) {
        this.opts.notify?.(`agent '${name}': its command sets --safe-mode, which disables MCP — it won't reach the Tachyon Bridge`, "warn");
      }
      return `${cmd} --mcp-config ${shellQuote(file)}`;
    }
    return cmd;
  }

  /**
   * spec 243/303 — inject per-spawn lifecycle hooks so a
   * `/clear`/`/resume` rotation is recorded positively and Activity keeps following it on a shared cwd.
   * Ad-hoc agents are persistence-off by convention, but still receive the ownership-only SessionStart hook
   * so Activity can be attributed without enabling handoff/continuity/stop behavior. Skips:
   *   - self-managed sessions (the user's own `--resume`/`--continue` agents — left untouched, like injectId);
   *   - non-supported runtimes;
   *   - a Claude command that already sets `--settings` (don't fight the user; advise that ownership is off).
   *
   * ADDITIVE, never override: `--settings` is a merge layer — claude unions hook command lists across all active
   * sources (user/project/local + each `--settings`), so for one event ALL run; our SessionStart does NOT replace
   * the user's hooks, and no `~/.claude`/repo `.claude/` file is mutated (verified live; see spec 243 § guarantee
   * + docs/system-design.md §7.1). Harness agents: orthogonal to `--strict-mcp-config` (MCP-only) and the
   * redirected `CLAUDE_CONFIG_DIR`. The only exception is a command that opts into `--setting-sources` (never ours).
   */
  private withSessionOwnership(name: string, def: Pick<AgentDef, "cmd">, cmd: string, opts: { declared: boolean }): string {
    const binary = binaryOf(def.cmd);
    const adapter = adapterFor(def.cmd);
    if (adapter?.mintsId && managesOwnSession(def.cmd)) {
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    const ownershipOnly = !opts.declared;
    if (binary === "codex") {
      const config = this.opts.materializeCodexSessionStartHookConfig?.(name, { ownershipOnly });
      this.opts.onSessionHooksInjected?.(name, !!config);
      if (!config) return cmd;
      const withConfig = codexConfigCmd(cmd, config);
      return ownershipOnly ? codexFlagCmd(withConfig, "--dangerously-bypass-hook-trust") : withConfig;
    }
    if (binary !== "claude") {
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    if (/(^|\s)--settings(=|\s|$)/.test(def.cmd)) {
      this.opts.notify?.(`agent '${name}': its command sets --settings, so Tachyon's session-ownership hook is not injected — its Activity may not follow a /clear on a shared cwd`, "warn");
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    const file = this.opts.materializeOwnershipSettings?.(name, { ownershipOnly });
    this.opts.onSessionHooksInjected?.(name, !!file);
    if (!file) return cmd;
    let out = `${cmd} --settings ${shellQuote(file)}`;
    if (ownershipOnly && !/(^|\s)--permission-mode(=|\s|$)/.test(out) && !/(^|\s)--dangerously-skip-permissions(=|\s|$)/.test(out)) {
      out += " --permission-mode auto";
    }
    return out;
  }

  private injectResumeId(name: string, def: AgentDef): { def: AgentDef; adapter: ResumeAdapter | null; resumeId: string; selfManaged: boolean } {
    const adapter = adapterFor(def.cmd) ?? null;
    const selfManaged = !!adapter?.mintsId && managesOwnSession(def.cmd);
    let resumeId = "";
    if (adapter?.mintsId && this.opts.ledger && !selfManaged) {
      resumeId = adapter.nameMint ? this.claudeSessionName(name) : (this.opts.newSessionId ?? (() => crypto.randomUUID()))();
      def = { ...def, cmd: adapter.injectId(def.cmd, resumeId) };
    }
    return { def, adapter, resumeId, selfManaged };
  }

  private async refreshOwnership(name: string): Promise<void> {
    // Best-effort: the ENTIRE body is guarded so a failed refresh (resolver, fs, or ledger
    // write) can NEVER throw out of kill()/restart() and block the teardown (review fix).
    try {
      const ledger = this.opts.ledger;
      const resolve = this.opts.resolveCurrentSession;
      if (!ledger || !resolve) return;
      const rec = ledger.get(name);
      if (!rec?.resume) return;
      // Normalize the cwd (path.resolve collapses '.', '..', trailing '/') so the ambiguity
      // gate AND the resolver/transcript all key off the same canonical path — two agents at
      // the same physical dir via aliases ('/repo' vs '/repo/.') no longer slip the gate
      // (review fix). Same normalized cwd feeds resolve + transcriptPath for consistency.
      const cwd = path.resolve(rec.cwd);
      // spec 226 (H2) / 240 — the config home this session lives under (persisted wins; derive fallback).
      const configHome = this.effectiveHome(name, rec);
      // spec 240 — two agents are ambiguous only when they share BOTH cwd AND config home (an isolated
      // home gives a distinct transcript namespace, so a same-cwd isolated agent is NOT ambiguous).
      const ambiguous = [...ledger.all()].some(([n, r]) => n !== name && path.resolve(r.cwd) === cwd && this.effectiveHome(n, r) === configHome);
      const adapter = adapterForRuntime(rec.resume.runtime);
      const exists = this.opts.fileExists ?? fs.existsSync;
      let id: string | null;
      // spec 244 — the spec-243 ownership ledger names this agent's CURRENT session exactly (positive, per-agent),
      // so it advances the stored id past a /clear even on a SHARED cwd, where the title resolve below gives up
      // (the new session carries an auto-generated customTitle). Authoritative ONLY after re-validating the
      // transcript under THIS configHome/cwd (codex: don't trust the row's raw path); else fall through.
      const owned = rec.resume.runtime === "claude" ? this.opts.ownedSession?.(name, cwd) : undefined;
      if (owned && adapter?.transcriptPath && exists(adapter.transcriptPath(configHome, cwd, owned.sessionId))) {
        id = owned.sessionId;
      } else if (ambiguous) {
        // Shared cwd: newest-by-cwd can't tell agents apart. Only claude can disambiguate — by the
        // unique customTitle stored as its not-yet-captured sessionId (spec 220). An already-captured
        // uuid, or any non-claude runtime, keeps its stored id (never guess on a shared cwd).
        const title = rec.resume.sessionId;
        if (rec.resume.runtime !== "claude" || !title || this.isUuid(title)) return;
        id = await resolve("claude", cwd, title, configHome);
      } else {
        // Unambiguous cwd: newest-by-cwd follows an in-TUI /resume to a different session for every
        // derivable runtime (spec 212) — including claude (its `-n` session is the newest unless the
        // human switched, in which case we correctly follow the switch).
        id = await resolve(rec.resume.runtime, cwd, undefined, configHome);
      }
      if (!id || id === rec.resume.sessionId) return;
      if (adapter?.transcriptPath && !exists(adapter.transcriptPath(configHome, cwd, id))) return; // don't write a phantom id
      ledger.record(name, { ...rec, resume: this.withConfigHome(name, this.definitionOf(name), { ...rec.resume, sessionId: id }) }); // spec 240
    } catch {
      /* never block Stop/Restart on a best-effort ledger refresh */
    }
  }

  async kill(name: string): Promise<void> {
    this.stoppingSince.delete(name);
    this.readinessCache.delete(name); // spec 221: kill refreshes ownership (sessionId may change) → drop cache
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    await this.refreshOwnership(name); // A3: capture an in-TUI /resume before the session ends
    await this.opts.tmux.killSession(session);
    const wasAdhoc = this.adhoc.has(name);
    // spec 225 — a forked sibling is PERSISTENT: keep its in-memory def AND ledger row across a Stop
    // (so it stays listed + resumable), dropping them only on an explicit Dismiss. The marker is
    // durable (ledger def.fork), so this holds after a window reload too.
    const persistent = this.opts.ledger?.get(name)?.def?.fork === true;
    this.lineage.delete(name); // children of a killed parent are promoted at render time
    if (!persistent) {
      this.adhoc.delete(name); // a killed ad-hoc agent leaves the listing entirely
      // Spec 211: an ad-hoc agent's ledger row must go too, or it resurrects as a
      // permanent stopped entry on the next activation. Declared agents keep their
      // row (still resumable later).
      if (wasAdhoc) {
        // pin p-4dadd3 (dogfood follow-up): kill removes the row AND leaves no pane (killSession, not a
        // remain-on-exit clean-exit dead pane), so the durable log is unreachable — it dies with the row.
        // spec 247: the row+log pair is one named operation now, so this can no longer drift apart.
        this.removeEphemeralFootprint(name);
      }
    }
    this.opts.revokeAgentToken?.(name); // spec 351 — the torn-down session's token is dead too
    this.opts.onKilled?.(name);
  }

  async stopGracefully(name: string): Promise<void> {
    this.readinessCache.delete(name); // same ownership freshness requirement as kill/restart
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    const state = (await this.agentStates()).get(name);
    if (state?.dead) return;
    const stoppingAt = this.stoppingSince.get(name);
    if (stoppingAt !== undefined && Date.now() - stoppingAt < AgentManager.STOPPING_FALLBACK_MS) return;
    this.stoppingSince.set(name, Date.now());
    this.opts.onStopping?.(name);
    try {
      await this.refreshOwnership(name); // capture an in-TUI /resume before asking the process to exit
      const binary = binaryOf(this.definitionOf(name)?.cmd ?? "");
      if (binary === "codex" || binary === "claude") await this.interruptActiveTurn(session);
      // claude's Ctrl+D only exits an idle prompt with an EMPTY composer; a leftover draft
      // (e.g. a queued notify_agent envelope) turns it into a delete-char no-op instead.
      if (binary === "claude") await this.opts.tmux.sendKey(session, "C-c");
      await this.opts.tmux.sendKey(session, "C-d");
      if (binary !== "claude") return;
      await sleep(150);
      const state = (await this.opts.tmux.sessionStates(session))?.get(session);
      if (state && !state.dead) await this.opts.tmux.sendKey(session, "C-d");
    } catch (err) {
      this.stoppingSince.delete(name);
      throw err;
    }
  }

  private async interruptActiveTurn(session: string): Promise<void> {
    let pane = "";
    try {
      pane = await this.opts.tmux.capturePane(session);
    } catch {
      return;
    }
    if (!isCodexTurnActive(pane)) return;
    await this.opts.tmux.sendKey(session, "Escape");
    await sleep(500);
  }

  async dismissCleanExitPane(name: string): Promise<boolean> {
    const session = this.session(name);
    const state = (await this.agentStates()).get(name);
    this.stoppingSince.delete(name);
    if (!state?.dead || state.exitCode !== 0) return false;
    await this.capturePostmortemOutput(name, session);
    await this.opts.tmux.killSession(session);
    this.cleanExited.add(name);
    return true;
  }

  private async capturePostmortemOutput(name: string, session: string): Promise<void> {
    const text = await this.opts.tmux.capturePane(session, AgentManager.POSTMORTEM_MAX_LINES);
    // spec 351 (dueto F8) — redact any Bridge token that leaked into the pane (e.g. a bare `echo $VAR`)
    // BEFORE it's retained; known-secret exact match (the shared token, still held in memory) + syntactic
    // pattern match (env assignment / Bearer header) for any token, including a per-agent one.
    const redacted = redactSecrets(text, this.knownSecretsFromEnv());
    this.postmortemOutput.set(name, this.limitPostmortemText(redacted, AgentManager.POSTMORTEM_MAX_LINES, AgentManager.POSTMORTEM_MAX_BYTES, false));
  }

  /** spec 351 — the plaintext secrets Tachyon still holds (via getExtraEnv) at redaction time; any env
   *  key containing "TOKEN" is treated as a secret to exact-match-redact from captured output. */
  private knownSecretsFromEnv(): string[] {
    const env = this.opts.getExtraEnv?.() ?? {};
    return Object.entries(env)
      .filter(([k]) => k.includes("TOKEN"))
      .map(([, v]) => v)
      .filter((v): v is string => !!v);
  }

  private limitPostmortemText(text: string, maxLines: number, maxBytes: number, alreadyTruncated: boolean): PostmortemOutput {
    const originalText = text;
    const lines = text.split("\n");
    let out = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
    let truncated = alreadyTruncated || out !== originalText;
    if (Buffer.byteLength(out, "utf8") > maxBytes) {
      out = Buffer.from(out, "utf8").subarray(-maxBytes).toString("utf8");
      truncated = true;
    }
    return { text: out, truncated, maxLines, maxBytes };
  }

  postmortemTail(name: string, lines?: number): PostmortemOutput | undefined {
    const rec = this.postmortemOutput.get(name);
    if (!rec) return undefined;
    if (lines === undefined || lines >= rec.maxLines) return rec;
    return this.limitPostmortemText(rec.text, lines, rec.maxBytes, rec.truncated);
  }

  /**
   * Live rename: moves the tmux session (alive or dead pane — attached clients
   * follow it) plus every piece of session-local memory keyed by the old name:
   * ad-hoc definition, lineage (its own parent AND children pointing at it),
   * and the resume-ledger record. The yml definition is the caller's job
   * (declared agents only — ad-hoc ones have nothing in the config).
   */
  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    // spec 226 (v1) — a harness agent's config home is keyed by name (`.tachyon/harness/<name>`) and
    // holds its claude transcripts; a rename would orphan them (resume would scan the new name's empty
    // home, and GC could delete the old one). Block it, fail-closed, until the home is persisted +
    // moved on rename (follow pass) — same posture as the fork block.
    if (this.definitionOf(oldName)?.harness) throw new Error(`cannot rename '${oldName}': renaming an isolated-harness agent isn't supported yet (v1)`);
    if (this.definitionOf(newName)) throw new Error(`agent '${newName}' already exists`);
    const states = await this.agentStates();
    if (states.has(newName)) throw new Error(`a session named '${newName}' already exists`);
    if (states.has(oldName)) {
      await this.opts.tmux.renameSession(this.session(oldName), this.session(newName));
    }

    const def = this.adhoc.get(oldName);
    if (def) {
      this.adhoc.delete(oldName);
      this.adhoc.set(newName, def);
    }
    const parent = this.lineage.get(oldName);
    if (parent) {
      this.lineage.delete(oldName);
      this.lineage.set(newName, parent);
    }
    for (const [child, p] of this.lineage) {
      if (p === oldName) this.lineage.set(child, newName);
    }
    for (const [child, p] of this.delegators) {
      if (p === oldName) this.delegators.set(child, newName);
    }
    if (this.opts.ledger) {
      const rec = this.opts.ledger.get(oldName);
      if (rec) {
        this.opts.ledger.remove(oldName);
        this.opts.ledger.record(newName, rec);
        moveActivityLog(this.activityDir(), oldName, newName);
      }
      // Spec 211: rewrite the persisted parent of every child pointing at oldName,
      // so lineage survives a rename across a restart.
      for (const [child, crec] of this.opts.ledger.all()) {
        if (crec.def?.parent === oldName) {
          this.opts.ledger.record(child, { ...crec, def: { ...crec.def, parent: newName } });
        }
      }
    }
    const postmortem = this.postmortemOutput.get(oldName);
    if (postmortem) {
      this.postmortemOutput.delete(oldName);
      this.postmortemOutput.set(newName, postmortem);
    }
  }

  /** Drop an ad-hoc agent's in-memory def + lineage (spec 211: after promotion to
   *  tachyon.yml, config is authoritative — no lingering ad-hoc shadow). */
  forgetAdhoc(name: string): void {
    this.adhoc.delete(name);
    this.lineage.delete(name);
    this.delegators.delete(name);
  }

  /** The one place that owns the durable activity-log directory (spec 239). */
  private activityDir(): string {
    return path.join(this.opts.workspaceRoot, ".tachyon", "activity");
  }

  /**
   * Remove an EPHEMERAL agent's durable footprint through the canonical forgetAgent()
   * cleanup: ledger row, activity log/state, session-owner rows, private harness home,
   * and per-spawn settings. This is the on-disk counterpart of forgetAdhoc()'s in-memory
   * def+lineage drop — call both for a full forget.
   *
   * EPHEMERAL ONLY: never call for an agent whose log must survive — a declared agent
   * being merely stopped, or a postmortem-viewable clean-exit dead pane (spec 239 keeps
   * those until an explicit dismiss). Callers gate; this helper never inspects `this.adhoc`.
   * Idempotent (ledger.remove on a missing key + force-rm of missing files).
   */
  removeEphemeralFootprint(name: string): void {
    forgetAgent(name, {
      workspaceRoot: this.opts.workspaceRoot,
      ledger: this.opts.ledger,
      removeHarnessHome: this.opts.removeHarnessHome,
    });
  }

  /**
   * Fully forget an ad-hoc agent — in-memory def + lineage AND its persisted
   * ledger row — so a sessionless/finished one won't rehydrate after a reload.
   * (The live dead-pane clean-exit case is auto-handled by list(); this is the
   * explicit user "dismiss" for a stopped row, or a one-shot whose pane vanished
   * before list() observed its exit.) Idempotent.
   */
  dismissAdhoc(name: string): void {
    this.forgetAdhoc(name); // in-memory def + lineage
    // pin p-4dadd3 (a): dismiss is the TRUE end-of-life for an ad-hoc one-shot — the clean-exit dead pane
    // (remain-on-exit) keeps offering "Activity" in postmortem until the user dismisses it, so the durable
    // log must survive until here, then be dropped with the row (it becomes unreachable: no row, no pane).
    // NOT done in list()'s clean-exit ledger-reap (the postmortem pane is still viewable then) and NOT in
    // forgetAdhoc (promotion to a declared tachyon.yml agent KEEPS the log — it's now a persistent agent).
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    this.removeEphemeralFootprint(name); // durable: ledger row + activity log (spec 247)
    this.opts.revokeAgentToken?.(name); // spec 351 — idempotent if kill() already revoked it
    this.opts.onKilled?.(name); // Bridge dismiss needs the same sidebar refresh path as UI dismiss.
  }

  async restart(name: string): Promise<void> {
    this.stoppingSince.delete(name);
    this.readinessCache.delete(name); // spec 221: restart is a new session → drop the cached badge
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    let def = this.definitionOf(name);
    if (!def) {
      throw new Error(
        `cannot restart '${name}': no stored definition (re-discovered ad-hoc agents lose their definition across extension restarts — kill and re-spawn instead)`,
      );
    }
    // Close the old editor terminal up front (synchronously) so onSpawned re-opens a
    // fresh one. Killing the session below would otherwise close it async, racing the
    // re-open into reusing a dead terminal (it'd take a second restart to reappear).
    this.opts.onRestart?.(name);
    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) {
      await this.refreshOwnership(name); // A3: capture an in-TUI /resume before tearing down
      await this.opts.tmux.killSession(session);
    }
    // spec 210 — reuse the existing worktree on restart (isRestart:true → no re-setup).
    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    let worktree: WorktreeRecord | undefined;
    if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({ name, def, parent: this.lineage.get(name), adhoc: this.adhoc.has(name), isRestart: true });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
      }
    }
    // spec 220: re-inject the resume id (claude `-n <name>`) so the RESTARTED session carries the
    // customTitle — else refreshOwnership/resume would match the pre-restart session by title and
    // resume the old conversation. Reset the ledger resume id back to the name so the next
    // refresh/resume re-resolves to the NEWEST title match (the restarted session), not a stale uuid.
    const injected = this.injectResumeId(name, def);
    def = injected.def;
    // spec 363 T3 — restart redelivers the composed instructions (same effectiveCmd path as spawn),
    // so re-attach the gate reminder from the persisted delegation record (gate is display/verify
    // metadata, never stored on the ledger def itself); the worktree is REUSED here, not fresh.
    const restartDelegationRecord = readLatestDelegationRecord(this.opts.workspaceRoot, name)?.record;
    const restartBuild = this.applyHarness(
      name,
      def,
      cwd,
      this.effectiveCmd(name, def, this.lineage.get(name), {
        delegator: this.delegators.get(name),
        gate: restartDelegationRecord
          ? { behaviorTest: restartDelegationRecord.behaviorTest, owns: restartDelegationRecord.owns, stubPath: restartDelegationRecord.stubPath }
          : undefined,
        freshWorktree: false,
      }),
      { ...this.opts.getExtraEnv?.(), ...this.opts.mintAgentToken?.(name), ...def.env, TACHYON_AGENT_NAME: name },
    );
    await this.opts.tmux.newSession({
      name: session,
      cmd: this.withSessionOwnership(name, def, this.withRuntimeBridge(name, def, restartBuild.cmd), { declared: !this.adhoc.has(name) }), // spec 236 Bridge + 243 ownership hook
      cwd,
      env: restartBuild.env,
    });
    // Persist the (re)resolved worktree so cleanup/C2 keep a source of truth even if the
    // prior row was cleared/missing (review fix: restart used to discard the record), and refresh
    // the resume block (reset sessionId → name) for adapter-backed, non-self-managed runtimes.
    if (this.opts.ledger && (worktree || (injected.adapter && !injected.selfManaged))) {
      const existing = this.opts.ledger.get(name);
      const resume = injected.adapter && !injected.selfManaged
        ? // spec 240 — restart mints a FRESH session under the CURRENT derived home, so RE-DERIVE configHome (do
          // NOT preserve): an isolate/harness toggle since the last session must take effect now. (resume() /
          // refreshOwnership still PRESERVE — they re-attach to an EXISTING session, where the old home is right.)
          { ...existing?.resume, runtime: injected.adapter.runtime, sessionId: injected.resumeId, configHome: this.runtimeConfigHome(injected.adapter.runtime, name, def) }
        : existing?.resume;
      this.opts.ledger.record(name, { ...(existing ?? { declared: !this.adhoc.has(name) }), cwd, ...(worktree ? { worktree } : {}), resume });
    }
    this.opts.onSpawned?.(name, true); // restart is a human action — reveal the fresh terminal
  }

  /**
   * spec 221 — would a resume of this record land WITH context? A read-only pre-flight that mirrors
   * resume()'s id-resolution + transcript-exists check WITHOUT spawning, so the sidebar can show an
   * honest "resumable" vs "fresh start" badge. CACHED per agent name, validated by the record's
   * sessionId — so it auto-recomputes when capture upgrades name→uuid, and the sidebar probe stops
   * re-scanning the project dir on every tree refresh (the 565 MB/188-file leak class). Lifecycle
   * changes clear the agent's entry.
   */
  async resumeReadiness(name: string, record: SessionRecord): Promise<boolean> {
    const sid = record.resume?.sessionId ?? "";
    const cached = this.readinessCache.get(name);
    if (cached && cached.sessionId === sid) return cached.ready;
    const ready = await this.computeReadiness(name, record);
    this.readinessCache.set(name, { sessionId: sid, ready });
    return ready;
  }

  private async computeReadiness(name: string, record: SessionRecord): Promise<boolean> {
    if (!record.resume) return false;
    if (!record.def?.cmd) return false; // resume() rejects a record with no command — mirror it, or the badge lies
    const { runtime } = record.resume;
    const adapter = adapterForRuntime(runtime);
    if (!adapter) return false;
    if (adapter.resumesWithoutId) return true; // qwen --continue resumes the cwd's last session
    const cwd = path.resolve(record.cwd);
    const configHome = this.effectiveHome(name, record); // spec 226 (H2) / 240 — persisted home wins
    const exists = this.opts.fileExists ?? fs.existsSync;
    // spec 244 — mirror resume()'s target resolution: if the spec-243 ownership ledger points at a live owned
    // session, the badge must read READY (else a crash that left the stored id stale shows "fresh start" while
    // Resume would in fact reopen the owned session — codex). Owner-first, transcript-validated under this home.
    const owned = this.opts.ownedSession?.(name, cwd);
    if (owned && exists(owned.transcriptPath)) return true;
    let id = record.resume.sessionId;
    if (runtime === "claude" && this.opts.resolveCurrentSession && id && !this.isUuid(id)) {
      id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? id;
    }
    if (!id) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    if (!id) return false;
    if (adapter.transcriptPath) {
      return exists(adapter.transcriptPath(configHome, cwd, id));
    }
    return true; // capture runtime with an id but no derivable path — resume attempts it
  }

  /**
   * spec 238 — resolve the on-disk transcript for an agent's CURRENT session, for the activity view to
   * tail. Mirrors the resume id-resolution (claude name→uuid, capture fallback) but NEVER spawns. Returns
   * the path + runtime when a transcript file exists, else undefined (the view then degrades to the
   * raw-only/terminal escape hatch). Capture runtimes whose transcript path is not derivable from the id
   * use `resolveCaptureSession` when implemented (v1: codex).
   */
  async transcriptPathOf(name: string, opts: { live?: boolean } = {}): Promise<{ path: string; runtime: ResumeRuntime } | undefined> {
    const ledger = this.opts.ledger;
    const record = ledger?.get(name);
    if (!record?.resume) return undefined;
    const { runtime } = record.resume;
    const adapter = adapterForRuntime(runtime);
    if (!adapter) return undefined;
    const canResolvePath = !!adapter.transcriptPath || !!this.opts.resolveCaptureSession;
    if (!canResolvePath) return undefined;
    const cwd = path.resolve(record.cwd);
    const configHome = this.effectiveHome(name, record); // spec 226 (H2) / 240 — persisted home wins
    // spec 240 — only agents sharing BOTH cwd AND config home are ambiguous; an isolated home is its own
    // transcript namespace, so a same-cwd isolated agent is unambiguous (newest-by-cwd safely follows it).
    const shared = !!ledger && [...ledger.all()].some(([n, r]) => n !== name && path.resolve(r.cwd) === cwd && this.effectiveHome(n, r) === configHome);
    // spec 243 — POSITIVE attribution first: the ownership ledger (written by the per-spawn SessionStart
    // hook) names this agent's CURRENT session exactly, so a live tail follows a `/clear`/`/resume`
    // rotation even on a SHARED cwd — where no disk-only guess is safe. Authoritative when a row exists and
    // its transcript is present; otherwise fall through to the title/captured-uuid resolution below.
    if (opts.live && this.opts.ownedSession) {
      const owned = this.opts.ownedSession(name, cwd);
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (owned && exists(owned.transcriptPath)) return { path: owned.transcriptPath, runtime };
    }
    let id = record.resume.sessionId;
    if (runtime === "claude" && this.opts.resolveCurrentSession) {
      if (id && !this.isUuid(id)) {
        // Not yet captured → resolve the real uuid by the unique stored title.
        id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? id;
      } else if (opts.live && !shared) {
        // Live panel on an unambiguous cwd → follow the CURRENT (newest) session, incl. an in-TUI /resume
        // switch to a different transcript (the captured uuid alone would pin us to the old file forever).
        id = (await this.opts.resolveCurrentSession(runtime, cwd, undefined, configHome)) ?? id;
      }
    }
    if (runtime === "codex") {
      const exists = this.opts.fileExists ?? fs.existsSync;
      const resolve = this.opts.resolveCaptureSession;
      if (id) {
        const loc = await resolve?.(runtime, cwd, configHome, id);
        if (loc && exists(loc.path)) return { path: loc.path, runtime };
      }
      if (opts.live && !shared) {
        const loc = await resolve?.(runtime, cwd, configHome);
        if (loc && exists(loc.path)) return { path: loc.path, runtime };
      }
      // Shared cwd with no authoritative row/path is an attribution gap, never a newest-by-cwd guess.
      return undefined;
    }
    // The bare cwd-scan ("newest in this dir") is the ONLY ambiguous fallback — on a SHARED cwd it could
    // return another agent's session, so skip it there (return undefined → caller treats as a gap). A captured
    // uuid or a unique-title resolve above is safe on shared cwd; this guards only the id-less case.
    if (!id && !shared) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    if (!id) return undefined;
    if (!adapter.transcriptPath) return undefined;
    const p = adapter.transcriptPath(configHome, cwd, id);
    const exists = this.opts.fileExists ?? fs.existsSync;
    return exists(p) ? { path: p, runtime } : undefined;
  }

  /**
   * Respawns an agent from a ledger record with the runtime's resume command, so it
   * recovers its prior conversation (spec 209). For capture runtimes with no stored
   * id, resolves it from disk by cwd. Throws ResumeUnavailableError when the id can't
   * be resolved or the transcript is gone — the caller falls back to a fresh spawn.
   */
  async resume(name: string, record: SessionRecord): Promise<void> {
    this.readinessCache.delete(name); // spec 221: resuming changes the session → drop the cached badge
    if (!record.resume) throw new ResumeUnavailableError(name, "record is not resumable (no resume block)");
    const { runtime } = record.resume;
    const cmd = record.def?.cmd;
    if (!cmd) throw new ResumeUnavailableError(name, "record has no command to resume");
    const adapter = adapterForRuntime(runtime);
    if (!adapter) throw new ResumeUnavailableError(name, `no resume adapter for '${runtime}'`);

    // Canonicalize the cwd (A3 review fix): refreshOwnership keys the resolver/transcript on
    // path.resolve(cwd), so resume must too, or an aliased stored cwd ('/repo/.') would encode
    // a different project dir here and read the transcript as missing. One canonical cwd for
    // resolveCaptureId, the transcript check, and the spawn.
    const cwd = path.resolve(record.cwd);
    // spec 226 (H2) / 240 — scan the home this session lives under (persisted wins; derive fallback), so a
    // harness/isolate agent's transcript is found, not ~/.claude.
    const configHome = this.effectiveHome(name, record);
    // spec 244 — prefer the spec-243 ownership ledger: it names this agent's CURRENT session, so a stop→resume
    // (or a crash that skipped refreshOwnership) reopens the post-/clear session instead of the stale stored uuid,
    // even on a shared cwd. Authoritative ONLY when the owned transcript exists under THIS configHome/cwd (codex);
    // else fall back to the existing stored-id resolution exactly as before (no regression on a gone transcript).
    const existsFn = this.opts.fileExists ?? fs.existsSync;
    const owned = this.opts.ownedSession?.(name, cwd);
    let id: string;
    if (owned && existsFn(owned.transcriptPath)) {
      id = owned.sessionId;
    } else {
      id = record.resume.sessionId;
      // spec 220: a claude id that is still a NAME (not a captured uuid) means no Stop→refreshOwnership
      // ran — a CRASH, a Resume right after reload, OR a RENAME (the stored title is the on-disk
      // customTitle; recomputing from the new name would miss it). `<name>.jsonl` doesn't exist (the
      // transcript is named by claude's uuid), so resolve the real uuid by matching that exact stored
      // title, making the transcript check + resume target the actual session instead of falling fresh.
      if (runtime === "claude" && this.opts.resolveCurrentSession && id && !this.isUuid(id)) {
        id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? id;
      }
      if (!id) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    }
    // qwen (resumesWithoutId) resumes the last session for its cwd via --continue,
    // so an empty id is fine; every other runtime needs a concrete id.
    if (!id && !adapter.resumesWithoutId) throw new ResumeUnavailableError(name, "no session id (capture runtime not resolved)");

    if (id && adapter.transcriptPath) {
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (!exists(adapter.transcriptPath(configHome, cwd, id))) {
        throw new ResumeUnavailableError(name, "transcript no longer on disk (retention/deleted)");
      }
    }

    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) await this.opts.tmux.killSession(session);
    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max);

    // Re-apply the declared agent's env on resume (spec 211 review fix) — spawn/restart include
    // def.env, but resume previously injected only bridge env, silently dropping e.g. an
    // ANTHROPIC_BASE_URL model-swap. definitionOf = config (declared) or adhoc def. spec 226 (H3):
    // also re-apply the isolated-harness wiring so a resumed harness agent stays scoped.
    const resumeDef = this.definitionOf(name);
    const resumeBuild = this.applyHarness(name, resumeDef, cwd, adapter.resumeCommand(cmd, id), { ...this.opts.getExtraEnv?.(), ...this.opts.mintAgentToken?.(name), ...resumeDef?.env, TACHYON_AGENT_NAME: name });
    await this.opts.tmux.newSession({
      name: session,
      // spec 236 (BLOCKER fix) — resume rebuilds the command, so it must re-inject the Bridge or a resumed
      // agent silently loses it. Classify the binary from the ACTUALLY-resumed `cmd` (record.def.cmd) so an
      // ad-hoc agent that's no longer in the config still gets it; harness routing comes from the config
      // overlay (resumeDef) so a harness agent folds the Bridge into its --strict file instead.
      cmd: this.withSessionOwnership(name, { cmd }, this.withRuntimeBridge(name, { cmd, harness: resumeDef?.harness }, resumeBuild.cmd), { declared: record.declared }),
      cwd,
      env: resumeBuild.env,
    });
    this.opts.ledger?.record(name, { ...record, resume: this.withConfigHome(name, this.definitionOf(name), { ...record.resume, runtime, sessionId: id }) }); // spec 240 — preserve persisted configHome
    this.opts.onSpawned?.(name, true); // resume is activation/human-driven — reveal

    // spec 363 T3 — resume doesn't recompose def.instructions (the transcript already carries the
    // original brief), but the primer is re-delivered anyway (spec.md: "always the full compact
    // primer" at all four moments) — typed into the freshly-resumed pane, mirroring re-anchor's
    // sendKeys pattern (Workspace.reanchor). Advisory/best-effort: never blocks a resume.
    const resumeDelegationRecord = readLatestDelegationRecord(this.opts.workspaceRoot, name)?.record;
    const { primer, beforeFinishing } = renderPrimer({
      agentName: name,
      delegator: this.delegators.get(name),
      parent: this.lineage.get(name),
      gate: resumeDelegationRecord
        ? { behaviorTest: resumeDelegationRecord.behaviorTest, owns: resumeDelegationRecord.owns, stubPath: resumeDelegationRecord.stubPath }
        : undefined,
      freshWorktree: false,
      verify: this.opts.getConfig()?.settings.verify,
    });
    await this.opts.tmux.sendKeys(session, `${primer}\n\n${beforeFinishing}`, true);
  }

  /** All names that already exist anywhere (config / ledger / ad-hoc memory / live tmux) — for fork-name uniqueness. */
  private async allKnownNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const n of Object.keys(this.opts.getConfig()?.agents ?? {})) names.add(n);
    for (const n of this.opts.ledger?.all().keys() ?? []) names.add(n);
    for (const n of this.adhoc.keys()) names.add(n);
    for (const n of (await this.agentStates()).keys()) names.add(n);
    return names;
  }

  /** First free `<source>-fork-N` (N≥1) not already taken. Pure given the taken set. */
  private uniqueForkName(source: string, taken: Set<string>): string {
    for (let n = 1; ; n++) {
      const candidate = `${source}-fork-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * spec 225 — fail-closed resolve of the source's CURRENT, LIVE fork inputs (id/cwd/worktree/cmd),
   * with NO side effects. Throws ForkUnavailableError on any blocker (no tracked session, non-native
   * runtime, self-managed cmd, not running, unresolvable live uuid, transcript gone). Called by BOTH
   * planFork (for the confirm) and commitFork (RE-resolved at spawn time) — so a stale confirm modal
   * can never fork an old session after the source restarted/switched (codex dueto round-2).
   */
  private async resolveForkSource(name: string): Promise<{
    runtime: ResumeRuntime;
    adapter: ResumeAdapter;
    baseCmd: string;
    sourceCwd: string;
    sourceId: string;
    sourceWorktree?: WorktreeRecord;
    instructions?: string;
    env?: Record<string, string>;
  }> {
    const ledger = this.opts.ledger;
    if (!ledger) throw new ForkUnavailableError(name, "the session ledger is disabled");
    const rec = ledger.get(name);
    if (!rec?.resume) throw new ForkUnavailableError(name, "it has no tracked session to fork");
    const { runtime } = rec.resume;
    const adapter = adapterForRuntime(runtime);
    if (!adapter || !forkable(adapter)) throw new ForkUnavailableError(name, `'${runtime}' has no native session fork — fork is claude-only today`);
    const baseCmd = rec.def?.cmd;
    if (!baseCmd) throw new ForkUnavailableError(name, "no base command recorded to fork");
    // spec 226 (v1) — forking an isolated-harness agent isn't supported yet: the fork would need its
    // OWN config home plus a cross-config-home transcript seed. Block it honestly rather than spawn a
    // fork that silently loses the harness's MCP isolation (fail-closed, H9). Follow-pass.
    if (this.definitionOf(name)?.harness) throw new ForkUnavailableError(name, "forking an isolated-harness agent isn't supported yet (v1)");
    // A self-managing cmd (its own --resume/--continue) has no Tachyon-tracked id to fork, and
    // injectId/forkCommand would compose a malformed double-resume — refuse (codex dueto MINOR).
    if (managesOwnSession(baseCmd)) throw new ForkUnavailableError(name, "it manages its own session (a --resume/--continue command) — nothing for Tachyon to fork");
    // Fork captures a LIVE session "up to now" — refuse a stale/stopped one (resume it first). The UI
    // already gates on running, but the manager API must not fork an old ledger session (codex dueto MAJOR).
    if (!(await this.runningAgents()).includes(name)) throw new ForkUnavailableError(name, "it isn't running — fork captures a live session; resume it first");

    // Fail-closed resolve of the source's CURRENT live id (a real uuid). For claude a not-yet-captured
    // id is the spawn NAME (customTitle); resolve it by title in the source cwd (spec 220). Never guess.
    const cwd = path.resolve(rec.cwd);
    // spec 226 — a harness source is already blocked above; derive the runtime home for resolver parity.
    const configHome = this.runtimeConfigHome(runtime, name, this.definitionOf(name));
    let id = rec.resume.sessionId;
    if (runtime === "claude" && this.opts.resolveCurrentSession && id && !this.isUuid(id)) {
      id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? "";
    }
    if (!id) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    if (!this.isUuid(id)) {
      throw new ForkUnavailableError(name, "not forkable yet — send it a message first (a fork needs at least one conversation turn to carry context)");
    }
    // The transcript must be on disk to fork from it (mirror resume's guard).
    if (adapter.transcriptPath) {
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (!exists(adapter.transcriptPath(configHome, cwd, id))) {
        throw new ForkUnavailableError(name, "its session transcript is no longer on disk");
      }
    }
    return {
      runtime,
      adapter,
      baseCmd,
      sourceCwd: cwd,
      sourceId: id,
      ...(rec.worktree ? { sourceWorktree: rec.worktree } : {}),
      ...(rec.def?.instructions ? { instructions: rec.def.instructions } : {}),
      ...(this.definitionOf(name)?.env ? { env: this.definitionOf(name)!.env } : {}),
    };
  }

  /**
   * spec 225 — resolve everything needed to fork `name` into a sibling, WITHOUT any side effect
   * (no worktree create, no spawn), so the UI can confirm the fork name + base + dirty warning first.
   * Fail-closed via resolveForkSource. NOTE: commitFork RE-resolves at spawn time, so the id/cwd here
   * are advisory display values — the actual fork always targets the source's CURRENT live session.
   */
  async planFork(name: string): Promise<ForkPlan> {
    const src = await this.resolveForkSource(name);
    const forkName = this.uniqueForkName(name, await this.allKnownNames());
    const dirty = src.sourceWorktree && this.opts.worktreeDirty ? await this.opts.worktreeDirty(src.sourceWorktree).catch(() => false) : false;
    return {
      source: name,
      forkName,
      sourceId: src.sourceId,
      sourceCwd: src.sourceCwd,
      baseCmd: src.baseCmd,
      runtime: src.runtime,
      ...(src.instructions ? { instructions: src.instructions } : {}),
      ...(src.sourceWorktree ? { sourceWorktree: src.sourceWorktree } : {}),
      dirty,
    };
  }

  /**
   * spec 225 — execute a ForkPlan: (worktree source → its own new worktree off committed HEAD + seed
   * the transcript into that cwd's project dir; non-worktree → share the source cwd) then spawn the
   * sibling `claude -n <fork-name> --resume <sourceId> --fork-session`. Records a PERSISTENT sibling
   * ledger row (base cmd + the fork's own name + fork:true, NO parent lineage). Returns the fork name.
   */
  async commitFork(plan: ForkPlan): Promise<string> {
    const source = plan.source;
    // RE-RESOLVE the source's CURRENT live inputs at spawn time (codex dueto round-2 MAJOR): the plan +
    // confirm modal may be stale — the source could have restarted or switched sessions while the modal
    // sat open, so trusting plan.sourceId/cwd/worktree would fork an OLD transcript. resolveForkSource
    // also re-asserts the fail-closed gates (running, native, uuid, transcript on disk).
    const src = await this.resolveForkSource(source);
    const { adapter } = src;
    if (!adapter.forkCommand) throw new ForkUnavailableError(source, `'${src.runtime}' has no native session fork`);

    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max); // gate BEFORE any side effect (no orphan worktree)
    // Re-derive a fresh unique name so two concurrent/stale confirmations can't both claim the same one.
    const forkName = this.uniqueForkName(source, await this.allKnownNames());
    this.readinessCache.delete(forkName);

    // cwd: a worktree source gets its OWN new worktree (decoupled); a non-worktree source shares the
    // source's cwd (same project dir → claude --resume carries context with no copy).
    let cwd = src.sourceCwd;
    let worktree: WorktreeRecord | undefined;
    if (src.sourceWorktree) {
      const created = this.opts.createForkWorktree ? await this.opts.createForkWorktree(forkName, src.sourceWorktree) : null;
      // Fail-closed: a worktree source REQUIRES its own worktree (locked decision). Never fall back to
      // the workspace root — a different cwd's project dir wouldn't hold the source transcript and
      // claude --resume would come up empty (cwd-scoped, verified live 2026-06-16).
      if (!created) throw new ForkUnavailableError(source, "couldn't create the fork's worktree (git unavailable or branch conflict)");
      cwd = created.cwd;
      worktree = created.worktree;
    }

    // From here a fresh worktree may exist + a session may be spawned — any failure must undo BOTH,
    // so a half-built fork never leaks an orphan worktree or a session with no ledger row (dueto MAJOR).
    let spawnedSession: string | undefined;
    try {
      // Worktree fork → seed the source transcript into the new cwd's project dir (claude --resume is
      // cwd-scoped). FAIL CLOSED: if the seed can't land, abort rather than spawn a context-less fork.
      if (worktree && adapter.transcriptPath && path.resolve(cwd) !== path.resolve(src.sourceCwd)) {
        // spec 226 — a harness source is blocked from fork; this source's transcripts are under ~/.claude.
        const configHome = path.join((this.opts.homeDir ?? os.homedir)(), ".claude");
        const seeded = (this.opts.seedTranscript ?? defaultSeedTranscript)(
          adapter.transcriptPath(configHome, src.sourceCwd, src.sourceId),
          adapter.transcriptPath(configHome, cwd, src.sourceId),
        );
        if (!seeded) throw new ForkUnavailableError(source, "couldn't seed the session transcript into the fork's worktree (claude --resume would find nothing)");
      }

      // -n <fork's OWN name> so its NEW session carries a distinct customTitle (spec-220 capture),
      // then --resume <sourceId> --fork-session. Verified live: `claude -n B --resume A --fork-session`.
      const forkClaudeName = this.claudeSessionName(forkName);
      const forkCmd = adapter.forkCommand(adapter.injectId(src.baseCmd, forkClaudeName), src.sourceId);
      const session = this.session(forkName);
      await this.opts.tmux.newSession({
        name: session,
        // spec 236 — a fork is a Tachyon-spawned agent too; inject the Bridge (claude-only + non-harness:
        // a harness source is blocked from fork, so this is always the non-harness --mcp-config append).
        cmd: this.withRuntimeBridge(forkName, { cmd: src.baseCmd }, forkCmd),
        cwd,
        env: { ...this.opts.getExtraEnv?.(), ...this.opts.mintAgentToken?.(forkName), ...src.env, TACHYON_AGENT_NAME: forkName },
      });
      spawnedSession = session;

      // Persistent SIBLING row: base cmd (a later resume uses the normal named path, never re-forks),
      // resume keyed to the fork's OWN name (captured → uuid by spec 220), NO parent lineage, fork:true.
      // The source's env is persisted so a restart/resume of the fork keeps it (dueto round-2: a
      // GLM/model-swap ANTHROPIC_BASE_URL must survive, not silently drop).
      this.opts.ledger?.record(forkName, {
        def: { cmd: src.baseCmd, kind: "agent", ...(src.instructions ? { instructions: src.instructions } : {}), ...(src.env ? { env: src.env } : {}), fork: true },
        resume: this.withConfigHome(forkName, undefined, { runtime: src.runtime, sessionId: forkClaudeName }), // spec 240 (fork = own cwd, ~/.claude)

        ...(worktree ? { worktree } : {}),
        cwd,
        declared: false,
      });
    } catch (err) {
      // Roll back, best-effort, in reverse order: kill the spawned session, then remove the worktree.
      if (spawnedSession) await this.opts.tmux.killSession(spawnedSession).catch(() => undefined);
      if (worktree && this.opts.removeForkWorktree) await this.opts.removeForkWorktree(worktree).catch(() => undefined);
      throw err;
    }
    this.adhoc.set(forkName, {
      cmd: src.baseCmd,
      instructions: src.instructions,
      ...(src.env ? { env: src.env } : {}),
      autostart: false,
      watch: [],
      attention: { enabled: true, silenceSec: 8, patterns: [] },
      restart: "never",
      kind: "agent",
      worktree: !!worktree,
    });
    this.opts.onSpawned?.(forkName, true);
    return forkName;
  }

  /** Kills every session of this workspace — alive agents and crashed postmortem panes alike. */
  async killAll(): Promise<string[]> {
    const all = [...(await this.agentStates()).keys()];
    for (const name of all) {
      await this.opts.tmux.killSession(this.session(name));
      this.lineage.delete(name);
      this.adhoc.delete(name);
      this.opts.onKilled?.(name);
    }
    return all;
  }

  /**
   * Declared autostart agents with no session at all (the activation spawn set).
   * Crashed agents are excluded — replacing their dead pane would erase the
   * postmortem; the restart policy or the human decides that.
   */
  async autostartPending(): Promise<string[]> {
    const config = this.opts.getConfig();
    if (!config) return [];
    const present = new Set((await this.agentStates()).keys());
    return Object.entries(config.agents)
      .filter(([name, def]) => def.autostart && !present.has(name))
      .map(([name]) => name);
  }
}

/**
 * spec 225 — default transcript seeder: copy `from`→`to` so a fork in a NEW worktree cwd can resume
 * the source session (claude --resume is cwd/project-dir-scoped). Best-effort — a failed copy degrades
 * to a fresh fork rather than throwing out of commitFork (planFork already verified `from` is on disk).
 */
function defaultSeedTranscript(from: string, to: string): boolean {
  try {
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return fs.existsSync(to); // verify it actually landed — commitFork fails closed on false
  } catch {
    return false;
  }
}

function resolveCwd(workspaceRoot: string, cwd?: string): string {
  // path.resolve canonicalizes ('.', '..', trailing '/') so every cwd recorded in the
  // ledger is in one form — the A3 ownership refresh, resume's transcript check, and the
  // capture resolvers all key off the same string (review fix).
  if (!cwd) return path.resolve(workspaceRoot);
  if (cwd.startsWith("/")) return path.resolve(cwd);
  return path.resolve(workspaceRoot, cwd);
}

/**
 * Debounced restart-on-file-change. The watcher primitive is injected so this stays
 * testable outside the VSCode host (the extension wires vscode.FileSystemWatcher).
 */
export class WatchController {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: Array<() => void> = [];

  constructor(
    private readonly restart: (agent: string) => Promise<void>,
    private readonly debounceMs = 500,
  ) {}

  /** Registers a change-event source for an agent; returns the controller for chaining. */
  watch(agent: string, subscribe: (onChange: () => void) => () => void): this {
    const dispose = subscribe(() => this.onChange(agent));
    this.disposables.push(dispose);
    return this;
  }

  onChange(agent: string): void {
    const existing = this.timers.get(agent);
    if (existing) clearTimeout(existing);
    this.timers.set(
      agent,
      setTimeout(() => {
        this.timers.delete(agent);
        void this.restart(agent);
      }, this.debounceMs),
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
  }
}
