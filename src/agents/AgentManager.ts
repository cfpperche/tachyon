import crypto from "node:crypto";
import { withPostCutAttestation } from "./legacyFleetGate.js";
import { hasLifecycleHooks, isTemporaryInstance } from "./agentInstancePolicy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asAgent, codexConfigCmd, composeCommand, codexBridgeCmd, piBridgeCmd, shellQuote, instructionsDeliverable, type AgentDef, type AgentEntry, type AgentPermissionProjectionEntry, type EntryKind, type TachyonConfig } from "../config/loadConfig.js";
import type { ResolvedAgentCapabilityProjection } from "../config/agentProfileResolver.js";
import { applyManagedHookTrust, managedHookRuntimeOf } from "./managedHookTrust.js";
import { TmuxService, sessionName, agentFromSession, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { adapterFor, adapterForRuntime, binaryOf, forkable, managesOwnSession, type ResumeAdapter, type ResumeRuntime } from "../resume/adapters.js";
import { URL_ENV_VAR } from "../bridge/token.js";
import { redactSecrets } from "../bridge/redact.js";
import { RELEASE_LOCK_HINT, resolveBase as resolveWorktreeBase, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { bridgeGrokHome, defaultRealOpencodeDataHome, harnessHome, type MaterializedHarness } from "../harness/HarnessManager.js";
import {
  type SessionLedger,
  type SessionRecord,
  type SessionResume,
  type AgentInstanceLifetime,
  type AgentInstancePolicy,
  type AgentInstanceResumePolicy,
} from "../resume/SessionLedger.js";
import {
  captureActivityRenameSnapshot,
  convergeActivityRetirement,
  convergeActivityRename,
  moveActivityLog,
  type ActivityRenameSnapshot,
} from "../activity/logStore.js";
import { composerProfileFor, composerText, findComposerRegion, isComposerOccupied } from "../runtime/composerRegion.js";
import { sessionOwnersFile } from "../activity/sessionOwners.js";
import { spawnContractCompletion, type SpawnContract } from "../bridge/spawnContract.js";
import type { ResolvedCaptureSession } from "../resume/resolvers.js";
import { assertVerifiedTranscriptIsolation, gracefulStopForCommand, isolationMechanismForCommand, opencodeIsolationFootgunWarning, projectScopedTranscriptWarning, runtimeProfile } from "../runtime/runtimeProfile.js";
import { forgetAgent } from "./forgetAgent.js";
import { ensurePaneTranscriptFile, removePaneTranscript, rotatePaneTranscriptIfNeeded } from "./paneTranscript.js";
import { removeDerivedAgentFiles } from "./derivedFile.js";
import { PI_SESSION_DIR_ENV, piSessionDir } from "./piSession.js";
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
  type RuntimeLaunchPreflightPort,
} from "../runtime/launchPreflight.js";
import { createDefaultLaunchPreflightRegistry } from "../runtime/defaultLaunchPreflight.js";
import { GROK_CANONICAL_MEMORY_POLICY, grokMemoryArgs, grokMemoryEnv } from "../runtime/adapters/grokMemory.js";
import {
  CodexLaunchReadiness,
  matchCodexBootstrapInput,
  type CodexBootstrapInputMatch,
} from "../runtime/adapters/codexLaunchReadiness.js";
import { GenericLaunchReadiness, LaunchReadiness, RuntimeLaunchReadinessError, type LaunchReadinessPort, type RuntimeLaunchReadinessAdapter } from "../runtime/launchReadiness.js";
import { AgentRuntimeAdmissionError, admitAgentRuntimeCommand } from "./agentRuntimeAdmission.js";
import { authRequiredFromPreflight, authRequiredOf, classifyAuthRequired, describeAuthRequired, type AuthRequiredEvidence } from "../runtime/authRequired.js";
import { loadAndRenderProjectGuidanceBundle, type RenderedProjectGuidanceBundle } from "../config/projectGuidance.js";
import { carryNativeConfigSources } from "../config/agentNativeConfigPolicy.js";
import { AgentProfileRefusal, type AgentProfileRefusalCode } from "../config/agentProfileRefusal.js";
import { composeAgentPrompt } from "./promptLayers.js";
import type { SessionLaunchKind, SessionWorkRecord } from "./sessionWorkRecord.js";
import { selectAssignedWork, staleContractReferences, type BoardAssignmentRow } from "./assignmentSelection.js";
import { sweepSessions } from "../tmux/sessionSweep.js";
import type { FormationLifecyclePort } from "./formation/lifecycleConsumer.js";
import { PARENT_CWD_REFUSAL } from "../bridge/spawnContract.js";
import { inspectCapabilitySourceAtRoot } from "../config/agentCapabilitySource.js";
import { LOCKFILE_REL_PATH, parseLockfile } from "../plugins/lockfile.js";

/** A remembered pid is only a hint about WHICH process to measure. Pids are reusable, so existence
 *  alone cannot prove that the process still occupies this checkout. `/proc/<pid>/cwd` re-establishes
 *  that association at the decision point; unreadable is distinct from gone and refuses cleanup. */
function probeRememberedRootProcess(
  pid: number,
  worktreePath: string,
): { state: "live" | "gone" | "unknown"; detail?: string } {
  try {
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    const root = fs.realpathSync(worktreePath);
    const relative = path.relative(root, cwd);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      ? { state: "live" }
      : { state: "gone" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { state: "gone" };
    return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
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

/**
 * t-4736b4 — the answer to "is this name still occupied?" when the question is being asked by a
 * REMOVAL. Three values, not two: `unknown` is a first-class outcome, because a tmux inventory that
 * could not be read is neither proof of life nor proof of death, and collapsing it into either one
 * is how a stopped agent became undeletable.
 */
export type AgentOccupancyVerdict =
  | { state: "occupied"; detail: string }
  | { state: "free" }
  | { state: "unknown"; detail: string };

/**
 * t-4736b4 — raised when a removal could not MEASURE occupancy. Deliberately distinct from the
 * "still running" refusal: they call for different actions from the human, and a caller that cannot
 * tell them apart will report the wrong one.
 *
 * This is a fail-closed refusal with a door: it is decided from a fresh read every time, so the very
 * next attempt succeeds once tmux answers. Nothing durable records it.
 */
/**
 * t-4736b4 + t-05dff5 — this is a GOVERNED REFUSAL, not an internal failure, so it declares itself.
 *
 * Its message names the recovery ("check the tmux server, retry — the check re-measures each time").
 * Left as a bare `Error` it would be flattened to "could not be completed" at the Studio boundary,
 * which would undo the reason t-4736b4 gave it a distinct sentence in the first place: the human has
 * to be able to tell "I could not measure" apart from "it is still running".
 */
export class AgentOccupancyUnverifiableError extends AgentProfileRefusal {
  constructor(name: string, detail: string) {
    super(
      "agent-profile/occupancy-unverifiable",
      `occupancy unverifiable for agent '${name}': ${detail}. `
      + "Removal refuses to guess whether the session is still there — nothing was changed. "
      + "Check the workspace tmux server (Control → Doctor) and retry; the check re-measures each time.",
    );
    this.name = "AgentOccupancyUnverifiableError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * t-aaad95 — the fork-bomb guardrail when `tachyon.yml` says nothing. This used to be the default of
 * a VS Code key reached through a host port that `tachyon.yml` already outranked at every one of the
 * three call sites; the measured precedence was yml > VS Code > 8. Removing the port removed the
 * duplication without moving the number.
 */
const DEFAULT_MAX_AGENTS = 8;
const LAUNCH_READINESS_RUNTIMES = new Set<ResumeRuntime>(["codex", "claude", "grok"]);

export interface CanonicalLiveRenameSnapshot {
  sessionPresent: boolean;
  ledgerRecord: SessionRecord | null;
  activity: ActivityRenameSnapshot;
}

export interface AgentProfileForgetSnapshot {
  ledgerSha256: string | null;
  activity: ActivityRenameSnapshot;
}

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
    /**
     * t-f6aa7c — kept as a field, not only baked into `message`. A caller that has to TELL a human
     * why continuity was lost needs the reason without the `cannot resume 'x':` prefix, and
     * re-deriving it by slicing the message is how the two accounts drift apart.
     */
    readonly reason: string,
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
  /**
   * t-f6aa7c — WHY a `session: "resume"` restart came back on a new section instead. Present only
   * when resume was asked for and did not happen; absent on `session: "new"` (nothing was asked for)
   * and on a successful resume.
   *
   * `resumed: false` says continuity was lost; it never says whether that was a first crash, an
   * aged-out transcript, or a runtime with no resume adapter. A caller whose job is to keep the
   * human from discovering the loss by behaviour cannot do it from the boolean alone.
   */
  resumeUnavailable?: string;
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
  /** t-8168a7 — true/false when Attention knows; absent when reload left the turn history unknown. */
  hasStartedTurn?: boolean;
  /** graceful Stop is in flight; user actions that contend for the pane should be held */
  stopping?: boolean;
  /** graceful Stop timed out while the pane stayed alive; retry is allowed */
  stopFailed?: boolean;
  /**
   * t-b103c5 — when `stopFailed`, the stage that timed out, a measured reason, and the next
   * deliberate action. Opaque "stop failed" taught the human nothing; this is what the subline shows.
   */
  stopFailure?: { stage: "await-exit"; reason: string; nextAction: string };
  /**
   * t-04052d — replaces `declared`, which said "config owns this definition" and was read as though it
   * said "what kind of worker is this". This says the latter, and only the latter.
   *
   * Resolved once, in `list()`, from the declared policy where an instance exists and from the ROSTER
   * where none does — see the comment at that site for why the second half is an observation rather
   * than the inference this cut removes.
   */
  lifetime: AgentInstanceLifetime;
  /**
   * t-04052d — the SECOND axis, resolved the same way and carried beside the first because the two do
   * not imply each other. A FORK is `temporary` + `restartable`: no durable Profile, but it owns a
   * resume block. A reader that has only `lifetime` cannot tell it apart from a plain Temporary instance, and any
   * rule that tries collapses the axes this cut exists to keep apart.
   */
  resumePolicy: AgentInstanceResumePolicy;
  /**
   * t-0ad300 — declared in tachyon.yml and refused, carrying WHY. Present only on those rows.
   *
   * A refused agent has no definition, so without this it is indistinguishable from a name that was
   * never written down, and the row silently disappears. The reason travels with it because a row
   * that says only "refused" sends the human back to a banner two surfaces away to find out what
   * broke.
   */
  refused?: string;
  /**
   * SDD 482 phase 3 — the DECLARED instance policy of a recorded instance; absent when this row is a
   * roster entry with no session ledger row behind it. Readers ask their question through the
   * `agentInstancePolicy` helpers rather than reading this directly.
   */
  instance?: AgentInstancePolicy;
  /** dead pane present (process ended on its own; postmortem kept until dismiss/restart) */
  dead: boolean;
  /**
   * t-9d76b1 — died and NOBODY ASKED IT TO. Two independent facts, never one:
   * `stopRequested` answers "did Tachyon ask?", the exit code answers "did it exit cleanly?".
   *
   * It used to be `dead && exitCode !== 0` alone, which answered the intent question with the code —
   * so a runtime that honours Ctrl-C by exiting 130 (128+SIGINT: the CORRECT exit for the interrupt
   * Tachyon itself sent) was reported as a crash. Measured: grok and hermes return 130, codex,
   * opencode and pi return 0, so no exit code — and no special case for one of them — could have
   * carried the intent.
   */
  crashed: boolean;
  /** t-9d76b1 — Tachyon requested this exit (graceful Stop / restart / rebind), so it is not a crash. */
  stopRequested?: boolean;
  exitCode?: number;
  /** process exited 0 and Tachyon already cleared the tmux postmortem pane */
  cleanExited?: boolean;
  /** agent = AI CLI; terminal = server/shell/build. Inferred or declared in tachyon.yml. */
  kind: EntryKind;
  /** who spawned this instance; persisted uniformly for Saved and Temporary lifetimes */
  parent?: string;
  /** Bridge-resolved agent that requested a gated delegation; display metadata, not runtime lineage. */
  delegator?: string;
  /** config-declared owner from tachyon.yml subagents; durable roster authority, not runtime lineage */
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

/**
 * t-aaa2c6 — the delegated-Codex class default, one constant per MEASURED door on codex-cli 0.146.0.
 * These are three doors, not three spellings of one:
 *
 * - `approval_policy` is COMMAND approval. `-a/--ask-for-approval` exposes only
 *   untrusted/on-request/never, while `config.toml` also parses `on-failure` and `granular`.
 * - `sandbox_mode` is the WRITE door, and it is the one an argument-by-analogy fix would have
 *   missed. Measured with `codex sandbox`: under `workspace-write`, `git add` inside a Tachyon
 *   worktree fails with `Unable to create '<repo>/.git/worktrees/<agent>/index.lock': Read-only
 *   file system`, because a worktree's git directory lives outside its own cwd. With
 *   `approval_policy = "never"` that stops being a prompt and becomes a hard failure — quieter,
 *   and no more autonomous. Delegated Claude and Grok children run with no sandbox at all, so
 *   `danger-full-access` is the parity value, not an escalation beyond the class.
 * - `mcp_servers.<server>.default_tools_approval_mode` is MCP TOOL approval, governed per SERVER and
 *   NOT by `approval_policy`. Measured live: with `approval_policy` at its default, a read-only
 *   Bridge-shaped tool call stops at "Allow the probe MCP server to run tool …?"; adding only
 *   `default_tools_approval_mode = "approve"` ran the same call with no prompt. Codex itself writes
 *   `approval_mode = "approve"` under `[mcp_servers.<server>.tools.<tool>]` when a human answers
 *   "Always allow", which is where the value's meaning is pinned.
 *
 * Only the Tachyon Bridge is vouched for here. A third-party MCP server a human authored into the
 * agent's own capabilities keeps Codex's default posture — Tachyon does not speak for it.
 */
const CODEX_DELEGATED_APPROVAL_POLICY = "never";
const CODEX_DELEGATED_SANDBOX_MODE = "danger-full-access";
const CODEX_DELEGATED_BRIDGE_TOOL_APPROVAL = "approve";
const CODEX_BRIDGE_MCP_SERVER = "tachyon_bridge";
/** Flags that already close BOTH the approval and the sandbox door in one token. */
const CODEX_BYPASS_FLAGS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo"];

/**
 * Is one Codex permission door already stated on this command line? An explicitly authored command
 * always wins over a class default; Tachyon adds a door, it never rewrites one.
 */
function codexDoorStated(
  argv: readonly string[],
  flags: readonly string[],
  configPrefix: string,
  /** The bypass token is documented as skipping approvals AND the sandbox — it says nothing about
   *  per-server MCP tool approval, and that was not measured, so the MCP door does not read it. */
  closedByBypassFlag = true,
): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (closedByBypassFlag && CODEX_BYPASS_FLAGS.includes(arg)) return true;
    if (flags.includes(arg)) return true;
    if (flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) return true;
    const value = arg === "-c" || arg === "--config"
      ? argv[i + 1] ?? ""
      : arg.startsWith("--config=")
        ? arg.slice("--config=".length)
        : arg.startsWith("-c") && arg.length > 2
          ? arg.slice(2)
          : undefined;
    if (value !== undefined && value.startsWith(configPrefix)) return true;
  }
  return false;
}

/**
 * Append `-c key=value` overrides for the doors that are not already stated. Argv `-c` beats
 * `config.toml`, and a later `-c` beats an earlier one — measured: the Bridge's own whole-table
 * override (`mcp_servers.tachyon_bridge={…}`, spliced right after the binary by `codexBridgeCmd`)
 * REPLACES the table, so the per-server approval key must land after it, which appending does.
 */
function applyCodexPermissionDoors(
  cmd: string,
  doors: { approvalPolicy?: string; sandboxMode?: string; bridgeToolApproval?: string },
): string {
  const argv = parseLaunchCommand(cmd)?.argv ?? [];
  const add = (override: string): void => {
    cmd += ` -c ${shellQuote(override)}`;
  };
  if (doors.approvalPolicy !== undefined && !codexDoorStated(argv, ["-a", "--ask-for-approval"], "approval_policy=")) {
    add(`approval_policy="${doors.approvalPolicy}"`);
  }
  if (doors.sandboxMode !== undefined && !codexDoorStated(argv, ["-s", "--sandbox"], "sandbox_mode=")) {
    add(`sandbox_mode="${doors.sandboxMode}"`);
  }
  if (
    doors.bridgeToolApproval !== undefined
    && !codexDoorStated(argv, [], `mcp_servers.${CODEX_BRIDGE_MCP_SERVER}.default_tools_approval_mode=`, false)
    && !codexDoorStated(argv, [], `mcp_servers.${CODEX_BRIDGE_MCP_SERVER}.tools.`, false)
  ) {
    add(`mcp_servers.${CODEX_BRIDGE_MCP_SERVER}.default_tools_approval_mode="${doors.bridgeToolApproval}"`);
  }
  return cmd;
}

const PI_REVIEWER_EXCLUDED_TOOLS = ["bash", "edit", "write"] as const;
type PiToolFilterPosture = "none" | "reviewer-read-only" | "other";

function piToolFilterPosture(cmd: string): PiToolFilterPosture {
  const parsed = parseLaunchCommand(cmd);
  if (!parsed || adapterFor(parsed.binary)?.runtime !== "pi" || !parsed.allWordsLiteral) {
    return /(^|\s)(?:--no-tools|-nt|--no-builtin-tools|-nbt|--tools|-t|--exclude-tools|-xt)(?:=|\s|$)/.test(cmd) ? "other" : "none";
  }
  const boundary = parsed.argv.indexOf("--");
  const options = boundary < 0 ? parsed.argv : parsed.argv.slice(0, boundary);
  const exclusions: string[] = [];
  let other = false;
  for (let index = 0; index < options.length; index++) {
    const token = options[index]!;
    if (token === "--exclude-tools" || token === "-xt") {
      const value = options[++index];
      if (!value || value.startsWith("-")) return "other";
      exclusions.push(value);
    } else if (token.startsWith("--exclude-tools=") || token.startsWith("-xt=")) {
      return "other"; // Pi v0.80.10 accepts only the separate-operand form
    } else if (["--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--tools", "-t"].includes(token)
      || token.startsWith("--tools=") || token.startsWith("-t=")) {
      other = true;
      if ((token === "--tools" || token === "-t") && options[index + 1] && !options[index + 1]!.startsWith("-")) index++;
    }
  }
  if (other || exclusions.length > 1) return "other";
  if (exclusions.length === 0) return "none";
  const normalized = [...new Set(exclusions[0]!.split(",").map((tool) => tool.trim()).filter(Boolean))].sort();
  return normalized.length === PI_REVIEWER_EXCLUDED_TOOLS.length
    && normalized.every((tool, index) => tool === [...PI_REVIEWER_EXCLUDED_TOOLS].sort()[index])
    ? "reviewer-read-only"
    : "other";
}


/**
 * t-b88106 — what a launch asks the PRESENTATION layer to do about this agent's surface.
 *
 * `reveal`   this launch is the reason a surface should exist: a human ▶, an explicit start, a fork.
 * `silent`   never open anything (a Bridge-spawned child must not yank the human's focus, F3).
 * `preserve` keep whatever the agent already was. A restart/resume/crash-recovery relaunch is a
 *            continuation of an agent that was ALREADY headless or already open — it is not a
 *            request to change that. Deciding it here, in the manager, is impossible: only the
 *            presentation layer knows whether a surface is open, and a persistent engine can be
 *            serving several windows that disagree. So the manager states the intent and the
 *            presentation resolves it.
 *
 * The old signature was a boolean, and restart/resume/crash-restart all passed `true` — which is
 * why relaunching a headless agent materialized an editor terminal nobody asked for.
 */
export type SpawnReveal = "reveal" | "preserve" | "silent";

export interface SpawnOptions {
  /** present = Temporary instance (not declared in tachyon.yml) */
  cmd?: string;
  /**
   * SDD 478 M9 — what the caller is asking to create. Required alongside `cmd`, because the manager
   * no longer infers it: which entity a Temporary command produces is a decision belonging to the door
   * that took the request, and this manager serves several. An `agent` request is admitted only for
   * a supported agent runtime (`admitAgentRuntimeCommand`); a `terminal` request has no agent fields to carry.
   */
  kind?: EntryKind;
  cwd?: string;
  /** role prompt for Temporary instances — delivered via composeCommand like Saved ones */
  instructions?: string;
  /** explicit runtime lineage: the agent that requested this instance, regardless of lifetime */
  parent?: string;
  /** spec 362 — Bridge-resolved requester for a gated delegation. Separate from parent because gated agents spawn top-level. */
  delegator?: string;
  /** open + focus the editor terminal on spawn (default true). The Bridge passes false
   *  so an agent spawning a child doesn't yank the human's focus off the parent (F3). */
  reveal?: boolean;
  /** spec 210 — opt this Temporary spawn into git-worktree isolation, including parented spawns. */
  worktree?: boolean;
  /** spec 230 — extra env merged into this Temporary spawn (e.g. a pipeline node's TACHYON_RUN_ID/NODE_ID/NODE_NONCE). Agent-declared env still wins on conflict via the spawn merge order. */
  env?: Record<string, string>;
  /** spec 230 — tag this Temporary spawn as a pipeline-run node; persisted to SessionDef.pipeline so the generic resume/offer path skips it (the run owns it). */
  pipeline?: { runId: string; nodeId: string };
  /** spec 230 — extra instructions appended to the agent's composed prompt (a pipeline node's task, added AFTER a declared agent's role/instructions so the specialist config is preserved). */
  taskBrief?: string;
  /** spec 246 — the validated delegation contract this Temporary AI child was spawned under (Bridge spawn-contract
   *  gate); persisted as structured metadata on the ledger def (D8). The brief itself rides in `instructions`. */
  contract?: SpawnContract;
  /** spec 246 — set when the spawner bypassed the contract gate (`skip_contract_reason`); recorded for audit. */
  contractSkipReason?: string;
}

export interface AgentManagerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  /** t-8168a7 — tri-state live/durable turn evidence, projected through list() for all consumers. */
  hasStartedTurn?: (name: string) => boolean | undefined;
  /**
   * t-0ad300 — agents that ARE declared in tachyon.yml and were refused, name → reason.
   *
   * They are deliberately absent from `getConfig().agents`: the isolation that keeps the healthy
   * roster loading has to delete them before the legacy parser sees them. Listing them from here
   * is what keeps "refused" distinguishable from "never declared" — without it the row disappears,
   * and with it the only way into Agent Studio, which is where the refusal gets repaired.
   */
  getRefusedAgents?: () => Record<string, string>;
  /** t-8354ae — optional pre-spawn gate (e.g. refuse LKG-only names while config is invalid). */
  assertSpawnAllowed?: (name: string) => void;
  /**
   * t-2d2ce7 — a Stop All that hit its sweep bound with sessions still alive.
   *
   * Optional, but never silent when wired: "stop everything" is the command a human reaches for to
   * get control of the machine back, so a partial one has to say so rather than return like a
   * success. Omitted by callers that have nowhere to surface it.
   */
  onStopAllIncomplete?: (passes: number) => void;
  /**
   * t-50bbd4 — the formation lane, as a narrow port. Optional: a manager without it behaves exactly
   * as before, which is what keeps this wiring reversible.
   */
  formation?: FormationLifecyclePort;
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
  /** t-84f0eb — read an explicitly authored per-agent permission posture from workspace authority. */
  resolveAgentPermissionProjection?: (name: string, runtime: string) => AgentPermissionProjectionEntry | undefined;
  /** Materialize a non-harness hermes agent's private HERMES_HOME (Bridge MCP in config.yaml +
   *  auth.json symlink), returning its path (undefined when the Bridge isn't up). Injected as
   *  HERMES_HOME. Wired in Workspace where the Bridge URL/token live. */
  materializeBridgeMcpHermes?: (name: string) => string | undefined;
  /** spec 399 — immutable staged Pi extension that projects the Bridge MCP catalog into Pi tools. */
  piBridgeExtensionPath?: () => string | undefined;
  /** spec 400 — materialize the private transcript namespace for one managed Pi agent. */
  materializePiSessionDir?: (name: string) => string;
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
  /**
   * t-2656d7 (SDD 495) — a launch refused because the RUNTIME is not authenticated.
   *
   * Separate from `notify` above, and the separation is the fix. `notify` is a one-way line with no
   * actions, and an action-less notice is precisely the branch that routes to
   * `vscode.window.setStatusBarMessage(…, 8_000)` — clipped by width, erased on a timer, no button.
   * That is where the owner's `— run grok login first` went on 2026-08-07. This condition is the one
   * launch failure a human can FIX, so it needs a surface that can carry the fix as a control; the
   * host decides what that surface is.
   *
   * Every launch door reaches it: the harness credential refusal (all runtimes), the OpenCode
   * pre-launch store probe, and a `runtime_auth_rejected` readiness verdict. Left undefined it
   * degrades to `notify`, which is today's behavior and is what the AgentManager suites construct.
   */
  onAuthRequired?: (agent: string, evidence: AuthRequiredEvidence) => void;
  /** spec 312 — lets Workspace tie pane-nudge suppression to the actual spawn-time hook outcome. */
  onSessionHooksInjected?: (name: string, injected: boolean) => void;
  onSpawned?: (name: string, reveal: SpawnReveal, context?: { worktree?: WorktreeRecord; temporary: boolean }) => void;
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
   * t-e3aaae — the board Tasks currently assigned to `name` and in flight. A `session:new` restart
   * materializes these into the replacement brief so the agent is TOLD its work instead of inferring
   * it from `assignee == me && status == active`.
   *
   * Two contracts:
   *  - returning `[]` is an answer ("nothing is assigned"), rendered as such;
   *  - THROWING is fail-closed. The restart is refused before the live pane is touched, because a
   *    brief that silently omits the assignment is exactly the failure this exists to end.
   *
   * Unwired (tests, headless) means the board cannot be consulted at all; the restart then behaves
   * as it did before this option existed and claims nothing about assignments.
   */
  assignedWork?: (name: string) => BoardAssignmentRow[];
  /**
   * t-9d250c — the status of ANY task id, for describing what the frozen spawn brief still names.
   * Optional and fail-quiet by design: unwired, or unknown id, produces no claim about that id at
   * all. It is only ever used to state a fact the store already holds, never to infer completion.
   */
  taskStatusById?: (id: string) => string | undefined;
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
    created?: boolean;
    preparationLocked?: boolean;
    rollbackHeadSha?: string;
    /** Observed HEADs retained only for recovery diagnostics; failed launch cleanup is non-destructive. */
    preparationHeadBefore?: string;
    preparationHeadAfter?: string;
  } | null>;
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
  /**
   * t-171cb2 — `delegated` is true when this launch has runtime lineage (parent or delegator).
   * Materializers use it for class-scoped authority (e.g. Codex directory trust) that must not
   * apply to top-level or declared agents.
   */
  materializeHarness?: (ctx: { name: string; def: AgentEntry; cwd: string; delegated?: boolean }) => MaterializedHarness | null;
  /** Remove a materialized per-agent runtime config home at the agent's end-of-life. */
  removeHarnessHome?: (name: string) => void;
  /** t-7bc276 — remove the private `bridge-mcp/<name>.<runtime>/` home at the agent's end-of-life. */
  removeBridgeRuntimeHome?: (name: string) => void;
  /** Remove a managed Pi agent's private transcript namespace at ephemeral end-of-life. */
  removePiSessionDir?: (name: string) => void;
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
  /** the source session's RESOLVED live id (a real uuid); native transport may use this id or its exact JSONL path */
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
  /** Authenticated coordinator for a gated top-level delegation. */
  delegator?: string;
  /** Temporary (MCP-spawned) vs Saved */
  temporary: boolean;
  /** true on restart/resume — the resolver reuses the worktree and skips worktreeSetup */
  isRestart: boolean;
  /**
   * t-da80ed — the profile's declared `workspace.cwd`, resolved to an absolute path; absent when the
   * profile declares none. Present so the resolver can SEE the directory it is about to override:
   * whatever it returns replaces this value, and until it could read it, a declaration the runtime
   * discarded was discarded without a word.
   */
  declaredCwd?: string;
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
 * t-55d4d0 — what a failed launch left behind, split by whether Tachyon CHOSE it or merely SUFFERED it.
 *
 * `failures` are compensation steps that did not work: a session that would not die, a token that
 * would not revoke, a ledger row that would not clear. They mean state is unaccounted for and a human
 * must look.
 *
 * `receipts` are deliberate preservations. Keeping a checkout whose branch tip may hold real agent
 * commits, or withholding a rollback that has no exact prepared HEAD to roll back to, is the CORRECT
 * outcome — it is reported so the operator knows what is on disk, not because anything went wrong.
 *
 * The two used to share one list, so filing a receipt flipped the verdict to "compensation was
 * incomplete" on the very path where compensation had completely succeeded (measured 2026-07-27: a
 * `runtime_auth_rejected` spawn reported incomplete compensation after a clean quarantine, leaving
 * the human unable to tell "intervene" from "this checkout is deliberate").
 */
interface LaunchCompensation {
  failures: Error[];
  receipts: Error[];
}

function newLaunchCompensation(): LaunchCompensation {
  return { failures: [], receipts: [] };
}

/**
 * The error to throw after compensating a failed launch. Receipts are never dropped — an operator
 * still has to be told a checkout was kept — but only real failures change the verdict.
 */
function launchCompensationError(primary: unknown, outcome: LaunchCompensation, subject: string): unknown {
  const cause = primary instanceof Error ? primary : new Error(String(primary));
  if (outcome.failures.length > 0) {
    return new AggregateError(
      [cause, ...outcome.failures, ...outcome.receipts],
      `${subject} failed and compensation was incomplete`,
      { cause },
    );
  }
  if (outcome.receipts.length > 0) {
    return new AggregateError(
      [cause, ...outcome.receipts],
      `${subject} failed; compensation completed and recovery state was preserved for inspection`,
      { cause },
    );
  }
  return primary;
}

/**
 * Lifecycle orchestration over TmuxService. tmux is the source of truth for what's
 * running; the only in-memory state is the definition of Temporary (MCP-spawned) agents,
 * which does not survive an extension restart by design.
 */
/**
 * t-eb4b30 — a Temporary Agent's definition, rebuilt from its ledger row.
 *
 * This was inline in `rehydrateFromLedger`, which is what made a second store look necessary: only the
 * rehydrate path could produce an `AgentDef` from a row, so everything else read a map. It is total
 * rather than lossy because a Temporary's lifecycle buttons are CONSTANTS, not authored data — nobody
 * can give one an autostart, a watch list or a restart policy, so there is nothing about it to lose.
 * The row carries the only authored parts: cmd, instructions, env and kind.
 */
function temporaryDefinitionFrom(def: NonNullable<SessionRecord["def"]>, worktree: SessionRecord["worktree"]): AgentDef {
  return {
    cmd: def.cmd,
    instructions: def.instructions,
    ...(def.env ? { env: def.env } : {}), // spec 225 — a forked sibling's inherited env survives reload
    autostart: false,
    watch: [],
    attention: { enabled: true, silenceSec: 8, patterns: [] },
    restart: "never",
    kind: def.kind,
    // spec 210 — a row with a worktree record means this agent runs in a worktree; restore the flag so
    // restart reuses it instead of falling back to the root.
    worktree: !!worktree,
  };
}

export function applyNativeLaneSuppressionCommand(cmd: string): { cmd: string; applied: boolean } {
  const runtime = binaryOf(cmd);
  if (runtime === "claude") {
    if (!/(^|\s)--setting-sources(?:=|\s+)user(?:\s|$)/.test(cmd)) cmd += " --setting-sources user";
    return { cmd, applied: true };
  }
  if (runtime === "codex") {
    if (!/(^|\s)(?:-c|--config)\s+project_doc_max_bytes=0(?:\s|$)/.test(cmd)) cmd = codexConfigCmd(cmd, "project_doc_max_bytes=0");
    if (!/(^|\s)--disable\s+memories(?:\s|$)/.test(cmd)) cmd += " --disable memories";
    return { cmd, applied: true };
  }
  return { cmd, applied: false };
}

export class AgentManager {

  static readonly STOPPING_FALLBACK_MS = 15_000;
  /** t-22944a — five measured Grok 1.0.0 active-tool exits completed in 992–1,032ms.
   * Two seconds keeps about one second of margin without inheriting the row's 15s durable
   * stop-failed threshold. This confirms an outcome only; it never escalates to a signal. */
  static readonly STOP_CONFIRM_TIMEOUT_MS = 2_000;
  static readonly POSTMORTEM_MAX_LINES = 1000;
  static readonly POSTMORTEM_MAX_BYTES = 64 * 1024;
  /**
   * t-eb4b30 — there is no second definition store.
   *
   * A Temporary Agent's definition used to live in `private temporary = new Map<string, AgentDef>()`, a
   * parallel machine beside `config.agents`, and 29 sites branched on membership in it to mean "is this
   * Temporary?". The map held nothing the ledger did not: `rehydrateFromLedger` already rebuilt the
   * whole `AgentDef` from `rec.def` + `rec.worktree` on every activation, and that reconstruction is
   * total because a Temporary's lifecycle buttons are CONSTANTS. So the map was a cache of the ledger,
   * and membership in it was a proxy for the declared lifetime that t-04052d made readable directly.
   *
   * Consequence, stated because it is a real narrowing: a Temporary now REQUIRES a ledger, since that
   * is where its definition is. Production has one construction site and it always passes one
   * (`Workspace.ts`); a manager built without a ledger simply has no Temporary agents, which is the
   * fail-closed reading rather than a silent second store.
   */
  private temporaryRow(name: string): { def: NonNullable<SessionRecord["def"]>; worktree?: SessionRecord["worktree"] } | undefined {
    if (this.opts.getConfig()?.agents[name]) return undefined; // a Saved definition wins; see `definitionOf`
    const rec = this.opts.ledger?.get(name);
    if (!rec?.def || !isTemporaryInstance(rec)) return undefined;
    return { def: rec.def, ...(rec.worktree ? { worktree: rec.worktree } : {}) };
  }

  /** Whether this name is a Temporary Agent — the declared lifetime, never which store holds it. */
  private isTemporary(name: string): boolean {
    return this.temporaryRow(name) !== undefined;
  }

  /**
   * Every Temporary Agent this workspace knows about, from the one store that holds them.
   *
   * Takes an optional snapshot because `SessionLedger.all()` reads and parses the file on every call
   * and `get()` is `all()` behind one key. A caller that already holds a snapshot — `list()` does, and
   * it runs on every UI refresh — must not pay for another read per name.
   */
  private temporaryNames(rows?: ReadonlyMap<string, SessionRecord>): string[] {
    const declared = this.opts.getConfig()?.agents ?? {};
    return [...(rows ?? this.opts.ledger?.all() ?? [])]
      .filter(([name, rec]) => !declared[name] && !!rec.def && isTemporaryInstance(rec))
      .map(([name]) => name);
  }

  /** child -> parent, the process-local projection of lineage persisted in the session ledger. */
  private lineage = new Map<string, string>();
  /** child -> delegator for gated delegations. Display-only; gated children intentionally have no runtime parent. */
  private delegators = new Map<string, string>();
  /** spec 221 perf — cache the resume-readiness badge per agent (validated by sessionId), so the
   *  sidebar probe doesn't re-resolve/scan on every tree refresh. Cleared on lifecycle changes. */
  private readinessCache = new Map<string, { sessionId: string; ready: boolean }>();
  private stoppingSince = new Map<string, number>();
  /**
   * t-5e1113 (SDD 482, decision 5) — instances THIS process started. Decision 5 makes lineage durable
   * "for the life of the instance", and that bound is what this set enforces: a ledger row describes
   * some instance, and if we started the current one ourselves we already know its lineage — including
   * that it deliberately has none. Without this, a stale row from a PREVIOUS instance of the same
   * declared agent would re-nest a top-level agent after a rehydrate.
   */
  private startedHere = new Set<string>();
  private stopFailed = new Set<string>();
  /** Detail for rows in `stopFailed` — cleared with the flag. */
  private stopFailureDetail = new Map<string, NonNullable<ManagedEntryInfo["stopFailure"]>>();
  private cleanExited = new Set<string>();
  /**
   * t-9d76b1 — TACHYON ASKED THIS PROCESS TO EXIT. The one fact an exit code cannot carry.
   *
   * `stoppingSince` above cannot answer this: it is the "stopping…" badge, and `list()` deletes it the
   * moment the pane goes dead — exactly when the question "did it die, or did I stop it?" is finally
   * being asked. So this is a second, longer-lived record of the same request, and it deliberately
   * survives the death.
   *
   * INSTANCE-scoped, not name-scoped: cleared wherever `cleanExited` is (spawn / restart / resume /
   * kill / dismiss), because those are the doors that begin a new process or collect the dead one.
   * Nothing clears it at the death observation — the row is read long after that.
   */
  private stopRequestedAt = new Map<string, number>();
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
  /** SDD 408 interim safety: until Pi exposes a shared auth-file lock domain, serialize admission of
   *  Pi processes workspace-wide so concurrent different-name spawns cannot both observe a free slot. */
  private piAdmissionTail: Promise<unknown> = Promise.resolve();
  /** Same-process positive hint closes the post-tmux/pre-ledger window between concurrent Pi launches. */
  private livePiHint: string | undefined;
  private postmortemOutput = new Map<string, PostmortemOutput>();
  /** Last known-good agentStates() result — served back when tmux.sessionStates() returns
   * null (an ambiguous list-panes error), so a transient tmux hiccup can't read as "every
   * agent vanished" (t-3a3a14). */
  private lastAgentStates = new Map<string, { dead: boolean; exitCode?: number }>();
  /** t-ab9b40: dispatch-order sequence for tmux reads that may write lastAgentStates. */
  private tmuxReadSeq = 0;
  /** Sequence number of the read that produced the CURRENT lastAgentStates — a read dispatched
   * before it must not clobber the cache on a slow resolve (last-writer-wins by RESOLVE order,
   * not dispatch order, would let a stale concurrent read win the race). */
  private tmuxReadAppliedSeq = 0;
  private readonly launchPreflight: RuntimeLaunchPreflightPort;
  private readonly launchReadiness: LaunchReadinessPort;
  /** A session becomes assignable only after a positive readiness observation. */
  private readyAgents = new Set<string>();
  /** A launched AI runtime remains provisional until the common observation policy sees a ready affordance. */
  private provisionalAgents = new Set<string>();
  /**
   * t-b51923 — `buildSidebarFleet` asks `canFork` for every agent on each presentation refresh. The
   * measured production chain is canFork → defOf → definitionOf → withDelegatedToolkit →
   * delegableToolkit, so a stable withheld grant used to raise the same human warning about 15 times
   * per second per running agent. The warning is legitimate (it explains why approved bytes did not
   * cross), but its CONDITION is edge-triggered: a new digest/error warns once, repeated projection
   * reads do not. Keys include the changing evidence so a later, genuinely different withholding is
   * visible rather than silenced for the manager lifetime.
   */
  private readonly notifiedDelegatedToolkitConditions = new Set<string>();

  constructor(private readonly opts: AgentManagerOptions) {
    this.launchPreflight = opts.launchPreflight ?? createDefaultLaunchPreflightRegistry();
    this.launchReadiness = opts.launchReadiness ?? new LaunchReadiness();
  }

  private notifyDelegatedToolkitCondition(key: string, message: string): void {
    if (this.notifiedDelegatedToolkitConditions.has(key)) return;
    this.notifiedDelegatedToolkitConditions.add(key);
    this.opts.notify?.(message, "warn");
  }

  private get prefix(): string {
    return `${SESSION_PREFIX}-${this.opts.wsHash}-`;
  }

  session(name: string): string {
    return sessionName(this.opts.wsHash, name);
  }

  private definitionOf(name: string, lineage = new Set<string>()): AgentDef | undefined {
    if (lineage.has(name)) return undefined;
    const nextLineage = new Set(lineage).add(name);
    const saved = this.opts.getConfig()?.agents[name];
    if (saved) return saved;
    const row = this.temporaryRow(name);
    if (!row) return undefined;
    return this.withDelegatedToolkit(name, temporaryDefinitionFrom(row.def, row.worktree), row.def.parent ?? row.def.delegator, nextLineage);
  }

  /** Delegation is the explicit grant: copy only the parent's enumerated skill snapshot, never credentials. */
  private withDelegatedToolkit(name: string, definition: AgentDef, parent: string | undefined, lineage = new Set<string>()): AgentDef {
    const child = asAgent(definition);
    if (!child || !parent) return definition;
    const parentAgent = asAgent(this.definitionOf(parent, lineage));
    const inherited = parentAgent ? this.delegableToolkit(parent, parentAgent) : undefined;
    if (!inherited || inherited.skills.length === 0) return definition;
    const runtime = adapterFor(child.cmd)?.runtime;
    if (runtime !== "claude" && runtime !== "codex" && runtime !== "grok") {
      throw new Error(`runtime '${runtime ?? child.cmd}' has no measured delegated skill projection`);
    }
    const own = child.profileCapabilities;
    if (own && own.adapter !== runtime) {
      throw new Error(`runtime '${runtime}' cannot consume profile capabilities for '${own.adapter}'`);
    }
    const skills = structuredClone(inherited.skills);
    const skillOrigins: NonNullable<ResolvedAgentCapabilityProjection["skillOrigins"]> = Object.fromEntries(
      skills.map((skill) => [skill.name, [{ kind: "delegator" as const, agent: parent }]]),
    );
    /** t-b0cfd4 — delegated skills held back below, so the child's sources cannot claim them. */
    const withheldFromDelegator = new Set<string>();
    for (const selected of own?.skills ?? []) {
      const inheritedIndex = skills.findIndex((skill) => skill.name === selected.name);
      if (inheritedIndex >= 0 && skills[inheritedIndex]!.source.sha256 !== selected.source.sha256) {
        const inheritedSha256 = skills[inheritedIndex]!.source.sha256;
        // t-b0cfd4 — the FOURTH site of the same shape, found by sweeping for it rather than by
        // waiting for it: one skill the parent and the child pinned at different content used to
        // throw here, and this throw aborts the whole spawn. Both sides are approved bytes, so
        // neither is unsafe; what is unsafe is picking silently, because the two are different
        // content wearing one name and the child would run believing it has the other one.
        //
        // The child's OWN profile selection wins — it is this agent's authored choice, and it is the
        // one the child's manifest already names — and the delegated copy is withheld by name. The
        // spawn continues.
        skills[inheritedIndex] = structuredClone(selected);
        skillOrigins[selected.name] = [];
        withheldFromDelegator.add(selected.name);
        this.notifyDelegatedToolkitCondition(
          `profile-conflict:${parent}:${name}:${selected.name}:${inheritedSha256}:${selected.source.sha256}`,
          `delegated toolkit withheld '${parent}'s '${selected.name}' from '${name}': the two pin different content `
          + "under one name, and the child's own profile selection is the authored choice. "
          + `Reauthorize it for one of the two in Agent Studio → Runtime tooling if they should match.`,
        );
      }
      if (inheritedIndex < 0) skills.push(structuredClone(selected));
      skillOrigins[selected.name] = [...(skillOrigins[selected.name] ?? []), { kind: "profile", agent: name }];
    }
    const projectionBase: Omit<ResolvedAgentCapabilityProjection, "sha256"> = {
      schemaVersion: 1,
      adapter: runtime,
      sources: structuredClone([
        // A withheld delegated copy must leave the SOURCES too. Leaving it would have the child's
        // manifest name a digest that nothing in its toolkit carries — provenance describing bytes
        // that were deliberately not delivered.
        ...inherited.sources.filter((source) => source.kind === "skill" && !withheldFromDelegator.has(path.posix.basename(source.path))),
        ...(own?.sources ?? []).filter((source) => source.kind === "skill" && !inherited.sources.some((candidate) => candidate.referenceId === source.referenceId && candidate.sha256 === source.sha256)),
      ]),
      skills,
      skillOrigins,
      mcp: structuredClone(own?.mcp ?? {}),
      hooks: structuredClone(own?.hooks ?? {}),
      pi: structuredClone(own?.pi ?? { extensions: [], prompts: [], themes: [], packages: [] }),
    };
    const sha256 = crypto.createHash("sha256").update(JSON.stringify({
      adapter: projectionBase.adapter,
      skills: projectionBase.skills.map((skill) => ({ name: skill.name, sha256: skill.source.sha256 })),
      skillOrigins: projectionBase.skillOrigins,
    })).digest("hex");
    return { ...child, profileCapabilities: { ...projectionBase, sha256 } };
  }

  /**
   * The delegator's toolkit has two explicit grant doors: profile selection and installed plugins.
   * The plugin lockfile is the authority boundary: never scan a runtime home for ambient skills, and
   * only capture a skill-dir target that the installer recorded for this parent's measured runtime.
   * Capturing the recorded target (rather than asking whether the child runtime directory exists)
   * also keeps delegation independent from plugin runtime detection/materialization ordering.
   */
  private delegableToolkit(agentName: string, agent: AgentEntry): ResolvedAgentCapabilityProjection | undefined {
    const declared = agent.profileCapabilities;
    const runtime = adapterFor(agent.cmd)?.runtime;
    if (!runtime) return declared;
    if (runtime !== "claude" && runtime !== "codex" && runtime !== "grok" && runtime !== "pi") return declared;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.opts.workspaceRoot, LOCKFILE_REL_PATH), "utf8");
    } catch {
      return declared;
    }
    const parsed = parseLockfile(raw);
    if (!parsed.lockfile) return declared;

    const skills = structuredClone(declared?.skills ?? []);
    const sources = structuredClone((declared?.sources ?? []).filter((source) => source.kind === "skill"));
    // t-b0cfd4 — what the parent's own config already withheld, by name. The config layer is where a
    // stale pin is visible at all (it holds the profile and the expected digest); by the time the
    // lockfile is read here the capture succeeds and looks perfectly healthy. Without this the two
    // layers would contradict each other in the worst direction: the parent runs without the skill
    // because the human has not re-approved it, and the child gets it anyway.
    const withheldByProfile = new Set((agent.profileWithheldCapabilities ?? []).map((entry) => entry.name));
    for (const plugin of Object.values(parsed.lockfile.plugins).sort((left, right) => left.name.localeCompare(right.name))) {
      for (const target of plugin.targets
        .filter((candidate) => candidate.kind === "skill-dir" && candidate.runtime === runtime)
        .sort((left, right) => left.file.localeCompare(right.file))) {
        const skillName = path.posix.basename(target.file);
        if (withheldByProfile.has(skillName)) {
          const withheld = (agent.profileWithheldCapabilities ?? []).find((entry) => entry.name === skillName);
          this.notifyDelegatedToolkitCondition(
            `profile-withheld:${agentName}:${skillName}:${withheld?.expectedSha256 ?? ""}:${withheld?.consumedSha256 ?? ""}`,
            `delegated toolkit withheld '${skillName}': '${agentName}' does not hold it either — its content changed `
            + "since it was authorized. Use Reauthorize in Agent Studio → Runtime tooling to accept the new content.",
          );
          continue;
        }
        // t-b505b3 follow-up — one uncapturable grant must not cost the caller the whole spawn.
        // `inspectCapabilitySourceAtRoot` throws per SOURCE (too-large, unsafe-path, io, …), and
        // before the delegated toolkit existed nothing here was captured, so those throws had no
        // reachable caller. Now they do: `product-foundation` is a legitimate 8.1 MiB plugin skill
        // against a 1 MiB capture cap, and letting it propagate refused EVERY delegation in the
        // workspace, for every runtime. Withhold the one grant BY NAME — the same shape
        // `planProjectedPluginHooks` uses — instead of failing the delegation closed: the child
        // losing one tool it may not need is recoverable, being unable to exist is not.
        let captured: ReturnType<typeof inspectCapabilitySourceAtRoot>;
        try {
          captured = inspectCapabilitySourceAtRoot(this.opts.workspaceRoot, target.file);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.notifyDelegatedToolkitCondition(
            `capture-failed:${agentName}:${plugin.name}:${skillName}:${detail}`,
            `delegated toolkit withheld skill '${skillName}' from plugin '${plugin.name}': `
            + `${detail} — the child spawns without it`,
          );
          continue;
        }
        const existing = skills.find((skill) => skill.name === skillName);
        if (existing && existing.source.sha256 !== captured.sha256) {
          // t-b0cfd4 — WITHHOLD, whatever the provenance. 4601017b had this branch refresh the
          // parent's snapshot when the fresh bytes came from this same plugin, on the reasoning that
          // one skill at two points in time is not a conflict. That reasoning is right and the
          // conclusion was wrong: refreshing hands the CHILD bytes no human approved, which is the
          // one thing the parent's pin exists to prevent — and it made the two layers disagree, the
          // config withholding the changed skill while delegation quietly delivered it.
          //
          // The parent's own copy still crosses: those bytes ARE approved. Only the plugin's newer
          // ones are held back, by name, and the spawn continues — a child missing one tool is
          // recoverable, and re-pinning stays a human gesture in Agent Studio.
          this.notifyDelegatedToolkitCondition(
            `plugin-conflict:${agentName}:${plugin.name}:${skillName}:${existing.source.sha256}:${captured.sha256}`,
            `delegated toolkit withheld plugin '${plugin.name}'s '${skillName}': its content differs from the copy `
            + `'${agentName}' authorized, and the child receives only approved bytes. `
            + "Use Reauthorize in Agent Studio → Runtime tooling to accept the new content.",
          );
          continue;
        }
        if (!existing) skills.push({ name: skillName, source: captured });
        const referenceId = `plugin:${plugin.name}:${skillName}`;
        if (!sources.some((source) => source.referenceId === referenceId && source.sha256 === captured.sha256)) {
          sources.push({
            referenceId,
            kind: "skill",
            scope: "project",
            owner: `plugin:${plugin.name}`,
            path: target.file,
            sha256: captured.sha256,
          });
        }
      }
    }
    if (skills.length === 0) return declared;
    return {
      schemaVersion: 1,
      adapter: declared?.adapter ?? runtime,
      sha256: declared?.sha256 ?? "",
      sources,
      skills,
      mcp: structuredClone(declared?.mcp ?? {}),
      hooks: structuredClone(declared?.hooks ?? {}),
      pi: structuredClone(declared?.pi ?? { extensions: [], prompts: [], themes: [], packages: [] }),
    };
  }

  /** SDD 478 — the Agent arm of a declared entry, or undefined for a terminal. Every agent-only
   *  capability below is read through this narrowing rather than through a `kind` conditional. */
  private agentDefinitionOf(name: string): AgentEntry | undefined {
    return asAgent(this.definitionOf(name));
  }

  private assertProfileLifecycleEnabled(name: string, definition = this.definitionOf(name)): void {
    const agent = asAgent(definition);
    if (agent?.profileLifecycle) this.opts.assertSpawnAllowed?.(name);
    if (agent?.profileLifecycle?.enabled !== false) return;
    throw new Error(`cannot launch '${name}': canonical agent profile is disabled`);
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
    // SDD 477 / t-0338fc — an unauthenticated runtime is a HUMAN's problem, surfaced with the same
    // sentence a transcript-detected one gets, so the launch boundary names the agent, the runtime and
    // the safe action rather than a bare code. Refused unconditionally: this is the one case where
    // letting the launch through produces a healthy-looking agent answering on a model nobody chose.
    if (result.state === "unauthenticated") {
      const evidence = authRequiredFromPreflight(result.runtime, result.reportedLine);
      if (evidence) this.reportAuthRequired(name, evidence);
      throw new RuntimeLaunchPreflightError(result);
    }
    if (result.state === "unsupported" || result.state === "failed") throw new RuntimeLaunchPreflightError(result);
    if (result.state === "unverifiable" && parsed.model && failClosedUnverifiable) throw new RuntimeLaunchPreflightError(result);
  }

  /** Public read of an agent's definition (the saved config wins, then a Temporary definition) — spec 216 needs
   *  command/instructions to detect compaction and rebuild persistent context. */
  defOf(name: string): AgentDef | undefined {
    return this.definitionOf(name);
  }

  /** An agent's kind (config wins, then Temporary def, else infer from a running session's
   *  command). Used to give Temporary TERMINALS terminal defaults (e.g. attention off) — F5. */
  kindOf(name: string): EntryKind {
    return this.definitionOf(name)?.kind ?? "agent";
  }

  async isReady(name: string): Promise<boolean> {
    if (this.readyAgents.has(name)) return true;
    // The sets above are intentionally process-local.  On an extension restart, recover the
    // gate for a declared, still-live Codex session rather than treating its missing entry as
    // ready.  Other/unknown agents retain the historic permissive behavior: we have no stable
    // terminal affordance with which to gate them.
    const agent = this.agentDefinitionOf(name);
    const candidate = agent ? adapterFor(agent.cmd) : undefined;
    const managedAgent = candidate && LAUNCH_READINESS_RUNTIMES.has(candidate.runtime) ? candidate : undefined;
    if (!this.provisionalAgents.has(name)) {
      if (!managedAgent || !(await this.opts.tmux.hasSession(this.session(name)).catch(() => false))) return true;
      this.provisionalAgents.add(name);
    }
    // A timeout is deliberately not terminal. Assignment is a later, cheap re-observation
    // point: it can promote a runtime that finished booting after the bounded launch window.
    if (!managedAgent) return false;
    const observed = this.readinessAdapter(agent!.cmd).classify(
      await this.opts.tmux.capturePane(this.session(name), { lines: 80, joinWrapped: true }).catch(() => ""),
    );
    if (observed?.state === "ready") {
      this.readyAgents.add(name);
      this.provisionalAgents.delete(name);
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
    const agent = this.agentDefinitionOf(name);
    if (!agent || binaryOf(agent.cmd) !== "codex") return undefined;
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
      // The bounded launch observation has reached a terminal answer. tmux remains the authority for
      // any pane that compensation fails to kill; keeping the process-local reservation cannot make
      // that pane safer, and used to leave a sessionless rejected launch blocking Forget forever.
      this.provisionalAgents.delete(name);
      // SDD 477 — an auth rejection is a HUMAN's problem, not a retryable fault. When the runtime
      // declared a measured signal, re-read the pane once to attach what the human must do, so the
      // failure names the runtime and the safe action instead of a bare code that invites a retry.
      let authRequired: AuthRequiredEvidence | undefined;
      if (readiness.code === "runtime_auth_rejected") {
        try {
          authRequired = classifyAuthRequired(
            adapter.runtime,
            await this.opts.tmux.capturePane(session, { lines: 80, joinWrapped: true }),
          );
        } catch {
          /* the pane may already be gone; an unexplained auth rejection is still honest */
        }
      }
      const primary = new RuntimeLaunchReadinessError(readiness.code, authRequired);
      if (authRequired) {
        this.reportAuthRequired(name, authRequired);
      }
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
    if (readiness.state === "ready") {
      this.readyAgents.add(name);
      this.provisionalAgents.delete(name);
    }
  }

  /** spec 332 — the lineage parent recorded for this agent (live projection first, durable ledger
   *  fallback), if any. Used by the death-poke wiring to find who to wake. t-384a3f:
   *  falls back to the persisted ledger the same way liveDescendants does — during reload the durable
   *  row can be visible before the process-local projection is rebuilt, and this is used for an
   *  AUTHORIZATION decision (inWaitOutputScope), so an in-memory miss must not read as "no parent". */
  parentOf(name: string): string | undefined {
    return this.lineage.get(name) ?? this.ledgerParentOf(name);
  }

  /** SDD 482 durable roster owner. Kept separate from runtime lineage: activating a Saved Agent
   *  does not manufacture a parent edge, while lifecycle governance can still recognize the
   *  owner declared by the human in tachyon.yml. */
  declaredOwnerOf(name: string): string | undefined {
    return this.opts.getConfig()?.declaredOwner?.[name];
  }

  /**
   * t-5e1113 (SDD 482, decision 5) — the ONE place a persisted parent is admitted, so the instance
   * bound is applied identically everywhere instead of being re-derived per reader.
   *
   * Two refusals, each with a reason the readers must not have to remember:
   *  - an instance THIS process started has already settled its lineage at spawn, including having
   *    none, so a row describing some earlier instance must not re-nest it;
   *  - a row naming itself as parent is a cycle, not a lineage. `withoutSelfParent` stops new ones
   *    reaching disk; this covers rows written before it existed.
   *
   * The fallback itself stays (rather than trusting `lineage` alone) because `liveDescendants` is a
   * safety guard against yanking a running child's cwd, and there failing closed means keeping the
   * child visible.
   */
  private ledgerParentOf(name: string): string | undefined {
    if (this.startedHere.has(name)) return undefined;
    const parent = this.opts.ledger?.get(name)?.def?.parent;
    return parent && parent !== name ? parent : undefined;
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
    // Union the live projection with persisted ledger parents. The same durable source covers Saved
    // and Temporary instances; without it the guard could miss a child during reload and yank its cwd.
    const ledgerParent = new Map<string, string>();
    if (this.opts.ledger) {
      for (const [c] of this.opts.ledger.all()) {
        const parent = this.ledgerParentOf(c); // same instance bound as parentOf
        if (parent) ledgerParent.set(c, parent);
      }
    }
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
   * Spec 211 / t-d542ac: after a host restart, rebuild Temporary definitions where needed and
   * runtime lineage for BOTH lifetimes from the ledger. Config remains authoritative only for a
   * Saved definition; it does not own the instance lineage. Idempotent; self-parent links are dropped.
   */
  async rehydrateFromLedger(): Promise<void> {
    if (!this.opts.ledger) return;
    const declared = new Set(Object.keys(this.opts.getConfig()?.agents ?? {}));
    for (const [name, rec] of this.opts.ledger.all()) {
      if (!rec.def) continue;
      // t-5e1113 (SDD 482, decision 5) — this used to `continue` for every config-owned row, which
      // skipped the lineage restore below as well. Persisting a Saved agent's parent would therefore
      // have changed nothing on its own: the row was never read back. Only the DEFINITION is config's
      // to own; the execution lineage below is the ledger's, for Saved and Temporary alike.
      const configOwned = !isTemporaryInstance(rec) || declared.has(name);
      // t-eb4b30 — no definition is copied into memory here any more. This loop used to rebuild the
      // `AgentDef` into a second map; `definitionOf` now derives it from this same row on demand, via
      // the same `temporaryDefinitionFrom`. What remains below is what only the ledger can answer:
      // lineage, delegator and clean-exit, for Saved and Temporary alike.
      // The instance bound: only adopt a ledger parent for an instance this process did not start.
      // If we started it, its lineage was settled at spawn — including deliberately having none.
      if (rec.def.parent && rec.def.parent !== name && !this.lineage.has(name) && !this.startedHere.has(name)) {
        this.lineage.set(name, rec.def.parent);
      }
      if (!this.delegators.has(name)) {
        const delegator = rec.def.delegator;
        if (delegator && delegator !== name) this.delegators.set(name, delegator);
      }
      // Left gated on the non-config-owned rows it has always applied to: decision 5 is about
      // lineage, and widening clean-exit rehydration is a separate question with its own consequences.
      if (!configOwned && rec.lifecycle?.state === "clean-exited") this.cleanExited.add(name);
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
  /**
   * Shared tmux read for agentStates/runningAgentsStrict. t-ab9b40: two concurrent callers (e.g.
   * LifecycleMonitor's poll and the rebind coordinator's boot scan) can dispatch in one order and
   * RESOLVE in another — a plain "always overwrite on success" cache write would let the
   * older-dispatched read clobber a newer one that already landed. Each read is stamped with a
   * dispatch-order sequence number; the write is applied only if no later-dispatched read has
   * already applied. Self-heals on the next successful read either way.
   */
  private async readAgentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }> | null> {
    const seq = ++this.tmuxReadSeq;
    const sessions = await this.opts.tmux.sessionStates(this.prefix);
    if (sessions === null) return null;
    const out = new Map<string, { dead: boolean; exitCode?: number }>();
    for (const [session, state] of sessions) {
      const agent = agentFromSession(this.opts.wsHash, session);
      if (agent !== null) out.set(agent, state);
    }
    if (seq > this.tmuxReadAppliedSeq) {
      // Compare against the previous inventory BEFORE replacing it: the alive→dead transition is
      // observable exactly here. Reprocessing a standing dead state on every poll would lose the
      // one-shot boundary needed to persist a requested stop.
      //
      // Guarded by `seq` for the same reason the cache is: a read dispatched earlier must not resolve
      // later and re-announce a death against a newer inventory.
      this.observeAgentDeaths(this.lastAgentStates, out);
      this.lastAgentStates = out;
      this.tmuxReadAppliedSeq = seq;
    }
    return out;
  }

  /**
   * Every agent that was alive in `previous` and is dead in `next` — the ONE seam where a death is an
   * event rather than a standing condition. Two things happen here, and both need this exact moment:
   *
   *  1. t-9d76b1 — a stop Tachyon ASKED FOR is stamped on the durable row while we still know it was
   *     asked. The in-memory intent dies with the extension host; the dead pane does not (remain-on-exit
   *     keeps it until dismiss/restart), so without this a window reload would re-read a requested stop
   *     as a crash. `lifecycle` is the row's terminal state, and spawn (fresh record), restart and
   *     resume all drop it, so a stamp can never leak into the next instance.
   */
  private observeAgentDeaths(
    previous: ReadonlyMap<string, { dead: boolean; exitCode?: number }>,
    next: ReadonlyMap<string, { dead: boolean; exitCode?: number }>,
  ): void {
    for (const [agent, state] of next) {
      const before = previous.get(agent);
      if (!before || before.dead || !state.dead) continue;
      const requested = this.stopRequestedAt.has(agent);
      if (requested) this.stampRequestedStop(agent);
    }
  }

  /**
   * t-9d76b1 — persist "Tachyon asked for this exit" on the row, once, at the death.
   *
   * Best-effort by construction: an agent with no ledger row (a declared terminal with no adapter,
   * worktree or parent never gets one) has nowhere to keep this, so its intent
   * lives only as long as this process does. Silent rather than warned — a durability side-channel must
   * never turn a stop the human asked for into an error report.
   */
  private stampRequestedStop(name: string): void {
    const ledger = this.opts.ledger;
    if (!ledger) return;
    try {
      const rec = ledger.get(name);
      if (!rec || rec.lifecycle?.state === "stopped") return;
      ledger.record(name, { ...rec, lifecycle: { state: "stopped", exitedAt: new Date().toISOString() } });
    } catch {
      /* best-effort: the row may be gone (a Temporary collected by a concurrent dismiss) */
    }
  }

  async agentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }>> {
    return (await this.readAgentStates()) ?? this.lastAgentStates;
  }

  /** t-4736b4 — a removal asks tmux this many times before it calls occupancy unverifiable. */
  private static readonly OCCUPANCY_PROBE_ATTEMPTS = 3;
  private static readonly OCCUPANCY_PROBE_DELAY_MS = 100;

  /**
   * t-4736b4 — STRICT, FRESH occupancy for the removal path.
   *
   * `agentStates()` serves `lastAgentStates` when the tmux read comes back ambiguous, and that
   * fallback is right for the readers it was built for (t-3a3a14): the sidebar must not blink every
   * agent out of existence over one bad `list-panes`. It is exactly wrong for a removal. A
   * last-known-LIVE snapshot is a memory of the past, and the past is not evidence that the agent is
   * running now — five agents killed through the Bridge, confirmed `running:false`, were refused
   * canonical forget indefinitely because the pre-kill snapshot kept answering for tmux, and no
   * retry could clear it (nothing invalidates the cache except a successful read, which is the very
   * thing that was failing).
   *
   * So this never consults the cache. It reports what it MEASURED:
   *  - `occupied` — a fresh inventory / session probe found the name. An in-process launch
   *    reservation strengthens that measured positive, but cannot veto when tmux contradicts it. A
   *    dead remain-on-exit pane counts: it is still present in tmux and still has to be torn down
   *    before forget can claim zero occupancy.
   *  - `free` — a fresh inventory came back and the name was not in it.
   *  - `unknown` — tmux could not be inventoried. Neither alive nor dead; the caller must fail closed
   *    and say which of the two it could not establish.
   *
   * A successful read still refreshes `lastAgentStates` (via `readAgentStates`), so this also heals
   * the cache the other readers depend on.
   */
  async probeAgentOccupancy(name: string): Promise<AgentOccupancyVerdict> {
    // A provisional launch marker is only a belief about tmux: it must be reconciled against the
    // world below before it can veto removal (t-dbddeb).
    const provisionalLaunch = this.provisionalAgents.has(name);

    // Retry the fresh inventory before giving up: a transient `list-panes` failure (racing a
    // concurrent kill, a momentarily busy server) is the common cause of `null`, and re-asking is
    // what makes "unverifiable" a rare, real condition instead of a coin flip.
    let states: Map<string, { dead: boolean; exitCode?: number }> | null = null;
    for (let attempt = 0; attempt < AgentManager.OCCUPANCY_PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(AgentManager.OCCUPANCY_PROBE_DELAY_MS);
      states = await this.readAgentStates();
      if (states !== null) break;
    }
    if (states === null) {
      return {
        state: "unknown",
        detail: `the tmux session inventory could not be read after ${AgentManager.OCCUPANCY_PROBE_ATTEMPTS} attempts`,
      };
    }
    const state = states.get(name);
    if (state) {
      if (provisionalLaunch) {
        return {
          state: "occupied",
          detail: `an in-process launch reservation is confirmed by tmux (${state.dead ? "a stopped pane is still present" : "the session is running"})`,
        };
      }
      return { state: "occupied", detail: state.dead ? "a stopped pane is still present in tmux" : "the session is running" };
    }

    // `hasSession` can only ADD occupancy here. Its negative is worthless as proof — it answers false
    // for an unreachable server too — but the fresh inventory above already supplied the negative,
    // and this catches the one thing `list-panes` cannot see: a session with no panes at all.
    try {
      if (await this.opts.tmux.hasSession(this.session(name))) {
        return {
          state: "occupied",
          detail: provisionalLaunch
            ? "an in-process launch reservation is confirmed by tmux (a session with this name is still present)"
            : "a tmux session with this name is still present",
        };
      }
    } catch (error) {
      return { state: "unknown", detail: `the tmux session probe failed (${error instanceof Error ? error.message : String(error)})` };
    }
    if (provisionalLaunch) {
      // Reconcile once: repeated removal phases must not re-warn about the same residue. This marker
      // protected the launch race while it was unmeasured; after two fresh tmux negatives, preserving
      // it would preserve only the leak, not a live process.
      this.provisionalAgents.delete(name);
      this.opts.notify?.(
        `agent '${name}': Tachyon believed a launch was still in flight, but tmux measured no session '${this.session(name)}'; a stale in-process launch reservation remained after lifecycle cleanup and was cleared`,
        "warn",
      );
    }
    return { state: "free" };
  }

  /**
   * t-4736b4 — the removal-side gate. `occupiedMessage` stays phase-specific (prepare and converge
   * refuse for different reasons at different points in the transaction); the unverifiable refusal is
   * one message everywhere, because there is only one thing to say about it.
   */
  private async assertRemovalOccupancyFree(
    name: string,
    occupiedCode: AgentProfileRefusalCode,
    occupiedMessage: string,
  ): Promise<void> {
    const verdict = await this.probeAgentOccupancy(name);
    if (verdict.state === "occupied") throw new AgentProfileRefusal(occupiedCode, `${occupiedMessage} (${verdict.detail})`);
    if (verdict.state === "unknown") throw new AgentOccupancyUnverifiableError(name, verdict.detail);
  }

  /** Agents whose process is ALIVE — crashed dead panes don't count. */
  async runningAgents(): Promise<string[]> {
    const states = await this.agentStates();
    return [...states.entries()].filter(([, s]) => !s.dead).map(([agent]) => agent);
  }

  /**
   * t-9d76b1 — did Tachyon ask this agent's CURRENT instance to exit?
   *
   * The same two sources `list()` reads, in the same order: this process's own record of the request,
   * then the durable terminal state a reload would otherwise have lost. Sync and cheap enough for the
   * lifecycle tick, which is the caller that must not announce a crash the human ordered.
   */
  wasStopRequested(name: string): boolean {
    if (this.stopRequestedAt.has(name)) return true;
    return this.opts.ledger?.get(name)?.lifecycle?.state === "stopped";
  }

  /**
   * t-6d09e6 — best-effort sync liveness from the last successful tmux inventory (no I/O).
   * Used by sync config writers (Agent Studio) that cannot await agentStates(). Prefer
   * runningAgents() when async is available; unknown → false (not running).
   */
  isKnownAliveSync(name: string): boolean {
    const s = this.lastAgentStates.get(name);
    return s !== undefined && !s.dead;
  }

  /**
   * t-016e8b: like runningAgents, but an ambiguous tmux read surfaces as null instead of the
   * last known-good snapshot — which on a fresh engine process is an empty Map, so the
   * "protection" would read as "no agents" exactly when rebind scans the boot inventory.
   * A successful read still refreshes lastAgentStates (subject to the t-ab9b40 freshness guard).
   */
  async runningAgentsStrict(): Promise<string[] | null> {
    const out = await this.readAgentStates();
    if (out === null) return null;
    return [...out.entries()].filter(([, s]) => !s.dead).map(([agent]) => agent);
  }

  async list(): Promise<ManagedEntryInfo[]> {
    const states = await this.agentStates();
    const config = this.opts.getConfig();
    // t-0ad300 — a refused agent is DECLARED. It counts as `saved` for lifetime and resume policy
    // for the same reason a healthy one does: the human wrote it in tachyon.yml. What it does not
    // get is a definition, so every `config.agents[name]` read below still misses and the row stays
    // command-less — and `assertSpawnAllowed` refuses it outright.
    const refusedAgents = this.opts.getRefusedAgents?.() ?? {};
    const declared = [...Object.keys(config?.agents ?? {}), ...Object.keys(refusedAgents)];
    // t-eb4b30 — Temporary names come from the ledger, which is where their definitions are. The old
    // map was repopulated from these same rows on every activation, so in steady state this is the same
    // set; it differs only on the paths where the map and the row disagreed, and those were bugs.
    // ONE ledger snapshot for the whole listing. `definitionOf` would otherwise re-read and re-parse
    // the file once per name below — `get()` is `all()` behind a single key — turning a UI refresh into
    // N disk reads. The old in-memory map made that free; the fix is to read once, not to keep a cache.
    const rows = this.opts.ledger?.all();
    const all = new Set([...declared, ...states.keys(), ...this.temporaryNames(rows), ...this.cleanExited]);
    const now = Date.now();
    const infos = [...all].sort().map((name) => {
      const state = states.get(name);
      const alive = state !== undefined && !state.dead;
      const stoppingAt = this.stoppingSince.get(name);
      const stopTimedOut = alive && stoppingAt !== undefined && now - stoppingAt >= AgentManager.STOPPING_FALLBACK_MS;
      if (stopTimedOut) {
        this.stopFailed.add(name);
        // Keys were sent; the process did not die within the bounded wait. Force is explicit
        // (Kill forced) so a Saved Agent is never torn down without a deliberate hard stop.
        this.stopFailureDetail.set(name, {
          stage: "await-exit",
          reason: "process still alive after graceful key sequence",
          nextAction: "Kill forced",
        });
      }
      const stopping = alive && stoppingAt !== undefined && !stopTimedOut;
      const stopFailed = alive && this.stopFailed.has(name);
      const stopFailure = stopFailed ? this.stopFailureDetail.get(name) : undefined;
      if (state === undefined || state.dead || stopTimedOut) {
        this.stoppingSince.delete(name);
      }
      if (state === undefined || state.dead) {
        this.clearStopFailed(name);
      }
      const recordedInstance = this.opts.ledger?.get(name)?.instance;
      const hasStartedTurn = this.opts.hasStartedTurn?.(name);
      // t-9d76b1 — the intent, from this process if it made the request and from the row if a reload
      // lost it. Read off the ONE ledger snapshot this listing already took, so it costs no extra I/O.
      const stopRequested = this.stopRequestedAt.has(name) || rows?.get(name)?.lifecycle?.state === "stopped";
      return {
        name,
        session: this.session(name),
        running: alive,
        ...(hasStartedTurn !== undefined ? { hasStartedTurn } : {}),
        ...(stopping ? { stopping: true } : {}),
        ...(stopFailed ? { stopFailed: true } : {}),
        // t-04052d — THE ONE PLACE the roster's durability question is answered.
        //
        // CONFIG FIRST, and that order is the pre-existing rule rather than a new choice: a name
        // declared in `tachyon.yml` has a durable Profile, and a ledger row that disagrees is a stale
        // shadow of some earlier instance that held the name. "Config wins, not the ledger shadow" is
        // already pinned by test, and inverting it inside a field rename would be a behavior change
        // smuggled in as vocabulary.
        //
        // This is not the inference the cut removes. That one read a RUNNING INSTANCE's policy off
        // config; this row is a ROSTER entry, and `instance` below still carries the instance's own
        // declared policy untouched for readers who are asking about the instance rather than the name.
        //
        // The fallback is fail-closed for the same reason the helpers are: an unknown name with a
        // policy-less row reads as temporary rather than being granted Saved capability on a guess.
        lifetime: declared.includes(name) ? "saved" : (recordedInstance?.lifetime ?? "temporary"),
        // Same config-first order, same fail-closed tail: a config Profile can always be started again,
        // otherwise the recorded policy answers, otherwise `collected` (withhold, never grant).
        resumePolicy: declared.includes(name) ? "restartable" : (recordedInstance?.resumePolicy ?? "collected"),
        ...(stopFailure ? { stopFailure } : {}),
        ...(recordedInstance ? { instance: recordedInstance } : {}),
        dead: state?.dead ?? false,
        // t-9d76b1 — TWO questions, two sources. `exitCode !== 0` still answers its own ("did it exit
        // cleanly?"); `stopRequested` answers the one it was being made to answer ("did it die, or did
        // I stop it?"). A crash that happens to exit 130 has no request behind it and stays a crash.
        crashed: (state?.dead ?? false) && state?.exitCode !== 0 && !stopRequested,
        ...(stopRequested ? { stopRequested: true } : {}),
        exitCode: state?.exitCode,
        ...(!state && this.cleanExited.has(name) ? { cleanExited: true } : {}),
        // Same answer as `definitionOf(name)?.kind`, read from the snapshot above: a Saved definition
        // wins, else the Temporary's row, else the default arm.
        kind: config?.agents[name]?.kind ?? rows?.get(name)?.def?.kind ?? "agent",
        parent: this.lineage.get(name),
        delegator: this.delegators.get(name),
        declaredOwner: config?.declaredOwner[name],
        ...(refusedAgents[name] !== undefined ? { refused: refusedAgents[name] } : {}),
      };
    });
    return infos;
  }

  async listAgents(): Promise<ManagedEntryInfo[]> {
    return (await this.list()).filter(({ kind }) => kind === "agent");
  }

  async listTerminals(): Promise<ManagedEntryInfo[]> {
    return (await this.list()).filter(({ kind }) => kind === "terminal");
  }

  /**
   * spec 216 — The launch command with persistent instructions and Bridge guidance applied. The prompt
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
   * Composed spawn brief (project guidance + instructions + primer + brief-file diversion). Shared by
   * `effectiveCmd` (argv delivery) and Hermes `HERMES_TUI_QUERY` (env delivery).
   */
  private effectiveInstructions(
    name: string,
    def: AgentDef,
    parent: string | undefined,
    primerCtx?: { delegator?: string; freshWorktree?: boolean },
    taskBrief?: string,
    taskContract?: SpawnContract,
    projectGuidance?: RenderedProjectGuidanceBundle,
    sessionWorkRecord?: SessionWorkRecord,
  ): string | undefined {
    // An explicit --resume/--continue/--session-id command owns its transcript and argv. Do not add
    // even declared instructions as a positional startup prompt; several runtimes reject or
    // reinterpret extra arguments on their resume form.
    const agent = asAgent(def);
    if (managesOwnSession(def.cmd) || (agent && !instructionsDeliverable(agent.cmd))) return undefined;
    const taskContractCompletion = taskContract ? spawnContractCompletion(taskContract) : undefined;
    if (taskContract && !taskContractCompletion) {
      throw new Error(
        `agent '${name}' spawn contract is invalid: expected exactly one non-empty deliverable or done_when`,
      );
    }
    const guidance = !!parent && (this.opts.getConfig()?.settings.bridgeGuidance ?? true);
    const composed = composeAgentPrompt({
      instructions: asAgent(def)?.instructions,
      bridgeGuidance: guidance,
      taskBrief,
      taskContractCompletion,
      sessionWorkRecord,
    });
    // Project-owned policy is body content, not product protocol. Put it before the task body
    // (task-specific instructions stay more recent) and before the long-brief diversion so an
    // arbitrarily long configured document can never bypass tmux's measured payload ceiling.
    const body = [projectGuidance?.body, composed.body].filter((part): part is string => !!part?.trim()).join("\n\n");
    const startupManifest = {
      projectGuidanceSources: projectGuidance?.sourceCount ?? 0,
      prompt: composed.manifest,
    };
    const frame = (deliverable: string | undefined): string | undefined => agent
      ? wrapWithPrimer(deliverable ?? "", {
          agentName: name,
          delegator: primerCtx?.delegator,
          parent,
        })
      : deliverable;
    // Size-check the exact successful-write pointer before deliverableBody atomically replaces any
    // prior brief. Thus an oversized dynamic fact cannot change what the still-running pane's old
    // pointer reads when restart is rejected.
    const preview = body ? previewDeliverableBody(this.opts.workspaceRoot, name, body, startupManifest) : undefined;
    const previewInstructions = frame(preview);
    if (previewInstructions) assertSafeBriefTransport(previewInstructions, `agent '${name}' startup brief`);

    const deliverable = body ? deliverableBody(this.opts.workspaceRoot, name, body, startupManifest) : undefined;
    const instructions = frame(deliverable);
    if (instructions) assertSafeBriefTransport(instructions, `agent '${name}' startup brief`);
    return instructions?.trim() ? instructions : undefined;
  }

  /**
   * t-e3aaae — the durable answer to "what am I working on, and where am I allowed to do it?", for a
   * restart that mints a NEW conversation. Both halves come from record, never from the pane the
   * restart just discarded: isolation from the worktree row (or its documented absence), assignments
   * from the board resolver.
   *
   * Fail-closed by design: an unreadable board throws out of here, and because every caller runs it
   * before the first live-pane mutation, the running agent is left exactly as it was rather than
   * replaced with a session that cannot say what it is for.
   */
  private sessionWorkRecordFor(
    name: string,
    def: AgentDef,
    worktree: WorktreeRecord | undefined,
    cwd: string,
    /** t-9d250c — the frozen brief this launch is about to replay, for stale-reference reporting. */
    replayedBrief?: string,
    /**
     * t-7f3009 — which launch is asking. A spawn needs this record for the SAME reason a restart does:
     * the brief it carries can be frozen from an earlier launch and name work the board has closed.
     */
    launch: SessionLaunchKind = "restart",
  ): SessionWorkRecord | undefined {
    if (!this.opts.assignedWork) return undefined;
    // Same gate `projectGuidanceFor` uses: a launch with no channel for a startup document gets no
    // record either, and must not be refused over a board it would never have been shown.
    const agent = asAgent(def);
    if (!agent || managesOwnSession(agent.cmd) || !instructionsDeliverable(agent.cmd)) return undefined;
    let rows: BoardAssignmentRow[];
    try {
      rows = this.opts.assignedWork(name);
    } catch (error) {
      throw new Error(
        `refusing ${launch} for agent '${name}': its assigned work could not be read, so a new session ` +
        "cannot be told what it is working on; fix the task store and retry",
        { cause: error },
      );
    }
    // t-9d250c — one current task, deterministically chosen; the rest are queue. The filter lives in
    // the selector so `active`-and-mine is one rule with one test, not a predicate repeated per caller.
    const assignment = selectAssignedWork(rows, name);
    // A stale-reference lookup must never cost the restart: the board read above is the fail-closed
    // part, this is decoration, and a store that throws here would turn a describable brief into a
    // refused restart for no safety gain.
    let stale: ReturnType<typeof staleContractReferences> = [];
    try {
      if (this.opts.taskStatusById) {
        stale = staleContractReferences(replayedBrief, assignment, this.opts.taskStatusById);
      }
    } catch {
      stale = [];
    }
    const durable = worktree ?? this.opts.ledger?.get(name)?.worktree;
    return {
      launch,
      isolation: durable
        ? { kind: "worktree", path: durable.path, branch: durable.branch }
        : { kind: "shared", cwd },
      assignment,
      ...(stale.length > 0 ? { staleContractReferences: stale } : {}),
    };
  }

  private projectGuidanceFor(def: AgentDef): RenderedProjectGuidanceBundle | undefined {
    // A command that explicitly resumes/manages its own transcript is the same no-push exception as
    // Workspace.resume(): adding a positional onboarding prompt can change or break its semantics.
    // Unsupported startup adapters cannot carry a prompt either; do not read configured files for a
    // launch that has no delivery channel. Manual re-anchor remains available once such an agent runs.
    const agent = asAgent(def);
    if (!agent || managesOwnSession(agent.cmd) || !instructionsDeliverable(agent.cmd)) return undefined;
    return loadAndRenderProjectGuidanceBundle(this.opts.workspaceRoot, this.opts.getConfig()?.settings.projectGuidance);
  }

  private applyAgentPermissionProjection(
    name: string,
    cmd: string,
    delegated = false,
    authoredNativePermissions?: { approvalPolicy?: string; sandboxMode?: string },
  ): string {
    const runtime = binaryOf(cmd);
    const authored = this.opts.resolveAgentPermissionProjection?.(name, runtime);
    if (authored !== undefined) {
      if (runtime !== "grok" && runtime !== "codex") {
        throw new Error(`agent '${name}': authored permission projection targets an unsupported runtime '${runtime}'`);
      }
      if (authored.runtime !== runtime) {
        throw new Error(`agent '${name}': authored permission projection targets an unsupported runtime '${runtime}'`);
      }
      if (authored.runtime === "grok") {
        const parsed = parseLaunchCommand(cmd)?.argv ?? [];
        const flag = parsed.findIndex((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="));
        if (flag >= 0) {
          const explicit = parsed[flag] === "--permission-mode" ? parsed[flag + 1] : parsed[flag]!.slice("--permission-mode=".length);
          if (explicit !== authored.mode) {
            throw new Error(`agent '${name}': command permission mode '${explicit ?? "missing"}' conflicts with authored mode '${authored.mode}'`);
          }
        } else {
          cmd += ` --permission-mode ${authored.mode}`;
        }
        return cmd;
      }
      return applyCodexPermissionDoors(cmd, {
        approvalPolicy: authored.approvalPolicy,
        sandboxMode: authored.sandboxMode,
        bridgeToolApproval: authored.bridgeToolApproval,
      });
    }
    if (
      delegated
      && runtime === "grok"
      && !/(^|\s)--permission-mode(?:=|\s|$)/.test(cmd)
      && !/(^|\s)--always-approve(?:=|\s|$)/.test(cmd)
    ) {
      // t-84f0eb — owner-authored workspace product policy: delegated Grok matches the existing
      // Claude/Codex subagent posture and does not stop its coordinator for every tool call. This is
      // keyed from durable Tachyon lineage, never discovered from HOME, cwd or runtime settings.
      cmd += " --always-approve";
    }
    if (delegated && runtime === "codex") {
      // t-aaa2c6 — the same owner decision, reaching the runtime Tachyon actually writes production
      // code with. Codex needed THREE doors, not one flag (measured on codex-cli 0.146.0; see
      // CODEX_DELEGATED_* above). An authored profile that already states a door keeps its value:
      // a per-agent security decision must not be widened by a class default.
      cmd = applyCodexPermissionDoors(cmd, {
        ...(authoredNativePermissions?.approvalPolicy === undefined ? { approvalPolicy: CODEX_DELEGATED_APPROVAL_POLICY } : {}),
        ...(authoredNativePermissions?.sandboxMode === undefined ? { sandboxMode: CODEX_DELEGATED_SANDBOX_MODE } : {}),
        bridgeToolApproval: CODEX_DELEGATED_BRIDGE_TOOL_APPROVAL,
      });
    }
    return cmd;
  }

  private effectiveCmd(name: string, def: AgentDef, instructions: string | undefined, delegated = false): string {
    return composeCommand({
      cmd: this.applyAgentPermissionProjection(name, def.cmd, delegated, asAgent(def)?.profileNativeConfig?.permissions),
      instructions,
    });
  }

  /** t-e3d14c — suppress native identity inputs only for launches whose formation vector replaces them. */
  private applyFormationNativeSuppression(name: string, def: AgentDef): { def: AgentDef; applied: boolean } {
    if (!this.opts.formation?.suppressionRequired(name)) return { def, applied: false };
    const applied = applyNativeLaneSuppressionCommand(def.cmd);
    return { def: { ...def, cmd: applied.cmd }, applied: applied.applied };
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
  private materializeRuntimeHarness(
    name: string,
    def: AgentDef | undefined,
    cwd: string,
    delegated = false,
  ): MaterializedHarness | null {
    const isolation = def ? isolationMechanismForCommand(def.cmd) : undefined;
    // A private config home is an Agent capability: a terminal has no harness, no transcript
    // isolation and no canonical profile to project, so the narrowing decides it here.
    const agent = asAgent(def);
    // spec 357/profile 358 - private-home runtimes need a per-agent config home by default.
    const needsPrivateHome = !!agent?.harness || agent?.isolate === "transcript"
      || isolation?.mechanism === "private-home" || !!agent?.profileLifecycle
      || !!agent?.profileFork || !!agent?.profileCapabilities || !!agent?.profileNativeConfig;
    // A private config home is materialized for the Agent arm only, so the materializer receives an
    // AgentEntry and never has to ask what it was handed.
    if (!agent || !needsPrivateHome || !this.opts.materializeHarness) return null;
    try {
      return this.opts.materializeHarness({ name, def: agent, cwd, delegated });
    } catch (error) {
      // t-2656d7 — the ONE place a harness is materialized, so every door that can refuse a launch
      // for credentials converges here: sidebar ▶, restart, resume, autostart, crash restart, a
      // pipeline node, and a Bridge `spawn_agent`/`restart_agent`. The repository's ACTOR × TRIGGER
      // rule is why the interception sits at the convergence and not at the caller — the second
      // caller is the one that does not exist yet on the day of the plan.
      //
      // The error is RETHROWN unchanged: reporting is presentation, and swallowing the refusal here
      // would let a launch look like it succeeded.
      const evidence = authRequiredOf(error);
      if (evidence) this.reportAuthRequired(name, evidence);
      throw error;
    }
  }

  /**
   * t-2656d7 — the single exit for "this launch was refused because the runtime is not logged in".
   *
   * The fallback to `notify` is deliberate and is not a silent degrade: it is exactly today's
   * behavior, preserved for the constructions that wire no host (the AgentManager unit suites). The
   * production construction in `Workspace` always wires `onAuthRequired`.
   */
  private reportAuthRequired(name: string, evidence: AuthRequiredEvidence): void {
    if (this.opts.onAuthRequired) {
      this.opts.onAuthRequired(name, evidence);
      return;
    }
    this.opts.notify?.(describeAuthRequired(name, evidence), "warn");
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
    // Only an Agent has a redirected config home; a terminal falls through to the host default.
    const agent = asAgent(def);
    if (runtime === "opencode" && (agent?.harness || agent?.isolate === "transcript")) return path.join(harnessHome(this.opts.workspaceRoot, name), "data");
    // harness/isolate grok: GROK_HOME is `<harness>/<agent>/.grok` (HarnessManager.grokHome).
    if (runtime === "grok" && (agent?.harness || agent?.isolate === "transcript")) {
      return path.join(harnessHome(this.opts.workspaceRoot, name), ".grok");
    }
    if (agent?.harness || agent?.isolate === "transcript") return harnessHome(this.opts.workspaceRoot, name); // spec 226 / 240 / 298
    if (runtime === "claude" && (agent?.profileLifecycle || agent?.profileFork || agent?.profileCapabilities || agent?.profileNativeConfig)) {
      return harnessHome(this.opts.workspaceRoot, name);
    }
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
    if (runtime === "pi") return this.opts.materializePiSessionDir?.(name) ?? piSessionDir(this.opts.workspaceRoot, name);
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

  /** Spawns a declared agent, or a Temporary one when `opts.cmd` is given. */
  async spawn(name: string, opts?: SpawnOptions): Promise<void> {
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

  private async spawnUnlocked(name: string, opts?: SpawnOptions): Promise<void> {
    // t-8354ae — config-failure / LKG-only refusal (before any delivery or occupancy mutation).
    // An explicit cmd creates a Temporary identity only when the name is not already declared.
    const declared = this.opts.getConfig()?.agents[name];
    if (!opts?.cmd || declared) this.opts.assertSpawnAllowed?.(name);
    this.assertProfileLifecycleEnabled(name, declared ?? (opts?.cmd ? undefined : this.definitionOf(name)));
    return this.spawnCore(name, opts);
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
   * Release a stopped agent's own stale occupancy immediately before its governed worktree removal.
   *
   * A `dirty` occupancy normally remains quarantined until an explicit cleanup path proves it safe.
   * Worktree removal is that path: it already stopped the agent and rejected live descendants. Keep
   * the proof here, under the same occupancy lock, so ordinary callers cannot turn quarantine into
   * an unguarded "clear" operation.
   */
  async releaseOwnedWorktreeForRemoval(agent: string, worktreePath: string): Promise<void> {
    const key = this.canonicalWorktreeKey(worktreePath);
    await this.withWorktreeLock(key, async () => {
      await this.refreshWorktreeOccupancy(key, worktreePath);
      const occ = this.worktreeOccupancy.get(key);
      if (!occ) return;
      if (occ.agentId !== agent) {
        throw new Error(`worktree is ${occ.state === "dirty" ? "quarantined by" : "occupied by"} agent '${occ.agentId}' (cwd ${occ.cwd})`);
      }
      // t-4736b4 — the third door on the same removal trail (delete with `removeWorktree:true` walks
      // `removeAgentWorktree` → here → `prepareAgentProfileForget`), and it inherited the same stale
      // snapshot. Measured, never cached; unmeasurable refuses as unverifiable.
      await this.assertRemovalOccupancyFree(
        agent,
        "agent-profile/worktree-release-agent-running",
        `agent '${agent}' must be fully stopped before releasing its worktree`,
      );
      if (occ.pid !== undefined) {
        const root = probeRememberedRootProcess(occ.pid, worktreePath);
        if (root.state === "live") {
          throw new Error(
            `agent '${agent}' still has a live root process for its worktree; ` +
            `wait for that process to exit, then retry kill_agent('${agent}')`,
          );
        }
        if (root.state === "unknown") throw new AgentOccupancyUnverifiableError(agent, `the remembered root process could not be measured (${root.detail})`);
      }
      this.worktreeOccupancy.delete(key);
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
    if (occ.pid !== undefined) {
      const root = probeRememberedRootProcess(occ.pid, worktreePath);
      if (root.state !== "gone") {
        this.worktreeOccupancy.set(key, { ...occ, state: "dirty" });
        return;
      }
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

      // t-e88c8a — a row can no longer be "bound" to anything: the Delivery marker that made this
      // distinction is gone. Every candidate is an ordinary occupant now.
      const bound = false;
      const invalid = false;
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

  /**
   * t-5e1113 (SDD 482, phase 1) — the ONE place a Tachyon-owned pane is created.
   *
   * `spawnCore` and `commitFork` each built this by hand, and fork's own comment conceded it
   * ("Merged last for the same reason as spawnCore") — copying the reasoning rather than the code,
   * which is how the two drift. What is shared is exactly the part that must never differ:
   *
   *  - the memory scope wraps outermost;
   *  - Pi launches under `withPiAdmission`, every other runtime directly.
   *
   */
  private async createOwnedSession(input: {
    agent: string;
    session: string;
    /** Already wrapped by `withSessionOwnership` — ownership is the caller's to decide. */
    ownedCmd: string;
    cwd: string;
    env: Record<string, string>;
    runtime?: string;
  }): Promise<void> {
    const create = () => this.opts.tmux.newSession({
      name: input.session,
      cmd: this.applyAgentMemoryScope(input.agent, input.ownedCmd),
      cwd: input.cwd,
      // t-fab832 — every session this build starts carries proof of which build started it.
      // t-e73e54 — the claim that used to sit here, that this was "the one door that creates an agent
      // session", was false: `startSessionCommandUnlocked` was a second one. Both now go through
      // `withPostCutAttestation`, which merges the proof LAST so a caller-supplied env cannot forge or
      // clear it.
      env: withPostCutAttestation(input.env),
    });
    if (input.runtime === "pi") await this.withPiAdmission(input.agent, create);
    else await create();
  }

  private async spawnCore(name: string, opts?: SpawnOptions): Promise<void> {
    const clearTransientState = () => {
      this.readyAgents.delete(name);
      this.readinessCache.delete(name);
      this.stoppingSince.delete(name);
      this.clearStopFailed(name);
      this.cleanExited.delete(name);
      this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
      this.postmortemOutput.delete(name);
    };
    let def = this.definitionOf(name);
    if (opts?.cmd) {
      const base = {
        cmd: opts.cmd,
        cwd: opts.cwd,
        autostart: false,
        watch: [],
        attention: { enabled: true, silenceSec: 8, patterns: [] },
        restart: "never" as const,
      };
      // SDD 478 M2 — a Temporary entry is built on ONE arm, so a generic command cannot carry
      // `instructions` or a worktree request: both are Agent capabilities, and until now this door
      // handed them to whatever it spawned.
      //
      // M9 — and the arm is now DECLARED by the caller rather than inferred here from the command
      // string. This manager serves several doors; each knows what it was asked for, and only the
      // door can produce the refusal that names the alternative. An `agent` request is still checked
      // against the attested set here, because that is the invariant, not the door's discretion.
      //
      // An omitted kind means `agent`, which is the STRICT arm: a caller that forgot to say gets a
      // refusal naming the Terminal operation, never a Terminal silently holding agent capabilities.
      //
      // A canonical Delivery execution is a different door: it arrives with an immutable Delivery, an
      // owned subset and an expected HEAD, and SDD 368 T10 measured that an unrecognized reviewer
      // runtime is run with an advisory rather than refused. That policy is not M9's to withdraw.
      const requested = opts.kind ?? "agent";
      if (requested === "agent") {
        const admission = admitAgentRuntimeCommand(opts.cmd);
        if (!admission.ok) throw new AgentRuntimeAdmissionError(admission.reason);
      }
      def = requested === "agent"
        ? {
          ...base,
          kind: "agent",
          instructions: opts.instructions,
          // spec 210 — MCP top-level spawn may opt into worktree isolation (uses the default
          // branch tachyon/<name>; ignored for a sub-agent, which inherits the parent's cwd).
          worktree: opts.worktree,
        }
        : { ...base, kind: "terminal" };
    }
    if (!def) throw new UnknownAgentError(name);

    const taskBrief = opts?.taskBrief;

    // Identity preflight remains before dead-pane replacement. Runtime preflight moves below cwd/private-home
    // preparation so its probe sees the exact prospective environment and owns explicit compensation.
    const suppression = this.applyFormationNativeSuppression(name, def);
    def = suppression.def;
    const session = this.session(name);
    let replaceDeadSession = false;
    if (await this.opts.tmux.hasSession(session)) {
      const state = (await this.agentStates()).get(name);
      if (state && state.dead) {
        // Delay replacing the dead postmortem pane until every guidance/brief operation that can
        // fail has completed. Merely observing the pane here is side-effect free.
        replaceDeadSession = true;
      } else {
        throw new Error(`agent '${name}' is already running`);
      }
    }

    // Resolve every declared project file before touching an incumbent tmux session or preparing a
    // worktree. A bad opt-in must fail this launch atomically, never kill a dead pane and then reveal
    // that the replacement brief could not be composed.
    const projectGuidance = this.projectGuidanceFor(def);
    const temporary = !!opts?.cmd;
    // t-d542ac — runtime lineage belongs to this instance, independent of whether its definition is
    // Saved or Temporary. `declaredOwner` remains separate profile metadata and is never inferred
    // into this edge; only the explicit spawn parent can create it.
    const parent = opts?.parent && opts.parent !== name ? opts.parent : undefined;
    const delegator = opts?.delegator && opts.delegator !== name ? opts.delegator : undefined;
    def = this.withDelegatedToolkit(name, def, parent ?? delegator, new Set([name]));
    // t-f660d8 / t-d542ac — primer/doorbell identity honors the explicit runtime parent first, then
    // config `declaredOwner` only as presentation guidance when this spawn has no lineage.
    const primerParent = (opts?.parent && opts.parent !== name ? opts.parent : undefined)
      ?? (!temporary ? this.opts.getConfig()?.declaredOwner?.[name] : undefined);
    const primerCtx = { delegator };

    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? DEFAULT_MAX_AGENTS;
    if (liveCount >= max) throw new MaxAgentsError(max);

    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    // spec 210 — worktree isolation: Workspace resolves the cwd (its own worktree for a
    // top-level opt-in agent, the parent's cwd for a sub-agent, the root on any git
    // problem). Awaited here (off the UI thread); null = keep the default cwd.
    let worktree: WorktreeRecord | undefined;
    let createdWorktree = false;
    let preparationLocked = false;
    let rollbackHeadSha: string | undefined;
    let preparationHeadBefore: string | undefined;
    let preparationHeadAfter: string | undefined;
    let launchTokenMinted = false;
    const revokeLaunchToken = (): void => {
      const revoke = this.opts.revokeAgentToken;
      if (!revoke) return;
      revoke(name);
      launchTokenMinted = false;
    };
    if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({
        name,
        def,
        parent,
        delegator,
        temporary,
        isRestart: false,
        ...(def.cwd ? { declaredCwd: cwd } : {}),
      });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
        createdWorktree = resolved.created === true;
        preparationLocked = resolved.preparationLocked === true;
        rollbackHeadSha = resolved.rollbackHeadSha;
        preparationHeadBefore = resolved.preparationHeadBefore;
        preparationHeadAfter = resolved.preparationHeadAfter;
      }
    }
    // t-f660d8 — explicit spawn_agent cwd: honor or fail closed (never silently ignore).
    // Parented Temporary children inherit the parent's cwd via resolveWorktreeCwd — refuse opts.cwd
    // so callers never think a custom path was applied. Declared agents without a worktree may
    // run in an explicit managed checkout (e.g. a Delivery worktree path).
    if (opts?.cwd) {
      const requested = resolveCwd(this.opts.workspaceRoot, opts.cwd);
      if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
        throw new Error(`spawn_agent cwd is not an existing directory: ${requested}`);
      }
      if (parent) {
        // t-6fe04b — the Bridge refuses this pair earlier and this is defence in depth, same rule,
        // same sentence, so a caller who reaches either one is pointed at the same way out.
        //
        // t-5f823a — the Bridge guard used to catch only an EXPLICIT `parent`, which left this the
        // one that fired for an agent that passed cwd alone. It now runs on the resolved parent, so
        // an agent caller never gets this far; what still can are launches with no caller identity
        // at all (config-driven, internal). That is why this throws the caller-neutral rendering:
        // the manager has no caller to render for, and inventing one would be a worse lie than the
        // generic message.
        throw new Error(PARENT_CWD_REFUSAL);
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
      if (!worktree || !this.opts.rollbackPreparedWorktree) return false;
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
    /**
     * t-d29398 — a directory Tachyon deleted is a directory Tachyon says it deleted.
     *
     * `rollbackLaunchPreparation` resolving now means the checkout THIS attempt created was discarded
     * rather than left locked behind. That is the point of the change — the next launch meets nothing —
     * but a silent removal would be the wrong half of "leave no residue": the human is told, on every
     * path that can reach it, and preservation still speaks for itself through its own error.
     */
    const announceDiscardedPreparation = (): void => {
      if (!worktree) return;
      this.opts.notify?.(
        `agent '${name}' did not launch — the worktree this attempt had just created was discarded (${worktree.path});` +
          " nothing was preserved, so a retry starts clean",
        "warn",
      );
    };
    const effectivePrimerCtx = { ...primerCtx, freshWorktree: !!worktree };
    let preparedRuntimeHarness: MaterializedHarness | null | undefined;
    let createdRuntimeHome = false;
    const preparedLaunch = await (async () => {
    // t-7f3009 — the spawn brief is NOT self-checking. `taskBrief` here can be a document frozen at an
    // earlier launch (the incident: the same t-2f6cdd contract replayed five times after it landed,
    // naming a worktree that no longer existed). t-9d250c built the board cross-check but wired it only
    // into restart, so the other door stayed open. Same record, same selector, same stale-reference
    // reporting — the difference is only which launch it describes.
    const spawnWorkRecord = this.sessionWorkRecordFor(
      name,
      def,
      worktree,
      cwd,
      [
        taskBrief,
        opts?.contract
          ? Object.values(opts.contract).filter((value) => typeof value === "string").join("\n")
          : undefined,
      ].filter(Boolean).join("\n"),
      "spawn",
    );
    // `parent` is runtime lineage; `primerParent` contributes only the declaredOwner fallback when
    // this instance has no explicit parent.
    const effectiveInstructions = this.effectiveInstructions(
      name,
      def,
      parent ?? primerParent,
      effectivePrimerCtx,
      taskBrief,
      opts?.contract,
      projectGuidance,
      spawnWorkRecord,
    );
    // Session-resume bookkeeping (spec 209): mint a session id for runtimes that
    // accept one (claude/gemini). The ORIGINAL cmd is kept for the ledger def +
    // temporary map; the injected one is only what we spawn.
    const originalCmd = def.cmd;
    // A self-resuming cmd (the user already passed --resume/--continue/--session-id) is run verbatim:
    // we neither mint our own id (claude exits 1 on --session-id + --resume without --fork-session)
    // nor record a resume block (its own cmd resumes on restart). claude name-mints `-n <name>`,
    // gemini uuid-mints `--session-id` (spec 220 — see injectResumeId).
    const injected = this.injectResumeId(name, def);
    def = injected.def;
    const { adapter, resumeId, selfManaged } = injected;
    const temporaryAgent = asAgent(def);
    if (temporary && adapter?.harness && !selfManaged && temporaryAgent && !temporaryAgent.harness && temporaryAgent.isolate === undefined) {
      // t-303f2b — grok non-harness already gets a private GROK_HOME via materializeBridgeMcpGrok
      // (same path as declared agents). Auto isolate:transcript would materialize a *second* private
      // home under .tachyon/harness/ and race GROK_HOME with withRuntimeBridge; cold dual-homes have
      // surfaced as interactive "Approve in your browser" instead of reusing ~/.grok auth.
      const usesBridgePrivateHome =
        (adapter.runtime === "grok" && !!this.opts.materializeBridgeMcpGrok) ||
        (adapter.runtime === "hermes" && !!this.opts.materializeBridgeMcpHermes);
      if (!usesBridgePrivateHome) {
        def = { ...temporaryAgent, isolate: "transcript" };
      }
    }
    const isolatedWorktree = !!worktree;
    // t-ef19a1 — anti-footgun only, never a trust/allow change: a tachyon.yml-declared opencode
    // agent with no harness/worktree isolation is intentionally allowed (its author already has
    // full extension trust), but it shares the global ~/.local/share opencode state, so warn once
    // at spawn time. A Temporary opencode instance is unaffected — it auto-gets isolate:"transcript" above.
    if (!temporary) {
      const footgun = opencodeIsolationFootgunWarning(def.cmd, { name, harness: !!asAgent(def)?.harness, isolatedWorktree });
      if (footgun) this.opts.notify?.(footgun, "warn");
    }
    if (temporaryAgent) {
      const projectScoped = projectScopedTranscriptWarning(temporaryAgent.cmd, {
        name,
        parented: !!parent,
        harness: !!temporaryAgent.harness,
        isolatedWorktree,
      });
      if (projectScoped) this.opts.notify?.(projectScoped, "warn");
    }
    if (parent && temporaryAgent && !temporaryAgent.harness) {
      assertVerifiedTranscriptIsolation(temporaryAgent.cmd, { name, isolatedWorktree, parented: true });
    }
    // Security review (782f1c6, HIGH): gate on `isolatedWorktree` too, not just lineage — an ungated,
    // shared-cwd delegation (t-e2ebe3) is `parent`-truthy but not worktree-contained, and `bash:"allow"`
    // is unconfined shell access with no `external_directory` bound on it. Only a worktree-contained
    // delegation gets the block; an uncontained one falls back to opencode's own default instead.
    const delegatedOpencode = (parent || delegator) && isolatedWorktree
      ? { workspaceRoot: this.opts.workspaceRoot, worktreesBase: this.worktreesBaseFor(cwd, worktree) }
      : undefined;

    // spec 230 — per-spawn env (a pipeline node's TACHYON_* nonce) is merged LAST so it reaches a
    // DECLARED agent too (not just the Temporary cmd path) and wins on any collision (codex B1).
    // Evaluate the extra environment before minting.  A bridge/env failure must not
    // revoke a durable declared token that this attempt never minted.
    const extraEnv = this.opts.getExtraEnv?.();
    const runtimeHome = harnessHome(this.opts.workspaceRoot, name);
    const runtimeHomeExisted = fs.existsSync(runtimeHome);
    try {
      preparedRuntimeHarness = this.materializeRuntimeHarness(name, def, cwd, !!(parent || delegator));
    } finally {
      createdRuntimeHome = !runtimeHomeExisted && fs.existsSync(runtimeHome);
    }
    {
      await this.assertLaunchPreflight(
        name,
        def.cmd,
        { ...extraEnv, ...def.env, ...(opts?.env ?? {}), ...(preparedRuntimeHarness?.env ?? {}) },
        temporary && !!asAgent(def),
        cwd,
      );
    }
    const effectiveCmd = this.effectiveCmd(name, def, effectiveInstructions, !!(parent || delegator));
    const tokenEnv = this.opts.mintAgentToken?.(name);
    launchTokenMinted = tokenEnv !== undefined && Object.keys(tokenEnv).length > 0;
    // Host-minted Bridge identity wins over def.env / opts.env (a stale TACHYON_AGENT_BRIDGE_TOKEN
    // in YAML used to overwrite the digest just registered → MCP 401 token_unknown).
    const spawnBuild = this.applyHarness(
      name,
      def,
      cwd,
      effectiveCmd,
      { ...extraEnv, ...def.env, ...(opts?.env ?? {}), ...tokenEnv, TACHYON_AGENT_NAME: name, ...this.hermesBriefEnv(def, effectiveInstructions) },
      preparedRuntimeHarness,
    );
    this.applyDelegatedOpencodeHarnessPermission(def, spawnBuild.env, delegatedOpencode);
    // spec 236 — fold the runtime-Bridge env delta (the OPENCODE_CONFIG path for opencode agents)
    // into spawnBuild.env so it reaches the spawn env alongside the Bridge URL/token.
    const spawnBridge = this.withRuntimeBridge(
      name,
      def,
      spawnBuild.cmd,
      cwd,
      delegatedOpencode,
      adapter?.runtime === "pi" && !selfManaged,
      spawnBuild.env.GROK_HOME,
    );
    // t-d42565 — recognized AI runtimes must receive Bridge MCP tools (notify_agent / doorbell) when
    // the workspace Bridge is up. Non-AI commands may still use kind:agent for lifecycle grouping.
    const spawnedAgent = asAgent(def);
    if (spawnedAgent && (adapter || binaryOf(spawnedAgent.cmd) === "pi") && !spawnBridge.wired) {
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
      lifecycleHooks: !temporary,
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
      if (worktree && this.opts.rollbackPreparedWorktree) {
        try {
          // t-d29398 — a `true` here now means the checkout THIS attempt created was discarded, so the
          // retry after the human fixes the cause starts clean instead of meeting a locked leftover.
          if (await rollbackLaunchPreparation()) announceDiscardedPreparation();
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
    clearTransientState();
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
    try {
      // spec 236 Bridge + 243 ownership hook and t-0d0152 memory scope live in createOwnedSession.
      await this.createOwnedSession({
        agent: name, session, ownedCmd: ownedSpawnCmd, cwd,
        env: { ...spawnBuild.env, ...spawnBridge.env },
        runtime: adapter?.runtime,
      });
    } catch (error) {
      // A same-named pane observed after newSession fails is ambiguous: it may belong to a
      // concurrent creator, so never kill it without an ownership receipt.
      const compensation = newLaunchCompensation();
      let sessionGone = false;
      try {
        sessionGone = !(await this.opts.tmux.hasSession(session));
      } catch (cleanupError) {
        compensation.failures.push(new Error("failed to probe partially-created agent session", { cause: cleanupError }));
      }
      if (sessionGone) {
        if (launchTokenMinted) {
          try { revokeLaunchToken(); }
          catch (cleanupError) { compensation.failures.push(new Error("failed to revoke token after session creation failure", { cause: cleanupError })); }
        }
        if (createdWorktree && !preparationHeadAfter) {
          // Withholding rollback here is the safe choice, not a fault: without an exact prepared HEAD
          // there is nothing to roll back TO, and guessing could discard real work.
          compensation.receipts.push(new Error("worktree recovery state was preserved deliberately: session creation failed without an exact prepared HEAD to roll back to; inspect it before retry"));
        } else {
          // t-d29398 — same compensation, same distinction: a checkout this attempt created and never
          // handed to a runtime is discarded, and one git refuses to discard still fails loudly below.
          try { if (await rollbackLaunchPreparation()) announceDiscardedPreparation(); }
          catch (cleanupError) { compensation.failures.push(new Error("agent worktree recovery state was preserved instead of automatic cleanup", { cause: cleanupError })); }
        }
      } else {
        compensation.failures.push(new Error("agent session creation is uncertain; worktree recovery state was preserved"));
      }
      throw launchCompensationError(error, compensation, `agent '${name}' session creation`);
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
        failures.push(new Error(`agent worktree recovery state was preserved at ${worktree.path}; ${RELEASE_LOCK_HINT}`));
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
    // `def` for every Temporary agent (drives restart, incl. non-AI `sh`);
    // a `resume` block only for adapter-backed runtimes.
    // Record when Temporary (restart), adapter-backed (resume), running in a worktree, OR it has a
    // parent. The last clause is deliberately lifetime-agnostic: even a Saved non-adapter instance
    // needs its lineage after reload so the cleanup descendant guard sees it.
    const defBlock = {
      cmd: originalCmd,
      kind: def.kind,
      ...(asAgent(def)?.instructions ? { instructions: asAgent(def)!.instructions } : {}),
      ...(taskBrief ? { taskBrief } : {}),
      ...(parent ? { parent } : {}),
      ...(delegator ? { delegator } : {}), // t-bae303 — persist so rehydrate can restore gated lineage after a reload
      ...(opts?.env ? { env: opts.env } : {}), // spec 230 — persist the node env so a restart re-applies the nonce
      ...(opts?.pipeline ? { pipeline: opts.pipeline } : {}), // spec 230 — pipeline-owned node (planResume skips it)
      ...(opts?.contract ? { contract: opts.contract } : {}), // spec 246 — structured delegation contract (D8)
      ...(opts?.contractSkipReason ? { contractSkipReason: opts.contractSkipReason } : {}), // spec 246 D6 — auditable bypass
    };
    const resumeBlock = adapter && !selfManaged ? this.withConfigHome(name, def, { runtime: adapter.runtime, sessionId: resumeId }) : undefined; // spec 240
    const shouldPersistLaunch = !!this.opts.ledger && !!(temporary || adapter || worktree || parent);
    // A gated launch is restart-denied from its very first durable row. The marker is removed only
    // after the host has authenticated and persisted the delegation authority. This two-phase row
    // stays fail-closed even if canonical persistence and every subsequent cleanup write all fail.
    const launchRecoveryRecord = {
      def: defBlock,
      resume: resumeBlock,
      worktree,
      cwd,
      // SDD 482 phase 2 — DECLARED here, from what this call was asked to do: `temporary` is set by the
      // caller supplying a command (or an explicitly ephemeral Delivery execution), never derived
      // from the name, the tmux session or `tachyon.yml`. A declared start is a Saved instance that
      // may be restarted; a Temporary start is a Temporary one collected when its work ends.
      // `lifecycleHooks` mirrors what `withSessionOwnership` was actually told above
      // (`lifecycleHooks: !temporary` → `ownershipOnly`), recorded as a capability of THIS instance rather
      // than left to be re-derived from identity by every reader.
      instance: temporary
        ? { lifetime: "temporary" as const, resumePolicy: "collected" as const, lifecycleHooks: false }
        : { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
    };
    try {
      if (shouldPersistLaunch) {
        this.opts.ledger!.record(name, launchRecoveryRecord);
      }
      // spec 364 — durable Bridge-client stamp after successful spawn with materialization.
      // Always stamp: preservesSavedLedger only protects principal def/resume/worktree/cwd
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
        failures.push(new Error(`agent worktree recovery state was preserved at ${worktree.path}; ${RELEASE_LOCK_HINT}`));
      }
      throw new AggregateError(
        failures,
        `agent '${name}' launch persistence failed` +
          (worktree ? `; locked recovery checkout: ${worktree.path}` : "") +
          (!sessionGone ? `; live recovery session: ${session}` : ""),
        { cause: primary },
      );
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
    // t-eb4b30 — no second write. The launch row above already persisted this definition
    // (`defBlock`, with `cmd: originalCmd`), and `definitionOf` reads it from there.
    this.startedHere.add(name);
    // A successful spawn settles the lineage for THIS instance. Replace the stopped instance's
    // retained display lineage even when the new instance is deliberately top-level; otherwise a
    // reused Saved name would inherit its predecessor's parent in memory.
    if (parent) this.lineage.set(name, parent);
    else this.lineage.delete(name);
    if (delegator) this.delegators.set(name, delegator);
    this.opts.onSpawned?.(name, opts?.reveal === false ? "silent" : "reveal", { worktree, temporary });
    await this.attachPaneTranscript(session);
    return;
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
   *   - MCP harness agent → no-op: the Bridge is folded into its materialized private config. Pi's
   *     resource-only harness remains additive because Pi has no native MCP config surface.
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
   *     `config.yaml` carrying `mcp_servers.tachyon_bridge` + isolated `auth.json` copy, inject `HERMES_HOME`.
   *   - pi → additively load the immutable staged `pi-bridge-extension.mjs`; URL and bearer remain env-only.
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
    def: Pick<AgentEntry, "cmd" | "harness">,
    cmd: string,
    cwd?: string,
    delegated?: { workspaceRoot: string; worktreesBase: string },
    managedPiSession = false,
    /**
     * t-ee5c05 — the private `GROK_HOME` `applyHarness` already materialized for THIS spawn, when it
     * did. Grok is the one runtime whose Bridge wiring rewrites the same file the canonical
     * materializer owns, so without this the second write would rebuild `config.toml` from the port's
     * own options and erase the projection the first one just made. For a declared agent the two
     * option sets are deliberately identical, so it was only redundant; for a FORK the port cannot see
     * the profile at all (a fork is not in `config.agents`), so it would drop the projection and the
     * exact-trust store. Reusing what was already built removes the second write entirely.
     */
    preparedGrokHome?: string,
  ): { cmd: string; env: Record<string, string>; wired: boolean } {
    const binary = binaryOf(def.cmd);
    let sessionEnv: Record<string, string> = {};
    if (managedPiSession) {
      const sessionDir = this.opts.materializePiSessionDir?.(name);
      if (!sessionDir) throw new Error(`agent '${name}': Pi session materializer is unavailable`);
      sessionEnv = {
        [PI_SESSION_DIR_ENV]: sessionDir,
        TACHYON_PI_SESSION_OWNER_FILE: sessionOwnersFile(this.opts.workspaceRoot),
      };
    }
    const url = this.opts.getExtraEnv?.()?.[URL_ENV_VAR];
    if (def.harness && binary !== "pi") {
      // Bridge is folded into the materialized harness MCP file (Workspace passes bridgeEntry when up).
      // SDD 406: Pi's harness contains resources only; its immutable Bridge extension stays additive.
      return { cmd, env: {}, wired: !!url };
    }
    if (!url) return { cmd, env: sessionEnv, wired: false };
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
      const home = preparedGrokHome ?? this.opts.materializeBridgeMcpGrok?.(name, cwd ?? this.opts.workspaceRoot);
      if (!home) return { cmd, env: {}, wired: false };
      // t-c46c35 — the non-harness canonical Grok path, and the one that actually needed the pin: it
      // deliberately skips `isolate: transcript` (t-303f2b), so it never reaches HarnessManager's
      // materializers. t-0e88f3 corrected WHICH pin carries the guarantee: `--no-memory` was measured
      // NOT to outrank GROK_MEMORY=1, so the env pin is the control and the flag is kept only as a
      // documented no-op. Still only on the wired path — an unwired command is returned untouched here,
      // exactly as every other runtime above does, and inherits the runtime's own default.
      return {
        cmd: [cmd, ...grokMemoryArgs(GROK_CANONICAL_MEMORY_POLICY)].join(" "),
        env: { GROK_HOME: home, ...grokMemoryEnv(GROK_CANONICAL_MEMORY_POLICY) },
        wired: true,
      };
    }
    if (binary === "hermes") {
      const home = this.opts.materializeBridgeMcpHermes?.(name);
      if (!home) return { cmd, env: {}, wired: false };
      return { cmd, env: { HERMES_HOME: home }, wired: true };
    }
    if (binary === "pi") {
      const toolPosture = piToolFilterPosture(def.cmd);
      if (toolPosture === "other") {
        this.opts.notify?.(
          `agent '${name}': its Pi command restricts tools beyond the proven reviewer denylist, so Tachyon cannot guarantee the complete Bridge catalog`,
          "warn",
        );
        return { cmd, env: sessionEnv, wired: false };
      }
      const extension = this.opts.piBridgeExtensionPath?.();
      if (!extension) {
        this.opts.notify?.(`agent '${name}': staged Pi Bridge extension is unavailable`, "warn");
        return { cmd, env: sessionEnv, wired: false };
      }
      return { cmd: piBridgeCmd(cmd, extension), env: sessionEnv, wired: true };
    }
    return { cmd, env: sessionEnv, wired: false };
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
   * Generation site (b) — the harness `XDG_CONFIG_HOME/opencode/opencode.json` path. t-d542ac made
   * explicit runtime lineage uniform across lifetimes, so a parented Saved opencode definition with
   * `harness:` can now reach this path. Keep the same delegated permission hardening as generation
   * site (a); storage origin must not change the security posture of the instance.
   */
  private applyDelegatedOpencodeHarnessPermission(
    def: Pick<AgentEntry, "cmd" | "harness"> | undefined,
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
   * Temporary instances are persistence-off by convention, but still receive the ownership-only SessionStart hook
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
    // t-aaad95 — `tachyon.yml` is the single authority; the VS Code `tachyon.agentMemoryMax` key and
    // the host port that carried it are gone.
    const memoryMax = parseAgentMemoryMax(this.opts.getConfig()?.settings.agentMemoryMax);
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
    def: Pick<AgentEntry, "cmd">,
    cmd: string,
    // t-04052d — this option was called `declared`, and it never asked about storage: `!declared`
    // became `ownershipOnly`, i.e. "inject profile-backed lifecycle hooks, or ownership only?". It is
    // renamed to the question it actually asks, which is also the capability the ledger records.
    opts: { lifecycleHooks: boolean; cwd: string; configHome?: string; preservePermissionMode?: boolean },
  ): string {
    const binary = binaryOf(def.cmd);
    const adapter = adapterFor(def.cmd);
    if (adapter?.mintsId && managesOwnSession(def.cmd)) {
      this.opts.onSessionHooksInjected?.(name, false);
      return cmd;
    }
    const ownershipOnly = !opts.lifecycleHooks;
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

  /**
   * t-28bf8f — does this row still CLAIM a checkout? The one question that decides whether a stop may
   * also collect the row.
   *
   * A Temporary's row is its listing (t-eb4b30), and every governed end-of-life door — UI delete,
   * `dismiss_agent`, Agent Studio Forget, `kill_agent` — addresses an agent BY NAME. The registry entry
   * in `managed-worktrees.json` is addressed by worktree id and may only be dropped by its owner or a
   * human (`canMutateManagedWorktree`), and lineage deliberately does NOT extend over an agent's own
   * working home (`resolveHygieneAuthority`: "a parent tidying up after a finished task must never be
   * able to delete the place its child actually lives"). So a row collected while it still owns a
   * checkout leaves the checkout, its branch and its registry entry behind with NO door on them at all:
   * the four name-addressed doors answer "not found", and the fifth refuses for want of an owner the
   * same call just deleted. Measured twice on 0.56.149 and cleaned up by hand both times.
   *
   * Hence the invariant, stated here rather than at each door: THE REGISTRY ENTRY NEVER OUTLIVES THE
   * ROW THAT OWNS IT. A stop leaves a still-owning Temporary listed and stopped, which is the state the
   * removal doors know how to finish; only they collect the row, and only after the cascade has proved
   * the checkout released (`removeAgentWorktree` → `ledger.clearWorktree`, after which this reads false).
   *
   * It is deliberately here, in `kill`, and not in one caller: the same effect is reachable through
   * every actor that stops an agent — the Bridge's `kill_agent`, the sidebar's forced Kill
   * (`agent.kill` → `manager.kill`, which never even refuses), and the removal cascade's own occupancy
   * gate. A guard in the Bridge door would have left the sidebar orphaning silently.
   */
  private ownsWorktree(name: string): boolean {
    return !!this.opts.ledger?.get(name)?.worktree;
  }

  async kill(name: string): Promise<void> {
    this.stoppingSince.delete(name);
    this.clearStopFailed(name);
    this.readinessCache.delete(name); // spec 221: kill refreshes ownership (sessionId may change) → drop cache
    this.cleanExited.delete(name);
    this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
    this.postmortemOutput.delete(name);
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    await this.refreshOwnership(name); // A3: capture an in-TUI /resume before the session ends
    await this.detachPaneTranscript(session);
    await this.opts.tmux.killSession(session);
    // Readiness belongs to the process instance, not to the durable Saved Agent.
    // Keeping either marker after the tmux session is gone makes a stopped agent
    // fail the canonical Forget precondition forever.
    this.readyAgents.delete(name);
    this.provisionalAgents.delete(name);
    const wasTemporary = this.isTemporary(name);
    // spec 225 — a forked sibling is PERSISTENT: keep its in-memory def AND ledger row across a Stop
    // (so it stays listed + resumable), dropping them only on an explicit Dismiss. The marker is
    // durable (ledger def.fork), so this holds after a window reload too.
    const persistent = this.opts.ledger?.get(name)?.def?.fork === true;
    if (!persistent) {
      // Spec 211: a Temporary agent's ledger row must go, or it resurrects as a permanent stopped
      // entry on the next activation. Since t-eb4b30 the row IS the listing — there is no in-memory
      // map whose deletion could hide a surviving row — so this removal is the whole operation rather
      // than the durable half of two. Declared agents keep their row (still resumable later).
      //
      // t-28bf8f — UNLESS the row still owns a checkout. See `ownsWorktree`.
      if (wasTemporary && !this.ownsWorktree(name)) {
        // pin p-4dadd3 (dogfood follow-up): kill removes the row AND leaves no pane (killSession, not a
        // remain-on-exit clean-exit dead pane), so the durable log is unreachable — it dies with the row.
        // spec 247: the row+log pair is one named operation now, so this can no longer drift apart.
        this.removeEphemeralFootprint(name);
        // This Temporary no longer has a roster row, so its lineage is an end-of-life footprint too.
        this.lineage.delete(name);
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
    // t-9d76b1 — recorded BEFORE the first key, for the same reason every seam mints before it acts:
    // the process can be gone before `sendKey` even returns, and an intent recorded afterwards would
    // miss exactly the fastest exits. Unlike `stoppingSince` this is not cleared when the pane dies.
    this.stopRequestedAt.set(name, Date.now());
    this.clearStopFailed(name);
    this.opts.onStopping?.(name);
    try {
      await this.refreshOwnership(name); // capture an in-TUI /resume before asking the process to exit
      const cmd = this.definitionOf(name)?.cmd ?? "";
      const gracefulStop = gracefulStopForCommand(cmd);
      for (const step of gracefulStop.steps) {
        if (step.type === "interruptActiveTurn") {
          await this.interruptActiveTurn(session);
        } else if (step.type === "sendKey") {
          await this.opts.tmux.sendKey(session, step.key);
        } else {
          await sleep(step.delayMs);
          const state = (await this.opts.tmux.sessionStates(session))?.get(session);
          if (state && !state.dead) {
            if (step.type === "sendKeyIfAliveAfterDelay") await this.opts.tmux.sendKey(session, step.key);
            else await this.sendStopText(session, step.text, cmd);
          }
        }
      }
    } catch (err) {
      this.stoppingSince.delete(name);
      this.clearStopFailed(name);
      // t-9d76b1 — `stopRequestedAt` deliberately SURVIVES this: some keys may already have landed, and
      // a process that dies from them a moment later was still stopped on request. The residue is a
      // stop that never reached the pane at all, after which a genuine crash of that same instance
      // would read as stopped — which is why the row keeps PAINTING the non-zero exit code beside
      // "stopped" instead of hiding it (see `deadSubline`).
      throw err;
    }
  }

  /** Confirm a graceful Stop without increasing its authority. */
  async confirmGracefulStop(
    name: string,
    timeoutMs = AgentManager.STOP_CONFIRM_TIMEOUT_MS,
  ): Promise<"stopped" | "alive" | "unknown"> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      try {
        const state = (await this.agentStates()).get(name);
        if (state === undefined || state.dead) return "stopped";
      } catch {
        return "unknown";
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "alive";
      await sleep(Math.min(50, remaining));
    }
  }

  /** t-ab2682 — the text step's own budget. All of it has to fit inside STOPPING_FALLBACK_MS, which
   *  is what turns a stop that never landed into the visible `stop-failed` row. Worst case here is
   *  ~9.7s against that 15s; the measured ordinary case is one capture and ~800ms to a dead pane. */
  private static readonly STOP_TEXT_FREE_TIMEOUT_MS = 5_000;
  private static readonly STOP_TEXT_POLL_MS = 100;
  private static readonly STOP_TEXT_CLEAR_ATTEMPTS = 2;
  private static readonly STOP_TEXT_RENDER_MS = 150;
  private static readonly STOP_TEXT_SUBMIT_ATTEMPTS = 3;
  private static readonly STOP_TEXT_EXIT_GRACE_MS = 1_500;

  /**
   * t-ab2682 — deliver a graceful-stop TEXT step (claude's `/exit`) without typing blind.
   *
   * The old delivery was `tmux.sendKeys(session, text, true)`: `send-keys -l "/exit"` with `C-m`
   * immediately behind it. Measured on claude 2.1.224 through the door production uses, that stop
   * left the process alive in 3 of 4 runs.
   *
   * The cause is NOT the missing gap between the text and its Enter, which is what the task
   * predicted. With a free composer the back-to-back pair exits 0 — 13 of 13 runs at a 6-13ms gap,
   * including 3 of 3 against an agent stopped mid-turn — and re-measuring with the proposed fixed
   * 600ms gap failed at exactly the old rate, 3 of 4. The cause is WHAT the composer held when the
   * text was typed: `/exit` typed onto a staged line becomes part of THAT line, and the Enter behind
   * it submits the pair to the model as a prompt. The spawn brief is the line that loses this race —
   * the pane read `── END BEFORE FINISHING ──/exit` and claude answered it in prose. That is also
   * why the composer looks EMPTY afterwards, which is what made this look like a swallowed Enter:
   * the Enter was never eaten, it submitted the wrong thing.
   *
   * So the guard is composer occupancy, not a delay. Type only into a composer that is provably
   * free, and press Enter only while the composer provably holds exactly this text. A capture costs
   * p50 4ms / p95 23ms, which is cheaper than the fixed delay that does not work anyway.
   */
  private async sendStopText(session: string, text: string, cmd: string): Promise<void> {
    const composer = composerProfileFor(cmd);
    // No measured composer for this runtime means there is no evidence to read. The honest fallback
    // is the old blind delivery rather than an invented verdict — the same rule `sendSubmittedLine`
    // follows when a runtime declares no composer.
    if (!composer) {
      await this.opts.tmux.sendKeys(session, text, true);
      return;
    }

    const deadline = Date.now() + AgentManager.STOP_TEXT_FREE_TIMEOUT_MS;
    let freed = false;
    let clears = 0;
    while (Date.now() < deadline) {
      if (await this.sessionIsDead(session)) return;
      const pane = await this.captureForStop(session);
      if (pane !== null && findComposerRegion(pane.split("\n"), composer) && !isComposerOccupied(pane, composer)) {
        freed = true;
        break;
      }
      // Occupied, or no composer region in this frame. Ctrl+C is this profile's OWN clear-the-draft
      // step (claude 2.1.224: it clears an unsubmitted draft), so asking again is the sequence's own
      // remedy rather than a new authority over the pane — a stop already consents to losing a draft.
      if (clears < AgentManager.STOP_TEXT_CLEAR_ATTEMPTS) {
        await this.sendKeyForStop(session, "C-c");
        clears++;
      }
      await sleep(AgentManager.STOP_TEXT_POLL_MS);
    }
    // The composer was never proved free. Typing anyway is the defect this method exists to prevent:
    // it would append to whatever is staged and submit the pair. Returning leaves the stop to time
    // out into the visible `stop-failed` row, which is a true statement about what happened.
    if (!freed) return;

    await this.opts.tmux.sendKeys(session, text, false); // typed exactly once; never re-typed below
    await sleep(AgentManager.STOP_TEXT_RENDER_MS);

    for (let attempt = 0; attempt < AgentManager.STOP_TEXT_SUBMIT_ATTEMPTS; attempt++) {
      if (await this.sessionIsDead(session)) return;
      const pane = await this.captureForStop(session);
      // Enter goes out only while the composer provably holds exactly our text. Unreadable, already
      // cleared, or our text with something else beside it all mean a press would be blind, and a
      // blind Enter answers whatever happens to be focused. The measured slash-command menu does not
      // trip this: its rows carry no prompt glyph, so the region still reads exactly `/exit`.
      if (pane === null || composerText(pane, composer) !== text.trim()) return;
      await this.sendKeyForStop(session, "C-m");
      if (await this.waitForSessionDeath(session, AgentManager.STOP_TEXT_EXIT_GRACE_MS)) return;
    }
  }

  private async sessionIsDead(session: string): Promise<boolean> {
    return (await this.opts.tmux.sessionStates(session))?.get(session)?.dead === true;
  }

  /** Colour-preserving capture for the stop path: an unreadable pane is `null`, never a guess. The
   *  colours are what separate claude's dim suggestion from a real staged draft (t-c5f29b). */
  private async captureForStop(session: string): Promise<string | null> {
    try {
      return await this.opts.tmux.capturePane(session, { joinWrapped: true, preserveColors: true });
    } catch {
      return null;
    }
  }

  /** A key aimed at a process that is already exiting is expected to fail; that is the outcome this
   *  step wants, so the failure must not surface as the stop's own error. */
  private async sendKeyForStop(session: string, key: string): Promise<void> {
    try {
      await this.opts.tmux.sendKey(session, key);
    } catch {
      /* the pane may already be gone */
    }
  }

  private async waitForSessionDeath(session: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (await this.sessionIsDead(session)) return true;
      await sleep(AgentManager.STOP_TEXT_POLL_MS);
    }
    return this.sessionIsDead(session);
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
    this.clearStopFailed(name);
    if (!state?.dead || state.exitCode !== 0) return false;
    await this.capturePostmortemOutput(name, session);
    const rec = this.opts.ledger?.get(name);
    // t-eb4b30 — this was `... && this.adhoc.has(name)`. The config check replaces that conjunct rather
    // than dropping it: `isTemporaryInstance` alone is TRUE for a policy-less row (it fails closed), so
    // without it a declared agent whose row predates the cut would start getting marked here. The
    // activation gate makes that row unreachable, and this keeps the condition honest anyway.
    if (rec && isTemporaryInstance(rec) && !this.opts.getConfig()?.agents[name]) {
      this.opts.ledger!.record(name, {
        ...rec,
        lifecycle: {
          state: "clean-exited",
          exitedAt: rec.lifecycle?.state === "clean-exited" ? rec.lifecycle.exitedAt : new Date().toISOString(),
        },
      });
    }
    await this.detachPaneTranscript(session);
    await this.opts.tmux.killSession(session);
    // The lifecycle monitor is a second session-removal door beside kill(). Readiness belongs to the
    // process instance it just collected; retaining either marker here makes a cleanly exited Saved
    // Agent look resumable while a process-local launch belief blocks its eventual Forget.
    this.readyAgents.delete(name);
    this.provisionalAgents.delete(name);
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
   * Temporary definition, lineage (its own parent AND children pointing at it),
   * and the resume-ledger record. The yml definition is the caller's job
   * (declared agents only — Temporary ones have nothing in the config).
   */
  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    // spec 226 (v1) — a harness agent's config home is keyed by name (`.tachyon/harness/<name>`) and
    // holds its claude transcripts; a rename would orphan them (resume would scan the new name's empty
    // home, and GC could delete the old one). Block it, fail-closed, until the home is persisted +
    // moved on rename (follow pass) — same posture as the fork block.
    if (this.agentDefinitionOf(oldName)?.harness) throw new Error(`cannot rename '${oldName}': renaming an isolated-harness agent isn't supported yet (v1)`);
    if (this.opts.ledger?.get(oldName)?.resume?.runtime === "pi") {
      throw new Error(`cannot rename '${oldName}': renaming a managed Pi session isn't supported yet (phase 2)`);
    }
    if (this.definitionOf(newName)) throw new Error(`agent '${newName}' already exists`);
    const states = await this.agentStates();
    if (states.has(newName)) throw new Error(`a session named '${newName}' already exists`);
    if (states.has(oldName)) {
      await this.opts.tmux.renameSession(this.session(oldName), this.session(newName));
    }

    // t-eb4b30 — a Temporary's definition used to be moved between keys of the in-memory map here.
    // It lives in the ledger row, and the row's key is moved by the `renameExact` below, so the rename
    // no longer has a definition step of its own. That collapse is the point of the step.
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

  /** Capture the exact durable/live bindings before canonical profile authority commits. */
  async prepareAgentProfileRename(oldName: string, newName: string): Promise<CanonicalLiveRenameSnapshot> {
    if (oldName === newName) throw new Error("canonical live rename source and destination must differ");
    if (this.agentDefinitionOf(oldName)?.harness) {
      throw new Error(`cannot rename '${oldName}': renaming an isolated-harness agent isn't supported yet (v1)`);
    }
    if (this.opts.ledger?.get(oldName)?.resume?.runtime === "pi") {
      throw new Error(`cannot rename '${oldName}': renaming a managed Pi session isn't supported yet (phase 2)`);
    }
    if (this.definitionOf(newName)) throw new Error(`agent '${newName}' already exists`);
    const oldSession = await this.opts.tmux.hasSession(this.session(oldName));
    const newSession = await this.opts.tmux.hasSession(this.session(newName));
    if (newSession) throw new Error(`a session named '${newName}' already exists`);
    const ledgerRecord = this.opts.ledger?.get(oldName) ?? null;
    if (this.opts.ledger?.get(newName)) throw new Error(`session ledger already contains '${newName}'`);
    const targetActivity = captureActivityRenameSnapshot(this.activityDir(), newName);
    if (targetActivity.jsonlSha256 !== null || targetActivity.stateSha256 !== null) {
      throw new Error(`activity storage already contains '${newName}'`);
    }
    return {
      sessionPresent: oldSession,
      ledgerRecord: ledgerRecord ? structuredClone(ledgerRecord) : null,
      activity: captureActivityRenameSnapshot(this.activityDir(), oldName),
    };
  }

  /**
   * Capture a stopped profile's exact name-scoped projections without touching runtime homes.
   *
   * t-05dff5 — both preconditions are `AgentProfileRefusal`, not `Error`. Each names a gesture the
   * human can perform (stop the agent; remove the worktree), and that CODE is what carries them
   * intact through the Studio boundary instead of being flattened to "could not be completed".
   */
  async prepareAgentProfileForget(name: string): Promise<AgentProfileForgetSnapshot> {
    // t-4736b4 measures fresh (never `lastAgentStates`); t-05dff5 makes the answer reach the human.
    // The two fixes meet here: an occupancy this path REFUSES on is a governed refusal, so it says so.
    await this.assertRemovalOccupancyFree(
      name,
      "agent-profile/forget-agent-running",
      `agent '${name}' must be fully stopped before canonical forget`,
    );
    if (this.opts.ledger?.get(name)?.worktree) {
      throw new AgentProfileRefusal(
        "agent-profile/forget-worktree-owned",
        `agent '${name}' still owns a worktree; remove it explicitly before canonical forget`,
      );
    }
    return {
      ledgerSha256: this.opts.ledger?.recordDigest(name) ?? null,
      activity: captureActivityRenameSnapshot(this.activityDir(), name),
    };
  }

  /**
   * Remove captured projections and generated per-agent files; private runtime homes and external
   * bindings are retained (see the transaction's `retainedBindings`).
   *
   * t-33ae3f — the generated spawn brief and the durable pane transcript are removed
   * here. `FORGET_AGENT_FOOTPRINTS` has always named them as end-of-life footprints, but only the
   * Temporary dismiss path ran `forgetAgent()`; the Saved Agent forget left them behind while the
   * journal's `retainedBindings` never claimed them, so they were neither cleaned nor declared —
   * the one state an audit of a removal cannot classify. Six of seven committed forgets on this
   * workspace had leaked them, 60 MB of transcripts. Nothing of audit value is lost: the profile is
   * quarantined under `retired-agent-profiles/<agentId>/<txid>/`, and a forgotten agent has no
   * postmortem reader left to serve.
   *
   * Both removals are idempotent (`force: true`), which `rollForward` requires — it may re-enter
   * this phase after a crash.
   */
  async convergeAgentProfileForget(
    name: string,
    agentId: string,
    txid: string,
    expected: AgentProfileForgetSnapshot,
  ): Promise<void> {
    // Mesmo código da pré-condição: a condição é a mesma (sessão viva bloqueia o forget), só a fase
    // muda. O código nomeia a classe; a mensagem nomeia onde foi detectada.
    await this.assertRemovalOccupancyFree(
      name,
      "agent-profile/forget-agent-running",
      `canonical forget found a live session for '${name}'`,
    );
    this.opts.ledger?.removeExactDigest(name, expected.ledgerSha256);
    convergeActivityRetirement(
      this.activityDir(),
      name,
      expected.activity,
      path.join(this.opts.workspaceRoot, ".tachyon", "retired-agent-profiles", agentId, txid, "runtime-projections"),
    );
    // t-14cf7c: Saved Agent Forget reaches the same credential-retirement tail as Temporary
    // dismiss. The complete cache is retained; only authority-bearing files are removed.
    this.opts.removeHarnessHome?.(name);
    removeDerivedAgentFiles(this.opts.workspaceRoot, name);
    removePaneTranscript(this.opts.workspaceRoot, name);
    // `removeExactDigest` above took the ledger row, which is the definition — nothing else to drop.
    this.lineage.delete(name);
    this.delegators.delete(name);
    this.readyAgents.delete(name);
    this.provisionalAgents.delete(name);
    this.readinessCache.delete(name);
    this.stoppingSince.delete(name);
    this.clearStopFailed(name);
    this.cleanExited.delete(name);
    this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
    this.postmortemOutput.delete(name);
  }

  /** Idempotently converge captured live bindings after canonical profile authority commits. */
  async convergeAgentProfileRename(
    oldName: string,
    newName: string,
    expected: CanonicalLiveRenameSnapshot,
  ): Promise<void> {
    let oldSession = await this.opts.tmux.hasSession(this.session(oldName));
    let newSession = await this.opts.tmux.hasSession(this.session(newName));
    if (expected.sessionPresent) {
      if (oldSession && !newSession) {
        try { await this.opts.tmux.renameSession(this.session(oldName), this.session(newName)); }
        catch (error) {
          oldSession = await this.opts.tmux.hasSession(this.session(oldName));
          newSession = await this.opts.tmux.hasSession(this.session(newName));
          if (oldSession || !newSession) throw error;
        }
        oldSession = await this.opts.tmux.hasSession(this.session(oldName));
        newSession = await this.opts.tmux.hasSession(this.session(newName));
      }
      if (oldSession || !newSession) throw new Error("canonical live rename tmux ownership is ambiguous");
    } else if (oldSession || newSession) {
      throw new Error("canonical stopped rename found an unexpected tmux session");
    }

    this.opts.ledger?.renameExact(oldName, newName, expected.ledgerRecord);
    convergeActivityRename(this.activityDir(), oldName, newName, expected.activity);

    // t-eb4b30 — `renameExact` above moved the ledger row, which carries the definition. The
    // conflicting-state check went with it: the ledger owns that key, so it cannot hold two.
    const parent = this.lineage.get(oldName);
    if (parent) {
      const targetParent = this.lineage.get(newName);
      if (targetParent !== undefined && targetParent !== parent) throw new Error("canonical live rename found conflicting lineage");
      this.lineage.delete(oldName);
      this.lineage.set(newName, parent);
    }
    for (const [child, value] of this.lineage) if (value === oldName) this.lineage.set(child, newName);
    for (const [child, value] of this.delegators) if (value === oldName) this.delegators.set(child, newName);
    const postmortem = this.postmortemOutput.get(oldName);
    if (postmortem) {
      if (this.postmortemOutput.has(newName)) throw new Error("canonical live rename found conflicting postmortem state");
      this.postmortemOutput.delete(oldName);
      this.postmortemOutput.set(newName, postmortem);
    }
  }

  /**
   * Drop a promoted agent's runtime lineage (spec 211: after promotion to tachyon.yml, config is
   * authoritative — no lingering Temporary shadow).
   *
   * t-eb4b30 — the definition half of this is now automatic and needs no call: promotion rewrites the
   * row to `lifetime: "saved"`, and `definitionOf` gives the config definition precedence anyway, so
   * there is no shadow left to forget. Only the lineage is still this method's to clear.
   */
  forgetTemporary(name: string): void {
    this.lineage.delete(name);
    this.delegators.delete(name);
  }

  /** The one place that owns the durable activity-log directory (spec 239). */
  private activityDir(): string {
    return path.join(this.opts.workspaceRoot, ".tachyon", "activity");
  }

  /**
   * Remove an EPHEMERAL agent's durable footprint through the canonical forgetAgent()
   * cleanup: ledger row, activity log/state, session-owner rows, private runtime-home credentials,
   * and per-spawn settings. t-eb4b30 — since the row IS the definition, this is no longer the on-disk
   * half of a two-place forget: it is the whole one. `forgetTemporary` now only clears lineage.
   *
   * EPHEMERAL ONLY: never call for an agent whose log must survive — a declared agent
   * being merely stopped, or a postmortem-viewable clean-exit dead pane (spec 239 keeps
   * those until an explicit dismiss). Callers gate; this helper never reads the instance policy.
   * Idempotent (ledger.remove on a missing key + force-rm of missing files).
   */
  removeEphemeralFootprint(name: string): void {
    forgetAgent(name, {
      workspaceRoot: this.opts.workspaceRoot,
      ledger: this.opts.ledger,
      removeHarnessHome: this.opts.removeHarnessHome,
      removeBridgeRuntimeHome: this.opts.removeBridgeRuntimeHome,
      removePiSessionDir: this.opts.removePiSessionDir,
    });
  }

  /**
   * Fully forget a Temporary instance — in-memory def + lineage AND its persisted
   * ledger row — so a sessionless/finished one won't rehydrate after a reload.
   * (The live dead-pane clean-exit case is auto-handled by list(); this is the
   * explicit user "dismiss" for a stopped row, or a one-shot whose pane vanished
   * before list() observed its exit.) Idempotent.
   */
  dismissTemporary(name: string): void {
    this.forgetTemporary(name); // in-memory def + lineage
    // pin p-4dadd3 (a): dismiss is the TRUE end-of-life for a Temporary one-shot — the clean-exit dead pane
    // (remain-on-exit) keeps offering "Activity" in postmortem until the user dismisses it, so the durable
    // log must survive until here, then be dropped with the row (it becomes unreachable: no row, no pane).
    // NOT done in list()'s clean-exit ledger-reap (the postmortem pane is still viewable then) and NOT in
    // forgetTemporary (promotion to a declared tachyon.yml agent KEEPS the log — it's now a persistent agent).
    this.cleanExited.delete(name);
    this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
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
    runtime?: ResumeRuntime;
    onBeforeKillNew?: () => void;
    onReplacementAttempt?: () => void;
  }): Promise<"respawned" | "created"> {
    const parsed = parseLaunchCommand(opts.cmd);
    const runtime = opts.runtime ?? (parsed ? adapterFor(parsed.binary)?.runtime : undefined);
    const target = agentFromSession(this.opts.wsHash, opts.session) ?? opts.session;
    return runtime === "pi"
      ? this.withPiAdmission(target, () => this.startSessionCommandUnlocked(opts))
      : this.startSessionCommandUnlocked(opts);
  }

  private async withPiAdmission<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.piAdmissionTail;
    const run = prior.then(
      () => this.withPiAdmissionUnlocked(target, operation),
      () => this.withPiAdmissionUnlocked(target, operation),
    );
    this.piAdmissionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withPiAdmissionUnlocked<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const sessions = await this.opts.tmux.sessionStates(this.prefix);
    if (sessions === null) {
      throw new Error(`cannot start Pi agent '${target}': could not prove the workspace Pi slot is free`);
    }
    if (this.livePiHint && this.livePiHint !== target) {
      const hintedState = sessions.get(this.session(this.livePiHint));
      if (hintedState && !hintedState.dead) {
        throw new Error(
          `cannot start Pi agent '${target}': Pi OAuth safety currently permits one live Pi agent per workspace; stop '${this.livePiHint}' first`,
        );
      }
      this.livePiHint = undefined;
    }
    for (const [session, state] of sessions) {
      if (state.dead) continue;
      const other = agentFromSession(this.opts.wsHash, session);
      if (other === null || other === target) continue;
      const record = this.opts.ledger?.get(other);
      const command = record?.def?.cmd ?? this.definitionOf(other)?.cmd;
      const runtime = record?.resume?.runtime ?? (() => {
        const parsed = command ? parseLaunchCommand(command) : null;
        return parsed ? adapterFor(parsed.binary)?.runtime : undefined;
      })();
      if (!record?.resume?.runtime && !command) {
        throw new Error(
          `cannot start Pi agent '${target}': could not classify live workspace entry '${other}' for Pi OAuth safety`,
        );
      }
      if (runtime === "pi") {
        throw new Error(
          `cannot start Pi agent '${target}': Pi OAuth safety currently permits one live Pi agent per workspace; stop '${other}' first`,
        );
      }
    }
    const result = await operation();
    this.livePiHint = target;
    return result;
  }

  private async startSessionCommandUnlocked(opts: {
    session: string;
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    onBeforeKillNew?: () => void;
    onReplacementAttempt?: () => void;
  }): Promise<"respawned" | "created"> {
    const agentName = agentFromSession(this.opts.wsHash, opts.session) ?? opts.session;
    const cmd = this.applyAgentMemoryScope(agentName, opts.cmd);
    const { session, cwd } = opts;
    // t-e73e54 — restart/resume lands here, and it creates real agent sessions: a respawned pane and
    // both `newSession` branches below. Attesting once at the top covers all three; doing it at each
    // call site is how the previous divergence happened.
    const env = withPostCutAttestation(opts.env);
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
    this.assertProfileLifecycleEnabled(name);
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
          const attempt = await this.tryResumeAfterStop(name);
          if (attempt.resumed) {
            return { stop, session, resumed: true, forcedAfterGracefulTimeout };
          }
          await this.restartFresh(name);
          return { stop, session, resumed: false, forcedAfterGracefulTimeout, resumeUnavailable: attempt.reason };
        }
      }

      // Stop phase over (or already stopped). Drop "stopping" before start so resume/fresh
      // cannot leave a live pane stuck in the graceful-stop UI state.
      this.clearStoppingState(name);

      const attempt = session === "resume" ? await this.tryResumeAfterStop(name) : undefined;
      if (attempt?.resumed) {
        return { stop, session, resumed: true, forcedAfterGracefulTimeout };
      }
      await this.restartFresh(name);
      return { stop, session, resumed: false, forcedAfterGracefulTimeout, ...(attempt ? { resumeUnavailable: attempt.reason } : {}) };
    } catch (error) {
      // Start failed after a graceful stop attempt — don't leave a permanent "stopping" badge.
      this.clearStoppingState(name);
      throw error;
    }
  }

  /** Clear graceful-stop UI flags (used when restart/resume owns the lifecycle again). */
  private clearStoppingState(name: string): void {
    this.stoppingSince.delete(name);
    this.clearStopFailed(name);
  }

  private clearStopFailed(name: string): void {
    this.stopFailed.delete(name);
    this.stopFailureDetail.delete(name);
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
   * Kill the tmux session only — never AgentManager.kill (that wipes Temporary ledger rows).
   * Used when graceful stop times out during a restart.
   */
  private async hardKillSessionOnly(name: string): Promise<void> {
    this.stoppingSince.delete(name);
    this.clearStopFailed(name);
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

  /**
   * Attempt resume after stop.
   *
   * t-f6aa7c — answers with the REASON on failure rather than a bare false. Every branch here is a
   * different fact about the world (nothing was ever recorded / the record carries no resume block /
   * the runtime or its transcript is gone), and the caller that has to explain the loss to a human
   * needs which one it was.
   */
  private async tryResumeAfterStop(name: string): Promise<{ resumed: true } | { resumed: false; reason: string }> {
    const record = this.opts.ledger?.get(name);
    if (!record) return { resumed: false, reason: "no session record for this agent (nothing was captured to resume)" };
    if (!record.resume) return { resumed: false, reason: "session record has no resume block (no prior session was captured)" };
    try {
      await this.resume(name, record);
      return { resumed: true };
    } catch (err) {
      if (err instanceof ResumeUnavailableError) return { resumed: false, reason: err.reason };
      throw err;
    }
  }

  /**
   * Force-replace / new-section restart: kill-ish respawn with the same definition (pre-389 path).
   * Mints a fresh session title for title-tracked runtimes.
   */
  private async restartFresh(name: string): Promise<void> {
    let def = this.definitionOf(name);
    if (!def) {
      throw new Error(
        `cannot restart '${name}': no stored definition (a re-discovered Temporary instance loses its definition across extension restarts — kill and re-spawn instead)`,
      );
    }
    // Project guidance is part of the replacement command. Load it before even transient restart
    // state changes so an invalid configured source leaves the live pane and its status untouched.
    const projectGuidance = this.projectGuidanceFor(def);
    const suppression = this.applyFormationNativeSuppression(name, def);
    def = suppression.def;
    const session = this.session(name);
    let worktree: WorktreeRecord | undefined;
    let preparationLocked = false;
    let restartTokenMinted = false;
    let replacementAttempted = false;
    try {
    const restartPrimerCtx = {
      delegator: this.delegators.get(name),
      freshWorktree: false as const,
    };
    const restartParent = this.lineage.get(name);
    // Resolve the exact reused cwd/private home before any live-pane or transient-state mutation.
    let cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    if (this.opts.resolveSpawnCwd) {
      const resolved = await this.opts.resolveSpawnCwd({
        name,
        def,
        parent: restartParent,
        temporary: this.isTemporary(name),
        isRestart: true,
        // t-da80ed — restart resolves the cwd through the same override as spawn, so it discarded a
        // declared directory the same way. Same fact in, same sentence out.
        ...(def.cwd ? { declaredCwd: cwd } : {}),
      });
      if (resolved) {
        cwd = resolved.cwd;
        worktree = resolved.worktree;
        preparationLocked = resolved.preparationLocked === true;
      }
    }
    const restartHarness = this.materializeRuntimeHarness(
      name,
      def,
      cwd,
      !!(restartParent || this.delegators.get(name)),
    );
    await this.assertLaunchPreflight(
      name,
      def.cmd,
      { ...this.opts.getExtraEnv?.(), ...def.env, ...(restartHarness?.env ?? {}) },
      this.isTemporary(name),
      cwd,
    );
    // `effectiveInstructions` includes long-brief persistence. It must succeed before cache changes,
    // ownership refresh, respawn, or kill+new fallback can mutate the running session.
    const persistedDef = this.opts.ledger?.get(name)?.def;
    if (persistedDef?.contractInvalid) {
      throw new Error(
        `refusing restart for agent '${name}': persisted spawn contract is invalid; ` +
        "expected task/context/constraints strings and exactly one non-empty deliverable or done_when",
      );
    }
    // Resolved before any cache/pane mutation: an unreadable board must refuse the restart outright
    // rather than replace the session with one that cannot state its own assignment (t-e3aaae).
    // t-9d250c — the record is built against the brief this restart will actually replay, so it can
    // name a contract that has since been finished instead of leaving the agent to notice.
    const replayedBrief = [
      persistedDef?.taskBrief,
      persistedDef?.contract ? Object.values(persistedDef.contract).filter((v) => typeof v === "string").join("\n") : undefined,
    ].filter(Boolean).join("\n");
    const restartWorkRecord = this.sessionWorkRecordFor(name, def, worktree, cwd, replayedBrief);
    const restartInstructions = this.effectiveInstructions(
      name,
      def,
      restartParent,
      restartPrimerCtx,
      persistedDef?.taskBrief,
      persistedDef?.contract,
      projectGuidance,
      restartWorkRecord,
    );
    this.stoppingSince.delete(name);
    this.clearStopFailed(name);
    this.readinessCache.delete(name); // spec 221: restart is a new session → drop the cached badge
    this.cleanExited.delete(name);
    this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
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
      this.effectiveCmd(name, def, restartInstructions, !!(this.lineage.get(name) || this.delegators.get(name))),
      {
        ...this.opts.getExtraEnv?.(),
        ...def.env,
        TACHYON_AGENT_NAME: name,
        ...this.hermesBriefEnv(def, restartInstructions),
      },
      restartHarness,
    );
    this.applyDelegatedOpencodeHarnessPermission(def, restartBuild.env, restartDelegatedOpencode);
    const restartBridge = this.withRuntimeBridge(
      name,
      def,
      restartBuild.cmd,
      cwd,
      restartDelegatedOpencode,
      injected.adapter?.runtime === "pi" && !injected.selfManaged,
      restartBuild.env.GROK_HOME,
    );
    const restartOwnedCmd = this.withSessionOwnership(name, def, restartBridge.cmd, {
      lifecycleHooks: !this.isTemporary(name),
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
      runtime: injected.adapter?.runtime,
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
      // t-04052d — this fallback (no prior row) used to supply `declared` and nothing else, which left
      // the new row with NO instance policy. That was invisible while `declared` still answered for
      // readers; with the field gone it would write a row this build cannot describe and the
      // activation gate would later refuse the whole workspace over it. So the fallback declares the
      // policy, from what a restart actually is: it is `restartable` by definition — that is the
      // operation in progress — and its lifetime follows the same source restart already uses to
      // decide hook injection two dozen lines above, so the two cannot disagree.
      const restartTemporary = this.isTemporary(name);
      const { lifecycle: _terminalLifecycle, ...restartable } = existing ?? {
        instance: restartTemporary
          ? { lifetime: "temporary" as const, resumePolicy: "restartable" as const, lifecycleHooks: false }
          : { lifetime: "saved" as const, resumePolicy: "restartable" as const, lifecycleHooks: true },
      };
      this.opts.ledger.record(name, {
        ...restartable,
        cwd,
        ...(worktree ? { worktree } : {}),
        resume,
      });
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
    // t-b88106 — a restart CONTINUES an agent; it does not decide whether it should be visible. A pane
    // that was open is restored in place; one that was headless (including crash auto-restart and
    // watch-restart, which no human asked for) stays headless.
    this.opts.onSpawned?.(name, "preserve");
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
        failures.push(new Error(`restart worktree recovery state was preserved at ${worktree.path}; ${RELEASE_LOCK_HINT}`));
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
   * their bounded cache.
   */
  async rebindResumeReadiness(name: string, record: SessionRecord): Promise<RebindResumeReadiness> {
    return await this.computeResumeReadiness(name, record);
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
    if (runtime === "pi") {
      const resolved = await this.opts.resolveCaptureSession?.(runtime, cwd, configHome, id);
      return resolved && exists(resolved.path)
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
    if (runtime === "codex" || runtime === "opencode" || runtime === "pi") {
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
    this.assertProfileLifecycleEnabled(name);
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
    if (runtime === "pi" && id) {
      const resolved = await this.opts.resolveCaptureSession?.(runtime, cwd, configHome, id);
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (!resolved || !exists(resolved.path)) {
        throw new ResumeUnavailableError(name, "transcript no longer on disk (retention/deleted)");
      }
    }

    const session = this.session(name);
    // Cap against OTHER live agents — a remain-on-exit dead pane does not occupy a slot, and
    // respawning THIS agent (already live) is a replace, not a new seat. Count others so we
    // don't reject resume of a running agent when the fleet is already at max (pre-t-4d2630
    // killed first, which dropped the seat before the check).
    const othersLive = (await this.runningAgents()).filter((n) => n !== name).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? DEFAULT_MAX_AGENTS;
    if (othersLive >= max) throw new MaxAgentsError(max);

    // Re-apply the declared agent's env on resume (spec 211 review fix) — spawn/restart include
    // def.env, but resume previously injected only bridge env, silently dropping e.g. an
    // ANTHROPIC_BASE_URL model-swap. definitionOf = config (declared) or temporary def. spec 226 (H3):
    // also re-apply the isolated-harness wiring so a resumed harness agent stays scoped.
    const resumeDef = this.agentDefinitionOf(name);
    // Security review (782f1c6): mirror restart's fuller delegated-check (`record.def?.parent` alone
    // misses a GATED agent — gated spawns always force `parent: undefined` and record `delegator`
    // instead, which never lands in `record.def`), and gate on the resumed worktree so an uncontained,
    // shared-cwd delegation doesn't get blanket bash:"allow" either (HIGH).
    const resumeDelegatedOpencode = (this.lineage.get(name) || this.delegators.get(name)) && record.worktree
      ? { workspaceRoot: this.opts.workspaceRoot, worktreesBase: this.worktreesBaseFor(cwd, record.worktree) }
      : undefined;
    // spec 380 — transcript lookup already treats resume.configHome as authoritative (spec 240), so
    // the replacement process must use that same home.  A rehydrated Temporary Claude row can lack the
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
    const resumeDelegated = !!(this.lineage.get(name) || this.delegators.get(name));
    const resumeHarness = this.materializeRuntimeHarness(name, resumeDef, cwd, resumeDelegated);
    await this.assertLaunchPreflight(
      name,
      cmd,
      { ...this.opts.getExtraEnv?.(), ...resumeDef?.env, ...(resumeHarness?.env ?? {}), ...persistedResumeHomeEnv },
      isTemporaryInstance(record),
      cwd,
    );
    const resumeBuild = this.applyHarness(
      name,
      resumeDef,
      cwd,
      adapter.resumeCommand(
        this.applyAgentPermissionProjection(
          name,
          cmd,
          resumeDelegated,
          resumeDef?.profileNativeConfig?.permissions,
        ),
        id,
      ),
      // Mint last so resumeDef.env cannot clobber TACHYON_AGENT_BRIDGE_TOKEN.
      { ...this.opts.getExtraEnv?.(), ...resumeDef?.env, ...this.opts.mintAgentToken?.(name), TACHYON_AGENT_NAME: name },
      resumeHarness,
    );
    this.applyDelegatedOpencodeHarnessPermission(resumeDef, resumeBuild.env, resumeDelegatedOpencode);
    // spec 236 (BLOCKER fix) — resume rebuilds the command, so it must re-inject the Bridge or a resumed
    // agent silently loses it. Classify the binary from the ACTUALLY-resumed `cmd` (record.def.cmd) so an
    // Temporary instance that's no longer in the config still gets it; harness routing comes from the config
    // overlay (resumeDef) so a harness agent folds the Bridge into its --strict file instead.
    const resumeBridge = this.withRuntimeBridge(
      name,
      { cmd, harness: resumeDef?.harness },
      resumeBuild.cmd,
      cwd,
      resumeDelegatedOpencode,
      runtime === "pi",
      resumeBuild.env.GROK_HOME,
    );
    this.readinessCache.delete(name); // spec 221: resuming changes the session → drop the cached badge
    // Resume is intentional re-launch — never inherit a prior graceful-stop "stopping" badge.
    this.clearStoppingState(name);
    // t-4d2630: respawn when a session/dead pane already exists; kill+new only as fallback.
    await this.startSessionCommand({
      session,
      cmd: this.withSessionOwnership(name, { cmd }, resumeBridge.cmd, {
        // Resume re-attaches an EXISTING instance, so it must reuse the capability that instance was
        // launched with — read from the row, never re-derived. This is the promotion case the
        // capability field exists for: a promoted agent has a Saved Profile while its running
        // instance still carries the ownership-only hooks it started with.
        lifecycleHooks: hasLifecycleHooks(record),
        cwd,
        configHome: resumeBuild.env.CLAUDE_CONFIG_DIR ?? persistedResumeHomeEnv.CLAUDE_CONFIG_DIR,
      }),
      cwd,
      env: { ...resumeBuild.env, ...persistedResumeHomeEnv, ...resumeBridge.env }, // spec 236 + 380 persisted home
      runtime,
    });
    // Resume re-attaches to existing state; only its newly launched session is disposable.
    await this.observeLaunchReadiness(name, cmd, session);
    const { lifecycle: _terminalLifecycle, ...activeRecord } = record;
    this.cleanExited.delete(name);
    this.stopRequestedAt.delete(name); // t-9d76b1 — a new instance is not the stopped one
    this.postmortemOutput.delete(name);
    this.opts.ledger?.record(name, { ...activeRecord, resume: this.withConfigHome(name, this.definitionOf(name), { ...record.resume, runtime, sessionId: id }) }); // spec 240 — preserve persisted configHome
    // spec 364 — stamp bound_generation at resume time (rebind + human resume both land here).
    if (!opts?.deferBridgeStamp) this.stampBridgeClientBinding(name, resumeBridge.wired);
    // t-b88106 — resume re-attaches an existing agent, and most resumes are activation/rebind rather
    // than a human asking to look at it. Preserve: `restoreOpenTerminals()` is what reopens the tabs
    // that were genuinely open, from the manifest.
    this.opts.onSpawned?.(name, "preserve");

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
    });
    await this.opts.tmux.sendKeys(session, `${primer}\n\n${beforeFinishing}`, true);
  }

  /** All names that already exist anywhere (config / ledger / Temporary memory / live tmux) — for fork-name uniqueness. */
  private async allKnownNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const n of Object.keys(this.opts.getConfig()?.agents ?? {})) names.add(n);
    for (const n of this.opts.ledger?.all().keys() ?? []) names.add(n);
    for (const n of this.temporaryNames()) names.add(n);
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
    /** Exact config namespace used to resolve and validate the source transcript. */
    sourceConfigHome: string;
    /** Exact validated source JSONL for runtimes whose fork namespace differs from the destination (Pi). */
    sourceTranscriptPath?: string;
    instructions?: string;
    env?: Record<string, string>;
  }> {
    const ledger = this.opts.ledger;
    if (!ledger) throw new ForkUnavailableError(name, "the session ledger is disabled");
    const rec = ledger.get(name);
    if (!rec?.resume) throw new ForkUnavailableError(name, "it has no tracked session to fork");
    const { runtime } = rec.resume;
    const adapter = adapterForRuntime(runtime);
    if (!adapter || !forkable(adapter)) throw new ForkUnavailableError(name, `'${runtime}' has no native session fork`);
    const baseCmd = rec.def?.cmd;
    if (!baseCmd) throw new ForkUnavailableError(name, "no base command recorded to fork");
    // spec 226 (v1) — forking an isolated-harness agent isn't supported yet: the fork would need its
    // OWN config home plus a cross-config-home transcript seed. Block it honestly rather than spawn a
    // fork that silently loses the harness's MCP isolation (fail-closed, H9). Follow-pass.
    if (this.agentDefinitionOf(name)?.harness) throw new ForkUnavailableError(name, "forking an isolated-harness agent isn't supported yet (v1)");
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
    let sourceTranscriptPath: string | undefined;
    if (runtime === "pi") {
      // Pi can rotate sessions in-TUI. Its bundled extension records every session_start positively;
      // require that current row rather than forking the launch-time UUID after a /new or /resume.
      const owned = this.opts.ownedSession?.(name, cwd);
      if (!owned) throw new ForkUnavailableError(name, "its current Pi session ownership has not been observed yet");
      id = owned.sessionId;
      const resolved = await this.opts.resolveCaptureSession?.(runtime, cwd, configHome, id);
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (!resolved || !exists(resolved.path) || path.resolve(resolved.path) !== path.resolve(owned.transcriptPath)) {
        throw new ForkUnavailableError(name, "its current Pi ownership row does not resolve to one exact transcript");
      }
      sourceTranscriptPath = path.resolve(resolved.path);
    } else {
      if (runtime === "claude" && this.opts.resolveCurrentSession && id && !this.isUuid(id)) {
        id = (await this.opts.resolveCurrentSession(runtime, cwd, id, configHome)) ?? "";
      }
      if (!id) id = (await this.opts.resolveCaptureId?.(runtime, cwd, configHome)) ?? "";
    }
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
      sourceConfigHome: configHome,
      ...(sourceTranscriptPath ? { sourceTranscriptPath } : {}),
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
   * sibling through the runtime's native fork command. Pi uses a fresh UUID + exact cross-home JSONL;
   * other runtimes preserve their existing id-based transport. Records a PERSISTENT sibling ledger row
   * (base cmd + the fork's own identity + fork:true, NO parent lineage). Returns the fork name.
   */
  async commitFork(plan: ForkPlan): Promise<string> {
    const source = plan.source;
    const sourceRecord = this.opts.ledger?.get(source);
    const sourceDefinition = this.agentDefinitionOf(source);
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
    const max = this.opts.getConfig()?.settings.maxAgents ?? DEFAULT_MAX_AGENTS;
    if (liveCount >= max) throw new MaxAgentsError(max); // gate BEFORE any side effect (no orphan worktree)
    // Re-derive a fresh unique name so two concurrent/stale confirmations can't both claim the same one.
    const forkName = this.uniqueForkName(source, await this.allKnownNames());
    this.readinessCache.delete(forkName);
    // Pi's destination identity is known before any checkout/home/token side effect. A broken injected
    // generator therefore cannot strand a worktree merely because it repeated the source UUID.
    let forkSessionId = src.runtime === "pi"
      ? (this.opts.newSessionId ?? (() => crypto.randomUUID()))()
      : this.claudeSessionName(forkName);
    if (src.runtime === "pi" && forkSessionId === src.sourceId) {
      forkSessionId = (this.opts.newSessionId ?? (() => crypto.randomUUID()))();
      if (forkSessionId === src.sourceId) throw new ForkUnavailableError(source, "could not mint a distinct Pi fork session id");
    }

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
    const forkDefinition: AgentEntry = {
      cmd: src.baseCmd,
      kind: "agent",
      autostart: false,
      watch: [],
      attention: { enabled: true, silenceSec: 8, patterns: [] },
      restart: "never",
      ...(src.instructions ? { instructions: src.instructions } : {}),
      ...(sourceRecord?.def?.taskBrief ? { taskBrief: sourceRecord.def.taskBrief } : {}),
      ...(src.env ? { env: src.env } : {}),
      // A canonical fork is still a Temporary sibling, so it must not inherit profileLifecycle
      // authority. This internal marker retains canonical private-home materialization even when
      // the source selected no optional native/capability families.
      ...(sourceDefinition?.profileLifecycle ? { profileFork: true as const } : {}),
      ...(sourceDefinition?.profileNativeConfig
        ? {
            // structuredClone drops the non-enumerable ownership metadata, so a forked agent would
            // stop being marked pending when its runtime config changes (t-59a11b).
            profileNativeConfig: carryNativeConfigSources(
              structuredClone(sourceDefinition.profileNativeConfig),
              sourceDefinition.profileNativeConfig,
            ),
          }
        : {}),
      ...(sourceDefinition?.profileCapabilities
        ? { profileCapabilities: structuredClone(sourceDefinition.profileCapabilities) }
        : {}),
      // t-b0cfd4 — a fork inherits what the source was NOT given, for the same reason it inherits
      // what it was: the fork delegates from the same profile, and a withholding that did not travel
      // would let the fork's own delegation hand a child the bytes the source is running without.
      ...(sourceDefinition?.profileWithheldCapabilities
        ? { profileWithheldCapabilities: structuredClone(sourceDefinition.profileWithheldCapabilities) }
        : {}),
    };
    const forkRecord = () => ({
      def: {
        cmd: src.baseCmd,
        kind: "agent" as const,
        ...(src.instructions ? { instructions: src.instructions } : {}),
        ...(sourceRecord?.def?.taskBrief ? { taskBrief: sourceRecord.def.taskBrief } : {}),
        ...(src.env ? { env: src.env } : {}),
        fork: true,
      },
      resume: this.withConfigHome(forkName, forkDefinition, { runtime: src.runtime, sessionId: forkSessionId }),
      ...(worktree ? { worktree } : {}),
      cwd,
      // SDD 482 phase 2 — the case that justifies TWO fields rather than one enum. A fork has no
      // durable Profile, so its `lifetime` is `temporary`; but it owns a resume block and can be
      // resumed, so its `resumePolicy` is `restartable`. A single saved/temporary value would have to
      // lie about one of the two, and the thing it would most likely lie about is whether the fork
      // survives — which is the reload this phase must not break.
      // `lifecycleHooks: false` records what commitFork already decides above by passing
      // `lifecycleHooks: false` to withSessionOwnership — "a fork must not inherit profileLifecycle
      // authority". Now the row says so instead of a reader guessing.
      instance: { lifetime: "temporary" as const, resumePolicy: "restartable" as const, lifecycleHooks: false },
    });
    let spawnedSession: string | undefined;
    let sessionAttempted = false;
    let tokenMinted = false;
    let privateHomeCreated = false;
    try {
      // A worktree fork can load project-scoped runtime configuration. Probe only after resolving
      // that exact cwd, but before transcript seeding, token minting, tmux, or durable identity.
      // If this fails, the catch preserves the newly locked checkout as an explicit recovery receipt.
      if (path.resolve(cwd) !== path.resolve(src.sourceCwd)) {
        await this.assertLaunchPreflight(forkName, src.baseCmd, src.env, true, cwd);
      }
      // Claude/Grok/OpenCode fork by exact source id. Pi sources and destinations use distinct private
      // homes, so its native --fork receives the exact validated source JSONL path instead.
      const sourceRef = src.runtime === "pi" ? src.sourceTranscriptPath : src.sourceId;
      if (!sourceRef) throw new ForkUnavailableError(source, "its exact Pi source transcript is unavailable");
      const forkCmd = adapter.forkCommand(adapter.injectId(src.baseCmd, forkSessionId), sourceRef);
      const session = this.session(forkName);
      const canonicalPrivateFork = !!sourceDefinition?.profileLifecycle
        || !!forkDefinition.profileCapabilities
        || !!forkDefinition.profileNativeConfig;
      // t-ee5c05 — Grok joins Pi and Claude. Its private home is the bridge home, NOT `harnessHome`;
      // using the wrong one here would silently disable the partial-home cleanup below, since nothing
      // is ever created at the path it watches.
      const managedPrivateFork = src.runtime === "pi"
        || ((src.runtime === "claude" || src.runtime === "grok") && canonicalPrivateFork);
      const privateHome = !managedPrivateFork
        ? undefined
        : src.runtime === "grok"
          ? bridgeGrokHome(this.opts.workspaceRoot, forkName)
          : harnessHome(this.opts.workspaceRoot, forkName);
      const privateHomeExisted = privateHome ? fs.existsSync(privateHome) : true;
      let preparedHarness: MaterializedHarness | null = null;
      try {
        preparedHarness = managedPrivateFork
          ? this.materializeRuntimeHarness(forkName, forkDefinition, cwd)
          : null;
      } finally {
        // Materializers may fail after creating part of the home; retain cleanup authority in that case.
        privateHomeCreated = !!privateHome && !privateHomeExisted && fs.existsSync(privateHome);
      }
      if (managedPrivateFork && !preparedHarness) {
        throw new ForkUnavailableError(source, `couldn't materialize the ${src.runtime} fork private home`);
      }

      // A private-home fork always crosses transcript namespaces, even when it shares the source cwd.
      // Worktree forks additionally cross project directories. Seed from the exact source namespace
      // validated by resolveForkSource into the destination namespace returned by materialization.
      const destinationConfigHome = preparedHarness?.env.CLAUDE_CONFIG_DIR
        ?? preparedHarness?.home
        ?? src.sourceConfigHome;
      if (adapter.transcriptPath && (
        path.resolve(destinationConfigHome) !== path.resolve(src.sourceConfigHome)
        || path.resolve(cwd) !== path.resolve(src.sourceCwd)
      )) {
        // t-ee5c05 — seed the runtime's declared transcript UNIT. For Claude that is the JSONL file
        // `transcriptPath` names; for Grok the session is the directory around it, and copying only
        // that file produces a session the runtime reports as not found.
        const unit = (file: string) => adapter.transcriptUnit === "session-directory" ? path.dirname(file) : file;
        const seeded = (this.opts.seedTranscript ?? defaultSeedTranscript)(
          unit(adapter.transcriptPath(src.sourceConfigHome, src.sourceCwd, src.sourceId)),
          unit(adapter.transcriptPath(destinationConfigHome, cwd, src.sourceId)),
        );
        if (!seeded) throw new ForkUnavailableError(source, "couldn't seed the session transcript into the fork's private namespace (the fork's resume would find nothing)");
      }
      const tokenEnv = this.opts.mintAgentToken?.(forkName);
      tokenMinted = tokenEnv !== undefined && Object.keys(tokenEnv).length > 0;
      const baseForkEnv = { ...this.opts.getExtraEnv?.(), ...tokenEnv, ...src.env, TACHYON_AGENT_NAME: forkName };
      // Apply the already-prepared private home for Pi and canonical Claude; ordinary forks retain
      // their existing byte/env path.
      const projectedForkCmd = this.applyAgentPermissionProjection(forkName, forkCmd);
      const forkBuild: { cmd: string; env: Record<string, string> } = preparedHarness
        ? this.applyHarness(forkName, forkDefinition, cwd, projectedForkCmd, baseForkEnv, preparedHarness)
        : { cmd: projectedForkCmd, env: baseForkEnv };
      // spec 236 / SDD 405 — a fork is a normal Tachyon-spawned process: private home first, then
      // immutable Pi extension + Bridge. managedPiSession also supplies the ownership ledger path.
      const forkBridge = this.withRuntimeBridge(
        forkName,
        forkDefinition,
        forkBuild.cmd,
        cwd,
        undefined,
        src.runtime === "pi",
        forkBuild.env.GROK_HOME,
      );
      if (src.runtime === "pi" && this.opts.getExtraEnv?.()?.[URL_ENV_VAR] && !forkBridge.wired) {
        throw new ForkUnavailableError(source, "Pi Bridge tools could not be materialized for the fork");
      }
      sessionAttempted = true;
      await this.createOwnedSession({
        agent: forkName,
        session,
        ownedCmd: this.withSessionOwnership(forkName, forkDefinition, forkBridge.cmd, {
          lifecycleHooks: false,
          cwd,
          configHome: forkBuild.env.CLAUDE_CONFIG_DIR ?? this.defaultClaudeConfigHome(),
          // A user-created fork inherits the source command's permission posture; capture must not widen it.
          preservePermissionMode: true,
        }),
        cwd,
        env: { ...forkBuild.env, ...forkBridge.env },
        runtime: src.runtime,
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
        failures.push(new Error(`fork recovery session may still be live and remains recorded as '${forkName}'`));
      } else {
        try { this.opts.ledger?.remove(forkName); }
        catch (error) { failures.push(new Error(`failed to remove fork recovery ledger row for '${forkName}'`, { cause: error })); }
      }
      if (tokenMinted) {
        try { this.opts.revokeAgentToken?.(forkName); }
        catch (error) { failures.push(new Error(`failed to revoke fork token for '${forkName}'`, { cause: error })); }
      }
      if (privateHomeCreated && !runtimeMayBeLive && !worktree) {
        try { this.opts.removeHarnessHome?.(forkName); }
        catch (error) { failures.push(new Error(`failed to remove ${src.runtime} fork private home for '${forkName}'`, { cause: error })); }
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
    // t-eb4b30 — the fork's row (recorded above) is its definition; there is no map to also write.
    this.opts.onSpawned?.(forkName, "reveal"); // a fork is a new agent someone asked for — nothing to preserve
    await this.attachPaneTranscript(this.session(forkName));
    return forkName;
  }

  /** Kills every session of this workspace — alive agents and crashed postmortem panes alike. */
  /**
   * Kill every agent session in this workspace, sweeping until a successful read finds none.
   *
   * t-2d2ce7 — this used to enumerate ONCE via `agentStates()` and kill what it saw, which had two
   * ways to leave something alive. A session born during the sweep was never in the snapshot; and
   * `agentStates()` falls back to the `lastAgentStates` CACHE when the tmux read is ambiguous, so a
   * hiccup could have it killing a stale list — or nothing at all — while reporting the names it
   * "stopped". The sweep reads `sessionStates` directly for exactly that reason: for stop-everything,
   * a cache is the wrong answer and an unreadable state must be retried, not assumed empty.
   */
  async killAll(): Promise<string[]> {
    const killedAgents: string[] = [];
    const result = await sweepSessions(this.opts.tmux, this.prefix, {
      onKill: async (session) => {
        const name = agentFromSession(this.opts.wsHash, session);
        if (name === null) return;
        await this.detachPaneTranscript(session);
        // t-eb4b30 — spec 211 applies to the SWEEP too, and it did not before.
        //
        // This used to delete the in-memory map entry and leave the ledger row, so the name dropped
        // out of `list()` until the next activation and then came back as a permanent stopped entry —
        // the exact resurrection `kill()` calls `removeEphemeralFootprint` to prevent. Measured on the
        // pre-change tree: spawn a Temporary, `killAll()`, `rehydrateFromLedger()`, and it is listed
        // again. Collapsing the store did not create that bug, it removed the mask.
        //
        // A fork is PERSISTENT (spec 225): its row survives a Stop and is dropped only by an explicit
        // Dismiss, which is the same exception `kill()` makes.
        //
        // t-28bf8f — and so is a row that still owns a checkout, for the reason spelled out on
        // `ownsWorktree`. Stop All is the sixth actor that reaches this same effect, and it reaches it
        // through its own copy of the collection rather than through `kill`, so the guard has to be
        // repeated here or the invariant holds everywhere except the one door that stops everything.
        if (this.opts.ledger?.get(name)?.def?.fork !== true && this.isTemporary(name) && !this.ownsWorktree(name)) {
          this.removeEphemeralFootprint(name);
          this.lineage.delete(name);
        }
        this.opts.onKilled?.(name);
        killedAgents.push(name);
      },
    });
    // Transcript detach happens in `onKill`, i.e. AFTER the session is killed rather than before it.
    // That ordering is safe — detaching a pipe from a dead pane is a no-op — and it is what lets the
    // one sweep own the kill for all three surfaces instead of each reimplementing the loop.
    if (!result.converged) {
      // Never silent: a sweep that hit its bound with work outstanding is not a completed Stop All,
      // and the operator asked for one precisely because they wanted control back.
      this.opts.onStopAllIncomplete?.(result.passes);
    }
    return killedAgents;
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
    if (fs.statSync(from).isDirectory()) return seedSessionDirectory(from, to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return fs.existsSync(to); // verify it actually landed — commitFork fails closed on false
  } catch {
    return false;
  }
}

/**
 * t-ee5c05 — seed a whole session directory, for a runtime whose session is not one file
 * (`transcriptUnit: "session-directory"`). Copies the directory's REGULAR FILES only:
 *
 *  - subdirectories are skipped, so the seed stays bounded and cannot recurse into runtime-owned trees
 *    (Grok keeps a `recap_requests/` directory beside the session's own files);
 *  - `*.lock` files are skipped, because a lock is a claim by the process that held it in the SOURCE
 *    home and carrying it into a fresh private home would assert something untrue about the fork.
 *
 * Returns false unless at least one file landed, so `commitFork` still fails closed on an empty or
 * unreadable source rather than spawning a fork whose session the runtime cannot find.
 */
function seedSessionDirectory(from: string, to: string): boolean {
  fs.mkdirSync(to, { recursive: true });
  let seeded = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".lock")) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    seeded += 1;
  }
  return seeded > 0;
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
