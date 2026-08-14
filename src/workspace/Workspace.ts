import path from "node:path";
import { isTemporaryInstance, mayRestartInstance } from "../agents/agentInstancePolicy.js";
import {
  formatResidueNames,
  partitionStoppedTemporaryResidue,
} from "../agents/stoppedTemporaryResidue.js";
import { ideBrowserRequest, isIdeBrowserBridgeAvailable } from "../ide-browser/client.js";
import {
  IDE_BROWSER_DISABLED_CODE,
  IDE_BROWSER_DISABLED_ERROR,
  isIdeBrowserEnabled,
} from "../ide-browser/settings.js";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { TmuxService, workspaceHash, SESSION_PREFIX, type SubmitReceipt } from "../tmux/TmuxService.js";
import { ControlModeClient } from "../tmux/ControlModeClient.js";
import { agentsOf, asAgent, CONFIG_FILENAMES, suggestKindForCommand, terminalsOf, type TachyonConfig } from "../config/loadConfig.js";
import { removeAgentWorktree, stopAgentSessionForDelete } from "../agents/agentRemovalCascade.js";
import { projectAgentForgetPlan, type AgentForgetPlanV1 } from "@tachyon/shared/config/agentForgetPlan.js";
import {
  loadProfileAwareConfig,
  parseProfileAwareConfigSyntax,
} from "../config/agentProfileConfigLoader.js";
import {
  parseAgentProfileAuthorityRegistry,
  serializeAgentProfileAuthorityRegistry,
  type AgentProfileAuthorityRecord,
} from "../config/agentProfileAuthority.js";
import {
  deriveSavedAgentState,
  isSavedAgentStateMember,
  savedAgentRemovalDoor,
  type SavedAgentPresenceFacts,
  type SavedAgentRemovalDoor,
  type SavedAgentState,
} from "../config/savedAgentState.js";
import {
  type AgentProfileAuthorityPort,
} from "../config/agentProfileTransactions.js";
import {
  agentProfileLifecycleBlocked,
  commitAgentProfileLifecycle as commitCanonicalAgentProfileLifecycle,
  inspectAgentProfileLifecycle as inspectCanonicalAgentProfileLifecycle,
  reconcileAgentProfileLifecycle,
  type AgentProfileLifecycleCommitResult,
  type AgentProfileLifecycleSnapshot,
  type CommitAgentProfileLifecycleInput,
} from "../config/agentProfileLifecycle.js";
import {
  authorizeAgentPlugin,
  authorizeAgentSkill,
  authorizedSkillStates,
  revokeAgentSkill,
  skillOriginFor,
  type SkillAuthorizationPorts,
} from "../config/agentSkillAuthorizationService.js";
import { annotateAuthorized, listAuthorizableCapabilities } from "../config/agentCapabilityCandidates.js";
import {
  agentProfileRenameBlocked,
  commitAgentProfileRename,
  reconcileAgentProfileRenames,
} from "../config/agentProfileRename.js";
import {
  agentProfileForgetBlocked,
  agentProfileForgetRetainedNames,
  agentProfileForgetRetentionUncertain,
  commitAgentProfileForget,
  reconcileAgentProfileForgets,
  type AgentProfileForgetResult,
} from "../config/agentProfileForget.js";
import {
  clonePortableAgentProfile,
  exportPortableAgentProfileBundle,
  importPortableAgentProfileBundle,
  type ImportPortableAgentProfileResult,
  type PortableAgentProfileBytes,
} from "../config/agentProfileBundle.js";
import {
  agentOwnershipView,
  createProfileFromStudioMutation,
  ownershipPatchFromStudioMutation,
  proposeSavedAgentGrantPatchFromStudioMutation,
  patchProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  assertOwnershipTargets,
  type AgentOwnershipRosterV1,
  type AgentOwnershipViewV1,
  type AgentProfileStudioLifecycleMutationV1,
  type AgentProfileStudioLifecycleResultV1,
  type AgentProfileStudioMutationV1,
  type AgentProfileStudioSnapshotV1,
} from "@tachyon/shared/config/agentProfileStudio.js";
import {
  POST_CUT_SESSION_ATTESTATION_ENV,
  describeLegacyFleetRefusal,
  inspectLegacyFleet,
  isTransientLegacyRefusal,
} from "../agents/legacyFleetGate.js";
import { scanAgentRosterDirectory } from "../config/agentRosterDirectory.js";
import { AgentProfileRefusal, isAgentProfileRefusal } from "@tachyon/shared/config/agentProfileRefusal.js";
import { snapshotFromConfig, writeConfigLkg, readConfigLkg, type ConfigLkgSnapshot } from "../config/configLkg.js";
import {
  type ConfigFailure,
  isLkgOnlySpawn,
  lkgSpawnRefusalMessage,
} from "../config/configFailure.js";
import { makeConfigDiscards, type ConfigDiscards } from "../config/configDiscards.js";
import { upsertCommand, upsertRunbook, upsertSchedule, deleteSchedule } from "../config/YamlConfigEditor.js";
import {
  cloneTerminalDeclaration,
  deleteLegacyTerminalDeclaration,
  deleteTerminalDeclaration,
  renameTerminalDeclaration,
  upsertTerminalDeclaration,
} from "../config/terminalDeclarations.js";
import { AgentManager, ResumeUnavailableError, WatchController, newlyDeclaredAutostart, type ManagedEntryInfo, type RestartSessionMode } from "../agents/AgentManager.js";
import { SurfacePreservation } from "./surfacePreservation.js";
import { mergedWorkspaceCommandReferences, workspaceCommandWriteFor } from "../config/agentWorkspaceCommandWrite.js";
import { mergedPersistentInstructionsReferences, persistentInstructionsWriteFor } from "../config/agentInstructionsWrite.js";
import { agentLaunchPath } from "../agents/spawnPath.js";
import { SessionLedger, durableBoundGeneration } from "../resume/SessionLedger.js";
import { createFormationLifecycleHost } from "../agents/formation/lifecycleHost.js";
import { createFormationAdoptionHost, type FormationAdoptionHost } from "../agents/formation/adoptionHost.js";
import type { FormationAdoptionRecord, FormationAdoptionState } from "../agents/formation/bootstrapTransaction.js";
import { readCanonicalAgentProfile, readCanonicalAgentProfileEntry, closeCanonicalAgentProfile } from "../config/agentProfileReader.js";
import type { FormationLifecyclePort } from "../agents/formation/lifecycleConsumer.js";
import { WorktreeManager, resolveWorktreeCwd, branchFor, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { shareDependencies } from "../worktree/dependencySharing.js";
import { resolveParentLocation } from "../worktree/parentLocation.js";
import { approvalResolutionPorts } from "../bridge/approvalResolutionPorts.js";
import { ManagedWorktreeService } from "../worktree/ManagedWorktreeService.js";
import { composeHygieneLineageSource, type OwnerPresence } from "../worktree/hygieneAuthority.js";
import { PipelineManager, type PipelineDeps } from "../pipeline/PipelineManager.js";
import { RunLedger } from "../pipeline/RunLedger.js";
import { loadPipeline, nodeSpawnName } from "../pipeline/loadPipeline.js";
import { assembleNodePrompt } from "../pipeline/nodePrompt.js";
import { initRun, type PipelineRun } from "../pipeline/runState.js";
import { randomBytes } from "node:crypto";
import { isWorktreeDirty } from "../worktree/pr.js";
import { HarnessManager, defaultRealOpencodeDataHome, measureDirUsage, realConfigHome, realRuntimeAuthHomeEnv, seedPrivateHomeGitIdentity } from "../harness/HarnessManager.js";
import { humanBytes } from "../humanInbox/loadArtifact.js";
import { materializePiSessionDir, removePiSessionDir } from "../agents/piSession.js";
import { expectedAgentClaudeEntry, expectedAgentOpencodeEntry } from "../registration/adapters.js";
import { adapterFor, binaryOf, harnessable, managesOwnSession, runtimeOf } from "@tachyon/shared/resume/adapters.js";
import { nodeCanSignal, nodeRuntimeOf } from "../pipeline/preflight.js";
import os from "node:os";
import { EVIDENCE_SCHEMA_VERSION, summarizeEvidence, viewEvidence, isSafeArtifactRef, type WorktreeEvidence, type EvidenceSummary, type EvidenceView } from "../worktree/evidence.js";
import { copyEvidenceArtifacts } from "../worktree/evidenceArtifacts.js";
import type { AttachEvidenceInput } from "../bridge/tools.js";
import { resolveCaptureId, resolveCaptureSession, resolveCurrentSession } from "../resume/resolvers.js";
import { planResume, autoResumes, offers, type ResumePlanItem } from "../resume/planResume.js";
import { LifecycleMonitor } from "../agents/LifecycleMonitor.js";
import { AttentionMonitor, type AgentAttention } from "@tachyon/shared/attention/AttentionMonitor.js";
import { isEvidencedWorking } from "../prompts/injectFlow.js";
import { contextRenewalGesture, type ContextRenewalMode } from "@tachyon/shared/anchor/compaction.js";
import { authRequiredOf, describeAuthRequired, runtimeLoginCommand, type AuthRequiredEvidence } from "@tachyon/shared/runtime/authRequired.js";
import { authRequiredLaunchNotice, loginFinishedNotice } from "./authRequiredNotice.js";
import { LoginRunner } from "../commands/LoginRunner.js";
import { applyCompletionHint, CompletionHintStore } from "../attention/completionHint.js";
import { TemporaryBackstopMonitor, idleNotifyThresholdMs } from "@tachyon/shared/workspace/TemporaryBackstopMonitor.js";
import {
  GatedCompletionMonitor,
  assignedCompletionFacts,
  resolveAssignedCompletionWorktree,
  type GatedCandidateRecord,
  type GatedCompletionFacts,
} from "./GatedCompletionMonitor.js";
import { isVerifiedSince } from "./verifyRecordReader.js";
import { defaultGitExec } from "../worktree/WorktreeManager.js";
import { appendDoorbellOverflowEvent, hasDoorbellRung } from "../bridge/doorbell.js";
import { resolveClipboardHelperAsync } from "../tmux/clipboard.js";
import { compileExtraPatterns } from "@tachyon/shared/attention/patterns.js";
import { subtreeCpuTicks } from "../attention/cpu.js";
import { Waiters } from "../bridge/Waiters.js";
import {
  DEFAULT_NOTICE_TTL_MS,
  NoticeQueue,
  type NoticeOrigin,
  type NoticeQueueItem,
  type NoticeQueueMetadata,
} from "../bridge/NoticeQueue.js";
import { Bridge, derivePort } from "../bridge/Bridge.js";
import { CompanionPairingService } from "../companion/CompanionPairingService.js";
import { CompanionLiveSync } from "../companion/CompanionLiveSync.js";
import { CompanionTabChannel } from "../companion/CompanionTabChannel.js";
import {
  companionListenHost,
  companionPairBaseUrl,
  companionPairBaseUrlCandidates,
  resolveTailscaleIPv4,
} from "../companion/lanReachability.js";
import type { CompanionPairBlockReason } from "../companion/CompanionPairingService.js";
import { resolveCompanionMobileDist } from "../companion/mobileAppStatic.js";
import { TabRefCache } from "../companion/tabRefCache.js";
import {
  APPROVAL_CHANNEL_COMPANION_HTTP,
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
import { loadOrCreateExternalToken, loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR, AGENT_TOKEN_ENV_VAR } from "../bridge/token.js";
import { healUnknownBearerFromProc } from "../bridge/agentTokenHeal.js";
import { CallerIdentityRegistry, loadOrCreateHmacKey, type CallerScope, type CallerSnapshot, type PersistableEntry } from "../bridge/callerIdentity.js";
import {
  agentProfileAuthoritiesSecretKey,
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
import { ProposalStore, scheduleProposalExpired } from "../schedule/ProposalStore.js";
import { readAgentProfileGrants } from "../config/agentProfileGrants.js";
import { PinStore } from "../pins/PinStore.js";
import { TaskStore } from "../tasks/TaskStore.js";
import { collectSessionInspection } from "../runtimeOps/collectSessionInspection.js";
import type { InspectedSession } from "../runtimeOps/sessionInspection.js";
import { wakeTaskAssignee, type TaskAssigneeWakePorts } from "../tasks/taskNotificationPolicy.js";
import { ValidationStore } from "../validations/ValidationStore.js";
import { ProbeService } from "../probe/ProbeService.js";
import { ProbeStore } from "../probe/ProbeStore.js";
import { claudeAdapter } from "../probe/adapters/claude.js";
import { codexAdapter } from "../probe/adapters/codex.js";
import { grokAdapter } from "../probe/adapters/grok.js";
import { buildProbeView, type ProbeView } from "../probe/probeView.js";
import { ContinuityStore } from "../continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../handoff/ProjectHandoffStore.js";
import { ContinuityState } from "../continuity/ContinuityState.js";
import { classifyInjection, CONTINUITY_STALE_LAG, injectionText, type Transition } from "../continuity/classifier.js";
import { gcOrphanAgentFootprints } from "../continuity/orphanGc.js";
import { ActivityLog, agentLogId } from "../activity/logStore.js";
import { compactSessionOwnerRows, compactSpawnSettings, latestOwnerFor, persistenceHookFailureFile, readPersistenceHookFailures, readSessionOwners, sessionOwnersFile, type OwnershipHookGroup } from "../activity/sessionOwners.js";
import { planProjectedPluginHooks, readHookProjectionCandidates } from "../plugins/agentHookProjection.js";
import { forgetAgent as forgetAgentFootprint } from "../agents/forgetAgent.js";
import {
  HeadlessTerminalPresentation,
  type TerminalPresentation,
} from "./TerminalPresentation.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { validateForm, validateTerminalForm, blockingErrors, toEntry, toTerminalEntry } from "../webview/formLogic.js";
import type { StudioSubmit, StudioDeps } from "../webview/studioSubmit.js";
import type { EngineHost, HostDisposable, ViewKind } from "./EngineHost.js";
import { composerProfileFor } from "@tachyon/shared/runtime/composerRegion.js";
import type { RuntimeLaunchPreflightPort } from "@tachyon/shared/runtime/launchPreflight.js";
import type { NoticeDeliveryResult, NotifyLevel } from "../bridge/tools.js";
import { resolveOpencodeStorageSession } from "./opencodeStorage.js";
import { createGitExec, type GitExec } from "../worktree/WorktreeManager.js";
import { resolveGitBinaryForHost } from "../worktree/gitBinary.js";
import { sharedGlobalSettings } from "../config/globalSettings.js";
import { TaskNotificationService } from "./TaskNotificationService.js";
import { BridgeSlowRequestToastPolicy } from "./bridgeSlowRequestPolicy.js";
import { ExternalToolRegistry } from "../externalTools/registry.js";
import { hostActionTouchesHostUi } from "../externalTools/filters.js";
import type { ClaudeStatusLineCaptureTransport } from "../runtimeObservability/claudeStatusLineCapture.js";
import {
  projectRuntimeCondition,
  type RuntimeConditionInputV1,
  type RuntimeConditionReportV1,
} from "../runtimeOps/runtimeCondition.js";
import { RuntimeSlackMonitor } from "./RuntimeSlackMonitor.js";

const ATTENTION_POLL_MS = 3000;

/**
 * t-1129e1 — how long a SELF-CLEARING legacy-fleet refusal is given before it is reported. Measured on
 * the reload that produced the task: the pre-cut session exited and its attested replacement was up
 * within ~40 seconds. Bounded on purpose — this changes WHEN a refusal is reported, never WHETHER.
 */
const LEGACY_FLEET_RECHECK_ATTEMPTS = 15;
const LEGACY_FLEET_RECHECK_INTERVAL_MS = 4_000;

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

export interface WorkspaceDeps {
  /** spec 233 — the host port the engine calls instead of `vscode` (the VS Code shell passes a VsCodeHost). */
  host: EngineHost;
  /** refresh the (global) sidebar providers + the attention badge */
  onViewsChanged: (view: ViewKind) => void;
  /** host-side UI affordance for newly recorded human-approval requests. */
  onApprovalRequested?: (ws: Workspace, request: { id: string; requester: string }) => void;
  /** t-8e9b5e — a Saved Agent proposal needs a human, exactly like an approval does. */
  onSavedAgentProposed?: (ws: Workspace, proposal: { id: string; name: string; proposer: string }) => void;
  /** t-afe120 — a Saved Agent removal proposal needs a human, same doorbell doctrine as create. */
  onSavedAgentRemovalProposed?: (ws: Workspace, proposal: { id: string; name: string; proposer: string }) => void;
  /** t-d4f246 — schedule proposals are first-class Human Inbox decisions. */
  onScheduleProposed?: (ws: Workspace, proposal: { id: string; name: string; proposer: string }) => void;
  /**
   * t-e76acc — the same affordance for a validation that lands on a human. Symmetric with the
   * approval hook above in EVERYTHING except authority: it carries a self-declared author (that is
   * what a validation has), it never injects into a session, and nothing downstream redeems it.
   */
  onHumanValidationPending?: (ws: Workspace, validation: { id: string; title: string; author: string }) => void;
  /** Optional extension-global Claude quota transport. It remains inert unless machine-local consent enables it. */
  claudeStatusLineCapture?: Pick<ClaudeStatusLineCaptureTransport, "materialize">;
  /**
   * t-458497 — the CACHED provider-observation state the runtime-condition projection reads.
   *
   * A synchronous accessor by contract: it hands over what the observation service already holds and
   * must never collect, because both consumers (the `runtime_condition` Bridge tool and the slack
   * doorbell) run on paths where starting a runtime process to answer would be a new measurement.
   * Absent when no observation service is wired — the projection then reports the quota channel as
   * `unknown` rather than claiming the runtimes have none.
   */
  runtimeQuotaObservations?: () => Omit<RuntimeConditionInputV1, "generatedAt">;
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
  /** test-only native-profile inspection home; production inspects the real runtime home. */
  agentProfileHomeDir?: string;
  /**
   * t-35c998 — the launch preflight registry the AgentManager checks before every spawn. Production
   * omits it and gets the real one, where the opencode adapter EXECUTES `opencode providers list`
   * because reading the runtime's own credential store is the only honest answer to "is this
   * authenticated?". A unit test that inherits that runs an external CLI once per spawn, which is the
   * machine-dependence SDD 387 forbids; `test/helpers/hermeticLaunchPreflight` is what goes here.
   * `AgentManager` already accepted this seam directly — only the Workspace door was missing.
   */
  launchPreflight?: RuntimeLaunchPreflightPort;
}

/** Dev Host may inspect a disposable runtime home; normal installed workspaces always use os.homedir(). */
export function resolveAgentProfileHomeDir(
  seam: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (seam) return seam;
  if (env.TACHYON_DEV_HOST !== "1") return undefined;
  const candidate = env.TACHYON_DEV_HOST_PROFILE_HOME;
  return typeof candidate === "string" && path.isAbsolute(candidate) ? candidate : undefined;
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

/** Best-effort project config read; undefined on any failure. */
function safeRead(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
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
    case "terminal-cmd-is-attested-runtime":
      return t(
        "command: '{0}' is an LLM runtime Tachyon attests — create it as an agent in Agent Studio; terminals are for generic processes",
        issue.param ?? "this command",
      );
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
  readonly worktrees: WorktreeManager;
  /** spec 392 — product registry + change worktrees over WorktreeManager. */
  readonly managedWorktrees: ManagedWorktreeService;
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
  readonly monitor: AttentionMonitor;
  private readonly temporaryBackstop: TemporaryBackstopMonitor;
  /** t-875700 — host-fallback for gated omit-doorbell. */
  private readonly gatedCompletion: GatedCompletionMonitor;
  /** t-458497 — pokes the coordinator when a runtime's quota window comes back with room. */
  private readonly runtimeSlack: RuntimeSlackMonitor;
  /** t-9552f3 — session-local completion doorbell latch (in-memory). */
  private readonly completionHints = new CompletionHintStore();
  /** t-6f0377 — session-local and deliberately non-durable: death cancels the intent. */
  private readonly pendingContextRenewal = new Map<string, ContextRenewalMode>();
  /** t-b88106 — a relaunch never changes whether an agent is visible; this owns that rule. */
  private readonly surfaces = new SurfacePreservation();
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
  /** SDD 446 C — running agents keep their current session until the next lifecycle boundary. */
  private readonly runtimeConfigPending = new Map<string, { scope: "global" | "workspace"; revision: string }>();
  // t-fb1453 — the TTL was the one drop path that told nobody. It now reports like overflow does.
  private readonly noticeQueue = new NoticeQueue({ onExpired: (items) => this.reportExpiredNotices(items) });
  /** t-01a425 — summaries waiting for a parent that did not itself survive the reload. Kept separate
   *  from NoticeQueue because onSpawned deliberately clears that target's old-incarnation queue. */
  private readonly pendingReloadSummaries = new Map<string, { children: string[]; line: string }>();
  /** A reload summary already inside NoticeQueue, retained separately until submit is confirmed so a
   *  fast parent restart cannot turn queue clearing into a durable false acknowledgement. */
  private readonly queuedReloadSummaries = new Map<string, { children: string[]; line: string }>();
  readonly waiters: Waiters;
  readonly lifecycle: LifecycleMonitor;
  readonly pinStore: PinStore;
  readonly taskStore: TaskStore;
  private readonly taskNotifications: TaskNotificationService;
  readonly validationStore: ValidationStore;
  readonly continuityStore: ContinuityStore;
  readonly handoffStore: ProjectHandoffStore;
  readonly continuityState: ContinuityState;
  readonly commandRunner: CommandRunner;
  readonly runbookRunner: RunbookRunner;
  /** t-2656d7 — the governed per-runtime login pane the `Log in` action opens. */
  readonly loginRunner: LoginRunner;
  /**
   * t-2656d7 — who was refused, per runtime, since that runtime's login pane was opened.
   *
   * A set because the credential is per config home: N agents on one runtime are refused for one
   * reason and are all served by one login. When the pane exits, every one of them is offered its
   * own explicit `Retry` — Tachyon starts none of them (SDD 495 Q3, the owner's decision).
   */
  private readonly awaitingLogin = new Map<string, Set<string>>();
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
  /** t-50bbd4 — the formation lane's host port; undefined when the host key is unavailable. */
  private formationLifecycle: FormationLifecyclePort | undefined;
  /** SDD 490 — the adoption (write) host; undefined when the host key is unavailable. */
  private formationAdoption: FormationAdoptionHost | undefined;

  /**
   * t-50bbd4 — the canonical `agentId` for a declared agent, or undefined when it is not a profile
   * agent. Read from the profile on disk rather than cached: the lane validates the profile bytes
   * against the vector anyway, so reading is the cheap way to stay correct across a rename or an
   * external edit.
   */
  private canonicalAgentIdOf(agentName: string): string | undefined {
    const source = readCanonicalAgentProfile(this.workspaceRoot, agentName);
    if (!source) return undefined;
    try {
      const entry = readCanonicalAgentProfileEntry(source, "agent.yml");
      if (!entry) return undefined;
      const id = /^agentId:\s*["']?([A-Za-z0-9][\w.:-]{0,127})["']?\s*$/m.exec(entry.bytes.toString("utf8"))?.[1];
      return id;
    } catch {
      // A profile we cannot read is not a profile we will render from.
      return undefined;
    } finally {
      closeCanonicalAgentProfile(source);
    }
  }
  /** Host-custodied profile heads selected before any profile-backed config can load. */
  private agentProfileAuthorities = new Map<string, AgentProfileAuthorityRecord>();
  private readonly agentProfileHomeDir: string | undefined;
  private agentProfileAuthorityTail: Promise<void> = Promise.resolve();
  private readonly reloadTransactions: ReloadTransactionStore;
  private readonly hostActionAuditPath: string;
  private readonly hostActionSessionEpoch: number;
  /** spec 364 — host-driven Bridge-client rebind after generation bump (constructed after AgentManager). */
  private clientRebind: BridgeClientRebindCoordinator | undefined;
  private readonly bridgeClientRebindAuditPath: string;
  config: TachyonConfig | undefined;
  /** Profile-backed rows retained after a warm reload failure remain visible but cannot start anew. */
  private profileSpawnBlocked = new Set<string>();
  /**
   * t-8354ae — set whenever the working-tree config fails to load. Survives until the next
   * successful reloadConfig(). Drives the persistent sidebar error banner + degraded roster.
   * Undefined when the config is valid (or no config file exists yet).
   */
  configFailure: ConfigFailure | undefined;
  /**
   * t-7d6013 — what the LAST SUCCESSFUL load dropped out of tachyon.yml, and the signature of the set
   * the human has already read. Private because the two only make sense together: readers ask
   * `configDiscards`, which is the record minus a dismissal that still applies.
   *
   * This is a record and never a gate — it does not touch `configValid`, `profileSpawnBlocked`, or
   * any load/spawn decision. The whole point of the owner's rule is that an invalid line warns and
   * the file keeps loading; a surface that changed that would be answering a question nobody asked.
   */
  private configDiscardsRecord: ConfigDiscards | undefined;
  private dismissedConfigDiscardsSignature: string | undefined;

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
  /** t-8168a7 review — fresh spawns observed by this host; surviving reload sessions are absent. */
  private readonly freshTurnBaselines = new Set<string>();

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
    this.agentProfileHomeDir = resolveAgentProfileHomeDir(seams.agentProfileHomeDir);
    this.wsHash = workspaceHash(workspaceRoot);
    this.gitExec = createGitExec(() => resolveGitBinaryForHost(deps.host, sharedGlobalSettings().current().gitPath));
    this.taskNotifications = new TaskNotificationService(workspaceRoot, this.wsHash, deps.host, () => this.config);
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
        // Dead-map changes are lifecycle signals; handle them immediately instead of waiting for
        // the subprocess polling fallback.
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
    let earlyConfig: TachyonConfig | undefined;
    if (earlyFile) {
      try {
        const earlyText = fs.readFileSync(earlyFile, "utf8");
        const canonicalSyntax = parseProfileAwareConfigSyntax(earlyText);
        earlyConfig = canonicalSyntax.config;
      } catch {
        // Preserve the historical default-on auth behavior when the file cannot be read.
      }
    }
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

    this.ledger = new SessionLedger(workspaceRoot);
    this.externalTools = new ExternalToolRegistry(workspaceRoot);
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
      // t-e74631 — read through a thunk for the same reason `occupancy` above does: AgentManager is
      // constructed AFTER this service, and lineage is session-local memory that keeps growing as
      // agents spawn. A snapshot taken here would be empty forever, and "empty" reads as "no
      // ancestors" — the one answer that must never be guessed in an authorization decision.
      // t-ff0a7a — also honor config declaredOwner so a governed Saved Agent's owner can sweep that
      // builder's CHANGE residue (runtime parent alone misses top-level Saved Agents).
      lineage: composeHygieneLineageSource({
        runtimeParentOf: (name: string) => this.manager.parentOf(name),
        declaredOwnerOf: (name: string) => this.config?.declaredOwner?.[name],
      }),
      // t-05dff5 — the registry and the ledger both record who owns an agent's checkout, and a
      // removal through Control → Worktrees used to update only the registry. The ledger then owned
      // a directory that no longer existed, which no governed action could undo. Same removal, both
      // records: `clearWorktree` is a no-op for a row that never had one.
      onAgentWorktreeRemoved: (agent: string) => this.ledger.clearWorktree(agent),
      // t-621613 — the roster question behind the ORPHAN grant, wired as a thunk for the same reason
      // `lineage` above is: the answer changes as agents spawn and die, and a snapshot taken here
      // would be the empty boot inventory forever.
      ownerPresence: (agent: string) => this.agentPresence(agent),
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
      // t-35c998 — test-only; absent in production, where AgentManager builds the real registry.
      ...(seams.launchPreflight ? { launchPreflight: seams.launchPreflight } : {}),
      // t-8168a7 — list() carries Attention's real-turn latch. The manager is constructed before the
      // monitor, but this thunk is first read after construction, when the monitor exists.
      hasStartedTurn: (name) => this.monitor?.hasStartedTurn(name),
      // t-50bbd4 — resolved lazily: the port is built later, when the host key arrives from
      // SecretStorage, and AgentManager is constructed before that. A getter keeps the wiring honest
      // instead of capturing an undefined that would never fill in.
      formation: {
        suppressionRequired: (agentName) => this.formationLifecycle?.suppressionRequired(agentName) ?? false,
      },
      // SDD 369 T3 — ordinary Claude sessions inherit this account home. Capture and transcript
      // resolution must use the same value; an unknown external home then fails capture closed.
      defaultClaudeConfigHome,
      ledger: this.ledger,
      // t-e3aaae — a session:new restart states the agent's board assignment from the store instead
      // of leaving the fresh conversation to rediscover it. `taskStore` is constructed later in this
      // constructor; the resolver only ever runs at restart time, long after that.
      // t-9d250c — hand over the ROWS, not a decision. Which of them is the current contract (and
      // which are merely queued behind it) is `selectAssignedWork`'s call, so the "active and mine"
      // rule and its ordering live in one tested place instead of in this closure.
      assignedWork: (name) => this.taskStore.listRaw()
        .filter((task) => task.assignee === name)
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
          ...(task.priority === undefined ? {} : { priority: task.priority }),
          ...(task.rank === undefined ? {} : { rank: task.rank }),
          ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
          ...(task.body === undefined ? {} : { body: task.body }),
        })),
      // t-9d250c — any task's status, so a restart can say what became of the work its frozen brief
      // still names. Unknown ids answer undefined and the brief then claims nothing about them.
      taskStatusById: (id) => this.taskStore.find(id)?.status,
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
      materializeHarness: ({ name, def, cwd, delegated }) => {
        const adapter = adapterFor(def.cmd);
        if (def.profileCapabilities) {
          if (!adapter) throw new Error(`runtime for '${name}' has no capability projection adapter`);
          if (adapter.runtime === "claude") {
            return this.harness.materializeCanonicalClaudeProfileHome(name, adapter, {
              ...(def.profileNativeConfig ? { nativeConfig: def.profileNativeConfig } : {}),
              capabilities: def.profileCapabilities,
            }, cwd, this.bridgeEntry());
          }
          if (adapter.runtime === "codex") {
            return this.harness.materializeCanonicalCodexProfileHome(name, adapter, {
              ...(def.profileNativeConfig ? { nativeConfig: def.profileNativeConfig } : {}),
              capabilities: def.profileCapabilities,
            }, cwd, this.bridgeEntry());
          }
          return this.harness.materializeProfileCapabilities(
            name,
            def.profileCapabilities,
            adapter,
            cwd,
            this.bridgeEntry(),
            def.profileNativeConfig,
          );
        }
        // SDD 401/406 — Pi is private-home by default; an opt-in resource harness uses its
        // dedicated exact-resource materializer rather than pretending Pi has generic MCP wiring.
        if (adapter?.runtime === "pi" && def.isolate === undefined) {
          const exactTrust = def.profileLifecycle
            ? { exactTrustCwd: cwd ?? this.workspaceRoot }
            : undefined;
          return def.harness
            ? this.harness.materializePiHome(name, def.harness, exactTrust)
            : this.harness.materializePiHomeOnly(name, exactTrust);
        }
        if (!harnessable(adapter) || !adapter) return null;
        // spec 236 — a harness agent runs with --strict-mcp-config (ignores project/global MCP), so the
        // Bridge MUST be folded into the materialized file or it can't reach complete_node/write_input.
        // t-836be3 — the grok branch of `materialize` writes `$GROK_HOME/hooks/`, so it is the door that
        // carries the projected gate for a harness-declared Grok agent. claude/codex harness agents get
        // theirs from their own per-spawn channel (`--settings` / `-c hooks.…`), never from here.
        if (def.harness) {
          return this.harness.materialize(
            name,
            def.harness,
            adapter,
            cwd,
            this.bridgeEntry(),
            adapter.runtime === "grok" ? this.projectedSessionHooks("grok", name) : undefined,
          );
        }
        if (adapter.runtime === "claude" && (def.profileLifecycle || def.profileFork || def.profileNativeConfig)) {
          return this.harness.materializeCanonicalClaudeHome(name, adapter, cwd, def.profileNativeConfig, this.bridgeEntry());
        }
        // spec 240 — `isolate: transcript`: private home ONLY (own transcript namespace), no MCP isolation,
        // so the agent still loads the workspace project config (incl. the project .mcp.json).
        // t-171cb2 — Temporary `cmd: codex` is auto-injected into this arm; directory trust still
        // applies by class when the launch is delegated (exact-path worktree cwd known here).
        if (def.isolate === "transcript") {
          return this.harness.materializeHomeOnly(name, adapter, cwd, {
            ...(adapter.runtime === "codex" && delegated
              ? { exactTrustCwd: cwd ?? this.workspaceRoot }
              : {}),
          });
        }
        // spec 357 - codex defaults to a lifetime-scoped private CODEX_HOME so same-cwd agents cannot
        // bind to each other's rollout transcripts.
        if (adapter.runtime === "codex") {
          if (def.profileNativeConfig) {
            return this.harness.materializeCanonicalCodexHome(name, adapter, def.profileNativeConfig, cwd);
          }
          // Canonical profiles own their forming inputs. Their private CODEX_HOME must not inherit
          // selectors/capabilities from the account-wide config that the profile inspector suppresses.
          // t-171cb2 — directory trust is authority: only a delegated child gets exact-path trust for
          // its spawn cwd (the new worktree path). Top-level and declared keep today's seed-only home.
          return this.harness.materializeHomeOnly(name, adapter, cwd, {
            inheritNativeConfig: def.profileLifecycle === undefined,
            ...(delegated ? { exactTrustCwd: cwd ?? this.workspaceRoot } : {}),
          });
        }
        // t-ee5c05 — `profileFork` joins the gate for the same reason it does on the Claude branch: a
        // fork is a Temporary sibling that deliberately does NOT inherit `profileLifecycle` authority,
        // so keying only on that would hand the fork an unprojected home.
        if (adapter.runtime === "grok" && (def.profileLifecycle || def.profileFork || def.profileNativeConfig)) {
          const home = this.harness.materializeBridgeMcpGrok(
            name,
            this.bridgeEntry() ?? {},
            cwd ?? this.workspaceRoot,
            // t-26f508 — the same options the Bridge port below passes. `withRuntimeBridge` calls
            // that port AFTER this materializer on every spawn, rewriting config.toml from scratch;
            // if the two disagreed, the second write would silently erase the projection this one
            // just made. Keeping them identical is what makes the second write a no-op. t-836be3
            // joins `projectedHooks` to that rule for the same reason.
            {
              exactTrust: true,
              ...(def.profileNativeConfig ? { nativeConfig: def.profileNativeConfig } : {}),
              // Canonical profiles are declared/saved; profileFork is a Temporary sibling and stays
              // ownership-only even though it reuses this native-config materialization door.
              ...(def.profileLifecycle ? { lifecycle: { handoffPath: this.handoffStore.canonicalPath } } : {}),
              ...this.projectedSessionHooks("grok", name),
            },
          );
          // Grok 0.2.112 consults `$HOME/.claude/settings.json` for permission settings even when
          // GROK_HOME is redirected. A canonical profile owns the complete forming namespace, so bind
          // HOME to the same private directory; auth continues to come only from GROK_HOME/auth.json.
          //
          // t-076a28 — co-binding HOME also hides the operator's `~/.gitconfig` from everything the
          // agent shells out to, which left canonical Grok agents unable to commit at all ("Author
          // identity unknown"). Seed an INCLUDE of their real global config: identity is read live
          // from the file they own, the permission isolation above is unaffected (measured: still
          // `loaded: 0`), and nothing else from the real HOME is re-exposed — `~/.ssh` deliberately
          // stays out of reach, declared as a limitation rather than seeded as a credential.
          seedPrivateHomeGitIdentity(home);
          return { home, env: { GROK_HOME: home, HOME: home }, args: [] };
        }
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
        if (!entry) return undefined;
        const declared = asAgent(this.config?.agents[name]);
        return this.harness.materializeBridgeMcpGrok(
          name,
          entry,
          cwd ?? this.workspaceRoot,
          {
            exactTrust: declared?.profileLifecycle !== undefined,
            // t-26f508 — must match the canonical branch above: this port runs last on every spawn.
            ...(declared?.profileNativeConfig ? { nativeConfig: declared.profileNativeConfig } : {}),
            ...(declared ? { lifecycle: { handoffPath: this.handoffStore.canonicalPath } } : {}),
            // t-836be3 — the gate for every non-harness Grok agent, Temporary ones included: the plan is a
            // pure function of (lockfile, classification, runtime) and never of the agent's declaration,
            // so an undeclared child is projected exactly like a Saved agent.
            ...this.projectedSessionHooks("grok", name),
          },
        );
      },
      // t-84f0eb — authority is the workspace config, keyed by the exact managed agent name. No
      // environment, parent command or runtime-home setting participates, and absence stays off.
      resolveAgentPermissionProjection: (name, runtime) => {
        const authored = this.config?.settings.agentPermissionProjection?.[name];
        if (!authored) return undefined;
        if (authored.runtime !== runtime) {
          throw new Error(
            `agent '${name}': settings.agentPermissionProjection targets '${authored.runtime}', not '${runtime}'`,
          );
        }
        return authored;
      },
      // Private HERMES_HOME for non-harness hermes (Bridge MCP in config.yaml + isolated auth copy).
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
          /**
           * t-084b28 — this used to be `!!opts?.ownershipOnly`, which is exactly backwards.
           *
           * `ownershipOnly` is `!lifecycleHooks`, and `lifecycleHooks` is `!temporary`. So a Temporary
           * agent got the flag and a SAVED agent did not — while the Saved agent is the one whose
           * profile carries an explicit `authorize: [bypassPermissions]` (SDD 471). Measured on
           * 0.56.126/0.56.127: the bypass disclaimer reappeared on every resume of this workspace's
           * Saved coordinator, leaving it parked at a prompt until a human pressed a key.
           *
           * The projected `permissions.defaultMode` in the private home does NOT answer this: the CLI
           * resolves this gate from `skipDangerousModePermissionPrompt` (or a previously accepted
           * `bypassPermissionsModeAccepted`), which is a different key on a different read path.
           *
           * Written unconditionally, and that is safe rather than lazy: the CLI consults it ONLY when
           * the effective mode is already dangerous, and Tachyon only reaches that mode through the
           * profile's explicit authorization. Suppressing a disclaimer about a posture the human
           * authored is not a policy decision — it is not asking the same question twice, of a
           * non-interactive process that cannot meaningfully answer it.
           */
          skipDangerousModePermissionPrompt: true,
          statusLine: opts?.statusLineCapture === false
            ? undefined
            : this.deps.claudeStatusLineCapture?.materialize({
              workspaceRoot: this.workspaceRoot,
              agent: name,
              cwd: opts?.cwd ?? this.workspaceRoot,
              configHome: opts?.configHome,
            }),
          ...this.projectedSessionHooks("claude", name),
        },
      ), // spec 245/312
      materializeCodexSessionStartHookConfig: (name, opts) => this.harness.materializeCodexSessionStartHookConfig(
        name,
        opts?.ownershipOnly ? undefined : this.handoffStore.canonicalPath,
        {
          silentPersistence: !opts?.ownershipOnly && this.silentPersistenceHooksDesired(name),
          ...this.projectedSessionHooks("codex", name),
        },
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
      // t-2656d7 — the launch-boundary auth refusal gets a surface it can be ACTED on, instead of the
      // action-less `notify` above, whose VS Code rendering is an 8-second status-bar flash.
      onAuthRequired: (name, evidence) => this.presentAuthRequiredLaunch(name, evidence),

      getConfig: () => this.config,
      getRefusedAgents: () => this.refusedAgents(),
      // t-8354ae — refuse spawn of names that exist only in the LKG snapshot while config is invalid.
      assertSpawnAllowed: (name) => this.assertNotLkgOnlySpawn(name),
      // t-aaad95 — `maxAgents` and `agentMemoryMax` used to arrive here from VS Code settings ALONGSIDE
      // `tachyon.yml`, and AgentManager preferred the yml. That duplication is gone: `getConfig()` is
      // now the single authority for both, so neither needs a port of its own.
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
        // F3: a Bridge-spawned child passes "silent" so it doesn't yank the human's editor focus off
        // the parent. It still appears in the tree (nested) — the human opens it on demand.
        // t-b88106: "preserve" (restart / resume / crash- and watch-restart) is resolved against the
        // surface the agent ACTUALLY had, so a headless agent stays headless.
        if (this.surfaces.shouldOpen(name, reveal, () => this.terminals.has(name))) {
          this.terminals.open(name, this.manager.session(name));
        }
        // spec 216 (codex r1 M2): a fresh session (spawn/restart/resume) clears any stale
        // recovery flag — else a compaction detected before a kill could inject into a brand-new
        // same-name session that never compacted.
        this.pendingContextRenewal.delete(name);
        this.recordSpawnIncarnation(name);
        if (reveal === "preserve") {
          this.freshTurnBaselines.delete(name);
        } else {
          this.freshTurnBaselines.add(name);
          // A tick may race launch observation and seed unknown before onSpawned. Rebuild only an
          // unproven snapshot; positive pane evidence from a turn already in flight must survive.
          if (this.monitor?.hasStartedTurn(name) !== true) this.monitor?.reset(name);
        }
        this.clientRebind?.onNewIncarnation(name);
        this.noticeQueue.clear(name);
        this.observeAgentLiveForReloadSummary(name);
        const reloadSummary = this.pendingReloadSummaries.get(name) ?? this.queuedReloadSummaries.get(name);
        if (reloadSummary) {
          this.pendingReloadSummaries.delete(name);
          this.queuedReloadSummaries.set(name, reloadSummary);
          this.enqueueNotice(name, reloadSummary.line);
        }
        this.temporaryBackstop.reset(name);
        this.completionHints.clear(name);
        const pending = this.runtimeConfigPending.get(name);
        if (pending) {
          this.runtimeConfigPending.delete(name);
          this.host.notify(this.t("'{0}' started with refreshed {1} runtime configuration", name, pending.scope), "info");
        }
        this.refreshAgentsViews();
      },
      onStopping: (name) => {
        // Grok replaces auth.json symlink with a regular file on token refresh — harvest before teardown.
        this.reconcileGrokAuthIfGrokAgent(name);
        this.refreshAgentsViews();
      },
      onKilled: async (name) => {
        this.reconcileGrokAuthIfGrokAgent(name);
        this.terminals.close(name);
        this.surfaces.forget(name); // t-b88106 — a kill ends the agent; nothing to restore
        this.pendingContextRenewal.delete(name); // t-6f0377: death cancels a renewal intent
        this.agentIncarnations.delete(name);
        this.noticeQueue.clear(name);
        this.temporaryBackstop.reset(name);
        this.completionHints.clear(name);
        this.monitor?.reset(name);
        this.freshTurnBaselines.delete(name);
        this.expectedDeath.add(name); // spec 332 (dueto F3): kill_agent/dismiss_agent/killAll — a deliberate
        // termination, never a completion signal; consumed by the next observed death edge.
        await this.returnTaskClaimsForUnavailableAgent(name, `agent '${name}' was stopped`);
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
      // attached — AgentManager skips onRestart then; onSpawned still restores the live tab.
      onRestart: (name) => {
        // t-b88106 — this close is the ONE place a restart destroys the evidence of what the agent
        // looked like, so record it before closing. Without this, the kill+new fallback would make
        // every restarted agent look headless and a visible pane would never come back.
        this.surfaces.noteBeforeRelaunchClose(name, this.terminals.has(name));
        this.terminals.close(name);
        this.temporaryBackstop.reset(name);
        this.completionHints.clear(name);
        this.monitor?.reset(name);
        this.freshTurnBaselines.delete(name);
      },
      // spec 210 — separate worktree checkout: resolve the cwd a session is born in.
      // spec 230 — a pipeline node spawns into its RUN's worktree (registered just before spawnNode);
      // this overrides the per-agent worktree path so the chain shares one checkout.
      resolveSpawnCwd: async (ctx) => {
        const pl = this.pipelineNodeCwd.get(ctx.name);
        if (pl) return { cwd: pl.cwd, worktree: pl.worktree };
        // A worktree, its branch and its setup are Agent capabilities — a terminal declares none.
        const ctxAgent = asAgent(ctx.def);
        const resolved = await resolveWorktreeCwd(
          {
            name: ctx.name,
            worktree: ctxAgent?.worktree,
            branch: ctxAgent?.branch,
            worktreeSetup: ctxAgent?.worktreeSetup,
            parent: ctx.parent,
            // spec 484 — a Temporary's NAME is reusable across spawns, so it cannot stand for its
            // branch identity the way a declared agent's does. The AgentManager has computed this
            // fact since spec 210; it just never reached the resolver that has to act on it.
            temporary: ctx.temporary,
            isRestart: ctx.isRestart,
            declaredCwd: ctx.declaredCwd,
          },
          {
            manager: this.worktrees,
            settings: this.config?.settings ?? {},
            // t-c9da28 — every authority that might still know where the parent runs, in descending
            // order. The ladder itself lives in `resolveParentLocation` so it is testable; this only
            // says which objects answer each rung.
            resolveParent: (p) => resolveParentLocation({
              ledgerRow: () => {
                const r = this.ledger.get(p);
                return r ? { ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.worktree?.path ? { worktreePath: r.worktree.path } : {}) } : undefined;
              },
              managedWorktreePath: () => this.managedWorktrees.list({ kind: "agent" }).find((e) => e.agent === p)?.path,
              isDeclaredAgent: () => !!this.config?.agents?.[p],
              isLiveAgent: async () => (await this.manager.agentStates()).has(p),
            }),
            priorRecord: this.ledger.get(ctx.name)?.worktree,
            runSetup: (rec, setup) => this.runWorktreeSetup(rec, setup),
            // t-5ac1df — the project owns the list. The materializer validates existence and
            // gitignore admission per path and reports bad entries without blocking launch.
            shareDependencies: (worktreePath) => shareDependencies({
              workspaceRoot: this.workspaceRoot,
              worktreePath,
              sharedDirectories: this.config?.settings.worktree?.shareDependencies === false
                ? []
                : (this.config?.settings.worktree?.sharedDirectories ?? []),
              warn: (message) => this.host.notify(message, "warn"),
            }),
            notify: (m, level) => this.host.notify(m, level ?? "info"),
          },
        );
        if (!resolved?.worktree) return resolved;
        this.managedWorktrees.syncAgentRecord(ctx.name, resolved.worktree, ctx.delegator);
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
            // t-d29398 — the checkout was DISCARDED, so this must not fall through to the reused-
            // checkout sentence below: that one describes recovery state at a path that no longer
            // exists, which is a worse lie than the residue this change removes.
            this.forgetDiscardedWorktree(resolved.worktree.path);
            throw new AggregateError(
              [primary, new Error(`the fresh worktree at ${resolved.worktree.path} was discarded; nothing was preserved`)],
              `agent '${ctx.name}' worktree preparation failed; its fresh checkout was discarded`,
            );
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
      },
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
        // t-d29398 — `created` IS the distinction, and it is measured rather than guessed: it is true
        // only when this very attempt ran `git worktree add`. Such a checkout is discarded (see
        // `rollbackCreated`, which still preserves whenever git refuses); one that already existed
        // takes the path below and is never touched.
        // A preserved checkout keeps its registry row, so reveal still points at it; a discarded one
        // must lose that row, or the residue simply changes shape into a claim on a missing directory.
        if (created) {
          if (!afterHead) throw new Error(`fresh worktree cleanup was withheld without a prepared HEAD observation: ${rec.path}`);
          await this.worktrees.rollbackCreated(rec, initialHead, afterHead);
          this.forgetDiscardedWorktree(rec.path);
          return;
        }
        if (!beforeHead || !afterHead) {
          throw new Error(`reused worktree cleanup was withheld without preparation HEAD observations: ${rec.path}`);
        }
        await this.worktrees.rollbackPreparation(rec, beforeHead, afterHead);
      },
      completePreparedWorktree: (rec) => this.worktrees.completePreparation(rec),
      removeHarnessHome: (name) => this.harness.retireCredentials(name),
      removeBridgeRuntimeHome: (name) => this.retireBridgeRuntimeHome(name),
      removePiSessionDir: (name) => removePiSessionDir(this.workspaceRoot, name),
    });

    // spec 230 — the pipeline executor. Constructed before the Bridge so its `completeNode` dep can
    // reference it. Deps bind to the real WorktreeManager / AgentManager.
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
          // Temporary instances (not saved): default attention ON for kind=agent, but OFF for
          // kind=terminal — a Bridge-spawned `sh`/shell shouldn't be monitored like an AI
          // agent (F5: Temporary attention now respects the inferred kind, matching declared
          // terminals which already default attention off).
          if (!att) return { enabled: this.manager.kindOf(agent) !== "terminal", silenceSec: 8, patterns: [] };
          return { enabled: att.enabled, silenceSec: att.silenceSec, patterns: safePatterns(att.patterns, this.t, (m, l) => this.host.notify(m, l)) };
        },
        // A correlated Activity event proves a turn. A fresh spawn observed by this host proves the
        // initial false. A surviving session with neither stays unknown and gets the generic poke.
        initialTurnState: (agent) =>
          this.hasDurableTurnEvidence(agent) ? true : this.freshTurnBaselines.has(agent) ? false : undefined,
        // Compaction detection is an AI-agent concept only. Return null for terminals so a terminal
        // running a claude/codex-shaped command cannot enqueue continuity recovery.
        cmdOf: (agent) => (this.manager.kindOf(agent) === "agent" ? (this.manager.defOf(agent)?.cmd ?? null) : null),
        // t-10771a v1 — derived prose-question handback is only for declared top-level agents:
        // declared in tachyon.yml, AI-kind, and not a declared subagent. Temporary children and
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
      (agent, attention, shouldToast, attentionCause) => {
        // t-9552f3 / t-0db8cb — clear the completion latch only when a NEW turn starts
        // (this callback only fires on state change; state === "working" here is the non-working → working
        // edge). Do NOT clear on every contentSince advance: after notify_agent the same turn still paints
        // final chrome (Working timer → idle prompt, status line), which bumps contentSince and would
        // drop the latch while raw classification can still lag (CPU / residual chrome). That left
        // list_agents stuck on "working" for a finished agent (portakill, codex dogfood).
        if (attention.state === "working") {
          this.completionHints.clearIfNewOutput(agent, attention.contentSince);
        }
        this.waiters.notifyAttention(agent, this.attentionOf(agent)?.state ?? attention.state);
        this.refreshAgentsViews();
        // Continuity recovery runs only after the agent becomes idle so it never writes over a turn.
        if (attention.state === "idle" && this.manager.kindOf(agent) === "agent") {
          void this.recoverOnIdle(agent).catch(() => {});
        }
        // t-8605be — a child stuck on an interactive prompt is otherwise unreachable by agents (write_input
        // refuses working/throttled, notify_agent refuses needs-input per 341) until a human notices the
        // badge. Poke the live PARENT proactively, same machine as pokeParentOnDeath (332): fires once per
        // needs-input episode (shouldToast is the monitor's own one-shot), independent of the human-toast
        // suppression below (the parent is a different pane, not the one the human may be looking at).
        if (shouldToast && attention.state === "needs-input") {
          this.pokeParentOnNeedsInput(agent, attention.matchedLine);
        }
        // SDD 477 / t-5bfb72 — the HOLD. Rate-limit auto-continue is Tachyon's one automatic retry
        // loop against a live pane, and poking a logged-out runtime just re-reads the same login
        // notice forever. An auth-required agent is waiting on a human, not on a clock.
        if (attention.authRequired) this.cancelRateLimitAutoContinue(agent);
        else if (attention.state === "throttled") this.scheduleRateLimitAutoContinue(agent, attention);
        else this.cancelRateLimitAutoContinue(agent);
        if (shouldToast && attention.state === "throttled") {
          this.pokeParentOnThrottle(agent, attention);
        }
        // t-dd130a — a composer draft is actionable only once the agent is idle: while the agent is
        // still working, pre-typing the next message is harmless. Lead with the consequence the
        // human cannot see, then name the two actions Tachyon deliberately will not take for them.
        if (attentionCause === "composer-draft") {
          this.host.notify(
            this.t("'{0}' is idle — your draft was not sent. Send it to start work, or discard it.", agent),
            "warn",
            [{ label: this.t("Open"), run: () => void this.terminals.open(agent, this.manager.session(agent)) }],
          );
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
        // SDD 477 / t-5bfb72 — a lost login is human-actionable and nothing else can clear it, so it
        // is told to BOTH audiences: the human who has to run the login, and the parent that would
        // otherwise keep handing this agent work. `shouldToast` is the monitor's own per-episode
        // one-shot, so neither is repeated while the hold sits. Unlike the needs-input toast this one
        // is NOT suppressed when the terminal is focused: the pane shows a login notice that looks
        // like ordinary output, which is exactly the misreading this spec exists to fix.
        if (shouldToast && attention.authRequired) {
          this.host.notify(describeAuthRequired(agent, attention.authRequired), "warn", [
            { label: this.t("Open"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
          this.pokeParentOnAuthRequired(agent, attention.authRequired);
        }
      },
      // Compaction is in-file, so the activity transition
      // counter won't see it) so the agent's continuity is re-injected on the next idle.
      (agent) => {
        if (this.manager.kindOf(agent) === "agent") this.continuityState.markDiscontinuity(agent, this.currentActivitySeq(agent));
      },
    );

    this.temporaryBackstop = new TemporaryBackstopMonitor(
      {
        listAgents: () => this.manager.listAgents(),
        attentionOf: (agent) => this.attentionOf(agent),
        now: () => Date.now(),
        deliverNotice: (parent, line, metadata) => this.deliverNotice(parent, line, metadata),
        sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent, "host-poke"),
        completionHinted: (agent) => this.completionHints.has(agent),
      },
      // t-585d5c — resolved per tick from the LIVE config, never captured here. `this.config` is
      // replaced on reload, so an edit reaches the next tick without recreating the workspace or its
      // agents, and without a second timer that would have to be kept in step with this one.
      () => idleNotifyThresholdMs(this.config?.settings.agentNotifications?.idleAfterMinutes),
    );

    // t-458497 — the doorbell half of runtime condition. It reads the SAME projection the
    // `runtime_condition` Bridge tool answers from, so what an agent is told and what it can ask
    // cannot drift into two accounts of one runtime.
    this.runtimeSlack = new RuntimeSlackMonitor({
      condition: () => this.runtimeCondition(),
      listAgents: () => this.manager.listAgents(),
      deliverNotice: (agent, line, metadata) => this.deliverNotice(agent, line, metadata),
    });

    this.gatedCompletion = new GatedCompletionMonitor({
      listGatedFacts: () => this.listGatedCompletionFacts(),
      listAgents: () => this.manager.listAgents(),
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
      isVerifiedSince: (worktreePath, headSha, sinceIso) =>
        isVerifiedSince(worktreePath, headSha, sinceIso, defaultGitExec),
      deliverNotice: (delegator, line, metadata) => this.deliverNotice(delegator, line, metadata),
      sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent, "host-poke"),
      now: () => Date.now(),
      loadCandidates: () => this.loadGatedCompletionCandidates(),
      saveCandidates: (c) => this.saveGatedCompletionCandidates(c),
    });

    this.lifecycle = new LifecycleMonitor(
      {
        agentStates: () => this.manager.agentStates(),
        // SDD 477 / t-5bfb72 — the HOLD, second half. A held agent's configured restart policy is
        // overridden to "never" for as long as the latch stands: restarting into a runtime that
        // still has no credential produces an identical failure, and the backoff would then give up
        // and mark the agent crashed — losing the one fact a human needs. The latch clears itself on
        // the first real turn (see AttentionMonitor.transition), so an explicit restart AFTER a login
        // restores the configured policy without anyone having to remember to re-enable it.
        policyOf: (agent) =>
          this.monitor.isAuthRequired(agent) ? "never" : (this.config?.agents[agent]?.restart ?? "never"),
        scheduleRestart: (agent, delayMs) => {
          setTimeout(() => void this.recoverFromCrash(agent), delayMs);
        },
        // t-9d76b1 — the manager owns the record of what Tachyon asked for; the monitor only asks.
        wasStopRequested: (agent) => this.manager.wasStopRequested(agent),
        now: () => Date.now(),
      },
      {
        onCrash: (agent, exitCode, willRestart, delayMs) => {
          this.waiters.notifyDead(agent, exitCode);
          this.noticeQueue.clear(agent);
          void this.returnTaskClaimsForUnavailableAgent(
            agent,
            `agent '${agent}' exited (${exitCode !== undefined ? exitCode : "unknown code"})`,
          );
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
              // t-f6aa7c — the SAME trigger (a crash) reached by a different ACTOR (the human, after
              // the policy declined to auto-restart). It goes through the same recovery, or the two
              // doors out of one crash would disagree about whether the agent keeps its memory.
              { label: this.t("Restart"), run: () => void this.recoverFromCrash(agent) },
            ]);
          }
        },
        onCleanExit: (agent) => {
          this.waiters.notifyDead(agent, 0);
          this.noticeQueue.clear(agent);
          void this.returnTaskClaimsForUnavailableAgent(agent, `agent '${agent}' exited (0)`);
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
        /**
         * t-9d76b1 — the exit the human (or a rebind) ORDERED. Same release work as the two arms above,
         * because the agent is just as gone; what changes is that nothing here calls it a failure and
         * nothing restarts it. It used to land on `onCrash` for grok and hermes (exit 130) and on
         * `onCleanExit` for codex, opencode and pi (exit 0) — one action, announced two different ways.
         *
         * The postmortem pane is collected only for a clean 0, exactly as before: a non-zero exit keeps
         * its dead pane so the `^C` and the code stay inspectable. `dismissCleanExitPane` refuses a
         * non-zero row anyway, so asking it here would just discard the reason.
         */
        onRequestedStop: (agent, exitCode) => {
          this.waiters.notifyDead(agent, exitCode);
          this.noticeQueue.clear(agent);
          void this.returnTaskClaimsForUnavailableAgent(agent, `agent '${agent}' was stopped on request`);
          this.pokeParentOnDeath(agent, `stopped on request, exit ${exitCode !== undefined ? exitCode : "unknown"}`);
          // spec 230 — a pipeline node whose agent was stopped did not finish its work: feed the real
          // exit to the executor, which is what fails the node. A requested stop is not a completion.
          const stoppedNode = this.pipelineNodeOf.get(agent);
          if (stoppedNode) {
            this.pipelines.onProcessExit(stoppedNode.runId, stoppedNode.nodeId, exitCode ?? 1);
            return;
          }
          if (exitCode === 0) {
            void this.manager.dismissCleanExitPane(agent)
              .catch((err) => {
                this.host.notify(this.t("'{0}' stopped, but Tachyon could not clear its terminal: {1}", agent, String(err instanceof Error ? err.message : err)), "warn");
              })
              .finally(() => this.refreshAgentsViews());
          } else {
            this.refreshAgentsViews();
          }
          this.host.notify(
            exitCode === 0 || exitCode === undefined
              ? this.t("'{0}' stopped", agent)
              : this.t("'{0}' stopped (exit {1})", agent, exitCode),
          );
        },
        onGone: (agent) => {
          this.waiters.notifyGone(agent);
          this.noticeQueue.clear(agent);
          if (!this.expectedDeath.has(agent)) {
            void this.returnTaskClaimsForUnavailableAgent(agent, `agent '${agent}' disappeared`);
          }
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
    this.taskStore = new TaskStore(workspaceRoot, {
      onMutation: async (event) => {
        // t-57a00a — the assignee's wake-up lives HERE, at the store's sink, because that is the only
        // point every writer crosses. It used to hang off the Bridge's update_task handler, so an
        // agent assigning notified and a human assigning in the UI did not.
        await wakeTaskAssignee(event, this.taskAssigneeWakePorts());
      },
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
    // t-2656d7 — its own tmux namespace, for the same reason CommandRunner has one: a pane whose job
    // is to EXIT must not be read by the agent lifecycle as an agent that died.
    this.loginRunner = new LoginRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      realHomeEnv: (runtime) => realRuntimeAuthHomeEnv(runtime),
      onFinished: (runtime) => this.onLoginPaneFinished(runtime),
    });
    this.runbookRunner = new RunbookRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onFinished: (job) => {
        deps.onViewsChanged("commands");
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
    // refused in this build (separate worktrees for them are a follow-up — D8 auth does real work here).
    this.probeStore = new ProbeStore(path.join(workspaceRoot, ".tachyon", "probes"));
    this.probeService = new ProbeService({
      adapters: new Map([
        ["claude", claudeAdapter],
        ["codex", codexAdapter],
        ["grok", grokAdapter],
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
        // lanAccess = mobile Companion via Tailscale (not multi-NIC Wi‑Fi).
        const mobile = this.config?.settings.companion?.lanAccess === true;
        return companionPairBaseUrl(port, mobile);
      },
      getBaseUrlCandidates: () => {
        const port = this.bridge.listenerPort;
        if (port === undefined) return undefined;
        const mobile = this.config?.settings.companion?.lanAccess === true;
        return companionPairBaseUrlCandidates(port, mobile);
      },
      getPairBlockReason: () => {
        if (this.bridge.listenerPort === undefined) return "bridge_down";
        if (this.config?.settings.companion?.lanAccess === true && !resolveTailscaleIPv4()) {
          return "tailscale_required";
        }
        return undefined;
      },
    });
    this.companionLive = new CompanionLiveSync({
      statusOf: (token) => this.companion.status(token),
      listAgents: () => this.companionListActiveAgents(),
    });
    this.companionTab = new CompanionTabChannel({
      push: (event, data) => {
        // tab.command must not leak to mobile SSE (probe t-44dfb6).
        if (event === "tab.command") {
          this.companionLive.pushEvent(event, data, this.companion.tokensForKind("browser"));
          return;
        }
        this.companionLive.pushEvent(event, data);
      },
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
        hasStartedTurn: (agent) => this.monitor.hasStartedTurn(agent),
        publishRuntimeStatus: (agent, event) => this.monitor.publishRuntimeStatus(agent, event),
        composerOccupiedOf: (agent) => this.attentionOf(agent)?.composerOccupied,
        // t-a53dd9 — the at-injection reading write_input prefers over the cached one above.
        composerDraftNow: (agent) => this.monitor.probeComposerOccupied(agent),
        // SDD 414 / t-2a7010 + t-fbe280 — agent tab tools via Companion extension.
        // Listed when settings.companion.tabTools is true; execution still requires a paired device.
        companionTabToolsEnabled: () => this.config?.settings.companion?.tabTools === true,
        // Prototype: Integrated Browser (shell HTTP+CDP). Always wire request so tools stay listed;
        // offline/instance-missing and settings.ideBrowser.enabled=false fail at call time (t-3cab05 / F4).
        // Never gate registration on enabled or live instance — MCP freezes the catalog at connect.
        ideBrowserToolsEnabled: () => isIdeBrowserBridgeAvailable(this.workspaceRoot),
        ideBrowserRequest: (route, body) => {
          if (!isIdeBrowserEnabled(this.config?.settings)) {
            return Promise.resolve({
              ok: false as const,
              code: IDE_BROWSER_DISABLED_CODE,
              error: IDE_BROWSER_DISABLED_ERROR,
            });
          }
          return ideBrowserRequest(this.workspaceRoot, route, body);
        },
        // Tab tools require a browser companion session (not mobile-only pair).
        companionBrowserPaired: () => this.companion.hasPairedKind("browser"),
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
        // t-fb1453 — notify_agent is the sender speaking for itself, so its notice outlives the sender.
        authoredNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent, "agent-authored"),
        markCompletionHint: (agent) => {
          this.completionHints.mark(agent);
          this.monitor.flagUnseen(agent);
        },
        onPinsChanged: () => deps.onViewsChanged("pins"),
        onSavedAgentProposed: (proposal) => deps.onSavedAgentProposed?.(this, proposal),
        onSavedAgentRemovalProposed: (proposal) => deps.onSavedAgentRemovalProposed?.(this, proposal),
        inspectSavedAgentProfile: async (name) => {
          if (!this.isSavedAgentMember(name)) return undefined;
          try {
            const snapshot = await this.inspectAgentProfileLifecycle(name);
            return { agentId: snapshot.agentId, revision: snapshot.revision };
          } catch {
            return undefined;
          }
        },
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
        onHumanValidationPending: (validation) => {
          deps.onHumanValidationPending?.(this, validation);
          // Companion side panel: the same push approvals already get, so a paired device can
          // refresh without polling. A distinct event name — one is a capability, one is evidence.
          try {
            this.companionLive.pushEvent("validations.changed", { id: validation.id, author: validation.author });
          } catch {
            /* best-effort */
          }
        },
        waiters: this.waiters,
        commands: this.commandRunner,
        runbooks: this.runbookRunner,
        scheduler: this.scheduler,
        proposals: this.proposals,
        onScheduleProposed: (proposal) => {
          deps.onViewsChanged("schedules");
          deps.onScheduleProposed?.(this, { id: proposal.id, name: proposal.name, proposer: proposal.by });
        },
        // spec 273 — the worktree evidence channel over MCP.
        attachEvidence: (input) => this.attachEvidence(input),
        listEvidence: (agent) => this.listEvidence(agent),
        requestContextCompaction: async (agent) => this.requestContextCompaction(agent),
        requestFreshContext: async (agent) => this.requestFreshContext(agent),
        // t-0bebf6 — the fifth exit on the idle poke. It answers the SAME monitor that authored the
        // line, so the acknowledgement and the notice cannot drift into two views of one child.
        acknowledgeIdlePoke: (agent) => this.temporaryBackstop.acknowledge(agent),
        // t-458497 — the read door onto runtime condition. Same projection the slack doorbell speaks
        // from, so the answer to "can I delegate to claude?" is one fact with two ways in.
        runtimeCondition: () => this.runtimeCondition(),
        continueTask: (input) => this.continueTaskAcrossRuntime(input),
        // spec 230 — a pipeline node signals completion (per-node nonce auth).
        completeNode: (input) => this.pipelines.completeSignal(input),
        // spec 359 — host actions are authorized with the per-request Bridge caller snapshot.
        runHostAction: (input) => this.runHostAction(input),
        managedWorktrees: this.managedWorktrees,
        runtimeCredentialHygiene: (input) => this.reconcileRuntimeCredentials(input),
        // SDD 494 Part 4 — the read door onto "which owners disagree about this agent, and which door
        // removes it". Read-only by construction: it measures the four presence facts and derives.
        savedAgentRosterReconciliation: () => this.reconcileSavedAgentRoster(),
        // t-d06da3 — the ports of the shared agent-removal cascade, so `dismiss_agent` takes an owned
        // checkout down through the SAME code `config.agent.delete` uses. The Workspace IS the port
        // bundle (manager + ledger + worktrees + registry), which is exactly how the operation service
        // already calls `removeAgentWorktree(workspace, …)`.
        agentWorktrees: this,
        // t-75e9c7 — the diff-vs-baseRef read `agent_touched_files` needs (spec 213's `changedFiles`,
        // already used by evidence/inspect). Separate from `agentWorktrees` because it is a plain
        // read, not part of the removal cascade.
        touchedFiles: (cwd, baseRef) => this.worktrees.changedFiles(cwd, baseRef),
        // t-004255 — a creation base becomes branch drift in a long-lived Saved Agent. Resolve the
        // moving base branch against this worktree's HEAD, then keep changedFiles' working-tree diff
        // so uncommitted edits remain visible.
        touchedFilesMergeBase: async (cwd, leftRef, rightRef) => {
          const result = await this.gitExec(["merge-base", leftRef, rightRef], cwd);
          return result.code === 0 ? result.stdout.trim() || undefined : undefined;
        },
        // spec 351 (dueto F8) — plaintext Bridge tokens Tachyon still holds, for exact-match redaction of
        // live-captured pane text (read_output). Per-agent tokens aren't retained in plaintext.
        knownSecrets: () => [this.token, this.externalToken].filter((s): s is string => !!s),
        // t-35d95a — request_human_attention's target: latch the CALLER's own agent on the LIVE
        // attention monitor (distinct from flag_for_human, which flags a Task on the board).
        flagAwaitingHuman: (agent, reason) => this.monitor.flagAwaitingHuman(agent, reason),
      },
      {
        token: this.token,
        externalToken: this.externalToken,
        companion: {
          pairing: this.companion,
          live: this.companionLive,
          tab: this.companionTab,
          // SDD 422 — engine serves Companion Mobile PWA at /companion/app/*
          mobileDistRoot: this.resolveCompanionMobileDistRoot(),
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
        // Dogfood: agent process still holds a token the digest registry forgot → adopt on first MCP hit.
        healUnknownBearer: (bearer) => {
          const reg = this.callerRegistry;
          if (!reg) return undefined;
          const healed = healUnknownBearerFromProc(reg, bearer, this.callerScope());
          if (!healed.ok) return undefined;
          if (healed.adopted) {
            this.persistCallerRegistry();
            console.warn(
              `[tachyon] healed Bridge agent token for '${healed.name}' from live process env (was token_unknown)`,
            );
          }
          return { kind: "agent" as const, name: healed.name };
        },
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
      // t-016e8b: boot-time scans must see "ambiguous tmux read" (null) instead of the cold
      // cache, so the coordinator's backoff rescans retry rather than accept an empty inventory.
      listRunningStrict: async () => {
        const running = await this.manager.runningAgentsStrict();
        return running === null ? null : running.filter((n) => this.manager.kindOf(n) === "agent");
      },
      kindOf: (name) => this.manager.kindOf(name),
      isRunning: async (name) => {
        const running = await this.manager.runningAgents();
        return running.includes(name);
      },
      // AgentManager's rebind-only, uncached generic-resume boundary: it distinguishes a young
      // transcript that may still appear from a record that cannot resume. Rebind must receive
      // `ready` before it stops anything.
      canResume: (name, record) => this.manager.rebindResumeReadiness(name, record),
      stopGracefully: (name) => this.manager.stopGracefully(name),
      hardKillSession: async (name) => {
        // Kill the tmux session only — do NOT call AgentManager.kill (that wipes Temporary ledger rows).
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
   * a Temporary instance named `pl-<runId>-<nodeId>` into the RUN's worktree (registered for the
   * resolveSpawnCwd override just before the spawn); the run worktree is `run-<id>`. cmd-node exit-code
   * wiring is a follow — agent nodes complete via
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
        const signalBased = def.done === "signal";
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
          // an inline `cmd:` node — an ephemeral Temporary instance, dismissed when done. Deliver the task +
          // complete_node protocol ONLY for an interactive signal-based LLM (e.g. `cmd: codex` with the
          // workspace default config); an exit-based one-shot (sh / codex exec) runs its command as-is.
          //
          // SDD 478 M9 — the manager no longer infers which arm a Temporary command lands on, so this
          // door states it. t-c003e1 finished the migration: the kind is DECLARED by the node's own
          // `done` contract (loadPipeline's `nodeKindFromDone`) and validated there, so nothing here
          // reads the command text to decide what it is spawning.
          await this.manager.spawn(name, {
            cmd: def.cmd,
            // Paired with `cmd`: the manager reads the kind only on the Temporary path, and a node
            // reaching here without a cmd already resolved as a declared entry, exactly as before.
            kind: def.kind,
            env,
            pipeline: { runId, nodeId },
            reveal: false,
            ...(signalBased ? { taskBrief: taskInstr } : {}),
          });
        }
      },
      dismissNode: (runId, nodeId) => {
        const def = nodeDefOf(runId, nodeId);
        const name = nodeSpawnName(runId, nodeId, def ?? {});
        // kill the session + drop the pipeline-tagged ledger row. A DECLARED `agent:` node reverts to a
        // clean config-listed STOPPED agent (no stale def.pipeline/nonce/run-worktree overlay — codex M1,
            // so resume never reads a removed worktree); an inline `cmd:` node vanishes entirely.
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
   *  instruction contract. Conservative — an unknown/bare agent returns false (→ `task` stays required). */
  private agentHasPersona = (name: string): boolean => {
    const a = asAgent(this.config?.agents[name]);
    if (!a) return false;
    if (typeof a.instructions === "string" && a.instructions.trim().length > 0) return true;
    if (a.harness) return true;
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

  private profileAuthorityPort(): AgentProfileAuthorityPort {
    const refresh = async (): Promise<Map<string, AgentProfileAuthorityRecord>> => {
      await this.agentProfileAuthorityTail;
      const records = parseAgentProfileAuthorityRegistry(
        await this.host.getSecret(agentProfileAuthoritiesSecretKey(this.wsHash)),
      );
      this.agentProfileAuthorities = records;
      return records;
    };
    const mutate = async (operation: (records: Map<string, AgentProfileAuthorityRecord>) => void): Promise<void> => {
      const pending = this.agentProfileAuthorityTail.then(async () => {
        const records = parseAgentProfileAuthorityRegistry(
          await this.host.getSecret(agentProfileAuthoritiesSecretKey(this.wsHash)),
        );
        operation(records);
        const serialized = serializeAgentProfileAuthorityRegistry(records);
        await this.host.setSecret(agentProfileAuthoritiesSecretKey(this.wsHash), serialized);
        const persisted = parseAgentProfileAuthorityRegistry(
          await this.host.getSecret(agentProfileAuthoritiesSecretKey(this.wsHash)),
        );
        if (serializeAgentProfileAuthorityRegistry(persisted) !== serialized) {
          throw new Error("agent profile authority SecretStorage readback mismatch");
        }
        this.agentProfileAuthorities = persisted;
      });
      this.agentProfileAuthorityTail = pending.catch(() => undefined);
      return pending;
    };
    return {
      read: async (agentName) => {
        const record = (await refresh()).get(agentName);
        return record ? structuredClone(record) : undefined;
      },
      publish: async (record) => mutate((records) => {
        if (records.has(record.agentName)) throw new Error(`agent profile authority CAS conflict for '${record.agentName}'`);
        records.set(record.agentName, structuredClone(record));
      }),
      replace: async (record, expected) => mutate((records) => {
        const current = records.get(record.agentName);
        if (!current || !isDeepStrictEqual(current, expected)) {
          throw new Error(`agent profile authority CAS conflict for '${record.agentName}'`);
        }
        records.set(record.agentName, structuredClone(record));
      }),
      retire: async (agentName, expected) => mutate((records) => {
        const current = records.get(agentName);
        if (!current || !isDeepStrictEqual(current, expected)) {
          throw new Error(`agent profile authority CAS conflict for '${agentName}'`);
        }
        records.delete(agentName);
      }),
      move: async (oldAgentName, newAgentName, expected, target) => mutate((records) => {
        const current = records.get(oldAgentName);
        const destination = records.get(newAgentName);
        if (!current) {
          if (destination && isDeepStrictEqual(destination, target)) return;
          throw new Error(`agent profile authority CAS conflict for '${oldAgentName}'`);
        }
        if (!isDeepStrictEqual(current, expected) || destination !== undefined
          || target.agentName !== newAgentName || target.agentId !== expected.agentId) {
          throw new Error(`agent profile authority CAS conflict for '${oldAgentName}' -> '${newAgentName}'`);
        }
        records.delete(oldAgentName);
        records.set(newAgentName, structuredClone(target));
      }),
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
      .filter((a): a is string => !!a && !!asAgent(this.config?.agents[a])?.worktree);
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
      if (node.done !== "signal") continue;
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
      // t-50bbd4 — the formation lane finally gets its host. The suppression key is DERIVED from this
      // same machine-local key (domain-separated), so there is no new vault, no new key and no new
      // file; rotation follows the host key. Built here because this is where the key exists and
      // nowhere earlier — and if the key never arrives, the port is simply absent (fail-closed),
      // which the lifecycle reads as "no formation" rather than as a weaker rendering path.
      ws.formationLifecycle = createFormationLifecycleHost({
        hostRoot: path.join(workspaceRoot, ".tachyon", "formation-authority"),
        agentIdOf: (agentName) => ws.canonicalAgentIdOf(agentName),
      });
      // SDD 490 Fatia A — moment zero's host, beside the read-only one and pointed at the same
      // authority. The spawn host stays read-only; this one grants `bootstrap` and nothing else.
      ws.formationAdoption = createFormationAdoptionHost({
        hostKey: hmacKey,
        hostRoot: path.join(workspaceRoot, ".tachyon", "formation-authority"),
        workspaceId: ws.wsHash,
      });
      ws.callerRegistry = new CallerIdentityRegistry(hmacKey, persisted);
    } catch (err) {
      ws.host.notify(ws.t("per-agent Bridge tokens and authority custody unavailable: {0} (falling back to the shared token; gated authority remains fail-closed)", err instanceof Error ? err.message : String(err)), "warn");
    }
    try {
      ws.agentProfileAuthorities = parseAgentProfileAuthorityRegistry(
        await deps.host.getSecret(agentProfileAuthoritiesSecretKey(ws.wsHash)),
      );
    } catch (err) {
      ws.host.notify(ws.t("agent profile authority custody unavailable: {0} (profile-backed agents remain fail-closed)", err instanceof Error ? err.message : String(err)), "warn");
    }
    // t-ae221c — recovery used to be gated on `tachyon.yml` existing, because every one of these
    // three transactions wrote a second durable copy of the roster into that file. None of them does
    // now: the profile home is the only copy. Gating an unfinished create's rollback on a file it
    // never touches would strand it exactly when the workspace has no config yet.
    {
      const lifecycle = await reconcileAgentProfileLifecycle({
        workspaceRoot,
        authority: ws.profileAuthorityPort(),
        activateState: (agentName, state) => ws.activateAgentProfileLifecycleState(agentName, state),
      });
      if (lifecycle.degraded.length > 0) {
        ws.host.notify(ws.t("agent profile lifecycle recovery found {0} degraded transaction(s); affected agents remain fail-closed", lifecycle.degraded.length), "error");
      }
      const renames = await reconcileAgentProfileRenames({
        workspaceRoot,
        authority: ws.profileAuthorityPort(),
        live: {
          prepare: (oldAgentName, newAgentName) => ws.manager.prepareAgentProfileRename(oldAgentName, newAgentName),
          converge: (oldAgentName, newAgentName, snapshot) => ws.manager.convergeAgentProfileRename(oldAgentName, newAgentName, snapshot),
        },
        activateState: () => {
          if (!ws.reloadConfig()) throw new Error("trusted profile rename activation failed");
        },
      });
      if (renames.degraded.length > 0) {
        ws.host.notify(ws.t("agent profile rename recovery found {0} degraded transaction(s); affected agents remain fail-closed", renames.degraded.length), "error");
      }
      const forgets = await reconcileAgentProfileForgets({
        workspaceRoot,
        authority: ws.profileAuthorityPort(),
        live: {
          prepare: (agentName) => ws.manager.prepareAgentProfileForget(agentName),
          converge: (agentName, agentId, txid, snapshot) => ws.manager.convergeAgentProfileForget(agentName, agentId, txid, snapshot),
        },
        activateState: () => {
          if (!ws.reloadConfig()) throw new Error("trusted profile forget activation failed");
        },
      });
      if (forgets.degraded.length > 0) {
        ws.host.notify(ws.t("agent profile forget recovery found {0} degraded transaction(s); affected names remain fail-closed", forgets.degraded.length), "error");
      }
    }

    try {
      // Load config before the Bridge so settings.bridgePort applies; default is a
      // stable per-workspace derived port, so registrations survive editor restarts.
      ws.reloadConfig();
      // SDD 368 T14/R4 — one bounded Delivery reload before Bridge exposure or return,
      // so ensureWorkspaceFor / createForTest never leave callers on `uninitialized`.
      // start() still recomputes after rehydrate/GC (failed→ready retry + ledger truth).
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
    ws.disposables.push(ws.host.watch(
      workspaceRoot,
      ".tachyon/agents/*/agent.yml",
      { change: true, create: true, delete: true },
      onConfigChange,
    ));

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

    // Upgrade notice: MCP clients cache the Bridge tool schema at THEIR session start. t-e5910c —
    // since t-016e8b, a wired/non-Delivery-bound survivor under the "auto" rebind policy self-heals
    // within seconds without any user action, EITHER via a stale-session 404 reconnect on its next
    // Bridge call OR via the spec-364 coordinator's proactive stop->resume (which only runs under
    // "auto" — clientRebind.ts's onListenerReady returns before scheduleEnqueue under "notify").
    // An idle agent making no calls under "notify" gets marked suspect but never proactively
    // touched, so "notify" must be treated the same as "off" here: only "auto" is proactive enough
    // to suppress the notice. The genuinely stuck cases: not Bridge-wired at all, the policy isn't
    // "auto", or the execution is Delivery-bound (coordinator always leaves it running).
    const currentVersion = deps.host.appVersion();
    const lastVersion = deps.host.getState<string>(workspaceVersionStateKey(ws.wsHash));
    const runningAtBoot = await ws.manager.runningAgents();
    const stragglers = runningAtBoot.filter((name) => {
      const record = ws.ledger.get(name);
      if (!isTachyonBridgeWiredRecord(record)) return true;
      return ws.bridgeClientRebindSettings().onHostGenerationBump !== "auto";
    });
    if (lastVersion && lastVersion !== currentVersion && stragglers.length > 0) {
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

  /**
   * SDD 414/422 — companion pair base URL (no path).
   * Loopback when mobile off; Tailscale mesh IP when lanAccess (mobile) on.
   */
  companionBaseUrl(): string | undefined {
    const port = this.bridge.listenerPort;
    if (port === undefined) return undefined;
    return companionPairBaseUrl(port, this.config?.settings.companion?.lanAccess === true);
  }

  /** SDD 422 — pair URL candidates (single Tailscale URL when mobile on). */
  companionBaseUrlCandidates(): string[] {
    const port = this.bridge.listenerPort;
    if (port === undefined) return [];
    return companionPairBaseUrlCandidates(port, this.config?.settings.companion?.lanAccess === true);
  }

  /** SDD 414/422 — mint a short-lived pair code for Tachyon Companion. */
  issueCompanionPairCode(): IssuedPairCode | { ok: false; reason: CompanionPairBlockReason } {
    return this.companion.issuePairCode();
  }

  /** SDD 414 — companion HTTP prefix on the Bridge listener. */
  companionHttpPrefix(): string {
    return COMPANION_HTTP_PREFIX;
  }

  /**
   * SDD 422 — directory with Companion Mobile PWA (index.html + app.js).
   * Prefer host mediaPath (VSIX / engine bundle); fall back to env + repo/sibling dist.
   */
  resolveCompanionMobileDistRoot(): string | undefined {
    try {
      const packaged = this.host.mediaPath("media", "companion-mobile");
      if (fs.existsSync(path.join(packaged, "index.html"))) return packaged;
    } catch {
      /* host media path unavailable or escapes root */
    }
    return resolveCompanionMobileDist();
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
    // t-6c8437 — promote in-session Grok OIDC refreshes without waiting for stop/kill.
    try {
      this.harness.maybeHarvestGrokAuthFromWorkspace();
    } catch {
      /* best-effort; never block the agents view on auth I/O */
    }
    // t-9598cc — same for Claude: a private home that detached on refresh must not outlive a global
    // /login just because nobody happens to materialize that agent again.
    try {
      this.harness.maybeReconcileClaudeAuthFromWorkspace();
    } catch {
      /* best-effort; never block the agents view on auth I/O */
    }
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

  /** Mark only live canonical agents whose native projection selects this runtime source. */
  async markRuntimeConfigPending(runtime: "codex" | "claude" | "grok", scope: "global" | "workspace", revision: string): Promise<string[]> {
    const live = await this.manager.listAgents();
    const affected: string[] = [];
    for (const agent of live) {
      if (!agent.running) continue;
      const def = asAgent(this.config?.agents[agent.name]);
      if (!def) continue;
      // SDD 481 — Grok's WORKSPACE source is not a profile projection and cannot be one: Grok
      // discovers `.grok/config.toml` from the working directory, so it reaches a live agent even
      // under a private GROK_HOME (measured on 0.2.112, and re-confirmed by t-26f508's own
      // `[mcp_servers.ambient]` measurement). Any live grok agent is therefore affected, profile or
      // not. Grok's GLOBAL source deliberately falls through to the projection rule below: since
      // t-26f508 a canonical Grok profile projects measured families from `~/.grok/config.toml`,
      // which is exactly what that rule already asks about.
      if (runtime === "grok" && scope === "workspace") {
        if (binaryOf(def.cmd) !== "grok") continue;
        this.runtimeConfigPending.set(agent.name, { scope, revision });
        affected.push(agent.name);
        continue;
      }
      if (def.profileNativeConfig?.adapter !== runtime) continue;
      const selected = Object.values(def.profileNativeConfig.sources ?? {}).includes(scope);
      if (!selected) continue;
      this.runtimeConfigPending.set(agent.name, { scope, revision });
      affected.push(agent.name);
    }
    if (affected.length > 0) this.refreshAgentsViews();
    return affected.sort();
  }

  runtimeConfigPendingAgents(): string[] {
    return [...this.runtimeConfigPending.keys()].sort();
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
        // t-86e59a — the CHANNEL, not an actor. The pairing that authorizes this door is a code the
        // caller can mint for itself over the control socket (door 2, t-de7df4), so "a human on a paired
        // device" is not a fact this site has either.
        resolvedBy: APPROVAL_CHANNEL_COMPANION_HTTP,
        ...approvalResolutionPorts({
          listEntries: () => this.manager.list(),
          // t-d79534 — queue-aware delivery. A requester waiting on its own escalation is busy by
          // construction, so the old raw submit typed into an occupied composer and reported success.
          deliverNotice: (agent, line) => this.deliverNotice(agent, line),
        }),
        // t-7a306a — no local swallow. `resolveApproval` owns the best-effort policy for BOTH channels
        // and now reports the failure instead of discarding it; catching here first would put this
        // channel back to silence while the other one speaks.
        completePin: async (pinId) => { await this.pinStore.setDone(pinId, true); },
      });
      this.afterApprovalResolved(result.request.id);
      return {
        ok: true,
        id: result.request.id,
        status: decision,
        ...(result.injectError ? { injectError: result.injectError } : {}),
        ...(result.pinError ? { pinError: result.pinError } : {}),
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
  private bridgeRestartTail: Promise<void> = Promise.resolve();

  async restartBridge(): Promise<number> {
    const preferred = this.config?.settings.bridgePort ?? derivePort(this.wsHash);
    let result!: number;
    let error: unknown;
    const turn = this.bridgeRestartTail.then(async () => {
      try {
        await this.bridge.dispose();
        result = await this.startBridgeListener(preferred);
        if (result !== preferred) {
          this.host.notify(
            this.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and restart the Bridge).", preferred, result),
            "warn",
          );
        }
        this.refreshAgentsViews();
      } catch (err) {
        error = err;
        throw err;
      }
    });
    // Always advance the queue past failures so a rejected restart cannot poison later ones.
    this.bridgeRestartTail = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
    if (error) throw error;
    return result;
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
   * t-7551f9 — continue an unfinished task on another declared agent (new session + focused handoff).
   * Source agent is left as-is. Destination must be stopped. Not native resume / not cmd migration.
   */
  async continueTaskAcrossRuntime(input: {
    fromAgent: string;
    toAgent: string;
    reason?: string;
    taskSummary?: string;
  }): Promise<{
    ok: true;
    handoffId: string;
    handoffPath: string;
    fromAgent: string;
    toAgent: string;
    fromRuntime: string;
    toRuntime: string;
  }> {
    const { prepareContinueTask } = await import("../sessionContinuation/continueTask.js");
    const fromDef = this.manager.defOf(input.fromAgent) ?? this.config?.agents[input.fromAgent];
    const toDef = this.manager.defOf(input.toAgent) ?? this.config?.agents[input.toAgent];
    if (!fromDef?.cmd) throw new Error(`unknown source agent '${input.fromAgent}'`);
    if (!toDef?.cmd) throw new Error(`unknown destination agent '${input.toAgent}'`);
    if (this.manager.kindOf(input.toAgent) !== "agent" && this.manager.kindOf(input.toAgent) !== undefined) {
      /* kind may be undefined for declared-only not in manager maps */
    }
    const running = new Set(await this.manager.runningAgents());
    const rec = this.ledger.get(input.fromAgent);
    const prep = prepareContinueTask({
      workspaceRoot: this.workspaceRoot,
      fromAgent: input.fromAgent,
      fromCmd: fromDef.cmd,
      toAgent: input.toAgent,
      toCmd: toDef.cmd,
      reason: input.reason,
      taskSummary: input.taskSummary,
      sourceTranscriptPath: rec?.resume?.sessionId
        ? undefined // path resolution is runtime-specific; optional later
        : undefined,
      workspaceNote: this.workspaceRoot,
      toAgentRunning: running.has(input.toAgent),
    });
    if (!prep.ok) throw new Error(prep.message);
    await this.manager.spawn(input.toAgent, { taskBrief: prep.taskBrief, reveal: true });
    this.deps.onViewsChanged("agents");
    this.host.notify(
      this.t(
        "Continued task: {0} → {1} (new session; handoff {2})",
        input.fromAgent,
        input.toAgent,
        prep.packet.id,
      ),
      "info",
    );
    return {
      ok: true,
      handoffId: prep.packet.id,
      handoffPath: prep.packet.relPath,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      fromRuntime: prep.packet.fromRuntime,
      toRuntime: prep.packet.toRuntime,
    };
  }

  // ───────────────────────── spec 241 — per-agent continuity ─────────────────────────
  /** D4 staleness threshold (activity records) past which an injected brief is flagged "may be stale". */
  private static readonly CONTINUITY_STALE_LAG = CONTINUITY_STALE_LAG;

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

  /**
   * t-8168a7 review — positive-only durable proof for the CURRENT runtime session.
   *
   * Activity is archived by agent across fresh starts, so old events alone prove nothing about the
   * live incarnation. Match a turn-bearing event against the current ledger/ownership session ids.
   * Missing, delayed, unsupported, or malformed activity remains unknown, never "did not start".
   *
   * The pane transcript is deliberately excluded: it appends by agent name across restart/resume
   * without incarnation markers, so prior output there cannot answer this question safely.
   */
  private hasDurableTurnEvidence(agent: string): boolean {
    try {
      const record = this.ledger.get(agent);
      if (!record) return false;
      const sessionIds = new Set<string>();
      if (record.resume?.sessionId) sessionIds.add(record.resume.sessionId);
      const owner = latestOwnerFor(
        readSessionOwners(sessionOwnersFile(this.workspaceRoot)),
        agent,
        path.resolve(record.cwd),
      );
      if (owner?.sessionId) sessionIds.add(owner.sessionId);
      if (sessionIds.size === 0) return false;

      const turnEvents = new Set([
        "user.message.completed",
        "user.interrupted",
        "system.nudge",
        "assistant.message.completed",
        "assistant.thinking",
        "tool.started",
        "tool.completed",
        "tool.failed",
        "file.referenced",
        "file.changed",
        "file.snapshot",
        "usage.updated",
      ]);
      const log = new ActivityLog(path.join(this.workspaceRoot, ".tachyon", "activity"), agent);
      return log.readTail(1_000).some((event) => {
        const sessionId = event.sessionId ?? event.source.sessionId;
        return sessionId !== undefined && sessionIds.has(sessionId) && turnEvents.has(event.type);
      });
    } catch {
      return false;
    }
  }

  /** spec 241 D5 — reap an agent's continuity (brief + state) on explicit delete. Best-effort. */
  removeContinuity(agent: string): void {
    this.continuityStore.remove(agent);
    this.continuityState.remove(agent);
  }

  /**
   * t-e74631 — remove change worktrees whose work has already landed, at startup.
   *
   * The residue this clears is structural, not accidental: hygiene used to depend on the creating
   * agent waking up and remembering, and an agent that finished its task never wakes again. So 19
   * accumulated, 14 of them clean and already contained in the trunk. The workspace is nobody's
   * descendant, so it can do this for every entry regardless of who created it.
   *
   * Runs detached and after `rehydrateFromLedger`, for two different reasons: it probes git per
   * entry, which must never sit in front of activation; and lineage has to be rebuilt before any
   * authority question is asked of it. Nothing here can delete work — `reconcileHygiene` re-proves
   * clean, unoccupied and contained per entry, so the worst case is that it removes nothing.
   */
  /**
   * t-d29398 — drop every claim on a checkout that was just discarded.
   *
   * A checkout is named in two places besides git: the managed registry (written at
   * `syncAgentRecord`, BEFORE preparation can fail) and the session ledger's `worktree` block. Leaving
   * either behind trades a locked directory for a row pointing at a directory that no longer exists —
   * the same family of residue, one surface over. Best-effort and loud: a claim we could not clear is
   * reported rather than swallowed, because the discard itself already succeeded and must not be undone.
   */
  private forgetDiscardedWorktree(worktreePath: string): void {
    try {
      const entry = this.managedWorktrees.get(worktreePath);
      if (!entry) return;
      this.managedWorktrees.unregister(entry.id, { kind: "human" });
      // `clearWorktree` is a no-op for a row that never had one — the ordinary case here, since a
      // failed first launch never persisted a ledger row at all.
      if (entry.kind === "agent" && entry.agent) this.ledger.clearWorktree(entry.agent);
    } catch (err) {
      this.host.notify(
        `the worktree registry still claims the discarded checkout at ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
    }
  }

  private sweepWorktreeHygiene(): void {
    void this.managedWorktrees
      // The host acting on its own registry is the workspace authority — the same principal the
      // Worktrees tab already uses for `worktree.remove-managed`.
      .reconcileHygiene({ actor: { kind: "human" }, deleteBranch: true })
      .then((report) => {
        if (report.removed.length === 0) return;
        // Only the removals are announced. Refusals at startup are the NORMAL state — every worktree
        // with work still in it is a refusal — so surfacing them here would train people to ignore
        // the notification. `reconcile_worktrees` reports them in full when someone asks.
        this.host.notify(
          this.t("worktree hygiene: removed {0} landed change worktree(s)", report.removed.length),
          "info",
        );
        this.refreshAgentsViews();
      })
      .catch(() => { /* best-effort: never let cleanup cost an activation */ });
  }

  /**
   * t-621613 — does Tachyon still know this agent name, anywhere?
   *
   * The same union `gcOrphanAgentFootprints` keeps (declared ∪ live ∪ ledger ∪ forget-retained),
   * asked about ONE name and answering three values instead of two. `unknown` is the load-bearing
   * one, because the caller is an authority decision that deletes a checkout: an ambiguous tmux read
   * (`runningAgentsStrict` → null) and unreadable forget receipts both mean "could not prove
   * absence", and a fresh engine process's empty inventory must never read as "nobody is running".
   *
   * Refused agents count as PRESENT: `config.agents` drops them before any roster reader sees them,
   * but the human still declared them in tachyon.yml, and this question is about declaration and not
   * about whether the declaration validates.
   */
  private async agentPresence(name: string): Promise<OwnerPresence> {
    try {
      if (!name) return "unknown";
      if (this.config?.agents?.[name]) return "present";
      if (this.refusedAgents()[name]) return "present";
      if (this.ledger.get(name)) return "present";
      // Corrupt receipts make a name-only absence claim unsafe — their owner cannot be recovered, so
      // the name could be retained by one of them.
      if (agentProfileForgetRetentionUncertain(this.workspaceRoot)) return "unknown";
      if (agentProfileForgetRetainedNames(this.workspaceRoot).has(name)) return "present";
      const running = await this.manager.runningAgentsStrict();
      if (running === null) return "unknown";
      return running.includes(name) ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }

  /**
   * t-8310ca — drop continuity brief/state (+ matching activity logs) for agent names that are not
   * declared, not live in tmux, and not in the session ledger. Complements forgetAgent when dismiss
   * never ran. Best-effort; never blocks activation.
   */
  private gcOrphanAgentFootprints(live: Set<string>): void {
    try {
      if (agentProfileForgetRetentionUncertain(this.workspaceRoot)) return;
      const known = new Set<string>([
        ...live,
        ...this.ledger.all().keys(),
        ...Object.keys(this.config?.agents ?? {}),
        ...agentProfileForgetRetainedNames(this.workspaceRoot),
      ]);
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

  /**
   * Canonical declared-agent removal tail. The caller owns the `tachyon.yml` entry — and since
   * t-af4a5f it deletes that entry AFTER this call, not before.
   *
   * The old wording here said "first", and `deleteConfiguredAgent` obeyed it. Nothing joins the two
   * writes: no journal, no lock, and — measured — no reconcile, because a declared terminal holds no
   * session-ledger row for `gcLedger` to collect and this tail writes no journal for
   * `reconcileAgentProfileLifecycle` to read. A crash between them therefore left the roster row
   * deleted and every footprint below intact, permanently and with no door pointing at it. Clearing
   * the footprint while the name is still declared leaves the opposite residue: a listed entry that
   * looks exactly like a terminal nobody has launched, which the next removal finishes because every
   * step here is idempotent.
   */
  async forgetAgent(name: string): Promise<void> {
    forgetAgentFootprint(name, {
      workspaceRoot: this.workspaceRoot,
      ledger: this.ledger,
      removeHarnessHome: (agent) => this.harness.retireCredentials(agent),
      removeBridgeRuntimeHome: (agent) => this.retireBridgeRuntimeHome(agent),
      removePiSessionDir: (agent) => removePiSessionDir(this.workspaceRoot, agent),
    });
    this.removeContinuity(name);
  }

  async reconcileRuntimeCredentials(input: { dryRun: boolean; agentNames: string[] }): Promise<unknown> {
    const live = new Set(await this.manager.runningAgentsStrict() ?? []);
    const known = new Set([...Object.keys(this.config?.agents ?? {}), ...this.ledger.all().keys(), ...live]);
    const orphans = this.harness.credentialHomeNames().filter((name) => !known.has(name));
    if (input.dryRun) return { dryRun: true, orphans };
    const requested = [...new Set(input.agentNames)];
    const removed: string[] = [];
    const refused: Array<{ agent: string; reason: string }> = [];
    for (const name of requested) {
      if (!orphans.includes(name)) { refused.push({ agent: name, reason: "agent is known or no credential-bearing home exists" }); continue; }
      try { this.harness.retireCredentials(name); removed.push(name); }
      catch (error) { refused.push({ agent: name, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { dryRun: false, removed, refused };
  }

  isAgentProfileAgent(name: string): boolean {
    return asAgent(this.config?.agents[name])?.profileLifecycle !== undefined;
  }

  /** SDD 494 Part 1 — membership survives a failed runtime projection. */
  isSavedAgentMember(name: string): boolean {
    const source = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: "terminal" | "profile" | "refused" }>;
    }) | undefined)?.agentSources?.[name];
    return source?.mode === "profile" || source?.mode === "refused";
  }

  /**
   * SDD 494 Part 4 — the four presence facts for ONE name, each read from the record that owns it.
   *
   * The authority names are passed in rather than read here so a caller listing the whole fleet reads
   * the host secret once instead of once per agent, and so the sync sidebar path and the async tool
   * path measure the same four facts through the same function.
   */
  private savedAgentPresenceFacts(name: string, authorityNames: ReadonlySet<string>): SavedAgentPresenceFacts {
    const source = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: "terminal" | "profile" | "refused" }>;
    }) | undefined)?.agentSources?.[name];
    return {
      rosterRow: source?.mode === "profile" || source?.mode === "refused",
      profileOnDisk: fs.existsSync(path.join(this.workspaceRoot, ".tachyon", "agents", name, "agent.yml")),
      authorityRecord: authorityNames.has(name),
      projection: source?.mode === "profile",
      // t-8b58b3 — measured EXACTLY the way `savedAgentSubjects` enumerates it below: `lstat` +
      // `isDirectory`, so a symlink is neither listed as a subject nor reported as a home. The
      // defect this fact closes was the sweep listing a subject by reading the directory and then
      // measuring only the file inside it, and a listing rule the measurement does not share would
      // reintroduce it in the other direction.
      profileHomeOnDisk: fs.lstatSync(
        path.join(this.workspaceRoot, ".tachyon", "agents", name),
        { throwIfNoEntry: false },
      )?.isDirectory() === true,
    };
  }

  /** The authority names as the host holds them NOW; the cached map is a load-time snapshot. */
  private async savedAgentAuthorityNames(): Promise<Set<string>> {
    await this.agentProfileAuthorityTail;
    const records = parseAgentProfileAuthorityRegistry(
      await this.host.getSecret(agentProfileAuthoritiesSecretKey(this.wsHash)),
    );
    this.agentProfileAuthorities = records;
    return new Set(records.keys());
  }

  /** Every name any of the four owners knows about, so a disagreement cannot hide by being absent from one. */
  private savedAgentSubjects(authorityNames: ReadonlySet<string>): string[] {
    const sources = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: "terminal" | "profile" | "refused" }>;
    }) | undefined)?.agentSources ?? {};
    const names = new Set<string>();
    for (const [name, source] of Object.entries(sources)) {
      if (source.mode === "profile" || source.mode === "refused") names.add(name);
    }
    for (const name of authorityNames) names.add(name);
    try {
      for (const entry of fs.readdirSync(path.join(this.workspaceRoot, ".tachyon", "agents"), { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // No profile directory at all is a fact about a workspace with no Saved Agents, not a failure.
    }
    return [...names].sort();
  }

  /**
   * SDD 494 Part 4 — the on-demand roster reconciliation, read-only and computed on every call.
   *
   * `reconcile_worktrees` and `reconcile_task` answer "what is residue?" and "what happened?".
   * Nothing answered "these records disagree about this agent, and here is the door that removes it",
   * which is the question `claude23` forced a human to answer by reading five sources.
   */
  async reconcileSavedAgentRoster(): Promise<{
    workspaceRoot: string;
    agents: Array<{
      agent: string;
      member: boolean;
      facts: SavedAgentPresenceFacts;
      state: SavedAgentState;
      removal: SavedAgentRemovalDoor;
      refusal?: string;
    }>;
  }> {
    const authorityNames = await this.savedAgentAuthorityNames();
    const refusals = this.refusedAgentReasons();
    return {
      workspaceRoot: this.workspaceRoot,
      agents: this.savedAgentSubjects(authorityNames).map((agent) => {
        const facts = this.savedAgentPresenceFacts(agent, authorityNames);
        const state = deriveSavedAgentState(facts);
        return {
          agent,
          member: isSavedAgentStateMember(facts),
          facts,
          state,
          removal: savedAgentRemovalDoor(state),
          ...(refusals[agent] !== undefined ? { refusal: refusals[agent] } : {}),
        };
      }),
    };
  }

  /**
   * t-e722ce — the read-only projection of what a forget would do, computed before the human is
   * asked to approve anything.
   *
   * Every fact below is gathered HERE and nowhere else, so `projectAgentForgetPlan` stays pure and
   * every branch of it is reachable in a unit test. The measurements are the same ones the cascade
   * makes — a MEASURED occupancy verdict rather than the last-known-good inventory (t-4736b4), the
   * session ledger rather than the worktree registry — because a plan that samples different
   * sources than the transaction is a plan that can be wrong in exactly the way this replaces.
   *
   * The checkout probe is `existsSync`, deliberately weaker than `WorktreeManager.probeAbsence`:
   * the plan never GATES on it (it reports it as `dissent` and as a change of wording on a step that
   * runs either way), and the cascade re-proves absence against the repository before it acts.
   */
  async planAgentProfileForget(name: string, expectedRevision?: string): Promise<AgentForgetPlanV1> {
    if (!this.isSavedAgentMember(name)) throw new Error(`agent '${name}' is not backed by a canonical profile`);
    const snapshot = await this.inspectAgentProfileLifecycle(name);
    if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
      throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${name}' profile revision conflict`);
    }
    const record = this.ledger.get(name)?.worktree;
    const [occupancy, liveDescendants, authority] = await Promise.all([
      this.manager.probeAgentOccupancy(name),
      this.manager.liveDescendants(name),
      this.profileAuthorityPort().read(name),
    ]);
    const checkoutPresent = record ? fs.existsSync(record.path) : null;
    // A status probe that fails is not a fact about risk; reporting zeroes for it would be a
    // confident lie, so the worktree facts carry `status: null` and the plan says nothing measured.
    const status = record && checkoutPresent
      ? await this.worktrees.status(record.path, record.baseRef).catch(() => null)
      : null;
    const home = path.join(this.workspaceRoot, ".tachyon", "agents", name);
    return projectAgentForgetPlan({
      agentName: name,
      revision: snapshot.revision,
      occupancy,
      liveDescendants,
      ledgerWorktree: record
        ? {
          branch: record.branch,
          path: record.path,
          tachyonCreatedBranch: record.tachyonCreatedBranch === true,
          status: status
            ? {
              staged: status.staged,
              unstaged: status.unstaged,
              untracked: status.untracked,
              conflicts: status.conflicts,
              aheadOfBase: status.aheadOfBase,
              unpushed: status.unpushed,
              ...(status.aheadProbeFailed ? { aheadProbeFailed: true } : {}),
            }
            : null,
        }
        : null,
      checkoutPresent,
      registryWorktreeBranch: this.managedWorktrees.list({ kind: "agent" }).find((entry) => entry.agent === name)?.branch ?? null,
      authorityPresent: authority !== undefined
        && authority.agentId === snapshot.profile.agentId
        && authority.canonicalSha256 === snapshot.provenance.canonical.sha256,
      locatorPresent: this.isSavedAgentMember(name),
      profileHomePresent: fs.existsSync(home),
    });
  }

  /**
   * t-e722ce — the whole removal behind ONE approval, and the only thing a human door calls.
   *
   * This is the cascade `config.agent.delete` has always run with `removeWorktree: true`: release
   * the checkout, prove the session is down, then commit the canonical forget. It was reachable only
   * from the sidebar's Remove button, which is why Agent Studio's Forget — the door the product tells
   * people to use — refused on a precondition it had no way to satisfy. Moving the cascade here, and
   * having BOTH `deleteConfiguredAgent` and Studio call it, is what makes "one means" true rather
   * than merely stated: there is one implementation, so two doors cannot disagree about it.
   *
   * The order is not negotiable. `prepareAgentProfileForget` refuses while the ledger still records
   * a checkout, so the worktree must go first; and the canonical transaction re-measures occupancy
   * twice more after `stopAgentSessionForDelete` (t-4736b4's three gates), so stopping early is not
   * an optimisation that lets a later gate be skipped — it is the gate that makes the later two pass.
   */
  async forgetAgentProfileAgentCascade(name: string, expectedRevision?: string): Promise<AgentProfileForgetResult> {
    if (!this.isSavedAgentMember(name)) throw new Error(`agent '${name}' is not backed by a canonical profile`);
    if (this.ledger.get(name)?.worktree) await removeAgentWorktree(this, name, true);
    await stopAgentSessionForDelete(this.manager, name);
    return this.forgetAgentProfileAgent(name, expectedRevision);
  }

  /** Recoverable retirement for a profile-backed declared agent. */
  async forgetAgentProfileAgent(name: string, expectedRevision?: string): Promise<AgentProfileForgetResult> {
    if (!this.isSavedAgentMember(name)) throw new Error(`agent '${name}' is not backed by a canonical profile`);
    const inspected = await this.inspectAgentProfileLifecycle(name);
    if (expectedRevision !== undefined && inspected.revision !== expectedRevision) {
      throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${name}' profile revision conflict`);
    }
    const wasOpen = this.terminals.has(name);
    if (wasOpen) this.terminals.close(name);
    try {
      const result = await commitAgentProfileForget({
        workspaceRoot: this.workspaceRoot,
        agentName: name,
        ownerAgentName: this.config?.declaredOwner?.[name],
        expectedRevision: inspected.revision,
        authority: this.profileAuthorityPort(),
        live: {
          prepare: (agentName) => this.manager.prepareAgentProfileForget(agentName),
          converge: (agentName, agentId, txid, snapshot) => this.manager.convergeAgentProfileForget(agentName, agentId, txid, snapshot),
        },
        activateState: () => {
          if (!this.reloadConfig()) throw new Error("trusted profile forget activation failed");
          this.profileSpawnBlocked.delete(name);
        },
      });
      this.rebuildWatches();
      this.refreshAgentsViews();
      return result;
    } catch (error) {
      if (wasOpen && !agentProfileForgetBlocked(this.workspaceRoot, name)) {
        this.terminals.open(name, this.manager.session(name));
      }
      throw error;
    }
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
   *  Temporary rows (including fork/worktree-backed ones) stay quiet unless an explicit future opt-in exists. */
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

  /**
   * t-09edf2 — the workspace's projected `enforcement` gate hooks for one about-to-spawn session.
   *
   * Recomputed on EVERY door (create, restart, resume, fork) because both callers run on every spawn:
   * there is no cached plan that could go stale, and a plugin installed or reclassified between two
   * spawns is picked up by the next one without touching the live session it cannot safely reach.
   *
   * Reads the AUTHORITY lockfile (`this.workspaceRoot`), never the agent's cwd — which is the whole
   * point for a delegated worktree, and why crash-recovery reproduces the same projection instead of
   * importing whatever settings happen to sit in the directory it woke up in.
   */
  private projectedSessionHooks(runtime: string, agent: string): { projectedHooks?: Record<string, OwnershipHookGroup[]> } {
    const policy = this.config?.settings.agentHookProjection;
    if (!policy || Object.keys(policy).length === 0) return {};
    const plan = planProjectedPluginHooks({
      plugins: readHookProjectionCandidates(this.workspaceRoot),
      runtime,
      policy,
    });
    // Only what the human ASKED for and did not get is worth a toast. An unclassified plugin is the
    // default state, not an incident, and reporting all thirteen of them on every spawn would train the
    // reader to ignore the line that matters.
    for (const entry of plan.withheld.filter((withheldEntry) => policy[withheldEntry.plugin] !== undefined)) {
      this.host.notify(
        this.t("agent '{0}': plugin '{1}' hooks were not projected into its session — {2}", agent, entry.plugin, entry.reason),
        "warn",
      );
    }
    return Object.keys(plan.hooks).length > 0 ? { projectedHooks: plan.hooks } : {};
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

  /** Serialize idle recovery so continuity and handoff reminders never interleave their pane writes. */
  private async recoverOnIdle(agent: string): Promise<void> {
    if (this.recoveryInFlight.has(agent)) return; // a prior pass is still running — the flag persists for the next idle
    this.recoveryInFlight.add(agent);
    try {
      if (await this.flushQueuedNotice(agent)) {
        return;
      }
      if (await this.applyPendingContextRenewal(agent)) return;
      this.detectSessionDiscontinuity(agent);
      if (this.continuityState.read(agent).discontinuitySinceRestore) {
        await this.injectContinuity(agent, "compaction-idle");
      } else {
        await this.maybeRemindCheckpoint(agent);
      }
      // spec 245 — serially AFTER continuity (so two sendKeys never interleave): a light, workspace-throttled
      // reminder to append a PROJECT-handoff note. Cadence is `settings.handoff.nudgeEvery` (default 30m, `off`).
      await this.maybeRemindHandoff(agent);
      // t-fb1453 — a notice that arrived WHILE this pass held the mutex was queued by deliverNotice's
      // `recoveryInFlight` branch even though the recipient was idle the whole time. Without this it
      // waits for the next working→idle edge, and an agent that is done working has no next edge. Safe
      // to run unconditionally: this line is only reached when the flush at the top found nothing, so
      // it can never re-submit the notice that pass already wrote.
      await this.flushQueuedNotice(agent);
    } finally {
      this.recoveryInFlight.delete(agent);
    }
  }

  private queueContextRenewal(agent: string, mode: ContextRenewalMode): { status: "pending"; replaced?: ContextRenewalMode } {
    const cmd = this.manager.defOf(agent)?.cmd ?? "";
    if (!contextRenewalGesture(cmd, mode)) {
      const runtime = runtimeOf(cmd) ?? (cmd.trim() || "unknown");
      throw new Error(`renew_context refused for '${agent}': runtime '${runtime}' has no measured ${mode} gesture`);
    }
    const replaced = this.pendingContextRenewal.get(agent);
    this.pendingContextRenewal.set(agent, mode);
    return { status: "pending", ...(replaced ? { replaced } : {}) };
  }

  /** Cheap path kept separate from fresh so callers cannot erase context through a defaulted flag. */
  private async requestContextCompaction(agent: string): Promise<{ status: "pending"; replaced?: ContextRenewalMode }> {
    return this.queueContextRenewal(agent, "compact");
  }

  /** Destructive path; Bridge governance checks continuity before this port is reachable. */
  private async requestFreshContext(agent: string): Promise<{ status: "pending"; replaced?: ContextRenewalMode }> {
    return this.queueContextRenewal(agent, "fresh");
  }

  private async applyPendingContextRenewal(agent: string): Promise<boolean> {
    const mode = this.pendingContextRenewal.get(agent);
    if (!mode) return false;
    // t-a53dd9 — same door, different actor: context renewal also types into a pane a human may be
    // drafting in. It already refused on the cached reading; it now refuses on the fresh one.
    const unsafeReason = (await this.humanDraftPresent(agent))
      ? "the composer contains a draft"
      : listPendingApprovalRequests(this.workspaceRoot).some((row) => row.requester === agent)
        ? "a human approval is pending"
        : undefined;
    if (unsafeReason) {
      this.pendingContextRenewal.delete(agent);
      this.host.notify(this.t("context renewal for '{0}' was cancelled: {1}", agent, unsafeReason), "warn");
      return false;
    }
    const gesture = contextRenewalGesture(this.manager.defOf(agent)?.cmd ?? "", mode);
    if (!gesture) {
      this.pendingContextRenewal.delete(agent);
      this.host.notify(this.t("context renewal for '{0}' was cancelled: runtime has no measured {1} gesture", agent, mode), "warn");
      return false;
    }
    const receipt = await this.submitNoticeLine(agent, gesture);
    this.pendingContextRenewal.delete(agent);
    if (receipt.status === "submit-unconfirmed") {
      this.host.notify(this.t("context renewal for '{0}' was typed but submission could not be confirmed", agent), "warn");
    }
    return true;
  }

  /**
   * t-c3c0c2 — the PORTS the assignee wake-up needs; the effect itself is composed in
   * `taskNotificationPolicy`. This used to be the whole effect written out here, and the gate ended up
   * far from the decision it protects — which is how a test harness came to reimplement it and omit
   * the dead-session check.
   *
   * Liveness matches notify_agent's: a terminal is not an agent and a stopped agent is not live, and
   * both are skipped silently, because assignment must not depend on whether the assignee is online.
   */
  private taskAssigneeWakePorts(): TaskAssigneeWakePorts {
    return {
      isLiveAgent: async (name) =>
        this.manager.kindOf(name) === "agent" && (await this.tmux.hasSession(this.manager.session(name))),
      deliver: (agent, line) => this.deliverNotice(agent, line),
    };
  }

  /**
   * t-d79534 — public because approval resolution reaches it from the editor path
   * (`extensionOperationService`) too, not only from the in-class Companion wiring.
   */
  async deliverNotice(agent: string, line: string, metadata: NoticeQueueMetadata = {}): Promise<NoticeDeliveryResult> {
    // t-0db8cb — use attentionOf (completion-hint aware), not raw monitor.stateOf. After notify_agent the
    // sender is presented idle for consumers while raw may still say working (CPU / chrome lag). Queue
    // policy must match list_agents / wait_for_agent, or notices wait on a working→idle edge that the
    // presentation layer already claims has happened.
    const attention = this.attentionOf(agent);
    const state = attention?.state;
    const evidencedWorking = isEvidencedWorking(state, attention?.hasStartedTurn);
    // t-e169e4 — a later notify is itself an escape door for the deadlock. Submit the exact retained
    // queue head already staged in an IDLE composer, then queue this newer notice behind the turn we
    // just started. Never continue into a second immediate paste on the now-working runtime.
    if (state === "idle" && !this.recoveryInFlight.has(agent)) {
      const queued = this.noticeQueue.peek(agent);
      if (queued && await this.stagedQueuedNoticePresent(agent, queued.line)) {
        await this.flushQueuedNotice(agent);
        return this.enqueueNotice(agent, line, metadata);
      }
    }
    if (evidencedWorking || state === "throttled" || state === "needs-input" || attention?.composerOccupied || this.recoveryInFlight.has(agent)) {
      return this.enqueueNotice(agent, line, metadata, attention?.composerOccupied ? "human-draft" : undefined);
    }
    // t-a53dd9 — the check above is a poll up to ATTENTION_POLL_MS old; this one is taken NOW, against
    // the pane we are about to write into. Both are kept: the cached read costs nothing and catches
    // the common case, and this one closes the seconds-wide window in which the owner started typing
    // after the last capture. Without it the queue is right about everything except the one state it
    // exists to protect.
    if (await this.humanDraftPresent(agent)) {
      return this.enqueueNotice(agent, line, metadata, "human-draft");
    }
    const receipt = await this.submitNoticeLine(agent, line);
    // t-8d190f — a typed-but-unsubmitted line used to report "notified". The doorbell must stay
    // actionable instead: the caller learns the text is staged and can decide, rather than believing
    // a delivery that never started a turn.
    if (receipt.status === "submit-unconfirmed") {
      return { status: "submit-unconfirmed", submitReason: receipt.reason };
    }
    return { status: "notified" };
  }

  private enqueueNotice(
    agent: string,
    line: string,
    metadata: NoticeQueueMetadata = {},
    heldFor?: "human-draft",
  ): NoticeDeliveryResult {
    const result = this.noticeQueue.enqueue(agent, line, metadata);
    if (result.dropped > 0) {
      // t-2153ae — this records the loss; it does not bound the wait or change the authored-doorbell
      // TTL exemption. The existing toast remains the immediate human warning.
      appendDoorbellOverflowEvent(this.workspaceRoot, {
        event: "overflow-drop",
        to: agent,
        at: new Date().toISOString(),
        dropped: result.dropped,
        queued: result.queued,
      });
      this.host.notify(this.t("dropped {0} old notice(s) for '{1}' while queueing a newer one", result.dropped, agent), "warn");
    }
    // t-a53dd9 — WHY it waits travels back to the sender. "Queued for idle delivery" reads as "the
    // recipient is mid-turn, it will land in a moment"; a held-for-a-human-draft wait is a different
    // thing with a different ending (it clears when the human submits, or it expires and the human is
    // told). The false-positive cost this task names — a doorbell that dies leaving no trace — starts
    // with the sender not being able to tell those two apart.
    return {
      status: "queued",
      queued: result.queued,
      dropped: result.dropped || undefined,
      oldestCreatedAt: result.oldestCreatedAt,
      heldFor,
    };
  }

  /**
   * t-a53dd9 — "is a human typing into this pane right now?", measured fresh, with the cached poll as
   * the fallback for runtimes that cannot answer (see AttentionMonitor.probeComposerOccupied for the
   * three-valued contract and the per-runtime signal).
   */
  private async humanDraftPresent(agent: string): Promise<boolean> {
    const fresh = await this.monitor.probeComposerOccupied(agent);
    return fresh ?? !!this.attentionOf(agent)?.composerOccupied;
  }

  /**
   * t-fb1453 — never silently. Expiry is a LOSS, and until now the only one with no witness: the sender
   * was answered `queued '<x>' for idle delivery` and nothing ever took that back. Named, not counted —
   * "a notice expired" tells a human nothing they can act on; "the report codex-revisor filed for you
   * expired unread" tells them which piece of work they now have to go find by hand.
   */
  private reportExpiredNotices(items: NoticeQueueItem[]): void {
    for (const item of items) {
      const message = item.sourceChild
        ? this.t(
            "'{0}' never saw the notice from '{1}' — it expired in the delivery queue: {2}",
            item.target,
            item.sourceChild,
            item.line,
          )
        : this.t("'{0}' never saw a Tachyon notice — it expired in the delivery queue: {1}", item.target, item.line);
      this.host.notify(message, "warn");
    }
  }

  /**
   * t-fb1453 / t-99ccc9 — provenance for a doorbell that outlived its sender. Without it the recipient
   * cannot tell a report retained across a dismissal from something that just happened, which is the
   * confusion t-99ccc9 was filed about. Bounded and single-line, like everything else in the envelope.
   */
  private delayedSenderMarker(sender: string, queuedAt: number, dismissed: boolean): string {
    const minutes = Math.max(1, Math.round((Date.now() - queuedAt) / 60_000));
    const dismissal = dismissed ? `; '${sender}' was dismissed before delivery` : "";
    return `[delayed ~${minutes}m; reported by '${sender}'${dismissal}]`;
  }

  private async flushQueuedNotice(agent: string): Promise<boolean> {
    // t-a53dd9 — expiry is swept BEFORE the composer guard, not after it. The old order made the one
    // wait with no natural end also the one wait the TTL never reached: a draft that is never
    // submitted holds this early-return forever, so the sweep below never ran for exactly the queue
    // that was stuck. The declared exit (expire, and tell the human by name — t-fb1453) only exists
    // if it is reachable while the queue is held.
    this.noticeQueue.clearExpired(agent);
    // t-fb1453 — peek, submit, THEN drop. Removing first meant an unobserved submit took the notice
    // with it (t-b4a799's unknown-flattened-into-known); now only a KNOWN fate consumes the item.
    let item = this.noticeQueue.peek(agent);
    if (!item) return false;
    const composerOccupied = await this.humanDraftPresent(agent);
    const retryStaged = composerOccupied && await this.stagedQueuedNoticePresent(agent, item.line);
    // t-e169e4 — occupied content remains human-owned unless it is byte-for-byte the retained queue
    // head. The queue is the out-of-band ownership mark; provenance-looking text alone is not enough.
    if (composerOccupied && !retryStaged) return false;
    while (item) {
      let line = item.line;
      if (item.sourceChild !== undefined) {
        const currentIncarnation = this.agentIncarnations.get(item.sourceChild);
        // t-572cef: agentIncarnationCounters is never deleted (onKilled clears only agentIncarnations,
        // rename only raises it) so `.has()` here means "this name went through recordSpawnIncarnation
        // at least once" — i.e. a genuinely killed-and-not-respawned child, as opposed to a name this
        // process has never recorded at all (a reload survivor start() didn't cover). React only in the
        // former case when incarnations disagree (covers both "mismatched" and "killed, no current
        // entry"); an entirely unknown name delivers — the safe default for the latter, undamaged case.
        const everRecorded = this.agentIncarnationCounters.has(item.sourceChild);
        const senderDismissed = everRecorded && currentIncarnation !== item.sourceIncarnation;
        if (senderDismissed) {
          // t-fb1453 — the sender being gone means different things for the two origins, and treating
          // them alike is what lost the doorbell.
          //
          // A host poke is Tachyon's claim about a child's LIVE state ("child 'X' is waiting for
          // input"). That claim stops being true when X stops existing, so it is still discarded
          // (t-572cef/t-eed531: the dead child must not reach out from beyond the grave).
          if (item.origin === "host-poke") {
            this.noticeQueue.dropFront(agent);
            item = this.noticeQueue.peek(agent);
            continue;
          }
          // A `notify_agent` doorbell is the child's own finished report. Dismissing the author does
          // not falsify the report — and measured on 2026-08-01, dismissing the author is precisely
          // what destroyed it: codex-revisor rang at 21:08, the coordinator killed it minutes later,
          // and the queued completion died with it while still inside its TTL.
          //
          // t-99ccc9 dropped these deliberately, and its incident was real: a parent that had ALREADY
          // consumed the work via read_output was later told about it again, out of context. But
          // "sender was killed" was only ever a PROXY for "already acknowledged" — the acknowledgement
          // mechanism that task asked for was explicitly deferred as out of free-run scope. That same
          // task's acceptance criteria also say, in as many words, that there must be "nenhuma perda
          // silenciosa de completion signals" and that delayed messages must be "rotuladas como
          // atrasadas [com] idade/proveniência". So: deliver it, and never as if it were fresh news.
          line = `${item.line} ${this.delayedSenderMarker(item.sourceChild, item.createdAt, true)}`;
        } else if (item.origin === "agent-authored" && Date.now() - item.createdAt > DEFAULT_NOTICE_TTL_MS) {
          // t-93bec9 — the common late path is a busy recipient, not a dismissed sender. Preserve
          // useful age/provenance without claiming a dismissal that did not happen.
          line = `${item.line} ${this.delayedSenderMarker(item.sourceChild, item.createdAt, false)}`;
        }
      }
      try {
        const receipt = retryStaged
          ? await this.submitStagedNoticeLine(agent, line)
          : await this.submitNoticeLine(agent, line);
        // t-8d190f drew the line between "delivered" and "we could not see it leave the composer";
        // t-fb1453 makes the queue respect it. An unconfirmed line stays queued for the next idle
        // rather than being consumed on a guess. Both outcomes still wrote to the pane, so both
        // report true — the caller's question is "did I touch the pane this pass", not "did it land".
        if (receipt.status !== "submit-unconfirmed") {
          this.noticeQueue.dropFront(agent);
          this.completeQueuedReloadSummary(agent, item.line);
        }
        return true;
      } catch (err) {
        // A throw here is `submitNoticeLine`'s dead-session path (which already cleared the queue) or a
        // transient tmux failure. Consume either way: this branch is loud, and a notice that re-fires a
        // warning on every idle would bury the one that matters.
        this.noticeQueue.dropFront(agent);
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

  /** t-fb1453 — `origin` is a parameter with no default on purpose: see NoticeQueue's ChildBoundNoticeMetadata. */
  /**
   * t-458497 — the derived two-axis runtime condition, from cached state only.
   *
   * One accessor for both doors (the Bridge tool and the slack doorbell). Cheap enough to call on the
   * heartbeat: it reads registries that are frozen at module load plus the observation service's
   * already-collected snapshot, and starts nothing.
   */
  runtimeCondition(): RuntimeConditionReportV1 {
    return projectRuntimeCondition({
      generatedAt: new Date().toISOString(),
      ...(this.deps.runtimeQuotaObservations?.() ?? {}),
    });
  }

  private sourceNoticeMetadata(agent: string, origin: NoticeOrigin): NoticeQueueMetadata {
    return { origin, sourceChild: agent, sourceIncarnation: this.agentIncarnations.get(agent) };
  }

  private async submitNoticeLine(agent: string, line: string): Promise<SubmitReceipt> {
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session))) {
      this.noticeQueue.clear(agent);
      throw new Error(`agent '${agent}' is not running`);
    }
    // t-8d190f — hand the runtime's measured composer profile down so the submit can be CONFIRMED
    // (the text left the editor) instead of assumed. Undeclared runtimes resolve to undefined and
    // keep the older, weaker check, reported as unconfirmed rather than as success.
    return this.tmux.sendSubmittedLine(session, line, {
      composer: composerProfileFor(this.manager.defOf(agent)?.cmd),
    });
  }

  private async stagedQueuedNoticePresent(agent: string, line: string): Promise<boolean> {
    return (await this.monitor.probeComposerText(agent)) === line.trim();
  }

  private async submitStagedNoticeLine(agent: string, line: string): Promise<SubmitReceipt> {
    const session = this.manager.session(agent);
    if (!(await this.tmux.hasSession(session))) {
      this.noticeQueue.clear(agent);
      throw new Error(`agent '${agent}' is not running`);
    }
    return this.tmux.sendStagedLine(session, line, {
      composer: composerProfileFor(this.manager.defOf(agent)?.cmd),
    });
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
      const receipt = await this.tmux.sendSubmittedLine(session, `[Tachyon] Your continuity brief is malformed (bad frontmatter) — fix or delete .tachyon/continuity/${agent}.md, then set_continuity. Recent activity is preserved in the durable log.`, {
        composer: composerProfileFor(this.manager.defOf(agent)?.cmd),
      });
      if (receipt.status === "submit-unconfirmed") {
        this.host.notify(this.t("continuity nudge for '{0}' was typed but submission could not be confirmed", agent), "warn");
        return;
      }
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
    const text = injectionText({ agent, reason: decision.reason, lag, staleLag: Workspace.CONTINUITY_STALE_LAG, briefStatus: brief?.meta.status });
    const receipt = await this.tmux.sendSubmittedLine(session, text, {
      composer: composerProfileFor(this.manager.defOf(agent)?.cmd),
    });
    if (receipt.status === "submit-unconfirmed") {
      this.host.notify(this.t("continuity nudge for '{0}' was typed but submission could not be confirmed", agent), "warn");
      return;
    }
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
   * The single linked Git projection for a canonical Delivery, or a refusal. Kept while the Delivery
   * lease still resolves a worktree by projection (t-e88c8a stage 3 removes both together).
   */
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

  // ── spec 273 — the worktree evidence channel ─────────────────────────────
  private evidenceSeq = 0;

  /** Current HEAD of a worktree (for evidence staleness), or "" if the worktree is gone. */
  private async worktreeHead(wt: { path: string }): Promise<string> {
    return fs.existsSync(wt.path) ? (await this.worktrees.headState(wt.path)).headRef : "";
  }

  /** A compact, mechanical evidence summary for agent handoffs (undefined when none). */
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
   * never touches Temporary/fork rows or a stopped-but-still-declared Saved agent (kept for resume).
   */
  private async gcLedger(declaredInConfig: Set<string>, live: Set<string>): Promise<void> {
    for (const [name, rec] of this.ledger.all()) {
      // t-04052d — `!isTemporaryInstance` rather than the retired `declared`. This branch DELETES, so
      // the fail-closed direction is to skip: a row with no declared policy reads as temporary here and
      // is left alone rather than collected on a guess.
      if (!isTemporaryInstance(rec) && !declaredInConfig.has(name) && !live.has(name)) {
        try {
          forgetAgentFootprint(name, {
            workspaceRoot: this.workspaceRoot,
            ledger: this.ledger,
            removeHarnessHome: (agent) => this.harness.retireCredentials(agent),
            removeBridgeRuntimeHome: (agent) => this.retireBridgeRuntimeHome(agent),
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
   * t-123143 — self-heal the append-only session-owner ledger: old Temporary instances dismissed before
   * removeSessionOwnerRows existed left ownership rows behind forever. Keep only agents still known by
   * one of the authoritative workspace sets: live tmux sessions, durable session ledger, or tachyon.yml.
   */
  private compactSessionOwners(declaredInConfig: Set<string>, live: Set<string>): void {
    if (agentProfileForgetRetentionUncertain(this.workspaceRoot)) return;
    const known = new Set([
      ...live,
      ...this.ledger.all().keys(),
      ...declaredInConfig,
      ...agentProfileForgetRetainedNames(this.workspaceRoot),
    ]);
    compactSessionOwnerRows(sessionOwnersFile(this.workspaceRoot), known);
    compactSpawnSettings(this.workspaceRoot, known);
  }

  /**
   * t-7bc276 — how many files the orphan-home report will stat before answering with a floor. Chosen
   * against the measured case: the tree that motivated this held 41,948 files across 35 homes, so a
   * cap in the low thousands still names every home and its order of magnitude for a fraction of the
   * syscalls, on a path that runs inside `start()`.
   */
  private static readonly ORPHAN_HOME_MEASURE_FILE_CAP = 2000;

  private gcHarnessHomes(): void {
    try {
      if (agentProfileForgetRetentionUncertain(this.workspaceRoot)) return;
      const declared = new Set([
        ...Object.keys(this.config?.agents ?? {}),
        ...agentProfileForgetRetainedNames(this.workspaceRoot),
      ]);
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
      this.reportOrphanBridgeRuntimeHomes(declared, tracked);
    } catch {
      /* GC is best-effort — a stale home is harmless, never block start */
    }
  }

  /**
   * t-7bc276 — name the private runtime homes nobody owns any more. REPORT ONLY, deliberately:
   * `worktree_processes` reports an orphan process and never kills one, and orphan BYTES had no
   * equivalent at all until here. Removal belongs to the end-of-life door somebody actually opened
   * (`forgetAgent`), not to a sweep that runs on its own at start — the homes this finds are the ones
   * that predate that door or whose agent vanished without passing through it, and deleting them
   * unasked would be exactly the irreversible-without-being-asked shape this fix exists to end.
   *
   * The keep-set is the sweep's own: declared in tachyon.yml (plus profile-forget retention) or still
   * carried by a ledger row.
   */
  private reportOrphanBridgeRuntimeHomes(declared: Set<string>, tracked: Set<string>): void {
    const orphans = this.harness.listBridgeRuntimeHomes()
      .filter((home) => !declared.has(home.agent) && !tracked.has(home.agent))
      // Bounded per home: this runs inside `start()`, and the tree that motivated the fix held 41,948
      // files. A floor is enough to make the cost legible; an exact byte count is not worth the stat storm.
      .map((home) => ({ ...home, ...measureDirUsage(home.path, Workspace.ORPHAN_HOME_MEASURE_FILE_CAP) }));
    if (orphans.length === 0) return;
    const bytes = orphans.reduce((total, home) => total + home.bytes, 0);
    const files = orphans.reduce((total, home) => total + home.files, 0);
    // A capped walk reports a FLOOR, and says so rather than quietly understating the disk.
    const floor = orphans.some((home) => home.truncated) ? "≥ " : "";
    const worst = [...orphans].sort((a, b) => b.bytes - a.bytes).slice(0, 3)
      .map((home) => `${home.agent}.${home.runtime} (${home.truncated ? "≥ " : ""}${humanBytes(home.bytes)})`).join(", ");
    this.host.notify(this.t(
      "{0} private runtime home(s) under .tachyon/bridge-mcp belong to no agent: {1}, {2} file(s). Largest: {3}. Nothing reads them; dismissing an agent now removes its own.",
      String(orphans.length),
      `${floor}${humanBytes(bytes)}`,
      `${floor}${files}`,
      worst,
    ), "warn");
  }

  /**
   * t-7bc276 — the end-of-life removal of an agent's private `bridge-mcp` runtime home, with the
   * receipt that makes the disk visible: a dismissed grok agent used to leave ~12.9 MB behind
   * silently, and 35 of them reached 2.2 GB before anyone looked. Says what left, and says what it
   * declined to take and why.
   */
  private retireBridgeRuntimeHome(agent: string): void {
    this.harness.retireBridgeRuntimeHomes(agent, {
      onOutcome: (outcome) => {
        this.host.notify(
          outcome.removed
            ? this.t(
              "Removed {0}'s private {1} home at end of life: {2}, {3} file(s).",
              outcome.agent, outcome.runtime, humanBytes(outcome.bytes), String(outcome.files),
            )
            : this.t(
              "Kept {0}'s private {1} home ({2}, {3} file(s)): it is still in use, or could not be removed.",
              outcome.agent, outcome.runtime, humanBytes(outcome.bytes), String(outcome.files),
            ),
          outcome.removed ? "info" : "warn",
        );
      },
    });
  }

  reloadConfig(): boolean {
    const file = this.configPath();
    const prevCompanionTabTools = this.config?.settings.companion?.tabTools === true;
    const prevCompanionLanAccess = this.config?.settings.companion?.lanAccess === true;
    if (!file) {
      this.config = undefined;
      this.configFailure = undefined;
      // t-7d6013 — no file, nothing discarded: a record naming a file that is gone would outlive the
      // thing it describes.
      this.setConfigDiscards(undefined);
      this.profileSpawnBlocked.clear();
      if (prevCompanionTabTools) {
        // Settings gone → drop companion tools from live MCP sessions.
        try {
          this.bridge.forceToolListRefresh();
        } catch {
          /* bridge may not be ready on early dispose paths */
        }
      }
      if (prevCompanionLanAccess && this.bridge.listenerPort !== undefined) {
        // LAN was on; config gone → rebind loopback only when Bridge is already listening.
        // Cold start has not started the listener yet — skip (avoids race with startBridgeListener).
        void this.restartBridge().catch(() => undefined);
      }
      return false;
    }
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      this.configFailure = {
        path: file,
        file: path.basename(file),
        errors: [`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`],
        at: new Date().toISOString(),
      };
      this.blockProfileSpawnsFromLiveConfig();
      return false;
    }
    const { config, errors, warnings, discarded, profileErrors } = this.parseTrustedConfigText(text);
    // t-af6803 — a broken profile is ONE agent's problem. The loader keeps its actionable reason in
    // agentSources as `refused`; putting the same error into the FILE-wide configFailure slot marks
    // every healthy/running row `config invalid` and makes unrelated profiles unspawnable.
    const isolatable = errors.length > 0 && profileErrors.length === errors.length && config !== undefined;
    if (errors.length > 0 && !isolatable) {
      // t-8354ae — keep a durable failure surface (sidebar banner); toast alone is not enough.
      // Do NOT clear a previously-loaded in-memory config: live sessions keep working until
      // the human fixes the file. Cold start leaves config undefined (never loaded).
      this.configFailure = {
        path: file,
        file: path.basename(file),
        errors: [...errors],
        at: new Date().toISOString(),
      };
      this.blockProfileSpawnsFromLiveConfig();
      this.host.notify(this.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? this.t(" (+{0} more)", errors.length - 1) : ""), "error");
      return false;
    }
    for (const warning of warnings) this.host.notify(this.t("{0}: {1}", path.basename(file), warning), "warn");
    // t-7d6013 — the toast above still fires (it is the "right now" signal), and everything it names
    // that was actually DROPPED also lands in a slot that outlives it. Set on the successful-load path
    // only: the fatal path above keeps the previously loaded config running, so it keeps that config's
    // discards too rather than clearing a record that still describes what is live.
    this.setConfigDiscards(makeConfigDiscards({
      path: file,
      file: path.basename(file),
      discarded,
      at: new Date().toISOString(),
    }));
    this.config = config;
    // The refused row itself is the durable failure surface (name + reason + disabled spawn). The
    // global banner is reserved for failures that actually invalidate tachyon.yml as a whole.
    this.configFailure = undefined;
    this.profileSpawnBlocked.clear();
    if (isolatable) {
      this.blockRefusedProfileSpawnsFromLiveConfig();
      this.host.notify(
        this.t("{0}: {1}{2}", path.basename(file), profileErrors[0], profileErrors.length > 1 ? this.t(" (+{0} more)", profileErrors.length - 1) : ""),
        "error",
      );
    }
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
    // Only when already listening. Cold start (_create) loads config before startBridgeListener;
    // a fire-and-forget restart here races startBridgeListener → "Bridge already started".
    const nextCompanionLanAccess = config?.settings.companion?.lanAccess === true;
    if (
      prevCompanionLanAccess !== nextCompanionLanAccess &&
      this.bridge.listenerPort !== undefined
    ) {
      void this.restartBridge().catch(() => undefined);
    }
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

  /**
   * t-7d6013 — the discards a reader should SEE: the record, unless the human has already dismissed
   * this exact set. Dismissal is content-keyed, so nothing has to be re-shown on every reload of an
   * unchanged file, and nothing stays hidden once what was dropped changes.
   */
  get configDiscards(): ConfigDiscards | undefined {
    const record = this.configDiscardsRecord;
    if (!record) return undefined;
    return this.dismissedConfigDiscardsSignature === record.signature ? undefined : record;
  }

  /**
   * The human read it and took it off the screen. Keyed by the signature the UI was showing, so a
   * click that races a reload dismisses nothing rather than hiding a set nobody has read (false when
   * that happens, which is also what the sidebar reports as "no change").
   */
  dismissConfigDiscards(signature: string): boolean {
    const record = this.configDiscardsRecord;
    if (!record || record.signature !== signature) return false;
    if (this.dismissedConfigDiscardsSignature === signature) return false;
    this.dismissedConfigDiscardsSignature = signature;
    return true;
  }

  /**
   * A dismissal covers one exact set of discarded lines. Any other set — including no discards at
   * all, which is what a FIXED file produces — retires it, so re-introducing the same typo later
   * shows the record again instead of inheriting a decision made about a different file.
   */
  private setConfigDiscards(next: ConfigDiscards | undefined): void {
    this.configDiscardsRecord = next;
    if (this.dismissedConfigDiscardsSignature !== next?.signature) this.dismissedConfigDiscardsSignature = undefined;
  }

  parseTrustedConfigText(yamlText: string) {
    const parsed = loadProfileAwareConfig({
      yamlText,
      workspaceRoot: this.workspaceRoot,
      authorities: this.agentProfileAuthorities,
      homeDir: this.agentProfileHomeDir,
    });
    return parsed;
  }

  private blockProfileSpawnsFromLiveConfig(): void {
    const sources = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: "terminal" | "profile" | "refused" }>;
    }) | undefined)?.agentSources;
    this.profileSpawnBlocked = new Set(
      // t-0ad300 — `refused` joins `profile` here. A refused agent now has a roster row, so for the
      // first time there is a surface that could try to start it; it has no definition to start
      // from, and starting it is exactly what its refusal denies.
      Object.entries(sources ?? {})
        .filter(([, source]) => source.mode === "profile" || source.mode === "refused")
        .map(([name]) => name),
    );
  }

  private blockRefusedProfileSpawnsFromLiveConfig(): void {
    const sources = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: "terminal" | "profile" | "refused" }>;
    }) | undefined)?.agentSources;
    this.profileSpawnBlocked = new Set(
      Object.entries(sources ?? {})
        .filter(([, source]) => source.mode === "refused")
        .map(([name]) => name),
    );
  }

  /**
   * t-0ad300 — the agents tachyon.yml declares that this load refused, name → reason.
   *
   * Read off `agentSources`, which is the only structure that still holds them: the isolation from
   * t-588644 deletes a refused agent from `config.agents` before the legacy parser runs, and every
   * roster reader downstream goes through `config.agents`.
   */
  refusedAgents(): Record<string, string> {
    // The load-time snapshot, not a fresh secret read: this runs on every `list()`, and the sidebar
    // must not make a host secret call per refresh. The tool below reads the live registry.
    const authorityNames = new Set(this.agentProfileAuthorities.keys());
    const out: Record<string, string> = {};
    for (const [name, reason] of Object.entries(this.refusedAgentReasons())) {
      out[name] = this.savedAgentDisagreementLine(deriveSavedAgentState(this.savedAgentPresenceFacts(name, authorityNames)), reason);
    }
    return out;
  }

  /** The raw refusal reasons, with no disagreement state on them. The tool reports the two apart. */
  private refusedAgentReasons(): Record<string, string> {
    const sources = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: string; reason?: string }>;
    }) | undefined)?.agentSources;
    const out: Record<string, string> = {};
    for (const [name, source] of Object.entries(sources ?? {})) {
      if (source.mode === "refused" && source.reason) out[name] = source.reason;
    }
    return out;
  }

  /**
   * SDD 494 Part 4 — the sidebar row's existing `refused` string, now naming WHICH owners disagree.
   *
   * It gets no surface of its own. The row is already rendered for a refused agent and a human
   * already reads it, so the state rides the string that is already there. The measured refusal is
   * around 260 characters, which is why each prefix is one short sentence and names the two owners
   * rather than explaining the state.
   */
  private savedAgentDisagreementLine(state: SavedAgentState, reason: string): string {
    switch (state) {
      case "orphan-locator":
        return this.t("orphan-locator — the roster and the profile on disk disagree. {0}", reason);
      case "unattested":
        return this.t("unattested — the roster and the host authority disagree. {0}", reason);
      case "unprojectable":
        return this.t("unprojectable — the profile and the runtime configuration disagree. {0}", reason);
      case "unlisted-profile":
        return this.t("unlisted-profile — a profile is on disk and the roster does not list it. {0}", reason);
      case "stranded-authority":
        return this.t("stranded-authority — a host authority is left and the agent is gone. {0}", reason);
      // A refusal with no disagreement behind it keeps the string it always had. Adding a state name
      // here would tell the reader that owners disagree when the measurement says they do not.
      //
      // `orphan-home` joins them because it cannot be reached from here at all, not because it says
      // nothing: this method is only ever called for a name `refusedAgentReasons` yielded, i.e. one
      // whose `agentSources` mode is `refused`, which makes `rosterRow` true — and no arm below the
      // roster row can then be selected. `reconcile_roster` is where that state has a reader.
      case "consistent":
      case "absent":
      case "orphan-home":
        return reason;
    }
  }

  async inspectAgentProfileLifecycle(agentName: string): Promise<AgentProfileLifecycleSnapshot> {
    return inspectCanonicalAgentProfileLifecycle({
      workspaceRoot: this.workspaceRoot,
      agentName,
      authority: this.profileAuthorityPort(),
    });
  }

  async inspectAgentProfileStudio(agentName: string): Promise<AgentProfileStudioSnapshotV1> {
    return projectAgentProfileStudioSnapshot(await this.inspectAgentProfileLifecycle(agentName));
  }

  /**
   * t-afc86e — the Studio save, including the agent's worktree setup.
   *
   * The mutation holds those two as COMMAND TEXT; the profile holds them as pinned reference ids.
   * This is where the two meet: `workspaceCommandWriteFor` turns the text into bytes plus digests
   * plus reference entries, and they ride the SAME lifecycle transaction as the patch that names
   * them. Publishing them separately would leave a window where the profile pins a digest nothing on
   * disk satisfies — the fail-closed state the projection exists to refuse.
   */
  async commitAgentProfileStudio(mutation: AgentProfileStudioMutationV1): Promise<AgentProfileStudioSnapshotV1> {
    if (mutation.expectedRevision === undefined) {
      const write = workspaceCommandWriteFor(mutation.editable);
      // t-d48775 — the instructions document rides the same create transaction, for the same reason.
      const instructions = persistentInstructionsWriteFor(mutation.editable);
      const localReferences = [...write.localReferences, ...instructions.localReferences];
      const artifacts = [...write.artifacts, ...instructions.artifacts];
      const result = await this.commitAgentProfileLifecycle({
        agentName: mutation.agentName,
        operation: "create",
        createProfile: createProfileFromStudioMutation(mutation),
        // A new agent's id is minted inside the transaction, and a profile-local reference is owned
        // by it — so the entries go in without scope/owner and the transaction stamps both.
        ...(localReferences.length > 0 ? { createProfileLocalReferences: localReferences } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      return projectAgentProfileStudioSnapshot(result.snapshot);
    }
    const current = await this.inspectAgentProfileLifecycle(mutation.agentName);
    const write = workspaceCommandWriteFor(mutation.editable, current.profile.workspace);
    const instructions = persistentInstructionsWriteFor(mutation.editable, current.profile.prompt);
    const patch = patchProfileFromStudioMutation(mutation, current);
    const result = await this.commitAgentProfileLifecycle({
      agentName: mutation.agentName,
      operation: "edit",
      expectedRevision: mutation.expectedRevision,
      // `references` is rebuilt whole rather than appended to: clearing a field must REMOVE its
      // entry, or the profile would keep a pin nothing points at and fail its own `requireKind`.
      // The two writers CHAIN over one list — each merge that rebuilt from
      // `current.profile.references` would drop what the previous one just added.
      patch: {
        ...patch,
        // t-d48775 — the instructions writer chains for the same reason. `patch.prompt` already
        // carries (or has dropped) `prompt.instructions` — `patchProfileFromStudioMutation` resolves
        // that id, because it needs nothing host-owned.
        references: mergedPersistentInstructionsReferences(
          current.profile,
          instructions,
          mergedWorkspaceCommandReferences(current.profile, write),
        ),
      },
      ...(write.artifacts.length + instructions.artifacts.length > 0
        ? { artifacts: [...write.artifacts, ...instructions.artifacts] }
        : {}),
    });
    return projectAgentProfileStudioSnapshot(result.snapshot);
  }

  /**
   * SDD 482 phase 4 (`t-5e1113`) — create a Saved Agent AND record its owner in ONE canonical
   * transaction.
   *
   * Ratified 2026-07-29 after an audit found the two-transaction version indefensible: ownership is
   * parent-side (spec 352), so the edge lives in the PROPOSER's profile, and committing the two
   * separately left a window where the agent existed unowned. One txid, both locks, one journal,
   * one compensation — and both authority records carry `revision: lifecycle-<txid>`, which is the
   * ratified consequence of a single transaction having a single identity.
   *
   * The owner's subagent list is read HERE, under the transaction's own lock, rather than taken from
   * a caller's earlier snapshot: `set-subagents` is a whole-list write, and reading it outside the
   * lock is the race this design removes.
   */
  async commitSavedAgentCreation(input: {
    agentName: string;
    createProfile: Parameters<typeof commitCanonicalAgentProfileLifecycle>[0]["createProfile"];
    owner?: string;
  }): Promise<AgentProfileLifecycleCommitResult> {
    // t-d48775 — this door publishes a PROFILE and no documents, so a `prompt.instructions` arriving
    // through it would name a reference nothing satisfies. The schema catches that, but as a
    // reference-integrity error that says nothing about which door the caller wanted. Both callers
    // today (`agent-profile.saved-agent-create` and its v2) come from Saved Agent approval, whose
    // mutation deliberately carries no instructions — this refusal is for the third caller, which is
    // the one that always arrives after the plan stops being read.
    if (input.createProfile?.prompt?.instructions) {
      throw new Error(
        "persistent instructions cannot be published by the Saved Agent creation door: it commits a profile "
        + "and no profile-local documents. Create the agent here, then author them in Agent Studio, which "
        + "publishes the document in the same transaction as the binding.",
      );
    }
    await this.assertAgentStoppedForProfileMutation(input.agentName);
    if (!input.owner) {
      return this.runAgentProfileLifecycleCommit({
        agentName: input.agentName,
        operation: "create",
        createProfile: input.createProfile,
      });
    }
    const ownerSnapshot = await this.inspectAgentProfileLifecycle(input.owner);
    const subagents = [...new Set([...(ownerSnapshot.profile.ownership?.subagents ?? []), input.agentName])];
    // The same spec 352 gate a Studio edit passes, against a roster that already includes the agent
    // this transaction is about to create.
    assertOwnershipTargets(input.owner, [input.agentName], [
      ...this.agentOwnershipRoster().filter((entry) => entry.name !== input.agentName),
      { name: input.agentName, kind: "agent", subagents: [] },
    ]);
    return this.runAgentProfileLifecycleCommit({
      agentName: input.agentName,
      operation: "create",
      createProfile: input.createProfile,
      companion: { agentName: input.owner, ownership: { subagents } },
    });
  }

  /**
   * t-05dff5 — the one place a governed refusal stops being an exception and becomes an answer.
   *
   * Below this line every precondition throws, because every caller in the engine already treats a
   * lifecycle failure as an exception and none of them should have to learn a second control flow.
   * Above it lies the engine↔shell wire, which carries values and not classes: an `AgentProfileRefusal`
   * thrown past here arrives as an anonymous `Error` whose message the cockpit dare not trust, which
   * is precisely how "still owns a worktree; remove it explicitly" became "could not be completed".
   *
   * Only `AgentProfileRefusal` converts. Everything else keeps rising as an exception and is still
   * flattened at the panel, which is right: a stack, a path or an EIO is not a gesture anyone can
   * perform, and its raw text leaks host layout into the webview.
   */
  async commitAgentProfileStudioLifecycle(
    mutation: AgentProfileStudioLifecycleMutationV1,
  ): Promise<AgentProfileStudioLifecycleResultV1> {
    try {
      return await this.runAgentProfileStudioLifecycle(mutation);
    } catch (error) {
      if (!isAgentProfileRefusal(error)) throw error;
      return { schemaVersion: 1, kind: "refused", code: error.code, message: error.message };
    }
  }

  private async runAgentProfileStudioLifecycle(
    mutation: AgentProfileStudioLifecycleMutationV1,
  ): Promise<AgentProfileStudioLifecycleResultV1> {
    if (mutation.operation === "set-enabled") {
      const result = await this.commitAgentProfileLifecycle({
        agentName: mutation.agentName,
        operation: "set-enabled",
        expectedRevision: mutation.expectedRevision,
        enabled: mutation.enabled,
      });
      return { schemaVersion: 1, kind: "snapshot", snapshot: projectAgentProfileStudioSnapshot(result.snapshot) };
    }
    if (mutation.operation === "rename") {
      await this.renameAgent(mutation.agentName, mutation.newName, mutation.expectedRevision);
      return { schemaVersion: 1, kind: "snapshot", snapshot: await this.inspectAgentProfileStudio(mutation.newName) };
    }
    if (mutation.operation === "set-subagents") {
      const current = await this.inspectAgentProfileLifecycle(mutation.agentName);
      const patch = ownershipPatchFromStudioMutation(mutation, current, this.agentOwnershipRoster());
      // Ownership is the one canonical field with NO runtime lifecycle role (spec 352): it derives
      // `declaredOwner` for the roster/sidebar and never seeds spawn lineage, so the running owner's
      // session cannot diverge from it. Requiring a stop here would mean an agent could never declare
      // its own team while it works, which is the case t-4c113c exists to serve.
      const result = await this.runAgentProfileLifecycleCommit({
        agentName: mutation.agentName,
        operation: "edit",
        expectedRevision: mutation.expectedRevision,
        patch,
      });
      return { schemaVersion: 1, kind: "snapshot", snapshot: projectAgentProfileStudioSnapshot(result.snapshot) };
    }
    if (mutation.operation === "set-propose-saved-agent-grant") {
      const current = await this.inspectAgentProfileLifecycle(mutation.agentName);
      const patch = proposeSavedAgentGrantPatchFromStudioMutation(mutation, current);
      // No stopped-agent precondition, and that is required rather than convenient: every door reads
      // this grant from disk at the moment it is used (`readAgentProfileGrants` at admission, again at
      // commit), so a live session holds no cached copy that could diverge. Requiring a stop would
      // also make the intended flow impossible — a human grants the capability to a RUNNING
      // coordinator so it can then propose, which is exactly the dogfood this task exists for.
      const result = await this.runAgentProfileLifecycleCommit({
        agentName: mutation.agentName,
        operation: "edit",
        expectedRevision: mutation.expectedRevision,
        patch,
      });
      return { schemaVersion: 1, kind: "snapshot", snapshot: projectAgentProfileStudioSnapshot(result.snapshot) };
    }
    if (mutation.operation === "forget") {
      if (mutation.confirmation !== mutation.agentName) throw new Error("canonical profile forget confirmation mismatch");
      // t-e722ce — the CASCADE, not the bare canonical forget.
      //
      // This branch used to call `forgetAgentProfileAgent`, which refuses while the session ledger
      // still records a checkout. That made the door the product points people at the one door that
      // could not finish the job: the human was told to remove the worktree, the only surface that
      // could was a sidebar button reading a different source, and Control → Worktrees cleared the
      // registry without clearing the ledger — so the remedy left the refusal exactly where it was.
      // Running the whole cascade here is what makes Agent Studio a door and not a diagnosis.
      const result = await this.forgetAgentProfileAgentCascade(mutation.agentName, mutation.expectedRevision);
      return { schemaVersion: 1, kind: "forgotten", agentName: result.agentName, agentId: result.agentId };
    }
    // t-9464ac — this chain used to END on the forget body, reaching it by narrowing rather than by
    // saying so. TypeScript did already refuse an unrouted variant (adding one and omitting its branch
    // fails with "Property 'confirmation' does not exist on type …"), so the hole was never silent —
    // but the code READ as "assume forget", which is a different and worse thing for a reader deciding
    // whether that fall-through was deliberate.
    //
    // The `never` binding is the real guard: it makes exhaustiveness a COMPILE error at the point of
    // the omission instead of an incidental property error inside someone else's branch. The throw
    // below it is the runtime backstop for the untyped boundary — a mutation decoded from the webview
    // is validated by schema, but a future caller that skips that step gets a refusal naming the
    // unrouted operation rather than a misleading complaint about forget confirmation.
    const unrouted: never = mutation;
    throw new Error(
      `canonical profile studio mutation '${(unrouted as { operation?: string }).operation ?? "unknown"}' is not routed`,
    );
  }

  /**
   * t-4c113c — roster facts for declared-ownership validation and for the Agent Form's picker.
   *
   * Read from the LOADED config rather than from the canonical profile files: `agents.<n>.subagents`
   * is what the projection publishes and what `declaredOwner` (and therefore the sidebar) is built
   * from, so validating against anything else would let Studio accept a declaration the roster then
   * rejects. Terminals are kept, with their kind, because targeting one is its own named refusal.
   */
  agentOwnershipRoster(): AgentOwnershipRosterV1 {
    return Object.entries(this.config?.agents ?? {}).map(([name, entry]) => {
      const agent = asAgent(entry);
      return {
        name,
        kind: agent ? "agent" as const : "terminal" as const,
        subagents: [...(agent?.subagents ?? [])],
      };
    });
  }

  async agentOwnershipView(agentName: string): Promise<AgentOwnershipViewV1> {
    const agents: AgentOwnershipRosterV1 = Object.entries(agentsOf(this.config)).map(([name, entry]) => ({
      name,
      kind: "agent",
      subagents: [...(entry.subagents ?? [])],
    }));
    return agentOwnershipView(agentName, agents);
  }

  /**
   * t-283149 — what Tachyon actually handed this agent's runtime: hooks it injected, settings with the
   * layer each came from, MCP wiring, minted env and the launch argv.
   *
   * Read-only by construction. Editing lives in Agent Studio and Runtime Config; a panel that both
   * shows the delivered session and edits the declared profile would blur the very distinction this
   * exists to make visible.
   *
   * `/proc` reads are Linux-shaped and best-effort. When the process is gone — or unreadable because it
   * belongs to another user — the projection falls back to what the last launch left on disk and SAYS
   * so, rather than presenting stale files as a live session.
   */
  async inspectAgentSession(agentName: string): Promise<InspectedSession> {
    const runtime = adapterFor(asAgent(this.config?.agents[agentName])?.cmd ?? "")?.runtime
      ?? this.ledger.get(agentName)?.resume?.runtime
      ?? "unknown";
    return collectSessionInspection({
      workspaceRoot: this.workspaceRoot,
      agent: agentName,
      runtime,
      // t-141f61 — the same classification `projectedSessionHooks` spends at spawn. The panel is a
      // second door onto that decision, so it reads the policy from the same place rather than
      // inferring "protected" from a hook list that has no way to show a gate that never arrived.
      hookProjectionPolicy: this.config?.settings.agentHookProjection,
      ports: {
        panePid: async () => {
          try { return await this.tmux.panePid(this.manager.session(agentName)); }
          catch { return undefined; }
        },
        processArgv: (pid) => readProcFile(pid, "cmdline")?.split("\0").filter(Boolean),
        processEnv: (pid) => {
          const raw = readProcFile(pid, "environ");
          if (raw === undefined) return undefined;
          const env: Record<string, string> = {};
          for (const entry of raw.split("\0")) {
            const at = entry.indexOf("=");
            if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
          }
          return env;
        },
      },
    });
  }

  async commitAgentProfileLifecycle(
    input: Omit<CommitAgentProfileLifecycleInput, "workspaceRoot" | "authority" | "config" | "activateState">,
  ): Promise<AgentProfileLifecycleCommitResult> {
    await this.assertAgentStoppedForProfileMutation(input.agentName);
    return this.runAgentProfileLifecycleCommit(input);
  }

  /**
   * The transaction itself, without the stopped-agent precondition. Only a mutation that provably
   * cannot diverge from a live session may call this directly — today that is `set-subagents`
   * (see `commitAgentProfileStudioLifecycle`). Everything else goes through the public method.
   */
  private async runAgentProfileLifecycleCommit(
    input: Omit<CommitAgentProfileLifecycleInput, "workspaceRoot" | "authority" | "config" | "activateState">,
  ): Promise<AgentProfileLifecycleCommitResult> {
    const result = await commitCanonicalAgentProfileLifecycle({
      ...input,
      workspaceRoot: this.workspaceRoot,
      authority: this.profileAuthorityPort(),
      activateState: (state) => this.activateAgentProfileLifecycleState(input.agentName, state),
    });
    this.rebuildWatches();
    this.refreshAgentsViews();
    return result;
  }

  /**
   * t-5498a6 — CALLER B: authorize a skill for an agent that already exists.
   *
   * This is the one that unblocks the agents in this workspace. `claude`, `claude-validador` and
   * `codex` never went through a proposal, so the approval path (caller A) would never reach them and
   * they would stay at zero capabilities forever.
   *
   * Authorizing does not select. The Studio's tooling checkboxes are the second gesture, and keeping
   * them separate is the whole point: "may have" and "has" are different facts.
   *
   * ## t-746f0f — why this one may run while the agent runs
   *
   * The stopped-agent precondition reached this door by a RENAME, not by an argument: it was born as
   * `assertAgentStoppedForProfileMigration` for the legacy→canonical migration (t-1d1842), which
   * rewrites the agent's whole definition source, and became `…ForProfileMutation` on every lifecycle
   * commit when the legacy format was removed. Nobody ever decided that authorizing a capability
   * needs a stop, and the cost of the inherited rule was measured: to give a running coordinator one
   * skill, the human had to kill its session, click, and start a new one.
   *
   * Measured against the other guarded operations, this is a different class. Create, import and
   * clone publish or replace the WHOLE profile — executable, selectors, environment, prompt,
   * isolation, nativeConfig — and the live process's argv, env, config home and cwd were composed
   * from exactly those fields at launch; rename changes the key its session, ledger and authority are
   * filed under. A capability authorization writes three things and no others: the skill
   * `references`, the `capabilities.skills` selection, and the authority's `capabilityGrants`. Their
   * only consumer is the capability projection, delivered by `HarnessManager.replaceCapturedSkillTree`
   * and `writeProfileCapabilityManifest`, reached only from `AgentManager.materializeRuntimeHarness`
   * — spawn, restart, resume, fork. All four start a process or replace one. Nothing re-materializes
   * under a live session, so this write cannot reach the running agent at all.
   *
   * Which is exactly why the answer has to be SAID rather than assumed: `reachesAgentAtNextLaunch`
   * reports that the capability landed in the profile and will be delivered on the next launch. A
   * silent success would let a human believe their running agent just gained the skill.
   *
   * `revokeAgentSkill` deliberately does NOT get this exemption. "It is gone at the next launch"
   * describes a revocation that is not yet in force, and a human withdrawing a capability must not be
   * left holding that.
   */
  async authorizeAgentSkill(agentName: string, skillName: string, options: { reauthorize?: boolean } = {}) {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    const origin = skillOriginFor(this.workspaceRoot, skillName, snapshot.profile.runtime.adapter);
    if (!origin) {
      return { ok: false as const, error: `no skill named '${skillName}' is installed by a plugin or present in this workspace` };
    }
    const running = await this.agentIsRunning(agentName);
    const result = await this.asCapabilityRefusal(() => authorizeAgentSkill({
      workspaceRoot: this.workspaceRoot,
      agentName,
      origin,
      reauthorize: options.reauthorize,
      // t-5498a6 — one click. The AUTHORIZE/SELECT split carries weight when the two acts belong to
      // different actors or different moments: an agent asks, a human answers. Here it is the same
      // person, in the same form, seconds apart — the second click carries no information. The
      // protection was never the second click either; it is the validation that refuses a selection
      // without a matching grant, and clicking Authorize IS the host authorization.
      //
      // The checkbox keeps the role that IS load-bearing: turning a capability off without revoking,
      // which preserves the digest pin so re-enabling needs no fresh approval. Revoking and
      // re-authorizing would re-pin whatever the content is by then.
      select: true,
      ports: this.skillAuthorizationPorts(snapshot.revision, { allowRunningAgent: true }),
    }));
    return result.ok && running ? { ...result, reachesAgentAtNextLaunch: true as const } : result;
  }

  /**
   * t-746f0f — a governed refusal reaches this door's VALUE channel instead of being flattened above.
   *
   * `authorizeAgentSkill` already answers refusals as `{ ok: false, error }` — "this plugin does not
   * install for codex" — and the cockpit posts that text verbatim. A refusal thrown from inside the
   * canonical transaction had no way onto that channel, so it rose as an exception and met
   * `postAgentProfileError`, which says "The profile lifecycle action could not be completed." for
   * everything. Both refusals reachable here name a gesture the human can perform (start over from a
   * reloaded profile; stop the agent first), so both belong in the channel that already exists rather
   * than in a second one invented for them.
   *
   * Only `AgentProfileRefusal` converts. A broken transaction keeps rising and is still flattened at
   * the panel, which stays correct: a stack or an EIO is not a gesture, and its text leaks host paths.
   */
  private async asCapabilityRefusal<T extends { ok: boolean }>(run: () => Promise<T>): Promise<T | { ok: false; error: string }> {
    try {
      return await run();
    } catch (error) {
      if (!isAgentProfileRefusal(error)) throw error;
      return { ok: false, error: error.message };
    }
  }

  /**
   * t-5498a6 — what this agent's runtime could be given, in two lists.
   *
   * A QUERY rather than a field on the profile snapshot: that snapshot is revisioned and the Studio
   * uses the revision as a CAS token, but installing a plugin changes none of it. Candidates carried
   * there would go stale while still claiming to be current.
   */
  /**
   * t-5498a6 — what this agent could be given. t-4a2a6f — annotated with what it already holds.
   *
   * The annotation is the whole repair path for a plugin update: without it an already-authorized
   * plugin is indistinguishable in this list from one the agent never saw, so the human clicks
   * "Authorize", the core correctly refuses to accept changed content silently, and the screen
   * reports success while nothing moved.
   */
  async authorizableCapabilitiesFor(agentName: string) {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    return annotateAuthorized(
      listAuthorizableCapabilities(this.workspaceRoot, snapshot.profile.runtime.adapter),
      authorizedSkillStates(this.workspaceRoot, snapshot.profile.references ?? []),
    );
  }

  /**
   * t-5498a6 — authorize a whole plugin: everything it exposes for this agent's runtime.
   *
   * Ratified with the user. A plugin exposing something no capability grant can carry is refused
   * WHOLE rather than partially — half a plugin reported as success is the failure this ends.
   */
  async authorizeAgentPlugin(agentName: string, pluginName: string, options: { reauthorize?: boolean } = {}) {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    const running = await this.agentIsRunning(agentName);
    const result = await this.asCapabilityRefusal(() => authorizeAgentPlugin({
      workspaceRoot: this.workspaceRoot,
      agentName,
      pluginName,
      adapter: snapshot.profile.runtime.adapter,
      ...(options.reauthorize ? { reauthorize: true } : {}),
      select: true,
      // t-746f0f — same reasoning as the skill door, which is where it is written down.
      ports: this.skillAuthorizationPorts(snapshot.revision, { allowRunningAgent: true }),
    }));
    return result.ok && running ? { ...result, reachesAgentAtNextLaunch: true as const } : result;
  }

  /** t-5498a6 — withdraw an authorization, dropping the selection in the same transaction. */
  async revokeAgentSkill(agentName: string, referenceId: string) {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    return revokeAgentSkill({ agentName, referenceId, ports: this.skillAuthorizationPorts(snapshot.revision) });
  }

  /**
   * The ports both callers share. `expectedRevision` is carried in so the commit is a compare-and-set
   * against the profile the decision was computed from — without it, two concurrent authorizations
   * would each write a grant set that silently discarded the other's.
   *
   * t-746f0f — the CAS token ADVANCES across the commits of one gesture. `authorizeAgentPlugin` runs
   * one commit per skill through a single ports object, and every commit publishes a new revision, so
   * a token captured once and reused made the second skill of any plugin refuse with a revision
   * conflict against its own predecessor. Chaining keeps the protection pointed at the third party it
   * was built for — a concurrent writer still invalidates the token — while a plugin's own successive
   * skills no longer race themselves. (Latent in this workspace, where every installed plugin exposes
   * one skill per runtime; reachable the moment one exposes two.)
   *
   * `allowRunningAgent` is the caller's declaration that its mutation provably cannot diverge from a
   * live session — see `authorizeAgentSkill`. It is passed per call rather than assumed, because
   * `revokeAgentSkill` shares these ports and does NOT qualify.
   */
  private skillAuthorizationPorts(
    expectedRevision: string,
    options: { allowRunningAgent?: boolean } = {},
  ): SkillAuthorizationPorts {
    let cas = expectedRevision;
    return {
      read: async (agentName) => {
        const snapshot = await this.inspectAgentProfileLifecycle(agentName);
        const authority = await this.profileAuthorityPort().read(agentName);
        return { profile: snapshot.profile, grants: authority?.capabilityGrants ?? [] };
      },
      commit: async ({ agentName, references, capabilityGrants, selectedSkills }) => {
        const snapshot = await this.inspectAgentProfileLifecycle(agentName);
        const input = {
          agentName,
          operation: "edit" as const,
          expectedRevision: cas,
          patch: {
            references: [...references],
            ...(selectedSkills
              ? { capabilities: { ...(snapshot.profile.capabilities ?? {}), skills: [...selectedSkills] } }
              : {}),
          },
          capabilityGrants,
        };
        const result = options.allowRunningAgent
          ? await this.runAgentProfileLifecycleCommit(input)
          : await this.commitAgentProfileLifecycle(input);
        cas = result.revision;
      },
    };
  }

  /**
   * t-746f0f — the precondition now NAMES the sequence, and declares itself a refusal.
   *
   * It used to throw a bare `Error`, so `isAgentProfileRefusal` said no and every door above flattened
   * it to "The profile lifecycle action could not be completed." Measured live on 0.56.157: a human
   * clicked Reauthorize with the coordinator running, read a sentence indistinguishable from "nothing
   * happened", and diagnosed the wrong subsystem twice before the engine's own answer was found by
   * reading source. The condition was checked correctly on the first click; only its answer was lost.
   *
   * The message states all three gestures rather than the blocked one. "must be stopped" tells a
   * reader what failed; "stop it, apply this, start it again" tells them what to DO, and the middle
   * step is the one they cannot infer — that the change survives the restart is the whole reason the
   * detour is worth taking.
   */
  private async assertAgentStoppedForProfileMutation(agentName: string): Promise<void> {
    if ((await this.manager.runningAgents()).includes(agentName)) {
      throw new AgentProfileRefusal(
        "agent-profile/agent-running",
        `agent '${agentName}' is running, and this change alters what its session was launched from.`
        + ` Stop '${agentName}', apply the change, then start it again — the change is written to the`
        + " canonical profile and takes effect on that next launch.",
      );
    }
  }

  /** t-746f0f — whether a capability written now would reach this agent only at its next launch. */
  private async agentIsRunning(agentName: string): Promise<boolean> {
    return (await this.manager.runningAgents()).includes(agentName);
  }

  async exportAgentProfileBundle(agentName: string): Promise<PortableAgentProfileBytes> {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    return exportPortableAgentProfileBundle({ workspaceRoot: this.workspaceRoot, snapshot });
  }

  async exportAgentProfileStudioBundle(agentName: string, expectedRevision: string): Promise<PortableAgentProfileBytes> {
    const snapshot = await this.inspectAgentProfileLifecycle(agentName);
    if (snapshot.revision !== expectedRevision) throw new Error(`agent '${agentName}' profile revision conflict`);
    return exportPortableAgentProfileBundle({ workspaceRoot: this.workspaceRoot, snapshot });
  }

  async importAgentProfileBundle(agentName: string, bundle: string | Buffer): Promise<ImportPortableAgentProfileResult> {
    await this.assertAgentStoppedForProfileMutation(agentName);
    const result = await importPortableAgentProfileBundle({
      workspaceRoot: this.workspaceRoot,
      agentName,
      bundle,
      authority: this.profileAuthorityPort(),
      activateState: (state) => this.activateAgentProfileLifecycleState(agentName, state),
    });
    this.rebuildWatches();
    this.refreshAgentsViews();
    return result;
  }

  async cloneAgentProfileAgent(sourceAgentName: string, destinationAgentName: string): Promise<ImportPortableAgentProfileResult> {
    const source = await this.inspectAgentProfileLifecycle(sourceAgentName);
    await this.assertAgentStoppedForProfileMutation(destinationAgentName);
    const result = await clonePortableAgentProfile({
      workspaceRoot: this.workspaceRoot,
      source,
      destinationAgentName,
      authority: this.profileAuthorityPort(),
      activateState: (state) => this.activateAgentProfileLifecycleState(destinationAgentName, state),
    });
    this.rebuildWatches();
    this.refreshAgentsViews();
    return result;
  }

  async cloneAgentProfileStudioBundle(
    sourceAgentName: string,
    expectedRevision: string,
    destinationAgentName: string,
  ): Promise<ImportPortableAgentProfileResult> {
    const source = await this.inspectAgentProfileLifecycle(sourceAgentName);
    if (source.revision !== expectedRevision) throw new Error(`agent '${sourceAgentName}' profile revision conflict`);
    await this.assertAgentStoppedForProfileMutation(destinationAgentName);
    const result = await clonePortableAgentProfile({
      workspaceRoot: this.workspaceRoot,
      source,
      destinationAgentName,
      authority: this.profileAuthorityPort(),
      activateState: (state) => this.activateAgentProfileLifecycleState(destinationAgentName, state),
    });
    this.rebuildWatches();
    this.refreshAgentsViews();
    return result;
  }

  private activateAgentProfileLifecycleState(agentName: string, state: "target" | "prior" | "blocked"): void {
    if (state !== "blocked") {
      if (!this.reloadConfig()) {
        throw new Error(`trusted profile ${state} activation failed: ${this.configFailure?.errors.join("; ") ?? "unknown config failure"}`);
      }
      this.profileSpawnBlocked.delete(agentName);
      return;
    }
    this.profileSpawnBlocked.add(agentName);
    const definition = asAgent(this.config?.agents[agentName]);
    if (definition?.profileLifecycle) {
      definition.profileLifecycle = { ...definition.profileLifecycle, enabled: false };
    }
  }

  /** t-8354ae — last successful roster snapshot (null when never written / corrupt). */
  readConfigLkg(): ConfigLkgSnapshot | null {
    return readConfigLkg(this.workspaceRoot);
  }

  /**
   * t-8354ae — LKG is render-only. Refuse spawn when the working-tree config is invalid AND the
   * name is not known via live config or an in-memory Temporary def (i.e. it would only come from LKG).
   */
  assertNotLkgOnlySpawn(name: string): void {
    const lifecycleBlocked = agentProfileLifecycleBlocked(this.workspaceRoot, name);
    const renameBlocked = agentProfileRenameBlocked(this.workspaceRoot, name);
    const forgetBlocked = agentProfileForgetBlocked(this.workspaceRoot, name);
    if (lifecycleBlocked || renameBlocked || forgetBlocked) {
      throw new Error(
        `cannot spawn profile-backed agent '${name}' while its lifecycle transaction requires recovery`
        + ` (lifecycle=${lifecycleBlocked}, rename=${renameBlocked}, forget=${forgetBlocked})`,
      );
    }
    if (this.profileSpawnBlocked.has(name)) {
      const reason = this.refusedAgents()[name];
      throw new Error(
        `cannot spawn profile-backed agent '${name}' while its trusted configuration is invalid`
        + `${reason ? ` — ${reason}` : ""}; fix that profile field or authority and reload`,
      );
    }
    if (!this.configFailure) return;
    const inLive = !!this.config?.agents[name] || this.manager.defOf(name) !== undefined;
    const lkg = this.readConfigLkg();
    const inLkg = !!lkg?.agents.some((a) => a.name === name);
    if (isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrTemporary: inLive, nameInLkg: inLkg })) {
      throw new Error(lkgSpawnRefusalMessage(name, this.configFailure.file));
    }
  }

  private triggerLifecycle(): void {
    // Debounced: a burst of events (layout apply, Stop All) becomes one tick.
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    this.lifecycleTrigger = setTimeout(() => {
      void this.lifecycle.tick();
      void this.commandRunner.tick();
      void this.loginRunner.tick();
      this.refreshAgentsViews();
      this.deps.onViewsChanged("commands");
    }, 250);
  }

  /**
   * Process loss cannot prove delivery, so it never completes work. It only removes the stale claim
   * that says this agent is still executing it. TaskStore owns the serialized state+journal write;
   * this wrapper keeps lifecycle delivery best-effort without turning a board-write failure into an
   * unhandled heartbeat rejection.
   */
  private async returnTaskClaimsForUnavailableAgent(agent: string, evidence: string): Promise<void> {
    try {
      const returned = await this.taskStore.returnUnavailableAgentClaims(agent, { evidence, actor: "tachyon" });
      if (returned.length > 0) this.deps.onViewsChanged("tasks");
    } catch (err) {
      this.host.notify(
        this.t("could not release task claim(s) held by unavailable agent '{0}': {1}", agent, err instanceof Error ? err.message : String(err)),
        "error",
      );
    }
  }

  /**
   * Reload has no process-local before-snapshot, but it does have both durable sides of the claim:
   * known agent definitions in config/ledger and active task assignees. A strict tmux inventory is
   * supplied by the caller; unknown/human assignees are deliberately outside this reconciliation.
   */
  private async returnTaskClaimsMissingAtStartup(liveAgents: ReadonlySet<string>): Promise<void> {
    const unavailable = new Set(
      this.taskStore.listRaw()
        .filter((task) => {
          if (task.status !== "active" || !task.assignee || liveAgents.has(task.assignee)) return false;
          return this.manager.defOf(task.assignee)?.kind === "agent";
        })
        .map((task) => task.assignee!),
    );
    for (const agent of unavailable) {
      await this.returnTaskClaimsForUnavailableAgent(
        agent,
        `agent '${agent}' was not running when the workspace started`,
      );
    }
  }

  /**
   * Reload cannot recover the missing lifecycle edge: an absent durable child might have exited while
   * the host was down, or it might already have been stopped. It can still report the weaker fact it
   * proves. One durable acknowledgement per missing interval prevents every subsequent reload from
   * repeating the same inventory; observing the child live again clears that acknowledgement.
   */
  private reloadSummaryStateKey(): string {
    return `tachyon.reload-missing-summary.v1.${this.wsHash}`;
  }

  private reloadSummaryAcknowledged(): Set<string> {
    const stored = this.host.getState<unknown>(this.reloadSummaryStateKey());
    if (!Array.isArray(stored)) return new Set();
    return new Set(stored.filter((name): name is string => typeof name === "string"));
  }

  private writeReloadSummaryAcknowledged(names: ReadonlySet<string>): void {
    this.host.setState(this.reloadSummaryStateKey(), [...names].sort());
  }

  private acknowledgeReloadSummary(children: readonly string[]): void {
    const acknowledged = this.reloadSummaryAcknowledged();
    let changed = false;
    for (const child of children) {
      if (acknowledged.has(child)) continue;
      acknowledged.add(child);
      changed = true;
    }
    if (changed) this.writeReloadSummaryAcknowledged(acknowledged);
  }

  private clearReloadSummaryAcknowledgement(agent: string): void {
    const acknowledged = this.reloadSummaryAcknowledged();
    if (!acknowledged.delete(agent)) return;
    this.writeReloadSummaryAcknowledged(acknowledged);
  }

  private observeAgentLiveForReloadSummary(agent: string): void {
    this.clearReloadSummaryAcknowledgement(agent);
    // A parent may start after reload before its own parent does. Do not later report the now-live
    // agent from a summary that was correctly derived, but has become stale while waiting.
    for (const [parent, pending] of this.pendingReloadSummaries) {
      if (!pending.children.includes(agent)) continue;
      const children = pending.children.filter((child) => child !== agent);
      if (children.length === 0) this.pendingReloadSummaries.delete(parent);
      else this.pendingReloadSummaries.set(parent, { children, line: this.reloadSummaryLine(children) });
    }
  }

  private completeQueuedReloadSummary(agent: string, line: string): void {
    const queued = this.queuedReloadSummaries.get(agent);
    if (!queued || queued.line !== line) return;
    this.queuedReloadSummaries.delete(agent);
    this.acknowledgeReloadSummary(queued.children);
  }

  private reloadSummaryLine(children: readonly string[]): string {
    const named = children.slice(0, 4).map((child) => `'${child}'`).join(", ");
    const remainder = children.length > 4 ? `, and ${children.length - 4} more` : "";
    const subject = children.length === 1
      ? `child ${named} is`
      : `children ${named}${remainder} are`;
    const uncertainty = children.length === 1
      ? "it exited while the host was down or was already stopped"
      : "they exited while the host was down or were already stopped";
    return `[tachyon] after reload, ${subject} not running. `
      + `Tachyon could not observe whether ${uncertainty} — `
      + "inspect Activity/list_agents, dismiss, resume, or re-delegate";
  }

  /**
   * t-01a425 — after a non-ambiguous startup inventory, reconcile Temporary ledger zombies.
   *
   * Kill-parity rows (no worktree claim, not fork, not clean-exited, no tmux session at all) are
   * collected automatically: kill() already destroys that shape when a death is observed, and a crash
   * only skips that door. Worktree-owned / fork / clean-exited rows stay listed — they are the
   * legitimate Resume/postmortem surface — and the human gets one bulk dismiss action with the names
   * visible, rather than N one-by-one Removes.
   */
  private async reconcileStoppedTemporaryResidueAtStartup(
    presentSessions: ReadonlySet<string>,
  ): Promise<void> {
    const declaredNames = new Set(Object.keys(this.config?.agents ?? {}));
    const { autoCollect, humanReview } = partitionStoppedTemporaryResidue(this.ledger.all(), {
      declaredNames,
      presentSessions,
    });

    for (const row of autoCollect) {
      // A pending reload summary for an auto-collected parent can never be delivered: the Temporary
      // def is gone and cannot rehydrate. Drop it rather than holding a line for a name that will not return.
      this.pendingReloadSummaries.delete(row.name);
      this.queuedReloadSummaries.delete(row.name);
      this.manager.dismissTemporary(row.name);
    }
    if (autoCollect.length > 0) {
      this.refreshAgentsViews();
      this.host.notify(
        this.t(
          "collected {0} temporary agent(s) with no session and no worktree claim (same end-of-life kill would have taken): {1}",
          autoCollect.length,
          formatResidueNames(autoCollect.map((r) => r.name)),
        ),
      );
    }

    if (humanReview.length === 0) return;
    const names = humanReview.map((r) => r.name);
    const offered = [...names];
    this.host.notify(
      this.t(
        "{0} stopped temporary agent(s) remain listed with no tmux session: {1}. Resume keeps them; dismiss removes the ledger row and any claimed worktree.",
        offered.length,
        formatResidueNames(offered),
      ),
      "warn",
      [{
        label: this.t("Dismiss all {0}", offered.length),
        // Return the promise so a test (and any host that awaits actions) can wait for the cascade.
        run: () => this.dismissStoppedTemporaryResidue(offered),
      }],
    );
  }

  /**
   * Human bulk door for the residue notice above. Re-checks each name is still a Temporary ledger
   * zombie before acting so a concurrent Resume cannot be raced into a dismiss. Uses the same
   * worktree cascade as dismiss_agent / config.agent.delete.
   */
  private async dismissStoppedTemporaryResidue(names: readonly string[]): Promise<void> {
    const declaredNames = new Set(Object.keys(this.config?.agents ?? {}));
    const present = new Set((await this.manager.agentStates()).keys());
    const errors: string[] = [];
    let dismissed = 0;
    for (const name of names) {
      try {
        const rec = this.ledger.get(name);
        if (!rec?.def || declaredNames.has(name) || present.has(name) || !isTemporaryInstance(rec)) {
          continue;
        }
        if (rec.worktree) await removeAgentWorktree(this, name, true);
        this.manager.dismissTemporary(name);
        dismissed += 1;
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.refreshAgentsViews();
    if (errors.length > 0) {
      this.host.notify(
        this.t(
          "dismissed {0} stopped temporary agent(s); {1} error(s): {2}",
          dismissed,
          errors.length,
          errors.slice(0, 3).join("; "),
        ),
        "warn",
      );
      return;
    }
    if (dismissed > 0) {
      this.host.notify(this.t("dismissed {0} stopped temporary agent(s)", dismissed));
    }
  }

  private summarizeMissingChildrenAfterReload(liveAgents: ReadonlySet<string>): void {
    const acknowledged = this.reloadSummaryAcknowledged();
    let acknowledgementChanged = false;
    for (const live of liveAgents) {
      if (acknowledged.delete(live)) acknowledgementChanged = true;
    }

    const byParent = new Map<string, string[]>();
    for (const [child, record] of this.ledger.all()) {
      const parent = record.def?.parent;
      if (
        liveAgents.has(child)
        || acknowledged.has(child)
        || record.def?.kind !== "agent"
        || !parent
        || parent === child
      ) continue;
      const children = byParent.get(parent) ?? [];
      children.push(child);
      byParent.set(parent, children);
    }

    for (const [parent, unsorted] of byParent) {
      const children = [...unsorted].sort();
      const line = this.reloadSummaryLine(children);
      if (!liveAgents.has(parent)) {
        this.pendingReloadSummaries.set(parent, { children, line });
        continue;
      }
      // Startup has not necessarily taken its first attention sample yet. Queue unconditionally so a
      // survivor that is mid-turn is never interrupted by an unknown→assumed-idle read; the first
      // idle observation uses the ordinary NoticeQueue flush path.
      this.queuedReloadSummaries.set(parent, { children, line });
      this.enqueueNotice(parent, line);
    }
    if (acknowledgementChanged) this.writeReloadSummaryAcknowledged(acknowledged);
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
      // Also cover Temporary / ledger-only rows where cmd is empty but the private home exists.
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
      .then(async (stillThere) => {
        if (stillThere) return undefined; // false alarm — the child is actually still running
        const alive = await this.tmux.hasSession(parentSession);
        if (!alive) return undefined;
        const result = await this.deliverNotice(parent, line, this.sourceNoticeMetadata(agent, "host-poke"));
        if (result.status === "notified") {
          this.acknowledgeReloadSummary([agent]);
        }
        return result;
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
      .then((alive) => (alive ? this.deliverNotice(parent, `[tachyon] child '${agent}' is waiting for input: ${line}`, this.sourceNoticeMetadata(agent, "host-poke")) : undefined))
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
      .then((alive) => (alive ? this.deliverNotice(parent, `[tachyon] child '${agent}' is rate-limited${runtime}.${reset} ${line}`, this.sourceNoticeMetadata(agent, "host-poke")) : undefined))
      .catch(() => undefined);
  }

  /**
   * SDD 477 / t-5bfb72 — tell the coordinator, not just the human. A parent that cannot see this
   * keeps assigning and re-poking a child that will never run, which is the exact loop the spec set
   * out to stop. The notice names the runtime and the human action and carries no credential
   * material — `describeAuthRequired` echoes only the CLI's own notice line.
   */
  private pokeParentOnAuthRequired(agent: string, evidence: AuthRequiredEvidence): void {
    const parent = this.manager.parentOf(agent);
    if (!parent) return;
    const session = this.manager.session(parent);
    void this.tmux
      .hasSession(session)
      .then((alive) =>
        alive
          ? this.deliverNotice(
              parent,
              `[tachyon] child '${agent}' is held: ${describeAuthRequired(agent, evidence)}`,
              this.sourceNoticeMetadata(agent, "host-poke"),
            )
          : undefined,
      )
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
    // t-a53dd9 — this "continue" is a BARE ENTER, and a bare Enter into an occupied composer submits
    // whatever the human has half-written there. Same loss as the notice incident, reached through a
    // different door and by a different actor (Tachyon's own retry timer, not an agent). Skip the
    // press and re-arm on the backoff, so the retry chain survives the wait instead of dying in it —
    // a silently cancelled auto-continue would be this task's own false-positive failure mode.
    if (await this.humanDraftPresent(agent)) {
      const held = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempt, 4));
      this.scheduleRateLimitAutoContinue(agent, { ...before, rateLimit: { ...before.rateLimit, resetAt: Date.now() + held } }, attempt + 1);
      return;
    }

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
    // t-2656d7 — a login pane finishing is otherwise eventless: nothing else in the fleet moves when
    // a human finishes a device flow, so the offer of an explicit Retry would never be made.
    void this.loginRunner.tick();
    this.scheduler.tick(); // fires anything due (workspace-open scope)
    // t-a53dd9 — the notice queue's TTL is enforced on the heartbeat, not only when something else
    // happens to touch the queue. Every other sweep point rides an event (a new notice, an idle
    // edge); a notice held behind a draft the human never submits and never clears produces no
    // events at all, so its declared exit — expire and name the loss to the human (t-fb1453) —
    // depended on an event that by construction never comes. Waiting is allowed to be long; it is
    // not allowed to be unbounded and silent.
    this.noticeQueue.clearExpired();
    await this.monitor.tick();
    await this.temporaryBackstop.tick();
    await this.runtimeSlack.tick().catch(() => undefined);
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
    const entries = await this.manager.listAgents();
    const out: Array<{
      agent: string;
      delegator: string;
      deliveryId: string;
      worktreePath: string;
      baseSha: string;
      sinceIso: string;
    }> = [];
    for (const entry of entries) {
      if (!entry.delegator) continue;
      const rec = this.ledger.get(entry.name);
      const wtPath = rec?.worktree?.path ?? rec?.cwd;
      if (!wtPath) continue;
      const baseSha = rec?.worktree?.baseRef;
      if (!baseSha) continue;
      const deliveryId = `gated:${entry.name}`;
      const sinceIso = rec?.updatedAt ?? new Date(0).toISOString();
      out.push({
        agent: entry.name,
        delegator: entry.delegator,
        deliveryId,
        worktreePath: wtPath,
        baseSha,
        sinceIso,
      });
    }
    out.push(...this.listAssignedCompletionFacts(entries));
    return out;
  }

  /**
   * t-5e9bf8 — the SECOND fact source: a declared canonical agent with a coordinator and an active
   * assigned task. These agents carry no `delegator`, so `listGatedCompletionFacts` above never saw
   * them, and the reproduction in t-d2a4dc was a coordinator learning about a finished task only
   * through human inspection.
   *
   * Deliberately NOT a second queue: these facts join the same monitor, the same grace window, the
   * same candidate file and the same doorbell suppression. What differs is only the evidence rule
   * they declare — `verified-since` instead of `beyond-base`, because a persistent agent's worktree
   * sits past its spawn base permanently and `beyond-base` there would fire on ordinary idle.
   */
  private listAssignedCompletionFacts(agents: readonly ManagedEntryInfo[]): GatedCompletionFacts[] {
    let tasks: ReturnType<TaskStore["listRaw"]>;
    try {
      tasks = this.taskStore.listRaw();
    } catch {
      return []; // no board readable → no facts, never a guess
    }
    return assignedCompletionFacts({
      agents,
      declared: new Set(Object.keys(this.config?.agents ?? {})),
      tasks,
      locate: (agent, taskId) => {
        const rec = this.ledger.get(agent);
        const worktreePath = rec?.worktree?.path ?? rec?.cwd;
        return resolveAssignedCompletionWorktree({
          agent,
          taskId,
          managed: this.managedWorktrees.list({ kind: "change", status: "active" }),
          persistent: worktreePath ? { worktreePath, baseSha: rec?.worktree?.baseRef } : undefined,
        });
      },
    });
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
        // The schedule definition is durable; this pane write is only its wake-up. Keep the receipt
        // honest so a lost Enter is visible instead of reporting the scheduled work as submitted.
        const receipt = await this.tmux.sendSubmittedLine(this.manager.session(def.spawn), def.instructions, {
          composer: composerProfileFor(this.manager.defOf(def.spawn)?.cmd),
        });
        if (receipt.status === "submit-unconfirmed") {
          this.host.notify(this.t("schedule '{0}' instructions were typed but submission could not be confirmed", name), "warn");
        }
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
    if (scheduleProposalExpired(proposal)) {
      this.host.notify(this.t("that schedule proposal expired at {0}", proposal.expiresAt), "warn");
      return false;
    }
    // Revocation is retroactive: the same durable-authority grant gates creation and commit.
    if (readAgentProfileGrants(this.workspaceRoot, proposal.by)?.proposeSavedAgent !== true) {
      this.host.notify(this.t("'{0}' no longer holds grants.proposeSavedAgent", proposal.by), "warn");
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

  /**
   * t-f6aa7c — recovery from a crash, for both doors out of one: the `restart: on-crash` policy's
   * scheduled attempt and the human clicking Restart on the postmortem toast.
   *
   * An AGENT comes back on the SAME conversation; a TERMINAL comes back zeroed. The `stop: "force"`
   * half is unchanged and still right for both — the process is already dead, so there is no
   * graceful handshake left to run. Only the SESSION half branches, on the question spec 389 never
   * asked: does this thing have memory worth preserving? `bun run dev` has none. An agent two hours
   * into a task has all of it, and it did not choose to die.
   *
   * Spec 389 recorded crash as "force + new" under the heading *unchanged* — it was preserving the
   * pre-389 single path while it introduced the stop × session axes, and it listed auto-resume on
   * crash as an explicit NON-GOAL. So this does not overturn a decision spec 389 made; it answers
   * the question spec 389 deferred.
   *
   * Resuming must never become REFUSING. When there is nothing to resume — a first crash, a
   * transcript aged out, a runtime with no resume adapter — `restart` already falls back to a fresh
   * section on its own, and this says WHY out loud. The defect being fixed is a human discovering
   * the loss by watching the agent re-ask a question that was already answered; a fresh section that
   * announces its own reason is not that.
   */
  private async recoverFromCrash(agent: string): Promise<void> {
    const session: RestartSessionMode = this.manager.kindOf(agent) === "agent" ? "resume" : "new";
    try {
      const result = await this.manager.restart(agent, { stop: "force", session });
      if (session === "resume" && !result.resumed) {
        this.host.notify(
          this.t(
            "'{0}' crashed — restarted on a NEW session, its prior context is gone: {1}",
            agent,
            result.resumeUnavailable ?? this.t("no resumable session"),
          ),
          "warn",
        );
      }
    } catch (err) {
      // Reached by the human's toast click as well as the policy, so it does not claim "auto".
      this.host.notify(`crash restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
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
    for (const [name, def] of Object.entries(terminalsOf(this.config))) {
      // t-bd14d8 — `config.agents` is the UNIFIED map: agents and terminals both live in it and this
      // loop had no arm for the difference, so a watch reaching an agent by any route got the
      // terminal behaviour above — force-kill, new session, triggered by a file save. The strip now
      // happens at projection, but the guarantee belongs HERE too: this is the consumer that acts,
      // and it must not depend on every producer upstream having been fixed.
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
    let surviving = await this.tmux.listSessions(`${SESSION_PREFIX}-${this.wsHash}-`);

    // t-fab832 — the Agent Instance cut's activation gate, BEFORE anything reads or resumes state.
    //
    // Placed here on purpose: `rehydrateFromLedger` below is the first thing that would INTERPRET a
    // pre-cut row, and this build has no rules for one. Refusing before that point is what makes
    // "we do not reinterpret old state" true rather than aspirational.
    //
    // It never stops or deletes anything — it reports and names the governed action. `start()` returns
    // without activating, so a running fleet is left exactly as it was for the operator to end.
    //
    // t-613361 — that early return is NOT Bridge/engine teardown. The Bridge listener was started in
    // `_create` (and the engine process continues past this call); refusal only skips the fleet
    // interpretation half of THIS method. Bridge read/write, Control, and scheduler stay up. See
    // `legacyFleetGate.ts` "What a refusal does NOT shut down".
    //
    // t-ae221c — the same question, asked of the record that now answers it. "Backed by a canonical
    // profile" was a pointer in `tachyon.yml`; it is a readable `.tachyon/agents/<name>/agent.yml`.
    // An unreadable or absent directory yields an empty set — which makes every agent look inline
    // and refuses. That is the fail-closed direction on purpose: refusing on a roster we cannot read
    // beats activating and guessing.
    const canonicalRoster = new Set(scanAgentRosterDirectory(this.workspaceRoot).members);
    const evaluateLegacyFleet = async () => {
      const liveAgentNames = new Set((await this.manager.listAgents()).map((entry) => entry.name));
      return inspectLegacyFleet({
      wsHash: this.wsHash,
      ledger: [...this.ledger.all()].map(([name, row]) => [name, row] as const),
      rosterEntries: Object.keys(agentsOf(this.config)).map((name) => ({
        name,
        kind: "agent" as const,
        hasProfilePointer: canonicalRoster.has(name),
      })),
      liveSessions: await Promise.all(surviving.filter((session) => {
        const name = session.slice(`${SESSION_PREFIX}-${this.wsHash}-`.length);
        return liveAgentNames.has(name);
      }).map(async (session) => {
        const name = session.slice(`${SESSION_PREFIX}-${this.wsHash}-`.length);
        return {
          session,
          name,
          kind: "agent" as const,
          // Proof is read off the SESSION, not the ledger. An unreadable session yields undefined,
          // which the gate refuses — a failed read must never admit.
          attestation: await this.tmux.sessionEnvValue(session, POST_CUT_SESSION_ATTESTATION_ENV),
        };
      })),
      });
    };

    // t-1129e1 — give a SELF-CLEARING refusal a bounded chance to clear before reporting it.
    //
    // On every extension-host reload the previous build's agent processes are still alive for a moment
    // and then exit; the product recreates them attested. The gate ran once in that window, refused
    // truthfully, and nothing ever re-evaluated — so the operator got a red "cannot activate" card on
    // EVERY reload, describing a fact that had already stopped being true, asking them to stop a fleet
    // that had already stopped itself.
    //
    // Only `live-agent-session` offenders are waited on (`isTransientLegacyRefusal`): a ledger row or a
    // roster entry is persisted state that will be just as present later, so waiting would delay a
    // refusal the operator genuinely has to act on. The wait is bounded and the refusal still happens
    // if it does not clear — this changes WHEN we report, never WHETHER.
    let legacy = await evaluateLegacyFleet();
    for (let attempt = 0; attempt < LEGACY_FLEET_RECHECK_ATTEMPTS && isTransientLegacyRefusal(legacy); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, LEGACY_FLEET_RECHECK_INTERVAL_MS));
      surviving = await this.tmux.listSessions(`${SESSION_PREFIX}-${this.wsHash}-`);
      legacy = await evaluateLegacyFleet();
    }
    if (!legacy.ok) {
      this.host.notify(describeLegacyFleetRefusal(legacy), "error");
      return;
    }

    // Resume-on-activation (spec 209): classify ledger agents, auto-resume declared
    // autostart ones whose session is gone, stash the rest as a human-offered set.
    // The strict read is the authority for claim recovery: an ambiguous tmux failure must never be
    // interpreted as a machine-wide death. `agentStates()` keeps its last-known-good fallback for the
    // existing presentation/resume path below.
    const runningAtStartup = await this.manager.runningAgentsStrict();
    const states = await this.manager.agentStates();
    const liveSessions = new Set([...states].filter(([, s]) => !s.dead).map(([name]) => name));
    // t-572cef: a session that survived a reload never goes through onSpawned, so it would otherwise
    // have no agentIncarnations entry for the rest of this process's life — give every live agent a
    // current incarnation now so flushQueuedNotice's mismatch check has something to compare against.
    for (const name of liveSessions) {
      this.recordSpawnIncarnation(name);
    }
    // Spec 211: rebuild Temporary defs + lineage from the ledger BEFORE planning resume,
    // so a re-discovered Temporary instance is restartable and re-nests under its parent.
    // t-8354ae — also run when config is invalid so the sidebar can list ledger agents.
    await this.manager.rehydrateFromLedger();
    if (runningAtStartup !== null) {
      const liveAtStartup = new Set(runningAtStartup);
      // Present = any tmux session for the name (alive or dead pane). Strict running inventory
      // already proved the read was non-ambiguous; `states` is the same inventory after that success.
      const presentAtStartup = new Set(states.keys());
      await this.returnTaskClaimsMissingAtStartup(liveAtStartup);
      this.summarizeMissingChildrenAfterReload(liveAtStartup);
      // After the parent summary so auto-collected names still appear in that one honest line.
      await this.reconcileStoppedTemporaryResidueAtStartup(presentAtStartup);
    }

    // t-62f599 — reproject every registered worktree, BEFORE the configOk branch below returns early.
    // Withdrawing inherited config is a policy decision, and a policy that only reaches agents somebody
    // restarts is not in force. This is the one hook that runs on a plain reload of a live fleet.
    await this.managedWorktrees.reprojectRegisteredWorktrees();

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
    this.sweepWorktreeHygiene(); // t-e74631: change worktrees already landed, left behind by finished agents
    await this.rehydratePipelines(); // spec 230: restore pipeline runs so a reloaded run's surviving nodes can still complete
    const plan = planResume({ ledger: this.ledger.all(), declaredAutostart, liveSessions });
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
    // t-05097f — count what actually STARTED, not what we intended to start. The summary below used
    // `pending.length`, so it reported "3 started" whether three sessions were born or none were,
    // which is precisely how a gate run could claim success while emitting no `new-session` at all.
    let started = 0;
    const autostartFailures: string[] = [];
    // t-2656d7 — kept apart from `autostartFailures` on purpose. An agent refused for credentials
    // has already produced its own actioned notice (naming the runtime and carrying `Log in`) via
    // AgentManager's `onAuthRequired` port, and it is not "failed to start" in the sense the summary
    // below means: nothing is broken, a human has something to do. Folding it into that count is
    // exactly how the recovery instruction used to disappear on this path — worse than the owner's
    // case, because here the sentence was never even printed.
    const awaitingLogin: string[] = [];
    for (const agent of pending) {
      try {
        await this.manager.spawn(agent);
        started += 1;
      } catch (err) {
        // Benign race with resume/re-entry/rebind: session can be live before spawn runs.
        // Same swallow as autostartNewlyDeclared — do not toast "already running" as a failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (authRequiredOf(err)) {
          awaitingLogin.push(agent);
        } else if (!msg.includes("already running")) {
          autostartFailures.push(agent);
          this.host.notify(this.t("autostart of '{0}' failed: {1}", agent, msg), "error");
        }
      }
    }
    this.rebuildWatches();
    await this.restoreOpenTerminals();

    const parts: string[] = [];
    if (surviving.length > 0) parts.push(this.t("{0} re-discovered", surviving.length));
    if (resumed > 0) parts.push(this.t("{0} resumed with context", resumed));
    if (started > 0) parts.push(this.t("{0} started", started));
    // A failed autostart is stated in the same summary, so the shortfall is visible where the count
    // is read — the per-agent error above only reaches whoever is watching notifications live.
    if (autostartFailures.length > 0) {
      parts.push(this.t("{0} failed to start ({1})", autostartFailures.length, autostartFailures.join(", ")));
    }
    // t-2656d7 — named as its own outcome, with the recovery in the words rather than in a count.
    // The per-agent notice carries the button; this line only makes the shortfall readable where the
    // summary is read, and says what kind of shortfall it is.
    if (awaitingLogin.length > 0) {
      parts.push(this.t("{0} waiting for a runtime login ({1})", awaitingLogin.length, awaitingLogin.join(", ")));
    }
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
        // t-2656d7 — a credential refusal already reached the human as its own actioned notice
        // (runtime named, `Log in` attached) through AgentManager's `onAuthRequired` port. Repeating
        // it here as an action-less error would put the same sentence back in the status bar, where
        // it gets clipped — one condition, one presentation.
        if (!msg.includes("already running") && !authRequiredOf(err)) {
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
      if (err instanceof ResumeUnavailableError && mayRestartInstance(record)) {
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
          if (err instanceof ResumeUnavailableError && mayRestartInstance(item.record)) {
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
      // t-48dd8d — a DISCARD refuses the write too. Reading forgives a file a human already wrote;
      // writing bytes we have just been told are partly unreadable is the delayed detonation this
      // gate exists to stop, and it would be this surface writing them.
      const check = this.parseTrustedConfigText(text);
      const refusals = [...check.errors, ...check.discarded];
      if (refusals.length > 0) {
        throw new Error(`invalid tachyon.yml (not saved): ${refusals[0]}${refusals.length > 1 ? ` (+${refusals.length - 1} more)` : ""}`);
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
    const check = this.parseTrustedConfigText(yamlText);
    // t-48dd8d — errors AND discards refuse the save. The loader forgives what it READS so a typo
    // cannot take a workspace down; it does not follow that a caller may WRITE a file whose keys it
    // has just been told are unreadable. Advisory warnings (a deprecation, a retired key) still ride
    // along with a successful write, which is why they are a separate channel from `discarded`.
    const refusals = [...check.errors, ...check.discarded];
    if (refusals.length > 0) return { ok: false, errors: refusals, warnings: check.warnings };
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

  /**
   * SDD 490 Fatia A — **the** production door to `mutation: "bootstrap"`. Moment zero.
   *
   * ## What this method is NOT, and must never become
   *
   * It is not an `ExtensionCommandV1` action, not a `vscode.commands` id, and not a member of
   * `WorkspaceAgentStudioTarget`. Each of those is a door an agent can already reach:
   * `extension.invoke` carries actions over the control socket whose nonce only proves same-uid; the
   * shell's UI handler executes **any** command id the daemon names; and the studio target interface
   * is what `ClientWorkspaceStudioTarget` implements by putting calls on that socket. Adoption is
   * reachable only by in-process extension-host code acting on a human's gesture, and
   * `test/unit/agentFormationBootstrap.test.ts` fails if any of the three routes appears.
   *
   * The residue is named rather than papered over: code executing inside the extension host is
   * indistinguishable from the human. See `bootstrapTransaction.ts`.
   */
  async adoptFormationAuthority(agentName: string, expectedProfileSha256?: string): Promise<FormationAdoptionRecord> {
    const host = this.requireFormationAdoptionHost();
    const authority = this.agentProfileAuthorities.get(agentName);
    if (!authority) {
      throw new Error(`agent '${agentName}' has no host-custodied profile authority to adopt; refresh the profile first`);
    }
    const effectiveSha256 = this.effectiveProfileSha256Of(agentName);
    if (!effectiveSha256) {
      throw new Error(`agent '${agentName}' has no resolved effective profile digest; reload the workspace config and try again`);
    }
    return host.service.adopt({
      operationId: `formation-adopt.${randomBytes(16).toString("hex")}`,
      caller: this.formationHumanCaller(),
      workspaceId: this.wsHash,
      workspaceRoot: this.workspaceRoot,
      agentName,
      runtimeInspector: { ...authority.runtimeInspector },
      effectiveSha256,
      ...(expectedProfileSha256 === undefined ? {} : { expectedProfileSha256 }),
    });
  }

  /**
   * What Agent Studio needs so an unadopted agent reads as HONEST rather than broken: whether this
   * agent has authority, and — when it does not — whether adoption would work and what blocks it.
   * Read-only, and the same reachability rules apply as to the adoption door itself.
   */
  async inspectFormationAuthority(agentName: string): Promise<FormationAdoptionState> {
    const host = this.requireFormationAdoptionHost();
    return host.service.inspect({
      workspaceRoot: this.workspaceRoot,
      agentName,
      caller: this.formationHumanCaller(),
    });
  }

  /**
   * Resolve an adoption interrupted between its barrier and its receipt. Adoption writes no workspace
   * bytes, so "rolled-back" simply means generation 1 never landed and the agent stays unadopted.
   */
  async recoverFormationAdoption(agentId: string): Promise<"none" | "rolled-back" | "completed"> {
    const host = this.requireFormationAdoptionHost();
    return host.service.recover(agentId, this.formationHumanCaller());
  }

  /**
   * The principal recorded in the durable receipt. It names the editor host, not a verified person:
   * `kind: "human"` here asserts *which surface acted*, and this repository has no way to assert more
   * than that. Writing a person's name in would claim a witness that does not exist.
   */
  private formationHumanCaller(): { principal: string; kind: "human" } {
    return { principal: `editor.${this.wsHash}`, kind: "human" };
  }

  private requireFormationAdoptionHost(): FormationAdoptionHost {
    if (!this.formationAdoption) {
      throw new Error(
        "formation authority custody is unavailable in this window, so adoption is closed; "
        + "the machine-local host key could not be loaded and the spawn path has no formation port either",
      );
    }
    return this.formationAdoption;
  }

  private effectiveProfileSha256Of(agentName: string): string | undefined {
    const sources = (this.config as (TachyonConfig & {
      agentSources?: Record<string, { mode: string; effectiveSha256?: string }>;
    }) | undefined)?.agentSources;
    const source = sources?.[agentName];
    return source?.mode === "profile" ? source.effectiveSha256 : undefined;
  }

  /** Config-backed Studio submit pipeline — webview forms and the internal test seam. */
  studioSubmit = (submit: StudioSubmit): string[] | undefined => {
    const kind = submit.state.kind;
    const takenMap =
      kind === "command" ? this.config?.commands : kind === "runbook" ? this.config?.runbooks : kind === "schedule" ? this.config?.schedules : this.config?.agents;
    const issues = kind === "terminal"
      ? validateTerminalForm(submit.state, Object.keys(takenMap ?? {}), submit.editingName)
      : validateForm(submit.state, Object.keys(takenMap ?? {}), submit.editingName);
    const errors = blockingErrors(issues);
    if (errors.length > 0) return errors.map((e) => issueMessage(e, this.t));
    const entry = kind === "terminal" ? toTerminalEntry(submit.state) : toEntry(submit.state);
    if (kind === "terminal") {
      try {
        upsertTerminalDeclaration(this.workspaceRoot, submit.state.name, entry, submit.editingName);
        if (!this.reloadConfig()) throw new Error("terminal declaration did not reload");
        this.deps.onViewsChanged("agents");
      } catch (err) {
        return [err instanceof Error ? err.message : String(err)];
      }
      const autostarted = submit.editingName === undefined && !!this.config?.agents[submit.state.name]?.autostart;
      if (autostarted) {
        void this.manager.spawn(submit.state.name).then(() => this.refreshAgentsViews()).catch((err) => {
          this.host.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
        });
      }
      this.host.notify(autostarted
        ? this.t("'{0}' saved & started (autostart)", submit.state.name)
        : this.t("'{0}' saved — ▶ in the sidebar starts it", submit.state.name));
      return undefined;
    }
    const isScheduleOrCommandOrRunbook = kind === "command" || kind === "runbook" || kind === "schedule";
    const doUpsert = (text: string | undefined) =>
      kind === "command"
        ? upsertCommand(text, submit.state.name, entry, submit.editingName)
        : kind === "runbook"
          ? upsertRunbook(text, submit.state.name, entry as { steps: string[] }, submit.editingName)
          : upsertSchedule(text, submit.state.name, entry, submit.editingName !== undefined);
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
    const cfg = this.parseTrustedConfigText(candidate.text);
    if (cfg.errors.length > 0) return cfg.errors;
    const ok = this.mutateConfig(
      () => candidate,
      () => this.deps.onViewsChanged(kind === "schedule" ? "schedules" : isScheduleOrCommandOrRunbook ? "commands" : "agents"),
    );
    if (!ok) return [this.t("could not write tachyon.yml — see the notification")];
    if (kind === "schedule") this.scheduler.activate(); // anchor a freshly-created schedule
    this.host.notify(
      kind === "command"
        ? this.t("command '{0}' saved — ▶ in the sidebar (or run_command) runs it", submit.state.name)
        : kind === "runbook"
          ? this.t("runbook '{0}' saved — ▶ in the sidebar (or run_runbook) runs it", submit.state.name)
          : this.t("schedule '{0}' saved — it's now active", submit.state.name),
    );
    return undefined;
  };

  studioDeps(): StudioDeps {
    return {
      extensionUri: this.host.webviewRoot() as StudioDeps["extensionUri"],
      detectClis: detectInstalledClis,
      takenNames: () => Object.keys(this.config?.agents ?? {}),
      commandNames: () => Object.keys(this.config?.commands ?? {}),
      defaultCwd: this.workspaceRoot,
      suggestKindForCommand,
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
   * Live rename across every subsystem: the tmux session follows (attached
   * clients ride along), session-local memory rekeys (Temporary def, lineage,
   * resume ledger), the yml updates for declared agents, and an open editor
   * pane is reopened under the new name (terminal titles can't change in place).
   * Attention state self-heals on the next tick; watchers rebuild on reload.
   */
  async renameAgent(oldName: string, newName: string, expectedRevision?: string): Promise<void> {
    const profileLifecycle = asAgent(this.config?.agents[oldName])?.profileLifecycle;
    if (profileLifecycle) {
      const inspected = await this.inspectAgentProfileLifecycle(oldName);
      if (expectedRevision !== undefined && inspected.revision !== expectedRevision) {
        throw new AgentProfileRefusal("agent-profile/revision-conflict", `agent '${oldName}' profile revision conflict`);
      }
      const liveSnapshot = await this.manager.prepareAgentProfileRename(oldName, newName);
      const wasOpen = this.terminals.has(oldName);
      if (wasOpen) this.terminals.close(oldName);
      try {
        await commitAgentProfileRename({
        workspaceRoot: this.workspaceRoot,
        oldAgentName: oldName,
        newAgentName: newName,
        ownerAgentName: this.config?.declaredOwner?.[oldName],
        expectedRevision: inspected.revision,
        authority: this.profileAuthorityPort(),
          live: {
          prepare: async () => liveSnapshot,
          converge: (oldAgentName, newAgentName, snapshot) => this.manager.convergeAgentProfileRename(oldAgentName, newAgentName, snapshot),
        },
        activateState: () => {
          if (!this.reloadConfig()) throw new Error("trusted profile rename activation failed");
          this.profileSpawnBlocked.delete(oldName);
          this.profileSpawnBlocked.delete(newName);
        },
        });
      } catch (error) {
        if (wasOpen && !agentProfileRenameBlocked(this.workspaceRoot, oldName)
          && !agentProfileRenameBlocked(this.workspaceRoot, newName)) {
          this.terminals.open(oldName, this.manager.session(oldName));
        }
        throw error;
      }
      this.pendingContextRenewal.delete(newName);
      const renewal = this.pendingContextRenewal.get(oldName);
      if (renewal) {
        this.pendingContextRenewal.delete(oldName);
        this.pendingContextRenewal.set(newName, renewal);
      }
      this.agentIncarnations.delete(newName);
      const incarnation = this.agentIncarnations.get(oldName);
      if (incarnation !== undefined) {
        this.agentIncarnations.delete(oldName);
        this.agentIncarnations.set(newName, incarnation);
        this.agentIncarnationCounters.set(newName, Math.max(this.agentIncarnationCounters.get(newName) ?? 0, incarnation));
      }
      if (wasOpen) this.terminals.open(newName, this.manager.session(newName));
      this.rebuildWatches();
      this.refreshAgentsViews();
      return;
    }
    const wasOpen = this.terminals.has(oldName);
    if (wasOpen) this.terminals.close(oldName);
    await this.manager.rename(oldName, newName);
    const wasDeclared = this.config?.agents[oldName] !== undefined;
    if (wasDeclared) {
      let renamed = false;
      try {
        renameTerminalDeclaration(this.workspaceRoot, oldName, newName);
        renamed = this.reloadConfig();
      } catch {
        renamed = false;
      }
      if (!renamed) {
        // yml refused after the session moved — move it back so tree and config agree.
        await this.manager.rename(newName, oldName);
        if (wasOpen) this.terminals.open(oldName, this.manager.session(oldName));
        return; // rolled back — the flag correctly stays under oldName
      }
    }
    try {
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
      if (wasDeclared) {
        try {
          renameTerminalDeclaration(this.workspaceRoot, newName, oldName);
          if (!this.reloadConfig()) rollbackFailures.push(new Error("terminal declaration rollback was refused"));
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (wasOpen && managerRolledBack) {
        try {
          this.terminals.open(oldName, this.manager.session(oldName));
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length > 1) {
        throw new AggregateError(rollbackFailures, "canonical agent rename failed and rollback was incomplete");
      }
      throw error;
    }
    this.pendingContextRenewal.delete(newName);
    const renewal = this.pendingContextRenewal.get(oldName);
    if (renewal) {
      this.pendingContextRenewal.delete(oldName);
      this.pendingContextRenewal.set(newName, renewal);
    }
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

  cloneTerminalDeclaration(source: string, newName: string): boolean {
    if (this.config?.agents[newName] !== undefined) throw new Error(`agent '${newName}' already exists`);
    cloneTerminalDeclaration(this.workspaceRoot, source, newName);
    return this.reloadConfig();
  }

  deleteTerminalDeclaration(name: string): boolean {
    const file = path.join(this.workspaceRoot, ".tachyon", "terminals", `${name}.yml`);
    if (!fs.existsSync(file)) return this.mutateConfig((text) => deleteLegacyTerminalDeclaration(text ?? "", name));
    deleteTerminalDeclaration(this.workspaceRoot, name);
    return this.reloadConfig();
  }

  promoteTerminalDeclaration(name: string, cmd: string): boolean {
    upsertTerminalDeclaration(this.workspaceRoot, name, { cmd, kind: "terminal" });
    return this.reloadConfig();
  }

  openCommandPane(name: string): void {
    this.terminals.open(`cmd:${name}`, this.commandRunner.session(name), undefined, `$ ${name}`);
  }

  openRunbookStepPane(runbook: string, index: number): void {
    this.terminals.open(`rb:${runbook}:${index}`, this.runbookRunner.stepSession(runbook, index), undefined, `$ ${runbook}#${index + 1}`);
  }

  /**
   * t-2656d7 (SDD 495, first slice) — present a launch refused because the runtime is not logged in.
   *
   * Reached from `AgentManager`'s `onAuthRequired` port, which every launch door converges on, and
   * from the autostart loop below. It replaces nothing structural: the notice goes through the same
   * `host.notify(message, level, actions)` the mid-run auth hold has always used. The change is that
   * the launch boundary now supplies actions, and an actions array is what decides whether a notice
   * becomes a durable, pressable attention row or an 8-second status-bar flash.
   *
   * The refusal is NOT swallowed here — the caller still throws, and the start still fails. This
   * only makes the failure legible.
   */
  private presentAuthRequiredLaunch(agent: string, evidence: AuthRequiredEvidence): void {
    const notice = authRequiredLaunchNotice(
      agent,
      evidence,
      {
        // Returned, not fire-and-forget: `NotificationService.dispatch` and
        // `DaemonEngineHost.invokeNoticeAction` both await what a picked action returns, so a
        // swallowed promise would report the button as done while the work was still in flight.
        retry: () => this.retryAfterLogin(agent),
        ...(runtimeLoginCommand(evidence.runtime)
          ? { login: () => this.startRuntimeLogin(evidence.runtime, agent) }
          : {}),
      },
      (message, ...args) => this.t(message, ...args),
    );
    this.host.notify(notice.message, notice.level, notice.actions);
  }

  /**
   * t-2656d7 — run the runtime's own login in a governed editor-tab terminal (SDD 495 Q2).
   *
   * Interface-initiated only, and deliberately so (SDD 495 Q5, still open and NOT anticipated here):
   * this is reachable from a notice action a human pressed, and no Bridge tool creates one. A login
   * pane nobody is sitting at is a device code expiring unseen.
   *
   * Tachyon allocates the PTY and stops. It never writes to the pane, never captures it, and never
   * touches the credential the runtime writes.
   */
  private async startRuntimeLogin(runtime: string, agent: string): Promise<void> {
    const waiting = this.awaitingLogin.get(runtime) ?? new Set<string>();
    waiting.add(agent);
    this.awaitingLogin.set(runtime, waiting);
    try {
      // One live session per runtime: a second refused agent JOINS this login rather than racing a
      // competing device flow for the same account. `LoginRunner.run` answers `already-running`, and
      // the next line reveals the pane that already exists — which is the right move either way.
      await this.loginRunner.run(runtime as Parameters<LoginRunner["run"]>[0]);
      this.openLoginPane(runtime);
    } catch (error) {
      waiting.delete(agent);
      if (waiting.size === 0) this.awaitingLogin.delete(runtime);
      this.host.notify(
        this.t("could not open the {0} login pane: {1}", runtime, error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  }

  openLoginPane(runtime: string): void {
    this.terminals.open(
      `login:${runtime}`,
      this.loginRunner.session(runtime as Parameters<LoginRunner["session"]>[0]),
      undefined,
      this.t("Log in: {0}", runtime),
    );
  }

  /**
   * t-2656d7 — the EXPLICIT retry (SDD 495 Q3).
   *
   * The owner decided this against his own live case, which wanted the automatic start: Tachyon does
   * not start an agent because a login finished. A human presses this. Nothing else calls it.
   */
  private async retryAfterLogin(agent: string): Promise<void> {
    try {
      await this.manager.spawn(agent);
      this.refreshAgentsViews();
    } catch (error) {
      // A second refusal re-presents itself through `onAuthRequired`; anything else is reported
      // plainly rather than swallowed, so a retry never fails silently.
      if (authRequiredOf(error)) return;
      this.host.notify(
        this.t("retry of '{0}' failed: {1}", agent, error instanceof Error ? error.message : String(error)),
        "error",
      );
    }
  }

  /**
   * t-2656d7 — a login pane exited.
   *
   * The exit code is NOT a verdict: a cancelled Codex flow can exit non-zero while a previous
   * credential is still perfectly valid, and a zero exit proves only that the process ended. This
   * slice deliberately does not probe the runtime (SDD 495 Q1 — no pre-launch probe), so the notice
   * says what is actually known — the pane finished — and offers the human their explicit retry.
   */
  private onLoginPaneFinished(runtime: string): void {
    const waiting = [...(this.awaitingLogin.get(runtime) ?? [])].sort();
    this.awaitingLogin.delete(runtime);
    const notice = loginFinishedNotice(
      runtime,
      waiting,
      { retry: (agent) => this.retryAfterLogin(agent), openPane: () => this.openLoginPane(runtime) },
      (message, ...args) => this.t(message, ...args),
    );
    this.host.notify(notice.message, notice.level, notice.actions);
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

/**
 * t-283149 — a best-effort `/proc` read. Absent, unreadable or non-Linux all mean the same thing to the
 * caller: we could not observe the live process, so say so instead of inventing one.
 */
function readProcFile(pid: number, file: "cmdline" | "environ"): string | undefined {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, "utf8"); }
  catch { return undefined; }
}
