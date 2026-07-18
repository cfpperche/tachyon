import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexConfigCmd, composeCommand, codexBridgeCmd, shellQuote, inferKind, instructionsDeliverable, type AgentDef, type EntryKind, type TachyonConfig } from "../config/loadConfig.js";
import { applyManagedHookTrust, managedHookRuntimeOf } from "./managedHookTrust.js";
import { TmuxService, sessionName, agentFromSession, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { adapterFor, adapterForRuntime, binaryOf, forkable, managesOwnSession, type ResumeAdapter, type ResumeRuntime } from "../resume/adapters.js";
import { URL_ENV_VAR } from "../bridge/token.js";
import { redactSecrets } from "../bridge/redact.js";
import { resolveBase as resolveWorktreeBase, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { defaultRealOpencodeDataHome, harnessHome, type MaterializedHarness } from "../harness/HarnessManager.js";
import {
  hasDeliveryMarker,
  isInvalidDeliveryMarker,
  isValidDeliveryBinding,
  type SessionDeliveryBinding,
  type SessionLedger,
  type SessionRecord,
  type SessionResume,
} from "../resume/SessionLedger.js";
import { moveActivityLog } from "../activity/logStore.js";
import type { DelegationGate, SpawnContract } from "../bridge/spawnContract.js";
import type { ResolvedCaptureSession } from "../resume/resolvers.js";
import { assertVerifiedTranscriptIsolation, gracefulStopForCommand, isolationMechanismForCommand, opencodeIsolationFootgunWarning, runtimeProfile } from "../runtime/runtimeProfile.js";
import { forgetAgent } from "./forgetAgent.js";
import { ensurePaneTranscriptFile, rotatePaneTranscriptIfNeeded } from "./paneTranscript.js";
import { wrapWithPrimer, renderPrimer } from "../bridge/primer.js";
import { delegatedOpencodePermission, setOpencodePermission } from "../registration/adapters.js";
import { assertSafeBriefTransport, deliverableBody, previewDeliverableBody } from "./briefFile.js";
import {
  agentMemoryScopeSupport,
  agentMemoryScopeUnitName,
  parseAgentMemoryMax,
  wrapAgentMemoryScopeCommand,
} from "./agentMemoryScope.js";
import {
  hasExplicitModelSelection,
  isExplicitCodexModelCommand,
  parseLaunchCommand,
  RuntimeLaunchPreflightError,
  RuntimeLaunchPreflightRegistry,
  type RuntimeLaunchPreflightPort,
} from "../runtime/launchPreflight.js";
import { CodexLaunchPreflight } from "../runtime/adapters/codexLaunchPreflight.js";
import {
  CodexLaunchReadiness,
  matchCodexBootstrapInput,
  type CodexBootstrapInputMatch,
} from "../runtime/adapters/codexLaunchReadiness.js";
import { GenericLaunchReadiness, LaunchReadiness, RuntimeLaunchReadinessError, type LaunchReadinessPort, type RuntimeLaunchReadinessAdapter } from "../runtime/launchReadiness.js";
import { loadAndRenderProjectGuidance } from "../config/projectGuidance.js";
import { openingPromptCapability } from "./openingPromptCapability.js";
import { cleanupStaleSoulLaunchReservationsSync, ensureSoulLaunchReservationsDirSync, SOUL_LAUNCH_RESERVATION_BOOT_ID, SoulError, resolveSoul, resolveSoulWithRetry, withSoulProfileAdmission, type ResolvedSoul } from "./soul.js";
import { principalBlockedByProfileTransaction } from "./soulProfileTransactions.js";
import { composeAgentPrompt, type SoulSnapshot } from "./promptLayers.js";
import type { CanonicalDeliverySpawnReceipt } from "../delivery/types.js";

/** t-815796 MEDIUM fix — is `pid` still alive? `process.kill(pid, 0)` sends no signal, only probes.
 *  ESRCH is the one unambiguous "gone" answer; any other error (e.g. EPERM — exists, owned by someone
 *  else) is treated as "still alive" so the cleanup probe never frees a worktree it isn't sure about. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

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
const LAUNCH_READINESS_RUNTIMES = new Set<ResumeRuntime>(["codex", "claude", "grok"]);

/** spec 236 — opencode honors this env var pointing at a config file (verified on 1.17.15). Tachyon
 *  sets it to the per-agent Bridge-only opencode config file it materializes, so a Tachyon-spawned
 *  opencode agent sees the Bridge MCP with zero workspace-file config of its own. */
const OPENCODE_CONFIG_ENV_VAR = "OPENCODE_CONFIG";

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

/**
 * Rebind-only view of generic resume readiness.  Unlike the cached sidebar boolean, this result
 * distinguishes a target that may still appear from a structural/authority denial that must never
 * cross the rebind teardown boundary.
 */
export type RebindResumeReadiness =
  | { kind: "ready" }
  | { kind: "retry"; reason: string }
  | { kind: "denied"; reason: string };

/** spec 389 — how restart stops a live pane before (or while) replacing it. */
export type RestartStopMode = "graceful" | "force";
/** spec 389 — whether restart reopens the prior conversation or mints a new section. */
export type RestartSessionMode = "resume" | "new";

/**
 * Product defaults for operator/Bridge restart when callers omit modes.
 * Crash auto-restart, file-watch restart, and historical force-replace tests pass force+new explicitly.
 */
export const RESTART_DEFAULTS = {
  stop: "graceful" as RestartStopMode,
  session: "resume" as RestartSessionMode,
};

/** Explicit force + new section — crash recovery, watch rebuild, and pre-389 replace semantics. */
export const RESTART_FORCE_NEW = {
  stop: "force" as RestartStopMode,
  session: "new" as RestartSessionMode,
};

export interface RestartOptions {
  /** Default: graceful. Force replaces the process immediately (no stop handshake). */
  stop?: RestartStopMode;
  /** Default: resume. Falls back to a new section when resume is unavailable. */
  session?: RestartSessionMode;
  /** Graceful wait budget before session-only hard kill. Default STOPPING_FALLBACK_MS. */
  gracefulTimeoutMs?: number;
}

export interface RestartResult {
  stop: RestartStopMode;
  session: RestartSessionMode;
  /** True when the start phase actually resumed a prior session. */
  resumed: boolean;
  /** True when graceful stop timed out and a session-only hard kill ran. */
  forcedAfterGracefulTimeout: boolean;
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
  /** graceful Stop timed out while the pane stayed alive; retry is allowed */
  stopFailed?: boolean;
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

export interface DeliveryJoinRequest {
  deliveryId: string;
  role: "implementer" | "reviewer" | "fixer" | "recovery";
  ownsSubset: string[];
  expectedHead: string;
  principal?: string;
  /** A declared definition used for a distinct, ephemeral Delivery execution. */
  declaredAgent?: string;
  operationId: string;
}

/** A receipt is deliberately local to one Delivery launch.  A name is not cleanup authority. */
interface DeliveryLaunchAttempt {
  /** Closed at acquisition: cleanup must never re-infer ownership from mutable maps. */
  readonly mode: "bound-ephemeral" | "cmd-adhoc-ephemeral" | "declared";
  acquired: boolean;
  token: boolean;
  materialized: "not-started" | "attempted" | "completed";
  session: "not-started" | "attempted" | "completed";
  ledger: boolean;
}

function deliveryDefinitionSnapshot(source: AgentDef): AgentDef {
  const clone = structuredClone(source) as AgentDef;
  return {
    ...clone, autostart: false, restart: "never", kind: "agent",
    ...("cwd" in clone ? { cwd: undefined } : {}),
    ...("worktree" in clone ? { worktree: undefined } : {}),
    ...("branch" in clone ? { branch: undefined } : {}),
    ...("worktreeSetup" in clone ? { worktreeSetup: undefined } : {}),
    ...("verify" in clone ? { verify: undefined } : {}),
    ...("subagents" in clone ? { subagents: undefined } : {}),
  };
}

export interface PreparedDeliveryJoin {
  cwd: string;
  worktree: WorktreeRecord;
  reservationNonce: string;
  /** SDD 368 T14 — reserved segment id from the pending lease; required for reverse binding. */
  segmentId: string;
}

/**
 * Hermes surfaces that cannot consume HERMES_TUI_QUERY as a managed startup brief.
 * argv is the parseLaunchCommand argv (binary path as argv[0]).
 */
function hermesBriefIncompatibleArg(argv: string[]): string | undefined {
  // Known Hermes CLI subcommands / non-TUI modes. Bare `hermes` (possibly with TUI-safe flags)
  // is the supported managed brief launch shape.
  // parseLaunchCommand.argv is post-binary (e.g. ["--cli"] or ["chat","-q","hi"]).
  const SUBCOMMANDS = new Set([
    "chat", "gateway", "model", "auth", "config", "doctor", "setup", "tools", "skills",
    "cron", "sessions", "completion", "update", "uninstall", "status", "insights",
    "acp", "desktop", "dashboard", "proxy", "portal", "kanban", "pairing", "plugins",
    "secrets", "memory", "send", "webhook", "profile", "claw", "mcp", "gui",
  ]);
  for (const token of argv) {
    if (token === "--cli" || token === "-q" || token === "--query") return token;
    if (token.startsWith("-")) continue;
    if (SUBCOMMANDS.has(token.toLowerCase())) return token;
  }
  return undefined;
}

function reviewerSafeCommand(cmd: string): { cmd: string; advisory?: string } {
  const parsed = parseLaunchCommand(cmd);
  if (!parsed || !parsed.allWordsLiteral) throw new Error("reviewer command is structurally ambiguous or uses shell expansion");
  const runtime = adapterFor(parsed.binary)?.runtime;
  if (parsed.packageLauncher && (!runtime || parsed.binary.includes("@") || parsed.binary.includes("/"))) {
    throw new Error(`reviewer command cannot prove the runtime adapter after ${parsed.packageLauncher}`);
  }
  const boundary = parsed.argv.indexOf("--");
  const options = boundary < 0 ? parsed.argv : parsed.argv.slice(0, boundary);
  const has = (flag: string) => options.includes(flag) || options.some((token) => token.startsWith(`${flag}=`));
  const valuesFor = (flags: string[]): string[] => {
    const values: string[] = [];
    for (let index = 0; index < options.length; index++) {
      const arg = options[index]!;
      const flag = flags.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
      if (!flag) continue;
      const value = arg === flag ? options[++index] : arg.slice(flag.length + 1);
      if (!value || value.startsWith("-")) throw new Error(`reviewer command has an incomplete ${flag} mode`);
      values.push(value);
    }
    return values;
  };
  const bypass = options.some((token) => token.startsWith("--dangerously-"))
    || has("--yolo") || has("--always-approve") || has("--allow-all");
  if (bypass) throw new Error("reviewer command refuses bypass flags");
  const insert = (flag: string) => `${cmd.slice(0, parsed.runtimeTokenEnd)} ${flag}${cmd.slice(parsed.runtimeTokenEnd)}`;
  if (runtime === "codex") {
    if (has("--full-auto")) throw new Error("reviewer command refuses --full-auto");
    const sandboxes: string[] = [];
    for (let index = 0; index < options.length; index++) {
      const arg = options[index]!;
      let value: string | undefined;
      if (arg === "--sandbox" || arg === "-s") value = options[++index];
      else if (arg.startsWith("--sandbox=")) value = arg.slice("--sandbox=".length);
      else if (arg.startsWith("-s=")) value = arg.slice(3);
      else if (arg.startsWith("-s") && arg.length > 2) value = arg.slice(2);
      else continue;
      if (!value || value.startsWith("-")) throw new Error("reviewer command has an incomplete sandbox mode");
      sandboxes.push(value);
    }
    if (sandboxes.length > 1) throw new Error("reviewer command has duplicate sandbox declarations");
    if (sandboxes.some((sandbox) => sandbox !== "read-only")) throw new Error(`reviewer command conflicts with sandbox mode ${sandboxes.join(",")}`);
    return { cmd: sandboxes.length ? cmd : insert("--sandbox read-only") };
  }
  if (runtime === "claude" || runtime === "grok") {
    const permissions = valuesFor(["--permission-mode"]);
    if (permissions.length > 1) throw new Error("reviewer command has duplicate permission-mode declarations");
    if (permissions.some((permission) => permission !== "plan")) throw new Error(`reviewer command conflicts with permission mode ${permissions.join(",")}`);
    return { cmd: permissions.length ? cmd : insert("--permission-mode plan") };
  }
  return { cmd, advisory: `reviewer runtime '${path.basename(parsed.binary) || "unknown"}' has no measured shell-level read-only mode; command left unchanged` };
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
  /** spec 210 — opt this ad-hoc spawn into git-worktree isolation, including parented spawns. */
  worktree?: boolean;
  /** spec 230 — extra env merged into this ad-hoc spawn (e.g. a pipeline node's TACHYON_RUN_ID/NODE_ID/NODE_NONCE). Agent-declared env still wins on conflict via the spawn merge order. */
  env?: Record<string, string>;
  /** spec 230 — tag this ad-hoc spawn as a pipeline-run node; persisted to SessionDef.pipeline so the generic resume/offer path skips it (the run owns it). */
  pipeline?: { runId: string; nodeId: string };
  /** spec 230 — extra instructions appended to the agent's composed prompt (a pipeline node's task, added AFTER a declared agent's role/instructions so the specialist config is preserved). */
  taskBrief?: string;
  /** spec 246 — the validated delegation contract this ad-hoc AI child was spawned under (Bridge spawn-contract
   *  gate); persisted as structured metadata on the ledger def (D8). The brief itself rides in `instructions`. */
  contract?: SpawnContract;
  /** spec 246 — set when the spawner bypassed the contract gate (`skip_contract_reason`); recorded for audit. */
  contractSkipReason?: string;
  /** spec 362 — a gated delegation must be born in an isolated worktree and later verified by behavior test. */
  gate?: DelegationGate;
  /** SDD 368 T6 — join an existing canonical Delivery; never creates a fallback worktree. */
  deliveryJoin?: DeliveryJoinRequest;
}

export interface AgentManagerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  /** t-8354ae — optional pre-spawn gate (e.g. refuse LKG-only names while config is invalid). */
  assertSpawnAllowed?: (name: string) => void;
  getMaxAgents: () => number;
  /**
   * t-0d0152 — opt-in MemoryMax for agent spawn trees (e.g. "2G").
   * Empty/undefined = no systemd scope wrap.
   */
  getAgentMemoryMax?: () => string | undefined;
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
  /** spec 236 — write a non-harness opencode agent's Bridge-only opencode config file (with the
   *  project opencode.json folded in, if any), returning its path (undefined when the Bridge isn't
   *  up). The path is injected into the spawn env as OPENCODE_CONFIG so opencode loads it instead of
   *  its cwd-discovered `opencode.json`. Wired in Workspace where the Bridge URL/token live. */
  materializeBridgeMcpOpencode?: (name: string, cwd: string) => string | undefined;
  /** t-843576 — materialize a non-harness grok agent's private GROK_HOME (Bridge MCP in config.toml
   *  + auth.json symlink), returning its path (undefined when the Bridge isn't up). Optional `cwd` is
   *  the effective spawn cwd so folder-trust can be seeded before the interactive TUI starts.
   *  Injected into the spawn env as GROK_HOME. Wired in Workspace where the Bridge URL/token live. */
  materializeBridgeMcpGrok?: (name: string, cwd?: string) => string | undefined;
  /** Materialize a non-harness hermes agent's private HERMES_HOME (Bridge MCP in config.yaml +
   *  auth.json symlink), returning its path (undefined when the Bridge isn't up). Injected as
   *  HERMES_HOME. Wired in Workspace where the Bridge URL/token live. */
  materializeBridgeMcpHermes?: (name: string) => string | undefined;
  /** spec 243 — write a claude agent's per-spawn `--settings` file (the SessionStart ownership hook),
   *  returning its path; injected so activity follows a `/clear` on a shared cwd. Wired in Workspace. */
  materializeOwnershipSettings?: (name: string, opts?: {
    ownershipOnly?: boolean;
    cwd?: string;
    configHome?: string;
    statusLineCapture?: boolean;
  }) => string | undefined;
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
  onSpawned?: (name: string, reveal: boolean, context?: { worktree?: WorktreeRecord; adhoc: boolean }) => void;
  onStopping?: (name: string) => void;
  onKilled?: (name: string) => unknown;
  /**
   * Fired only when restart falls back to kill-session + new-session (t-4d2630).
   * Happy path uses respawn-pane -k so attached clients stay; the UI close dance is
   * unnecessary then. On the kill+new path, close the old editor terminal synchronously
   * so post-spawn onSpawned re-opens a fresh one instead of racing a dead attach client.
   */
  onRestart?: (name: string) => void;
  /** Session-resume ledger (spec 209); absent = resume tracking disabled. */
  ledger?: SessionLedger;
  /**
   * spec 364 — current Bridge generation for durable bridgeClient stamps on spawn/resume.
   * Workspace provides this from BridgeClientRebindCoordinator; default 0 when unwired.
   */
  getBridgeGeneration?: () => number;
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
  /** Effective host Claude config home inherited by non-harness sessions. Workspace supplies the same
   *  value used as HarnessManager's credential source so capture/resume never assume a different account. */
  defaultClaudeConfigHome?: string;
  /**
   * spec 210 — resolve the cwd a session is born in (worktree isolation). Given the spawn
   * context, returns the cwd + an optional worktree record to persist, or null to use the
   * default (workspace root / def.cwd). Owned by Workspace (it has the WorktreeManager,
   * lineage, and the setup runner). Awaited by the async spawn/restart — never the UI thread.
   */
  resolveSpawnCwd?: (ctx: SpawnCwdContext) => Promise<{
    cwd: string;
    worktree?: WorktreeRecord;
    delegationBaseSha?: string;
    created?: boolean;
    preparationLocked?: boolean;
    rollbackHeadSha?: string;
    /** Observed HEADs retained only for recovery diagnostics; failed launch cleanup is non-destructive. */
    preparationHeadBefore?: string;
    preparationHeadAfter?: string;
  } | null>;
  /** Persist canonical Delivery + linked Git projection after a gated agent successfully starts. */
  recordCanonicalDelivery?: (input: {
    name: string;
    delegator?: string;
    gate: DelegationGate;
    contract: SpawnContract;
    worktree: WorktreeRecord;
    baseSha: string;
    verifySettings?: TachyonConfig["settings"]["verify"];
  }) => CanonicalDeliverySpawnReceipt | Promise<CanonicalDeliverySpawnReceipt>;
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
   * be seeded or it can't carry context — commitFork FAILS CLOSED and preserves the quarantined
   * checkout on a false return rather than spawn a context-less fork. Default = fs copy then existence check.
   * Injectable for tests.
   */
  seedTranscript?: (from: string, to: string) => boolean;
  /** Legacy-named failed-launch hook. Implementations must preserve the checkout rather than risk
   *  deleting a concurrent ignored write or rewinding a commit after a time-of-check/time-of-use gap. */
  rollbackPreparedWorktree?: (
    worktree: WorktreeRecord,
    initialHead?: string,
    preparationHeadBefore?: string,
    preparationHeadAfter?: string,
    created?: boolean,
  ) => Promise<void>;
  /** Unlock a quarantined launch/fork worktree only after its ledger and, for a gate, canonical Delivery are durable.
   * Failure is reported but leaves the live runtime, durable records and Git lock intact for recovery. */
  completePreparedWorktree?: (worktree: WorktreeRecord) => Promise<void>;
  /**
   * spec 226 — materialize an agent's isolated harness (private config home + scoped MCP) and return
   * the spawn wiring (CLAUDE_CONFIG_DIR env + the strict-mcp args), or null when the agent has no
   * harness / the runtime doesn't support one. Owned by Workspace (it has the HarnessManager). Called
   * on EVERY spawn path (spawn/restart/resume/fork) so isolation never silently drops (H3).
   */
  materializeHarness?: (ctx: { name: string; def: AgentDef; cwd: string }) => MaterializedHarness | null;
  /** Remove a materialized per-agent runtime config home at the agent's end-of-life. */
  removeHarnessHome?: (name: string) => void;
  prepareDeliveryJoin?: (name: string, request: DeliveryJoinRequest) => Promise<PreparedDeliveryJoin>;
  confirmDeliveryJoin?: (name: string, request: DeliveryJoinRequest, prepared: PreparedDeliveryJoin, pid?: number) => Promise<void>;
  failDeliveryJoin?: (name: string, request: DeliveryJoinRequest, prepared: PreparedDeliveryJoin, error: unknown) => Promise<void>;
  /**
   * SDD 368 T14 — agents denied by the read-only reload snapshot (includes marker-less
   * cross-store crash rows). Generic spawn/resume/restart/autostart/readiness consult this;
   * explicit deliveryJoin remains allowed.
   */
  isDeliveryLifecycleDenied?: (name: string) => boolean;
  /** Runtime-native, non-inference capability validation performed before tmux or worktree creation. */
  launchPreflight?: RuntimeLaunchPreflightPort;
  /** Bounded, non-inference post-launch observation. Injectable for fake-timer tests. */
  launchReadiness?: LaunchReadinessPort;
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
  /** Immutable project verifier snapshot shown in the primer and persisted with this delegation. */
  verifySettings?: TachyonConfig["settings"]["verify"];
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
  private readonly soulReservations = new Map<string, string>();

  private soulPrincipal(name: string): string {
    const source = this.opts.ledger?.get(name)?.identity?.soul.source;
    return source?.match(/^\.tachyon\/agents\/([a-zA-Z][a-zA-Z0-9_-]*)\/SOUL\.md$/)?.[1] ?? name;
  }

  private async reserveSoulLaunch(executionName: string, principal: string, def: AgentDef): Promise<ResolvedSoul> {
    return withSoulProfileAdmission(this.opts.workspaceRoot, principal, async () => {
      const soul = await this.preflightSoul(principal, def);
      const dir = ensureSoulLaunchReservationsDirSync(this.opts.workspaceRoot);
      const file = path.join(dir, `${principal.toLowerCase()}--${executionName}--${crypto.randomUUID()}.json`);
      const reservation = JSON.stringify({ principal, execution: executionName, profileId: soul.profileId, sha256: soul.sha256, ownerPid: process.pid, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID, createdAt: new Date().toISOString() });
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, reservation);
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      try {
        const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (error) {
        if (process.platform !== "win32" && !["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      this.soulReservations.set(executionName, file);
      return soul;
    });
  }

  private releaseSoulReservation(name: string): void {
    const file = this.soulReservations.get(name);
    if (!file) return;
    this.soulReservations.delete(name);
    try {
      fs.unlinkSync(file);
      try {
        const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (error) {
        if (process.platform !== "win32" && !["EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.opts.notify?.(`failed to clear soul launch reservation for '${name}'`, "warn");
    }
  }
  private soulSnapshot(soul: ResolvedSoul, channel: SoulSnapshot["channel"]): SoulSnapshot {
    return { profileId: soul.profileId, source: soul.source, sha256: soul.sha256, chars: soul.chars, bytes: soul.bytes, offeredAt: new Date().toISOString(), channel, state: "offered" };
  }

  private async preflightSoul(name: string, def: AgentDef): Promise<ResolvedSoul> {
    const capability = openingPromptCapability(def.cmd);
    if (capability.status !== "prompt") {
      throw new SoulError("soul/runtime-unsupported", `Soul delivery is unsupported for ${capability.runtime}: ${capability.detail}`);
    }
    if (await principalBlockedByProfileTransaction(this.opts.workspaceRoot, name)) {
      throw new SoulError(
        "soul/profile-transaction-degraded",
        `Soul profile for '${name}' is blocked by a profile-transaction-degraded journal`,
      );
    }
    return resolveSoulWithRetry(async () => {
        return await resolveSoul(this.opts.workspaceRoot, name);
    });
  }
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
  private stopFailed = new Set<string>();
  private cleanExited = new Set<string>();
  /** Runtime occupancy observations keyed by the worktree's canonical realpath.
   *  Process-local (no lock files); `pending` = grant reserved but the spawn hasn't landed yet, `live` =
   *  occupant confirmed running, `dirty` = the last live occupant died without a clean cleanup probe. No
   *  entry = free. A reuse launch also acquires Git's durable worktree lock before spawn; the process-local
   *  map coordinates live callers while that lock preserves interrupted-launch quarantine across reloads.
   *  `pid` (best-effort, captured while the occupant's tmux session was confirmed live) is
   *  the occupant's pane-root process — the cleanup probe's one extra signal beyond "tmux session gone"
   *  when it's available; absent when the pid couldn't be resolved at capture time. */
  private worktreeOccupancy = new Map<string, { state: "pending" | "live" | "dirty"; agentId: string; cwd: string; pid?: number }>();
  /** t-815796 design point 2 — a process-local per-worktree mutex (chained promises), keyed the same as
   *  worktreeOccupancy. Serializes refresh-liveness and occupied-state transitions. */
  private worktreeLocks = new Map<string, Promise<unknown>>();
  /** Serialize the full launch transaction for one execution name, including worktree preparation,
   *  recovery handling and tmux creation. This closes the gap where two concurrent gated spawns could
   *  both pass the initial session probe and misattribute one checkout to the other launch. */
  private spawnLocks = new Map<string, Promise<void>>();
  private postmortemOutput = new Map<string, PostmortemOutput>();
  /** Last known-good agentStates() result — served back when tmux.sessionStates() returns
   * null (an ambiguous list-panes error), so a transient tmux hiccup can't read as "every
   * agent vanished" (t-3a3a14). */
  private lastAgentStates = new Map<string, { dead: boolean; exitCode?: number }>();
  private readonly launchPreflight: RuntimeLaunchPreflightPort;
  private readonly launchReadiness: LaunchReadinessPort;
  /** A session becomes assignable only after a positive readiness observation. */
  private readyAgents = new Set<string>();
  /** A launched AI runtime remains provisional until the common observation policy sees a ready affordance. */
  private provisionalAgents = new Set<string>();

  constructor(private readonly opts: AgentManagerOptions) {
    cleanupStaleSoulLaunchReservationsSync(opts.workspaceRoot);
    this.launchPreflight = opts.launchPreflight ?? new RuntimeLaunchPreflightRegistry({ codex: new CodexLaunchPreflight() });
    this.launchReadiness = opts.launchReadiness ?? new LaunchReadiness();
  }

  private get prefix(): string {
    return `${SESSION_PREFIX}-${this.opts.wsHash}-`;
  }

  session(name: string): string {
    return sessionName(this.opts.wsHash, name);
  }

  private definitionOf(name: string): AgentDef | undefined {
    return this.opts.getConfig()?.agents[name] ?? this.adhoc.get(name);
  }

  private async assertLaunchPreflight(
    name: string,
    cmd: string,
    env?: Record<string, string>,
    failClosedUnverifiable = false,
    cwd?: string,
  ): Promise<void> {
    const parsed = parseLaunchCommand(cmd);
    if (!parsed) {
      if (isExplicitCodexModelCommand(cmd) || (failClosedUnverifiable && hasExplicitModelSelection(cmd))) {
        throw new RuntimeLaunchPreflightError({ state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "explicit model command could not be verified" });
      }
      return;
    }
    const result = await this.launchPreflight.check(parsed, {
      ...process.env,
      ...this.opts.getExtraEnv?.(),
      ...env,
      TACHYON_AGENT_NAME: name,
    }, cwd);
    if (result.state === "unsupported" || result.state === "failed") throw new RuntimeLaunchPreflightError(result);
    if (result.state === "unverifiable" && parsed.model && failClosedUnverifiable) throw new RuntimeLaunchPreflightError(result);
  }

  /** Public read of an agent's definition (declared config wins, then ad-hoc) — spec 216 needs
   *  cmd/role/instructions to detect compaction and rebuild the role reminder. */
  defOf(name: string): AgentDef | undefined {
    return this.definitionOf(name);
  }

  /** Resolve the current canonical identity at an explicit lifecycle boundary. */
  async resolveSoulForLifecycle(name: string): Promise<ResolvedSoul | undefined> {
    const def = this.definitionOf(name);
    if (!def?.soul) return undefined;
    const principal = this.soulPrincipal(name);
    return withSoulProfileAdmission(this.opts.workspaceRoot, principal, () => this.preflightSoul(principal, def));
  }

  /** An agent's kind (config wins, then ad-hoc def, else infer from a running session's
   *  command). Used to give ad-hoc TERMINALS terminal defaults (e.g. attention off) — F5. */
  kindOf(name: string): EntryKind {
    return this.definitionOf(name)?.kind ?? "agent";
  }

  async isReady(name: string): Promise<boolean> {
    if (this.readyAgents.has(name)) return true;
    // The sets above are intentionally process-local.  On an extension restart, recover the
    // gate for a declared, still-live Codex session rather than treating its missing entry as
    // ready.  Other/unknown agents retain the historic permissive behavior: we have no stable
    // terminal affordance with which to gate them.
    const def = this.definitionOf(name);
    const candidate = def?.kind === "agent" ? adapterFor(def.cmd) : undefined;
    const managedAgent = candidate && LAUNCH_READINESS_RUNTIMES.has(candidate.runtime) ? candidate : undefined;
    if (!this.provisionalAgents.has(name)) {
      if (!managedAgent || !(await this.opts.tmux.hasSession(this.session(name)).catch(() => false))) return true;
      this.provisionalAgents.add(name);
    }
    // A timeout is deliberately not terminal. Assignment is a later, cheap re-observation
    // point: it can promote a runtime that finished booting after the bounded launch window.
    if (!managedAgent) return false;
    const observed = this.readinessAdapter(def!.cmd).classify(
      await this.opts.tmux.capturePane(this.session(name), { lines: 80, joinWrapped: true }).catch(() => ""),
    );
    if (observed?.state === "ready") {
      this.readyAgents.add(name);
      return true;
    }
    if (observed?.state === "rejected") await this.opts.tmux.killSession(this.session(name)).catch(() => undefined);
    return false;
  }

  private readinessAdapter(cmd: string): RuntimeLaunchReadinessAdapter {
    const adapter = adapterFor(cmd);
    if (adapter?.runtime === "codex") return new CodexLaunchReadiness();
    const composer = adapter ? runtimeProfile(adapter.runtime)?.composer : undefined;
    return new GenericLaunchReadiness(composer);
  }

  /**
   * SDD 370 live-dogfood recovery: admit only an input that matches the currently visible,
   * measured Codex bootstrap screen. This never promotes readiness and never applies to a
   * non-Codex runtime. The Bridge still requires explicit answering intent.
   */
  async matchBootstrapInput(name: string, text: string, submit: boolean): Promise<CodexBootstrapInputMatch | undefined> {
    if (this.readyAgents.has(name)) return undefined;
    const def = this.definitionOf(name);
    if (def?.kind !== "agent" || binaryOf(def.cmd) !== "codex") return undefined;
    if (!(await this.opts.tmux.hasSession(this.session(name)).catch(() => false))) return undefined;
    const pane = await this.opts.tmux
      .capturePane(this.session(name), { lines: 80, joinWrapped: true })
      .catch(() => "");
    return matchCodexBootstrapInput(pane, text, submit);
  }

  private async observeLaunchReadiness(name: string, cmd: string, session: string, cleanup?: () => Promise<void>): Promise<void> {
    const adapter = adapterFor(cmd);
    if (!adapter || !LAUNCH_READINESS_RUNTIMES.has(adapter.runtime)) return;
    this.readyAgents.delete(name);
    this.provisionalAgents.add(name);
    const readiness = await this.launchReadiness.wait({
      capture: () => this.opts.tmux.capturePane(session, { lines: 80, joinWrapped: true }),
      adapter: this.readinessAdapter(cmd),
      isAlive: async () => {
        const states = await this.opts.tmux.sessionStates(session);
        const state = states?.get(session);
        return state ? !state.dead : await this.opts.tmux.hasSession(session).catch(() => false);
      },
      aliveAtDeadline: "pending",
    });
    if (readiness.state === "rejected") {
      const primary = new RuntimeLaunchReadinessError(readiness.code);
      const failures: Error[] = [primary];
      try { await this.opts.tmux.killSession(session); }
      catch (error) { failures.push(new Error("failed to kill rejected launch", { cause: error })); }
      let sessionGone = false;
      try { sessionGone = !(await this.opts.tmux.hasSession(session)); }
      catch (error) { failures.push(new Error("failed to verify rejected launch liveness", { cause: error })); }
      if (sessionGone) {
        try { await cleanup?.(); }
        catch (error) { failures.push(new Error("failed to roll back rejected launch worktree", { cause: error })); }
      } else {
        failures.push(new Error("rejected launch may still be live; worktree rollback was withheld"));
      }
      if (failures.length === 1) throw primary;
      throw new AggregateError(failures, `launch readiness rejection '${readiness.code}' had incomplete compensation`, { cause: primary });
    }
    if (readiness.state === "ready") this.readyAgents.add(name);
  }

  /** spec 332 — the lineage parent recorded for this agent (session-local memory, same source as
   *  list()'s `parent` field), if any. Used by the death-poke wiring to find who to wake. t-384a3f:
   *  falls back to the persisted ledger the same way liveDescendants does — a child's parent link can
   *  survive only in the ledger after a reload (rehydrateFromLedger skips names that are currently
   *  declared), and this is now used for an AUTHORIZATION decision (inWaitOutputScope), so an in-memory
   *  miss must not read as "no parent" while the ledger still has one. */
  parentOf(name: string): string | undefined {
    return this.lineage.get(name) ?? this.opts.ledger?.get(name)?.def?.parent;
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
  async rehydrateFromLedger(): Promise<void> {
    if (!this.opts.ledger) return;
    const declared = new Set(Object.keys(this.opts.getConfig()?.agents ?? {}));
    for (const [name, rec] of this.opts.ledger.all()) {
      if (!rec.def || rec.declared || declared.has(name)) continue;
      if (!this.adhoc.has(name)) {
        this.adhoc.set(name, {
          cmd: rec.def.cmd,
          instructions: rec.def.instructions,
          ...(rec.def.role ? { role: rec.def.role } : {}),
          ...(rec.def.soul ? { soul: true } : {}),
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
      if (!this.delegators.has(name)) {
        const delegator = rec.def.delegator;
        if (delegator && delegator !== name) this.delegators.set(name, delegator);
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
      const alive = state !== undefined && !state.dead;
      const stoppingAt = this.stoppingSince.get(name);
      const stopTimedOut = alive && stoppingAt !== undefined && now - stoppingAt >= AgentManager.STOPPING_FALLBACK_MS;
      if (stopTimedOut) this.stopFailed.add(name);
      const stopping = alive && stoppingAt !== undefined && !stopTimedOut;
      const stopFailed = alive && this.stopFailed.has(name);
      if (state === undefined || state.dead || stopTimedOut) {
        this.stoppingSince.delete(name);
      }
      if (state === undefined || state.dead) this.stopFailed.delete(name);
      return {
        name,
        session: this.session(name),
        running: alive,
        ...(stopping ? { stopping: true } : {}),
        ...(stopFailed ? { stopFailed: true } : {}),
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
   * (prepended) + BEFORE-FINISHING block (appended) for every agent entry. Terminals retain their
   * byte-identical command because onboarding is agent context, never server/shell input.
   *
   * t-11a2d1 — a composed body past BRIEF_FILE_THRESHOLD is diverted to the agent's brief file
   * (deliverableBody) BEFORE the primer wrap: the pane payload gets a short pointer instead of the
   * full contract, staying well clear of tmux's hard per-argument ceiling. A body at or under the
   * threshold passes through unchanged — short-brief delivery stays byte-identical.
   */
  /**
   * Composed spawn brief (project guidance + role/instructions + primer + brief-file diversion). Shared by
   * `effectiveCmd` (argv delivery) and Hermes `HERMES_TUI_QUERY` (env delivery).
   */
  private effectiveInstructions(
    name: string,
    def: AgentDef,
    parent: string | undefined,
    primerCtx?: { delegator?: string; gate?: DelegationGate; freshWorktree?: boolean; verify?: TachyonConfig["settings"]["verify"] },
    taskBrief?: string,
    soul?: ResolvedSoul,
    projectGuidance?: string,
  ): string | undefined {
    // An explicit --resume/--continue/--session-id command owns its transcript and argv. Do not add
    // even declared role/instructions as a positional startup prompt; several runtimes reject or
    // reinterpret extra arguments on their resume form.
    if (managesOwnSession(def.cmd) || (def.kind === "agent" && !instructionsDeliverable(def.cmd))) return undefined;
    const guidance = !!parent && (this.opts.getConfig()?.settings.bridgeGuidance ?? true);
    const composed = composeAgentPrompt({ soul, role: def.role, instructions: def.instructions, bridgeGuidance: guidance, taskBrief }).body;
    // Project-owned policy is body content, not product protocol. Put it before the task/role body
    // (task-specific instructions stay more recent) and before the long-brief diversion so an
    // arbitrarily long configured document can never bypass tmux's measured payload ceiling.
    const body = [projectGuidance, composed].filter((part): part is string => !!part?.trim()).join("\n\n");
    const frame = (deliverable: string | undefined): string | undefined => def.kind === "agent"
      ? wrapWithPrimer(deliverable ?? "", {
          agentName: name,
          delegator: primerCtx?.delegator,
          parent,
          gate: primerCtx?.gate,
          verify: primerCtx?.verify ?? this.opts.getConfig()?.settings.verify,
        })
      : deliverable;
    // Size-check the exact successful-write pointer before deliverableBody atomically replaces any
    // prior brief. Thus an oversized verify/gate fact cannot change what the still-running pane's
    // old pointer reads when restart is rejected.
    const preview = body ? previewDeliverableBody(this.opts.workspaceRoot, name, body) : undefined;
    const previewInstructions = frame(preview);
    if (previewInstructions) assertSafeBriefTransport(previewInstructions, `agent '${name}' startup brief`);

    const deliverable = body ? deliverableBody(this.opts.workspaceRoot, name, body) : undefined;
    const instructions = frame(deliverable);
    if (instructions) assertSafeBriefTransport(instructions, `agent '${name}' startup brief`);
    return instructions?.trim() ? instructions : undefined;
  }

  private projectGuidanceFor(def: AgentDef): string | undefined {
    // A command that explicitly resumes/manages its own transcript is the same no-push exception as
    // Workspace.resume(): adding a positional onboarding prompt can change or break its semantics.
    // Unsupported startup adapters cannot carry a prompt either; do not read configured files for a
    // launch that has no delivery channel. Manual re-anchor remains available once such an agent runs.
    if (def.kind !== "agent" || managesOwnSession(def.cmd) || !instructionsDeliverable(def.cmd)) return undefined;
    return loadAndRenderProjectGuidance(this.opts.workspaceRoot, this.opts.getConfig()?.settings.projectGuidance);
  }

  private effectiveCmd(def: AgentDef, instructions: string | undefined): string {
    return composeCommand({ cmd: def.cmd, instructions });
  }

  /**
   * Hermes has no interactive positional prompt — the modern TUI reads HERMES_TUI_QUERY as
   * STARTUP_QUERY. The classic CLI is Hermes' default, so every pushed brief must also select the
   * TUI explicitly. Explicit non-TUI surfaces (--cli, chat, -q/--query, other CLI subcommands) fail
   * closed before tmux creation so the brief is never silently dropped.
   */
  private hermesBriefEnv(
    def: AgentDef,
    brief: string | undefined,
  ): Record<string, string> {
    if (binaryOf(def.cmd) !== "hermes") return {};
    if (!brief) return {};
    const incompatible = hermesBriefIncompatibleArg(parseLaunchCommand(def.cmd)?.argv ?? []);
    if (incompatible) {
      throw new Error(
        `Hermes startup brief requires the TUI; remove '${incompatible}' (or use bare 'hermes') or remove the startup brief`,
      );
    }
    return { HERMES_TUI_QUERY: brief, HERMES_TUI: "1" };
  }

  /**
   * spec 226 (H3) — the SINGLE place isolated-harness wiring is applied. Materializes the agent's
   * private config home (if any) and folds its CLAUDE_CONFIG_DIR env + strict-mcp args into the
   * spawn, so spawn/restart/resume/fork are all isolated identically. No-op for an agent without a
   * harness, or when no materializer is wired. Pass the ORIGINAL declared def (it carries `harness`).
   */
  private materializeRuntimeHarness(name: string, def: AgentDef | undefined, cwd: string): MaterializedHarness | null {
    const isolation = def ? isolationMechanismForCommand(def.cmd) : undefined;
    // spec 357/profile 358 - private-home runtimes need a per-agent config home by default.
    const needsPrivateHome = !!def?.harness || def?.isolate === "transcript" || isolation?.mechanism === "private-home";
    if (!def || !needsPrivateHome || !this.opts.materializeHarness) return null;
    return this.opts.materializeHarness({ name, def, cwd });
  }

  private applyHarness(
    name: string,
    def: AgentDef | undefined,
    cwd: string,
    cmd: string,
    env: Record<string, string>,
    prepared?: MaterializedHarness | null,
  ): { cmd: string; env: Record<string, string> } {
    const mat = prepared === undefined ? this.materializeRuntimeHarness(name, def, cwd) : prepared;
    if (!mat) return { cmd, env };
    const cmdWithArgs = mat.args.length > 0 ? `${cmd} ${mat.args.join(" ")}` : cmd;
    return { cmd: cmdWithArgs, env: { ...env, ...mat.env } };
  }

  /**
   * spec 226 (H2) — the config home that holds this agent's claude transcripts (`<home>/projects/…`).
   * A harness agent's home is redirected to `.tachyon/harness/<name>` (its CLAUDE_CONFIG_DIR); every
   * other agent uses the host's effective default Claude home (normally `~/.claude`). The resume/readiness
   * transcript checks must use THIS, or redirected/default-override transcripts become invisible.
   */
  private runtimeConfigHome(runtime: ResumeRuntime, name: string, def: AgentDef | undefined): string {
    if (runtime === "opencode" && (def?.harness || def?.isolate === "transcript")) return path.join(harnessHome(this.opts.workspaceRoot, name), "data");
    // harness/isolate grok: GROK_HOME is `<harness>/<agent>/.grok` (HarnessManager.grokHome).
    if (runtime === "grok" && (def?.harness || def?.isolate === "transcript")) {
      return path.join(harnessHome(this.opts.workspaceRoot, name), ".grok");
    }
    if (def?.harness || def?.isolate === "transcript") return harnessHome(this.opts.workspaceRoot, name); // spec 226 / 240 / 298
    if (runtime === "codex" && this.opts.materializeHarness) return harnessHome(this.opts.workspaceRoot, name); // spec 357 - default private CODEX_HOME
    // t-843576 — non-harness grok with Bridge wiring uses the private bridge GROK_HOME (sessions live there too).
    if (runtime === "grok" && this.opts.materializeBridgeMcpGrok) {
      return path.join(this.opts.workspaceRoot, ".tachyon", "bridge-mcp", `${name}.grok`);
    }
    // Non-harness hermes with Bridge wiring uses the private bridge HERMES_HOME (state.db lives there).
    if (runtime === "hermes" && this.opts.materializeBridgeMcpHermes) {
      return path.join(this.opts.workspaceRoot, ".tachyon", "bridge-mcp", `${name}.hermes`);
    }
    const home = (this.opts.homeDir ?? os.homedir)();
    if (runtime === "codex") return path.join(home, ".codex");
    if (runtime === "opencode") return defaultRealOpencodeDataHome(process.env, home);
    if (runtime === "grok") return path.join(home, ".grok");
    if (runtime === "hermes") return path.join(home, ".hermes");
    return this.defaultClaudeConfigHome();
  }

  private defaultClaudeConfigHome(): string {
    return this.opts.defaultClaudeConfigHome ?? path.join((this.opts.homeDir ?? os.homedir)(), ".claude");
  }

  private isWrongRuntimeDefaultHome(runtime: ResumeRuntime, configHome: string | undefined): boolean {
    if (!configHome) return false;
    const home = (this.opts.homeDir ?? os.homedir)();
    if (runtime === "codex") return path.resolve(configHome) === path.resolve(path.join(home, ".claude"));
    if (runtime === "claude") return path.resolve(configHome) === path.resolve(path.join(home, ".codex"));
    if (runtime === "opencode") return path.resolve(configHome) === path.resolve(path.join(home, ".claude")) || path.resolve(configHome) === path.resolve(path.join(home, ".codex"));
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

  /** Spawns a declared agent, or an ad-hoc one when `opts.cmd` is given. */
  async spawn(name: string, opts?: SpawnOptions): Promise<CanonicalDeliverySpawnReceipt | void> {
    const prior = this.spawnLocks.get(name) ?? Promise.resolve();
    const run = prior.then(() => this.spawnUnlocked(name, opts), () => this.spawnUnlocked(name, opts));
    const tail = run.then(() => undefined, () => undefined);
    this.spawnLocks.set(name, tail);
    try {
      return await run;
    } finally {
      if (this.spawnLocks.get(name) === tail) this.spawnLocks.delete(name);
    }
  }

  private async spawnUnlocked(name: string, opts?: SpawnOptions): Promise<CanonicalDeliverySpawnReceipt | void> {
    try {
      // t-8354ae — config-failure / LKG-only refusal (before any delivery or occupancy mutation).
      // Ad-hoc spawns with an explicit cmd are allowed (caller supplies the def); declared LKG-only names are not.
      if (!opts?.cmd) this.opts.assertSpawnAllowed?.(name);
      if (opts?.deliveryJoin) {
        if (opts.gate || opts.worktree) {
          throw new Error("spawn_agent delivery_join cannot combine with gate or worktree:true");
        }
        // Explicit deliveryJoin is the only allowed route after canonical recovery/acquisition.
        return await this.spawnDeliveryJoin(name, opts, opts.deliveryJoin);
      }
      if (opts?.gate) {
        const behaviorTest = opts.gate.behaviorTest.replace(/\s+/g, " ").trim();
        const owns = [...new Set(opts.gate.owns.map((ownedPath) => ownedPath.trim()).filter(Boolean))];
        if (!behaviorTest) throw new Error("gated delegation requires a behavior-level verifier");
        if (owns.length === 0) throw new Error("gated delegation requires at least one owned path");
        opts = { ...opts, gate: { ...opts.gate, behaviorTest, owns } };
      }
      // SDD 368 T14 — generic spawn refuses snapshot-denied agents before any mutation.
      this.assertNotDeliveryLifecycleDenied(name, "spawn");
      return await this.spawnCore(name, opts);
    } finally {
      this.releaseSoulReservation(name);
    }
  }

  /**
   * SDD 368 T14 — refuse generic lifecycle when the agent has a Delivery marker OR is in the
   * reload snapshot's unavailable deny set (marker-less crash window). Guards must run before
   * any transient cache mutation.
   */
  private isDeliveryLifecycleDenied(name: string, record?: SessionRecord): boolean {
    if (hasDeliveryMarker(record) || hasDeliveryMarker(this.opts.ledger?.get(name))) return true;
    return this.opts.isDeliveryLifecycleDenied?.(name) === true;
  }

  private assertNotDeliveryLifecycleDenied(name: string, op: "spawn" | "resume" | "restart", record?: SessionRecord): void {
    if (!this.isDeliveryLifecycleDenied(name, record)) return;
    if (op === "resume") {
      throw new Error(
        `cannot resume '${name}': Delivery-bound execution requires Delivery recovery, not generic resume`,
      );
    }
    if (op === "restart") {
      throw new Error(
        `cannot restart '${name}': Delivery-bound execution requires a new nonce-bound segment or recovery path, not generic pane respawn`,
      );
    }
    throw new Error(
      `cannot spawn '${name}': Delivery lifecycle is unavailable for this agent (reload deny or Delivery marker); use explicit deliveryJoin recovery`,
    );
  }

  private async spawnDeliveryJoin(name: string, opts: SpawnOptions, request: DeliveryJoinRequest): Promise<void> {
    if (!this.opts.prepareDeliveryJoin || !this.opts.confirmDeliveryJoin) {
      throw new Error("DELIVERY_LEASE_UNAVAILABLE: Delivery join wiring is unavailable");
    }
    let definition: AgentDef | undefined;
    const bound = request.declaredAgent;
    if (bound) {
      if (opts.cmd) throw new Error("delivery_join.declared_agent cannot combine with cmd");
      if (request.principal) throw new Error("delivery_join.declared_agent cannot combine with principal");
      if (name === bound) throw new Error("delivery_join execution name must differ from declared_agent");
      const config = this.opts.getConfig();
      const source = config?.agents[bound];
      if (!source) throw new UnknownAgentError(bound);
      if (source.kind !== "agent") throw new Error(`delivery_join.declared_agent '${bound}' must have kind: agent`);
      if (source.env?.TACHYON_AGENT_BRIDGE_TOKEN !== undefined) throw new Error(`delivery_join.declared_agent '${bound}' may not declare TACHYON_AGENT_BRIDGE_TOKEN`);
      if (config?.agents[name] || this.adhoc.has(name) || this.opts.ledger?.get(name) || await this.opts.tmux.hasSession(this.session(name))) throw new Error(`delivery_join execution name '${name}' is already in use`);
      definition = deliveryDefinitionSnapshot(source);
      request = { ...request, principal: bound };
    }
    let commandOverride: string | undefined;
    if (request.role === "reviewer") {
      const baseCommand = definition?.cmd ?? opts.cmd ?? this.definitionOf(name)?.cmd;
      if (!baseCommand) throw new UnknownAgentError(name);
      const safe = reviewerSafeCommand(baseCommand);
      commandOverride = safe.cmd;
      if (safe.advisory) this.opts.notify?.(safe.advisory, "warn");
    }
    const effective = commandOverride ?? definition?.cmd ?? opts.cmd ?? this.definitionOf(name)?.cmd;
    if (!effective) throw new UnknownAgentError(name);
    const preliminaryPreflight = this.launchPreflight.requiresPreparedEnvironment !== true;
    if (preliminaryPreflight) {
      await this.assertLaunchPreflight(name, effective, { ...(definition?.env ?? this.definitionOf(name)?.env), ...(opts.env ?? {}) });
    }
    const resolvedSoul = definition?.soul ? await this.reserveSoulLaunch(name, bound!, definition) : undefined;
    // Preparation is not an acquisition boundary: a same-named session can appear while
    // the Delivery reservation is being prepared.  The inner spawn boundary records
    // acquisition only after it rechecks every identity source.
    const mode: DeliveryLaunchAttempt["mode"] = bound
      ? "bound-ephemeral"
      : opts.cmd
        ? "cmd-adhoc-ephemeral"
        : "declared";
    const attempt: DeliveryLaunchAttempt = { mode, acquired: false, token: false, materialized: "not-started", session: "not-started", ledger: false };
    const prepared = await this.opts.prepareDeliveryJoin(name, request);
    try {
      await this.spawnCore(name, opts, { cwd: prepared.cwd, worktree: prepared.worktree, commandOverride, definition, ephemeral: mode !== "declared", preliminaryPreflight, attempt, resolvedSoul });
      await this.opts.confirmDeliveryJoin(name, request, prepared, await this.tryPanePid(name));
      // SDD 368 T14 — reverse binding after confirm; failure is a failed join (never unbound successful holder).
      this.persistDeliveryBinding(name, {
        deliveryId: request.deliveryId,
        segmentId: prepared.segmentId,
        executionNonce: prepared.reservationNonce,
      });
    } catch (error) {
      const compensationErrors = await this.cleanupFailedDeliveryExecution(name, attempt);
      try { await this.opts.failDeliveryJoin?.(name, request, prepared, error); }
      catch (cleanupError) { compensationErrors.push(new Error("reservation compensation failed", { cause: cleanupError })); }
      if (compensationErrors.length) {
        throw new AggregateError([error, ...compensationErrors], "Delivery join failed and compensation was incomplete", { cause: error });
      }
      throw error;
    }
  }

  /**
   * SDD 368 T14 — write the Delivery reverse marker onto the exact execution's ledger row.
   * Throws on missing ledger/row or conflicting bind so the join path compensates.
   */
  private persistDeliveryBinding(name: string, binding: SessionDeliveryBinding): void {
    if (!this.opts.ledger) {
      throw new Error(`DELIVERY_BINDING_FAILED: no session ledger to persist reverse binding for '${name}'`);
    }
    if (typeof binding.segmentId !== "string" || binding.segmentId.length === 0) {
      throw new Error(`DELIVERY_BINDING_FAILED: prepared join for '${name}' lacks segmentId`);
    }
    this.opts.ledger.bindDelivery(name, binding);
  }

  private async cleanupFailedDeliveryExecution(name: string, attempt: DeliveryLaunchAttempt): Promise<Error[]> {
    const errors: Error[] = [];
    const phase = (label: string, error: unknown) => errors.push(new Error(label, { cause: error }));
    if (!attempt.acquired) return errors;
    let completedSessionAbsent = false;
    if (attempt.session === "completed") {
      try {
        if (!(await this.opts.tmux.hasSession(this.session(name)))) completedSessionAbsent = true;
        else {
        try { await this.opts.tmux.killSession(this.session(name)); } catch (error) { phase("session kill failed", error); }
        try { completedSessionAbsent = !(await this.opts.tmux.hasSession(this.session(name))); } catch (error) { phase("post-kill session probe failed", error); }
        if (!completedSessionAbsent) errors.push(new Error("failed Delivery execution may still be live; recovery state preserved"));
        }
      } catch (error) { phase("initial session probe failed", error); }
      if (!completedSessionAbsent && !errors.some(error => error.message.includes("may still be live"))) errors.push(new Error("failed Delivery execution may still be live; recovery state preserved"));
    } else if (attempt.session === "attempted") {
      // newSession may have created a pane before reporting a failure.  It is not
      // safe to kill a same-named session without a successful creation receipt.
      errors.push(new Error("Delivery execution session creation is uncertain; recovery state preserved"));
    }
    if (attempt.token) try { this.opts.revokeAgentToken?.(name); } catch (error) { phase("token revoke failed", error); }
    if (attempt.session === "attempted") return errors;
    if (attempt.session === "not-started") {
      // No session was completed, so only a freshly acquired ephemeral execution
      // can discard the materialization it owns.  A declared principal retains
      // all transient, durable, and callback state from its prior lifetime.
      if (attempt.mode !== "declared" && (attempt.materialized !== "not-started" || attempt.ledger)) {
        try { this.forgetAdhoc(name); } catch (error) { phase("in-memory cleanup failed", error); }
        try { this.removeEphemeralFootprint(name); } catch (error) { phase("footprint cleanup failed", error); }
      }
      return errors;
    }
    if (!completedSessionAbsent) return errors;
    const transient = [
      () => this.readyAgents.delete(name), () => this.provisionalAgents.delete(name), () => this.readinessCache.delete(name),
      () => this.stoppingSince.delete(name), () => this.stopFailed.delete(name), () => this.cleanExited.delete(name), () => this.postmortemOutput.delete(name),
    ];
    for (const clear of transient) try { clear(); } catch (error) { phase("in-memory cleanup failed", error); }
    if (attempt.mode !== "declared" && (attempt.materialized !== "not-started" || attempt.ledger)) {
      try { this.forgetAdhoc(name); } catch (error) { phase("in-memory cleanup failed", error); }
      try { this.removeEphemeralFootprint(name); } catch (error) { phase("footprint cleanup failed", error); }
    }
    try { this.opts.onKilled?.(name); } catch (error) { phase("killed callback failed", error); }
    return errors;
  }

  /** The mutex key is a worktree's canonical realpath, so two different-looking paths to the
   *  same directory (a symlink, a relative vs absolute form) never fragment into two separate locks. */
  private canonicalWorktreeKey(worktreePath: string): string {
    try {
      return fs.realpathSync(worktreePath);
    } catch {
      return path.resolve(worktreePath);
    }
  }

  /** Process-local per-worktree mutex: chains onto whatever is already
   *  queued for `key` (swallowing its outcome so one failed grant never wedges the next caller's turn),
   *  then runs `fn` and returns ITS outcome to the caller that queued it. No lock files. */
  private async withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.worktreeLocks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    this.worktreeLocks.set(key, run.catch(() => undefined));
    return run;
  }

  async worktreeOccupant(worktreePath: string): Promise<{ state: "live" | "pending" | "dirty"; agent: string; cwd: string } | undefined> {
    const key = this.canonicalWorktreeKey(worktreePath);
    return this.withWorktreeLock(key, async () => {
      await this.refreshWorktreeOccupancy(key, worktreePath);
      const occ = this.worktreeOccupancy.get(key);
      return occ ? { state: occ.state, agent: occ.agentId, cwd: occ.cwd } : undefined;
    });
  }

  /**
   * t-815796 design point 2/3 — refresh a worktree's occupancy before granting: (a) with no tracked
   * occupant yet this process, close the owner-vs-occupant gap by scanning the ledger for ANY agent
   * whose recorded cwd is this worktree and who is currently alive (the original delegated owner may
   * still be running); (b) with a tracked `live`/`pending` occupant, confirm it is still alive; if it
   * died, design point 3 says death does NOT free the worktree — only a cleanup probe does. We have no
   * process tracking beyond tmux, so "the occupant's tmux session is fully gone" IS that probe: a
   * lingering dead/postmortem pane is an INCONCLUSIVE probe (an orphaned child process could still be
   * running under it) and the worktree goes `dirty` instead of `free`.
   */
  private async refreshWorktreeOccupancy(key: string, worktreePath: string): Promise<void> {
    const occ = this.worktreeOccupancy.get(key);
    if (!occ) {
      const ledgerOccupant = await this.findLedgerWorktreeOccupant(worktreePath);
      if (ledgerOccupant?.state === "live") {
        this.worktreeOccupancy.set(key, { state: "live", agentId: ledgerOccupant.agent, cwd: ledgerOccupant.cwd, pid: await this.tryPanePid(ledgerOccupant.agent) });
      } else if (ledgerOccupant?.state === "dead") {
        this.worktreeOccupancy.set(key, { state: "dirty", agentId: ledgerOccupant.agent, cwd: ledgerOccupant.cwd });
      }
      return;
    }
    if (occ.state === "dirty") return; // stays quarantined until an explicit cleanup clears it elsewhere
    const running = new Set(await this.runningAgents());
    if (running.has(occ.agentId)) return; // still alive — occupancy holds
    if (occ.state === "pending") {
      // a reservation whose spawn never came up alive — never actually occupied, so it's simply free.
      this.worktreeOccupancy.delete(key);
      return;
    }
    const sessionGone = !(await this.opts.tmux.hasSession(this.session(occ.agentId)));
    if (!sessionGone) {
      this.worktreeOccupancy.set(key, { ...occ, state: "dirty" });
      return;
    }
    // design point 3's stated probe is "tmux gone + no root process" — a bare sessionGone only ever
    // checked the first half. When we captured the occupant's pane-root pid while it was live, honor the
    // second half: a process that outlived its own tmux session (reparented, or the tmux server itself
    // dropped bookkeeping) must still quarantine the worktree, not free it. No captured pid (pre-existing
    // occupancy row, or the capture failed) keeps the pre-existing tmux-only behavior — undiminished, but
    // unable to claim it checked something it didn't.
    if (occ.pid !== undefined && isPidAlive(occ.pid)) {
      this.worktreeOccupancy.set(key, { ...occ, state: "dirty" });
      return;
    }
    // SDD 368 T14 — a Delivery-bound occupant never becomes free from tmux disappearance alone.
    // Bound worktrees stay dirty/unavailable until an explicit Delivery recovery path clears them.
    if (hasDeliveryMarker(this.opts.ledger?.get(occ.agentId))) {
      this.worktreeOccupancy.set(key, { ...occ, state: "dirty" });
      return;
    }
    if (occ.pid === undefined) console.warn(`[tachyon] worktree occupancy freed on tmux-session-gone alone for '${occ.agentId}' — no pid was captured to verify its root process also exited`);
    this.worktreeOccupancy.delete(key);
  }

  /** t-815796 MEDIUM fix — best-effort pane-root pid capture; never blocks a grant on it. */
  private async tryPanePid(agentId: string): Promise<number | undefined> {
    try {
      return await this.opts.tmux.panePid(this.session(agentId));
    } catch {
      return undefined;
    }
  }

  /**
   * t-7da04c / t-815796 / SDD 368 T14/R3 — owner-vs-occupant reload gap.
   * Gather ALL ledger rows whose persisted cwd OR worktree.path is under this worktree
   * (never return the first match alone; never ignore a cwd-drifted bound worktree path):
   *   - one exact live bound row with matching cwd+worktree → live
   *   - a dead/missing/invalid/mismatched bound row or multiple candidates → dirty (dead)
   *   - unbound live/dead behaves as before for a single match
   * Bound rows without a live tmux session still count (missing runtime is dirty, not free).
   */
  private async findLedgerWorktreeOccupant(worktreePath: string): Promise<{ agent: string; state: "live" | "dead"; cwd: string } | undefined> {
    if (!this.opts.ledger) return undefined;
    const states = await this.agentStates();
    const root = this.canonicalWorktreeKey(worktreePath);
    type Candidate = { agent: string; state: "live" | "dead"; cwd: string; bound: boolean; invalid: boolean };
    const candidates: Candidate[] = [];
    for (const [agent, rec] of this.opts.ledger.all()) {
      const cwdKey = rec.cwd ? this.canonicalWorktreeKey(rec.cwd) : undefined;
      const wtKey = rec.worktree?.path ? this.canonicalWorktreeKey(rec.worktree.path) : undefined;
      const cwdMatch = !!cwdKey && isPathAtOrUnder(cwdKey, root);
      const wtMatch = !!wtKey && isPathAtOrUnder(wtKey, root);
      if (!cwdMatch && !wtMatch) continue;

      const bound = hasDeliveryMarker(rec);
      const invalidMarker = isInvalidDeliveryMarker(rec.delivery)
        || (bound && !isValidDeliveryBinding(rec.delivery));
      // Bound mismatch (including cwd-drift): one of cwd/worktree under the target without the
      // other agreeing, missing side, or both under but not the same canonical key.
      const boundPathMismatch = bound && (
        !rec.cwd
        || !rec.worktree?.path
        || cwdMatch !== wtMatch
        || (cwdKey !== undefined && wtKey !== undefined && cwdKey !== wtKey)
      );
      const invalid = invalidMarker || boundPathMismatch;
      const reportCwd = (cwdMatch && rec.cwd)
        ? rec.cwd
        : (rec.worktree?.path ?? rec.cwd ?? worktreePath);
      const state = states.get(agent);
      if (!state) {
        // Unbound rows without a session remain invisible (pre-T14). Bound missing runtime → dirty.
        if (bound) candidates.push({ agent, state: "dead", cwd: reportCwd, bound: true, invalid });
        continue;
      }
      candidates.push({
        agent,
        state: state.dead ? "dead" : "live",
        cwd: reportCwd,
        bound,
        invalid,
      });
    }
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      // Multiple candidates → dirty/unavailable; report first agent for diagnostics.
      const pick = candidates[0]!;
      return { agent: pick.agent, state: "dead", cwd: pick.cwd };
    }
    const only = candidates[0]!;
    if (only.bound && (only.invalid || only.state === "dead")) {
      return { agent: only.agent, state: "dead", cwd: only.cwd };
    }
    return { agent: only.agent, state: only.state, cwd: only.cwd };
  }

  /** Core spawn machinery shared by ordinary spawn and canonical Delivery execution. */
  private async spawnCore(name: string, opts?: SpawnOptions, forced?: { cwd: string; worktree: WorktreeRecord; commandOverride?: string; definition?: AgentDef; ephemeral?: boolean; preliminaryPreflight?: boolean; attempt?: DeliveryLaunchAttempt; resolvedSoul?: ResolvedSoul }): Promise<CanonicalDeliverySpawnReceipt | void> {
    const clearTransientState = () => {
      this.readyAgents.delete(name);
      this.readinessCache.delete(name);
      this.stoppingSince.delete(name);
      this.stopFailed.delete(name);
      this.cleanExited.delete(name);
      this.postmortemOutput.delete(name);
    };
    let def = forced?.definition ?? this.definitionOf(name);
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
    if (forced?.commandOverride) def = { ...def, cmd: forced.commandOverride };

    const taskBrief = opts?.taskBrief;

    // Identity preflight remains before dead-pane replacement. Runtime preflight moves below cwd/private-home
    // preparation so its probe sees the exact prospective environment and owns explicit compensation.
    const resolvedSoul = forced?.resolvedSoul ?? (def.soul ? await this.reserveSoulLaunch(name, this.soulPrincipal(name), def) : undefined);

    const session = this.session(name);
    let replaceDeadSession = false;
    if (forced?.attempt) {
      // This is the true Delivery acquisition boundary.  Do not inherit ordinary
      // spawn's dead-pane replacement behavior: either kind of racing occupant is
      // another execution and carries no cleanup authority for this receipt.
      const incumbentIdentity = forced.attempt.mode !== "declared"
        && (this.opts.getConfig()?.agents[name] || this.adhoc.has(name) || this.opts.ledger?.get(name));
      if (incumbentIdentity || await this.opts.tmux.hasSession(session)) {
        throw new Error(`delivery_join execution name '${name}' is already in use`);
      }
    } else if (await this.opts.tmux.hasSession(session)) {
      const state = (await this.agentStates()).get(name);
      if (state && state.dead) {
        // Delay replacing the dead postmortem pane until every guidance/brief operation that can
        // fail has completed. Merely observing the pane here is side-effect free.
        replaceDeadSession = true;
      } else {
        throw new Error(`agent '${name}' is already running`);
      }
    }

    // A gated launch cannot become valid later in the pipeline: reject incomplete caller wiring
    // before guidance reads, worktree quarantine, ledger writes or runtime creation.
    if (opts?.gate && !opts.contract) throw new Error("gated delegation requires a validated delegation contract");
    if (opts?.gate && !this.opts.recordCanonicalDelivery) {
      throw new Error("gated delegation requires canonical Delivery persistence");
    }

    // Resolve every declared project file before touching an incumbent tmux session or preparing a
    // worktree. A bad opt-in must fail this launch atomically, never kill a dead pane and then reveal
    // that the replacement brief could not be composed.
    const projectGuidance = this.projectGuidanceFor(def);
    const adhoc = !!opts?.cmd || !!forced?.ephemeral;
    // Runtime lineage is only for ad-hoc children. A tachyon.yml-declared name is
    // always a top-level managed entry; config subagents are exposed separately as
    // declaredOwner metadata and must not inherit stale ad-hoc-era parents.
    const parent = adhoc && !opts?.gate && opts?.parent && opts.parent !== name ? opts.parent : undefined;
    const delegator = opts?.gate && opts.delegator && opts.delegator !== name ? opts.delegator : undefined;
    // t-f660d8 — primer/doorbell identity for declared agents: honor spawn_agent `parent` or
    // config `declaredOwner` without writing runtime lineage (sidebar stays top-level + declaredOwner).
    const primerParent = !opts?.gate
      ? ((opts?.parent && opts.parent !== name ? opts.parent : undefined)
        ?? (!adhoc ? this.opts.getConfig()?.declaredOwner?.[name] : undefined))
      : undefined;
    // `{}` is an intentional snapshot of "no verifier configured". Leaving it undefined would be
    // indistinguishable from an omitted snapshot and verify_task could later adopt newly-added commands.
    const verifySettingsSnapshot: NonNullable<TachyonConfig["settings"]["verify"]> = structuredClone(
      this.opts.getConfig()?.settings.verify ?? {},
    );
    const primerCtx = { delegator, gate: opts?.gate, verify: verifySettingsSnapshot };

    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max);

    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    // spec 210 — worktree isolation: Workspace resolves the cwd (its own worktree for a
    // top-level opt-in agent, the parent's cwd for a sub-agent, the root on any git
    // problem). Awaited here (off the UI thread); null = keep the default cwd.
    let worktree: WorktreeRecord | undefined = forced?.worktree;
    let createdWorktree = false;
    let preparationLocked = false;
    let rollbackHeadSha: string | undefined;
    let preparationHeadBefore: string | undefined;
    let preparationHeadAfter: string | undefined;
    let delegationBaseSha: string | undefined;
    let launchTokenMinted = false;
    const revokeLaunchToken = (): void => {
      const revoke = this.opts.revokeAgentToken;
      if (!revoke) return;
      revoke(name);
      launchTokenMinted = false;
      // Delivery's outer receipt-aware compensator must not revoke the same name again after an
      // inner launch phase has already revoked the credential acquired by this attempt.
      if (forced?.attempt) forced.attempt.token = false;
    };
    if (forced) {
      // Canonical Delivery provides the exact, already-owned worktree and bypasses generic cwd resolution.
      cwd = forced.cwd;
    } else if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({
        name,
        def,
        parent,
        adhoc,
        isRestart: false,
        gate: opts?.gate,
        verifySettings: verifySettingsSnapshot,
      });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
        createdWorktree = resolved.created === true;
        preparationLocked = resolved.preparationLocked === true;
        rollbackHeadSha = resolved.rollbackHeadSha;
        preparationHeadBefore = resolved.preparationHeadBefore;
        preparationHeadAfter = resolved.preparationHeadAfter;
        delegationBaseSha = resolved.delegationBaseSha;
      }
    }
    if (opts?.gate && !worktree) {
      throw new Error("gated delegation requires an isolated worktree; worktree creation was unavailable");
    }
    // t-f660d8 — explicit spawn_agent cwd: honor or fail closed (never silently ignore).
    // Parented ad-hoc children inherit the parent's cwd via resolveWorktreeCwd — refuse opts.cwd
    // so callers never think a custom path was applied. Declared agents without a worktree may
    // run in an explicit managed checkout (e.g. a Delivery worktree path).
    if (!forced && opts?.cwd) {
      const requested = resolveCwd(this.opts.workspaceRoot, opts.cwd);
      if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
        throw new Error(`spawn_agent cwd is not an existing directory: ${requested}`);
      }
      if (parent) {
        throw new Error(
          `spawn_agent cwd is not used for parented ad-hoc children (they inherit the parent's cwd); omit cwd or spawn without parent`,
        );
      }
      if (worktree) {
        if (path.resolve(worktree.path) !== path.resolve(requested)) {
          throw new Error(
            `spawn_agent cwd '${requested}' conflicts with worktree isolation at ${worktree.path}; omit cwd or match the worktree path`,
          );
        }
      } else {
        cwd = requested;
      }
    }
    const rollbackLaunchPreparation = async (): Promise<boolean> => {
      if (forced || !worktree || !this.opts.rollbackPreparedWorktree) return false;
      if (!createdWorktree && (!preparationHeadBefore || !preparationHeadAfter)) return false;
      await this.opts.rollbackPreparedWorktree(
        worktree,
        rollbackHeadSha,
        preparationHeadBefore,
        preparationHeadAfter,
        createdWorktree,
      );
      return true;
    };
    // `resolveSpawnCwd` may bind a project-configured named verifier's existing oracle/mechanics and
    // enrich the gate with their fixed hashes. Runner-neutral `cmd:` gates deliberately do neither. Compose
    // only afterwards so the primer carries the authoritative result, before any tmux mutation.
    const effectivePrimerCtx = { ...primerCtx, freshWorktree: !!worktree };
    let preparedRuntimeHarness: MaterializedHarness | null | undefined;
    let createdRuntimeHome = false;
    const preparedLaunch = await (async () => {
    // primerParent (declared owner/spawn parent) only for primer/guidance — not runtime lineage.
    const effectiveInstructions = this.effectiveInstructions(
      name,
      def,
      parent ?? primerParent,
      effectivePrimerCtx,
      taskBrief,
      resolvedSoul,
      projectGuidance,
    );
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
      // t-303f2b — grok non-harness already gets a private GROK_HOME via materializeBridgeMcpGrok
      // (same path as declared agents). Auto isolate:transcript would materialize a *second* private
      // home under .tachyon/harness/ and race GROK_HOME with withRuntimeBridge; cold dual-homes have
      // surfaced as interactive "Approve in your browser" instead of reusing ~/.grok auth.
      const usesBridgePrivateHome =
        (adapter.runtime === "grok" && !!this.opts.materializeBridgeMcpGrok) ||
        (adapter.runtime === "hermes" && !!this.opts.materializeBridgeMcpHermes);
      if (!usesBridgePrivateHome) {
        def = { ...def, isolate: "transcript" };
      }
    }
    const isolatedWorktree = !!worktree;
    // t-ef19a1 — anti-footgun only, never a trust/allow change: a tachyon.yml-declared opencode
    // agent with no harness/worktree isolation is intentionally allowed (its author already has
    // full extension trust), but it shares the global ~/.local/share opencode state, so warn once
    // at spawn time. Ad-hoc opencode is unaffected — it auto-gets isolate:"transcript" above.
    if (!adhoc) {
      const footgun = opencodeIsolationFootgunWarning(def.cmd, { name, harness: !!def.harness, isolatedWorktree });
      if (footgun) this.opts.notify?.(footgun, "warn");
    }
    if (parent && def.kind === "agent" && !def.harness) {
      assertVerifiedTranscriptIsolation(def.cmd, { name, isolatedWorktree, parented: true });
    }
    // Security review (782f1c6, HIGH): gate on `isolatedWorktree` too, not just lineage — an ungated,
    // shared-cwd delegation (t-e2ebe3) is `parent`-truthy but not worktree-contained, and `bash:"allow"`
    // is unconfined shell access with no `external_directory` bound on it. Only a worktree-contained
    // delegation gets the block; an uncontained one falls back to opencode's own default instead.
    const delegatedOpencode = (parent || delegator || opts?.gate) && isolatedWorktree
      ? { workspaceRoot: this.opts.workspaceRoot, worktreesBase: this.worktreesBaseFor(cwd, worktree) }
      : undefined;

    // spec 230 — per-spawn env (a pipeline node's TACHYON_* nonce) is merged LAST so it reaches a
    // DECLARED agent too (not just the ad-hoc cmd path) and wins on any collision (codex B1).
    // Evaluate the extra environment before minting.  A bridge/env failure must not
    // revoke a durable declared token that this attempt never minted.
    const extraEnv = this.opts.getExtraEnv?.();
    const runtimeHome = harnessHome(this.opts.workspaceRoot, name);
    const runtimeHomeExisted = fs.existsSync(runtimeHome);
    try {
      preparedRuntimeHarness = this.materializeRuntimeHarness(name, def, cwd);
    } finally {
      createdRuntimeHome = !runtimeHomeExisted && fs.existsSync(runtimeHome);
    }
    if (!forced?.preliminaryPreflight) {
      await this.assertLaunchPreflight(
        name,
        def.cmd,
        { ...extraEnv, ...def.env, ...(opts?.env ?? {}), ...(preparedRuntimeHarness?.env ?? {}) },
        adhoc && def.kind === "agent",
        cwd,
      );
    }
    const effectiveCmd = this.effectiveCmd(def, effectiveInstructions);
    if (forced?.attempt) forced.attempt.acquired = true;
    const tokenEnv = this.opts.mintAgentToken?.(name);
    launchTokenMinted = tokenEnv !== undefined && Object.keys(tokenEnv).length > 0;
    if (forced?.attempt && tokenEnv !== undefined) forced.attempt.token = true;
    if (forced?.attempt) forced.attempt.materialized = "attempted";
    const spawnBuild = this.applyHarness(
      name,
      def,
      cwd,
      effectiveCmd,
      { ...extraEnv, ...tokenEnv, ...def.env, ...(opts?.env ?? {}), TACHYON_AGENT_NAME: name, ...this.hermesBriefEnv(def, effectiveInstructions) },
      preparedRuntimeHarness,
    );
    if (forced?.attempt) forced.attempt.materialized = "completed";
    this.applyDelegatedOpencodeHarnessPermission(def, spawnBuild.env, delegatedOpencode);
    // spec 236 — fold the runtime-Bridge env delta (the OPENCODE_CONFIG path for opencode agents)
    // into spawnBuild.env so it reaches the spawn env alongside the Bridge URL/token.
    const spawnBridge = this.withRuntimeBridge(name, def, spawnBuild.cmd, cwd, delegatedOpencode);
    // t-d42565 — recognized AI runtimes must receive Bridge MCP tools (notify_agent / doorbell) when
    // the workspace Bridge is up. Non-AI commands may still use kind:agent for lifecycle grouping.
    if (def.kind === "agent" && adapter && !spawnBridge.wired) {
      const bridgeUrl = this.opts.getExtraEnv?.()?.[URL_ENV_VAR];
      if (bridgeUrl) {
        throw new Error(
          `agent '${name}' spawn refused: Tachyon Bridge tools could not be materialized for this session ` +
            `(notify_agent / Bridge MCP would be unavailable; fix runtime wiring or materializers before spawn)`,
        );
      }
    }
    // Ownership materialization can write files. Complete it before replacing a dead incumbent so
    // every fallible launch-preparation step preserves the old postmortem pane on failure.
    const ownedSpawnCmd = this.withSessionOwnership(name, def, spawnBridge.cmd, {
      declared: !adhoc,
      cwd,
      configHome: spawnBuild.env.CLAUDE_CONFIG_DIR,
    });
    return { originalCmd, adapter, resumeId, selfManaged, spawnBridge, spawnBuild, ownedSpawnCmd };
    })().catch(async (error) => {
      if (launchTokenMinted) {
        try { revokeLaunchToken(); }
        catch { /* preserve the primary preparation failure; no runtime exists yet */ }
      }
      if (createdRuntimeHome) {
        try { this.opts.removeHarnessHome?.(name); }
        catch { /* preserve the primary preflight/preparation failure */ }
      }
      if (!forced && worktree && this.opts.rollbackPreparedWorktree) {
        try {
          await rollbackLaunchPreparation();
        } catch (preservation) {
          // t-7faea9 — rollback preservation always surfaces as AggregateError; Bridge clients only
          // see .message, so inline the primary preparation failure (e.g. missing oracle / primer).
          const primaryError = error instanceof Error ? error : new Error(String(error));
          throw new AggregateError(
            [primaryError, preservation instanceof Error ? preservation : new Error(String(preservation))],
            `agent '${name}' launch preparation failed: ${primaryError.message}; its worktree recovery state was preserved`,
            { cause: primaryError },
          );
        }
      }
      throw error;
    });
    const { originalCmd, adapter, resumeId, selfManaged, spawnBridge, spawnBuild, ownedSpawnCmd } = preparedLaunch;
    // Preparation and runtime preflight are now proven. Only now may an ordinary replacement
    // discard prior readiness/postmortem state; a rejected launch preserves its recovery handle.
    if (!forced?.attempt) clearTransientState();
    // All fallible guidance, cwd, harness, env and Bridge composition is complete. Only now may a
    // crashed incumbent be replaced; earlier failures leave its postmortem pane intact.
    if (replaceDeadSession) {
      try {
        await this.opts.tmux.killSession(session);
      } catch (error) {
        // Preparation and token materialization belong to the replacement attempt, but newSession has
        // not started. Revoke that unused credential and compensate only the newly-prepared checkout;
        // the incumbent dead pane remains the observable recovery handle.
        const primary = error instanceof Error ? error : new Error(String(error));
        const failures: Error[] = [primary];
        if (launchTokenMinted) {
          try { revokeLaunchToken(); }
          catch (cleanupError) { failures.push(new Error("failed to revoke token after dead-session replacement failure", { cause: cleanupError })); }
        }
        let preparationCompensated = false;
        try { preparationCompensated = await rollbackLaunchPreparation(); }
        catch (cleanupError) {
          failures.push(new Error(
            `agent worktree preparation could not be compensated at ${worktree?.path ?? cwd}; recovery state was preserved`,
            { cause: cleanupError },
          ));
        }
        if (worktree && !preparationCompensated && failures.length === 1) {
          failures.push(new Error(`agent worktree preparation has no automatic compensation at ${worktree.path}; inspect it before retry`));
        }
        throw new AggregateError(
          failures,
          `agent '${name}' could not replace its dead session` +
            (worktree
              ? `; ${preparationCompensated ? "compensated checkout" : "recovery checkout"}: ${worktree.path}`
              : `; launch cwd: ${cwd}`),
          { cause: primary },
        );
      }
    }
    if (forced?.attempt) forced.attempt.session = "attempted";
    try {
      await this.opts.tmux.newSession({
        name: session,
        // spec 236 Bridge + 243 ownership hook — apply ownership hook to the runtime-bridge cmd; the
        // env delta is folded into env below. t-0d0152 MemoryMax scope wraps outermost when configured.
        cmd: this.applyAgentMemoryScope(name, ownedSpawnCmd),
        cwd,
        env: { ...spawnBuild.env, ...spawnBridge.env },
      });
    } catch (error) {
      // Delivery owns its prepared worktree and has a separate receipt-aware recovery path. For an
      // ordinary launch, a same-named pane observed after newSession fails is ambiguous: it may belong
      // to a concurrent creator, so never kill it without an ownership receipt.
      if (forced) throw error;
      const cleanupErrors: Error[] = [];
      let sessionGone = false;
      try {
        sessionGone = !(await this.opts.tmux.hasSession(session));
      } catch (cleanupError) {
        cleanupErrors.push(new Error("failed to probe partially-created agent session", { cause: cleanupError }));
      }
      if (sessionGone) {
        if (launchTokenMinted) {
          try { revokeLaunchToken(); }
          catch (cleanupError) { cleanupErrors.push(new Error("failed to revoke token after session creation failure", { cause: cleanupError })); }
        }
        if (createdWorktree && !preparationHeadAfter) {
          cleanupErrors.push(new Error("session creation failed without an exact prepared HEAD; worktree recovery state was preserved"));
        } else {
          try { await rollbackLaunchPreparation(); }
          catch (cleanupError) { cleanupErrors.push(new Error("agent worktree recovery state was preserved instead of automatic cleanup", { cause: cleanupError })); }
        }
      } else {
        cleanupErrors.push(new Error("agent session creation is uncertain; worktree recovery state was preserved"));
      }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], `agent '${name}' session creation failed and compensation was incomplete`, { cause: error });
      }
      throw error;
    }
    if (forced?.attempt) {
      forced.attempt.session = "completed";
      clearTransientState();
    }

    // Once tmux reports a created runtime, even a readiness failure may follow legitimate writes.
    // Readiness owns session cleanup only; the checkout stays as recovery state.
    try {
      await this.observeLaunchReadiness(name, def.cmd, session);
    } catch (error) {
      const failures: Error[] = [error instanceof Error ? error : new Error(String(error))];
      let sessionGone = false;
      try { sessionGone = !(await this.opts.tmux.hasSession(session)); }
      catch (probeError) { failures.push(new Error("failed to verify rejected launch liveness", { cause: probeError })); }
      if (sessionGone && launchTokenMinted) {
        try { revokeLaunchToken(); }
        catch (revokeError) { failures.push(new Error("failed to revoke token after rejected launch", { cause: revokeError })); }
      }
      if (preparationLocked && worktree) {
        failures.push(new Error(`agent worktree recovery state was preserved at ${worktree.path}; inspect and unlock it explicitly before retry`));
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          `agent '${name}' launch readiness failed` + (worktree ? `; locked recovery checkout: ${worktree.path}` : ""),
          { cause: failures[0] },
        );
      }
      throw error;
    }

    // Persist ONLY after a successful spawn (spec 211: no phantom rows). Record a
    // `def` for every ad-hoc agent (drives restart + lineage, incl. non-AI `sh`);
    // a `resume` block only for adapter-backed runtimes.
    // Record when ad-hoc (restart/lineage), adapter-backed (resume), running in a worktree,
    // OR it has a parent — the worktree case covers a declared terminal/unknown-runtime
    // agent, and `parent` persists a declared non-adapter sub-agent's lineage so the
    // cleanup descendant-guard sees it after a reload (review fixes).
    // A conventional Delivery join may use a declared principal that already has
    // durable resume state.  It receives a new session, not ownership of that row.
    const preservesDeclaredLedger = !!forced?.attempt && forced.attempt.mode === "declared" && !!this.opts.ledger?.get(name);
    const defBlock = {
      cmd: originalCmd,
      kind: def.kind,
      ...(def.instructions ? { instructions: def.instructions } : {}),
      ...(def.role ? { role: def.role } : {}),
      ...(def.soul ? { soul: true } : {}),
      ...(taskBrief ? { taskBrief } : {}),
      ...(parent ? { parent } : {}),
      ...(delegator ? { delegator } : {}), // t-bae303 — persist so rehydrate can restore gated lineage after a reload
      ...(opts?.env ? { env: opts.env } : {}), // spec 230 — persist the node env so a restart re-applies the nonce
      ...(opts?.pipeline ? { pipeline: opts.pipeline } : {}), // spec 230 — pipeline-owned node (planResume skips it)
      ...(opts?.contract ? { contract: opts.contract } : {}), // spec 246 — structured delegation contract (D8)
      ...(opts?.contractSkipReason ? { contractSkipReason: opts.contractSkipReason } : {}), // spec 246 D6 — auditable bypass
    };
    const resumeBlock = adapter && !selfManaged ? this.withConfigHome(name, def, { runtime: adapter.runtime, sessionId: resumeId }) : undefined; // spec 240
    const promptCapability = openingPromptCapability(def.cmd);
    const identity = resolvedSoul ? this.soulSnapshot(resolvedSoul, promptCapability.status === "prompt" ? promptCapability.channel : "startup-argument") : undefined;
    const shouldPersistLaunch = !!this.opts.ledger && !preservesDeclaredLedger && !!(adhoc || adapter || worktree || parent);
    // A gated launch is restart-denied from its very first durable row. The marker is removed only
    // after the host has authenticated and persisted the delegation authority. This two-phase row
    // stays fail-closed even if canonical persistence and every subsequent cleanup write all fail.
    const delegationPending = !!opts?.gate && shouldPersistLaunch;
    const launchRecoveryRecord = {
      def: defBlock,
      resume: resumeBlock,
      worktree,
      cwd,
      declared: !adhoc,
      ...(identity ? { identity: { soul: identity, health: "offered" as const } } : {}),
      ...(delegationPending ? { delivery: { invalid: true as const } } : {}),
    };
    try {
      if (shouldPersistLaunch) {
        this.opts.ledger!.record(name, launchRecoveryRecord);
        if (forced?.attempt) forced.attempt.ledger = true;
      }
      // spec 364 — durable Bridge-client stamp after successful spawn with materialization.
      // Always stamp: preservesDeclaredLedger only protects principal def/resume/worktree/cwd
      // from ledger.record; stampBridgeClientBinding merges bridgeClient alone and must
      // reflect this incarnation's wiring (T13 R3 / t-0b5723).
      this.stampBridgeClientBinding(name, spawnBridge.wired);
    } catch (error) {
      // A runtime has passed creation/readiness, so it may already have changed its checkout. Never
      // roll that checkout back or unlock its quarantine. Terminate only the session whose creation
      // succeeded, prove absence before revoking its credential, and retain/retry an exact durable
      // worktree handle whenever the process may still be live.
      const primary = error instanceof Error ? error : new Error(String(error));
      const failures: Error[] = [primary];
      try { await this.opts.tmux.killSession(session); }
      catch (cleanupError) { failures.push(new Error("failed to kill runtime after launch persistence failure", { cause: cleanupError })); }
      let sessionGone = false;
      try { sessionGone = !(await this.opts.tmux.hasSession(session)); }
      catch (cleanupError) { failures.push(new Error("failed to verify runtime liveness after launch persistence failure", { cause: cleanupError })); }

      const hasDurableRecoveryHandle = (): boolean => {
        const durable = this.opts.ledger?.get(name);
        if (!durable || durable.cwd !== cwd) return false;
        if (!worktree) return true;
        return durable.worktree?.path === worktree.path && durable.worktree.branch === worktree.branch;
      };
      let durableRecoveryHandle = false;
      try { durableRecoveryHandle = hasDurableRecoveryHandle(); }
      catch (cleanupError) { failures.push(new Error("failed to inspect durable launch recovery handle", { cause: cleanupError })); }
      if (!sessionGone && !durableRecoveryHandle && shouldPersistLaunch) {
        try {
          this.opts.ledger!.record(name, launchRecoveryRecord);
          if (forced?.attempt) forced.attempt.ledger = true;
        } catch (cleanupError) {
          failures.push(new Error("failed to retry durable launch recovery handle", { cause: cleanupError }));
        }
        try { durableRecoveryHandle = hasDurableRecoveryHandle(); }
        catch (cleanupError) { failures.push(new Error("failed to verify retried durable launch recovery handle", { cause: cleanupError })); }
      }
      if (!sessionGone && !durableRecoveryHandle) {
        failures.push(new Error("runtime may still be live without a durable recovery handle"));
      }
      if (sessionGone) {
        clearTransientState();
        if (launchTokenMinted) {
          try { revokeLaunchToken(); }
          catch (cleanupError) { failures.push(new Error("failed to revoke token after launch persistence failure", { cause: cleanupError })); }
        }
      } else {
        failures.push(new Error("runtime may still be live; its token remains valid for the preserved recovery session"));
      }
      if (worktree) {
        failures.push(new Error(`agent worktree recovery state was preserved at ${worktree.path}; inspect and unlock it explicitly before retry`));
      }
      throw new AggregateError(
        failures,
        `agent '${name}' launch persistence failed` +
          (worktree ? `; locked recovery checkout: ${worktree.path}` : "") +
          (!sessionGone ? `; live recovery session: ${session}` : ""),
        { cause: primary },
      );
    }
    let canonicalReceipt: CanonicalDeliverySpawnReceipt | undefined;
    if (opts?.gate) {
      if (!opts.contract) throw new Error("gated delegation requires a validated delegation contract");
      if (!worktree) throw new Error("gated delegation requires an isolated worktree");
      try {
        if (!this.opts.recordCanonicalDelivery) {
          throw new Error("gated delegation requires canonical Delivery persistence");
        }
        canonicalReceipt = await this.opts.recordCanonicalDelivery({
          name,
          delegator,
          gate: opts.gate,
          contract: opts.contract,
          worktree,
          baseSha: delegationBaseSha ?? worktree.baseRef,
          verifySettings: verifySettingsSnapshot,
        });
        if (delegationPending) {
          const pending = this.opts.ledger?.get(name);
          if (!pending || !isInvalidDeliveryMarker(pending.delivery)) {
            throw new Error("gated delegation lost its pending lifecycle marker before authority commit");
          }
          const { delivery: _pendingMarker, ...authorized } = pending;
          this.opts.ledger!.record(name, authorized);
        }
      } catch (error) {
        // Keep the ledger/cwd as a visible recovery handle until tmux proves the runtime is dead.
        // Every eligible cleanup is attempted and failures retain the reconciliation error as cause.
        const cleanupErrors: Error[] = [];
        try { await this.opts.tmux.killSession(session); }
        catch (cleanupError) { cleanupErrors.push(new Error("failed to kill rejected delegated runtime", { cause: cleanupError })); }
        let sessionGone = false;
        try { sessionGone = !(await this.opts.tmux.hasSession(session)); }
        catch (cleanupError) { cleanupErrors.push(new Error("failed to verify rejected delegated runtime liveness", { cause: cleanupError })); }
        if (sessionGone) {
          if (launchTokenMinted) {
            try { revokeLaunchToken(); }
            catch (cleanupError) { cleanupErrors.push(new Error("failed to revoke rejected delegation token", { cause: cleanupError })); }
          }
          // The delegation contract never became durable. Once the runtime is proven absent, its
          // ordinary ledger row must not survive as an ungated restart/resume recipe after reload.
          try { this.opts.ledger?.remove(name); }
          catch (cleanupError) {
            cleanupErrors.push(new Error("failed to remove restartable ledger row after delegation rejection", { cause: cleanupError }));
            // A one-shot remove fault must still fail closed on reload. Reuse the typed invalid
            // Delivery marker: generic restart/resume already refuses every row carrying it.
            try {
              const recovery = this.opts.ledger?.get(name);
              if (recovery) this.opts.ledger?.record(name, { ...recovery, delivery: { invalid: true } });
            } catch (markerError) {
              cleanupErrors.push(new Error("failed to quarantine rejected delegation ledger row", { cause: markerError }));
            }
          }
          clearTransientState();
          // The runtime existed long enough to pass readiness and may have written legitimate work.
          // Keep the Git-quarantined checkout as the recovery receipt; deleting its current branch
          // tip could turn fast agent commits into dangling objects.
          cleanupErrors.push(new Error(`canonical Delivery persistence failed; checkout recovery state was preserved${worktree ? ` at ${worktree.path}` : ""}`));
        } else {
          cleanupErrors.push(new Error("rejected delegated runtime may still be live; durable recovery state was preserved"));
        }
        if (cleanupErrors.length) {
          throw new AggregateError([error, ...cleanupErrors], "delegation reconciliation failed and compensation was incomplete", { cause: error });
        }
        throw error;
      }
    }
    if (preparationLocked && worktree) {
      const durable = this.opts.ledger?.get(name)?.worktree;
      if (!durable || durable.path !== worktree.path || durable.branch !== worktree.branch) {
        this.opts.notify?.(`agent '${name}' started, but its worktree remains locked because durable ownership could not be confirmed`, "warn");
      } else if (!this.opts.completePreparedWorktree) {
        this.opts.notify?.(`agent '${name}' started, but its worktree remains locked because quarantine finalization is unavailable`, "warn");
      } else {
        try {
          await this.opts.completePreparedWorktree(worktree);
        } catch (error) {
          // Ownership and (for a gate) canonical Delivery intent are durable by this point. Keep the running
          // session and the Git lock as recoverable state; a failed unlock must never trigger teardown.
          this.opts.notify?.(
            `agent '${name}' started, but its worktree remains locked for recovery: ${error instanceof Error ? error.message : String(error)}`,
            "warn",
          );
        }
      }
    }
    if (adhoc) this.adhoc.set(name, { ...def, cmd: originalCmd });
    if (parent) this.lineage.set(name, parent);
    if (delegator) this.delegators.set(name, delegator);
    this.opts.onSpawned?.(name, opts?.reveal ?? true, { worktree, adhoc });
    await this.attachPaneTranscript(session);
    return canonicalReceipt;
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
   * spec 236 — the SINGLE place the Tachyon bridge MCP is injected so EVERY Tachyon-spawned agent reaches
   * `complete_node`/`write_input` with zero workspace-file config. Operates on the FINAL composed command
   * (after effectiveCmd + applyHarness) and is applied identically at spawn + restart + resume + fork:
   *   - harness agent → no-op: the Bridge is folded into its materialized --strict mcp file (mergeServers).
   *   - codex        → idempotent `-c mcp_servers.tachyon_bridge={…}` (token via bearer_token_env_var).
   *   - claude (non-harness) → append `--mcp-config <bridge file>` at the END (additive, no --strict; the
   *     trailing flag avoids claude's variadic --mcp-config swallowing the prompt positional). Token stays
   *     a `${TACHYON_BRIDGE_TOKEN}` ref in the file.
   *   - opencode (non-harness) → no argv change; materialize a per-agent Bridge-only opencode config file
   *     (the project opencode.json folded in if present) and inject its path via the OPENCODE_CONFIG env
   *     var (verified 1.17.15 — opencode loads that file instead of its cwd-discovered `opencode.json`).
   *     Token stays a `{env:TACHYON_AGENT_BRIDGE_TOKEN}` ref (opencode resolves `{env:VAR}` at runtime),
   *     so a per-agent token minted into the session env resolves to a strong identity with no secret on
   *     disk or argv.
   *   - grok (non-harness, t-843576) → no argv change; materialize a private GROK_HOME with
   *     `config.toml` carrying `[mcp_servers.tachyon_bridge]` (`Authorization: Bearer ${TACHYON_AGENT_BRIDGE_TOKEN}`)
   *     + `auth.json` symlink, and inject `GROK_HOME=<home>`. Never mutates the user's real `~/.grok`.
   *   - hermes (non-harness) → no argv change; materialize a private HERMES_HOME with
   *     `config.yaml` carrying `mcp_servers.tachyon_bridge` + `auth.json` symlink, inject `HERMES_HOME`.
   * No-op when the Bridge URL is absent (self-heals on the next (re)start). Generalizes spec 232 (the
   * pipeline-node gate is dropped — all codex/opencode-bridge spawns get it via this one call).
   */
  /**
   * Inject runtime-specific Bridge MCP wiring. Returns `wired: true` when Tachyon actually
   * applied materialization (spec 364 durable stamp predicate). Harness agents fold Bridge into
   * the private --strict mcp file in applyHarness; when the Bridge URL is present that counts as wired.
   */
  private withRuntimeBridge(
    name: string,
    def: Pick<AgentDef, "cmd" | "harness">,
    cmd: string,
    cwd?: string,
    delegated?: { workspaceRoot: string; worktreesBase: string },
  ): { cmd: string; env: Record<string, string>; wired: boolean } {
    const url = this.opts.getExtraEnv?.()?.[URL_ENV_VAR];
    if (def.harness) {
      // Bridge is folded into the materialized harness MCP file (Workspace passes bridgeEntry when up).
      return { cmd, env: {}, wired: !!url };
    }
    if (!url) return { cmd, env: {}, wired: false };
    const binary = binaryOf(def.cmd);
    if (binary === "codex") return { cmd: codexBridgeCmd(cmd, url), env: {}, wired: true };
    if (binary === "claude") {
      const file = this.opts.materializeBridgeMcp?.(name);
      if (!file) return { cmd, env: {}, wired: false };
      // A user-supplied --strict-mcp-config makes claude ignore the project/global MCP; our injected file
      // still loads (Bridge works) but the additive-over-project promise is void → advise. --safe-mode
      // disables MCP entirely → injection can't help.
      if (/(^|\s)--strict-mcp-config(=|\s|$)/.test(def.cmd)) {
        this.opts.notify?.(`agent '${name}': its command sets --strict-mcp-config, so only Tachyon's injected Bridge + your --mcp-config files load (the project .mcp.json is ignored)`, "warn");
      }
      if (/(^|\s)--safe-mode(=|\s|$)/.test(def.cmd)) {
        this.opts.notify?.(`agent '${name}': its command sets --safe-mode, which disables MCP — it won't reach the Tachyon Bridge`, "warn");
      }
      return { cmd: `${cmd} --mcp-config ${shellQuote(file)}`, env: {}, wired: true };
    }
    if (binary === "opencode") {
      const file = this.opts.materializeBridgeMcpOpencode?.(name, cwd ?? this.opts.workspaceRoot);
      if (!file) return { cmd, env: {}, wired: false };
      if (delegated) this.applyDelegatedOpencodePermission(file, delegated);
      return { cmd, env: { [OPENCODE_CONFIG_ENV_VAR]: file }, wired: true };
    }
    if (binary === "grok") {
      const home = this.opts.materializeBridgeMcpGrok?.(name, cwd ?? this.opts.workspaceRoot);
      if (!home) return { cmd, env: {}, wired: false };
      return { cmd, env: { GROK_HOME: home }, wired: true };
    }
    if (binary === "hermes") {
      const home = this.opts.materializeBridgeMcpHermes?.(name);
      if (!home) return { cmd, env: {}, wired: false };
      return { cmd, env: { HERMES_HOME: home }, wired: true };
    }
    return { cmd, env: {}, wired: false };
  }

  /**
   * spec 364 — persist the Bridge materialization outcome for every successful spawn/resume.
   * A new process that did not receive Bridge wiring must replace a prior incarnation's
   * `wired: true` stamp instead of inheriting its healthy-looking durable state.
   */
  private stampBridgeClientBinding(name: string, wired: boolean): void {
    if (!this.opts.ledger) return;
    const rec = this.opts.ledger.get(name);
    if (!rec) return;
    const boundGeneration = this.opts.getBridgeGeneration?.() ?? 0;
    this.opts.ledger.record(name, {
      ...rec,
      bridgeClient: { boundGeneration, wired },
    });
  }

  private worktreesBaseFor(cwd: string, worktree?: WorktreeRecord): string {
    if (worktree?.path) return path.dirname(worktree.path);
    const marker = `${path.sep}.cache${path.sep}tachyon${path.sep}worktrees${path.sep}`;
    const idx = cwd.indexOf(marker);
    if (idx >= 0) {
      const start = idx + marker.length;
      const end = cwd.indexOf(path.sep, start);
      if (end > start) return cwd.slice(0, end);
    }
    return path.join(
      resolveWorktreeBase(this.opts.getConfig()?.settings ?? ({} as TachyonConfig["settings"]), process.env, (this.opts.homeDir ?? os.homedir)()),
      this.opts.wsHash,
    );
  }

  private applyDelegatedOpencodePermission(file: string, ctx: { workspaceRoot: string; worktreesBase: string }): void {
    try {
      const existing = fs.readFileSync(file, "utf8");
      const content = setOpencodePermission(existing, delegatedOpencodePermission(ctx.workspaceRoot, ctx.worktreesBase));
      fs.writeFileSync(file, content, "utf8");
    } catch (err) {
      this.opts.notify?.(`agent opencode config at '${file}': could not apply delegated permission block: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }

  /**
   * Generation site (b) — the harness `XDG_CONFIG_HOME/opencode/opencode.json` path, for a
   * `harness:`-declared opencode agent. Security review (782f1c6, MEDIUM): this is currently DEAD CODE —
   * `delegated` (parent/delegator/gate-derived) and `def.harness` can never both be truthy today, because
   * every path that produces a `delegated` lineage (spawn/restart/resume) requires an ad-hoc `def`, and an
   * ad-hoc `def` never carries a `harness` key (`SpawnOptions` has no `harness` param). Every currently
   * possible delegated opencode agent is non-harness-declared and is covered by generation site (a)
   * (`applyDelegatedOpencodePermission` via `withRuntimeBridge`) instead. Left in place (not removed) so a
   * future change that lets an ad-hoc/gated spawn carry a `harness:` block is covered without a second fix —
   * but don't read "both sites covered" as true of the population that exists today.
   */
  private applyDelegatedOpencodeHarnessPermission(
    def: Pick<AgentDef, "cmd" | "harness"> | undefined,
    env: Record<string, string>,
    delegated?: { workspaceRoot: string; worktreesBase: string },
  ): void {
    if (!delegated || binaryOf(def?.cmd ?? "") !== "opencode" || !def?.harness) return;
    const configHome = env.XDG_CONFIG_HOME;
    if (!configHome) return;
    this.applyDelegatedOpencodePermission(path.join(configHome, "opencode", "opencode.json"), delegated);
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
  /**
   * t-0d0152 — wrap pane command in systemd --user scope with MemoryMax when configured.
   * Fail-open (returns cmd unchanged) when off, non-Linux, or wrap fails.
   */
  private applyAgentMemoryScope(agentName: string, cmd: string): string {
    const fromYml = parseAgentMemoryMax(this.opts.getConfig()?.settings.agentMemoryMax);
    const fromHost = parseAgentMemoryMax(this.opts.getAgentMemoryMax?.());
    const memoryMax = fromYml ?? fromHost;
    if (!memoryMax) return cmd;
    const support = agentMemoryScopeSupport();
    if (!support.ok) {
      this.opts.notify?.(
        `settings.agentMemoryMax=${memoryMax} ignored: ${support.reason}`,
        "warn",
      );
      return cmd;
    }
    const unit = agentMemoryScopeUnitName(
      this.opts.wsHash,
      agentName,
      crypto.randomBytes(4).toString("hex"),
    );
    try {
      return wrapAgentMemoryScopeCommand(unit, memoryMax, cmd);
    } catch (error) {
      this.opts.notify?.(
        `settings.agentMemoryMax wrap failed for '${agentName}': ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return cmd;
    }
  }

  private withSessionOwnership(
    name: string,
    def: Pick<AgentDef, "cmd">,
    cmd: string,
    opts: { declared: boolean; cwd: string; configHome?: string; preservePermissionMode?: boolean },
  ): string {
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
      // t-554634 option C + t-bc8d21: scoped managed-hook trust (only when Tachyon injected hooks).
      return applyManagedHookTrust(withConfig, {
        injected: true,
        kind: "session-config-flag",
        runtime: managedHookRuntimeOf(binary),
      });
    }
    if (binary !== "claude") {
      // Grok/Hermes/OpenCode: no withSessionOwnership lifecycle injection today.
      // Grok harness private-home hooks are trusted via seedGrokTrustedFolders at materialize time.
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    if (/(^|\s)--settings(=|\s|$)/.test(def.cmd)) {
      this.opts.notify?.(`agent '${name}': its command sets --settings, so Tachyon's session-ownership hook is not injected — its Activity may not follow a /clear on a shared cwd`, "warn");
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    const file = this.opts.materializeOwnershipSettings?.(name, {
      ownershipOnly,
      cwd: opts.cwd,
      configHome: opts.configHome ?? this.defaultClaudeConfigHome(),
      // An explicit source filter changes which lower-precedence statusLine Claude would see. Until Tachyon parses
      // that CLI value exactly, keep lifecycle hooks but omit capture instead of reviving an excluded user setting.
      statusLineCapture: !/(^|\s)--setting-sources(=|\s|$)/.test(def.cmd),
    });
    this.opts.onSessionHooksInjected?.(name, !!file);
    if (!file) return cmd;
    let out = `${cmd} --settings ${shellQuote(file)}`;
    out = applyManagedHookTrust(out, {
      injected: true,
      kind: "session-settings",
      runtime: managedHookRuntimeOf(binary),
    });
    if (ownershipOnly
      && !opts.preservePermissionMode
      && !/(^|\s)--permission-mode(=|\s|$)/.test(out)
      && !/(^|\s)--dangerously-skip-permissions(=|\s|$)/.test(out)) {
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
    this.stopFailed.delete(name);
    this.readinessCache.delete(name); // spec 221: kill refreshes ownership (sessionId may change) → drop cache
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    await this.refreshOwnership(name); // A3: capture an in-TUI /resume before the session ends
    await this.detachPaneTranscript(session);
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
    await this.opts.onKilled?.(name);
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
    this.stopFailed.delete(name);
    this.opts.onStopping?.(name);
    try {
      await this.refreshOwnership(name); // capture an in-TUI /resume before asking the process to exit
      const gracefulStop = gracefulStopForCommand(this.definitionOf(name)?.cmd ?? "");
      for (const step of gracefulStop.steps) {
        if (step.type === "interruptActiveTurn") {
          await this.interruptActiveTurn(session);
        } else if (step.type === "sendKey") {
          await this.opts.tmux.sendKey(session, step.key);
        } else {
          await sleep(step.delayMs);
          const state = (await this.opts.tmux.sessionStates(session))?.get(session);
          if (state && !state.dead) await this.opts.tmux.sendKey(session, step.key);
        }
      }
    } catch (err) {
      this.stoppingSince.delete(name);
      this.stopFailed.delete(name);
      throw err;
    }
  }

  private async interruptActiveTurn(session: string): Promise<void> {
    let pane = "";
    try {
      // Parser (isCodexTurnActive) — join soft wraps (t-24e0f8).
      pane = await this.opts.tmux.capturePane(session, { joinWrapped: true });
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
    this.stopFailed.delete(name);
    if (!state?.dead || state.exitCode !== 0) return false;
    await this.capturePostmortemOutput(name, session);
    await this.detachPaneTranscript(session);
    await this.opts.tmux.killSession(session);
    this.cleanExited.add(name);
    return true;
  }

  /**
   * t-6a6a00 — attach the durable pane-transcript pipe after spawn/restart/resume/fork.
   * TmuxService.pipePane is idempotent (safe to call on an already-piping pane — see its doc
   * comment for why it deliberately avoids `-o`), so this can be called unconditionally on every
   * lifecycle transition without needing to know whether the pane is fresh (kill+new fallback, a
   * fork) or preserved (a happy-path respawn-pane restart/resume).
   * Best-effort and silent: a durability side-channel must never fail or warn-spam a spawn/restart/
   * fork whose actual runtime succeeded (e.g. an unwritable workspace root, or pre-3.2 tmux missing
   * pipe-pane semantics some distro forks ship).
   */
  private async attachPaneTranscript(session: string): Promise<void> {
    const name = agentFromSession(this.opts.wsHash, session);
    if (!name) return;
    try {
      const file = ensurePaneTranscriptFile(this.opts.workspaceRoot, name);
      rotatePaneTranscriptIfNeeded(file);
      await this.opts.tmux.pipePane({ target: session, file });
    } catch {
      /* best-effort durability feature — never blocks the caller's actual lifecycle transition */
    }
  }

  /** t-6a6a00 — detach the durable pane-transcript pipe before an explicit kill. Best-effort: the
   *  session may already be gone, and a failure here must never block the kill itself. */
  private async detachPaneTranscript(session: string): Promise<void> {
    try {
      await this.opts.tmux.unpipePane(session);
    } catch {
      /* best-effort */
    }
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
      // so lineage survives a rename across a restart. t-bae303: mirror this for `delegator`
      // (a gated child's persisted lineage), or a renamed delegator's gated children would
      // point at a name that no longer exists after the next reload.
      for (const [child, crec] of this.opts.ledger.all()) {
        if (crec.def?.parent === oldName || crec.def?.delegator === oldName) {
          this.opts.ledger.record(child, {
            ...crec,
            def: {
              ...crec.def,
              ...(crec.def?.parent === oldName ? { parent: newName } : {}),
              ...(crec.def?.delegator === oldName ? { delegator: newName } : {}),
            },
          });
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

  /**
   * Run `cmd` in `session`: prefer `respawn-pane -k` when the session exists so
   * attached clients and scrollback survive (t-4d2630). Fall back to kill + new-session
   * when there is no session or respawn fails. Paths that truly need a new session
   * object (rename/namespace) keep calling kill/new directly.
   *
   * `onBeforeKillNew` runs only on the kill+new path (e.g. UI terminal close for restart).
   */
  private async startSessionCommand(opts: {
    session: string;
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    onBeforeKillNew?: () => void;
    onReplacementAttempt?: () => void;
  }): Promise<"respawned" | "created"> {
    const agentName = agentFromSession(this.opts.wsHash, opts.session) ?? opts.session;
    const cmd = this.applyAgentMemoryScope(agentName, opts.cmd);
    const { session, cwd, env } = opts;
    if (await this.opts.tmux.hasSession(session)) {
      try {
        opts.onReplacementAttempt?.();
        await this.opts.tmux.respawnPane({ target: session, cmd, cwd, env });
        await this.attachPaneTranscript(session);
        return "respawned";
      } catch (respawnError) {
        opts.onBeforeKillNew?.();
        try {
          await this.opts.tmux.killSession(session);
        } catch (killError) {
          throw new AggregateError(
            [respawnError, killError],
            `could not replace session '${session}': respawn and teardown both failed`,
            { cause: respawnError },
          );
        }
        let absent: boolean;
        try {
          absent = !(await this.opts.tmux.hasSession(session));
        } catch (probeError) {
          throw new AggregateError(
            [respawnError, probeError],
            `could not prove old session '${session}' absent after replacement teardown`,
            { cause: respawnError },
          );
        }
        if (!absent) throw new Error(`could not replace session '${session}': old session remains live after teardown`);
        opts.onReplacementAttempt?.();
        await this.opts.tmux.newSession({ name: session, cmd, cwd, env });
        await this.attachPaneTranscript(session);
        return "created";
      }
    }
    opts.onReplacementAttempt?.();
    await this.opts.tmux.newSession({ name: session, cmd, cwd, env });
    await this.attachPaneTranscript(session);
    return "created";
  }

  /**
   * spec 389 — restart matrix: stop (graceful|force) × session (resume|new).
   * Product default: graceful + resume (fallback to new). Crash/watch callers pass force+new.
   *
   * Graceful stop marks `stoppingSince` for the sidebar. That flag is for user Stop only —
   * after we intentionally bring the process back (resume/fresh), it MUST be cleared or the
   * row sticks on "stopping…" then flips to stop-failed while the pane is already live.
   */
  async restart(name: string, opts: RestartOptions = {}): Promise<RestartResult> {
    // SDD 368 T14 — refuse before any stop/replace mutation.
    this.assertNotDeliveryLifecycleDenied(name, "restart");
    const stop: RestartStopMode = opts.stop ?? RESTART_DEFAULTS.stop;
    const session: RestartSessionMode = opts.session ?? RESTART_DEFAULTS.session;
    const gracefulTimeoutMs = opts.gracefulTimeoutMs ?? AgentManager.STOPPING_FALLBACK_MS;
    let forcedAfterGracefulTimeout = false;

    try {
      const alive = await this.isProcessAlive(name);
      if (alive) {
        if (stop === "graceful") {
          try {
            await this.stopGracefully(name);
          } catch {
            // Half-dead / already exiting — still wait, then hard-kill if needed.
          }
          const died = await this.waitUntilProcessDead(name, gracefulTimeoutMs);
          if (!died) {
            forcedAfterGracefulTimeout = true;
            await this.hardKillSessionOnly(name);
          }
        } else if (session === "new") {
          // force + new: in-place replace (historical restart semantics).
          await this.restartFresh(name);
          return { stop, session, resumed: false, forcedAfterGracefulTimeout };
        } else {
          // force + resume: replace onto resume command; fall back to fresh if unavailable.
          if (await this.opts.tmux.hasSession(this.session(name))) {
            await this.refreshOwnership(name);
          }
          if (await this.tryResumeAfterStop(name)) {
            return { stop, session, resumed: true, forcedAfterGracefulTimeout };
          }
          await this.restartFresh(name);
          return { stop, session, resumed: false, forcedAfterGracefulTimeout };
        }
      }

      // Stop phase over (or already stopped). Drop "stopping" before start so resume/fresh
      // cannot leave a live pane stuck in the graceful-stop UI state.
      this.clearStoppingState(name);

      if (session === "resume" && (await this.tryResumeAfterStop(name))) {
        return { stop, session, resumed: true, forcedAfterGracefulTimeout };
      }
      await this.restartFresh(name);
      return { stop, session, resumed: false, forcedAfterGracefulTimeout };
    } catch (error) {
      // Start failed after a graceful stop attempt — don't leave a permanent "stopping" badge.
      this.clearStoppingState(name);
      throw error;
    }
  }

  /** Clear graceful-stop UI flags (used when restart/resume owns the lifecycle again). */
  private clearStoppingState(name: string): void {
    this.stoppingSince.delete(name);
    this.stopFailed.delete(name);
  }

  /** True when the named entry has a live (non-dead) pane process. */
  private async isProcessAlive(name: string): Promise<boolean> {
    const state = (await this.agentStates()).get(name);
    return !!state && !state.dead;
  }

  /** Poll until the process is dead or the budget expires. Returns true if dead. */
  private async waitUntilProcessDead(name: string, timeoutMs: number): Promise<boolean> {
    if (!(await this.isProcessAlive(name))) return true;
    if (timeoutMs <= 0) return !(await this.isProcessAlive(name));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isProcessAlive(name))) return true;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return !(await this.isProcessAlive(name));
  }

  /**
   * Kill the tmux session only — never AgentManager.kill (that wipes ad-hoc ledger rows).
   * Used when graceful stop times out during a restart.
   */
  private async hardKillSessionOnly(name: string): Promise<void> {
    this.stoppingSince.delete(name);
    this.stopFailed.delete(name);
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) return;
    try {
      await this.refreshOwnership(name);
    } catch {
      /* best-effort capture before teardown */
    }
    await this.detachPaneTranscript(session);
    await this.opts.tmux.killSession(session);
  }

  /** Attempt resume after stop; false when no resumable record / ResumeUnavailableError. */
  private async tryResumeAfterStop(name: string): Promise<boolean> {
    const record = this.opts.ledger?.get(name);
    if (!record?.resume) return false;
    try {
      await this.resume(name, record);
      return true;
    } catch (err) {
      if (err instanceof ResumeUnavailableError) return false;
      throw err;
    }
  }

  /**
   * Force-replace / new-section restart: kill-ish respawn with the same definition (pre-389 path).
   * Mints a fresh session title for title-tracked runtimes.
   */
  private async restartFresh(name: string): Promise<void> {
    // SDD 368 T14 — refuse before mutating transient caches (readiness/postmortem/stopping).
    this.assertNotDeliveryLifecycleDenied(name, "restart");
    let def = this.definitionOf(name);
    if (!def) {
      throw new Error(
        `cannot restart '${name}': no stored definition (re-discovered ad-hoc agents lose their definition across extension restarts — kill and re-spawn instead)`,
      );
    }
    // Project guidance is part of the replacement command. Load it before even transient restart
    // state changes so an invalid configured source leaves the live pane and its status untouched.
    const projectGuidance = this.projectGuidanceFor(def);
    const resolvedSoul = def.soul ? await this.reserveSoulLaunch(name, this.soulPrincipal(name), def) : undefined;
    const session = this.session(name);
    let worktree: WorktreeRecord | undefined;
    let preparationLocked = false;
    let restartTokenMinted = false;
    let replacementAttempted = false;
    try {
    const restartPrimerCtx = {
      delegator: this.delegators.get(name),
      freshWorktree: false as const,
      verify: this.opts.getConfig()?.settings.verify,
    };
    const restartParent = this.lineage.get(name);
    // Resolve the exact reused cwd/private home before any live-pane or transient-state mutation.
    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({ name, def, parent: restartParent, adhoc: this.adhoc.has(name), isRestart: true });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
        preparationLocked = resolved.preparationLocked === true;
      }
    }
    const restartHarness = this.materializeRuntimeHarness(name, def, cwd);
    await this.assertLaunchPreflight(
      name,
      def.cmd,
      { ...this.opts.getExtraEnv?.(), ...def.env, ...(restartHarness?.env ?? {}) },
      this.adhoc.has(name),
      cwd,
    );
    // `effectiveInstructions` includes long-brief persistence. It must succeed before cache changes,
    // ownership refresh, respawn, or kill+new fallback can mutate the running session.
    const restartInstructions = this.effectiveInstructions(
      name,
      def,
      restartParent,
      restartPrimerCtx,
      this.opts.ledger?.get(name)?.def?.taskBrief,
      resolvedSoul,
      projectGuidance,
    );
    this.stoppingSince.delete(name);
    this.stopFailed.delete(name);
    this.readinessCache.delete(name); // spec 221: restart is a new session → drop the cached badge
    this.cleanExited.delete(name);
    this.postmortemOutput.delete(name);
    // A3: capture an in-TUI /resume before the process is replaced (respawn or kill).
    if (await this.opts.tmux.hasSession(session)) {
      await this.refreshOwnership(name);
    }
    // spec 220: re-inject the resume id (claude `-n <name>`) so the RESTARTED session carries the
    // customTitle — else refreshOwnership/resume would match the pre-restart session by title and
    // resume the old conversation. Reset the ledger resume id back to the name so the next
    // refresh/resume re-resolves to the NEWEST title match (the restarted session), not a stale uuid.
    const injected = this.injectResumeId(name, def);
    def = injected.def;
    // spec 363 T3 — restart redelivers the composed instructions (same effectiveCmd path as spawn).
    // Security review (782f1c6, HIGH): mirror spawn's isolatedWorktree gate — a restarted delegation
    // reusing a shared (non-worktree) cwd must not get blanket bash:"allow" either.
    const restartDelegatedOpencode = (this.lineage.get(name) || this.delegators.get(name)) && worktree
      ? { workspaceRoot: this.opts.workspaceRoot, worktreesBase: this.worktreesBaseFor(cwd, worktree) }
      : undefined;
    const restartBuild = this.applyHarness(
      name,
      def,
      cwd,
      this.effectiveCmd(def, restartInstructions),
      {
        ...this.opts.getExtraEnv?.(),
        ...def.env,
        TACHYON_AGENT_NAME: name,
        ...this.hermesBriefEnv(def, restartInstructions),
      },
      restartHarness,
    );
    this.applyDelegatedOpencodeHarnessPermission(def, restartBuild.env, restartDelegatedOpencode);
    const restartBridge = this.withRuntimeBridge(name, def, restartBuild.cmd, cwd, restartDelegatedOpencode);
    const restartOwnedCmd = this.withSessionOwnership(name, def, restartBridge.cmd, {
      declared: !this.adhoc.has(name),
      cwd,
      configHome: restartBuild.env.CLAUDE_CONFIG_DIR,
    });
    // mint() revokes the incumbent credential. Wait until every fallible composition/materialization
    // step has completed so a preparation error cannot strand an unchanged live pane.
    const restartTokenEnv = this.opts.mintAgentToken?.(name);
    restartTokenMinted = restartTokenEnv !== undefined && Object.keys(restartTokenEnv).length > 0;
    // t-4d2630: respawn in place when the session exists (clients + scrollback stay).
    // onRestart UI close only on kill+new fallback — unnecessary when respawn keeps the attach.
    await this.startSessionCommand({
      session,
      cmd: restartOwnedCmd, // spec 236 Bridge + 243 ownership hook
      cwd,
      env: { ...restartBuild.env, ...restartBridge.env, ...restartTokenEnv }, // host token wins over project env
      onBeforeKillNew: () => this.opts.onRestart?.(name),
      onReplacementAttempt: () => { replacementAttempted = true; },
    });
    // Restart reuses its existing worktree/ledger state, so rejection compensation is
    // session-only; do not erase the durable record needed for a later recovery.
    await this.observeLaunchReadiness(name, def.cmd, session);
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
      const capability = openingPromptCapability(def.cmd);
      const soul = resolvedSoul && capability.status === "prompt" ? this.soulSnapshot(resolvedSoul, capability.channel) : existing?.identity?.soul;
      const identity = soul ? { soul, health: "offered" as const } : existing?.identity;
      this.opts.ledger.record(name, { ...(existing ?? { declared: !this.adhoc.has(name) }), cwd, ...(worktree ? { worktree } : {}), resume, identity });
    }
    if (preparationLocked && worktree) {
      const durable = this.opts.ledger?.get(name)?.worktree;
      if (!durable || durable.path !== worktree.path || durable.branch !== worktree.branch) {
        this.opts.notify?.(`agent '${name}' restarted, but its worktree remains locked because durable ownership could not be confirmed`, "warn");
      } else if (!this.opts.completePreparedWorktree) {
        this.opts.notify?.(`agent '${name}' restarted, but its worktree remains locked because quarantine finalization is unavailable`, "warn");
      } else {
        try {
          await this.opts.completePreparedWorktree(worktree);
          preparationLocked = false;
        } catch (error) {
          this.opts.notify?.(
            `agent '${name}' restarted, but its worktree remains locked for recovery: ${error instanceof Error ? error.message : String(error)}`,
            "warn",
          );
        }
      }
    }
    // spec 364 — restart is a fresh process with Bridge re-injection; stamp generation.
    this.stampBridgeClientBinding(name, restartBridge.wired);
    this.opts.onSpawned?.(name, true); // restart is a human action — reveal (existing attach or fresh open)
    } catch (error) {
      const primary = error instanceof Error ? error : new Error(String(error));
      const failures: Error[] = [primary];
      let sessionAbsent = false;
      try { sessionAbsent = !(await this.opts.tmux.hasSession(session)); }
      catch (probeError) { failures.push(new Error("failed to verify restart session liveness", { cause: probeError })); }
      if (restartTokenMinted && (!replacementAttempted || sessionAbsent)) {
        try { this.opts.revokeAgentToken?.(name); }
        catch (revokeError) { failures.push(new Error("failed to revoke unconfirmed restart token", { cause: revokeError })); }
      }
      if (preparationLocked && worktree) {
        failures.push(new Error(`restart worktree recovery state was preserved at ${worktree.path}; inspect and unlock it explicitly before retry`));
        throw new AggregateError(
          failures,
          `agent '${name}' restart failed: ${primary.message}; locked recovery checkout: ${worktree.path}`,
          { cause: primary },
        );
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `agent '${name}' restart failed: ${primary.message}`, { cause: primary });
      }
      throw primary;
    } finally {
      this.releaseSoulReservation(name);
    }
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
    // SDD 368 T14 — valid/invalid markers and snapshot-unavailable agents never report ready
    // for generic resume (explicit deliveryJoin recovery only).
    if (this.isDeliveryLifecycleDenied(name, record)) return false;
    const sid = record.resume?.sessionId ?? "";
    const cached = this.readinessCache.get(name);
    if (cached && cached.sessionId === sid) return cached.ready;
    const ready = (await this.computeResumeReadiness(name, record)).kind === "ready";
    this.readinessCache.set(name, { sessionId: sid, ready });
    return ready;
  }

  /**
   * spec 388 / t-769666 — fresh generic-resume probe for Bridge-client rebind.
   *
   * This deliberately neither reads nor writes `readinessCache`: a capture runtime can keep the same
   * empty ledger sessionId while its transcript appears, whereas ordinary sidebar reads must retain
   * their bounded cache.  Delivery authority is checked on both sides of the asynchronous resolver so
   * a denial that appears during the probe cannot admit destructive teardown.
   */
  async rebindResumeReadiness(name: string, record: SessionRecord): Promise<RebindResumeReadiness> {
    if (this.isDeliveryLifecycleDenied(name, record)) {
      return { kind: "denied", reason: "generic resume is denied by Delivery lifecycle authority" };
    }
    const result = await this.computeResumeReadiness(name, record);
    if (this.isDeliveryLifecycleDenied(name, record)) {
      return { kind: "denied", reason: "generic resume became denied by Delivery lifecycle authority" };
    }
    return result;
  }

  /**
   * Synchronous final admission guard for rebind.  The coordinator calls this after every awaited
   * readiness/liveness probe and once more immediately before teardown, so a Delivery marker or
   * crash-window deny that appeared after an earlier positive result still wins.
   */
  rebindResumeDenied(name: string, record: SessionRecord): boolean {
    return this.isDeliveryLifecycleDenied(name, record);
  }

  private async computeResumeReadiness(name: string, record: SessionRecord): Promise<RebindResumeReadiness> {
    if (!record.resume) return { kind: "denied", reason: "record has no resume block" };
    if (!record.def?.cmd) {
      // resume() rejects a record with no command — mirror it, or the badge lies.
      return { kind: "denied", reason: "record has no command to resume" };
    }
    const { runtime } = record.resume;
    const adapter = adapterForRuntime(runtime);
    if (!adapter) return { kind: "denied", reason: `no resume adapter for '${runtime}'` };
    if (adapter.resumesWithoutId) return { kind: "ready" }; // qwen --continue resumes the cwd's last session
    const cwd = path.resolve(record.cwd);
    const configHome = this.effectiveHome(name, record); // spec 226 (H2) / 240 — persisted home wins
    const exists = this.opts.fileExists ?? fs.existsSync;
    // spec 244 — mirror resume()'s target resolution: if the spec-243 ownership ledger points at a live owned
    // session, the badge must read READY (else a crash that left the stored id stale shows "fresh start" while
    // Resume would in fact reopen the owned session — codex). Owner-first, transcript-validated under this home.
    const owned = this.opts.ownedSession?.(name, cwd);
    if (owned && exists(owned.transcriptPath)) return { kind: "ready" };
    let id = record.resume.sessionId;
    if (runtime === "claude" && this.opts.resolveCurrentSession && id && !this.isUuid(id)) {
      id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? id;
    }
    if (!id) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    if (!id) return { kind: "retry", reason: "session id has not been captured yet" };
    if (adapter.transcriptPath) {
      return exists(adapter.transcriptPath(configHome, cwd, id))
        ? { kind: "ready" }
        : { kind: "retry", reason: "session transcript is not on disk yet" };
    }
    return { kind: "ready" }; // capture runtime with an id but no derivable path — resume attempts it
  }

  /**
   * spec 238 — resolve the on-disk transcript for an agent's CURRENT session, for the activity view to
   * tail. Mirrors the resume id-resolution (claude name→uuid, capture fallback) but NEVER spawns. Returns
   * the path + runtime when a transcript file exists, else undefined (the view then degrades to the
   * raw-only/terminal escape hatch). Capture runtimes whose transcript path is not derivable from the id
   * use `resolveCaptureSession` when implemented (v1: codex).
   */
  async transcriptPathOf(
    name: string,
    opts: { live?: boolean } = {},
  ): Promise<{ path: string; runtime: ResumeRuntime; sessionId?: string } | undefined> {
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
      if (owned && exists(owned.transcriptPath)) {
        return { path: owned.transcriptPath, runtime, sessionId: owned.sessionId };
      }
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
    if (runtime === "codex" || runtime === "opencode") {
      const exists = this.opts.fileExists ?? fs.existsSync;
      const resolve = this.opts.resolveCaptureSession;
      if (id) {
        const loc = await resolve?.(runtime, cwd, configHome, id);
        if (loc && exists(loc.path)) {
          return {
            path: runtime === "opencode" ? path.join(loc.path, `${loc.id}.jsonl`) : loc.path,
            runtime,
            sessionId: loc.id,
          };
        }
      }
      if (opts.live && !shared) {
        const loc = await resolve?.(runtime, cwd, configHome);
        if (loc && exists(loc.path)) {
          return {
            path: runtime === "opencode" ? path.join(loc.path, `${loc.id}.jsonl`) : loc.path,
            runtime,
            sessionId: loc.id,
          };
        }
      }
      // Shared cwd with no authoritative row/path is an attribution gap, never a newest-by-cwd guess.
      return undefined;
    }
    // Hermes: resolve session id via state.db (capture), path is always `$HERMES_HOME/state.db`.
    if (runtime === "hermes") {
      if (opts.live && !shared) {
        // `/resume` can reactivate an older row in the same private state.db. The stored id is only
        // a launch-time capture; live Activity must follow the current resolver. Same cwd remains safe
        // when configHome differs because the ambiguity check above includes both namespaces.
        id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? id;
      } else if (!id && !shared) {
        id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
      }
      if (!id) return undefined;
      if (!adapter.transcriptPath) return undefined;
      const p = adapter.transcriptPath(configHome, cwd, id);
      const exists = this.opts.fileExists ?? fs.existsSync;
      return exists(p) ? { path: p, runtime, sessionId: id } : undefined;
    }
    // The bare cwd-scan ("newest in this dir") is the ONLY ambiguous fallback — on a SHARED cwd it could
    // return another agent's session, so skip it there (return undefined → caller treats as a gap). A captured
    // uuid or a unique-title resolve above is safe on shared cwd; this guards only the id-less case.
    if (!id && !shared) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    if (!id) return undefined;
    if (!adapter.transcriptPath) return undefined;
    const p = adapter.transcriptPath(configHome, cwd, id);
    const exists = this.opts.fileExists ?? fs.existsSync;
    return exists(p) ? { path: p, runtime, sessionId: id } : undefined;
  }

  /**
   * Respawns an agent from a ledger record with the runtime's resume command, so it
   * recovers its prior conversation (spec 209). For capture runtimes with no stored
   * id, resolves it from disk by cwd. Throws ResumeUnavailableError when the id can't
   * be resolved or the transcript is gone — the caller falls back to a fresh spawn.
   *
   * @param opts.injectPrimer — when true, re-types the spec 363 primer into the pane after
   *   launch. **Default is false** for all runtimes: resume re-attaches the transcript + Bridge
   *   only. Pasting primer+Enter on every stop/resume stranded draft noise in TUI composers
   *   (dogfood 2026-07-14) and was already forbidden for host rebind (t-762940 / spec 364).
   *   Spawn, restart, and re-anchor still deliver the primer; opt-in true remains for rare callers.
   * @param opts.deferBridgeStamp — internal spec-380 rebind handoff: the coordinator owns the
   *   healthy stamp after its post-launch liveness proof. Ordinary human resume leaves this false.
   */
  async resume(name: string, record: SessionRecord, opts?: { injectPrimer?: boolean; deferBridgeStamp?: boolean }): Promise<void> {
    // SDD 368 T14 — refuse before mutating readiness cache (markers + snapshot deny set).
    this.assertNotDeliveryLifecycleDenied(name, "resume", record);
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
    // Cap against OTHER live agents — a remain-on-exit dead pane does not occupy a slot, and
    // respawning THIS agent (already live) is a replace, not a new seat. Count others so we
    // don't reject resume of a running agent when the fleet is already at max (pre-t-4d2630
    // killed first, which dropped the seat before the check).
    const othersLive = (await this.runningAgents()).filter((n) => n !== name).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (othersLive >= max) throw new MaxAgentsError(max);

    // Re-apply the declared agent's env on resume (spec 211 review fix) — spawn/restart include
    // def.env, but resume previously injected only bridge env, silently dropping e.g. an
    // ANTHROPIC_BASE_URL model-swap. definitionOf = config (declared) or adhoc def. spec 226 (H3):
    // also re-apply the isolated-harness wiring so a resumed harness agent stays scoped.
    const resumeDef = this.definitionOf(name);
    // Security review (782f1c6): mirror restart's fuller delegated-check (`record.def?.parent` alone
    // misses a GATED agent — gated spawns always force `parent: undefined` and record `delegator`
    // instead, which never lands in `record.def`), and gate on the resumed worktree so an uncontained,
    // shared-cwd delegation doesn't get blanket bash:"allow" either (HIGH).
    const resumeDelegatedOpencode = (this.lineage.get(name) || this.delegators.get(name)) && record.worktree
      ? { workspaceRoot: this.opts.workspaceRoot, worktreesBase: this.worktreesBaseFor(cwd, record.worktree) }
      : undefined;
    // spec 380 — transcript lookup already treats resume.configHome as authoritative (spec 240), so
    // the replacement process must use that same home.  A rehydrated ad-hoc Claude row can lack the
    // transient `isolate` definition that originally caused applyHarness to set CLAUDE_CONFIG_DIR.
    // Do not set the env for Claude's real default home: an explicit CLAUDE_CONFIG_DIR changes where
    // Claude looks for its top-level .claude.json, so default-home behavior must stay byte-compatible.
    const defaultClaudeHome = this.defaultClaudeConfigHome();
    const persistedResumeHomeEnv = runtime === "claude"
      && adapter.harness
      && !resumeDef?.harness
      && path.resolve(configHome) !== path.resolve(defaultClaudeHome)
      ? { [adapter.harness.configHomeEnv]: configHome }
      : {};
    const resumeHarness = this.materializeRuntimeHarness(name, resumeDef, cwd);
    await this.assertLaunchPreflight(
      name,
      cmd,
      { ...this.opts.getExtraEnv?.(), ...resumeDef?.env, ...(resumeHarness?.env ?? {}), ...persistedResumeHomeEnv },
      !record.declared,
      cwd,
    );
    const resumeBuild = this.applyHarness(
      name,
      resumeDef,
      cwd,
      adapter.resumeCommand(cmd, id),
      { ...this.opts.getExtraEnv?.(), ...this.opts.mintAgentToken?.(name), ...resumeDef?.env, TACHYON_AGENT_NAME: name },
      resumeHarness,
    );
    this.applyDelegatedOpencodeHarnessPermission(resumeDef, resumeBuild.env, resumeDelegatedOpencode);
    // spec 236 (BLOCKER fix) — resume rebuilds the command, so it must re-inject the Bridge or a resumed
    // agent silently loses it. Classify the binary from the ACTUALLY-resumed `cmd` (record.def.cmd) so an
    // ad-hoc agent that's no longer in the config still gets it; harness routing comes from the config
    // overlay (resumeDef) so a harness agent folds the Bridge into its --strict file instead.
    const resumeBridge = this.withRuntimeBridge(name, { cmd, harness: resumeDef?.harness }, resumeBuild.cmd, cwd, resumeDelegatedOpencode);
    this.readinessCache.delete(name); // spec 221: resuming changes the session → drop the cached badge
    // Resume is intentional re-launch — never inherit a prior graceful-stop "stopping" badge.
    this.clearStoppingState(name);
    // t-4d2630: respawn when a session/dead pane already exists; kill+new only as fallback.
    await this.startSessionCommand({
      session,
      cmd: this.withSessionOwnership(name, { cmd }, resumeBridge.cmd, {
        declared: record.declared,
        cwd,
        configHome: resumeBuild.env.CLAUDE_CONFIG_DIR ?? persistedResumeHomeEnv.CLAUDE_CONFIG_DIR,
      }),
      cwd,
      env: { ...resumeBuild.env, ...persistedResumeHomeEnv, ...resumeBridge.env }, // spec 236 + 380 persisted home
    });
    // Resume re-attaches to existing state; only its newly launched session is disposable.
    await this.observeLaunchReadiness(name, cmd, session);
    this.opts.ledger?.record(name, { ...record, resume: this.withConfigHome(name, this.definitionOf(name), { ...record.resume, runtime, sessionId: id }) }); // spec 240 — preserve persisted configHome
    // spec 364 — stamp bound_generation at resume time (rebind + human resume both land here).
    if (!opts?.deferBridgeStamp) this.stampBridgeClientBinding(name, resumeBridge.wired);
    this.opts.onSpawned?.(name, true); // resume is activation/human-driven — reveal

    // Resume does not recompose def.instructions (transcript carries the original brief) and does
    // NOT paste the 363 primer by default — all runtimes, all callers (sidebar / autostart / rebind).
    // Spec 363 injection moments are spawn, restart, and re-anchor; resume is re-attach only.
    // Opt-in injectPrimer:true remains for rare deliberate re-orientation after resume.
    // Advisory/best-effort: never blocks a resume.
    if (opts?.injectPrimer !== true) return;
    const { primer, beforeFinishing } = renderPrimer({
      agentName: name,
      delegator: this.delegators.get(name),
      parent: this.lineage.get(name),
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
    const dirty = src.sourceWorktree
      ? this.opts.worktreeDirty
        ? await this.opts.worktreeDirty(src.sourceWorktree).catch(() => true)
        : true
      : false;
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
    const sourceRecord = this.opts.ledger?.get(source);
    const sourceDefinition = this.definitionOf(source);
    // RE-RESOLVE the source's CURRENT live inputs at spawn time (codex dueto round-2 MAJOR): the plan +
    // confirm modal may be stale — the source could have restarted or switched sessions while the modal
    // sat open, so trusting plan.sourceId/cwd/worktree would fork an OLD transcript. resolveForkSource
    // also re-asserts the fail-closed gates (running, native, uuid, transcript on disk).
    const src = await this.resolveForkSource(source);
    const { adapter } = src;
    if (!adapter.forkCommand) throw new ForkUnavailableError(source, `'${src.runtime}' has no native session fork`);
    // Catch account/catalog drift before creating a fork checkout. A second probe below runs only
    // when the prospective cwd differs, covering project-scoped runtime configuration as well.
    await this.assertLaunchPreflight(plan.forkName, src.baseCmd, src.env, true, src.sourceCwd);

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

    // From here a fresh Git-locked worktree may exist + a session may be spawned. Failures terminate
    // only a provably-created session; the checkout remains locked recovery state and is never removed.
    const forkClaudeName = this.claudeSessionName(forkName);
    const forkRecord = () => ({
      def: {
        cmd: src.baseCmd,
        kind: "agent" as const,
        ...(src.instructions ? { instructions: src.instructions } : {}),
        ...(sourceDefinition?.role ? { role: sourceDefinition.role } : sourceRecord?.def?.role ? { role: sourceRecord.def.role } : {}),
        ...(sourceDefinition?.soul || sourceRecord?.def?.soul ? { soul: true } : {}),
        ...(sourceRecord?.def?.taskBrief ? { taskBrief: sourceRecord.def.taskBrief } : {}),
        ...(src.env ? { env: src.env } : {}),
        fork: true,
      },
      resume: this.withConfigHome(forkName, undefined, { runtime: src.runtime, sessionId: forkClaudeName }),
      ...(sourceRecord?.identity ? { identity: structuredClone(sourceRecord.identity) } : {}),
      ...(worktree ? { worktree } : {}),
      cwd,
      declared: false,
    });
    let spawnedSession: string | undefined;
    let sessionAttempted = false;
    let tokenMinted = false;
    try {
      // A worktree fork can load project-scoped runtime configuration. Probe only after resolving
      // that exact cwd, but before transcript seeding, token minting, tmux, or durable identity.
      // If this fails, the catch preserves the newly locked checkout as an explicit recovery receipt.
      if (path.resolve(cwd) !== path.resolve(src.sourceCwd)) {
        await this.assertLaunchPreflight(forkName, src.baseCmd, src.env, true, cwd);
      }
      // Worktree fork → seed the source transcript into the new cwd's project dir (claude --resume is
      // cwd-scoped). FAIL CLOSED: if the seed can't land, abort rather than spawn a context-less fork.
      if (worktree && adapter.transcriptPath && path.resolve(cwd) !== path.resolve(src.sourceCwd)) {
        // spec 226 / SDD 369 — a harness source is blocked from fork; use the explicit inherited home when
        // present, otherwise the same effective host-default home used to resolve the source transcript.
        const configHome = src.env?.CLAUDE_CONFIG_DIR ?? this.defaultClaudeConfigHome();
        const seeded = (this.opts.seedTranscript ?? defaultSeedTranscript)(
          adapter.transcriptPath(configHome, src.sourceCwd, src.sourceId),
          adapter.transcriptPath(configHome, cwd, src.sourceId),
        );
        if (!seeded) throw new ForkUnavailableError(source, "couldn't seed the session transcript into the fork's worktree (claude --resume would find nothing)");
      }

      // -n <fork's OWN name> so its NEW session carries a distinct customTitle (spec-220 capture),
      // then --resume <sourceId> --fork-session. Verified live: `claude -n B --resume A --fork-session`.
      const forkCmd = adapter.forkCommand(adapter.injectId(src.baseCmd, forkClaudeName), src.sourceId);
      const session = this.session(forkName);
      // spec 236 — a fork is a Tachyon-spawned agent too; inject the Bridge (claude-only + non-harness:
      // a harness source is blocked from fork, so this is always the non-harness --mcp-config / OPENCODE_CONFIG path).
      const forkBridge = this.withRuntimeBridge(forkName, { cmd: src.baseCmd }, forkCmd, cwd);
      const tokenEnv = this.opts.mintAgentToken?.(forkName);
      tokenMinted = tokenEnv !== undefined && Object.keys(tokenEnv).length > 0;
      sessionAttempted = true;
      await this.opts.tmux.newSession({
        name: session,
        cmd: this.applyAgentMemoryScope(
          forkName,
          this.withSessionOwnership(forkName, { cmd: src.baseCmd }, forkBridge.cmd, {
            declared: false,
            cwd,
            // Harness-backed sources cannot fork. Preserve an explicit source override; otherwise use the
            // same host-default account home used by transcript resolution and HarnessManager seeding.
            configHome: src.env?.CLAUDE_CONFIG_DIR ?? this.defaultClaudeConfigHome(),
            // A user-created fork inherits the source command's permission posture; capture must not widen it.
            preservePermissionMode: true,
          }),
        ),
        cwd,
        env: { ...this.opts.getExtraEnv?.(), ...tokenEnv, ...src.env, ...forkBridge.env, TACHYON_AGENT_NAME: forkName },
      });
      spawnedSession = session;
      // The catch below owns session teardown. Readiness rejection deliberately leaves the Git-locked
      // checkout as recovery state because the runtime may already have written ignored or tracked work.
      await this.observeLaunchReadiness(forkName, src.baseCmd, session);

      // Persistent SIBLING row: base cmd (a later resume uses the normal named path, never re-forks),
      // resume keyed to the fork's OWN name (captured → uuid by spec 220), NO parent lineage, fork:true.
      // The source's env is persisted so a restart/resume of the fork keeps it (dueto round-2: a
      // GLM/model-swap ANTHROPIC_BASE_URL must survive, not silently drop).
      this.opts.ledger?.record(forkName, forkRecord());
      // spec 364 — fork is a new Tachyon-spawned process with Bridge injection.
      this.stampBridgeClientBinding(forkName, forkBridge.wired);
      if (worktree) {
        const durable = this.opts.ledger?.get(forkName)?.worktree;
        if (!durable || durable.path !== worktree.path || durable.branch !== worktree.branch) {
          this.opts.notify?.(`fork '${forkName}' started, but its worktree remains locked because durable ownership could not be confirmed`, "warn");
        } else if (!this.opts.completePreparedWorktree) {
          this.opts.notify?.(`fork '${forkName}' started, but its worktree remains locked because quarantine finalization is unavailable`, "warn");
        } else {
          try {
            await this.opts.completePreparedWorktree(worktree);
          } catch (error) {
            this.opts.notify?.(
              `fork '${forkName}' started, but its worktree remains locked for recovery: ${error instanceof Error ? error.message : String(error)}`,
              "warn",
            );
          }
        }
      }
    } catch (err) {
      const primary = err instanceof Error ? err : new Error(String(err));
      const failures: Error[] = [primary];
      const session = this.session(forkName);
      if (spawnedSession) {
        try { await this.opts.tmux.killSession(spawnedSession); }
        catch (error) { failures.push(new Error(`failed to kill fork recovery session '${session}'`, { cause: error })); }
      }
      let runtimeMayBeLive = false;
      if (sessionAttempted) {
        try { runtimeMayBeLive = await this.opts.tmux.hasSession(session); }
        catch (error) {
          runtimeMayBeLive = true;
          failures.push(new Error(`failed to verify fork recovery session '${session}' liveness`, { cause: error }));
        }
      }
      if (runtimeMayBeLive) {
        try { this.opts.ledger?.record(forkName, forkRecord()); }
        catch (error) { failures.push(new Error(`failed to persist fork recovery handle for '${forkName}'`, { cause: error })); }
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
        failures.push(new Error(`fork recovery session may still be live and remains recorded as '${forkName}'`));
      } else {
        try { this.opts.ledger?.remove(forkName); }
        catch (error) { failures.push(new Error(`failed to remove fork recovery ledger row for '${forkName}'`, { cause: error })); }
        this.adhoc.delete(forkName);
      }
      if (tokenMinted) {
        try { this.opts.revokeAgentToken?.(forkName); }
        catch (error) { failures.push(new Error(`failed to revoke fork token for '${forkName}'`, { cause: error })); }
      }
      // The checkout may contain transcript/setup/runtime writes, including ignored files, so its
      // Git quarantine lock is the recovery receipt; never delete it automatically.
      if (worktree) {
        failures.push(new Error(
          `fork worktree recovery state was preserved at ${worktree.path}; inspect it, then unlock it explicitly before retry or removal`,
        ));
      }
      throw new AggregateError(
        failures,
        `fork '${forkName}' failed: ${primary.message}` +
          (worktree ? `; locked recovery checkout: ${worktree.path}` : "") +
          (runtimeMayBeLive ? `; live recovery session: ${session}` : ""),
        { cause: primary },
      );
    }
    this.adhoc.set(forkName, {
      cmd: src.baseCmd,
      instructions: src.instructions,
      ...(sourceDefinition?.role ? { role: sourceDefinition.role } : sourceRecord?.def?.role ? { role: sourceRecord.def.role } : {}),
      ...(sourceDefinition?.soul || sourceRecord?.def?.soul ? { soul: true } : {}),
      ...(src.env ? { env: src.env } : {}),
      autostart: false,
      watch: [],
      attention: { enabled: true, silenceSec: 8, patterns: [] },
      restart: "never",
      kind: "agent",
      worktree: !!worktree,
    });
    this.opts.onSpawned?.(forkName, true);
    await this.attachPaneTranscript(this.session(forkName));
    return forkName;
  }

  /** Kills every session of this workspace — alive agents and crashed postmortem panes alike. */
  async killAll(): Promise<string[]> {
    const all = [...(await this.agentStates()).keys()];
    for (const name of all) {
      await this.detachPaneTranscript(this.session(name));
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
      .filter(([name, def]) => {
        if (!def.autostart || present.has(name)) return false;
        // SDD 368 T14 — Delivery markers and snapshot-denied agents never generic autostart.
        if (this.isDeliveryLifecycleDenied(name)) return false;
        return true;
      })
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

function isPathAtOrUnder(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
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
