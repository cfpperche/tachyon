import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxService, workspaceHash, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { ControlModeClient } from "../tmux/ControlModeClient.js";
import { loadConfigFile, parseConfig, CONFIG_FILENAMES, inferKind, shellQuote, type TachyonConfig } from "../config/loadConfig.js";
import { composeAgentPrompt } from "../agents/promptLayers.js";
import { SoulError, agentSoulPath, readCanonicalSoulBytes } from "../agents/soul.js";
import {
  adoptSoulProfile,
  createSoulProfile,
  deleteSoulProfile,
  disableSoulProfile,
  enableSoulProfile,
  importSoulProfileBytesTransaction,
  replaceSoulProfileBytesTransaction,
  importSoulProfileTransaction,
  reconcileProfileTransactions,
  refreshSoulProfileStatus,
  type ProfileMutationResult,
  type ProfileTxConfigAccess,
} from "../agents/soulProfileTransactions.js";
import type { SoulProfileStatus } from "../agents/soul.js";
import { snapshotFromConfig, writeConfigLkg, readConfigLkg, type ConfigLkgSnapshot } from "../config/configLkg.js";
import { containsUnsafeFramingCharacter } from "../config/framingSafety.js";
import {
  type ConfigFailure,
  isLkgOnlySpawn,
  lkgSpawnRefusalMessage,
} from "../config/configFailure.js";
import { upsertAgent, upsertCommand, upsertRunbook, upsertSchedule, deleteSchedule, renameAgent as renameAgentInYml } from "../config/YamlConfigEditor.js";
import { AgentManager, ResumeUnavailableError, WatchController, newlyDeclaredAutostart, type DeliveryJoinRequest, type PreparedDeliveryJoin } from "../agents/AgentManager.js";
import { agentLaunchPath } from "../agents/spawnPath.js";
import { SessionLedger, durableBoundGeneration, type SessionDeliveryBinding, type SessionRecord } from "../resume/SessionLedger.js";
import { WorktreeManager, resolveWorktreeCwd, branchFor, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { ManagedWorktreeService } from "../worktree/ManagedWorktreeService.js";
import { PipelineManager, type PipelineDeps } from "../pipeline/PipelineManager.js";
import { RunLedger } from "../pipeline/RunLedger.js";
import { loadPipeline, nodeSpawnName } from "../pipeline/loadPipeline.js";
import { assembleNodePrompt } from "../pipeline/nodePrompt.js";
import { initRun, type PipelineRun } from "../pipeline/runState.js";
import { createHash, randomBytes } from "node:crypto";
import { isWorktreeDirty } from "../worktree/pr.js";
import { HarnessManager, defaultRealOpencodeDataHome, realConfigHome } from "../harness/HarnessManager.js";
import { materializePiSessionDir, removePiSessionDir } from "../agents/piSession.js";
import { expectedAgentClaudeEntry, expectedAgentOpencodeEntry } from "../registration/adapters.js";
import { adapterFor, binaryOf, harnessable, managesOwnSession } from "../resume/adapters.js";
import { nodeCanSignal, nodeRuntimeOf } from "../pipeline/preflight.js";
import os from "node:os";
import { effectiveVerify, verifySteps, verifyStale, verifyBadge, worktreeUnchanged, type VerifyState, type VerifyBadge } from "../worktree/verify.js";
import { EVIDENCE_SCHEMA_VERSION, VERIFY_PRODUCER, STEP_RESULT_KIND, summarizeEvidence, viewEvidence, isSafeArtifactRef, type WorktreeEvidence, type Severity, type EvidenceSummary, type EvidenceView } from "../worktree/evidence.js";
import { copyEvidenceArtifacts } from "../worktree/evidenceArtifacts.js";
import type { AttachEvidenceInput } from "../bridge/tools.js";
import { collectVerifyCandidates } from "../config/verifyCandidates.js";
import { resolveCaptureId, resolveCaptureSession, resolveCurrentSession } from "../resume/resolvers.js";
import { planResume, autoResumes, offers, type ResumePlanItem } from "../resume/planResume.js";
import { LifecycleMonitor } from "../agents/LifecycleMonitor.js";
import { AttentionMonitor, type AgentAttention } from "../attention/AttentionMonitor.js";
import { applyCompletionHint, CompletionHintStore } from "../attention/completionHint.js";
import { AdhocBackstopMonitor } from "./AdhocBackstopMonitor.js";
import { GatedCompletionMonitor, type GatedCandidateRecord } from "./GatedCompletionMonitor.js";
import { hasDoorbellRung } from "../bridge/doorbell.js";
import { roleReminder, buildRoleDoc } from "../roles/templates.js";
import { resolveClipboardHelperAsync } from "../tmux/clipboard.js";
import { compileExtraPatterns } from "../attention/patterns.js";
import { subtreeCpuTicks } from "../attention/cpu.js";
import { Waiters } from "../bridge/Waiters.js";
import { NoticeQueue, type NoticeQueueMetadata } from "../bridge/NoticeQueue.js";
import { Bridge, derivePort } from "../bridge/Bridge.js";
import { CompanionPairingService } from "../companion/CompanionPairingService.js";
import { CompanionLiveSync } from "../companion/CompanionLiveSync.js";
import { CompanionTabChannel } from "../companion/CompanionTabChannel.js";
import { companionListenHost, companionPairBaseUrl } from "../companion/lanReachability.js";
import { TabRefCache } from "../companion/tabRefCache.js";
import {
  listPendingApprovalRequests,
  resolveApproval,
  type ApprovalDecision,
} from "../bridge/approvalRequest.js";
import {
  COMPANION_HTTP_PREFIX,
  type CompanionAgentRow,
  type CompanionApprovalSummary,
  type CompanionResolveApprovalResponse,
  type IssuedPairCode,
  type SendPromptResponse,
} from "../companion/protocol.js";
import { composeAgentNotice, prepareAgentSummary } from "../bridge/notifyAgent.js";
import {
  BridgeClientRebindCoordinator,
  DEFAULT_BRIDGE_CLIENT_REBIND,
  parseBridgeClientRebindSettings,
  reloadInitiatorStateKey,
  isTachyonBridgeWiredRecord,
  type BridgeClientRebindSettings,
  type ClientRebindState,
} from "../bridge/clientRebind.js";
import type { AuthorityHead, AuthorityHeadPort } from "../delivery/authorityIntegrity.js";
import { resolveCanonicalBehaviorOracle } from "../bridge/behaviorStub.js";
import { behaviorTestError } from "../config/behaviorVerification.js";
import { parseArgvCommand } from "../config/argvCommand.js";
import { renderPrimer, wrapWithPrimer } from "../bridge/primer.js";
import { loadAndRenderProjectGuidance } from "../config/projectGuidance.js";
import { assertSafeBriefTransport, deliverableBody, previewDeliverableBody } from "../agents/briefFile.js";
import { loadOrCreateExternalToken, loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR, AGENT_TOKEN_ENV_VAR } from "../bridge/token.js";
import { CallerIdentityRegistry, loadOrCreateHmacKey, type CallerScope, type CallerSnapshot, type PersistableEntry } from "../bridge/callerIdentity.js";
import {
  authorityHeadsSecretKey,
  callerIdentityInstanceIdStateKey,
  callerIdentityRegistryStateKey,
  hostActionSessionEpochStateKey,
  workspaceVersionStateKey,
} from "./operationalStateKeys.js";
import { redactSecrets } from "../bridge/redact.js";
import { CMD_WAIT_PREFIX } from "../bridge/tools.js";
import { FileHashChainAuditSink, HostActionBroker, hostActionName, hostActionPolicyPaths, loadPinnedExternalPolicy, restorePinnedExternalPolicy, type HostActionCallerResolver } from "../host-action/index.js";
import { ReloadTransactionStore, type ReloadReattachBundle } from "../host-action/reloadTransaction.js";
import { VsCodeHostActionAdapter } from "../agent-vscode/hostActionAdapter.js";
import { VSCODE_RELOAD_WINDOW_POLICY_HASH, VSCODE_RELOAD_WINDOW_POLICY_JSON } from "../agent-vscode/reloadCapability.js";
import { CommandRunner } from "../commands/CommandRunner.js";
import { RunbookRunner } from "../commands/RunbookRunner.js";
import { Scheduler } from "../schedule/Scheduler.js";
import { ProposalStore } from "../schedule/ProposalStore.js";
import { PinStore } from "../pins/PinStore.js";
import { TaskStore } from "../tasks/TaskStore.js";
import { EvolutionStore } from "../evolution/EvolutionStore.js";
import { resolveEvolutionStartupSnapshot } from "../evolution/startupSnapshot.js";
import { EvolutionCoordinator } from "../evolution/EvolutionCoordinator.js";
import { declaredHarnessSkillNames } from "../evolution/skillBundle.js";
import {
  readEvolutionStudioCandidateDetail,
  readEvolutionStudioOverview,
  type EvolutionStudioCandidateDetail,
  type EvolutionStudioOverview,
} from "../evolution/studioProjection.js";
import { ValidationStore } from "../validations/ValidationStore.js";
import { ProbeService } from "../probe/ProbeService.js";
import { ProbeStore } from "../probe/ProbeStore.js";
import { claudeAdapter } from "../probe/adapters/claude.js";
import { codexAdapter } from "../probe/adapters/codex.js";
import { buildProbeView, type ProbeView } from "../probe/probeView.js";
import { ContinuityStore } from "../continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../handoff/ProjectHandoffStore.js";
import { ContinuityState } from "../continuity/ContinuityState.js";
import { classifyInjection, injectionText, type Transition } from "../continuity/classifier.js";
import { gcOrphanAgentFootprints } from "../continuity/orphanGc.js";
import { agentLogId } from "../activity/logStore.js";
import { compactSessionOwnerRows, compactSpawnSettings, latestOwnerFor, persistenceHookFailureFile, readPersistenceHookFailures, readSessionOwners, sessionOwnersFile } from "../activity/sessionOwners.js";
import { forgetAgent as forgetAgentFootprint } from "../agents/forgetAgent.js";
import { writePrivateFileAtomic } from "../agents/derivedFile.js";
import {
  HeadlessTerminalPresentation,
  type TerminalPresentation,
} from "./TerminalPresentation.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { validateForm, blockingErrors, toEntry } from "../webview/formLogic.js";
import type { StudioSubmit, StudioDeps } from "../webview/studioSubmit.js";
import type { EngineHost, HostDisposable, ViewKind } from "./EngineHost.js";
import type { NoticeDeliveryResult, NotifyLevel } from "../bridge/tools.js";
import { resolveOpencodeStorageSession } from "./opencodeStorage.js";
import { GitDeliveryStore } from "../git-delivery/store.js";
import { DeliveryStore } from "../delivery/store.js";
import { DeliveryLeaseService, waitForDeliveryLease, type DeliveryRecoveryApproval, type DeliveryRecoveryInspection } from "../delivery/leaseService.js";
import { UnavailableProcessFence } from "../agents/processFence.js";
import { readOwnApprovalRequest } from "../bridge/approvalRequest.js";
import { DeliveryVerificationLeaseService } from "../delivery/verificationLease.js";
import { DeliveryProjectionService } from "../delivery/projectionService.js";
import { LegacyDeliveryRetirement } from "../delivery/retireLegacyState.js";
import type { CanonicalDeliverySpawnReceipt, DeliveryActor } from "../delivery/types.js";
import {
  readLinuxProcessIdentity,
  reconcileDeliveryReload,
  type LinkedGitProjection,
  type ObservedProcess,
  type ReloadReconciliationSnapshot,
} from "../delivery/reloadReconciliation.js";
import { resolveGitDeliverySettings } from "../git-delivery/settings.js";
import { createGitExec, type GitExec } from "../worktree/WorktreeManager.js";
import { resolveGitBinaryForHost } from "../worktree/gitBinary.js";
import type { GitDelivery } from "../git-delivery/types.js";
import { hasDeliveryMarker, isInvalidDeliveryMarker, isValidDeliveryBinding, sameDeliveryBinding } from "../resume/SessionLedger.js";
import { TaskNotificationService } from "./TaskNotificationService.js";
import { BridgeSlowRequestToastPolicy } from "./bridgeSlowRequestPolicy.js";
import { ExternalToolRegistry } from "../externalTools/registry.js";
import { hostActionTouchesHostUi } from "../externalTools/filters.js";
import type { ClaudeStatusLineCaptureTransport } from "../runtimeObservability/claudeStatusLineCapture.js";

const ATTENTION_POLL_MS = 3000;

/**
 * spec 214 — internal label a verify run uses with the runbook executor. MUST be tmux-safe:
 * a `:` is tmux's session:window target separator, so the label can NOT contain one (review
 * fix: `verify:<agent>` broke new-session). The leading `_` is also NAME_RE-impossible (names
 * must start with a letter), so it can never collide with a user-declared runbook/command name
 * (round-2 review fix: `verify-<agent>` could clash with a runbook literally named that).
 */
const VERIFY_LABEL_PREFIX = "_verify-";
const verifyLabel = (agent: string): string => `${VERIFY_LABEL_PREFIX}${agent}`;

/** spec 230/231 — the pipeline-node completion guidance now lives in `nodePrompt.ts` (`assembleNodePrompt`),
 *  which owns the byte-identical guidance literal + the run-input/upstream sections. */

/** Which sidebar surface a Workspace event touches. */
export type { ViewKind } from "./EngineHost.js";

export type PersistenceHookHealth =
  | { state: "active"; updatedAt: string }
  | { state: "skipped"; reason: string; updatedAt?: string }
  | { state: "failed"; reason: string; script: string; path: string; updatedAt: string }
  | { state: "unknown"; reason: string };

function failureIsCurrent(failureTs: string, injectionTs: string): boolean {
  const failureMs = Date.parse(failureTs);
  const injectionMs = Date.parse(injectionTs);
  if (!Number.isFinite(failureMs)) return true;
  if (!Number.isFinite(injectionMs)) return true;
  return failureMs > injectionMs;
}

function parseAuthorityHeads(raw: string | undefined): Map<string, AuthorityHead> {
  if (raw === undefined || raw.length === 0) return new Map();
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`authority freshness heads are corrupt: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authority freshness heads must be an object");
  const heads = new Map<string, AuthorityHead>();
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`authority head '${key}' is malformed`);
    const revision = (candidate as Record<string, unknown>).revision;
    const mac = (candidate as Record<string, unknown>).mac;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1 || typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) {
      throw new Error(`authority head '${key}' is malformed`);
    }
    heads.set(key, { revision: revision as number, mac });
  }
  return heads;
}

function serializeAuthorityHeads(heads: Map<string, AuthorityHead>): string {
  return JSON.stringify(Object.fromEntries([...heads.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * A gated launch is deliberately persisted with an invalid Delivery marker until its
 * authority is durable. Canonical Delivery creation resolves the exact binding while
 * that marker is still present; the AgentManager then removes the marker with one
 * ledger.record call. Promote the staged binding in that same write so no crash window
 * can leave a restartable, unbound row between those two lifecycle phases.
 */
class CanonicalSessionLedger extends SessionLedger {
  private readonly stagedBindings = new Map<string, SessionDeliveryBinding>();

  stageCanonicalBinding(name: string, binding: SessionDeliveryBinding): void {
    if (!isValidDeliveryBinding(binding)) {
      throw new Error(`cannot stage canonical Delivery for '${name}': binding is invalid`);
    }
    const current = this.get(name);
    if (!isInvalidDeliveryMarker(current?.delivery)) {
      throw new Error(`cannot stage canonical Delivery for '${name}': pending lifecycle marker is missing`);
    }
    const staged = this.stagedBindings.get(name);
    if (staged) {
      if (sameDeliveryBinding(staged, binding)) return;
      throw new Error(`cannot stage canonical Delivery for '${name}': staged binding differs`);
    }
    this.stagedBindings.set(name, { ...binding });
  }

  override record(name: string, rec: Omit<SessionRecord, "updatedAt"> & { updatedAt?: string }): void {
    const staged = this.stagedBindings.get(name);
    const current = staged ? this.get(name) : undefined;
    if (staged && rec.delivery === undefined && isInvalidDeliveryMarker(current?.delivery)) {
      // The pending-marker removal and canonical reverse binding are one durable sessions.json write.
      super.record(name, { ...rec, delivery: staged });
      this.stagedBindings.delete(name);
      return;
    }
    super.record(name, rec);
  }

  override remove(name: string): void {
    super.remove(name);
    if (!this.get(name)) this.stagedBindings.delete(name);
  }
}

export interface WorkspaceDeps {
  /** spec 233 — the host port the engine calls instead of `vscode` (the VS Code shell passes a VsCodeHost). */
  host: EngineHost;
  /** refresh the (global) sidebar providers + the attention badge */
  onViewsChanged: (view: ViewKind) => void;
  /** host-side UI affordance for newly recorded human-approval requests. */
  onApprovalRequested?: (ws: Workspace, request: { id: string; requester: string }) => void;
  /** Optional extension-global Claude quota transport. It remains inert unless machine-local consent enables it. */
  claudeStatusLineCapture?: Pick<ClaudeStatusLineCaptureTransport, "materialize">;
  /** spec 399 — immutable staged Pi Bridge extension shipped beside the persistent engine daemon. */
  piBridgeExtensionPath?: string;
}

/** spec 235 — the slice of the control-mode engine the Workspace lifecycle needs; a test passes a no-op. */
export interface WorkspaceEngine {
  start(): Promise<void>;
  dispose(): void | Promise<void>;
}

/** spec 235 — test-only injected substrate (production omits ALL of these via the normal `create`). */
export interface WorkspaceSeams {
  /** a fake-exec `TmuxService` — when set, the control-mode engine is NOT wired (polling lifecycle via tick()). */
  tmux?: TmuxService;
  /** a no-op engine for tests (defaults to a no-op when `tmux` is injected). */
  engine?: WorkspaceEngine;
  /** skip `bridge.start()` (no port bound) — default true in production. */
  startBridge?: boolean;
  /** test-only presentation override; production obtains the adapter from EngineHost. */
  terminals?: TerminalPresentation;
}

export interface BridgeStartFailureInfo {
  code: string;
  message: string;
  technicalDetail: string;
}

const NOOP_ENGINE: WorkspaceEngine = { start: async () => {}, dispose: () => {} };
const TASK_FILE_REFRESH_DEBOUNCE_MS = 75;
const MAX_BRIDGE_FAILURE_DETAIL_LENGTH = 2_000;

/** spec 233 — the i18n function shape (vscode.l10n.t-compatible), passed into module helpers. */
type Translate = (message: string, ...args: (string | number | boolean)[]) => string;

const warnedPatterns = new Set<string>();

/** Best-effort file read for the verify-stack framework hints (composer/Gemfile); undefined on any failure. */
function safeRead(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * t-7faea9 — gated preparation often wraps the real cause in AggregateError after intentional
 * recovery preservation (`rollbackCreated` always throws). Bridge clients only see `.message`,
 * so the primary error text must be in the AggregateError message, not only in `.errors[0]`.
 */
function gatedPreparationAggregateError(
  name: string,
  primary: unknown,
  recoveryTail: string,
  extras: unknown[] = [],
): AggregateError {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const extraErrors = extras.map((item) => (item instanceof Error ? item : new Error(String(item))));
  return new AggregateError(
    [primaryError, ...extraErrors],
    `gated delegation '${name}' preparation failed: ${primaryError.message}; ${recoveryTail}`,
    { cause: primaryError },
  );
}

function boundedBridgeFailureDetail(detail: string): string {
  if (detail.length <= MAX_BRIDGE_FAILURE_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_BRIDGE_FAILURE_DETAIL_LENGTH - 1)}…`;
}

function safePatterns(sources: string[], t: Translate, warn: (message: string, level?: NotifyLevel) => void): RegExp[] {
  const good: RegExp[] = [];
  for (const src of sources) {
    try {
      good.push(...compileExtraPatterns([src]));
    } catch {
      if (!warnedPatterns.has(src)) {
        warnedPatterns.add(src);
        warn(t("invalid attention pattern ignored: {0}", src), "warn");
      }
    }
  }
  return good;
}

const issueMessage = (issue: { code: string; param?: string }, t: Translate): string => {
  switch (issue.code) {
    case "name-invalid":
      return t("name: letters/digits/_/-, starting with a letter");
    case "name-taken":
      return t("name '{0}' already exists", issue.param ?? "");
    case "cmd-required":
      return t("command: required");
    case "steps-required":
      return t("steps: at least one step is required");
    case "instructions-not-deliverable":
      return t("note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered");
    case "soul-invalid":
      return t("soul: choose enabled or disabled, then try again");
    case "soul-runtime-unsupported":
      return t("soul: {0} cannot receive a Tachyon-managed soul — use a supported direct agent command or disable soul", issue.param ?? "this runtime");
    case "harness-claude-only":
      return t("isolated harness: supported for Claude, Codex, OpenCode, Grok, and Hermes agents only");
    case "codex-harness-mcp-only":
      return t("isolated harness: Codex does not support rules; use instruction files instead");
    case "harness-home-config-only":
      return t(
        "isolated harness: {0} supports MCP / skills / hooks only (no rules or instruction files)",
        issue.param ?? "this runtime",
      );
    case "harness-empty":
      return t("isolated harness: declare at least one of MCP / rules / skills / hooks");
    case "harness-mcp-invalid":
      return t("isolated harness: MCP servers must be a valid YAML mapping");
    case "harness-hooks-invalid":
      return t("isolated harness: hooks must be a valid YAML mapping");
    default:
      return issue.code;
  }
};

/**
 * Everything Tachyon runs FOR ONE FOLDER — config, agents, monitors, runners,
 * Bridge, engine, pins, watchers. The extension holds a registry of these
 * (multi-root, F9); the isolation underneath (tmux namespace, token, derived
 * port, .tachyon/ files) was always per-folder via wsHash, so this class is
 * the organizational seam, not new isolation.
 */
export class Workspace {
  readonly gitExec: GitExec;
  readonly wsHash: string;
  readonly tmux: TmuxService;
  readonly terminals: TerminalPresentation;
  readonly manager: AgentManager;
  readonly ledger: SessionLedger;
  private readonly canonicalLedger: CanonicalSessionLedger;
  readonly worktrees: WorktreeManager;
  /** spec 392 — product registry + change worktrees over WorktreeManager. */
  readonly managedWorktrees: ManagedWorktreeService;
  readonly gitDeliveries: GitDeliveryStore;
  readonly deliveries: DeliveryStore;
  readonly deliveryProjection: DeliveryProjectionService;
  readonly deliveryLease: DeliveryLeaseService;
  readonly deliveryVerification: DeliveryVerificationLeaseService;
  readonly legacyDeliveryRetirement: LegacyDeliveryRetirement;
  /** spec 257 — the captured headless A2A probe lane (probe_agent / read_probe_result). */
  readonly probeService: ProbeService;
  private readonly probeStore: ProbeStore;
  /** spec 226/298 — materializes per-agent isolated harness config homes. */
  readonly harness: HarnessManager;
  /** spec 230 — the one-shot agent pipeline executor + its run-state ledger. */
  readonly pipelines: PipelineManager;
  private readonly runLedger: RunLedger;
  /** spec 230 — agentName → the RUN worktree to spawn it into (the resolveSpawnCwd override). */
  private readonly pipelineNodeCwd = new Map<string, { cwd: string; worktree: WorktreeRecord }>();
  /** spec 230 — node agentName → its {runId, nodeId} (lifecycle wiring). */
  private readonly pipelineNodeOf = new Map<string, { runId: string; nodeId: string }>();
  /** spec 230 — run worktree key → its record (for release). */
  private readonly pipelineRunWt = new Map<string, WorktreeRecord>();
  /** Dead agents with a resumable session that we did NOT auto-resume — offered to the human (spec 209). */
  private resumable: ResumePlanItem[] = [];
  /**
   * SDD 368 T14/R4 — explicit reload snapshot readiness.
   * Construction attempts one bounded reload before the Workspace is returned;
   * external callers must never observe `uninitialized`. Non-ready phases
   * (failed, and the internal uninitialized default before that attempt)
   * deny every generic lifecycle action. Explicit deliveryJoin remains allowed.
   */
  private deliveryReload:
    | { phase: "uninitialized" }
    | { phase: "ready"; snapshot: ReloadReconciliationSnapshot }
    | { phase: "failed"; reason: string } = { phase: "uninitialized" };
  /** Suppresses the duplicate factory/start warning for one unchanged quarantine set. */
  private deliveryAuthorityQuarantineNoticeKey?: string;
  readonly monitor: AttentionMonitor;
  private readonly adhocBackstop: AdhocBackstopMonitor;
  /** t-875700 — host-fallback for gated omit-doorbell. */
  private readonly gatedCompletion: GatedCompletionMonitor;
  /** t-9552f3 — session-local completion doorbell latch (in-memory). */
  private readonly completionHints = new CompletionHintStore();
  /** spec 216 — agents whose CLI just compacted; a re-anchor is consumed on their next idle. */
  private pendingAnchor = new Set<string>();
  /** t-71ec3b — per-agent delayed retry for real runtime rate-limit reset screens. */
  private readonly rateLimitRetries = new Map<string, { timer: NodeJS.Timeout; episodeKey: string; attempt: number }>();
  /** spec 332 (dueto F3) — agents whose death was JUST caused by a deliberate kill/dismiss (onKilled);
   *  consumed (deleted) by the next observed death edge so that cancellation never masquerades as a
   *  completion poke to the parent. Self-cleans on the edge it's marked for. */
  private readonly expectedDeath = new Set<string>();
  /** t-572cef — current live incarnation per agent name plus monotonic per-name counters. Child pokes queued
   *  for a parent carry the source child's incarnation captured at enqueue time; flush drops them if the
   *  child is gone or the same name now refers to a later session. */
  private readonly agentIncarnations = new Map<string, number>();
  private readonly agentIncarnationCounters = new Map<string, number>();
  private readonly noticeQueue = new NoticeQueue();
  readonly waiters: Waiters;
  readonly lifecycle: LifecycleMonitor;
  readonly pinStore: PinStore;
  readonly taskStore: TaskStore;
  readonly evolutionStore: EvolutionStore;
  private readonly evolutionCoordinator: EvolutionCoordinator;
  private readonly taskNotifications: TaskNotificationService;
  readonly validationStore: ValidationStore;
  readonly continuityStore: ContinuityStore;
  readonly handoffStore: ProjectHandoffStore;
  readonly continuityState: ContinuityState;
  readonly commandRunner: CommandRunner;
  readonly runbookRunner: RunbookRunner;
  readonly scheduler: Scheduler;
  readonly proposals: ProposalStore;
  readonly bridge: Bridge;
  /** SDD 414 — Tachyon Companion pairing (loopback /companion/v1 on the Bridge listener). */
  readonly companion: CompanionPairingService;
  /** SDD 414 — companion SSE live state fan-out. */
  readonly companionLive: CompanionLiveSync;
  /** SDD 414 — agent ↔ extension tab command channel. */
  readonly companionTab: CompanionTabChannel;
  /** SDD 420 — last snapshot @e metadata for safety gates. */
  readonly companionTabRefs = new TabRefCache();
  readonly externalTools: ExternalToolRegistry;
  readonly token: string | undefined;
  readonly externalToken: string | undefined;
  readonly authEnabled: boolean;
  /** spec 351 — this Bridge's own id, PERSISTED per workspace (generated once, reused across reloads —
   *  see T6 resume-env proof) so a tmux session surviving an extension-host reload keeps resolving its
   *  pre-reload token instead of being silently stranded. Distinct from `wsHash` in shape (a future
   *  multi-instance-per-workspace scenario could still differ), but stable in practice today. */
  readonly bridgeInstanceId: string;
  /** spec 351 — settings.legacyBridgeAuth (default true): whether the shared token may still resolve as a
   *  caller (kind "legacy") at all. */
  readonly legacyBridgeAuthEnabled: boolean;
  /** spec 351 — the digest-only per-agent token registry; undefined until the HMAC key is loaded (async,
   *  set at the tail of `_create` before the Bridge/any agent could actually use it). */
  private callerRegistry: CallerIdentityRegistry | undefined;
  /** SecretStorage key, domain-separated from caller digests for durable authority seals. */
  private authorityIntegrityKey: Buffer | undefined;
  /** SecretStorage-backed exact MAC heads; kept outside agent-writable workspace metadata. */
  private authorityHeads = new Map<string, AuthorityHead>();
  /** Serializes the async SecretStorage read/prepare/readback sequence inside this extension host. */
  private authorityHeadPrepareTail: Promise<void> = Promise.resolve();
  private readonly reloadTransactions: ReloadTransactionStore;
  private readonly hostActionAuditPath: string;
  private readonly hostActionSessionEpoch: number;
  /** spec 364 — host-driven Bridge-client rebind after generation bump (constructed after AgentManager). */
  private clientRebind: BridgeClientRebindCoordinator | undefined;
  private readonly bridgeClientRebindAuditPath: string;
  config: TachyonConfig | undefined;
  /**
   * t-8354ae — set whenever the working-tree config fails to load. Survives until the next
   * successful reloadConfig(). Drives the persistent sidebar error banner + degraded roster.
   * Undefined when the config is valid (or no config file exists yet).
   */
  configFailure: ConfigFailure | undefined;

  private readonly engine: WorkspaceEngine;
  private watches: WatchController;
  private readonly disposables: HostDisposable[] = [];
  private lifecycleTrigger: NodeJS.Timeout | undefined;
  private taskFileRefreshTimer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private engineWarned = false;
  private readonly bridgeSlowRequestToasts = new BridgeSlowRequestToastPolicy();
  private lastBridgeStartFailure: BridgeStartFailureInfo | undefined;
  /** t-4ecf9a — latest control-mode #{window_activity} map (session → unix seconds); live only while engine is up. */
  private activityBySession = new Map<string, number>();
  private activityFeedLive = false;

  /** spec 233 — the host port; the engine calls this instead of `vscode`. */
  private get host(): EngineHost {
    return this.deps.host;
  }
  /** spec 233 — i18n via the host (same shape as vscode.l10n.t). Arrow field so it can be passed by
   *  reference into module helpers (issueMessage / safePatterns) keeping its `this` binding. */
  private readonly t = (message: string, ...args: (string | number | boolean)[]): string => this.deps.host.t(message, ...args);

  private constructor(
    readonly workspaceRoot: string,
    private readonly deps: WorkspaceDeps,
    seams: WorkspaceSeams = {},
  ) {
    this.wsHash = workspaceHash(workspaceRoot);
    this.gitExec = createGitExec(() => resolveGitBinaryForHost(deps.host));
    this.taskNotifications = new TaskNotificationService(workspaceRoot, deps.host, () => this.config);
    if (seams.tmux) {
      // spec 235 — test mode: a fake-exec tmux is supplied; the control-mode engine is NOT wired (lifecycle
      // is polling-only via tick()). A no-op engine keeps start()/dispose() coherent.
      this.tmux = seams.tmux;
      this.engine = seams.engine ?? NOOP_ENGINE;
    } else {
      this.tmux = new TmuxService();
      // F20 engine: persistent control-mode client — command channel (zero
      // subprocess churn) + event-driven lifecycle; subprocess fallback when down.
      const engine = new ControlModeClient({
        wsHash: this.wsHash,
        onDeadMapChanged: () => this.triggerLifecycle(),
        onActivityMapChanged: (map) => {
          this.activityBySession = map;
          this.activityFeedLive = true;
        },
        onSessionsChanged: () => this.triggerLifecycle(),
        onStateChange: (isUp) => {
          if (!isUp) {
            // t-4ecf9a — same structural fallback as dead-map: drop the push feed so AttentionMonitor polls.
            this.activityFeedLive = false;
            this.activityBySession = new Map();
            if (!this.engineWarned) {
              this.engineWarned = true;
              console.warn(`Tachyon[${this.folderName}]: control-mode engine down — subprocess fallback (reconnecting)`);
            }
          } else {
            this.engineWarned = false;
          }
        },
      });
      this.engine = engine;
      this.tmux.useExecutor(engine.makeExecutor());
    }
    const terminalOptions = {
      onReveal: (_agent: string, session: string) => void this.tmux.refreshClients(session),
      kindOf: (agent: string) => this.manager.kindOf(agent),
      manifest: {
        read: () => deps.host.getState(this.terminalManifestStateKey()),
        write: (entries: import("./TerminalPresentation.js").TerminalRestoreEntry[]) => deps.host.setState(this.terminalManifestStateKey(), entries),
      },
    };
    this.terminals = seams.terminals
      ?? deps.host.createTerminalPresentation?.(terminalOptions)
      ?? new HeadlessTerminalPresentation();

    // Auth: stable per-workspace token (extension storage — never in a committable file).
    const earlyFile = this.configPath();
    const earlyConfig = earlyFile ? loadConfigFile(earlyFile).config : undefined;
    this.authEnabled = earlyConfig?.settings.auth ?? true;
    this.token = this.authEnabled ? loadOrCreateToken(deps.host.globalStoragePath(), this.wsHash) : undefined;
    this.externalToken = this.token ? loadOrCreateExternalToken(deps.host.globalStoragePath(), this.wsHash, this.token) : undefined;
    // spec 351 T6 — PERSISTED, not fresh-per-activation: a tmux session surviving an extension-host
    // reload (Tachyon's core "sessions outlive the editor" promise) must keep resolving under the SAME
    // scope after reload, or every surviving agent gets silently stranded on a dead token. Generated once
    // per workspace and reused forever after (see also: the digest registry reload below).
    const instanceIdKey = this.bridgeInstanceIdStateKey();
    this.bridgeInstanceId = deps.host.getState<string>(instanceIdKey) ?? randomBytes(8).toString("hex");
    deps.host.setState(instanceIdKey, this.bridgeInstanceId);
    this.legacyBridgeAuthEnabled = earlyConfig?.settings.legacyBridgeAuth ?? true;
    const hostActionRoot = path.join(deps.host.globalStoragePath(), "host-actions");
    this.reloadTransactions = new ReloadTransactionStore(path.join(hostActionRoot, "reload-pending.json"));
    this.hostActionAuditPath = path.join(hostActionRoot, "audit.jsonl");
    // spec 364 — sibling of host-actions under globalStorage
    this.bridgeClientRebindAuditPath = path.join(deps.host.globalStoragePath(), "bridge-client-rebind", "audit.jsonl");
    const epochKey = this.hostActionSessionEpochStateKey();
    this.hostActionSessionEpoch = (deps.host.getState<number>(epochKey) ?? 0) + 1;
    deps.host.setState(epochKey, this.hostActionSessionEpoch);

    this.canonicalLedger = new CanonicalSessionLedger(workspaceRoot);
    this.ledger = this.canonicalLedger;
    this.legacyDeliveryRetirement = new LegacyDeliveryRetirement(workspaceRoot);
    this.externalTools = new ExternalToolRegistry(workspaceRoot);
    this.gitDeliveries = new GitDeliveryStore(workspaceRoot);
    this.deliveries = new DeliveryStore(workspaceRoot, {
      authorityIntegrityKey: () => this.authorityIntegrityKey,
      authorityHead: this.canonicalAuthorityHeadPort(),
    });
    this.worktrees = new WorktreeManager({
      workspaceRoot,
      wsHash: this.wsHash,
      getSettings: () => this.config?.settings ?? {},
      git: this.gitExec,
      occupancy: (worktreePath) => this.manager.worktreeOccupant(worktreePath),
    });
    this.managedWorktrees = new ManagedWorktreeService({
      workspaceRoot,
      wsHash: this.wsHash,
      getSettings: () => this.config?.settings ?? {},
      manager: this.worktrees,
      git: this.gitExec,
      occupancy: (worktreePath) => this.manager.worktreeOccupant(worktreePath),
      onRegistryChanged: () => {
        // Best-effort refresh signal (agents view re-syncs worktree reveal on host).
        try { this.host.onViewsChanged("agents"); } catch { /* host optional during early boot */ }
      },
    });
    // SDD 368 T15 — constructed after worktrees so the path lock seam is available.
    this.deliveryProjection = new DeliveryProjectionService({
      deliveries: this.deliveries,
      gitDeliveries: this.gitDeliveries,
      workspaceRoot,
      workspaceId: this.wsHash,
      git: this.gitExec,
      liveness: (agent) => this.gitDeliveryLiveness(agent),
      worktreeOccupancy: (worktreePath) => this.manager.worktreeOccupant(worktreePath),
      // t-2dd637 §4 — the base repair may only widen a pinned SHA to the workspace's own checked-out
      // branch: the exact ref WorktreeManager forks deliveries from, so nothing else can be proposed.
      targetBranch: () => this.workspaceTargetBranch(),
      resolveBaseRepairApproval: (approvalId, actor, actionDigest) => this.resolveTrustedRecoveryApproval(approvalId, actor, actionDigest),
      removeManagedWorktree: (worktreePath, o) =>
        this.managedWorktrees.removePath(worktreePath, {
          deleteBranch: o?.deleteBranch,
          branch: o?.branch,
          tachyonCreatedBranch: o?.tachyonCreatedBranch,
          baseRef: o?.baseRef,
          force: o?.force,
        }),
      withWorktreeLock: (canonicalWorktree, fn) => this.worktrees.withPathLock(canonicalWorktree, fn),
      settings: () => resolveGitDeliverySettings(this.config?.settings),
      loadReloadSnapshot: async (deliveryId) => {
        // Prefer the in-memory T14 snapshot when ready; otherwise recompute one bounded view.
        if (this.deliveryReload.phase === "ready") {
          const snap = this.deliveryReload.snapshot;
          if (snap.byId.has(deliveryId)) return snap;
        }
        return this.refreshDeliveryReloadSnapshot();
      },
    });
    // T14.6B2: the strong fence remains deliberately unavailable until T14.6C.
    // Mechanism-only uses the exact ledger/pane stopper below and never claims descendant absence.
    this.deliveryLease = new DeliveryLeaseService({
      store: this.deliveries,
      processFence: new UnavailableProcessFence(),
      recoveryPrincipals: () => resolveGitDeliverySettings(this.config?.settings).prunePrincipals,
      resolveRecoveryApproval: (approvalId, actor, actionDigest) => this.resolveTrustedRecoveryApproval(approvalId, actor, actionDigest),
      // t-9e57e8 — the free→abandoned disposition substitutes liveness + occupancy evidence for the
      // process fence. Both reuse the existing oracles (no second liveness/occupancy source).
      agentLiveness: (agent) => this.gitDeliveryLiveness(agent),
      worktreeOccupancy: (canonicalWorktree) => this.manager.worktreeOccupant(canonicalWorktree),
      canonicalWorktreeFor: async (delivery) => fs.realpathSync((await this.exactCanonicalProjection(delivery)).worktreePath),
      readHead: async (cwd) => this.requiredGitOutput(["rev-parse", "HEAD"], cwd, "Git HEAD"),
      inspectWorktree: async (cwd) => ({ headSha: await this.requiredGitOutput(["rev-parse", "HEAD"], cwd, "Git HEAD"), clean: await this.requiredGitStatus(cwd) }),
      inspectRecoveryWorktree: (cwd, baseSha) => this.requiredRecoveryInventory(cwd, baseSha),
      inspectReviewWorktree: async (cwd, taskRef) => {
        const headSha = await this.requiredGitOutput(["rev-parse", "HEAD"], cwd, "Git HEAD");
        const taskRefSha = await this.requiredGitOutput(["rev-parse", taskRef], cwd, "Git task ref");
        const indexTreeSha = await this.requiredGitOutput(["write-tree"], cwd, "Git index tree");
        const commitTreeSha = await this.requiredGitOutput(["rev-parse", "HEAD^{tree}"], cwd, "Git commit tree");
        return { headSha, taskRefSha, indexTreeSha, commitTreeSha, trackedClean: await this.requiredGitStatus(cwd) };
      },
      isAncestor: async (older, newer, cwd) => {
        const result = await this.gitExec(["merge-base", "--is-ancestor", older, newer], cwd);
        if (result.code === 0) return true;
        if (result.code === 1) return false;
        throw new Error(`Git ancestry inspection failed (${result.code}): ${result.stderr.trim() || "no diagnostic"}`);
      },
      withWorktreeLock: (cwd, fn) => this.worktrees.withPathLock(cwd, fn),
      processObserver: { observe: (identity) => {
        const observed = readLinuxProcessIdentity(identity.pid);
        if (observed.state === "gone") return { state: "gone" as const };
        if (observed.state !== "exact") return { state: "unknown" as const, reason: observed.reason };
        return observed.processStart === identity.processStart && observed.bootId === identity.bootId ? { state: "alive" as const } : { state: "unknown" as const, reason: "pid identity changed" };
      } },
      exactExecutionStopper: { stop: async (input) => {
        const holder = (await this.deliveries.get(input.deliveryId))?.lease.holder;
        const row = this.ledger.get(input.executionAgent);
        const panePid = await this.tmux.panePid(this.manager.session(input.executionAgent));
        const observed = readLinuxProcessIdentity(input.process.pid);
        if (!holder || holder.segmentId !== input.segmentId || holder.executionNonce !== input.executionNonce
          || holder.executionAgent !== input.executionAgent || !isValidDeliveryBinding(row?.delivery) || row.delivery.deliveryId !== input.deliveryId || row.delivery.segmentId !== input.segmentId || row.delivery.executionNonce !== input.executionNonce
          || !row.cwd || !row.worktree?.path || fs.realpathSync(row.cwd) !== input.canonicalWorktree || fs.realpathSync(row.worktree.path) !== input.canonicalWorktree
          || panePid !== input.process.pid || observed.state !== "exact" || observed.processStart !== input.process.processStart || observed.bootId !== input.process.bootId) {
          throw new Error("DELIVERY_EXACT_STOP_REFUSED: ledger, worktree, or pane identity drifted");
        }
        await this.manager.kill(input.executionAgent);
      } },
      postStopObservation: {
        attempts: 81,
        delayMs: 25,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    const defaultClaudeConfigHome = realConfigHome();
    this.harness = new HarnessManager(workspaceRoot, defaultClaudeConfigHome, undefined, undefined, undefined, (message) => this.host.notify(message, "warn"));
    // spec 226 (H2) — when an agent has an isolated harness, its claude transcripts live under the
    // redirected config home; pass it to the resolvers as `claudeHome` so by-title/by-cwd scans hit it.
    const resolverEnv = (runtime: string, configHome?: string) =>
      configHome ? {
        home: os.homedir(),
        ...(runtime === "claude" ? { claudeHome: configHome } : {}),
        ...(runtime === "codex" ? { codexHome: configHome } : {}),
        ...(runtime === "hermes" ? { hermesHome: configHome } : {}),
        ...(runtime === "pi" ? { piSessionDir: configHome } : {}),
      } : undefined;
    const resolveOpencode = (cwd: string, dataHome?: string, id?: string) => resolveOpencodeStorageSession(cwd, dataHome ?? defaultRealOpencodeDataHome(), id);
    this.manager = new AgentManager({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      // SDD 369 T3 — ordinary Claude sessions inherit this account home. Capture and transcript
      // resolution must use the same value; an unknown external home then fails capture closed.
      defaultClaudeConfigHome,
      ledger: this.ledger,
      resolveEvolutionSnapshot: (principal) => resolveEvolutionStartupSnapshot(
        this.workspaceRoot,
        principal,
        this.evolutionStore,
      ),
      // spec 364 — stamp bound_generation from the live coordinator (0 until first listener-ready bump).
      getBridgeGeneration: () => this.clientRebind?.getGeneration() ?? 0,
      resolveCaptureId: (runtime, cwd, configHome) => runtime === "opencode"
        ? Promise.resolve(resolveOpencode(cwd, configHome)?.id ?? null)
        : resolveCaptureId(runtime, cwd, resolverEnv(runtime, configHome)),
      resolveCaptureSession: (runtime, cwd, configHome, id) => runtime === "opencode"
        ? Promise.resolve(resolveOpencode(cwd, configHome, id))
        : resolveCaptureSession(runtime, cwd, resolverEnv(runtime, configHome), id),
      resolveCurrentSession: (runtime, cwd, title, configHome) => runtime === "opencode"
        ? Promise.resolve(resolveOpencode(cwd, configHome, title)?.id ?? null)
        : resolveCurrentSession(runtime, cwd, resolverEnv(runtime, configHome), title), // A3 + spec 220: claude matches by customTitle
      // spec 226/298 (H3) — materialize an agent's isolated harness and return its runtime config-home
      // env + MCP wiring; null when the agent has no harness / runtime can't.
      materializeHarness: ({ name, def, cwd }) => {
        const adapter = adapterFor(def.cmd);
        // SDD 401/406 — Pi is private-home by default; an opt-in resource harness uses its
        // dedicated exact-resource materializer rather than pretending Pi has generic MCP wiring.
        if (adapter?.runtime === "pi" && def.isolate === undefined) {
          return def.harness
            ? this.harness.materializePiHome(name, def.harness)
            : this.harness.materializePiHomeOnly(name);
        }
        if (!harnessable(adapter) || !adapter) return null;
        // spec 236 — a harness agent runs with --strict-mcp-config (ignores project/global MCP), so the
        // Bridge MUST be folded into the materialized file or it can't reach complete_node/write_input.
        if (def.harness) return this.harness.materialize(name, def.harness, adapter, cwd, this.bridgeEntry());
        // spec 240 — `isolate: transcript`: private home ONLY (own transcript namespace), no MCP isolation,
        // so the agent still loads the workspace project config (incl. the project .mcp.json).
        if (def.isolate === "transcript") return this.harness.materializeHomeOnly(name, adapter, cwd);
        // spec 357 - codex defaults to a lifetime-scoped private CODEX_HOME so same-cwd agents cannot
        // bind to each other's rollout transcripts.
        if (adapter.runtime === "codex") return this.harness.materializeHomeOnly(name, adapter, cwd);
        return null;
      },
      // spec 236 — write a NON-harness claude agent's Bridge-only --mcp-config file and return its path
      // (appended additively at spawn). undefined when the Bridge isn't up (self-heals on next restart).
      materializeBridgeMcp: (name) => {
        const entry = this.bridgeEntry();
        return entry ? this.harness.materializeBridgeMcp(name, entry) : undefined;
      },
      // spec 236 — write a NON-harness opencode agent's Bridge-only opencode config file and return its
      // path (injected into the spawn env as OPENCODE_CONFIG so opencode loads it instead of the cwd-
      // discovered opencode.json). Folds the agent's cwd's project opencode.json in (additive) so the
      // user's other keys/servers ride alongside `mcp.tachyon_bridge`. undefined when the Bridge isn't
      // up (self-heals on next restart). cwd is the EFFECTIVE spawn cwd (worktree or workspace root).
      materializeBridgeMcpOpencode: (name, cwd) => {
        const entry = this.bridgeEntryOpencode();
        if (!entry) return undefined;
        const projectOpencodeJson = safeRead(path.join(cwd, "opencode.json"));
        return this.harness.materializeBridgeMcpOpencode(name, entry, projectOpencodeJson);
      },
      // t-843576 — materialize a NON-harness grok agent's private GROK_HOME (Bridge MCP in config.toml +
      // auth.json symlink) and return its path (injected into the spawn env as GROK_HOME). cwd is the
      // effective spawn cwd so folder-trust is seeded for the workspace/worktree before the TUI starts.
      // undefined when the Bridge isn't up (self-heals on next restart). Never mutates the user's real ~/.grok.
      materializeBridgeMcpGrok: (name, cwd) => {
        const entry = this.bridgeEntry();
        return entry ? this.harness.materializeBridgeMcpGrok(name, entry, cwd ?? this.workspaceRoot) : undefined;
      },
      // Private HERMES_HOME for non-harness hermes (Bridge MCP in config.yaml + auth.json symlink).
      materializeBridgeMcpHermes: (name) => {
        const entry = this.bridgeEntry();
        return entry ? this.harness.materializeBridgeMcpHermes(name, entry) : undefined;
      },
      piBridgeExtensionPath: () => {
        const file = this.deps.piBridgeExtensionPath;
        if (!file) return undefined;
        try { return fs.statSync(file).isFile() ? file : undefined; }
        catch { return undefined; }
      },
      materializePiSessionDir: (name) => materializePiSessionDir(this.workspaceRoot, name),
      // spec 243 — per-spawn --settings SessionStart ownership hook (claude); the resolver reads the ledger
      // it writes so Activity follows a /clear/resume rotation even on a shared cwd.
      materializeOwnershipSettings: (name, opts) => this.harness.materializeOwnershipSettings(
        name,
        opts?.ownershipOnly ? undefined : this.handoffStore.canonicalPath,
        {
          silentPersistence: !opts?.ownershipOnly && this.silentPersistenceHooksDesired(name),
          skipDangerousModePermissionPrompt: !!opts?.ownershipOnly,
          statusLine: opts?.statusLineCapture === false
            ? undefined
            : this.deps.claudeStatusLineCapture?.materialize({
              workspaceRoot: this.workspaceRoot,
              agent: name,
              cwd: opts?.cwd ?? this.workspaceRoot,
              configHome: opts?.configHome,
            }),
        },
      ), // spec 245/312
      materializeCodexSessionStartHookConfig: (name, opts) => this.harness.materializeCodexSessionStartHookConfig(
        name,
        opts?.ownershipOnly ? undefined : this.handoffStore.canonicalPath,
        { silentPersistence: !opts?.ownershipOnly && this.silentPersistenceHooksDesired(name) },
      ), // spec 303/312
      onSessionHooksInjected: (name, injected) => {
        const active = injected && this.silentPersistenceHooksDesired(name);
        if (active) this.silentPersistenceHookAgents.add(name);
        else this.silentPersistenceHookAgents.delete(name);
        this.writeSilentPersistenceHookState(name, active);
      },
      ownedSession: (name, cwd) => {
        const row = latestOwnerFor(readSessionOwners(sessionOwnersFile(this.workspaceRoot)), name, cwd);
        return row ? { sessionId: row.sessionId, transcriptPath: row.transcriptPath } : undefined;
      },
      notify: (message, level) => this.host.notify(message, level),
      // SDD 368 T14/R3 — fail-closed until a complete snapshot is ready; then consult deny set.
      isDeliveryLifecycleDenied: (name) => {
        if (this.deliveryReload.phase !== "ready") return true;
        return this.deliveryReload.snapshot.unavailableAgents.has(name);
      },
      prepareDeliveryJoin: (name, request) => this.prepareDeliveryJoin(name, request),
      confirmDeliveryJoin: (name, request, prepared, pid) => this.confirmDeliveryJoin(name, request, prepared, pid),
      failDeliveryJoin: (_name, request, prepared, error) => this.deliveryLease.failJoin(request.deliveryId, prepared.reservationNonce, error instanceof Error ? error.message : String(error), `${request.operationId}:fail`).then(() => undefined),

      getConfig: () => this.config,
      // t-8354ae — refuse spawn of names that exist only in the LKG snapshot while config is invalid.
      assertSpawnAllowed: (name) => this.assertNotLkgOnlySpawn(name),
      getMaxAgents: () => this.host.getSetting("tachyon", "maxAgents", 8),
      getAgentMemoryMax: () => {
        const host = this.host.getSetting<string>("tachyon", "agentMemoryMax", "");
        return host.trim() || undefined;
      },
      getExtraEnv: () => {
        // Every Tachyon-spawned session can reach (and authenticate to) ITS folder's Bridge.
        // PATH is pinned too: rebind/resume after reload can land panes on a tmux global PATH
        // without nvm → `codex: command not found` exit 127 (dogfood 2026-07-09).
        const env: Record<string, string> = { PATH: agentLaunchPath() };
        if (this.bridge.url) env[URL_ENV_VAR] = this.bridge.url;
        if (this.token) env[TOKEN_ENV_VAR] = this.token;
        return env;
      },
      // spec 351 — a fresh per-agent token at spawn/restart/resume; `{}` until the HMAC key has loaded
      // (a short transient window at extension activation — a spawn in it just gets no per-agent token,
      // same self-healing shape as the Bridge URL/token above before the Bridge itself has bound a port).
      mintAgentToken: (name): Record<string, string> => {
        if (!this.callerRegistry) return {};
        const token = this.callerRegistry.mint(name, this.callerScope());
        this.persistCallerRegistry();
        return { [AGENT_TOKEN_ENV_VAR]: token };
      },
      revokeAgentToken: (name) => {
        this.callerRegistry?.revoke(name, this.callerScope());
        this.persistCallerRegistry();
      },
      onSpawned: (name, reveal) => {
        // F3: a Bridge-spawned child passes reveal=false so it doesn't yank the human's
        // editor focus off the parent. It still appears in the tree (nested) — the human
        // opens it on demand. Human ▶ / autostart / resume / restart reveal as before.
        if (reveal) this.terminals.open(name, this.manager.session(name));
        // spec 216 (codex r1 M2): a fresh session (spawn/restart/resume) clears any stale
        // re-anchor flag — else a compaction detected before a kill could inject into a brand-new
        // same-name session that never compacted.
        this.pendingAnchor.delete(name);
        this.recordSpawnIncarnation(name);
        this.clientRebind?.onNewIncarnation(name);
        this.noticeQueue.clear(name);
        this.adhocBackstop.reset(name);
        this.completionHints.clear(name);
        this.refreshAgentsViews();
      },
      onStopping: (name) => {
        // Grok replaces auth.json symlink with a regular file on token refresh — harvest before teardown.
        this.reconcileGrokAuthIfGrokAgent(name);
        this.refreshAgentsViews();
      },
      onKilled: async (name) => {
        await this.deliveryLease.quarantineKilledExecution(name);
        this.reconcileGrokAuthIfGrokAgent(name);
        this.terminals.close(name);
        this.pendingAnchor.delete(name); // spec 216: don't carry a re-anchor flag past the session
        this.agentIncarnations.delete(name);
        this.noticeQueue.clear(name);
        this.adhocBackstop.reset(name);
        this.completionHints.clear(name);
        this.expectedDeath.add(name); // spec 332 (dueto F3): kill_agent/dismiss_agent/killAll — a deliberate
        // termination, never a completion signal; consumed by the next observed death edge.
        // spec 364 — user stop while suspect/queued cancels rebind (never resume).
        this.clientRebind?.onAgentStopped(name);
        // spec 230 — a pipeline node's session ended → tell the executor (a signal node that dies
        // without complete_node fails closed; the per-node timeout is the backstop for a silent hang).
        const node = this.pipelineNodeOf.get(name);
        if (node) this.pipelines.onSessionEnd(node.runId, node.nodeId);
        this.refreshAgentsViews();
      },
      // Restart kill+new fallback only (t-4d2630): close the old terminal now (sync) so
      // post-spawn onSpawned re-opens a fresh attach. Happy-path respawn-pane keeps clients
      // attached — AgentManager skips onRestart then; onSpawned still reveals the live tab.
      onRestart: (name) => {
        this.terminals.close(name);
        this.adhocBackstop.reset(name);
        this.completionHints.clear(name);
      },
      // spec 210 — worktree isolation: resolve the cwd a session is born in.
      // spec 230 — a pipeline node spawns into its RUN's worktree (registered just before spawnNode);
      // this overrides the per-agent worktree path so the chain shares one checkout.
      resolveSpawnCwd: async (ctx) => {
        if (ctx.gate) {
          const gateError = behaviorTestError(ctx.gate.behaviorTest);
          if (gateError) throw new Error(`gated delegation behavior_test ${gateError}`);
          for (const [index, ownedPath] of (ctx.gate.owns ?? []).entries()) {
            if (containsUnsafeFramingCharacter(ownedPath)) {
              throw new Error(`gated delegation owns[${index}] must not contain control characters`);
            }
          }
        }
        const explicitBehaviorCommand = ctx.gate?.behaviorTest.match(/^cmd:\s*(.*)$/s);
        if (explicitBehaviorCommand) {
          try {
            parseArgvCommand(explicitBehaviorCommand[1] ?? "");
          } catch (error) {
            throw new Error(
              `gated delegation behavior_test has an invalid cmd: verifier: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const namedBehaviorSettings = ctx.gate && !explicitBehaviorCommand
          ? ctx.verifySettings?.behavior
          : undefined;
        if (ctx.gate && !explicitBehaviorCommand && !namedBehaviorSettings) {
          throw new Error(
            "plain gated delegation behavior_test requires the project to configure " +
              "settings.verify.behavior; otherwise use an explicit cmd:<command> verifier",
          );
        }
        const pl = this.pipelineNodeCwd.get(ctx.name);
        if (pl) return { cwd: pl.cwd, worktree: pl.worktree };
        const forceWorktree = ctx.gate ? true : ctx.def.worktree;
        const resolved = await resolveWorktreeCwd(
          {
            name: ctx.name,
            worktree: forceWorktree,
            branch: ctx.def.branch,
            worktreeSetup: ctx.def.worktreeSetup,
            parent: ctx.gate ? undefined : ctx.parent,
            isRestart: ctx.isRestart,
          },
          {
            manager: this.worktrees,
            settings: this.config?.settings ?? {},
            parentCwd: (p) => {
              const r = this.ledger.get(p);
              return r?.worktree?.path ?? r?.cwd;
            },
            priorRecord: this.ledger.get(ctx.name)?.worktree,
            runSetup: (rec, setup) => this.runWorktreeSetup(rec, setup),
            notify: (m, level) => this.host.notify(m, level ?? "info"),
          },
        );
        if (!resolved?.worktree) return resolved;
        this.managedWorktrees.syncAgentRecord(ctx.name, resolved.worktree, ctx.delegator);
        if (!ctx.gate) {
          let exactPreparedHead: string | undefined;
          try {
            const { headRef } = await this.worktrees.headState(resolved.cwd);
            if (!headRef) throw new Error(`agent '${ctx.name}' could not resolve its prepared worktree HEAD`);
            exactPreparedHead = headRef;
            return {
              ...resolved,
              ...(resolved.rollbackHeadSha ? { preparationHeadBefore: resolved.rollbackHeadSha } : {}),
              preparationHeadAfter: headRef,
            };
          } catch (primary) {
            if (resolved.created && exactPreparedHead) {
              try { await this.worktrees.rollbackCreated(resolved.worktree, resolved.rollbackHeadSha, exactPreparedHead); }
              catch (preservation) {
                throw new AggregateError(
                  [primary, preservation],
                  `agent '${ctx.name}' worktree preparation failed; recovery state was preserved`,
                );
              }
            } else if (resolved.created) {
              throw new AggregateError(
                [primary, new Error("fresh worktree recovery state was preserved because its exact prepared HEAD is unknown")],
                `agent '${ctx.name}' worktree preparation failed without a recovery HEAD observation`,
              );
            }
            if (resolved.rollbackHeadSha) {
              try {
                await this.worktrees.rollbackPreparation(resolved.worktree, resolved.rollbackHeadSha, resolved.rollbackHeadSha);
              } catch (preservation) {
                throw new AggregateError(
                  [primary, preservation],
                  `agent '${ctx.name}' worktree preparation failed; its reused recovery checkout is preserved at ${resolved.worktree.path}`,
                );
              }
            }
            throw new AggregateError(
              [primary, new Error(`reused worktree recovery state was preserved at ${resolved.worktree.path}; its prepared HEAD is unknown`)],
              `agent '${ctx.name}' worktree preparation failed; recovery checkout: ${resolved.worktree.path}`,
            );
          }
        }
        const preparationHeadBefore = resolved.rollbackHeadSha;
        let preparationHeadAfter: string | undefined;
        try {
          const preparedState = await this.worktrees.headState(resolved.cwd);
          if (!preparedState.headRef) throw new Error(`gated delegation '${ctx.name}' could not resolve its prepared worktree HEAD`);
          preparationHeadAfter = preparedState.headRef;
          if (!explicitBehaviorCommand) {
            const { stubPath, oracleHash, executorHashes, headRef } = await resolveCanonicalBehaviorOracle({
              worktreePath: resolved.cwd,
              agent: ctx.name,
              settings: namedBehaviorSettings!,
            });
            preparationHeadAfter = headRef;
            ctx.gate.stubPath = stubPath;
            ctx.gate.oracleHash = oracleHash;
            ctx.gate.executorHashes = executorHashes;
          }
          // A reused gated worktree must anchor to its current HEAD, not the original worktree baseRef.
          // Named adapters bind existing project-owned oracle/executor bytes without mutating the checkout.
          const { headRef } = await this.worktrees.headState(resolved.cwd);
          if (!headRef) throw new Error(`gated delegation '${ctx.name}' could not resolve the task worktree HEAD`);
          preparationHeadAfter = headRef;
          return {
            ...resolved,
            delegationBaseSha: headRef,
            ...(preparationHeadBefore ? { preparationHeadBefore } : {}),
            ...(preparationHeadAfter ? { preparationHeadAfter } : {}),
          };
        } catch (primary) {
          if (resolved.created) {
            if (!preparationHeadAfter) {
              throw gatedPreparationAggregateError(
                ctx.name,
                primary,
                "fresh worktree recovery state was preserved because its exact prepared HEAD is unknown",
                [new Error("fresh gated worktree recovery state was preserved because its exact prepared HEAD is unknown")],
              );
            }
            try {
              await this.worktrees.rollbackCreated(resolved.worktree, resolved.rollbackHeadSha, preparationHeadAfter);
            } catch (preservation) {
              // rollbackCreated intentionally preserves the checkout and always throws (recovery-first).
              throw gatedPreparationAggregateError(
                ctx.name,
                primary,
                "its fresh worktree recovery state was preserved",
                [preservation],
              );
            }
          } else if (preparationHeadBefore && preparationHeadAfter) {
            try {
              await this.worktrees.rollbackPreparation(resolved.worktree, preparationHeadBefore, preparationHeadAfter);
            } catch (preservation) {
              throw gatedPreparationAggregateError(
                ctx.name,
                primary,
                "its reused worktree recovery state was preserved",
                [preservation],
              );
            }
          } else {
            throw gatedPreparationAggregateError(
              ctx.name,
              primary,
              `recovery checkout: ${resolved.worktree.path}`,
              [new Error(`reused gated worktree recovery state was preserved at ${resolved.worktree.path}; complete HEAD observations are unavailable`)],
            );
          }
          throw primary;
        }
      },
      recordCanonicalDelivery: ({ name, delegator, gate, worktree, baseSha, verifySettings }) =>
        this.recordCanonicalDelivery({ name, delegator, gate, worktree, baseSha, verifySettings }),
      // spec 225 — fork: probe the source worktree for the dirty warning, and create the fork's own
      // worktree branched off the source's committed HEAD (its branch).
      worktreeDirty: (rec) => isWorktreeDirty(rec.path, this.gitExec),
      createForkWorktree: async (forkName, source) => {
        try {
          const forkBranch = branchFor(forkName, this.config?.settings ?? {}, {});
          const rec = await this.worktrees.createFork(forkName, forkBranch, source.branch);
          this.managedWorktrees.syncAgentRecord(forkName, rec);
          return { cwd: rec.path, worktree: rec };
        } catch (err) {
          this.host.notify(`couldn't create fork worktree for '${forkName}': ${err instanceof Error ? err.message : String(err)}`, "warn");
          return null;
        }
      },
      rollbackPreparedWorktree: async (rec, initialHead, beforeHead, afterHead, created) => {
        // rollbackCreated/rollbackPreparation intentionally preserve the checkout (recovery state).
        // Registry rows stay active so reveal still points at the recovery path; human cleanup uses remove.
        if (created) {
          if (!afterHead) throw new Error(`fresh worktree cleanup was withheld without a prepared HEAD observation: ${rec.path}`);
          await this.worktrees.rollbackCreated(rec, initialHead, afterHead);
          return;
        }
        if (!beforeHead || !afterHead) {
          throw new Error(`reused worktree cleanup was withheld without preparation HEAD observations: ${rec.path}`);
        }
        await this.worktrees.rollbackPreparation(rec, beforeHead, afterHead);
      },
      completePreparedWorktree: (rec) => this.worktrees.completePreparation(rec),
      removeHarnessHome: (name) => this.harness.remove(name),
      removePiSessionDir: (name) => removePiSessionDir(this.workspaceRoot, name),
    });

    this.deliveryVerification = new DeliveryVerificationLeaseService({
      store: this.deliveries,
      gitDeliveries: this.gitDeliveries,
      ownerEpoch: randomBytes(16).toString("hex"),
      withPathLock: (worktreePath, fn) => this.worktrees.withPathLock(worktreePath, fn),
      isAgentRunning: async (name) => {
        const state = (await this.manager.agentStates()).get(name);
        return !!state && !state.dead;
      },
      establishTailAbsence: (input) => this.deliveryLease.establishVerificationTailAbsence(input),
    });

    // spec 230 — the pipeline executor. Constructed before the Bridge so its `completeNode` dep can
    // reference it. Deps bind to the real WorktreeManager / AgentManager / verify gate.
    this.runLedger = new RunLedger(workspaceRoot);
    this.pipelines = new PipelineManager(this.pipelineDeps());

    this.waiters = new Waiters();
    this.monitor = new AttentionMonitor(
      {
        runningAgents: () => this.manager.runningAgents(),
        // Attention parses content for idle/working; join soft wraps (t-24e0f8).
        capturePane: (agent) => this.tmux.capturePane(this.manager.session(agent), { joinWrapped: true }),
        // Composer placeholder detection may need ANSI attributes; keep this bounded and opt-in.
        capturePaneEscaped: (agent, lines) => this.tmux.capturePane(this.manager.session(agent), { joinWrapped: true, preserveColors: true, lines }),
        cpuTicks: async (agent) => {
          try {
            return subtreeCpuTicks(await this.tmux.panePid(this.manager.session(agent)));
          } catch {
            return null;
          }
        },
        settingsOf: (agent) => {
          const att = this.config?.agents[agent]?.attention;
          // Ad-hoc agents (not declared): default attention ON for kind=agent, but OFF for
          // kind=terminal — a Bridge-spawned `sh`/shell shouldn't be monitored like an AI
          // agent (F5: ad-hoc attention now respects the inferred kind, matching declared
          // terminals which already default attention off).
          if (!att) return { enabled: this.manager.kindOf(agent) !== "terminal", silenceSec: 8, patterns: [] };
          return { enabled: att.enabled, silenceSec: att.silenceSec, patterns: safePatterns(att.patterns, this.t, (m, l) => this.host.notify(m, l)) };
        },
        // spec 216 (codex r1 M1): compaction detection / re-anchoring is an AI-agent concept only.
        // Return null for terminals so a terminal running a claude/codex-shaped cmd (attention forced
        // on) can never enqueue a re-anchor and get injected into.
        cmdOf: (agent) => (this.manager.kindOf(agent) === "agent" ? (this.manager.defOf(agent)?.cmd ?? null) : null),
        // t-10771a v1 — derived prose-question handback is only for declared top-level agents:
        // declared in tachyon.yml, AI-kind, and not a declared subagent. Ad-hoc children and
        // tachyon.yml subagents can still use the authored request_human_attention path.
        awaitingHumanOnIdle: (agent) =>
          this.manager.kindOf(agent) === "agent" &&
          !!this.config?.agents?.[agent] &&
          this.config?.declaredOwner?.[agent] === undefined,
        // t-4ecf9a — push activity timestamps from control-mode; null when engine down → full capture poll.
        windowActivity: (agent) => {
          if (!this.activityFeedLive) return null;
          const ts = this.activityBySession.get(this.manager.session(agent));
          return ts !== undefined ? ts : null;
        },
        now: () => Date.now(),
      },
      (agent, attention, shouldToast) => {
        // t-9552f3 — clear completion latch only when pane content moves after the doorbell
        // (a real new turn). Do not clear while monitor still says "working" on frozen content.
        this.completionHints.clearIfNewOutput(agent, attention.contentSince);
        this.waiters.notifyAttention(agent, this.attentionOf(agent)?.state ?? attention.state);
        this.refreshAgentsViews();
        // spec 216 (Part C) — re-anchor the role on the first idle AFTER a detected compaction (never
        // working/needs-input), once per episode, only when opted in. spec 241 — continuity recovery rides
        // the same idle. codex fix #4: run them SERIALLY (role reminder, then continuity pointer) so two
        // tmux sendKeys never interleave into the pane.
        if (attention.state === "idle" && this.manager.kindOf(agent) === "agent") {
          const hasPendingAnchor = this.pendingAnchor.has(agent);
          const wantAnchor = hasPendingAnchor && (this.config?.settings.anchor?.auto ?? false);
          if (hasPendingAnchor && !wantAnchor) this.pendingAnchor.delete(agent);
          void this.recoverOnIdle(agent, wantAnchor).catch(() => {});
        }
        // t-8605be — a child stuck on an interactive prompt is otherwise unreachable by agents (write_input
        // refuses working/throttled, notify_agent refuses needs-input per 341) until a human notices the
        // badge. Poke the live PARENT proactively, same machine as pokeParentOnDeath (332): fires once per
        // needs-input episode (shouldToast is the monitor's own one-shot), independent of the human-toast
        // suppression below (the parent is a different pane, not the one the human may be looking at).
        if (shouldToast && attention.state === "needs-input") {
          this.pokeParentOnNeedsInput(agent, attention.matchedLine);
        }
        if (attention.state === "throttled") this.scheduleRateLimitAutoContinue(agent, attention);
        else this.cancelRateLimitAutoContinue(agent);
        if (shouldToast && attention.state === "throttled") {
          this.pokeParentOnThrottle(agent, attention);
        }
        // Suppress the toast when you're already looking at this agent's terminal —
        // the prompt is right in front of you; the popup would be pure noise. The
        // sidebar badge still updates (onViewsChanged above, outside this gate).
        if (shouldToast && attention.state === "needs-input" && !this.terminals.isActive(agent)) {
          const line = attention.matchedLine ?? "waiting for input";
          this.host.notify(this.t("'{0}' needs you — {1}", agent, line), "info", [
            { label: this.t("Open"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
        } else if (shouldToast && attention.state === "throttled" && !this.terminals.isActive(agent)) {
          // spec 306 — provider error (rate limit/overloaded) sustained past the anti-spam delay.
          const line = attention.matchedLine ?? "provider throttled";
          this.host.notify(this.t("'{0}' is throttled — {1}", agent, line), "warn", [
            { label: this.t("Open"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
        }
        // t-35d95a — request_human_attention's AUTHORED signal: fires independently of attention.state
        // (typically idle — the agent ended its turn with a prose question the needs-input PATTERN
        // matcher can't see). shouldToast is flagAwaitingHuman's own one-shot (mirrors stallNotified),
        // so this fires exactly once per awaiting-human episode. Same terminal-active suppression as
        // needs-input — the sidebar badge (onViewsChanged above) still reflects the latch either way.
        // OS/mobile push is OUT OF SCOPE (deferred to the companion t-fe52f0/t-619157) — in-app only.
        if (shouldToast && attention.awaitingHuman && !this.terminals.isActive(agent)) {
          const reason = attention.awaitingHumanReason ?? "";
          this.host.notify(this.t("'{0}' needs you: {1}", agent, reason), "info", [
            { label: this.t("Open"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
        }
      },
      // spec 216 — compaction detected: queue a re-anchor, consumed on the next idle above.
      // spec 241 — also mark a continuity discontinuity (compaction is in-file, so the activity transition
      // counter won't see it) so the agent's continuity is re-injected on the next idle.
      (agent) => {
        // A failed soul-aware compaction anchor is a durable human-attention latch. Do not let later
        // compaction observations create an automatic retry loop; a manual re-anchor clears health.
        if (this.ledger.get(agent)?.identity?.health !== "identity-degraded") this.pendingAnchor.add(agent);
        if (this.manager.kindOf(agent) === "agent") this.continuityState.markDiscontinuity(agent, this.currentActivitySeq(agent));
      },
    );

    this.adhocBackstop = new AdhocBackstopMonitor({
      listEntries: () => this.manager.list(),
      attentionOf: (agent) => this.attentionOf(agent),
      now: () => Date.now(),
      deliverNotice: (parent, line, metadata) => this.deliverNotice(parent, line, metadata),
      sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent),
      completionHinted: (agent) => this.completionHints.has(agent),
    });

    this.gatedCompletion = new GatedCompletionMonitor({
      listGatedFacts: () => this.listGatedCompletionFacts(),
      listEntries: () => this.manager.list(),
      attentionOf: (agent) => this.attentionOf(agent),
      headState: async (worktreePath) => {
        try {
          return await this.worktrees.headState(worktreePath);
        } catch {
          return null;
        }
      },
      hasDoorbellRung: (agent, delegator, sinceIso) =>
        hasDoorbellRung(this.workspaceRoot, agent, delegator, sinceIso),
      deliverNotice: (delegator, line, metadata) => this.deliverNotice(delegator, line, metadata),
      sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent),
      now: () => Date.now(),
      loadCandidates: () => this.loadGatedCompletionCandidates(),
      saveCandidates: (c) => this.saveGatedCompletionCandidates(c),
    });

    this.lifecycle = new LifecycleMonitor(
      {
        agentStates: () => this.manager.agentStates(),
        policyOf: (agent) => this.config?.agents[agent]?.restart ?? "never",
        scheduleRestart: (agent, delayMs) => {
          setTimeout(() => {
            // spec 389 — crash recovery is force + new (not operator graceful+resume).
            this.manager.restart(agent, { stop: "force", session: "new" }).catch((err) => {
              this.host.notify(`auto-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            });
          }, delayMs);
        },
        now: () => Date.now(),
      },
      {
        onCrash: (agent, exitCode, willRestart, delayMs) => {
          this.waiters.notifyDead(agent, exitCode);
          void this.evolutionCoordinator.onAgentUnavailable(agent, `agent '${agent}' exited before submitting the review`);
          this.noticeQueue.clear(agent);
          this.pokeParentOnDeath(agent, exitCode !== undefined ? String(exitCode) : "killed");
          // spec 230 — a pipeline node's process died: feed the exit to the executor (an exit-based node
          // fails on the non-zero code; a signal-based node fails closed). No crash popup — the run shows it.
          const plNode = this.pipelineNodeOf.get(agent);
          if (plNode) {
            this.pipelines.onProcessExit(plNode.runId, plNode.nodeId, exitCode ?? 1);
            return;
          }
          this.refreshAgentsViews();
          const code = exitCode !== undefined ? this.t(" (exit {0})", exitCode) : "";
          if (willRestart) {
            this.host.notify(this.t("'{0}' crashed{1} — restarting in {2}s", agent, code, Math.round((delayMs ?? 0) / 1000)), "warn");
          } else {
            this.host.notify(this.t("'{0}' crashed{1} — dead pane kept for postmortem", agent, code), "error", [
              { label: this.t("Inspect"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
              // spec 389 — one-click crash recovery stays force + new section.
              { label: this.t("Restart"), run: () => void this.manager.restart(agent, { stop: "force", session: "new" }).catch((err) => this.host.notify(String(err instanceof Error ? err.message : err), "error")) },
            ]);
          }
        },
        onCleanExit: (agent) => {
          this.waiters.notifyDead(agent, 0);
          void this.evolutionCoordinator.onAgentUnavailable(agent, `agent '${agent}' exited before submitting the review`);
          this.noticeQueue.clear(agent);
          this.pokeParentOnDeath(agent, "0");
          // spec 230 — a pipeline `cmd:` one-shot exited cleanly: complete its node by exit code.
          const plNode = this.pipelineNodeOf.get(agent);
          if (plNode) {
            this.pipelines.onProcessExit(plNode.runId, plNode.nodeId, 0);
            return;
          }
          void this.manager.dismissCleanExitPane(agent)
            .catch((err) => {
              this.host.notify(this.t("'{0}' exited cleanly, but Tachyon could not clear its terminal: {1}", agent, String(err instanceof Error ? err.message : err)), "warn");
            })
            .finally(() => this.refreshAgentsViews());
          this.host.notify(this.t("'{0}' exited cleanly", agent));
        },
        onGone: (agent) => {
          this.waiters.notifyGone(agent);
          void this.evolutionCoordinator.onAgentUnavailable(agent, `agent '${agent}' stopped before submitting the review`);
          this.noticeQueue.clear(agent);
          this.pokeParentOnDeath(agent, "killed", true);
        },
        onGiveUp: (agent, attempts) => {
          this.refreshAgentsViews();
          this.host.notify(this.t("'{0}' crash-looped ({1} restarts in 1 min) — giving up. Fix it and restart manually.", agent, attempts), "error", [
            { label: this.t("Inspect"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
        },
      },
    );

    this.pinStore = new PinStore(workspaceRoot);
    this.evolutionStore = new EvolutionStore(workspaceRoot, {
      reservedSkillNames: (name) => declaredHarnessSkillNames(
        workspaceRoot,
        this.config?.agents[name]?.harness?.skills,
      ),
      authorityIntegrityKey: () => this.authorityIntegrityKey,
      authorityHead: this.canonicalAuthorityHeadPort(),
      sessionSnapshotsRoot: path.join(deps.host.globalStoragePath(), "evolution-session-snapshots", this.wsHash),
    });
    this.evolutionCoordinator = new EvolutionCoordinator({
      store: this.evolutionStore,
      declaredAgent: (name) => this.config?.agents[name],
      sessionFor: (name) => this.manager.session(name),
      activitySeq: (name) => this.currentActivitySeq(name),
      deliverNotice: (name, line) => this.deliverNotice(name, line),
      onReviewChanged: () => deps.onViewsChanged("agents"),
      onError: (message) => this.host.notify(message, "error"),
    });
    this.taskStore = new TaskStore(workspaceRoot, {
      evolutionCompletionFor: (event) => this.evolutionCoordinator.completionMarker(event),
      onMutation: (event) => this.evolutionCoordinator.onTaskMutation(event),
    });
    this.validationStore = new ValidationStore(workspaceRoot);
    this.continuityStore = new ContinuityStore(workspaceRoot);
    this.continuityState = new ContinuityState(workspaceRoot);
    // spec 245 — shared per-project handoff. Path overridable via tachyon.yml `handoff.path` (default .tachyon/HANDOFF.md).
    this.handoffStore = new ProjectHandoffStore(workspaceRoot, { canonicalRelPath: this.config?.settings?.handoff?.path });

    // One-shot commands + runbooks (F15/F21): own tmux namespaces, inverted lifecycle.
    this.commandRunner = new CommandRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onRerun: (name) => this.terminals.close(`cmd:${name}`),
      onFinished: (name, exitCode, durationMs) => {
        this.waiters.notifyDead(`${CMD_WAIT_PREFIX}${name}`, exitCode);
        deps.onViewsChanged("commands");
        if (exitCode === 0) {
          this.host.notify(this.t("command '{0}' passed ({1}s)", name, Math.round((durationMs ?? 0) / 1000)));
        } else {
          this.host.notify(this.t("command '{0}' failed (exit {1})", name, exitCode ?? "?"), "error", [
            { label: this.t("Inspect"), run: () => this.openCommandPane(name) },
          ]);
        }
      },
    });
    this.runbookRunner = new RunbookRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onFinished: (job) => {
        deps.onViewsChanged("commands");
        // spec 214 — verify-gate runs use the runbook executor under a `_verify-<agent>` label;
        // runVerify owns their messaging + badge, so skip the generic runbook toast here.
        if (job.runbook.startsWith(VERIFY_LABEL_PREFIX)) return;
        if (job.outcome === "passed") {
          this.host.notify(this.t("runbook '{0}' passed ({1} steps)", job.runbook, job.steps.length));
        } else {
          const failed = job.steps.find((st) => st.state === "failed");
          this.host.notify(this.t("runbook '{0}' failed at step {1} ({2})", job.runbook, (failed?.index ?? 0) + 1, failed?.step ?? "?"), "error", [
            { label: this.t("Inspect"), run: () => failed && this.openRunbookStepPane(job.runbook, failed.index) },
          ]);
        }
      },
    });

    // Schedules (F23): a timer over the existing executors; fires only while the
    // workspace is open. Agent proposals land inert in .tachyon/ until approved.
    this.proposals = new ProposalStore(workspaceRoot);

    // spec 257 — the captured headless A2A probe lane. Read-only by default; write-capable probes are
    // refused in this build (worktree isolation for them is a follow-up — D8 auth does real work here).
    this.probeStore = new ProbeStore(path.join(workspaceRoot, ".tachyon", "probes"));
    this.probeService = new ProbeService({
      adapters: new Map([
        ["claude", claudeAdapter],
        ["codex", codexAdapter],
      ]),
      store: this.probeStore,
      onComplete: (env) => {
        this.host.notify(this.t("probe {0} {1}", env.runId.slice(0, 16), env.status), "info");
        deps.onViewsChanged("probes"); // re-render the inspector + drop the sidebar chip (D9)
      },
      onLaunch: () => deps.onViewsChanged("probes"), // raise the transient sidebar chip immediately
      authorize: (req) => (req.write ? { ok: false, reason: "write-capable probes are not enabled in this build" } : { ok: true }),
      // spec 351 — probes are first-class callers (dueto F11): a per-run token through the same registry.
      mintCallerToken: (name) => {
        const token = this.callerRegistry?.mint(name, this.callerScope());
        this.persistCallerRegistry();
        return token;
      },
      revokeCallerToken: (name) => {
        this.callerRegistry?.revoke(name, this.callerScope());
        this.persistCallerRegistry();
      },
    });
    void this.probeService.reap(); // reconcile any probe orphaned by a previous Bridge restart (OQ3)
    void this.probeStore.prune(); // bounded retention (OQ2)
    this.scheduler = new Scheduler({
      getConfig: () => this.config,
      onFire: (name, def) => this.runSchedule(name, def),
      onError: (name, err) => this.host.notify(this.t("schedule '{0}' failed: {1}", name, err instanceof Error ? err.message : String(err)), "error"),
    });

    this.companion = new CompanionPairingService({
      engineLabel: path.basename(this.workspaceRoot) || "tachyon",
      engineId: this.wsHash,
      getBaseUrl: () => {
        const port = this.bridge.listenerPort;
        if (port === undefined) return undefined;
        const lanAccess = this.config?.settings.companion?.lanAccess === true;
        return companionPairBaseUrl(port, lanAccess);
      },
    });
    this.companionLive = new CompanionLiveSync({
      statusOf: (token) => this.companion.status(token),
      listAgents: () => this.companionListActiveAgents(),
    });
    this.companionTab = new CompanionTabChannel({
      push: (event, data) => this.companionLive.pushEvent(event, data),
    });
    this.bridge = new Bridge(
      {
        workspaceRoot: this.workspaceRoot,
        // t-099be8 — agent self-edit gate for tachyon.yml (validate-then-write).
        writeTachyonConfig: (yamlText) => this.writeTachyonConfigText(yamlText),
        manager: this.manager,
        tmux: this.tmux,
        pins: this.pinStore,
        tasks: this.taskStore,
        evolution: this.evolutionStore,
        validations: this.validationStore,
        continuity: this.continuityStore,
        currentActivitySeq: (agent) => this.currentActivitySeq(agent),
        // the agent just checkpointed → it demonstrably has context now → clear any outstanding discontinuity
        // so we don't redundantly re-inject on its next idle.
        onContinuityChanged: (agent) => {
          this.continuityState.markRestored(agent, this.currentActivitySeq(agent));
          this.continuityState.setLastSeenTransitions(agent, this.writerTransitions(agent)); // codex fix #1 — baseline at checkpoint
          this.refreshAgentsViews();
        },
        // spec 245 — shared per-project handoff (distinct from per-agent continuity above).
        handoff: this.handoffStore,
        lastActivityAt: () => this.lastActivityAt(),
        onHandoffChanged: () => deps.onViewsChanged("handoff"),
        notify: (m, l) => this.host.notify(m, l),
        // spec 257 — the captured headless A2A probe lane.
        probe: this.probeService,
        probeCwd: () => this.workspaceRoot,
        attentionOf: (agent) => this.attentionOf(agent)?.state,
        composerOccupiedOf: (agent) => this.attentionOf(agent)?.composerOccupied,
        // SDD 414 / t-2a7010 + t-fbe280 — agent tab tools via Companion extension.
        // Listed when settings.companion.tabTools is true; execution still requires a paired device.
        companionTabToolsEnabled: () => this.config?.settings.companion?.tabTools === true,
        companionBrowserPaired: () => this.companion.hasPairedDevice(),
        companionRefHints: (tabId, ref) => this.companionTabRefs.hintsFor(tabId, ref),
        companionTabTabsList: (opts) => this.companionTab.requestTabsList(opts?.timeoutMs),
        companionTabSnapshot: async (opts) => {
          const result = await this.companionTab.requestSnapshot(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            opts.timeoutMs,
          );
          // Cache @e metadata for ref-only safety classification (t-8f0862).
          if (result && typeof result === "object" && (result as { ok?: boolean }).ok === true) {
            const r = result as {
              tabId?: string;
              refs?: Array<{
                ref: string;
                selector?: string;
                name?: string;
                tag?: string;
                role?: string;
                href?: string;
              }>;
            };
            const tid = typeof r.tabId === "string" ? r.tabId : opts.tabId;
            this.companionTabRefs.putFromSnapshot(tid, r.refs);
          }
          return result;
        },
        companionTabScreenshot: (opts) =>
          this.companionTab.requestScreenshot(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              format: opts.format,
              quality: opts.quality,
              scope: opts.scope,
              ref: opts.ref,
              selector: opts.selector,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabEval: (opts) =>
          this.companionTab.requestEval(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            opts.expression,
            opts.timeoutMs,
          ),
        companionTabConsole: (opts) =>
          this.companionTab.requestConsole(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            opts.limit,
            opts.timeoutMs,
          ),
        companionTabAct: (input) => {
          const target = { tabId: input.tabId, expectedDocumentToken: input.expectedDocumentToken };
          if (input.kind === "click") {
            return this.companionTab.requestClick(target, {
              ref: input.ref,
              selector: input.selector,
              timeoutMs: input.timeoutMs,
            });
          }
          if (input.kind === "type") {
            return this.companionTab.requestType(target, {
              ref: input.ref,
              selector: input.selector,
              text: input.text ?? "",
              submit: input.submit,
              timeoutMs: input.timeoutMs,
            });
          }
          return this.companionTab.requestFill(target, {
            ref: input.ref,
            selector: input.selector,
            value: input.value ?? "",
            timeoutMs: input.timeoutMs,
          });
        },
        companionAllowedHosts: () => this.config?.settings.companion?.allowedHosts,
        companionTabNavigate: (opts) =>
          this.companionTab.requestNavigate(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            opts.action,
            { url: opts.url, timeoutMs: opts.timeoutMs },
          ),
        companionTabScroll: (opts) =>
          this.companionTab.requestScroll(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              direction: opts.direction,
              pixels: opts.pixels,
              ref: opts.ref,
              selector: opts.selector,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabPressKey: (opts) =>
          this.companionTab.requestPressKey(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              key: opts.key,
              modifiers: opts.modifiers,
              ref: opts.ref,
              selector: opts.selector,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabWaitFor: (opts) =>
          this.companionTab.requestWaitFor(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              what: opts.what,
              ref: opts.ref,
              selector: opts.selector,
              text: opts.text,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabOpen: (opts) => this.companionTab.requestTabOpen(opts),
        companionTabActivate: (opts) =>
          this.companionTab.requestTabActivate({ tabId: opts.tabId }, opts.timeoutMs),
        companionTabClose: (opts) =>
          this.companionTab.requestTabClose({ tabId: opts.tabId }, opts.timeoutMs),
        companionTabGet: (opts) =>
          this.companionTab.requestGet(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              what: opts.what,
              attribute: opts.attribute,
              ref: opts.ref,
              selector: opts.selector,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabFind: (opts) =>
          this.companionTab.requestFind(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            { text: opts.text, limit: opts.limit, timeoutMs: opts.timeoutMs },
          ),
        companionTabHover: (opts) =>
          this.companionTab.requestHover(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            { ref: opts.ref, selector: opts.selector, timeoutMs: opts.timeoutMs },
          ),
        companionTabSelectOption: (opts) =>
          this.companionTab.requestSelectOption(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              ref: opts.ref,
              selector: opts.selector,
              value: opts.value,
              label: opts.label,
              index: opts.index,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabCheck: (opts) =>
          this.companionTab.requestCheck(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              ref: opts.ref,
              selector: opts.selector,
              checked: opts.checked,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabDrag: (opts) =>
          this.companionTab.requestDrag(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              sourceRef: opts.sourceRef,
              sourceSelector: opts.sourceSelector,
              targetRef: opts.targetRef,
              targetSelector: opts.targetSelector,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabUpload: (opts) =>
          this.companionTab.requestUpload(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            {
              ref: opts.ref,
              selector: opts.selector,
              files: opts.files,
              timeoutMs: opts.timeoutMs,
            },
          ),
        companionTabDownload: (opts) =>
          this.companionTab.requestDownload(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            { ref: opts.ref, selector: opts.selector, timeoutMs: opts.timeoutMs },
          ),
        companionTabNetwork: (opts) =>
          this.companionTab.requestNetwork(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            { limit: opts.limit, urlContains: opts.urlContains, timeoutMs: opts.timeoutMs },
          ),
        companionTabListFrames: (opts) =>
          this.companionTab.requestListFrames(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            opts.timeoutMs,
          ),
        companionTabDialog: (opts) =>
          this.companionTab.requestDialog(
            { tabId: opts.tabId, expectedDocumentToken: opts.expectedDocumentToken },
            { action: opts.action, text: opts.text, timeoutMs: opts.timeoutMs },
          ),

        deliverNotice: (target, line, metadata) => this.deliverNotice(target, line, metadata),
        sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent),
        markCompletionHint: (agent) => {
          this.completionHints.mark(agent);
          this.monitor.flagUnseen(agent);
        },
        onPinsChanged: () => deps.onViewsChanged("pins"),
        onApprovalRequested: (request) => {
          deps.onApprovalRequested?.(this, request);
          // Companion side panel: push so Approvals tab can refresh without polling.
          try {
            this.companionLive.pushEvent("approvals.changed", {
              id: request.id,
              requester: request.requester,
            });
          } catch {
            /* best-effort */
          }
        },
        onTasksChanged: () => deps.onViewsChanged("tasks"),
        onTaskNotificationEvent: (event) => this.taskNotifications.notify(event),
        onValidationsChanged: () => deps.onViewsChanged("tasks"),
        waiters: this.waiters,
        commands: this.commandRunner,
        runbooks: this.runbookRunner,
        scheduler: this.scheduler,
        proposals: this.proposals,
        onScheduleProposed: (name, by) => {
          deps.onViewsChanged("schedules");
          this.host.notify(this.t("{0} proposed a schedule '{1}' — approve it?", by, name), "info", [
            { label: this.t("Review"), run: () => this.host.focusPrimaryView() },
          ]);
        },
        // spec 214 — verify-gate handoff over MCP: list_agents reads this, verify_agent runs it.
        verifyInfo: async (agent) => {
          const info = await this.verifyInfo(agent);
          if (!info) return undefined;
          return { command: info.command, passed: info.state?.passed, atCommit: info.state?.atCommit, ranAt: info.state?.ranAt, stale: info.stale, evidence: await this.evidenceHandoff(agent) };
        },
        runVerify: async (agent) => {
          const s = await this.runVerify(agent);
          // Recompute staleness freshly (review fix: never hardcode stale:false — HEAD may have
          // moved or the tree gone dirty during a long verify, and a dirty run is stale at once).
          const info = await this.verifyInfo(agent);
          // If verifyInfo vanished (config/ledger changed mid-run), default to STALE — never
          // hand back a non-stale verdict we can no longer validate (round-2 review fix).
          return { command: s.command, passed: s.passed, atCommit: s.atCommit, ranAt: s.ranAt, stale: info?.stale ?? true, evidence: await this.evidenceHandoff(agent) };
        },
        withWorktreeLock: (agent, fn) => this.worktrees.withAgentPathLock(agent, fn),
        deliveryVerification: this.deliveryVerification,
        assertLegacyDeliveryRetired: () => this.legacyDeliveryRetirement.assertRetired(),
        deliveryLease: this.deliveryLease,
        // spec 273 — the worktree evidence channel over MCP.
        attachEvidence: (input) => this.attachEvidence(input),
        listEvidence: (agent) => this.listEvidence(agent),
        // spec 216 — manual re-anchor over MCP (always available; the auto path is opt-in).
        reanchor: async (agent) => this.reanchor(agent),
        // spec 230 — a pipeline node signals completion (per-node nonce auth).
        completeNode: (input) => this.pipelines.completeSignal(input),
        // spec 359 — host actions are authorized with the per-request Bridge caller snapshot.
        runHostAction: (input) => this.runHostAction(input),
        gitDelivery: {
          store: this.gitDeliveries,
          git: this.gitExec,
          settings: () => resolveGitDeliverySettings(this.config?.settings),
          liveness: (agent) => this.gitDeliveryLiveness(agent),
          worktreeOccupancy: (worktreePath) => this.manager.worktreeOccupant(worktreePath),
          tasks: this.taskStore,
          workspaceId: this.wsHash,
          withWorktreeLock: (agent, fn) => this.worktrees.withAgentPathLock(agent, fn),
          projection: this.deliveryProjection,
          deliveries: this.deliveries,
          reloadSnapshot: () => (this.deliveryReload.phase === "ready" ? this.deliveryReload.snapshot : undefined),
          // spec 392 — prune through managed engine (occupancy-checked) instead of raw git argv.
          removeManagedWorktree: (worktreePath, o) =>
            this.managedWorktrees.removePath(worktreePath, {
              deleteBranch: o?.deleteBranch,
              branch: o?.branch,
              tachyonCreatedBranch: o?.tachyonCreatedBranch,
              baseRef: o?.baseRef,
              force: o?.force,
            }),
        },
        managedWorktrees: this.managedWorktrees,
        // spec 351 (dueto F8) — plaintext Bridge tokens Tachyon still holds, for exact-match redaction of
        // live-captured pane text (read_output). Per-agent tokens aren't retained in plaintext.
        knownSecrets: () => [this.token, this.externalToken].filter((s): s is string => !!s),
        // t-35d95a — request_human_attention's target: latch the CALLER's own agent on the LIVE
        // attention monitor (distinct from flag_for_human, which flags a Task on the board).
        flagAwaitingHuman: (agent, reason) => this.monitor.flagAwaitingHuman(agent, reason),
        waitForDeliveryLease: (input, signal) => waitForDeliveryLease(this.deliveries, input, undefined, signal),
      },
      {
        token: this.token,
        externalToken: this.externalToken,
        companion: {
          pairing: this.companion,
          live: this.companionLive,
          tab: this.companionTab,
          ops: {
            listActiveAgents: () => this.companionListActiveAgents(),
            sendPrompt: (agent, text) => this.companionSendPrompt(agent, text),
            listApprovals: () => this.companionListApprovals(),
            resolveApproval: (id, decision) => this.companionResolveApproval(id, decision),
          },
        },
        getRegistry: () => this.callerRegistry,
        scope: this.callerScope(),
        legacyCompatEnabled: this.legacyBridgeAuthEnabled,
        onLegacyCall: (info) => this.logLegacyBridgeCall(info),
        onRequestComplete: (info) => {
          const toast = this.bridgeSlowRequestToasts.decide(info);
          if (toast) this.host.notify(this.t(toast.message), "warn");
        },
      },
    );

    this.watches = new WatchController(async () => {});

    // spec 364 — Bridge-client rebind coordinator (host-agnostic ports; after manager/bridge exist).
    this.clientRebind = new BridgeClientRebindCoordinator({
      workspaceHash: this.wsHash,
      bridgeInstanceId: this.bridgeInstanceId,
      getState: (key) => this.host.getState(key),
      setState: (key, value) => this.host.setState(key, value),
      getLedger: (name) => this.ledger.get(name),
      listRunning: async () => {
        const running = await this.manager.runningAgents();
        return running.filter((n) => this.manager.kindOf(n) === "agent");
      },
      kindOf: (name) => this.manager.kindOf(name),
      isRunning: async (name) => {
        const running = await this.manager.runningAgents();
        return running.includes(name);
      },
      // Use AgentManager's rebind-only, uncached generic-resume boundary. It distinguishes a young
      // transcript that may appear from Delivery/snapshot/record denial and rechecks authority around
      // asynchronous resolution. Rebind must receive `ready` before it stops anything.
      canResume: (name, record) => this.manager.rebindResumeReadiness(name, record),
      resumeDenied: (name, record) => this.manager.rebindResumeDenied(name, record),
      stopGracefully: (name) => this.manager.stopGracefully(name),
      hardKillSession: async (name) => {
        // Kill the tmux session only — do NOT call AgentManager.kill (that wipes ad-hoc ledger rows).
        const session = this.manager.session(name);
        await this.tmux.killSession(session);
      },
      resume: (name, record, opts) => this.manager.resume(name, record, opts),
      stampBridgeClient: (name, generation) => {
        const rec = this.ledger.get(name);
        if (!rec) return;
        this.ledger.record(name, { ...rec, bridgeClient: { boundGeneration: generation, wired: true } });
      },
      markExpectedDeath: (name) => {
        this.expectedDeath.add(name);
      },
      notify: (message, level) => this.host.notify(message, level),
      deliverNotice: (target, line) => this.deliverNotice(target, line),
      getSettings: () => this.bridgeClientRebindSettings(),
      auditPath: this.bridgeClientRebindAuditPath,
      getReloadInitiator: () => {
        const v = this.host.getState<string>(reloadInitiatorStateKey(this.wsHash));
        return typeof v === "string" && v.length > 0 ? v : undefined;
      },
      clearReloadInitiator: () => this.host.setState(reloadInitiatorStateKey(this.wsHash), undefined),
    });
  }

  /** spec 364 — settings with defaults when the section is absent. */
  private bridgeClientRebindSettings(): BridgeClientRebindSettings {
    const raw = this.config?.settings.bridgeClientRebind;
    if (!raw) return { ...DEFAULT_BRIDGE_CLIENT_REBIND };
    return parseBridgeClientRebindSettings(raw);
  }

  /** Allowlisted Runtime Ops read of Bridge-client state; excludes tokens, audit records, and session identity. */
  runtimeOpsBridgeHealth(name: string): {
    currentGeneration: number;
    boundGeneration: number;
    wired: boolean;
    clientState?: ClientRebindState;
  } {
    const record = this.ledger.get(name);
    const clientState = this.clientRebind?.getClientState(name);
    return {
      currentGeneration: this.clientRebind?.getGeneration() ?? 0,
      boundGeneration: durableBoundGeneration(record),
      wired: isTachyonBridgeWiredRecord(record),
      ...(clientState ? { clientState } : {}),
    };
  }

  private async reloadWindowBusyAgents(callerName?: string): Promise<Array<{ name: string; state: string }>> {
    const running = await this.manager.runningAgents();
    const busy: Array<{ name: string; state: string }> = [];
    for (const name of running) {
      if (name === callerName || this.manager.kindOf(name) !== "agent") continue;
      const attention = this.attentionOf(name);
      if (attention?.composerOccupied) {
        busy.push({ name, state: attention.state === "idle" ? "composer" : `${attention.state}+composer` });
      } else if (attention && attention.state !== "idle") {
        busy.push({ name, state: attention.state });
      }
    }
    return busy;
  }

  private async runHostAction(input: {
    readonly action: string;
    readonly args?: unknown;
    readonly timeoutMs?: number;
    readonly caller: CallerSnapshot;
  }) {
    if (input.action === "reloadWindow") {
      const callerName = input.caller.kind === "agent" ? input.caller.name : undefined;
      const busy = await this.reloadWindowBusyAgents(callerName);
      if (busy.length > 0) {
        const listed = busy.slice(0, 5).map((agent) => `${agent.name}:${agent.state}`).join(", ");
        const more = busy.length > 5 ? `, +${busy.length - 5} more` : "";
        const message = `reloadWindow blocked: ${busy.length} other agent(s) are active (${listed}${more}). Wait for them to go idle, stop them, or restart them deliberately before reloading VS Code.`;
        this.host.notify(message, "warn");
        return {
          ok: false as const,
          code: "precondition_failed" as const,
          message,
          actionId: "reload-precondition",
          auditSeq: 0,
        };
      }
    }
    // spec 364 / 359 — remember reload initiator so post-rebind can deliverNotice (persists across reload).
    if (input.action === "reloadWindow" && input.caller.kind === "agent" && input.caller.name) {
      this.host.setState(reloadInitiatorStateKey(this.wsHash), input.caller.name);
    }
    const paths = hostActionPolicyPaths(this.host.globalStoragePath());
    await restorePinnedExternalPolicy(paths, VSCODE_RELOAD_WINDOW_POLICY_JSON, VSCODE_RELOAD_WINDOW_POLICY_HASH);
    const policy = await loadPinnedExternalPolicy(paths, VSCODE_RELOAD_WINDOW_POLICY_HASH);
    const audit = new FileHashChainAuditSink({ filePath: this.hostActionAuditPath });
    const adapter = new VsCodeHostActionAdapter(
      { executeCommand: (command) => this.host.executeCommand(command) },
      this.reloadTransactions,
      () => this.hostActionBundle(),
    );
    const callerResolver: HostActionCallerResolver = {
      resolve: () => {
        if (input.caller.kind === "agent" && input.caller.name) return { ok: true, caller: { kind: "agent", name: input.caller.name } };
        if (input.caller.kind === "legacy") return { ok: true, caller: { kind: "legacy" } };
        return { ok: false, reason: "run_host_action requires an agent-scoped Bridge token" };
      },
    };
    const broker = new HostActionBroker({ callerResolver, policy, audit, port: adapter });
    const result = await broker.run({ action: hostActionName(input.action), args: input.args, timeoutMs: input.timeoutMs });
    if (input.caller.kind === "agent" && input.caller.name && hostActionTouchesHostUi(input.action)) {
      const now = new Date().toISOString();
      this.externalTools.upsert({
        agent: input.caller.name,
        kind: "host-action",
        tool: input.action,
        source: "host-action",
        confidence: "strong",
        sessionId: `ets-host-${this.hostActionSessionEpoch}-${Date.now().toString(36)}`,
        startedAt: now,
        lastSeenAt: now,
        state: "active",
      });
    }
    return result;
  }

  private async recoverPendingHostActionReload(): Promise<void> {
    const recovered = await this.reloadTransactions.recover({
      current: this.hostActionBundle(),
      healthOk: Boolean(this.bridge.url),
    });
    if (!recovered) return;
    const audit = new FileHashChainAuditSink({ filePath: this.hostActionAuditPath });
    await audit.appendOutcome({
      kind: "outcome",
      actionId: recovered.actionId,
      state: recovered.state,
      ...(recovered.reason ? { message: recovered.reason } : {}),
    });
    if (recovered.state === "result_unknown" || recovered.state === "returned_wrong_host" || recovered.state === "failed_to_return") {
      this.host.notify(this.t("host action reload result is unknown: {0}", recovered.reason ?? recovered.state), "warn");
    }
  }

  private hostActionBundle(): Omit<ReloadReattachBundle, "reattach_nonce"> {
    return {
      host_instance_id: this.bridgeInstanceId,
      workspace_id: this.wsHash,
      extension_build_id: this.host.appVersion(),
      session_epoch: this.hostActionSessionEpoch,
    };
  }

  /**
   * spec 230 — bind the pipeline executor's side effects to the real subsystems. A node is spawned as
   * an ad-hoc agent named `pl-<runId>-<nodeId>` into the RUN's worktree (registered for the
   * resolveSpawnCwd override just before the spawn); the run worktree is `run-<id>`. The verify gate is
   * the worktree-scoped one (settings.worktree.verify) run in the run worktree; empty-diff staleness is
   * a follow (MVP returns stale:false). cmd-node exit-code wiring is a follow — agent nodes complete via
   * complete_node and the per-node timeout is the backstop.
   */
  private pipelineDeps(): PipelineDeps {
    const nodeDefOf = (runId: string, nodeId: string) => this.pipelines.getRun(runId)?.pipeline.nodes[nodeId];
    return {
      genRunId: () => randomBytes(4).toString("hex"),
      mintNonce: () => randomBytes(16).toString("hex"),
      allocateWorktree: async (runId) => {
        const agent = `run-${runId}`;
        const branch = branchFor(agent, this.config?.settings ?? {}, {});
        const { record, preparationLocked } = await this.worktrees.ensure({ agent, branch, quarantineForLaunch: true });
        if (!preparationLocked) throw new Error(`pipeline worktree '${record.path}' was not quarantined during allocation`);
        this.pipelineRunWt.set(agent, record);
        this.managedWorktrees.syncAgentRecord(agent, record);
        // PipelineManager invokes this only after its initial RunLedger record is crash-durable and
        // before the first node can spawn. Failure leaves both the durable run and Git receipt intact.
        return {
          cwd: record.path,
          key: agent,
          worktree: record,
          finalizeOwnership: () => this.worktrees.completePreparation(record),
        };
      },
      releaseWorktree: async (key) => {
        const rec = this.pipelineRunWt.get(key);
        if (rec) {
          const removed = await this.worktrees.remove(rec, true); // Tachyon-created run branch — safe to drop
          if (!removed.removed) {
            throw new Error(`pipeline worktree remains preserved at ${rec.path}: ${removed.error ?? "removal was refused"}`);
          }
          this.managedWorktrees.syncAgentRecord(key, null);
        }
        this.pipelineRunWt.delete(key);
      },
      spawnNode: async ({ runId, nodeId, def, cwd, env, input, upstream }) => {
        const name = nodeSpawnName(runId, nodeId, def);
        const wt = this.pipelineRunWt.get(`run-${runId}`);
        if (wt) this.pipelineNodeCwd.set(name, { cwd, worktree: wt }); // resolveSpawnCwd override
        this.pipelineNodeOf.set(name, { runId, nodeId });
        const signalBased = def.done === "signal" || def.done === "signal_then_verify";
        // spec 231 — compose task (optional) + the run input + upstream handoffs; byte-identical to the
        // 230 prompt when there is no input and no upstream summaries.
        const taskInstr = assembleNodePrompt({ task: def.task, input, upstream });
        if (def.agent) {
          // a declared specialist agent (harness/skills/rules/role) without its own worktree: spawn it
          // BY NAME into the run worktree, appending the task. It persists in the tree and is STOPPED
          // (not destroyed) when done. A declared agent is a single resource — if it's already running
          // (manual, or another run), spawn throws; surface a clear reason and let the node fail safely
          // (the executor never owns/kills the contended session — codex B2).
          try {
            await this.manager.spawn(def.agent, { env, pipeline: { runId, nodeId }, reveal: false, taskBrief: taskInstr });
          } catch (err) {
            if (String(err).includes("already running")) {
              this.host.notify(this.t("pipeline node '{0}' needs agent '{1}', but it's already running — stop it and re-run", nodeId, def.agent), "warn");
            }
            throw err;
          }
        } else {
          // an inline `cmd:` node — an ephemeral ad-hoc, dismissed when done. Deliver the task +
          // complete_node protocol ONLY for an interactive signal-based LLM (e.g. `cmd: codex` with the
          // workspace default config); an exit-based one-shot (sh / codex exec) runs its command as-is.
          await this.manager.spawn(name, { cmd: def.cmd, env, pipeline: { runId, nodeId }, reveal: false, ...(signalBased ? { taskBrief: taskInstr } : {}) });
        }
      },
      runVerify: async ({ runId, nodeId }) => {
        const def = nodeDefOf(runId, nodeId);
        // spec 230 — stale = the run worktree produced NOTHING vs its base (a no-op node fails even if
        // verify is green). Captured BEFORE verify (codex B1: verify artifacts — coverage/build output —
        // would otherwise mask a no-op). Uses `status` (counts untracked new files), not a bare diff.
        // FAIL CLOSED (codex M2): if we can't prove the node changed anything, treat it as stale.
        // Run-level (vs the run base); per-node-baseline staleness is a follow. A node that declares
        // `expectsChange: false` (read-only/review/planning) opts OUT — verify-passed alone completes it.
        let stale = false;
        if (def?.expectsChange !== false) {
          stale = true;
          const rec = this.pipelineRunWorktree(runId);
          if (rec) {
            try {
              stale = worktreeUnchanged(await this.worktrees.status(rec.path, rec.baseRef));
            } catch {
              stale = true; // probe failed → can't prove a change → stale
            }
          }
        }
        const st = await this.runVerify(nodeSpawnName(runId, nodeId, def ?? {})); // worktree-scoped; node row carries the run worktree
        return { passed: st.passed, stale };
      },
      dismissNode: (runId, nodeId) => {
        const def = nodeDefOf(runId, nodeId);
        const name = nodeSpawnName(runId, nodeId, def ?? {});
        // kill the session + drop the pipeline-tagged ledger row. A DECLARED `agent:` node reverts to a
        // clean config-listed STOPPED agent (no stale def.pipeline/nonce/run-worktree overlay — codex M1,
        // so planResume/verify never read a removed worktree); an inline `cmd:` node vanishes entirely.
        return this.manager.kill(name)
          .catch(async (error) => {
            // A naturally exited/missing pane is already safe. Any still-live or unprovable pane keeps
            // every cwd/ledger map so PipelineManager cannot release the run worktree underneath it.
            if (await this.tmux.hasSession(this.manager.session(name))) throw error;
          })
          .then(async () => {
            if (await this.tmux.hasSession(this.manager.session(name))) {
              throw new Error(`pipeline node '${name}' is still live after teardown`);
            }
            // Only absence proof permits removal of the runtime ownership handles.
            this.pipelineNodeCwd.delete(name);
            this.pipelineNodeOf.delete(name);
            // pin p-4dadd3 (a) / spec 247: an inline `cmd:` node (`pl-<runId>-<nodeId>`) vanishes entirely —
            // drop its orphaned durable log WITH the row (one named operation). A DECLARED `agent:` node reverts
            // to a persistent stopped agent and KEEPS its log (it has a real, reusable sidebar row) — row-only.
            if (!def?.agent) this.manager.removeEphemeralFootprint(name);
            else this.ledger.remove(name);
            this.refreshAgentsViews();
          });
      },
      persist: (run) => this.runLedger.save(run),
      persistInitial: (run) => this.runLedger.saveRequired(run),
      onChange: () => this.refreshAgentsViews(),
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    };
  }

  /**
   * spec 230 — on activation, restore in-memory pipeline runs from disk so a node agent that survived
   * a VS Code reload can still complete_node (the dogfood finding: a reload otherwise orphans the run →
   * "unknown or closed pipeline run/node"). Run graph ← run ledger; each running node's nonce/cwd ←
   * the session-ledger row (def.env). Terminal or worktree-gone runs are dropped.
   */
  private async rehydratePipelines(): Promise<void> {
    const restored: Array<{ run: PipelineRun; cwd: string; nonces: Record<string, string> }> = [];
    for (const persistedRun of this.runLedger.list()) {
      let run = persistedRun;
      const nonces: Record<string, string> = {};
      let cwd = run.worktree?.path ?? "";
      if (run.worktreeReady === false) {
        if (!run.worktree) {
          this.host.notify(this.t("pipeline {0} has an incomplete worktree receipt without a recovery record", run.id), "warn");
          continue;
        }
        try {
          await this.worktrees.completePersistedPreparation(run.worktree);
          run = { ...run, worktreeReady: true };
          this.runLedger.saveRequired(run);
        } catch (error) {
          this.host.notify(
            this.t("pipeline {0} worktree remains locked for recovery: {1}", run.id, error instanceof Error ? error.message : String(error)),
            "warn",
          );
          continue;
        }
      }
      if (run.worktree) this.pipelineRunWt.set(run.worktreeKey, run.worktree);
      for (const nodeId of Object.keys(run.nodes)) {
        const name = nodeSpawnName(run.id, nodeId, run.pipeline.nodes[nodeId] ?? {});
        const rec = this.ledger.get(name);
        const nonce = rec?.def?.env?.TACHYON_NODE_NONCE;
        if (nonce) nonces[nodeId] = nonce;
        if (rec?.worktree) {
          cwd = rec.worktree.path;
          this.pipelineRunWt.set(run.worktreeKey, rec.worktree);
          this.pipelineNodeCwd.set(name, { cwd: rec.worktree.path, worktree: rec.worktree });
          this.pipelineNodeOf.set(name, { runId: run.id, nodeId });
        }
      }
      if (!cwd || !fs.existsSync(cwd)) {
        this.runLedger.remove(run.id); // the run worktree is gone — can't reconcile; drop it
        continue;
      }
      restored.push({ run, cwd, nonces });
    }
    if (restored.length) this.pipelines.rehydrate(restored);
  }

  /** spec 257 — the probe inspector's render-model, built from the captured-run store (D9).
   *  spec 322 — `caller` scopes it to one launching agent's probes (the per-agent panel). */
  async probeView(caller?: string): Promise<ProbeView> {
    return buildProbeView(await this.probeStore.list(), Date.now(), caller);
  }

  /** spec 230 — pipeline names declared in `.tachyon/pipelines/*.{yml,yaml}`. */
  listPipelines(): string[] {
    const dir = path.join(this.workspaceRoot, ".tachyon", "pipelines");
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => /\.ya?ml$/.test(n))
        .map((n) => n.replace(/\.ya?ml$/, ""))
        .sort();
    } catch {
      return [];
    }
  }

  /** spec 230 — the worktree record of an active run (for the diff-review action); undefined once released. */
  pipelineRunWorktree(runId: string): WorktreeRecord | undefined {
    return this.pipelineRunWt.get(`run-${runId}`);
  }

  /** spec 230 — the on-disk path of a pipeline definition (existing `.yml`/`.yaml`, else the `.yml` default). */
  pipelineFilePath(name: string): string {
    const dir = path.join(this.workspaceRoot, ".tachyon", "pipelines");
    return [".yml", ".yaml"].map((e) => path.join(dir, `${name}${e}`)).find((p) => fs.existsSync(p)) ?? path.join(dir, `${name}.yml`);
  }

  /** spec 230 — delete a pipeline definition file. */
  deletePipelineFile(name: string): void {
    try {
      fs.rmSync(this.pipelineFilePath(name), { force: true });
    } catch {
      /* ignore */
    }
    this.refreshAgentsViews();
  }

  /** spec 231 — does this agent carry a persona (so a pipeline node referencing it may omit `task` under
   *  `input: required`)? True iff it declares non-empty instructions, an isolated harness, or a non-custom
   *  role template. Conservative — an unknown/bare agent returns false (→ `task` stays required). */
  private agentHasPersona = (name: string): boolean => {
    const a = this.config?.agents[name];
    if (!a) return false;
    if (typeof a.instructions === "string" && a.instructions.trim().length > 0) return true;
    if (a.harness) return true;
    if (a.role && a.role !== "custom") return true;
    return false;
  };

  private loadPipelineByName(name: string): { pipeline?: import("../pipeline/loadPipeline.js").PipelineDef; errors: string[]; file?: string } {
    const dir = path.join(this.workspaceRoot, ".tachyon", "pipelines");
    const file = [".yml", ".yaml"].map((e) => path.join(dir, `${name}${e}`)).find((p) => fs.existsSync(p));
    if (!file) return { errors: [`pipeline '${name}' not found`] };
    const known = new Set(Object.keys(this.config?.agents ?? {}));
    return { ...loadPipeline(fs.readFileSync(file, "utf8"), known, this.agentHasPersona), file };
  }

  /** spec 231 — true if `name` declares `input: required` (the ▶ Run flow must collect a run input). */
  pipelineNeedsInput(name: string): boolean {
    return this.loadPipelineByName(name).pipeline?.input === "required";
  }

  /** spec 231 — the per-run input file (the durable edit surface; the ledger snapshot is runtime-canonical). */
  runInputFilePath(runId: string): string {
    return path.join(this.workspaceRoot, ".tachyon", "runs", `${runId}.input.md`);
  }

  /** spec 351 — this workspace's caller-identity scope (workspace + this Bridge instance). */
  private callerScope(): CallerScope {
    return { workspaceId: this.wsHash, instanceId: this.bridgeInstanceId };
  }

  private bridgeInstanceIdStateKey(): string {
    return callerIdentityInstanceIdStateKey(this.wsHash);
  }

  private hostActionSessionEpochStateKey(): string {
    return hostActionSessionEpochStateKey(this.wsHash);
  }

  private callerRegistryStateKey(): string {
    return callerIdentityRegistryStateKey(this.wsHash);
  }

  private authorityHeadsSecretKey(): string {
    return authorityHeadsSecretKey(this.wsHash);
  }

  private authorityHeadMapKey(identity: string): string {
    return `canonical:${identity}`;
  }

  private async currentAuthorityHead(identity: string): Promise<AuthorityHead | undefined> {
    // A process-local snapshot is not an anti-rollback anchor: another extension host may have
    // advanced custody since this Workspace was created. Do not interleave this read with this
    // host's own read/modify/write, then refresh durable custody on every authority decision.
    await this.authorityHeadPrepareTail;
    const persisted = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
    this.authorityHeads = persisted;
    const head = persisted.get(this.authorityHeadMapKey(identity));
    return head ? { ...head } : undefined;
  }

  private async prepareAuthorityHead(
    identity: string,
    next: AuthorityHead,
    expectedMac?: string,
  ): Promise<void> {
    const prepared = this.authorityHeadPrepareTail.then(() =>
      this.prepareAuthorityHeadSerialized(identity, next, expectedMac)
    );
    // A refusal must not poison unrelated later preparations, while every caller still
    // receives its own exact failure.
    this.authorityHeadPrepareTail = prepared.catch(() => undefined);
    return prepared;
  }

  private async prepareAuthorityHeadSerialized(
    identity: string,
    next: AuthorityHead,
    expectedMac?: string,
  ): Promise<void> {
    if (!identity || !Number.isSafeInteger(next.revision) || next.revision < 1 || !/^[0-9a-f]{64}$/.test(next.mac)) {
      throw new Error("invalid authority freshness head");
    }
    // Refresh immediately before the RMW. Canonical writers are already serialized across
    // hosts by DeliveryStore's SQLite BEGIN IMMEDIATE; this merge prevents a second host's
    // committed head for another Delivery from being overwritten by a stale local snapshot.
    // If a host did race outside that lock, the readback below refuses rather than trusting it.
    this.authorityHeads = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
    const mapKey = this.authorityHeadMapKey(identity);
    const current = this.authorityHeads.get(mapKey);
    if (expectedMac === undefined) {
      if (current) {
        if (current.revision === next.revision && current.mac === next.mac) return;
        throw new Error(`authority head '${mapKey}' already exists with different state`);
      }
      if (next.revision !== 1) throw new Error(`initial authority head '${mapKey}' must start at revision 1`);
    } else {
      if (!current || current.mac !== expectedMac || next.revision !== current.revision + 1) {
        throw new Error(`authority head '${mapKey}' changed or attempted a non-monotonic update`);
      }
    }
    await this.commitAuthorityHead(mapKey, next);
  }

  /** Migration-only counterpart to `prepareAuthorityHeadSerialized`'s initial branch: establishes the
   * first head for `identity` at its already-existing revision N (any N >= 1) instead of the fixed
   * revision 1 that ordinary create requires. Guarded to only ever fire when there is no current head
   * (or the exact same head is being re-applied), so it can only plant a first anchor at a record's true
   * current version — there is no older signed state for that identity to roll back to. */
  private async establishInitialAuthorityHead(identity: string, head: AuthorityHead): Promise<void> {
    const established = this.authorityHeadPrepareTail.then(() =>
      this.establishInitialAuthorityHeadSerialized(identity, head)
    );
    this.authorityHeadPrepareTail = established.catch(() => undefined);
    return established;
  }

  private async establishInitialAuthorityHeadSerialized(identity: string, head: AuthorityHead): Promise<void> {
    if (!identity || !Number.isSafeInteger(head.revision) || head.revision < 1 || !/^[0-9a-f]{64}$/.test(head.mac)) {
      throw new Error("invalid authority freshness head");
    }
    this.authorityHeads = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
    const mapKey = this.authorityHeadMapKey(identity);
    const current = this.authorityHeads.get(mapKey);
    if (current) {
      if (current.revision === head.revision && current.mac === head.mac) return;
      throw new Error(`authority head '${mapKey}' already exists with different state`);
    }
    await this.commitAuthorityHead(mapKey, head);
  }

  private async commitAuthorityHead(mapKey: string, head: AuthorityHead): Promise<void> {
    const updated = new Map(this.authorityHeads);
    updated.set(mapKey, { ...head });
    await this.commitAuthorityHeads(updated, mapKey);
  }

  private async commitAuthorityHeads(updated: Map<string, AuthorityHead>, operation: string): Promise<void> {
    const serialized = serializeAuthorityHeads(updated);
    // SecretStorage is prepared before the workspace/SQLite commit. A crash after this await leaves
    // the head ahead of workspace state, which is an explicit fail-closed recovery condition.
    await this.host.setSecret(this.authorityHeadsSecretKey(), serialized);
    const persisted = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
    if (serializeAuthorityHeads(persisted) !== serialized) {
      this.authorityHeads = persisted;
      throw new Error(`authority head '${operation}' changed during durable prepare`);
    }
    this.authorityHeads = persisted;
  }

  private async retireAuthorityHead(identity: string, expectedMac?: string): Promise<void> {
    const retired = this.authorityHeadPrepareTail.then(async () => {
      if (!identity) throw new Error("invalid authority freshness identity");
      this.authorityHeads = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
      const mapKey = this.authorityHeadMapKey(identity);
      const current = this.authorityHeads.get(mapKey);
      if (!current) return;
      if (expectedMac !== undefined && current.mac !== expectedMac) {
        throw new Error(`authority head '${mapKey}' changed before retirement`);
      }
      const updated = new Map(this.authorityHeads);
      updated.delete(mapKey);
      await this.commitAuthorityHeads(updated, `retire:${mapKey}`);
    });
    this.authorityHeadPrepareTail = retired.catch(() => undefined);
    return retired;
  }

  private async moveAuthorityHead(
    fromIdentity: string,
    toIdentity: string,
    next: AuthorityHead,
    expectedMac: string,
  ): Promise<void> {
    const moved = this.authorityHeadPrepareTail.then(async () => {
      if (!fromIdentity || !toIdentity || fromIdentity === toIdentity
        || !Number.isSafeInteger(next.revision) || next.revision < 1
        || !/^[0-9a-f]{64}$/.test(next.mac) || !/^[0-9a-f]{64}$/.test(expectedMac)) {
        throw new Error("invalid authority freshness move");
      }
      this.authorityHeads = parseAuthorityHeads(await this.host.getSecret(this.authorityHeadsSecretKey()));
      const fromKey = this.authorityHeadMapKey(fromIdentity);
      const toKey = this.authorityHeadMapKey(toIdentity);
      const current = this.authorityHeads.get(fromKey);
      const destination = this.authorityHeads.get(toKey);
      if (!current || current.mac !== expectedMac) {
        if (!current && destination?.revision === next.revision && destination.mac === next.mac) return;
        throw new Error(`authority head '${fromKey}' changed before move`);
      }
      if (destination && (destination.revision !== next.revision || destination.mac !== next.mac)) {
        throw new Error(`authority head '${toKey}' already exists with different state`);
      }
      const updated = new Map(this.authorityHeads);
      updated.delete(fromKey);
      updated.set(toKey, { ...next });
      await this.commitAuthorityHeads(updated, `move:${fromKey}->${toKey}`);
    });
    this.authorityHeadPrepareTail = moved.catch(() => undefined);
    return moved;
  }

  private canonicalAuthorityHeadPort(): AuthorityHeadPort {
    return {
      current: (identity) => this.currentAuthorityHead(identity),
      prepare: (identity, next, expectedMac) => this.prepareAuthorityHead(identity, next, expectedMac),
      establishInitial: (identity, head) => this.establishInitialAuthorityHead(identity, head),
      retire: (identity, expectedMac) => this.retireAuthorityHead(identity, expectedMac),
      move: (fromIdentity, toIdentity, next, expectedMac) => this.moveAuthorityHead(fromIdentity, toIdentity, next, expectedMac),
    };
  }

  /** spec 351 T6 — persist the digest-only registry snapshot after every mint/revoke, so a surviving tmux
   *  session resolves across a reload (workspaceState only ever holds digests — never a plaintext token,
   *  same invariant as the in-memory registry). Sweeps orphans first to bound growth. */
  private persistCallerRegistry(): void {
    if (!this.callerRegistry) return;
    this.callerRegistry.sweepOrphans();
    this.host.setState(this.callerRegistryStateKey(), this.callerRegistry.toPersistable());
  }

  /** spec 351 (dueto F1) — "every legacy-authenticated call is logged with tool + claimed identity": an
   *  append-only, best-effort JSONL line under .tachyon/. Never throws — a logging failure must not turn
   *  into a Bridge request failure. */
  private logLegacyBridgeCall(info: { tool: string; claimedIdentity?: string }): void {
    try {
      const file = path.join(this.workspaceRoot, ".tachyon", "legacy-bridge-calls.log");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // spec 351 (dueto F8) — belt-and-suspenders: `claimedIdentity` is a self-declared identity STRING by
      // contract, never the bearer itself, but redact defensively in case a caller passes a token-shaped
      // value there anyway.
      const safe = { ts: new Date().toISOString(), tool: info.tool, ...(info.claimedIdentity ? { claimedIdentity: redactSecrets(info.claimedIdentity, [this.token, this.externalToken].filter((s): s is string => !!s)) } : {}) };
      fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, "utf8");
    } catch {
      // best-effort — never let logging break a legacy-authenticated request.
    }
  }

  /** spec 236 — the claude-shaped Bridge MCP entry injected into every Tachyon-spawned agent (harness
   *  file fold + non-harness --mcp-config). undefined until the Bridge has bound a port; the token stays
   *  a literal `${TACHYON_AGENT_BRIDGE_TOKEN}` ref (spec 351 — this agent's own minted token) expanded
   *  from the spawn env (no secret on disk/argv). */
  private bridgeEntry(): Record<string, unknown> | undefined {
    return this.bridge.url ? expectedAgentClaudeEntry(this.bridge.url, !!this.token) : undefined;
  }

  /** spec 236 — the opencode-shaped Bridge `mcp.<server>` entry injected into a Tachyon-spawned opencode
   *  agent's OWN opencode config file (the file pointed at by OPENCODE_CONFIG). undefined until the
   *  Bridge has bound a port; the token stays a literal `{env:TACHYON_AGENT_BRIDGE_TOKEN}` ref (opencode
   *  resolves `{env:VAR}` at runtime) so this agent's own minted per-agent token resolves from the
   *  spawn env (no secret on disk or argv). */
  private bridgeEntryOpencode(): Record<string, unknown> | undefined {
    return this.bridge.url ? expectedAgentOpencodeEntry(this.bridge.url, !!this.token) : undefined;
  }

  /** spec 230 — load + validate + start a pipeline by name. `input` (spec 231) is required when the
   *  pipeline declares `input: required` — fail-closed if missing. Returns the run id, or null on error. */
  async startPipeline(name: string, input?: string): Promise<string | null> {
    const { pipeline, errors, file } = this.loadPipelineByName(name);
    if (!file) {
      this.host.notify(this.t("pipeline '{0}' not found in .tachyon/pipelines/", name), "warn");
      return null;
    }
    if (!pipeline) {
      this.host.notify(this.t("pipeline '{0}' is invalid: {1}", name, errors.join("; ")), "error");
      return null;
    }
    // a pipeline node runs in the RUN's worktree, so a referenced agent must not own one (spec 230).
    const owns = Object.values(pipeline.nodes)
      .map((n) => n.agent)
      .filter((a): a is string => !!a && !!this.config?.agents[a]?.worktree);
    if (owns.length > 0) {
      this.host.notify(this.t("pipeline '{0}': agent(s) {1} own a worktree — pipeline agents must not (the run owns the worktree)", name, [...new Set(owns)].join(", ")), "error");
      return null;
    }
    // spec 231 — `input: required` fails closed without a non-empty input (no silent empty run).
    const trimmed = input?.trim() ?? "";
    if (pipeline.input === "required" && trimmed.length === 0) {
      this.host.notify(this.t("pipeline '{0}' requires an input — none provided", name), "warn");
      return null;
    }
    // spec 232 — preflight: a signal-based node whose agent can't reach the Bridge would hang to timeout.
    // Fail closed on a provably-can't node; warn (with the fix) on an unprovable one, then proceed.
    const bridgeUp = !!this.bridgeUrl();
    for (const [nodeId, node] of Object.entries(pipeline.nodes)) {
      if (node.done !== "signal" && node.done !== "signal_then_verify") continue;
      const cmd = node.agent ? (this.config?.agents[node.agent]?.cmd ?? "") : (node.cmd ?? "");
      const runtime = nodeRuntimeOf(binaryOf(cmd));
      // spec 236 — claude --safe-mode disables MCP, so even the injected Bridge can't load → can't signal.
      const mcpDisabled = /(^|\s)--safe-mode(=|\s|$)/.test(cmd);
      const verdict = nodeCanSignal({ done: node.done, runtime, bridgeUp, mcpDisabled });
      if (verdict === "cannot") {
        this.host.notify(this.t("pipeline '{0}': node '{1}' can't signal completion (the Tachyon Bridge isn't running) — start it and re-run", name, nodeId), "error");
        return null;
      }
      if (verdict === "unprovable") {
        this.host.notify(this.t("pipeline '{0}': node '{1}' ({2}) may be unable to call complete_node — register the Bridge MCP for it, or it could hang", name, nodeId, runtime), "warn");
      }
    }
    const runId = await this.pipelines.start(pipeline, pipeline.input === "required" ? trimmed : undefined);
    // persist the durable per-run input file (the ledger snapshot stays runtime-canonical).
    if (pipeline.input === "required") {
      try {
        fs.mkdirSync(path.dirname(this.runInputFilePath(runId)), { recursive: true });
        fs.writeFileSync(this.runInputFilePath(runId), `${trimmed}\n`, "utf8");
      } catch {
        /* best-effort — the ledger snapshot is the source of truth */
      }
    }
    this.host.notify(this.t("▶ pipeline '{0}' started (run {1})", name, runId));
    this.refreshAgentsViews();
    return runId;
  }

  /** Rig/demo hook (the screenshot scene): seed a synthetic mid-run state for `name` so the Pipelines
   *  tree renders a representative run — early nodes `done`, the next `running`, and a `gate: approve`
   *  node parked at `awaiting-approval`. No agents/worktree are spawned. Returns the run id or null. */
  seedPipelineRun(name: string): string | null {
    const { pipeline } = this.loadPipelineByName(name);
    if (!pipeline) return null;
    const ids = Object.keys(pipeline.nodes);
    const run = initRun("demo01", pipeline, "run-demo01", pipeline.input === "required" ? "Add a dark-mode toggle to Settings, persist the choice." : undefined);
    const gateIdx = ids.findIndex((id) => pipeline.nodes[id].gate === "approve");
    // upstream of the gate (or all-but-last when there's no gate) → done; the gate → awaiting-approval;
    // with no gate, the last node is shown `running`. Nodes after the gate stay `pending` (initRun default).
    ids.forEach((id, i) => {
      if (gateIdx >= 0) {
        if (i < gateIdx) run.nodes[id] = { status: "done" };
        else if (i === gateIdx) run.nodes[id] = { status: "awaiting-approval" };
      } else {
        run.nodes[id] = { status: i === ids.length - 1 ? "running" : "done" };
      }
    });
    this.pipelines.seedRun(run);
    this.refreshAgentsViews();
    return run.id;
  }

  /** spec 231 — re-read the per-run input file into the ledger snapshot (the "Edit input" action; only
   *  not-yet-started nodes pick up the change). No-op if the run/file is gone. */
  applyRunInput(runId: string): void {
    try {
      const text = fs.readFileSync(this.runInputFilePath(runId), "utf8").trim();
      this.pipelines.setInput(runId, text);
      this.refreshAgentsViews();
    } catch {
      /* nothing to apply */
    }
  }

  /** Persistent-engine entry: the daemon owns the public Bridge listener directly. */
  static async createDaemon(workspaceRoot: string, deps: WorkspaceDeps): Promise<Workspace> {
    return Workspace._create(workspaceRoot, deps);
  }

  /** spec 235 — headless test entry: inject a fake-exec tmux + no-op engine + `startBridge:false` to drive
   *  the Workspace with no Electron / real tmux / bound port. */
  static async createForTest(workspaceRoot: string, deps: WorkspaceDeps, seams: WorkspaceSeams): Promise<Workspace> {
    return Workspace._create(workspaceRoot, deps, seams);
  }

  private static async _create(workspaceRoot: string, deps: WorkspaceDeps, seams: WorkspaceSeams = {}): Promise<Workspace> {
    const ws = new Workspace(workspaceRoot, deps, seams);
    void ws.engine.start().catch(() => {
      /* degraded from birth — executor falls back, reconnect loop is running */
    });

    // spec 351 — machine-local HMAC key custody (VS Code SecretStorage): loaded/created BEFORE the Bridge
    // binds a port or any agent could spawn, so mintAgentToken never misses a real spawn in production.
    // A headless test host (no getSecret wired) degrades to no per-agent tokens (legacy path only).
    try {
      const persisted = deps.host.getState<PersistableEntry[]>(ws.callerRegistryStateKey()) ?? [];
      const hmacKey = await loadOrCreateHmacKey(deps.host);
      const authorityHeads = parseAuthorityHeads(await deps.host.getSecret(ws.authorityHeadsSecretKey()));
      ws.authorityIntegrityKey = hmacKey;
      ws.authorityHeads = authorityHeads;
      ws.callerRegistry = new CallerIdentityRegistry(hmacKey, persisted);
    } catch (err) {
      ws.host.notify(ws.t("per-agent Bridge tokens and authority custody unavailable: {0} (falling back to the shared token; gated authority remains fail-closed)", err instanceof Error ? err.message : String(err)), "warn");
    }

    try {
      // Load config before the Bridge so settings.bridgePort applies; default is a
      // stable per-workspace derived port, so registrations survive editor restarts.
      ws.reloadConfig();
      // SDD 368 T14/R4 — one bounded Delivery reload before Bridge exposure or return,
      // so ensureWorkspaceFor / createForTest never leave callers on `uninitialized`.
      // start() still recomputes after rehydrate/GC (failed→ready retry + ledger truth).
      await ws.attemptDeliveryReloadSnapshot();
      if (seams.startBridge !== false) {
        const preferred = ws.config?.settings.bridgePort ?? derivePort(ws.wsHash);
        const port = await ws.startBridgeListener(preferred);
        if (port !== preferred) {
          ws.host.notify(
            ws.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and reload).", preferred, port),
            "warn",
          );
        }
        // A Workspace is created only by a new persistent-engine incarnation. Shell attach/reload never
        // reaches this path, so survivor recovery is bound to an actual engine restart.
        void (async () => {
          await ws.recoverPendingHostActionReload();
          await ws.clientRebind?.onListenerReady();
          ws.refreshAgentsViews();
        })();
      }
    } catch (err) {
      ws.notifyBridgeStartFailure(err);
    }

    // tachyon.yml edits reflect live (config + watches + views).
    const onConfigChange = () => {
      const portBefore = ws.config?.settings.bridgePort;
      const agentsBefore = new Set(Object.keys(ws.config?.agents ?? {}));
      ws.reloadConfig();
      ws.rebuildWatches();
      ws.refreshAgentsViews();
      // dogfood p-5a2a83 follow-up: an autostart agent ADDED by a live tachyon.yml edit starts
      // now (parity with the Studio create path), without re-spawning a pre-existing/stopped one.
      void ws.autostartNewlyDeclared(agentsBefore);
      deps.onViewsChanged("commands");
      if (ws.config?.settings.bridgePort !== portBefore) {
        ws.host.notify(ws.t("bridgePort changed — run Tachyon: Restart Bridge to apply it"), "warn");
      }
      if ((ws.config?.settings.auth ?? true) !== ws.authEnabled) {
        ws.host.notify(ws.t("settings.auth changed — reload the window to apply it"), "warn");
      }
    };
    ws.disposables.push(ws.host.watch(workspaceRoot, "tachyon.{yml,yaml}", { change: true, create: true }, onConfigChange));

    // Manual edits to .tachyon/* (or agent writes through another window) reflect live.
    const refreshTachyonDir = () => {
      deps.onViewsChanged("pins");
      deps.onViewsChanged("schedules"); // pending proposals live here too
    };
    ws.disposables.push(ws.host.watch(workspaceRoot, ".tachyon/*", { change: true, create: true, delete: true }, refreshTachyonDir));

    const refreshTaskFiles = () => {
      if (ws.taskFileRefreshTimer) clearTimeout(ws.taskFileRefreshTimer);
      ws.taskFileRefreshTimer = setTimeout(() => {
        ws.taskFileRefreshTimer = undefined;
        deps.onViewsChanged("tasks");
      }, TASK_FILE_REFRESH_DEBOUNCE_MS);
    };
    ws.disposables.push(ws.host.watch(workspaceRoot, ".tachyon/tasks/*.json", { change: true, create: true, delete: true }, refreshTaskFiles));

    // Schedules tick on the heartbeat; activate anchors every-schedules + catch-up.
    ws.scheduler.activate();
    ws.ticker = setInterval(() => void ws.tick(), ATTENTION_POLL_MS);

    // Upgrade notice: MCP clients cache the Bridge tool schema at THEIR session start.
    const currentVersion = deps.host.appVersion();
    const lastVersion = deps.host.getState<string>(workspaceVersionStateKey(ws.wsHash));
    if (lastVersion && lastVersion !== currentVersion && (await ws.manager.runningAgents()).length > 0) {
      ws.host.notify(
        ws.t(
          "Tachyon was updated ({0} → {1}) — running agents keep the old Bridge tools until restarted (↻ in the sidebar)",
          lastVersion,
          currentVersion,
        ),
        "warn",
      );
    }
    deps.host.setState(workspaceVersionStateKey(ws.wsHash), currentVersion);

    return ws;
  }

  get folderName(): string {
    return path.basename(this.workspaceRoot);
  }

  /** spec 245 — cheap "project activity" proxy for handoff staleness: the SessionStart ownership ledger's mtime
   *  (advances on every agent startup/resume/clear). Null when absent → staleness falls back to pending + age. */
  lastActivityAt(): string | null {
    try { return fs.statSync(sessionOwnersFile(this.workspaceRoot)).mtime.toISOString(); } catch { return null; }
  }

  /** sidebar accessors */
  bridgeUrl(): string | undefined {
    return this.bridge.url;
  }

  /** SDD 414 — companion loopback base (no path), undefined if Bridge is down. */
  companionBaseUrl(): string | undefined {
    const port = this.bridge.listenerPort;
    return port === undefined ? undefined : `http://127.0.0.1:${port}`;
  }

  /** SDD 414 — mint a short-lived pair code for Tachyon Companion. */
  issueCompanionPairCode(): IssuedPairCode | { ok: false; reason: "bridge_down" } {
    return this.companion.issuePairCode();
  }

  /** SDD 414 — companion HTTP prefix on the Bridge listener. */
  companionHttpPrefix(): string {
    return COMPANION_HTTP_PREFIX;
  }

  /**
   * SDD 414 item 3 (MVP, evolving) — running agents only, with attention snapshot for the Companion UI.
   */
  async companionListActiveAgents(): Promise<CompanionAgentRow[]> {
    const running = await this.manager.runningAgents();
    const rows: CompanionAgentRow[] = [];
    for (const name of running) {
      if (this.manager.kindOf(name) !== "agent") continue;
      const att = this.attentionOf(name);
      rows.push({
        name,
        attention: att?.state ?? "unknown",
        composerOccupied: !!att?.composerOccupied,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }


  /** Sidebar agents view + Companion live agent list (SSE). Safe before companionLive is constructed. */
  refreshAgentsViews(): void {
    try {
      this.deps.onViewsChanged("agents");
    } catch {
      /* host optional */
    }
    try {
      (this as { companionLive?: CompanionLiveSync }).companionLive?.notifyChanged();
    } catch {
      /* best-effort */
    }
  }

  /** SDD 414 / t-a45c6b — pending human-approval requests for Companion UI. */
  async companionListApprovals(): Promise<CompanionApprovalSummary[]> {
    return listPendingApprovalRequests(this.workspaceRoot).map((r) => ({
      id: r.id,
      requester: r.requester,
      reason: r.payload.reason,
      proposedAction: r.payload.proposedAction,
      risk: r.payload.risk,
      exactPrompt: r.payload.exactPrompt,
      createdAt: r.createdAt,
      status: "pending" as const,
    }));
  }

  /**
   * SDD 414 / t-a45c6b — host-authoritative Accept/Deny (same resolveApproval path as Control UI).
   * Never a Bridge agent tool — only Companion HTTP with session token.
   */
  async companionResolveApproval(
    id: string,
    decision: ApprovalDecision,
  ): Promise<CompanionResolveApprovalResponse> {
    try {
      const result = await resolveApproval({
        workspaceRoot: this.workspaceRoot,
        id,
        decision,
        resolvedBy: "companion",
        currentSessionOwner: async (session) =>
          (await this.manager.list()).find((entry) => entry.session === session && entry.running)?.name,
        inject: async (session, text) => {
          await this.tmux.sendSubmittedLine(session, text);
          return { receipt: `tmux:${session}` };
        },
        completePin: (pinId) => {
          try {
            this.pinStore.setDone(pinId, true);
          } catch {
            /* best-effort */
          }
        },
      });
      this.afterApprovalResolved(result.request.id);
      return {
        ok: true,
        id: result.request.id,
        status: decision,
        ...(result.injectError ? { injectError: result.injectError } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already resolved") || message.includes("cancelled")) {
        return { ok: false, code: "not_pending", message };
      }
      if (message.includes("not found") || message.includes("No such file") || message.includes("ENOENT")) {
        return { ok: false, code: "not_found", message };
      }
      return { ok: false, code: "unknown", message };
    }
  }

  /**
   * After any host-authoritative approval resolve: refresh Control/pins, Companion SSE,
   * and drop matching durable Attention notices (the toast card is independent of the ledger).
   */
  afterApprovalResolved(approvalId: string): void {
    this.dismissApprovalAttentionNotices(approvalId);
    try {
      this.deps.onViewsChanged("pins");
      this.refreshAgentsViews();
    } catch {
      /* host optional */
    }
    try {
      this.companionLive.pushEvent("approvals.changed", { id: approvalId });
    } catch {
      /* best-effort */
    }
  }

  /**
   * routeHumanApprovalRequest creates a durable notice-inbox card ("approval request a-… from '…'").
   * Resolving the ledger does not auto-dismiss that card — clear entries that mention this id.
   */
  private dismissApprovalAttentionNotices(approvalId: string): void {
    const host = this.host as EngineHost & {
      listNoticeInbox?: () => Array<{ id: string; message: string }>;
      markNoticeRead?: (id: string) => boolean;
    };
    const rows = host.listNoticeInbox?.() ?? [];
    if (!rows.length || !host.markNoticeRead) return;
    const needle = approvalId.toLowerCase();
    for (const row of rows) {
      if (row.message.toLowerCase().includes(needle)) {
        try {
          host.markNoticeRead(row.id);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /**
   * SDD 414 item 3 (MVP, evolving) — send a one-line prompt to a running agent.
   * Uses deliverNotice: idle → submit now; working/throttled/needs-input/composer → queue until idle.
   */
  async companionSendPrompt(agent: string, text: string): Promise<SendPromptResponse> {
    const name = agent.trim();
    if (!name) {
      return { ok: false, code: "not_agent", message: "Agent name is required." };
    }
    if (this.manager.kindOf(name) !== "agent") {
      return { ok: false, code: "not_agent", message: `'${name}' is not an agent (terminals cannot receive companion prompts).` };
    }
    const running = await this.manager.runningAgents();
    if (!running.includes(name)) {
      return { ok: false, code: "not_running", message: `Agent '${name}' is not running. v1 only targets active agents.` };
    }
    try {
      if (!(await this.manager.isReady(name))) {
        return {
          ok: false,
          code: "not_ready",
          message: `Agent '${name}' is still bootstrapping (runtime not ready). Wait for the prompt, then retry.`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        code: "unknown",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const summary = prepareAgentSummary(text);
    if (!summary) {
      return { ok: false, code: "empty", message: "Message is empty after sanitizing." };
    }
    const line = composeAgentNotice("companion", name, summary);
    try {
      const result = await this.deliverNotice(name, line);
      return {
        ok: true,
        status: result.status,
        agent: name,
        ...(result.dropped !== undefined ? { dropped: result.dropped } : {}),
        ...(result.queued !== undefined ? { queued: result.queued } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        code: "unknown",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** t-7f94f2 — human notice inbox (daemon host only; empty on VsCodeHost-only shells). */
  listNoticeInbox(): import("./noticeInbox.js").NoticeInboxEntry[] {
    const host = this.host as EngineHost & { listNoticeInbox?: () => import("./noticeInbox.js").NoticeInboxEntry[] };
    return host.listNoticeInbox?.() ?? [];
  }

  markNoticeRead(id: string): boolean {
    const host = this.host as EngineHost & { markNoticeRead?: (id: string) => boolean };
    return host.markNoticeRead?.(id) ?? false;
  }

  markAllNoticesRead(): boolean {
    const host = this.host as EngineHost & { markAllNoticesRead?: () => boolean };
    return host.markAllNoticesRead?.() ?? false;
  }

  async invokeNoticeInboxAction(noticeId: string, actionId: string): Promise<boolean> {
    const host = this.host as EngineHost & { invokeNoticeAction?: (noticeId: string, actionId: string) => Promise<void> };
    if (!host.invokeNoticeAction) return false;
    try {
      await host.invokeNoticeAction(noticeId, actionId);
      return true;
    } catch {
      return false;
    }
  }

  bridgeStartFailureInfo(): BridgeStartFailureInfo | undefined {
    return this.lastBridgeStartFailure ? { ...this.lastBridgeStartFailure } : undefined;
  }

  /** Serialize Bridge restarts so concurrent reloadConfig lanAccess flips cannot race dispose/start. */
  private bridgeRestartChain: Promise<number> | undefined;

  async restartBridge(): Promise<number> {
    const run = async (): Promise<number> => {
      const preferred = this.config?.settings.bridgePort ?? derivePort(this.wsHash);
      await this.bridge.dispose();
      const port = await this.startBridgeListener(preferred);
      if (port !== preferred) {
        this.host.notify(
          this.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and restart the Bridge).", preferred, port),
          "warn",
        );
      }
      this.refreshAgentsViews();
      return port;
    };
    const next = (this.bridgeRestartChain ?? Promise.resolve(0)).then(run, run);
    this.bridgeRestartChain = next.then(
      (p) => p,
      () => 0,
    );
    return next;
  }

  async stopBridge(): Promise<void> {
    await this.bridge.dispose();
    this.refreshAgentsViews();
  }

  private async startBridgeListener(preferred: number): Promise<number> {
    const lanAccess = this.config?.settings.companion?.lanAccess === true;
    const port = await this.bridge.start(preferred, { host: companionListenHost(lanAccess) });
    this.lastBridgeStartFailure = undefined;
    return port;
  }

  private rememberBridgeStartFailure(error: unknown): BridgeStartFailureInfo {
    const failure = {
      code: "BRIDGE_START_FAILED",
      message: "Bridge could not start. Run Tachyon: Doctor for details, then retry the Bridge.",
      technicalDetail: boundedBridgeFailureDetail(error instanceof Error ? error.stack ?? error.message : String(error)),
    };
    if (
      this.lastBridgeStartFailure?.code === failure.code
      && this.lastBridgeStartFailure.message === failure.message
      && this.lastBridgeStartFailure.technicalDetail === failure.technicalDetail
    ) return this.lastBridgeStartFailure;
    this.lastBridgeStartFailure = failure;
    console.warn(`[tachyon] ${failure.code}: ${failure.technicalDetail}`);
    return failure;
  }

  private notifyBridgeStartFailure(error: unknown): void {
    const failure = this.rememberBridgeStartFailure(error);
    this.host.notify(failure.message, "error", [
      {
        label: "Retry Bridge",
        run: async () => {
          try {
            await this.restartBridge();
            this.host.notify("Bridge restarted.");
          } catch (retryError) {
            this.notifyBridgeStartFailure(retryError);
          }
        },
      },
      { label: "Run Doctor", run: () => this.host.executeCommand("tachyon.doctor", this.wsHash).then(() => undefined) },
    ]);
  }
  attentionOf(agent: string): AgentAttention | undefined {
    // t-9552f3 — after notify_agent, present finished turns as idle for sidebar/backstop.
    // t-a39c7d — seenAfterHint keeps idle after human look without re-raising done.
    return applyCompletionHint(
      this.monitor.stateOf(agent),
      this.completionHints.has(agent),
      this.completionHints.isSeen(agent),
    );
  }

  /** t-a39c7d — human opened/focused the agent pane; decay done(unseen) → idle. */
  markAgentPaneSeen(agent: string): void {
    this.monitor.markSeen(agent);
    this.completionHints.markSeen(agent);
  }

  /**
   * spec 216 (Part C) — re-anchor an agent to its role: (re)write the durable per-agent role
   * doc, then type a compact reminder into its terminal pointing back at it. Used both by the
   * opt-in auto path (on idle-after-compaction) and the always-on manual command/Bridge tool.
   * Best-effort: no-op if the agent isn't running.
   */
  async reanchor(agent: string): Promise<void> {
    // spec 216 (codex r1 M3): re-anchoring types a role reminder into the pane — agents only.
    // The UI menu gates on `-ai`, but the Bridge tool calls this directly, so guard here too:
    // injecting a `cat .tachyon/roles/…` line into a terminal/server would be wrong.
    if (this.manager.kindOf(agent) !== "agent") throw new Error(`'${agent}' is a terminal — re-anchoring applies only to agents`);
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session))) throw new Error(`agent '${agent}' is not running`);
    const def = this.manager.defOf(agent);
    const canonicalGate = await this.canonicalPrimerGate(agent);
    const sessionEvolution = this.ledger.get(agent)?.evolution;
    if (def?.soul) {
      const previous = this.ledger.get(agent)?.identity;
      try {
        const soul = await this.manager.resolveSoulForLifecycle(agent);
        if (!soul) throw new Error(`agent '${agent}' has no enabled soul`);
        const { primer, beforeFinishing } = renderPrimer({
          agentName: agent,
          delegator: this.manager.delegatorOf(agent),
          parent: this.manager.parentOf(agent),
          gate: canonicalGate,
          verify: this.config?.settings.verify,
        });
        const body = composeAgentPrompt({
          soul,
          role: def.role,
          instructions: def.instructions,
          evolution: sessionEvolution,
          bridgeGuidance: !!this.manager.parentOf(agent) && (this.config?.settings.bridgeGuidance ?? true),
          taskBrief: this.ledger.get(agent)?.def?.taskBrief,
        }).body ?? "";
        const dir = path.join(this.workspaceRoot, ".tachyon", "anchors");
        const abs = path.join(dir, `${agent}.md`);
        writePrivateFileAtomic(abs, `${body}\n`);
        const transition = previous?.soul.sha256 && previous.soul.sha256 !== soul.sha256 ? ` (${previous.soul.sha256.slice(0, 12)}→${soul.sha256.slice(0, 12)})` : "";
        const pointer = `[Tachyon] Re-anchor identity${transition}: read the complete current contract with: cat ${shellQuote(abs)}`;
        await this.tmux.sendKeys(session, `${primer}\n\n${pointer}\n\n${beforeFinishing}`, true);
        const rec = this.ledger.get(agent);
        if (rec) this.ledger.record(agent, { ...rec, identity: { soul: { profileId: soul.profileId, source: soul.source, sha256: soul.sha256, chars: soul.chars, bytes: soul.bytes, offeredAt: new Date().toISOString(), channel: "reanchor-pointer", state: "offered" }, health: "offered" } });
        return;
      } catch (error) {
        const rec = this.ledger.get(agent);
        if (rec?.identity) this.ledger.record(agent, { ...rec, identity: { ...rec.identity, health: "identity-degraded", degradedAt: new Date().toISOString(), degradedCode: error instanceof SoulError ? error.code : "soul/io-error" } });
        this.host.notify(this.t("agent '{0}' identity re-anchor failed; repair the soul and retry re-anchor manually", agent), "warn");
        throw error;
      }
    }
    const relPath = path.join(".tachyon", "roles", `${agent}.md`);
    // Resolve the complete project-owned block before writing the role artifact or touching the
    // pane. A configured-but-invalid source must leave the running agent exactly as it was.
    const projectGuidance = loadAndRenderProjectGuidance(
      this.workspaceRoot,
      this.config?.settings.projectGuidance,
    );
    if (sessionEvolution) {
      const composed = composeAgentPrompt({
        role: def?.role,
        instructions: def?.instructions,
        evolution: sessionEvolution,
        bridgeGuidance: !!this.manager.parentOf(agent) && (this.config?.settings.bridgeGuidance ?? true),
        taskBrief: this.ledger.get(agent)?.def?.taskBrief,
      }).body;
      const body = [projectGuidance, composed]
        .filter((part): part is string => !!part?.trim())
        .join("\n\n");
      const frame = (deliverable: string): string => wrapWithPrimer(deliverable, {
        agentName: agent,
        delegator: this.manager.delegatorOf(agent),
        parent: this.manager.parentOf(agent),
        gate: canonicalGate,
        verify: this.config?.settings.verify,
      });
      assertSafeBriefTransport(
        frame(previewDeliverableBody(this.workspaceRoot, agent, body, "reanchor")),
        `agent '${agent}' re-anchor brief`,
      );
      const injection = frame(deliverableBody(this.workspaceRoot, agent, body, "reanchor"));
      assertSafeBriefTransport(injection, `agent '${agent}' re-anchor brief`);
      await this.tmux.sendKeys(session, injection, true);
      return;
    }
    try {
      const abs = path.join(this.workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildRoleDoc(agent, def?.role, def?.instructions), "utf8");
    } catch {
      // a missing role doc just weakens the reminder; the inline role name still re-anchors
    }
    // Specs 363/383 — re-anchor uses the same ownership ordering as startup: Tachyon protocol,
    // project-owned body, then the closing protocol reminder. Long bodies go to a purpose-specific
    // file so the original startup brief remains intact and tmux receives only a compact pointer.
    const body = [projectGuidance, roleReminder(def?.role, relPath)]
      .filter((part): part is string => !!part?.trim())
      .join("\n\n");
    const frame = (deliverable: string): string => wrapWithPrimer(deliverable, {
      agentName: agent,
      delegator: this.manager.delegatorOf(agent),
      parent: this.manager.parentOf(agent),
      gate: canonicalGate,
      verify: this.config?.settings.verify,
    });
    // Preflight the exact pointer framing before replacing a prior re-anchor artifact.
    assertSafeBriefTransport(
      frame(previewDeliverableBody(this.workspaceRoot, agent, body, "reanchor")),
      `agent '${agent}' re-anchor brief`,
    );
    const deliverable = deliverableBody(this.workspaceRoot, agent, body, "reanchor");
    const injection = frame(deliverable);
    assertSafeBriefTransport(injection, `agent '${agent}' re-anchor brief`);
    await this.tmux.sendKeys(session, injection, true);
  }

  /** Primer metadata is advisory, but it must still come from the exact canonical binding. */
  private async canonicalPrimerGate(agent: string): Promise<{ behaviorTest: string; owns: string[]; stubPath?: string } | undefined> {
    const binding = this.ledger.get(agent)?.delivery;
    if (!isValidDeliveryBinding(binding)) return undefined;
    try {
      const delivery = await this.deliveries.get(binding.deliveryId);
      const holder = delivery?.lease.holder;
      if (!delivery || !holder || holder.segmentId !== binding.segmentId || holder.executionAgent !== agent) return undefined;
      const segment = delivery.segments.find((candidate) => candidate.id === binding.segmentId);
      if (!segment || segment.executionAgent !== agent || segment.releasedAt) return undefined;
      return {
        behaviorTest: delivery.contract.behaviorTest,
        owns: [...segment.ownsSubset],
        ...(delivery.contract.stubPath ? { stubPath: delivery.contract.stubPath } : {}),
      };
    } catch {
      return undefined;
    }
  }

  // ───────────────────────── spec 241 — per-agent continuity ─────────────────────────
  /** D4 staleness threshold (activity records) past which an injected brief is flagged "may be stale". */
  private static readonly CONTINUITY_STALE_LAG = 100;

  /** The current activity "seq" = record count of the durable per-agent log (cheap; the freshness anchor, D4). */
  currentActivitySeq(agent: string): number | undefined {
    try {
      const file = path.join(this.workspaceRoot, ".tachyon", "activity", `${agentLogId(agent)}.jsonl`);
      const raw = fs.readFileSync(file, "utf8");
      if (raw.length === 0) return 0;
      let n = 0;
      for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
      return raw.endsWith("\n") ? n : n + 1;
    } catch {
      return undefined;
    }
  }

  /** spec 241 D5 — reap an agent's continuity (brief + state) on explicit delete. Best-effort. */
  removeContinuity(agent: string): void {
    this.continuityStore.remove(agent);
    this.continuityState.remove(agent);
  }

  /**
   * t-8310ca — drop continuity brief/state (+ matching activity logs) for agent names that are not
   * declared, not live in tmux, and not in the session ledger. Complements forgetAgent when dismiss
   * never ran. Best-effort; never blocks activation.
   */
  private gcOrphanAgentFootprints(live: Set<string>): void {
    try {
      const known = new Set<string>([...live, ...this.ledger.all().keys(), ...Object.keys(this.config?.agents ?? {})]);
      const result = gcOrphanAgentFootprints({
        workspaceRoot: this.workspaceRoot,
        knownAgents: known,
        dryRun: false,
        activity: true,
      });
      if (result.orphans.length > 0) {
        console.info(
          `[tachyon t-8310ca] orphan footprint GC: removed ${result.orphans.length} continuity name(s)` +
            (result.removedActivity.length ? ` (+ activity)` : ""),
        );
      }
    } catch {
      /* never block start */
    }
  }

  /** Canonical declared-agent removal tail. Caller owns deleting the tachyon.yml entry first. */
  async forgetAgent(name: string): Promise<void> {
    await this.evolutionStore.retireAgent(name);
    forgetAgentFootprint(name, {
      workspaceRoot: this.workspaceRoot,
      ledger: this.ledger,
      removeHarnessHome: (agent) => this.harness.remove(agent),
      removePiSessionDir: (agent) => removePiSessionDir(this.workspaceRoot, agent),
    });
    this.removeContinuity(name);
  }

  /** spec 241 OQ4 — the sidebar freshness badge: missing (no brief) | stale (≥ staleLag behind) | fresh. */
  continuityBadge(agent: string): "fresh" | "stale" | "missing" {
    let brief: ReturnType<ContinuityStore["read"]> = null;
    try {
      brief = this.continuityStore.read(agent);
    } catch {
      return "stale"; // a malformed/unreadable brief is, at best, not trustworthy
    }
    if (!brief) return "missing";
    const cur = this.currentActivitySeq(agent);
    const seq = typeof brief.meta.source_activity_seq === "number" ? brief.meta.source_activity_seq : undefined;
    if (cur === undefined || seq === undefined) return "fresh";
    return cur - seq > Workspace.CONTINUITY_STALE_LAG ? "stale" : "fresh";
  }

  /** spec 390 — MC tasks for focus-line projection (assignee / open statuses resolved in agentFocus). */
  focusTasks(): Array<{ id: string; title: string; status: string; assignee?: string; updatedAt: string }> {
    return this.taskStore.listRaw().map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      ...(t.assignee ? { assignee: t.assignee } : {}),
      updatedAt: t.updatedAt,
    }));
  }

  /** spec 390 — continuity body for Current Goal parse; null when missing/unreadable. */
  continuityBody(agent: string): string | null {
    try {
      return this.continuityStore.read(agent)?.body ?? null;
    } catch {
      return null;
    }
  }

  /** The activity writer's session-transition counter (bumps on a new session file: /clear, restart, external). */
  private writerTransitions(agent: string): number {
    try {
      const file = path.join(this.workspaceRoot, ".tachyon", "activity", `${agentLogId(agent)}.state.json`);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { transitions?: number };
      return typeof parsed.transitions === "number" ? parsed.transitions : 0;
    } catch {
      return 0;
    }
  }

  /** D3/D9 — a session-id change (vs the clean-resume baseline) is a discontinuity; flag it. First sight just baselines. */
  private detectSessionDiscontinuity(agent: string): void {
    const tr = this.writerTransitions(agent);
    const seen = this.continuityState.read(agent).lastSeenTransitions;
    if (seen === undefined) {
      this.continuityState.setLastSeenTransitions(agent, tr); // baseline only — don't inject on first observation
    } else if (tr > seen) {
      this.continuityState.markDiscontinuity(agent, this.currentActivitySeq(agent));
      this.continuityState.setLastSeenTransitions(agent, tr);
    }
  }

  /** in-flight recovery guard (codex residual #2) — idle events can fire faster than a recovery completes;
   *  overlapping passes would double-send into the pane. One recovery per agent at a time. */
  private readonly recoveryInFlight = new Set<string>();
  /** spec 312 — agents whose CURRENT spawn actually received the silent persistence hook bundle. */
  private readonly silentPersistenceHookAgents = new Set<string>();
  private silentPersistenceHookState?: Record<string, { active: boolean; updatedAt: string }>;

  /** spec 307 — automatic persistence nudges are for declared agents only in v1.
   *  Ad-hoc rows (including fork/worktree-backed ones) stay quiet unless an explicit future opt-in exists. */
  private automaticPersistenceNudgesAllowed(agent: string): boolean {
    return this.manager.kindOf(agent) === "agent" && !!this.config?.agents?.[agent];
  }

  /** spec 312 — persisted Claude/Codex agents use runtime-native silent hooks by default. This also suppresses
   *  automatic pane nudges; manual UI reinjection remains explicit and visible. */
  private silentPersistenceHooksDesired(agent: string): boolean {
    // t-7bcba6 — silent hooks are the only supported mode for eligible declared Claude/Codex
    // agents. The obsolete settings.persistence.silentHooks kill switch was removed; a false
    // override can no longer disable injection or claim to restore visible pane reminders.
    if (!this.automaticPersistenceNudgesAllowed(agent)) return false;
    const def = this.config?.agents?.[agent];
    if (!def || managesOwnSession(def.cmd)) return false;
    const binary = binaryOf(def.cmd);
    return binary === "claude" || binary === "codex";
  }

  private silentPersistenceHookStatePath(): string {
    return path.join(this.workspaceRoot, ".tachyon", "activity", "silent-persistence-hooks.json");
  }

  private readSilentPersistenceHookState(): Record<string, { active: boolean; updatedAt: string }> {
    if (this.silentPersistenceHookState) return this.silentPersistenceHookState;
    try {
      const raw = JSON.parse(fs.readFileSync(this.silentPersistenceHookStatePath(), "utf8")) as unknown;
      if (!raw || typeof raw !== "object") return (this.silentPersistenceHookState = {});
      const out: Record<string, { active: boolean; updatedAt: string }> = {};
      for (const [agent, row] of Object.entries(raw as Record<string, unknown>)) {
        if (!row || typeof row !== "object") continue;
        const r = row as { active?: unknown; updatedAt?: unknown };
        if (typeof r.active === "boolean" && typeof r.updatedAt === "string") out[agent] = { active: r.active, updatedAt: r.updatedAt };
      }
      return (this.silentPersistenceHookState = out);
    } catch {
      return (this.silentPersistenceHookState = {});
    }
  }

  private writeSilentPersistenceHookState(agent: string, active: boolean): void {
    try {
      const state = { ...this.readSilentPersistenceHookState(), [agent]: { active, updatedAt: new Date().toISOString() } };
      const file = this.silentPersistenceHookStatePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      this.silentPersistenceHookState = state;
    } catch {
      /* never block spawn/resume on hook-state bookkeeping */
    }
  }

  persistenceHookHealth(agent: string): PersistenceHookHealth | undefined {
    if (!this.silentPersistenceHooksDesired(agent)) return undefined;
    const injected = this.readSilentPersistenceHookState()[agent];
    const latestFailure = readPersistenceHookFailures(persistenceHookFailureFile(this.workspaceRoot))
      .filter((row) => row.agent === agent)
      .at(-1);
    if (!injected?.updatedAt) {
      return { state: "unknown", reason: latestFailure ? "failure exists but current-spawn hook state is unknown" : "no current-spawn hook evidence" };
    }
    if (latestFailure && failureIsCurrent(latestFailure.ts, injected.updatedAt)) {
      return {
        state: "failed",
        reason: latestFailure.reason || "hook failure",
        script: latestFailure.script,
        path: latestFailure.path,
        updatedAt: latestFailure.ts,
      };
    }
    if (injected?.active === true) return { state: "active", updatedAt: injected.updatedAt };
    if (injected?.active === false) return { state: "skipped", reason: "hook injection not active for current spawn", updatedAt: injected.updatedAt };
    return { state: "unknown", reason: "no current-spawn hook evidence" };
  }

  /** codex fix #4 — serialize idle recovery so spec-216 re-anchor and spec-241 continuity never interleave
   *  their pane writes: role reminder first, then the continuity pointer (or the proactive checkpoint reminder). */
  private async recoverOnIdle(agent: string, wantAnchor: boolean): Promise<void> {
    if (this.recoveryInFlight.has(agent)) return; // a prior pass is still running — the flag persists for the next idle
    this.recoveryInFlight.add(agent);
    try {
      if (await this.flushQueuedNotice(agent)) {
        if (wantAnchor) this.pendingAnchor.add(agent);
        return;
      }
      if (wantAnchor) {
        try {
          this.pendingAnchor.delete(agent);
          await this.reanchor(agent);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.host.notify(this.t("could not re-anchor agent '{0}': {1}", agent, detail), "warn");
        }
      }
      this.detectSessionDiscontinuity(agent);
      if (this.continuityState.read(agent).discontinuitySinceRestore) {
        await this.injectContinuity(agent, "compaction-idle");
      } else {
        await this.maybeRemindCheckpoint(agent);
      }
      // spec 245 — serially AFTER continuity (so two sendKeys never interleave): a light, workspace-throttled
      // reminder to append a PROJECT-handoff note. Cadence is `settings.handoff.nudgeEvery` (default 30m, `off`).
      await this.maybeRemindHandoff(agent);
    } finally {
      this.recoveryInFlight.delete(agent);
    }
  }

  private async deliverNotice(agent: string, line: string, metadata: NoticeQueueMetadata = {}): Promise<NoticeDeliveryResult> {
    const attention = this.monitor.stateOf(agent);
    const state = attention?.state;
    if (state === "working" || state === "throttled" || state === "needs-input" || attention?.composerOccupied || this.recoveryInFlight.has(agent)) {
      return this.enqueueNotice(agent, line, metadata);
    }
    await this.submitNoticeLine(agent, line);
    return { status: "notified" };
  }

  private enqueueNotice(agent: string, line: string, metadata: NoticeQueueMetadata = {}): NoticeDeliveryResult {
    const result = this.noticeQueue.enqueue(agent, line, metadata);
    if (result.dropped > 0) {
      this.host.notify(this.t("dropped {0} old notice(s) for '{1}' while queueing a newer one", result.dropped, agent), "warn");
    }
    return { status: "queued", queued: result.queued, dropped: result.dropped || undefined };
  }

  private async flushQueuedNotice(agent: string): Promise<boolean> {
    if (this.monitor.stateOf(agent)?.composerOccupied) return false;
    this.noticeQueue.clearExpired(agent);
    let item = this.noticeQueue.dequeue(agent);
    while (item) {
      if (item.sourceChild !== undefined) {
        const currentIncarnation = this.agentIncarnations.get(item.sourceChild);
        // t-572cef: agentIncarnationCounters is never deleted (onKilled clears only agentIncarnations,
        // rename only raises it) so `.has()` here means "this name went through recordSpawnIncarnation
        // at least once" — i.e. a genuinely killed-and-not-respawned child, as opposed to a name this
        // process has never recorded at all (a reload survivor start() didn't cover). Drop only in the
        // former case when incarnations disagree (covers both "mismatched" and "killed, no current
        // entry"); an entirely unknown name delivers — the safe default for the latter, undamaged case.
        const everRecorded = this.agentIncarnationCounters.has(item.sourceChild);
        if (everRecorded && currentIncarnation !== item.sourceIncarnation) {
          item = this.noticeQueue.dequeue(agent);
          continue;
        }
      }
      try {
        await this.submitNoticeLine(agent, item.line);
        return true;
      } catch (err) {
        this.host.notify(this.t("failed to deliver queued notice to '{0}': {1}", agent, err instanceof Error ? err.message : String(err)), "warn");
        return false;
      }
    }
    return false;
  }

  private recordSpawnIncarnation(agent: string): number {
    const incarnation = (this.agentIncarnationCounters.get(agent) ?? 0) + 1;
    this.agentIncarnationCounters.set(agent, incarnation);
    this.agentIncarnations.set(agent, incarnation);
    return incarnation;
  }

  private sourceNoticeMetadata(agent: string): NoticeQueueMetadata {
    return { sourceChild: agent, sourceIncarnation: this.agentIncarnations.get(agent) };
  }

  private async submitNoticeLine(agent: string, line: string): Promise<void> {
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session))) {
      this.noticeQueue.clear(agent);
      throw new Error(`agent '${agent}' is not running`);
    }
    await this.tmux.sendSubmittedLine(session, line);
  }

  /** Automatic handoff reminders are hook-only. If the runtime cannot receive hooks, Tachyon stays quiet. */
  private async maybeRemindHandoff(agent: string): Promise<void> {
    void agent;
  }

  /**
   * spec 241 (D3/D4/D5) — re-inject the agent's continuity pointer if it's at risk. The decision is the pure
   * `classifyInjection`; here we just gather inputs + do the side effect (type into the pane), then mark the
   * discontinuity restored (which dedupes future restores). Best-effort: never throws into the caller.
   */
  async injectContinuity(agent: string, transition: Transition, opts: { origin?: "auto" | "ui" } = {}): Promise<void> {
    if (this.manager.kindOf(agent) !== "agent") return;
    if (opts.origin !== "ui") return;
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session))) return;
    // codex fix #3 — distinguish a MISSING brief (cold start) from a MALFORMED one (read throws): a corrupt
    // brief must NOT be silently treated as cold-start-then-cleared, or we lose the only restore opportunity.
    let brief: ReturnType<ContinuityStore["read"]> = null;
    let malformed = false;
    try {
      brief = this.continuityStore.read(agent);
    } catch {
      malformed = true;
    }
    const cur = this.currentActivitySeq(agent);
    if (malformed) {
      const nowm = Date.now();
      await this.tmux.sendKeys(session, `[Tachyon] Your continuity brief is malformed (bad frontmatter) — fix or delete .tachyon/continuity/${agent}.md, then set_continuity. Recent activity is preserved in the durable log.`, true);
      this.continuityState.markNudged(agent, new Date(nowm).toISOString(), cur);
      this.continuityState.setLastSeenTransitions(agent, this.writerTransitions(agent)); // re-baseline; do NOT markRestored (unresolved)
      return;
    }
    const st = this.continuityState.read(agent);
    const decision = classifyInjection({
      transition,
      hasBrief: !!brief,
      discontinuitySinceRestore: st.discontinuitySinceRestore,
      briefStatus: brief?.meta.status,
    });
    if (!decision.inject) return;
    // codex fix #2 — a genuine discontinuity RESTORE must not be suppressed by the proactive-reminder cooldown;
    // the flag-clear below (markRestored) is what dedupes restores (they only re-fire on a NEW discontinuity).
    // Only the manual path is unconditional; auto restores rely on the flag, not the time cooldown.
    const now = Date.now();
    const seq = typeof brief?.meta.source_activity_seq === "number" ? brief.meta.source_activity_seq : undefined;
    const lag = cur !== undefined && seq !== undefined ? Math.max(0, cur - seq) : undefined;
    const hasRole = fs.existsSync(path.join(this.workspaceRoot, ".tachyon", "roles", `${agent}.md`)); // polish: only point at the role doc if it exists
    const text = injectionText({ agent, reason: decision.reason, lag, staleLag: Workspace.CONTINUITY_STALE_LAG, briefStatus: brief?.meta.status, hasRole });
    await this.tmux.sendKeys(session, text, true);
    // codex fix #1 — advance the session-change baseline at the restore point so the NEXT bump is detected.
    this.continuityState.markRestored(agent, cur);
    this.continuityState.setLastSeenTransitions(agent, this.writerTransitions(agent));
    this.continuityState.markNudged(agent, new Date(now).toISOString(), cur);
  }

  /** Automatic checkpoint reminders are hook-only. No runtime hook means no continuity prompt. */
  private async maybeRemindCheckpoint(agent: string): Promise<void> {
    void agent;
  }

  /**
   * spec 241 D8 — seed a fork's continuity from its parent: a SNAPSHOT copy in the fork's own file, started
   * `status: paused` with fork provenance + a re-scope note (an off-task fork must not present the parent's
   * goal as its own active work). Best-effort: no parent brief → nothing to do.
   */
  snapshotContinuityForFork(fromAgent: string, toAgent: string): void {
    let brief: ReturnType<ContinuityStore["read"]> = null;
    try {
      brief = this.continuityStore.read(fromAgent);
    } catch {
      return;
    }
    if (!brief) return;
    const body = `${brief.body}\n\n> _(Inherited from \`${fromAgent}\` — re-scope to your own task before treating this as active.)_`;
    const extraMeta: Record<string, unknown> = { forked_from_agent: fromAgent };
    if (typeof brief.meta.source_session_id === "string") extraMeta.forked_from_session_id = brief.meta.source_session_id;
    try {
      this.continuityStore.write(toAgent, body, { updatedBy: "tachyon", status: "paused", sourceActivitySeq: this.currentActivitySeq(toAgent), extraMeta });
    } catch {
      /* never block a fork on continuity */
    }
  }

  /** Automatic teardown checkpoint reminders are hook-only; Tachyon never types fallback prompts into panes. */
  async checkpointBeforeTeardown(agent: string): Promise<void> {
    void agent;
  }

  configPath(): string | undefined {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(this.workspaceRoot, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * spec 210 — run an agent's `worktreeSetup` in its fresh worktree: sequential,
   * stop on first failure, with `TACHYON_WORKSPACE_ROOT`/`TACHYON_WORKTREE_ROOT`
   * injected. Awaited by the async spawn (off the UI thread); per-command timeout;
   * failure is surfaced but NON-fatal (the agent still spawns).
   */
  private async runWorktreeSetup(rec: WorktreeRecord, setup: string[]): Promise<void> {
    const run = promisify(execFile);
    const env = { ...process.env, TACHYON_WORKSPACE_ROOT: this.workspaceRoot, TACHYON_WORKTREE_ROOT: rec.path };
    for (const cmd of setup) {
      try {
        await run("bash", ["-lc", cmd], { cwd: rec.path, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        const detail = err instanceof Error ? (err as Error & { stderr?: string }).stderr?.trim() || err.message : String(err);
        this.host.notify(this.t("worktree setup for '{0}' failed at: {1} — {2} (agent started anyway)", rec.branch, cmd, detail), "warn");
        return; // stop on first failure
      }
    }
    this.host.notify(this.t("worktree setup complete for '{0}'", rec.branch), "info");
  }

  private async requiredGitOutput(args: string[], cwd: string, label: string): Promise<string> {
    const result = await this.gitExec(args, cwd);
    const output = result.stdout.trim();
    // Git object formats are SHA-1 (40 hex) or SHA-256 (64 hex).  Do not turn a
    // successful SHA-256 repository into an apparent inspection failure.
    if (result.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(output)) {
      throw new Error(`${label} failed (${result.code}): ${result.stderr.trim() || "missing or malformed object id"}`);
    }
    return output;
  }

  private async requiredGitStatus(cwd: string): Promise<boolean> {
    const result = await this.gitExec(["status", "--porcelain"], cwd);
    if (result.code !== 0) {
      throw new Error(`Git status inspection failed (${result.code}): ${result.stderr.trim() || "no diagnostic"}`);
    }
    return result.stdout.trim() === "";
  }

  private async requiredRecoveryInventory(cwd: string, baseSha: string): Promise<DeliveryRecoveryInspection> {
    const headSha = await this.requiredGitOutput(["rev-parse", "HEAD"], cwd, "Git HEAD");
    const status = await this.gitExec(["status", "--porcelain=v1"], cwd);
    if (status.code !== 0) {
      throw new Error(`Git status failed (${status.code}): ${status.stderr.trim() || "no diagnostic"}`);
    }
    const history = await this.gitExec(["rev-list", `${baseSha}..${headSha}`], cwd);
    if (history.code !== 0) {
      throw new Error(`Git recovery history failed (${history.code}): ${history.stderr.trim() || "no diagnostic"}`);
    }
    const uniqueCommits = history.stdout.split(/\r?\n/).filter(Boolean);
    if (uniqueCommits.some((sha) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha))) {
      throw new Error("Git recovery history returned a malformed object id");
    }
    return { inventory: {
      headSha,
      dirtyPaths: status.stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
      uniqueCommits,
    } };
  }

  /** The Delivery backlink, linked row, and real worktree must agree at every canonical entry point. */
  private async exactCanonicalProjection(delivery: import("../delivery/types.js").Delivery): Promise<GitDelivery> {
    if (!delivery.gitDeliveryId) throw new Error(`DELIVERY_WORKTREE_MISMATCH: Delivery '${delivery.id}' has no projection backlink`);
    const linked = (await this.gitDeliveries.list()).filter((g) => g.deliveryId === delivery.id && !!g.worktreePath);
    if (linked.length !== 1 || linked[0].id !== delivery.gitDeliveryId) throw new Error(`DELIVERY_WORKTREE_MISMATCH: expected exact linked projection for '${delivery.id}'`);
    fs.realpathSync(linked[0].worktreePath);
    return linked[0];
  }

  /**
   * Cross-store boundary is deliberately fail-closed: canonical Delivery is durable first, then its
   * Git projection, then the backlink. Replaying the stable operation repairs either crash boundary;
   * no compatibility record is dual-written and an unlinked Delivery is never mistaken for a complete one.
   */
  private async recordCanonicalDelivery(input: {
    name: string;
    delegator?: string;
    gate: { behaviorTest: string; owns?: string[]; stubPath?: string; oracleHash?: string; executorHashes?: Record<string, string> };
    worktree: WorktreeRecord;
    baseSha: string;
    verifySettings?: NonNullable<TachyonConfig["settings"]>["verify"];
  }): Promise<CanonicalDeliverySpawnReceipt> {
    this.legacyDeliveryRetirement.assertRetired();
    // t-2dd637 — the projection base must be a SYMBOLIC branch ref. `WorktreeRecord.baseRef` is a
    // fork-point SHA on every producer path, so coalescing to it silently substitutes one meaning
    // for the other and pins the base to a commit; `containedInBase` then reads that pin as a
    // containment ceiling and refuses forever, since each new commit moves the tip further from it.
    // Refuse before ANY durable write (Delivery record included): a refused spawn is loud and
    // retryable, a SHA-pinned projection is permanently unintegrable.
    const projectionBaseRef = input.worktree.baseBranch;
    if (!projectionBaseRef) {
      throw new Error(
        "DELIVERY_BASE_REF_UNRESOLVED: canonical gated spawn requires a symbolic base branch; "
        + `worktree '${input.worktree.path}' carries only a pinned base SHA`,
      );
    }
    const owns = [...new Set(input.gate.owns ?? [])];
    const spawnKey = createHash("sha256").update(JSON.stringify({
      agent: input.name, delegator: input.delegator, baseSha: input.baseSha,
      taskRef: input.worktree.branch, behaviorTest: input.gate.behaviorTest, owns,
      oracleHash: input.gate.oracleHash,
      executorHashes: input.gate.executorHashes,
      verifySettings: input.verifySettings,
    })).digest("hex");
    const deliveryId = `d-spawn-${spawnKey.slice(0, 32)}`;
    const actor = input.delegator ? { kind: "agent" as const, name: input.delegator } : { kind: "system" as const, name: "tachyon" };
    let delivery = await this.deliveries.get(deliveryId);
    if (!delivery) {
      // The gated pane already exists at this callback boundary. Capture its exact
      // Linux identity before publishing the initial held lease; unknown is fail-closed.
      const identity = readLinuxProcessIdentity(await this.tmux.panePid(this.manager.session(input.name)));
      if (identity.state !== "exact") throw new Error("DELIVERY_PROCESS_IDENTITY_MISSING: canonical gated spawn requires an exact pane identity");
      const executionNonce = randomBytes(16).toString("hex");
      const now = new Date().toISOString();
      try {
        delivery = await this.deliveries.create({
      id: deliveryId,
      workspaceId: this.wsHash,
      createdBy: actor,
      operationId: `gated-spawn:${spawnKey}`,
      contract: {
        baseSha: input.baseSha,
        behaviorTest: input.gate.behaviorTest,
        owns,
        taskRef: input.worktree.branch,
        ...(input.gate.stubPath ? { stubPath: input.gate.stubPath } : {}),
        ...(input.gate.oracleHash ? { oracleHash: input.gate.oracleHash } : {}),
        ...(input.gate.executorHashes ? { executorHashes: structuredClone(input.gate.executorHashes) } : {}),
        ...(input.verifySettings ? { verifySettings: structuredClone(input.verifySettings) } : {}),
      },
      lease: { state: "held", holder: { segmentId: `seg-${spawnKey.slice(0, 16)}`, executionAgent: input.name, principal: input.name, executionNonce, process: { pid: identity.pid, processStart: identity.processStart, bootId: identity.bootId } }, expectedHeadSha: input.baseSha, changedAt: now },
      segments: [{
        id: `seg-${spawnKey.slice(0, 16)}`, index: 0, role: "implementer", executionAgent: input.name,
        principal: input.name, grantedBy: actor, ownsSubset: owns, grantedHeadSha: input.baseSha, grantedAt: now,
      }],
        });
      } catch (error) {
        delivery = await this.deliveries.get(deliveryId);
        if (!delivery) throw error;
      }
    }
    // SDD 368 T15 — canonical gated open under projection claim + intent + backlink repair.
    const opened = await this.deliveryProjection.openCanonical({
      deliveryId: delivery.id,
      agent: input.name,
      branchRef: input.worktree.branch,
      worktreePath: input.worktree.path,
      tachyonCreatedBranch: input.worktree.tachyonCreatedBranch,
      baseRef: projectionBaseRef,
      currentHeadSha: input.baseSha,
      actor,
      operationId: `gated-spawn-open:${spawnKey}`,
      reason: "canonical gated spawn",
    });
    delivery = opened.delivery;
    // SDD 368 T14 — reverse binding after Delivery + linked Git projection are durable.
    // Require one internally exact held holder/open-tail/executionAgent boundary; no
    // same-name or tail-segment inference.
    const holder = delivery.lease.holder;
    const tail = delivery.segments.at(-1);
    if (
      !holder
      || !tail
      || tail.releasedAt
      || tail.id !== holder.segmentId
      || tail.executionAgent !== holder.executionAgent
      || tail.principal !== holder.principal
      || holder.executionAgent !== input.name
    ) {
      throw new Error(
        `Delivery '${delivery.id}' has no exact holder/open-tail/executionAgent boundary for '${input.name}'`,
      );
    }
    if (!holder.executionNonce || !holder.process) {
      throw new Error("DELIVERY_PROCESS_IDENTITY_MISSING: sequential canonical holder lacks nonce or process identity");
    }
    const projectionWorktree = fs.realpathSync(opened.projection.worktreePath);
    const expectedWorktree = fs.realpathSync(input.worktree.path);
    const expectedBaseRef = projectionBaseRef;
    if (
      delivery.contract.baseSha !== input.baseSha
      || opened.projection.workspaceId !== this.wsHash
      || opened.projection.deliveryId !== delivery.id
      || opened.projection.branchRef !== input.worktree.branch
      || opened.projection.tachyonCreatedBranch !== input.worktree.tachyonCreatedBranch
      || opened.projection.baseRef !== expectedBaseRef
      || opened.projection.currentHeadSha !== input.baseSha
      || projectionWorktree !== expectedWorktree
    ) {
      throw new Error(`DELIVERY_WORKTREE_MISMATCH: canonical spawn receipt for '${delivery.id}' is inconsistent`);
    }
    this.canonicalLedger.stageCanonicalBinding(input.name, {
      deliveryId: delivery.id,
      segmentId: holder.segmentId,
      executionNonce: holder.executionNonce,
    });
    return {
      deliveryId: delivery.id,
      projectionId: opened.projection.id,
      segmentId: holder.segmentId,
      worktree: projectionWorktree,
      branch: opened.projection.branchRef,
      head: input.baseSha,
    };
  }

  private async prepareDeliveryJoin(name: string, request: DeliveryJoinRequest): Promise<PreparedDeliveryJoin> {
    this.legacyDeliveryRetirement.assertRetired();
    const delivery = await this.deliveries.get(request.deliveryId);
    if (!delivery) throw new Error(`DELIVERY_NOT_FOUND: ${request.deliveryId}`);
    const projection = await this.exactCanonicalProjection(delivery);
    const worktreePath = fs.realpathSync(projection.worktreePath);
    const worktree: WorktreeRecord = { path: worktreePath, branch: projection.branchRef, tachyonCreatedBranch: projection.tachyonCreatedBranch, baseRef: projection.baseRef, createdAt: projection.createdAt };
    const actor = { kind: "system" as const, name: "tachyon" };
    const reservation = delivery.lease.state === "free"
      ? await this.deliveryLease.acquire({ deliveryId: delivery.id, expectedVersion: delivery.version, expectedHeadSha: request.expectedHead, canonicalWorktree: worktreePath, role: request.role, executionAgent: name, principal: request.principal, grantedBy: actor, ownsSubset: request.ownsSubset, operationId: request.operationId })
      : delivery.lease.state === "held"
        ? await this.deliveryLease.handoff({ deliveryId: delivery.id, canonicalWorktree: worktreePath, expectedFinalHeadSha: request.expectedHead, role: request.role, executionAgent: name, principal: request.principal, grantedBy: actor, ownsSubset: request.ownsSubset, operationId: request.operationId })
        : delivery.lease.state === "pending" && request.role === "recovery"
          ? await this.deliveryLease.preparePendingRecovery({ deliveryId: delivery.id, canonicalWorktree: worktreePath, expectedHeadSha: request.expectedHead, executionAgent: name, principal: request.principal, ownsSubset: request.ownsSubset })
        : (() => { throw new Error(`DELIVERY_INVALID_STATE: Delivery is ${delivery.lease.state}`); })();
    const segmentId = reservation.delivery.lease.holder?.segmentId;
    if (!segmentId) throw new Error("DELIVERY_INVALID_STATE: reservation has no segment");
    return { cwd: worktreePath, worktree, reservationNonce: reservation.reservationNonce, segmentId };
  }

  private async confirmDeliveryJoin(name: string, request: DeliveryJoinRequest, prepared: PreparedDeliveryJoin, pid?: number): Promise<void> {
    void name;
    if (!pid) throw new Error("DELIVERY_PROCESS_IDENTITY_MISSING: pane pid is unreadable");
    const identity = readLinuxProcessIdentity(pid);
    if (identity.state !== "exact") throw new Error("DELIVERY_PROCESS_IDENTITY_MISSING: pane identity is unreadable or reused");
    await this.deliveryLease.confirmHeld(request.deliveryId, prepared.reservationNonce, { pid: identity.pid, processStart: identity.processStart, bootId: identity.bootId }, `${request.operationId}:confirm`);
  }

  /**
   * SDD 368 T14 — recompute the in-memory Delivery reload snapshot from one bounded
   * set of store/ledger/process reads. Read-only; never mutates Delivery or GitDelivery.
   * Passes exact linked GitDelivery records (no last-wins path map).
   * On success installs `{phase:"ready", snapshot}`; throws leave phase unchanged
   * (callers use `attemptDeliveryReloadSnapshot` for fail-closed handling).
   */
  private async refreshDeliveryReloadSnapshot(): Promise<ReloadReconciliationSnapshot> {
    const deliveryList = await this.deliveries.listWithCorrupt();
    if (deliveryList.corrupt.length > 0) {
      const noticeKey = deliveryList.corrupt.map((record) => `${record.id}\0${record.error}`).join("\0");
      if (noticeKey !== this.deliveryAuthorityQuarantineNoticeKey) {
        const preview = deliveryList.corrupt
          .slice(0, 3)
          .map((record) => `${record.id}: ${record.error.replace(/\s+/g, " ").slice(0, 160)}`)
          .join("; ");
        const omitted = deliveryList.corrupt.length - 3;
        console.warn(
          `[tachyon] quarantined ${deliveryList.corrupt.length} canonical Delivery record(s) with invalid authority: ${preview}${omitted > 0 ? `; +${omitted} more` : ""}`,
        );
        this.host.notify(
          this.t(
            "Tachyon quarantined {0} canonical Delivery record(s) with invalid authority; affected agents remain unavailable",
            deliveryList.corrupt.length,
          ),
          "warn",
        );
        this.deliveryAuthorityQuarantineNoticeKey = noticeKey;
      }
    } else {
      this.deliveryAuthorityQuarantineNoticeKey = undefined;
    }
    const deliveries = deliveryList.records;
    const gitList = await this.gitDeliveries.list();
    const linkedProjections: LinkedGitProjection[] = [];
    for (const g of gitList) {
      if (g.deliveryId && g.worktreePath) {
        linkedProjections.push({
          gitDeliveryId: g.id,
          deliveryId: g.deliveryId,
          worktreePath: g.worktreePath,
        });
      }
    }
    const sessions = this.ledger.all();
    // Observe processes for every session that may participate in classification:
    // bound rows, and also marker-less names that appear as Delivery holders (crash window).
    const observeNames = new Set<string>();
    for (const [name, rec] of sessions) {
      if (hasDeliveryMarker(rec)) observeNames.add(name);
    }
    for (const d of deliveries) {
      const holder = d.lease.holder?.executionAgent;
      if (holder) observeNames.add(holder);
    }
    const processByAgent = new Map<string, ObservedProcess>();
    for (const name of observeNames) {
      try {
        const session = this.manager.session(name);
        if (!(await this.tmux.hasSession(session))) {
          processByAgent.set(name, { state: "gone" });
          continue;
        }
        const pid = await this.tmux.panePid(session);
        processByAgent.set(name, readLinuxProcessIdentity(pid));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        processByAgent.set(name, { state: "unknown", reason });
      }
    }
    const snapshot = reconcileDeliveryReload({
      deliveries,
      untrustedDeliveries: deliveryList.corrupt.map((record) => ({ id: record.id })),
      linkedProjections,
      sessions,
      processByAgent,
    });
    this.deliveryReload = { phase: "ready", snapshot };
    return snapshot;
  }

  /**
   * SDD 368 T14/R4 — shared bounded reload attempt used by `_create` and `start`.
   * Success → ready; failure → failed + warn. Never leaves callers on uninitialized
   * after the attempt completes. Does not special-case empty stores or test mode.
   */
  private async attemptDeliveryReloadSnapshot(): Promise<void> {
    try {
      await this.refreshDeliveryReloadSnapshot();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deliveryReload = { phase: "failed", reason };
      this.host.notify(
        this.t("delivery reload reconciliation failed: {0}", reason),
        "warn",
      );
    }
  }

  /** SDD 368 T14 — last ready reload snapshot (undefined when not ready). */
  deliveryReloadState(): ReloadReconciliationSnapshot | undefined {
    return this.deliveryReload.phase === "ready" ? this.deliveryReload.snapshot : undefined;
  }

  /**
   * SDD 368 T14/R3 — explicit snapshot readiness. Never interpret a missing
   * snapshot as safe generic-lifecycle admission. After `_create`/`start` attempt,
   * callers should only see `ready` or `failed` (not `uninitialized`).
   */
  deliveryReloadPhase(): "uninitialized" | "ready" | "failed" {
    return this.deliveryReload.phase;
  }

  /**
   * The workspace's own checked-out branch — the ref `WorktreeManager.add` forks new delivery
   * branches from, and therefore the only base a governed base repair may widen a pin to.
   * A detached or unresolvable HEAD throws so the repair stays unavailable rather than guessing.
   */
  private async workspaceTargetBranch(): Promise<string> {
    const result = await this.gitExec(["rev-parse", "--abbrev-ref", "HEAD"], this.workspaceRoot);
    const branch = result.stdout.trim();
    if (result.code !== 0 || !branch || branch === "HEAD") {
      throw new Error(`workspace target branch is not resolvable (${result.stderr.trim() || "detached HEAD"})`);
    }
    return branch;
  }

  /**
   * The one durable approval store both governed recovery dispositions redeem against: the caller
   * may only redeem an approval it requested itself, and the resolved payload must name this exact
   * action digest. Shared by the lease service's recovery approvals and the projection service's
   * base repair so neither can drift onto a weaker binding check.
   */
  private resolveTrustedRecoveryApproval(approvalId: string, actor: DeliveryActor, actionDigest: string): DeliveryRecoveryApproval {
    if (actor.kind !== "agent" || !actor.name) throw new Error("recovery approval requires an agent caller");
    const request = readOwnApprovalRequest(this.workspaceRoot, approvalId, actor.name);
    if (request.status !== "resolved" || request.resolution?.decision !== "approved") throw new Error("approval is not resolved as approved");
    if (!request.payload.proposedAction.includes(actionDigest)) throw new Error("approval is not bound to this recovery action digest");
    return { decision: "approved", requester: request.requester, actionDigest, payloadHash: request.payloadHash,
      resolvedAt: request.resolution.resolvedAt, resolvedBy: request.resolution.resolvedBy };
  }

  private async gitDeliveryLiveness(agent: string): Promise<"live" | "not_live" | "unknown"> {
    try {
      const state = (await this.manager.agentStates()).get(agent);
      return state && !state.dead ? "live" : "not_live";
    } catch {
      return "unknown";
    }
  }

  /**
   * spec 214 (C3) — run an agent's verify-gate IN its worktree and record the result. Resolves
   * the effective verify (per-agent `verify:` > global `settings.worktree.verify`) and treats it
   * like a runbook step: a declared runbook → its steps; else a single step (a declared command
   * name → its cmd, else inline shell). Reuses RunbookRunner with the worktree cwd (no new
   * executor). The verdict is keyed to the worktree HEAD, so it goes stale when work moves on.
   * Advisory — surfaces a badge + a toast; never blocks. Returns the recorded state.
   */
  async runVerify(agent: string): Promise<VerifyState> {
    const rec = this.ledger.get(agent);
    const wt = rec?.worktree;
    if (!wt) throw new Error(this.t("'{0}' has no worktree — verify is worktree-scoped", agent));
    if (!fs.existsSync(wt.path)) throw new Error(this.t("'{0}' worktree is gone ({1}) — nothing to verify", agent, wt.path));
    const verify = effectiveVerify(this.config?.agents[agent] ?? {}, this.config?.settings ?? {});
    if (!verify) throw new Error(this.t("'{0}' has no verify declared (set 'verify:' on the agent, or settings.worktree.verify)", agent));

    // Snapshot HEAD BEFORE running, so the verdict is keyed to the commit it actually ran against.
    const { headRef } = await this.worktrees.headState(wt.path);
    const steps = verifySteps(verify, this.config?.commands ?? {}, this.config?.runbooks ?? {});
    const job = await this.runbookRunner.runSteps(verifyLabel(agent), steps, wt.path);
    const passed = job.outcome === "passed";

    const ranAt = new Date().toISOString();
    const state: VerifyState = { command: verify, passed, atCommit: headRef, ranAt };
    this.ledger.recordVerify(agent, state);

    // spec 273 — record per-step evidence (the data runVerify already computed but used to discard).
    // REPLACE the prior verify step-set (dedup on re-run); the binary VerifyState above is unchanged.
    const verifyRunId = `${ranAt}:${this.evidenceSeq++}`; // unique even if two runs share a tick (codex)
    const stepEvidence: WorktreeEvidence[] = job.steps.map((st) => ({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id: `verify:${verifyRunId}:${st.index}`,
      targetAgent: agent,
      producer: VERIFY_PRODUCER,
      sourceRunId: verifyRunId,
      atCommit: headRef,
      producedAt: ranAt,
      kind: STEP_RESULT_KIND,
      severity: (st.state === "failed" ? "error" : st.state === "skipped" ? "warn" : "info") as Severity,
      summary: `${st.state}: ${st.step}`,
      data: { index: st.index, step: st.step, cmd: st.cmd, exitCode: st.exitCode, durationMs: st.durationMs, state: st.state },
    }));
    this.ledger.replaceVerifyEvidence(agent, stepEvidence);
    this.refreshAgentsViews();
    if (passed) {
      this.host.notify(this.t("✓ '{0}' verified — {1} passed", agent, verify));
    } else {
      const failed = job.steps.find((st) => st.state === "failed");
      this.host.notify(this.t("'{0}' verify FAILED — {1}", agent, failed?.step ?? verify), "error", [
        { label: this.t("Inspect"), run: () => failed && this.openRunbookStepPane(verifyLabel(agent), failed.index) },
      ]);
    }
    return state;
  }

  /**
   * spec 214 — the verify-gate render/handoff view for an agent: the recorded result + a freshly
   * computed staleness (HEAD moved past the verified commit, or the tree is dirty). Returns
   * undefined when verify doesn't apply (no worktree, or no `verify:` declared) → no badge. Used
   * by the sidebar badge AND the MCP handoff (list_agents / verify_agent), one source of truth.
   */
  async verifyInfo(agent: string): Promise<{ command: string; state?: VerifyState; stale: boolean; badge: VerifyBadge } | undefined> {
    const wt = this.ledger.get(agent)?.worktree;
    const command = effectiveVerify(this.config?.agents[agent] ?? {}, this.config?.settings ?? {});
    if (!wt || !command) return undefined;
    // A recorded result only counts if it ran the CURRENTLY-effective verify command (review fix:
    // changing `verify:` must not show the old command's result as fresh — treat it as not-verified).
    const state = wt.verify && wt.verify.command === command ? wt.verify : undefined;
    let stale = true;
    if (state && fs.existsSync(wt.path)) {
      const { headRef, dirty } = await this.worktrees.headState(wt.path);
      stale = verifyStale(state, headRef, dirty);
    }
    return { command, state, stale, badge: verifyBadge(state, stale) };
  }

  // ── spec 273 — the worktree evidence channel ─────────────────────────────
  private evidenceSeq = 0;

  /** Current HEAD of a worktree (for evidence staleness), or "" if the worktree is gone. */
  private async worktreeHead(wt: { path: string }): Promise<string> {
    return fs.existsSync(wt.path) ? (await this.worktrees.headState(wt.path)).headRef : "";
  }

  /** A compact, mechanical evidence summary folded into the verify handoff (undefined when none). */
  async evidenceHandoff(agent: string): Promise<EvidenceSummary | undefined> {
    const wt = this.ledger.get(agent)?.worktree;
    if (!wt) return undefined;
    const records = this.ledger.getEvidence(agent);
    if (records.length === 0) return undefined;
    return summarizeEvidence(records, await this.worktreeHead(wt));
  }

  /** Read a worktree agent's evidence (fresh + stale-flagged), newest-first. */
  async listEvidence(agent: string): Promise<EvidenceView[]> {
    const wt = this.ledger.get(agent)?.worktree;
    if (!wt) return [];
    return viewEvidence(this.ledger.getEvidence(agent), await this.worktreeHead(wt));
  }

  /**
   * Attach one non-binary evidence record to a worktree agent (worktree-scoped; never gates).
   * `producer` is self-declared by the caller — provenance, consistent with the bridge's existing
   * caller model (the bridge has no connection-bound identity); Tachyon stamps the server-controlled
   * fields (id/producedAt/atCommit/schemaVersion). Artifact refs that escape the worktree are rejected.
   */
  async attachEvidence(input: AttachEvidenceInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const wt = this.ledger.get(input.targetAgent)?.worktree;
    if (!wt) return { ok: false, reason: `'${input.targetAgent}' has no worktree — evidence is worktree-scoped` };
    // Reject impersonation of the reserved built-in producer (codex): a self-declared `producer:"verify"` could
    // spoof verify step-results AND would be silently dropped by the next verify-set replacement.
    if (input.producer === VERIFY_PRODUCER) return { ok: false, reason: `producer '${VERIFY_PRODUCER}' is reserved for the built-in verify producer` };
    const artifacts = input.artifacts ?? [];
    const bad = artifacts.find((a) => !isSafeArtifactRef(a));
    if (bad) return { ok: false, reason: `unsafe artifact ref rejected: ${bad}` };
    const atCommit = await this.worktreeHead(wt);
    // No commit anchor → the record would be born permanently stale and useless; reject (codex).
    if (!atCommit) return { ok: false, reason: `'${input.targetAgent}' worktree HEAD is unresolvable (gone?) — cannot anchor evidence` };
    const producedAt = new Date().toISOString();
    const id = `ev-${producedAt}-${this.evidenceSeq++}`;

    // spec 274 — copy artifacts from the worktree into the managed evidence dir so a verdict's screenshot
    // survives a worktree rebuild/removal (a vanished artifact makes the verdict unauditable). Missing → fail.
    let storedArtifacts: string[] | undefined;
    if (artifacts.length > 0) {
      const copied = copyEvidenceArtifacts({ workspaceRoot: this.workspaceRoot, worktreePath: wt.path, agent: input.targetAgent, id, refs: artifacts });
      if (!copied.ok) return { ok: false, reason: copied.reason };
      storedArtifacts = copied.refs;
    }

    const record: WorktreeEvidence = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id,
      targetAgent: input.targetAgent,
      producer: input.producer,
      ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      atCommit,
      producedAt,
      kind: input.kind,
      severity: input.severity,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.data ? { data: input.data } : {}),
      ...(storedArtifacts && storedArtifacts.length ? { artifacts: storedArtifacts } : {}),
    };
    this.ledger.appendEvidence(input.targetAgent, record);
    this.refreshAgentsViews();
    return { ok: true, id };
  }

  /**
   * spec 226 (H8) — remove harness config homes that no agent owns anymore: not declared in config
   * AND not in the ledger (a stopped-but-resumable declared agent stays in config → kept; a live one
   * is in config or the ledger). Runs at startup (after rehydrate); never deletes a home an agent
   * could still resume into (its `projects/` holds the transcript). Best-effort — never throws.
   */
  /**
   * spec 239 — prune STALE DECLARED ledger rows at startup: a row marked `declared` that is no longer in
   * tachyon.yml AND has no live session is a deleted agent whose row was orphaned (defense-in-depth against
   * external yaml edits / crash paths; the delete command also removes its row directly). Narrow on purpose —
   * never touches ad-hoc/fork rows (declared=false) or a stopped-but-still-declared agent (kept for resume).
   */
  private async gcLedger(declaredInConfig: Set<string>, live: Set<string>): Promise<void> {
    for (const [name, rec] of this.ledger.all()) {
      if (rec.declared && !declaredInConfig.has(name) && !live.has(name)) {
        try {
          await this.evolutionStore.retireAgent(name);
          forgetAgentFootprint(name, {
            workspaceRoot: this.workspaceRoot,
            ledger: this.ledger,
            removeHarnessHome: (agent) => this.harness.remove(agent),
            removePiSessionDir: (agent) => removePiSessionDir(this.workspaceRoot, agent),
          });
        } catch (error) {
          this.host.notify(this.t(
            "Could not finish cleanup for removed agent {0}: {1}",
            name,
            error instanceof Error ? error.message : String(error),
          ), "warn");
        }
      }
    }
  }

  /**
   * t-123143 — self-heal the append-only session-owner ledger: old ad-hoc agents dismissed before
   * removeSessionOwnerRows existed left ownership rows behind forever. Keep only agents still known by
   * one of the authoritative workspace sets: live tmux sessions, durable session ledger, or tachyon.yml.
   */
  private compactSessionOwners(declaredInConfig: Set<string>, live: Set<string>): void {
    const known = new Set([...live, ...this.ledger.all().keys(), ...declaredInConfig]);
    compactSessionOwnerRows(sessionOwnersFile(this.workspaceRoot), known);
    compactSpawnSettings(this.workspaceRoot, known);
  }

  private gcHarnessHomes(): void {
    try {
      const declared = new Set(Object.keys(this.config?.agents ?? {}));
      const tracked = new Set(this.ledger.all().keys());
      // spec 240 — keep any home a ledger row still POINTS AT via resume.configHome (a persisted home can
      // differ from harnessHome(currentName) after a rename/toggle; a name-only keep-set would reap the live
      // transcript namespace — codex BLOCKER).
      const referenced = new Set([...this.ledger.all()].map(([, r]) => r.resume?.configHome).filter((h): h is string => !!h));
      for (const name of this.harness.list()) {
        if (!declared.has(name) && !tracked.has(name) && !referenced.has(this.harness.home(name))) this.harness.remove(name);
      }
      // spec 236 — sweep ownerless per-agent Bridge `--mcp-config` files too (a removed/renamed
      // non-harness claude agent leaves one behind; harness.remove already drops the harness ones).
      for (const name of this.harness.listBridgeMcp()) {
        if (!declared.has(name) && !tracked.has(name)) this.harness.removeBridgeMcp(name);
      }
    } catch {
      /* GC is best-effort — a stale home is harmless, never block start */
    }
  }

  reloadConfig(): boolean {
    const file = this.configPath();
    const prevCompanionTabTools = this.config?.settings.companion?.tabTools === true;
    const prevCompanionLanAccess = this.config?.settings.companion?.lanAccess === true;
    if (!file) {
      this.config = undefined;
      this.configFailure = undefined;
      if (prevCompanionTabTools) {
        // Settings gone → drop companion tools from live MCP sessions.
        try {
          this.bridge.forceToolListRefresh();
        } catch {
          /* bridge may not be ready on early dispose paths */
        }
      }
      if (prevCompanionLanAccess) {
        // LAN was on; config gone → rebind loopback when Bridge is up.
        void this.restartBridge().catch(() => undefined);
      }
      return false;
    }
    const { config, errors, warnings } = loadConfigFile(file);
    if (errors.length > 0) {
      // t-8354ae — keep a durable failure surface (sidebar banner); toast alone is not enough.
      // Do NOT clear a previously-loaded in-memory config: live sessions keep working until
      // the human fixes the file. Cold start leaves config undefined (never loaded).
      this.configFailure = {
        path: file,
        file: path.basename(file),
        errors: [...errors],
        at: new Date().toISOString(),
      };
      this.host.notify(this.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? this.t(" (+{0} more)", errors.length - 1) : ""), "error");
      return false;
    }
    for (const warning of warnings) this.host.notify(this.t("{0}: {1}", path.basename(file), warning), "warn");
    this.config = config;
    this.configFailure = undefined;
    // SDD 414 — human toggle settings.companion.tabTools changes the Bridge tool catalog.
    // Close MCP sessions + announce list_changed so runtimes re-discover (pair alone does not).
    const nextCompanionTabTools = config?.settings.companion?.tabTools === true;
    if (prevCompanionTabTools !== nextCompanionTabTools) {
      try {
        this.bridge.forceToolListRefresh();
      } catch {
        /* best-effort */
      }
    }
    // SDD 422 — lanAccess changes the listen host; rebind Bridge so phone reachability matches yml.
    const nextCompanionLanAccess = config?.settings.companion?.lanAccess === true;
    if (prevCompanionLanAccess !== nextCompanionLanAccess) {
      void this.restartBridge().catch(() => undefined);
    }
    // spec 377 T15A — reconcile incomplete profile journals on every successful reload.
    void this.reconcileSoulProfileTransactions().catch(() => undefined);
    void this.evolutionCoordinator.reconcileCompletedTasks(this.taskStore.listRaw()).catch((error) => {
      this.host.notify(this.t("Agent Evolution review reconciliation failed: {0}", error instanceof Error ? error.message : String(error)), "error");
    });
    // t-8354ae — persist last-known-good roster for degraded sidebar rendering if config later breaks.
    if (config) writeConfigLkg(this.workspaceRoot, snapshotFromConfig(config, file));
    // Push the user's tmux overlay (settings.tmux) to the server-options layer;
    // empty/absent falls back to Tachyon's defaults. Re-asserted per new-session.
    this.tmux.setServerOptions(config?.settings.tmux ?? {});
    // spec 219 — clean clipboard copy: wire the bundled UTF-8 helper unless opted out, and only
    // when its `--check` finds a real clipboard tool (else leave OSC 52, which works over SSH/headless).
    const helperPath = this.host.mediaPath("media", "clipboard-copy.sh");
    void resolveClipboardHelperAsync({ clipboardOff: config?.settings.clipboard === "off", helperPath })
      .then((resolvedHelper) => {
        this.tmux.setClipboardHelper(resolvedHelper);
        return this.tmux.applyLiveOptions();
      })
      .catch(() => {});
    // spec 220 (219-followup): re-assert options + clipboard on a LIVE server so updating the
    // extension / changing config + Reload applies the clean-clipboard fix to already-attached
    // agents without restarting one. Best-effort: a no-op when no server runs, never blocks apply.
    void this.tmux.applyLiveOptions().catch(() => {});
    return true;
  }

  /** t-8354ae — last successful roster snapshot (null when never written / corrupt). */
  readConfigLkg(): ConfigLkgSnapshot | null {
    return readConfigLkg(this.workspaceRoot);
  }

  /**
   * t-8354ae — LKG is render-only. Refuse spawn when the working-tree config is invalid AND the
   * name is not known via live config or an in-memory ad-hoc def (i.e. it would only come from LKG).
   */
  assertNotLkgOnlySpawn(name: string): void {
    if (!this.configFailure) return;
    const inLive = !!this.config?.agents[name] || this.manager.defOf(name) !== undefined;
    const lkg = this.readConfigLkg();
    const inLkg = !!lkg?.agents.some((a) => a.name === name);
    if (isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrAdhoc: inLive, nameInLkg: inLkg })) {
      throw new Error(lkgSpawnRefusalMessage(name, this.configFailure.file));
    }
  }

  private triggerLifecycle(): void {
    // Debounced: a burst of events (layout apply, Stop All) becomes one tick.
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    this.lifecycleTrigger = setTimeout(() => {
      void this.lifecycle.tick();
      void this.commandRunner.tick();
      this.refreshAgentsViews();
      this.deps.onViewsChanged("commands");
    }, 250);
  }

  /**
   * Grok token refresh under a private GROK_HOME replaces `auth.json` (symlink → regular file).
   * On stop/kill, harvest the freshest private credential into `~/.grok/auth.json` and re-symlink
   * every private home so resume / sibling agents do not hit a re-login wall with a revoked key.
   */
  private reconcileGrokAuthIfGrokAgent(name: string): void {
    try {
      const cmd = this.manager.defOf(name)?.cmd ?? "";
      const runtime = this.ledger.get(name)?.resume?.runtime;
      const isGrok = binaryOf(cmd) === "grok" || runtime === "grok";
      // Also cover ad-hoc / ledger-only rows where cmd is empty but the private home exists.
      if (!isGrok && !fs.existsSync(path.join(this.workspaceRoot, ".tachyon", "bridge-mcp", `${name}.grok`, "auth.json"))) {
        return;
      }
      this.harness.reconcileGrokAuthFromWorkspace();
    } catch (err) {
      this.host.notify(
        `grok auth reconcile failed for '${name}': ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
    }
  }

  /**
   * spec 332 — a child with a live parent pokes it on an UNEXPECTED death (crash, clean self-exit,
   * external vanish); a deliberate kill/dismiss (marked via onKilled, dueto F3) is consumed here and
   * suppressed — cancellation never masquerades as completion. Best-effort: no parent, or a parent
   * that's also not running, means nobody to wake. `exitDescriptor` is the literal exit code or
   * "killed" (no code available — a vanished session).
   */
  private pokeParentOnDeath(agent: string, exitDescriptor: string, confirmVanished = false): void {
    if (this.expectedDeath.delete(agent)) return;
    if (this.manager.kindOf(agent) !== "agent") return;
    const parent = this.manager.parentOf(agent);
    if (!parent) return;
    const parentSession = this.manager.session(parent);
    const line = `[tachyon] child '${agent}' exited(${exitDescriptor}) — inspect Activity/read_output, dismiss, resume, or re-delegate`;
    // t-3a3a14c — onGone confirms absence via two consecutive LifecycleMonitor observations (b), not
    // a direct tmux read; re-check the CHILD's OWN session right before poking "killed" as a final,
    // cheap guard against whatever race those two ticks still missed (e.g. both hit the same
    // ambiguous list-panes error). Skipped for a confirmed dead-pane crash/clean-exit poke — those
    // already came from a real tmux read this tick, no recheck needed.
    const guard = confirmVanished ? this.tmux.hasSession(this.manager.session(agent)).catch(() => false) : Promise.resolve(false);
    void guard
      .then((stillThere) => {
        if (stillThere) return undefined; // false alarm — the child is actually still running
        return this.tmux
          .hasSession(parentSession)
          .then((alive) => (alive ? this.deliverNotice(parent, line, this.sourceNoticeMetadata(agent)) : undefined));
      })
      .catch(() => undefined); // best-effort poke — never let a delivery failure escape the lifecycle tick
  }

  /**
   * t-8605be — same machine as pokeParentOnDeath, for the other way a child goes unreachable: it enters
   * needs-input (an interactive prompt) instead of dying. Routed through deliverNotice so a busy parent
   * gets queued (341) rather than an interrupted paste. Best-effort: no parent, or a parent that's also
   * not running, means nobody to wake.
   */
  private pokeParentOnNeedsInput(agent: string, matchedLine: string | undefined): void {
    const parent = this.manager.parentOf(agent);
    if (!parent) return;
    const session = this.manager.session(parent);
    const line = matchedLine ?? "waiting for input";
    void this.tmux
      .hasSession(session)
      .then((alive) => (alive ? this.deliverNotice(parent, `[tachyon] child '${agent}' is waiting for input: ${line}`, this.sourceNoticeMetadata(agent)) : undefined))
      .catch(() => undefined); // best-effort poke — never let a delivery failure escape the monitor tick
  }

  private pokeParentOnThrottle(agent: string, attention: AgentAttention): void {
    const parent = this.manager.parentOf(agent);
    if (!parent) return;
    const session = this.manager.session(parent);
    const runtime = attention.rateLimit?.runtime ? ` ${attention.rateLimit.runtime}` : "";
    const reset = attention.rateLimit?.resetAt ? ` reset ${new Date(attention.rateLimit.resetAt).toLocaleString()}` : "";
    const line = attention.matchedLine ?? "provider throttled";
    void this.tmux
      .hasSession(session)
      .then((alive) => (alive ? this.deliverNotice(parent, `[tachyon] child '${agent}' is rate-limited${runtime}.${reset} ${line}`, this.sourceNoticeMetadata(agent)) : undefined))
      .catch(() => undefined);
  }

  private scheduleRateLimitAutoContinue(agent: string, attention: AgentAttention, attempt = 0): void {
    const resetAt = attention.rateLimit?.resetAt;
    if (!resetAt) return;
    const current = this.rateLimitRetries.get(agent);
    if (current?.episodeKey === attention.episodeKey && current.attempt === attempt) return;
    this.cancelRateLimitAutoContinue(agent);

    const now = Date.now();
    const delay = Math.max(1_000, resetAt - now + 5_000);
    const timer = setTimeout(() => {
      this.rateLimitRetries.delete(agent);
      void this.tryRateLimitAutoContinue(agent, attention.episodeKey, attempt).catch(() => {});
    }, delay);
    this.rateLimitRetries.set(agent, { timer, episodeKey: attention.episodeKey, attempt });
  }

  private cancelRateLimitAutoContinue(agent: string): void {
    const current = this.rateLimitRetries.get(agent);
    if (!current) return;
    clearTimeout(current.timer);
    this.rateLimitRetries.delete(agent);
  }

  private async tryRateLimitAutoContinue(agent: string, episodeKey: string, attempt: number): Promise<void> {
    const before = this.monitor.stateOf(agent);
    if (before?.state !== "throttled" || before.episodeKey !== episodeKey) return;
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session).catch(() => false))) return;

    await this.tmux.sendKeys(session, "", true);
    await new Promise((resolve) => setTimeout(resolve, ATTENTION_POLL_MS + 1_000));
    await this.monitor.tick().catch(() => undefined);
    const after = this.monitor.stateOf(agent);
    if (after?.state !== "throttled") return;

    const resetAt = after.rateLimit?.resetAt;
    if (resetAt && resetAt > Date.now() + 5_000) {
      this.scheduleRateLimitAutoContinue(agent, after, attempt + 1);
      return;
    }
    const backoff = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempt, 4));
    this.scheduleRateLimitAutoContinue(agent, { ...after, rateLimit: { ...after.rateLimit, resetAt: Date.now() + backoff } }, attempt + 1);
  }

  /** the 3s heartbeat (engine events make these happen sooner, never different) */
  async tick(): Promise<void> {
    void this.lifecycle.tick();
    void this.commandRunner.tick();
    this.scheduler.tick(); // fires anything due (workspace-open scope)
    await this.monitor.tick();
    await this.adhocBackstop.tick();
    await this.gatedCompletion.tick().catch(() => undefined);
    // States with durations ("idle 2m") need periodic re-render even without transitions.
    this.refreshAgentsViews();
  }

  /** t-875700 — gated agents with delegator + worktree + delivery binding (or synthetic id). */
  private async listGatedCompletionFacts(): Promise<
    Array<{
      agent: string;
      delegator: string;
      deliveryId: string;
      worktreePath: string;
      baseSha: string;
      sinceIso: string;
    }>
  > {
    const entries = await this.manager.list();
    const out: Array<{
      agent: string;
      delegator: string;
      deliveryId: string;
      worktreePath: string;
      baseSha: string;
      sinceIso: string;
    }> = [];
    for (const entry of entries) {
      if (entry.kind !== "agent" || !entry.delegator) continue;
      const rec = this.ledger.get(entry.name);
      const wtPath = rec?.worktree?.path ?? rec?.cwd;
      if (!wtPath) continue;
      const baseSha = rec?.worktree?.baseRef;
      if (!baseSha) continue;
      let deliveryId = `gated:${entry.name}`;
      let sinceIso = rec?.updatedAt ?? new Date(0).toISOString();
      const binding = rec?.delivery;
      if (isValidDeliveryBinding(binding)) {
        deliveryId = binding.deliveryId;
        try {
          const delivery = await this.deliveries.get(binding.deliveryId);
          if (delivery) {
            sinceIso = delivery.createdAt;
            // Prefer contract base when present
            if (delivery.contract.baseSha) {
              out.push({
                agent: entry.name,
                delegator: entry.delegator,
                deliveryId,
                worktreePath: wtPath,
                baseSha: delivery.contract.baseSha,
                sinceIso,
              });
              continue;
            }
          }
        } catch {
          /* fall through to ledger base */
        }
      }
      out.push({
        agent: entry.name,
        delegator: entry.delegator,
        deliveryId,
        worktreePath: wtPath,
        baseSha,
        sinceIso,
      });
    }
    return out;
  }

  private gatedCompletionStatePath(): string {
    return path.join(this.workspaceRoot, ".tachyon", "completion-candidates.json");
  }

  private loadGatedCompletionCandidates(): Record<string, GatedCandidateRecord> {
    const file = this.gatedCompletionStatePath();
    try {
      if (!fs.existsSync(file)) return {};
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { candidates?: Record<string, GatedCandidateRecord> };
      return raw.candidates && typeof raw.candidates === "object" ? raw.candidates : {};
    } catch {
      return {};
    }
  }

  private saveGatedCompletionCandidates(candidates: Record<string, GatedCandidateRecord>): void {
    const file = this.gatedCompletionStatePath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, candidates }, null, 2)}\n`, "utf8");
    } catch {
      /* best-effort durable state */
    }
  }

  /** Routes a fired schedule to the right executor. */
  private async runSchedule(name: string, def: import("../config/loadConfig.js").ScheduleDef): Promise<void> {
    this.host.notify(this.t("schedule '{0}' fired", name));
    this.deps.onViewsChanged("schedules");
    if (def.run !== undefined) {
      if (this.config?.commands[def.run]) await this.commandRunner.run(def.run);
      else if (this.config?.runbooks[def.run]) await this.runbookRunner.run(def.run);
      this.deps.onViewsChanged("commands");
    } else if (def.spawn !== undefined) {
      const running = await this.manager.runningAgents();
      if (!running.includes(def.spawn)) {
        await this.manager.spawn(def.spawn, def.instructions ? { taskBrief: def.instructions } : undefined);
      } else if (def.instructions) {
        // already up — deliver the prompt to its terminal
        await this.tmux.sendKeys(this.manager.session(def.spawn), def.instructions, true);
      }
      this.refreshAgentsViews();
    }
  }

  /** Approve a pending agent proposal: write it into tachyon.yml, drop the proposal. */
  approveProposal(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      this.host.notify(this.t("that proposal is no longer pending"), "warn");
      return false;
    }
    const ok = this.mutateConfig(
      (text) => upsertSchedule(text, proposal.name, proposal.schedule as Record<string, unknown>, true),
      () => {},
    );
    if (!ok) return false;
    this.proposals.remove(id);
    this.scheduler.activate(); // pick up the freshly-approved schedule's anchor
    this.deps.onViewsChanged("schedules");
    this.host.notify(this.t("schedule '{0}' approved — it's now active", proposal.name));
    return true;
  }

  rejectProposal(id: string): void {
    const proposal = this.proposals.get(id);
    this.proposals.remove(id);
    this.deps.onViewsChanged("schedules");
    if (proposal) this.host.notify(this.t("proposal '{0}' rejected", proposal.name));
  }

  deleteScheduleEntry(name: string): void {
    this.mutateConfig((text) => deleteSchedule(text ?? "", name), () => this.deps.onViewsChanged("schedules"));
  }

  toggleSchedulePause(name: string): void {
    const paused = !this.scheduler.isPaused(name);
    this.scheduler.setPaused(name, paused);
    this.deps.onViewsChanged("schedules");
    this.host.notify(paused ? this.t("schedule '{0}' paused", name) : this.t("schedule '{0}' resumed", name));
  }

  rebuildWatches(): void {
    this.watches.dispose();
    this.watches = new WatchController(async (agent) => {
      try {
        // spec 389 — file-watch rebuild is force + new (immediate replace, not resume).
        await this.manager.restart(agent, { stop: "force", session: "new" });
        this.host.notify(this.t("'{0}' restarted (watched file changed)", agent));
      } catch (err) {
        this.host.notify(this.t("watch-restart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
      }
    });
    for (const [name, def] of Object.entries(this.config?.agents ?? {})) {
      for (const glob of def.watch) {
        this.watches.watch(name, (onChange) => {
          const watcher = this.host.watch(this.workspaceRoot, glob, { change: true, create: true, delete: true }, onChange);
          return () => watcher.dispose();
        });
      }
    }
  }

  async start(): Promise<void> {
    const configOk = this.reloadConfig();
    // Re-discover sessions that survived a VSCode restart, then resume agents whose
    // process died (crash/reboot), then spawn the remaining pending autostarts.
    // Survivors are NOT auto-opened as tabs (hidden-tab attach renders blank).
    const surviving = await this.tmux.listSessions(`${SESSION_PREFIX}-${this.wsHash}-`);

    // Resume-on-activation (spec 209): classify ledger agents, auto-resume declared
    // autostart ones whose session is gone, stash the rest as a human-offered set.
    const states = await this.manager.agentStates();
    const liveSessions = new Set([...states].filter(([, s]) => !s.dead).map(([name]) => name));
    // t-572cef: a session that survived a reload never goes through onSpawned, so it would otherwise
    // have no agentIncarnations entry for the rest of this process's life — give every live agent a
    // current incarnation now so flushQueuedNotice's mismatch check has something to compare against.
    for (const name of liveSessions) {
      this.recordSpawnIncarnation(name);
    }
    // Spec 211: rebuild ad-hoc defs + lineage from the ledger BEFORE planning resume,
    // so a re-discovered ad-hoc agent is restartable and re-nests under its parent.
    // t-8354ae — also run when config is invalid so the sidebar can list ledger agents.
    await this.manager.rehydrateFromLedger();

    if (!configOk) {
      // t-8354ae — fail VISIBLE, not silent wipe: rehydrate + surface views, but never
      // autostart/auto-resume from LKG or a missing live config.
      this.host.notify(
        this.configFailure
          ? this.t(
              "invalid {0} — fleet shown from session ledger / last-known-good (read-only). Fix the config or run Tachyon: Doctor.",
              this.configFailure.file,
            )
          : this.t("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again"),
        "warn",
      );
      // Offer manual resume for ledger-resumable agents (defs are self-contained).
      const plan = planResume({
        ledger: this.ledger.all(),
        declaredAutostart: new Set(), // no autostart while config invalid
        liveSessions,
        deliveryUnavailableAgents: undefined,
        deliveryReloadSnapshotReady: false,
      });
      this.resumable = offers(plan);
      this.refreshAgentsViews();
      if (this.resumable.length > 0) this.offerResume();
      if (surviving.length > 0) this.host.notify(this.t("{0} re-discovered", surviving.length));
      return;
    }

    const declaredAutostart = new Set(
      Object.entries(this.config?.agents ?? {})
        .filter(([, def]) => def.autostart)
        .map(([name]) => name),
    );
    this.gcHarnessHomes(); // spec 226 (H8): drop config homes left by agents no longer declared/tracked
    const declaredInConfig = new Set(Object.keys(this.config?.agents ?? {}));
    await this.gcLedger(declaredInConfig, liveSessions); // spec 239: prune stale declared rows
    this.compactSessionOwners(declaredInConfig, liveSessions); // t-123143: prune stale session-owner rows
    this.gcOrphanAgentFootprints(liveSessions); // t-8310ca: continuity (+ activity) for names no longer known
    await this.rehydratePipelines(); // spec 230: restore pipeline runs so a reloaded run's surviving nodes can still complete
    // SDD 368 T14/R4 — recompute after ledger rehydration/GC (same attempt helper as _create).
    // Reflects post-rehydrate truth and allows a prior failed create/start to become ready.
    await this.attemptDeliveryReloadSnapshot();
    const reload = this.deliveryReload;
    const plan = planResume({
      ledger: this.ledger.all(),
      declaredAutostart,
      liveSessions,
      deliveryUnavailableAgents: reload.phase === "ready" ? reload.snapshot.unavailableAgents : undefined,
      deliveryReloadSnapshotReady: reload.phase === "ready",
    });
    let resumed = 0;
    for (const item of autoResumes(plan)) {
      try {
        await this.manager.resume(item.name, item.record);
        resumed++;
      } catch (err) {
        // No transcript / unresolved id → let the fresh autostart below handle it.
        if (!(err instanceof ResumeUnavailableError)) {
          this.host.notify(this.t("resume of '{0}' failed: {1}", item.name, err instanceof Error ? err.message : String(err)), "error");
        }
      }
    }
    this.resumable = offers(plan);

    // Fresh autostart for declared agents not already present (resumed ones now are).
    const pending = await this.manager.autostartPending();
    for (const agent of pending) {
      try {
        await this.manager.spawn(agent);
      } catch (err) {
        // Benign race with resume/re-entry/rebind: session can be live before spawn runs.
        // Same swallow as autostartNewlyDeclared — do not toast "already running" as a failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already running")) {
          this.host.notify(this.t("autostart of '{0}' failed: {1}", agent, msg), "error");
        }
      }
    }
    this.rebuildWatches();
    await this.restoreOpenTerminals();

    const parts: string[] = [];
    if (surviving.length > 0) parts.push(this.t("{0} re-discovered", surviving.length));
    if (resumed > 0) parts.push(this.t("{0} resumed with context", resumed));
    if (pending.length > 0) parts.push(this.t("{0} started", pending.length));
    if (parts.length > 0) this.host.notify(parts.join(", "));
    if (this.resumable.length > 0) this.offerResume();
  }

  /**
   * dogfood p-5a2a83 follow-up — start agents that a LIVE tachyon.yml edit just added with
   * `autostart: true` (and aren't already running). `before` is the agent-name set captured
   * before the reload; `newlyDeclaredAutostart` keeps this to genuinely-new names, so an
   * intentionally-stopped existing agent is never resurrected. A benign "already running" (a
   * race with another start path) is swallowed silently.
   */
  async autostartNewlyDeclared(before: Set<string>): Promise<void> {
    const running = new Set(await this.manager.runningAgents());
    for (const name of newlyDeclaredAutostart(before, this.config?.agents ?? {}, running)) {
      try {
        await this.manager.spawn(name);
        this.refreshAgentsViews();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already running")) {
          this.host.notify(this.t("autostart of '{0}' failed: {1}", name, msg), "error");
        }
      }
    }
  }

  /** Notifies that N agents can be resumed and wires a one-click "Resume all". */
  private offerResume(): void {
    const n = this.resumable.length;
    this.host.notify(this.t("{0} agent(s) can be resumed with their prior context", n), "info", [
      { label: this.t("Resume all"), run: () => void this.resumeAllOffered() },
    ]);
  }

  /** Names of agents the human can resume (dead session + ledger entry, not auto-resumed). */
  resumableAgents(): string[] {
    return this.resumable.map((p) => p.name);
  }

  /** Resume one offered/known agent by name (sidebar ↻ / command). */
  async resumeAgent(name: string): Promise<void> {
    const record = this.ledger.get(name);
    if (!record) throw new Error(`no resumable session for '${name}'`);
    try {
      await this.manager.resume(name, record);
    } catch (err) {
      // spec 220 (codex dueto MAJOR): a genuinely-gone session degrades to a fresh start for a
      // DECLARED agent (parity with resumeAllOffered), instead of hard-erroring the sidebar ↻.
      if (err instanceof ResumeUnavailableError && record.declared) {
        await this.manager.spawn(name);
      } else {
        throw err;
      }
    }
    this.resumable = this.resumable.filter((p) => p.name !== name);
    this.refreshAgentsViews();
  }

  /** Resume every currently-offered agent; declared stale sessions fall back to fresh spawn. */
  async resumeAllOffered(): Promise<void> {
    const failed: typeof this.resumable = [];
    for (const item of [...this.resumable]) {
      try {
        await this.manager.resume(item.name, item.record);
      } catch (err) {
        try {
          if (err instanceof ResumeUnavailableError && item.record.declared) {
            await this.manager.spawn(item.name);
          } else {
            throw err;
          }
        } catch (fallbackError) {
          failed.push(item);
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          this.host.notify(this.t("could not resume agent '{0}': {1}", item.name, detail), "error");
        }
      }
    }
    // Keep failed offers actionable instead of silently discarding their recovery path.
    this.resumable = failed;
    this.refreshAgentsViews();
  }

  /**
   * Applies a UI-driven mutation to tachyon.yml (the file stays the source of
   * truth), then reloads config and refreshes. Surfaces warnings.
   */
  mutateConfig(
    mutate: (text: string | undefined) => { text: string; warnings: string[] },
    afterReload?: () => void,
  ): boolean {
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    try {
      const { text, warnings } = mutate(existing);
      // t-099be8 — validate the full resulting file BEFORE write (same gate as Studio submit / Bridge tool).
      // Never persist a config that loadConfig would reject; the delayed-detonation window (invalid on disk
      // until next reload) is the incident class this blocks for UI-driven edits.
      const check = parseConfig(text);
      if (check.errors.length > 0) {
        throw new Error(`invalid tachyon.yml (not saved): ${check.errors[0]}${check.errors.length > 1 ? ` (+${check.errors.length - 1} more)` : ""}`);
      }
      fs.writeFileSync(file, text, "utf8");
      this.reloadConfig();
      this.rebuildWatches();
      afterReload?.();
      for (const warning of [...warnings, ...check.warnings]) this.host.notify(warning, "warn");
      return true;
    } catch (err) {
      this.host.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  /**
   * t-099be8 — agent-facing validate-then-write for the workspace tachyon.yml.
   * Refuses to save on parse/schema/cross-ref hard errors; returns structured result (no throw).
   */
  writeTachyonConfigText(yamlText: string): { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
    const check = parseConfig(yamlText);
    if (check.errors.length > 0) return { ok: false, errors: check.errors, warnings: check.warnings };
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    try {
      fs.writeFileSync(file, yamlText.endsWith("\n") ? yamlText : `${yamlText}\n`, "utf8");
    } catch (err) {
      return { ok: false, errors: [`cannot write tachyon.yml: ${err instanceof Error ? err.message : String(err)}`], warnings: check.warnings };
    }
    this.reloadConfig();
    this.rebuildWatches();
    this.refreshAgentsViews();
    this.deps.onViewsChanged("commands");
    for (const warning of check.warnings) this.host.notify(warning, "warn");
    return { ok: true, warnings: check.warnings };
  }

  // spec 234 — applyLayoutWithSpawn / applyDefaultLayout removed (layouts feature retired).

  // spec 233 — `saveLayoutAs` (the editor-arrangement capture/prompt feature) was removed here: the
  // layouts feature is discontinued (FEATURES.layouts=false; its commands are `when:false`), so the
  // method was dead code AND the last `vscode` touchpoint in the engine. Removing it completes the
  // engine/UI decoupling. The broader layout-surface cleanup (applyLayout, the tree provider) is a
  // separate follow.

  /** spec 377 T15A — config accessor for journaled profile mutations (CAS + compensate). */
  soulProfileConfigAccess(_agentName?: string): ProfileTxConfigAccess {
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    return {
      configPath: file,
      readConfigText: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
      writeConfigText: (text: string) => {
        const result = this.writeTachyonConfigText(text);
        if (!result.ok) throw new Error(result.errors[0] ?? "could not write tachyon.yml");
        return text;
      },
      isSoulEnabled: (name: string) => this.config?.agents[name]?.soul === true,
    };
  }

  private makeSoulProfileAccess(): (principal: string) => ProfileTxConfigAccess {
    return (principal) => this.soulProfileConfigAccess(principal);
  }

  async reconcileSoulProfileTransactions(): Promise<{ reconciled: string[]; degraded: string[] }> {
    return reconcileProfileTransactions(this.workspaceRoot, this.makeSoulProfileAccess());
  }

  async createSoulProfile(agentName: string): Promise<ProfileMutationResult> {
    return createSoulProfile(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName));
  }

  async importSoulProfile(agentName: string, sourcePath: string): Promise<ProfileMutationResult> {
    return importSoulProfileTransaction(this.workspaceRoot, agentName, sourcePath, this.soulProfileConfigAccess(agentName));
  }

  async importSoulProfileBytes(agentName: string, bytes: Buffer): Promise<ProfileMutationResult> {
    return importSoulProfileBytesTransaction(this.workspaceRoot, agentName, bytes, this.soulProfileConfigAccess(agentName));
  }

  async replaceSoulProfileBytes(agentName: string, bytes: Buffer, expectedDigest: string): Promise<ProfileMutationResult> {
    return replaceSoulProfileBytesTransaction(this.workspaceRoot, agentName, bytes, expectedDigest, this.soulProfileConfigAccess(agentName));
  }

  async adoptSoulProfile(agentName: string, expectedDigest: string): Promise<ProfileMutationResult> {
    return adoptSoulProfile(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName), {
      expectedDigest,
      enable: true,
    });
  }

  async enableSoulProfile(agentName: string): Promise<ProfileMutationResult> {
    return enableSoulProfile(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName));
  }

  async disableSoulProfile(agentName: string): Promise<ProfileMutationResult> {
    return disableSoulProfile(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName));
  }

  async deleteSoulProfile(agentName: string): Promise<ProfileMutationResult> {
    return deleteSoulProfile(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName));
  }

  async refreshSoulProfile(agentName: string): Promise<SoulProfileStatus> {
    return refreshSoulProfileStatus(this.workspaceRoot, agentName, this.soulProfileConfigAccess(agentName));
  }

  async readAgentEvolutionOverview(agentName: string): Promise<EvolutionStudioOverview> {
    const def = this.config?.agents[agentName];
    return readEvolutionStudioOverview(
      this.evolutionStore,
      agentName,
      def?.kind === "agent" && def.selfEvolution?.enabled === true,
    );
  }

  async readAgentEvolutionCandidate(agentName: string, candidateId: string): Promise<EvolutionStudioCandidateDetail> {
    return readEvolutionStudioCandidateDetail(this.evolutionStore, agentName, candidateId);
  }

  async approveAgentEvolutionCandidate(
    agentName: string,
    candidateId: string,
    input: { expectedActiveVersion: number; expectedTargetDigest?: string },
  ): Promise<{ candidateId: string; activeVersion: number }> {
    const result = await this.evolutionStore.approveCandidate(agentName, candidateId, input);
    return { candidateId: result.candidate.id, activeVersion: result.profile.activeVersion };
  }

  async rejectAgentEvolutionCandidate(
    agentName: string,
    candidateId: string,
    input: { expectedActiveVersion: number; expectedTargetDigest?: string },
  ): Promise<{ candidateId: string; activeVersion: number }> {
    const candidate = await this.evolutionStore.rejectCandidate(agentName, candidateId, input);
    const profile = await this.evolutionStore.readProfile(agentName);
    return { candidateId: candidate.id, activeVersion: profile?.activeVersion ?? input.expectedActiveVersion };
  }

  canonicalSoulPath(agentName: string): string {
    return agentSoulPath(this.workspaceRoot, agentName);
  }

  async canonicalSoulPathForOpen(agentName: string): Promise<string> {
    const bytes = await readCanonicalSoulBytes(this.workspaceRoot, agentName);
    if (!bytes) throw new SoulError("soul/missing", `No canonical SOUL.md exists for '${agentName}'`);
    return agentSoulPath(this.workspaceRoot, agentName);
  }

  /** Agent Studio submit pipeline — webview form and the internal test seam. */
  studioSubmit = (submit: StudioSubmit): string[] | undefined => {
    const kind = submit.state.kind;
    const takenMap =
      kind === "command" ? this.config?.commands : kind === "runbook" ? this.config?.runbooks : kind === "schedule" ? this.config?.schedules : this.config?.agents;
    const errors = blockingErrors(validateForm(submit.state, Object.keys(takenMap ?? {}), submit.editingName));
    if (errors.length > 0) return errors.map((e) => issueMessage(e, this.t));
    // spec 215 — an entry's kind decides its block; you can't flip agent↔terminal by editing
    // (the Studio also locks the tabs in edit mode). Reject rather than silently write the wrong
    // block (review fix: editing a terminals: entry on the Agent tab used to stay a terminal).
    if ((kind === "agent" || kind === "terminal") && submit.editingName) {
      const existingKind = this.config?.agents[submit.editingName]?.kind;
      if (existingKind && existingKind !== kind) {
        return [this.t("can't change '{0}' between agent and terminal by editing — delete it and recreate", submit.editingName)];
      }
    }
    const entry = toEntry(submit.state);
    const isScheduleOrCommandOrRunbook = kind === "command" || kind === "runbook" || kind === "schedule";
    const doUpsert = (text: string | undefined) =>
      kind === "command"
        ? upsertCommand(text, submit.state.name, entry, submit.editingName)
        : kind === "runbook"
          ? upsertRunbook(text, submit.state.name, entry as { steps: string[] }, submit.editingName)
          : kind === "schedule"
            ? upsertSchedule(text, submit.state.name, entry, submit.editingName !== undefined)
            // spec 215 — a NEW terminal lands in the terminals: block; an edit rewrites it in
            // its current block (upsertAgent resolves that). The agent path stays agents:.
            : upsertAgent(text, submit.state.name, entry, submit.editingName, kind === "terminal" ? "terminals" : "agents");
    // codex 228-review B1 — validate the resulting FULL config BEFORE persisting. The harness form is
    // intentionally shallow (loadConfig is authoritative for ${VAR}-env / server shape), so a
    // structurally-valid-YAML-but-invalid harness must not silently break the whole tachyon.yml. Surface
    // the real config errors back to the form; write nothing on failure.
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    let candidate: { text: string; warnings: string[] };
    try {
      candidate = doUpsert(existing);
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
    const cfg = parseConfig(candidate.text);
    if (cfg.errors.length > 0) return cfg.errors;
    const ok = this.mutateConfig(
      () => candidate,
      () => this.deps.onViewsChanged(kind === "schedule" ? "schedules" : isScheduleOrCommandOrRunbook ? "commands" : "agents"),
    );
    if (!ok) return [this.t("could not write tachyon.yml — see the notification")];
    if (kind === "schedule") this.scheduler.activate(); // anchor a freshly-created schedule
    // F2 (dogfood): a freshly-CREATED agent declared autostart:true should start now —
    // not only on the next workspace open. Targeted to the create path (editingName
    // undefined) so editing the yml never auto-(re)starts an intentionally-stopped agent.
    const isAgentKind = !isScheduleOrCommandOrRunbook;
    const autostarted = isAgentKind && submit.editingName === undefined && !!this.config?.agents[submit.state.name]?.autostart;
    if (autostarted) {
      void this.manager.spawn(submit.state.name).then(() => this.refreshAgentsViews()).catch((err) => {
        this.host.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }
    this.host.notify(
      kind === "command"
        ? this.t("command '{0}' saved — ▶ in the sidebar (or run_command) runs it", submit.state.name)
        : kind === "runbook"
          ? this.t("runbook '{0}' saved — ▶ in the sidebar (or run_runbook) runs it", submit.state.name)
          : kind === "schedule"
            ? this.t("schedule '{0}' saved — it's now active", submit.state.name)
            : autostarted
              ? this.t("'{0}' saved & started (autostart)", submit.state.name)
              : this.t("'{0}' saved — ▶ in the sidebar starts it", submit.state.name),
    );
    return undefined;
  };

  studioDeps(): StudioDeps {
    return {
      extensionUri: this.host.webviewRoot() as StudioDeps["extensionUri"],
      detectClis: detectInstalledClis,
      takenNames: () => Object.keys(this.config?.agents ?? {}),
      commandNames: () => Object.keys(this.config?.commands ?? {}),
      verifyCandidates: () => this.verifyCandidates(),
      defaultCwd: this.workspaceRoot,
      inferKind,
      onSubmit: this.studioSubmit,
    };
  }

  async restoreOpenTerminals(): Promise<void> {
    await this.terminals.restoreOpen((session) => this.tmux.hasSession(session));
  }

  private terminalManifestStateKey(): string {
    return `tachyon.terminals.open.v1.${this.wsHash}`;
  }

  /**
   * spec 214 — the Studio's verify-gate suggestions: stack-derived candidates (Node package.json
   * scripts, cargo/go/pytest/…) FIRST, then the project's already-declared command + runbook
   * names. Offered as pick-or-edit chips; the human always has the final word (can type their own).
   */
  verifyCandidates(): string[] {
    return collectVerifyCandidates(this.workspaceRoot, this.config);
  }

  /**
   * Live rename across every subsystem: the tmux session follows (attached
   * clients ride along), session-local memory rekeys (ad-hoc def, lineage,
   * resume ledger), the yml updates for declared agents, and an open editor
   * pane is reopened under the new name (terminal titles can't change in place).
   * Attention state self-heals on the next tick; watchers rebuild on reload.
   */
  async renameAgent(oldName: string, newName: string): Promise<void> {
    const wasOpen = this.terminals.has(oldName);
    if (wasOpen) this.terminals.close(oldName);
    await this.manager.rename(oldName, newName);
    const wasDeclared = this.config?.agents[oldName] !== undefined;
    if (wasDeclared) {
      if (!this.mutateConfig((text) => renameAgentInYml(text ?? "", oldName, newName))) {
        // yml refused after the session moved — move it back so tree and config agree.
        await this.manager.rename(newName, oldName);
        if (wasOpen) this.terminals.open(oldName, this.manager.session(oldName));
        return; // rolled back — the flag correctly stays under oldName
      }
    }
    try {
      await this.evolutionStore.renameAgent(oldName, newName);
    } catch (error) {
      // Config now names the new agent, so the old manager key is free for a rollback.
      const rollbackFailures: unknown[] = [error];
      let managerRolledBack = false;
      try {
        await this.manager.rename(newName, oldName);
        managerRolledBack = true;
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
      if (wasDeclared && !this.mutateConfig((text) => renameAgentInYml(text ?? "", newName, oldName))) {
        rollbackFailures.push(new Error("tachyon.yml rollback was refused"));
      }
      if (wasOpen && managerRolledBack) {
        try {
          this.terminals.open(oldName, this.manager.session(oldName));
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length > 1) {
        throw new AggregateError(rollbackFailures, "Agent Evolution rename failed and rollback was incomplete");
      }
      throw error;
    }
    // spec 216 (codex r2): a live rename moves the SAME session (no restart, no onSpawned/onKilled),
    // so carry any pending re-anchor flag to the new name and clear a stale flag on the new identity.
    this.pendingAnchor.delete(newName);
    if (this.pendingAnchor.delete(oldName)) this.pendingAnchor.add(newName);
    this.agentIncarnations.delete(newName);
    const incarnation = this.agentIncarnations.get(oldName);
    if (incarnation !== undefined) {
      this.agentIncarnations.delete(oldName);
      this.agentIncarnations.set(newName, incarnation);
      this.agentIncarnationCounters.set(newName, Math.max(this.agentIncarnationCounters.get(newName) ?? 0, incarnation));
    }
    if (wasOpen) this.terminals.open(newName, this.manager.session(newName));
    this.refreshAgentsViews();
  }

  openCommandPane(name: string): void {
    this.terminals.open(`cmd:${name}`, this.commandRunner.session(name), undefined, `$ ${name}`);
  }

  openRunbookStepPane(runbook: string, index: number): void {
    this.terminals.open(`rb:${runbook}:${index}`, this.runbookRunner.stepSession(runbook, index), undefined, `$ ${runbook}#${index + 1}`);
  }

  /** Folder removed from the window (or extension deactivating). tmux sessions survive. */
  async dispose(): Promise<void> {
    // Stop admitting work before any awaited teardown can release a slot and
    // accidentally start a queued subprocess fallback during disposal.
    this.tmux.dispose();
    if (this.ticker) clearInterval(this.ticker);
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    if (this.taskFileRefreshTimer) clearTimeout(this.taskFileRefreshTimer);
    for (const retry of this.rateLimitRetries.values()) clearTimeout(retry.timer);
    this.rateLimitRetries.clear();
    this.clientRebind?.dispose();
    this.clientRebind = undefined;
    for (const d of this.disposables) d.dispose();
    this.watches.dispose();
    this.terminals.dispose();
    this.waiters.dispose();
    await Promise.allSettled([this.bridge.dispose(), this.engine.dispose()]);
  }
}
