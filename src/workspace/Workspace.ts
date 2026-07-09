import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxService, workspaceHash, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { ControlModeClient } from "../tmux/ControlModeClient.js";
import { loadConfigFile, parseConfig, CONFIG_FILENAMES, inferKind, type TachyonConfig } from "../config/loadConfig.js";
import { upsertAgent, upsertCommand, upsertRunbook, upsertSchedule, deleteSchedule, renameAgent as renameAgentInYml } from "../config/YamlConfigEditor.js";
import { AgentManager, ResumeUnavailableError, WatchController, newlyDeclaredAutostart } from "../agents/AgentManager.js";
import { SessionLedger } from "../resume/SessionLedger.js";
import { WorktreeManager, resolveWorktreeCwd, branchFor, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { PipelineManager, type PipelineDeps } from "../pipeline/PipelineManager.js";
import { RunLedger } from "../pipeline/RunLedger.js";
import { loadPipeline, nodeSpawnName } from "../pipeline/loadPipeline.js";
import { assembleNodePrompt } from "../pipeline/nodePrompt.js";
import { initRun, runStatus, type PipelineRun } from "../pipeline/runState.js";
import { randomBytes } from "node:crypto";
import { isWorktreeDirty } from "../worktree/pr.js";
import { HarnessManager, defaultRealOpencodeDataHome, realConfigHome } from "../harness/HarnessManager.js";
import { expectedAgentClaudeEntry, expectedAgentOpencodeEntry } from "../registration/adapters.js";
import { adapterFor, binaryOf, harnessable, managesOwnSession } from "../resume/adapters.js";
import { nodeCanSignal, nodeRuntimeOf } from "../pipeline/preflight.js";
import os from "node:os";
import { effectiveVerify, verifySteps, verifyStale, verifyBadge, worktreeUnchanged, suggestVerify, type VerifyState, type VerifyBadge } from "../worktree/verify.js";
import { EVIDENCE_SCHEMA_VERSION, VERIFY_PRODUCER, STEP_RESULT_KIND, summarizeEvidence, viewEvidence, isSafeArtifactRef, type WorktreeEvidence, type Severity, type EvidenceSummary, type EvidenceView } from "../worktree/evidence.js";
import { copyEvidenceArtifacts } from "../worktree/evidenceArtifacts.js";
import type { AttachEvidenceInput } from "../bridge/tools.js";
import { detectStack, type DetectedProject } from "../init/initLogic.js";
import { resolveCaptureId, resolveCaptureSession, resolveCurrentSession } from "../resume/resolvers.js";
import { planResume, autoResumes, offers, type ResumePlanItem } from "../resume/planResume.js";
import { LifecycleMonitor } from "../agents/LifecycleMonitor.js";
import { AttentionMonitor, type AgentAttention } from "../attention/AttentionMonitor.js";
import { AdhocBackstopMonitor } from "./AdhocBackstopMonitor.js";
import { roleReminder, buildRoleDoc } from "../roles/templates.js";
import { resolveClipboardHelperAsync } from "../tmux/clipboard.js";
import { compileExtraPatterns } from "../attention/patterns.js";
import { subtreeCpuTicks } from "../attention/cpu.js";
import { Waiters } from "../bridge/Waiters.js";
import { NoticeQueue, type NoticeQueueMetadata } from "../bridge/NoticeQueue.js";
import { Bridge, derivePort } from "../bridge/Bridge.js";
import {
  BridgeClientRebindCoordinator,
  DEFAULT_BRIDGE_CLIENT_REBIND,
  parseBridgeClientRebindSettings,
  reloadInitiatorStateKey,
  type BridgeClientRebindSettings,
} from "../bridge/clientRebind.js";
import { delegationRecordFromSpawn, readLatestDelegationRecord, writeDelegationRecordAsync } from "../bridge/delegationRecord.js";
import { writeAndCommitCanonicalBehaviorStub } from "../bridge/behaviorStub.js";
import { renderPrimer } from "../bridge/primer.js";
import { loadOrCreateExternalToken, loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR, AGENT_TOKEN_ENV_VAR } from "../bridge/token.js";
import { CallerIdentityRegistry, loadOrCreateHmacKey, type CallerScope, type CallerSnapshot, type PersistableEntry } from "../bridge/callerIdentity.js";
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
import { agentLogId } from "../activity/logStore.js";
import { compactSessionOwnerRows, compactSpawnSettings, latestOwnerFor, persistenceHookFailureFile, readPersistenceHookFailures, readSessionOwners, sessionOwnersFile } from "../activity/sessionOwners.js";
import { forgetAgent as forgetAgentFootprint } from "../agents/forgetAgent.js";
import { Terminals } from "../presentation/Terminals.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { validateForm, blockingErrors, toEntry } from "../webview/formLogic.js";
import type { StudioSubmit, StudioDeps } from "../webview/studioSubmit.js";
import type { EngineHost, HostDisposable, ViewKind } from "./EngineHost.js";
import type { NoticeDeliveryResult, NotifyLevel } from "../bridge/tools.js";
import { resolveOpencodeStorageSession } from "./opencodeStorage.js";

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

export interface WorkspaceDeps {
  /** spec 233 — the host port the engine calls instead of `vscode` (the VS Code shell passes a VsCodeHost). */
  host: EngineHost;
  /** refresh the (global) sidebar providers + the attention badge */
  onViewsChanged: (view: ViewKind) => void;
  /** host-side UI affordance for newly recorded human-approval requests. */
  onApprovalRequested?: (ws: Workspace, request: { id: string; requester: string }) => void;
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
}

const NOOP_ENGINE: WorkspaceEngine = { start: async () => {}, dispose: () => {} };
const TASK_FILE_REFRESH_DEBOUNCE_MS = 75;

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
    case "harness-claude-only":
      return t("isolated harness: supported for Claude/Codex agents only");
    case "codex-harness-mcp-only":
      return t("isolated harness: Codex does not support rules; use instruction files instead");
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
  readonly wsHash: string;
  readonly tmux: TmuxService;
  readonly terminals: Terminals;
  readonly manager: AgentManager;
  readonly ledger: SessionLedger;
  readonly worktrees: WorktreeManager;
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
  private readonly adhocBackstop: AdhocBackstopMonitor;
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
  readonly validationStore: ValidationStore;
  readonly continuityStore: ContinuityStore;
  readonly handoffStore: ProjectHandoffStore;
  readonly continuityState: ContinuityState;
  readonly commandRunner: CommandRunner;
  readonly runbookRunner: RunbookRunner;
  readonly scheduler: Scheduler;
  readonly proposals: ProposalStore;
  readonly bridge: Bridge;
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
  private readonly reloadTransactions: ReloadTransactionStore;
  private readonly hostActionAuditPath: string;
  private readonly hostActionSessionEpoch: number;
  /** spec 364 — host-driven Bridge-client rebind after generation bump (constructed after AgentManager). */
  private clientRebind: BridgeClientRebindCoordinator | undefined;
  private readonly bridgeClientRebindAuditPath: string;
  config: TachyonConfig | undefined;

  private readonly engine: WorkspaceEngine;
  private watches: WatchController;
  private readonly disposables: HostDisposable[] = [];
  private lifecycleTrigger: NodeJS.Timeout | undefined;
  private taskFileRefreshTimer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private engineWarned = false;
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
    this.terminals = new Terminals(
      (_agent, session) => void this.tmux.refreshClients(session),
      (agent) => this.manager.kindOf(agent),
      {
        read: () => deps.host.getState(this.terminalManifestStateKey()),
        write: (entries) => deps.host.setState(this.terminalManifestStateKey(), entries),
      },
    );

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

    this.ledger = new SessionLedger(workspaceRoot);
    this.worktrees = new WorktreeManager({
      workspaceRoot,
      wsHash: this.wsHash,
      getSettings: () => this.config?.settings ?? {},
    });
    this.harness = new HarnessManager(workspaceRoot, realConfigHome(), undefined, undefined, undefined, (message) => this.host.notify(message, "warn"));
    // spec 226 (H2) — when an agent has an isolated harness, its claude transcripts live under the
    // redirected config home; pass it to the resolvers as `claudeHome` so by-title/by-cwd scans hit it.
    const resolverEnv = (runtime: string, configHome?: string) =>
      configHome ? {
        home: os.homedir(),
        ...(runtime === "codex" ? { codexHome: configHome } : {}),
        ...(runtime !== "codex" ? { claudeHome: configHome } : {}),
      } : undefined;
    const resolveOpencode = (cwd: string, dataHome?: string, id?: string) => resolveOpencodeStorageSession(cwd, dataHome ?? defaultRealOpencodeDataHome(), id);
    this.manager = new AgentManager({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      ledger: this.ledger,
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
      // auth.json symlink) and return its path (injected into the spawn env as GROK_HOME). undefined
      // when the Bridge isn't up (self-heals on next restart). Never mutates the user's real ~/.grok.
      materializeBridgeMcpGrok: (name) => {
        const entry = this.bridgeEntry();
        return entry ? this.harness.materializeBridgeMcpGrok(name, entry) : undefined;
      },
      // spec 243 — per-spawn --settings SessionStart ownership hook (claude); the resolver reads the ledger
      // it writes so Activity follows a /clear/resume rotation even on a shared cwd.
      materializeOwnershipSettings: (name, opts) => this.harness.materializeOwnershipSettings(
        name,
        opts?.ownershipOnly ? undefined : this.handoffStore.canonicalPath,
        {
          silentPersistence: !opts?.ownershipOnly && this.silentPersistenceHooksDesired(name),
          skipDangerousModePermissionPrompt: !!opts?.ownershipOnly,
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

      getConfig: () => this.config,
      getMaxAgents: () => this.host.getSetting("tachyon", "maxAgents", 8),
      getExtraEnv: () => {
        // Every Tachyon-spawned session can reach (and authenticate to) ITS folder's Bridge.
        const env: Record<string, string> = {};
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
        this.noticeQueue.clear(name);
        this.adhocBackstop.reset(name);
        deps.onViewsChanged("agents");
      },
      onStopping: () => deps.onViewsChanged("agents"),
      onKilled: (name) => {
        this.terminals.close(name);
        this.pendingAnchor.delete(name); // spec 216: don't carry a re-anchor flag past the session
        this.agentIncarnations.delete(name);
        this.noticeQueue.clear(name);
        this.adhocBackstop.reset(name);
        this.expectedDeath.add(name); // spec 332 (dueto F3): kill_agent/dismiss_agent/killAll — a deliberate
        // termination, never a completion signal; consumed by the next observed death edge.
        // spec 364 — user stop while suspect/queued cancels rebind (never resume).
        this.clientRebind?.onAgentStopped(name);
        // spec 230 — a pipeline node's session ended → tell the executor (a signal node that dies
        // without complete_node fails closed; the per-node timeout is the backstop for a silent hang).
        const node = this.pipelineNodeOf.get(name);
        if (node) this.pipelines.onSessionEnd(node.runId, node.nodeId);
        deps.onViewsChanged("agents");
      },
      // Restart kill+new fallback only (t-4d2630): close the old terminal now (sync) so
      // post-spawn onSpawned re-opens a fresh attach. Happy-path respawn-pane keeps clients
      // attached — AgentManager skips onRestart then; onSpawned still reveals the live tab.
      onRestart: (name) => {
        this.terminals.close(name);
        this.adhocBackstop.reset(name);
      },
      // spec 210 — worktree isolation: resolve the cwd a session is born in.
      // spec 230 — a pipeline node spawns into its RUN's worktree (registered just before spawnNode);
      // this overrides the per-agent worktree path so the chain shares one checkout.
      resolveSpawnCwd: async (ctx) => {
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
        if (!ctx.gate || !resolved?.worktree) return resolved;
        const { stubPath } = await writeAndCommitCanonicalBehaviorStub({
          worktreePath: resolved.cwd,
          agent: ctx.name,
          behaviorTest: ctx.gate.behaviorTest,
        });
        ctx.gate.owns = ctx.gate.owns?.includes(stubPath) ? ctx.gate.owns : [...(ctx.gate.owns ?? []), stubPath];
        ctx.gate.stubPath = stubPath;
        const { headRef } = await this.worktrees.headState(resolved.cwd);
        if (!headRef) throw new Error(`gated delegation '${ctx.name}' could not resolve the task worktree HEAD`);
        return { ...resolved, delegationBaseSha: headRef };
      },
      recordDelegation: async ({ name, delegator, gate, contract, worktree, baseSha }) => {
        await writeDelegationRecordAsync(
          this.workspaceRoot,
          delegationRecordFromSpawn({
            agent: name,
            delegator,
            baseSha,
            taskRef: worktree.branch,
            gate,
            stubPath: gate.stubPath,
            contract,
          }),
        );
      },
      // spec 225 — fork: probe the source worktree for the dirty warning, and create the fork's own
      // worktree branched off the source's committed HEAD (its branch).
      worktreeDirty: (rec) => isWorktreeDirty(rec.path),
      createForkWorktree: async (forkName, source) => {
        try {
          const forkBranch = branchFor(forkName, this.config?.settings ?? {}, {});
          const rec = await this.worktrees.createFork(forkName, forkBranch, source.branch);
          return { cwd: rec.path, worktree: rec };
        } catch (err) {
          this.host.notify(`couldn't create fork worktree for '${forkName}': ${err instanceof Error ? err.message : String(err)}`, "warn");
          return null;
        }
      },
      removeForkWorktree: async (rec) => {
        await this.worktrees.remove(rec, true); // rollback a half-built fork — Tachyon-created branch, safe to drop
      },
      removeHarnessHome: (name) => this.harness.remove(name),
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
        // t-4ecf9a — push activity timestamps from control-mode; null when engine down → full capture poll.
        windowActivity: (agent) => {
          if (!this.activityFeedLive) return null;
          const ts = this.activityBySession.get(this.manager.session(agent));
          return ts !== undefined ? ts : null;
        },
        now: () => Date.now(),
      },
      (agent, attention, shouldToast) => {
        this.waiters.notifyAttention(agent, attention.state);
        deps.onViewsChanged("agents");
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
        this.pendingAnchor.add(agent);
        if (this.manager.kindOf(agent) === "agent") this.continuityState.markDiscontinuity(agent, this.currentActivitySeq(agent));
      },
    );

    this.adhocBackstop = new AdhocBackstopMonitor({
      listEntries: () => this.manager.list(),
      attentionOf: (agent) => this.monitor.stateOf(agent),
      now: () => Date.now(),
      deliverNotice: (parent, line, metadata) => this.deliverNotice(parent, line, metadata),
      sourceNoticeMetadata: (agent) => this.sourceNoticeMetadata(agent),
    });

    this.lifecycle = new LifecycleMonitor(
      {
        agentStates: () => this.manager.agentStates(),
        policyOf: (agent) => this.config?.agents[agent]?.restart ?? "never",
        scheduleRestart: (agent, delayMs) => {
          setTimeout(() => {
            this.manager.restart(agent).catch((err) => {
              this.host.notify(`auto-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            });
          }, delayMs);
        },
        now: () => Date.now(),
      },
      {
        onCrash: (agent, exitCode, willRestart, delayMs) => {
          this.waiters.notifyDead(agent, exitCode);
          this.noticeQueue.clear(agent);
          this.pokeParentOnDeath(agent, exitCode !== undefined ? String(exitCode) : "killed");
          // spec 230 — a pipeline node's process died: feed the exit to the executor (an exit-based node
          // fails on the non-zero code; a signal-based node fails closed). No crash popup — the run shows it.
          const plNode = this.pipelineNodeOf.get(agent);
          if (plNode) {
            this.pipelines.onProcessExit(plNode.runId, plNode.nodeId, exitCode ?? 1);
            return;
          }
          deps.onViewsChanged("agents");
          const code = exitCode !== undefined ? this.t(" (exit {0})", exitCode) : "";
          if (willRestart) {
            this.host.notify(this.t("'{0}' crashed{1} — restarting in {2}s", agent, code, Math.round((delayMs ?? 0) / 1000)), "warn");
          } else {
            this.host.notify(this.t("'{0}' crashed{1} — dead pane kept for postmortem", agent, code), "error", [
              { label: this.t("Inspect"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
              { label: this.t("Restart"), run: () => void this.manager.restart(agent).catch((err) => this.host.notify(String(err instanceof Error ? err.message : err), "error")) },
            ]);
          }
        },
        onCleanExit: (agent) => {
          this.waiters.notifyDead(agent, 0);
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
            .finally(() => deps.onViewsChanged("agents"));
          this.host.notify(this.t("'{0}' exited cleanly", agent));
        },
        onGone: (agent) => {
          this.waiters.notifyGone(agent);
          this.noticeQueue.clear(agent);
          this.pokeParentOnDeath(agent, "killed", true);
        },
        onGiveUp: (agent, attempts) => {
          deps.onViewsChanged("agents");
          this.host.notify(this.t("'{0}' crash-looped ({1} restarts in 1 min) — giving up. Fix it and restart manually.", agent, attempts), "error", [
            { label: this.t("Inspect"), run: () => void this.terminals.open(agent, this.manager.session(agent)) },
          ]);
        },
      },
    );

    this.pinStore = new PinStore(workspaceRoot);
    this.taskStore = new TaskStore(workspaceRoot);
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

    this.bridge = new Bridge(
      {
        workspaceRoot: this.workspaceRoot,
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
          deps.onViewsChanged("agents");
        },
        // spec 245 — shared per-project handoff (distinct from per-agent continuity above).
        handoff: this.handoffStore,
        lastActivityAt: () => this.lastActivityAt(),
        onHandoffChanged: () => deps.onViewsChanged("handoff"),
        notify: (m, l) => this.host.notify(m, l),
        // spec 257 — the captured headless A2A probe lane.
        probe: this.probeService,
        probeCwd: () => this.workspaceRoot,
        attentionOf: (agent) => this.monitor.stateOf(agent)?.state,
        deliverNotice: (target, line) => this.deliverNotice(target, line),
        onPinsChanged: () => deps.onViewsChanged("pins"),
        onApprovalRequested: (request) => deps.onApprovalRequested?.(this, request),
        onTasksChanged: () => deps.onViewsChanged("tasks"),
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
        // spec 273 — the worktree evidence channel over MCP.
        attachEvidence: (input) => this.attachEvidence(input),
        listEvidence: (agent) => this.listEvidence(agent),
        // spec 216 — manual re-anchor over MCP (always available; the auto path is opt-in).
        reanchor: async (agent) => this.reanchor(agent),
        // spec 230 — a pipeline node signals completion (per-node nonce auth).
        completeNode: (input) => this.pipelines.completeSignal(input),
        // spec 359 — host actions are authorized with the per-request Bridge caller snapshot.
        runHostAction: (input) => this.runHostAction(input),
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
        getRegistry: () => this.callerRegistry,
        scope: this.callerScope(),
        legacyCompatEnabled: this.legacyBridgeAuthEnabled,
        onLegacyCall: (info) => this.logLegacyBridgeCall(info),
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
      stopGracefully: (name) => this.manager.stopGracefully(name),
      hardKillSession: async (name) => {
        // Kill the tmux session only — do NOT call AgentManager.kill (that wipes ad-hoc ledger rows).
        const session = this.manager.session(name);
        await this.tmux.killSession(session);
      },
      resume: (name, record) => this.manager.resume(name, record),
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

  private async runHostAction(input: {
    readonly action: string;
    readonly args?: unknown;
    readonly timeoutMs?: number;
    readonly caller: CallerSnapshot;
  }) {
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
    return broker.run({ action: hostActionName(input.action), args: input.args, timeoutMs: input.timeoutMs });
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
        const { record } = await this.worktrees.ensure({ agent, branch });
        this.pipelineRunWt.set(agent, record);
        return { cwd: record.path, key: agent };
      },
      releaseWorktree: async (key) => {
        const rec = this.pipelineRunWt.get(key);
        if (rec) await this.worktrees.remove(rec, true); // Tachyon-created run branch — safe to drop
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
            await this.manager.spawn(def.agent, { env, pipeline: { runId, nodeId }, reveal: false, appendInstructions: taskInstr });
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
          await this.manager.spawn(name, { cmd: def.cmd, env, pipeline: { runId, nodeId }, reveal: false, ...(signalBased ? { instructions: taskInstr } : {}) });
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
        // drop the maps BEFORE killing so onKilled doesn't re-enter the executor for this node.
        this.pipelineNodeCwd.delete(name);
        this.pipelineNodeOf.delete(name);
        // kill the session + drop the pipeline-tagged ledger row. A DECLARED `agent:` node reverts to a
        // clean config-listed STOPPED agent (no stale def.pipeline/nonce/run-worktree overlay — codex M1,
        // so planResume/verify never read a removed worktree); an inline `cmd:` node vanishes entirely.
        return this.manager
          .kill(name)
          .catch(() => {}) // may already be gone (the node process exited)
          .then(() => {
            // pin p-4dadd3 (a) / spec 247: an inline `cmd:` node (`pl-<runId>-<nodeId>`) vanishes entirely —
            // drop its orphaned durable log WITH the row (one named operation). A DECLARED `agent:` node reverts
            // to a persistent stopped agent and KEEPS its log (it has a real, reusable sidebar row) — row-only.
            if (!def?.agent) this.manager.removeEphemeralFootprint(name);
            else this.ledger.remove(name);
            this.deps.onViewsChanged("agents");
          });
      },
      persist: (run) => this.runLedger.save(run),
      onChange: () => this.deps.onViewsChanged("agents"),
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
  private rehydratePipelines(): void {
    const restored: Array<{ run: PipelineRun; cwd: string; nonces: Record<string, string> }> = [];
    for (const run of this.runLedger.list()) {
      const status = runStatus(run);
      if (status === "completed" || status === "failed") {
        this.runLedger.remove(run.id); // a finished run left on disk → nothing to restore
        continue;
      }
      const nonces: Record<string, string> = {};
      let cwd = "";
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
    this.deps.onViewsChanged("agents");
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
    return `tachyon.callerIdentity.instanceId.${this.wsHash}`;
  }

  private hostActionSessionEpochStateKey(): string {
    return `tachyon.hostAction.sessionEpoch.${this.wsHash}`;
  }

  private callerRegistryStateKey(): string {
    return `tachyon.callerIdentity.registry.${this.wsHash}`;
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
    this.deps.onViewsChanged("agents");
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
    this.deps.onViewsChanged("agents");
    return run.id;
  }

  /** spec 231 — re-read the per-run input file into the ledger snapshot (the "Edit input" action; only
   *  not-yet-started nodes pick up the change). No-op if the run/file is gone. */
  applyRunInput(runId: string): void {
    try {
      const text = fs.readFileSync(this.runInputFilePath(runId), "utf8").trim();
      this.pipelines.setInput(runId, text);
      this.deps.onViewsChanged("agents");
    } catch {
      /* nothing to apply */
    }
  }

  /** Builds, boots the Bridge/engine/watchers, and (if configured) starts agents. */
  /** Production entry: builds, boots the Bridge/engine/watchers, and (if configured) starts agents. */
  static async create(workspaceRoot: string, deps: WorkspaceDeps): Promise<Workspace> {
    return Workspace._create(workspaceRoot, deps, {});
  }

  /** spec 235 — headless test entry: inject a fake-exec tmux + no-op engine + `startBridge:false` to drive
   *  the Workspace with no Electron / real tmux / bound port. Delegates to the same impl as `create`. */
  static async createForTest(workspaceRoot: string, deps: WorkspaceDeps, seams: WorkspaceSeams): Promise<Workspace> {
    return Workspace._create(workspaceRoot, deps, seams);
  }

  private static async _create(workspaceRoot: string, deps: WorkspaceDeps, seams: WorkspaceSeams): Promise<Workspace> {
    const ws = new Workspace(workspaceRoot, deps, seams);
    void ws.engine.start().catch(() => {
      /* degraded from birth — executor falls back, reconnect loop is running */
    });

    // spec 351 — machine-local HMAC key custody (VS Code SecretStorage): loaded/created BEFORE the Bridge
    // binds a port or any agent could spawn, so mintAgentToken never misses a real spawn in production.
    // A headless test host (no getSecret wired) degrades to no per-agent tokens (legacy path only).
    try {
      const persisted = deps.host.getState<PersistableEntry[]>(ws.callerRegistryStateKey()) ?? [];
      ws.callerRegistry = new CallerIdentityRegistry(await loadOrCreateHmacKey(deps.host), persisted);
    } catch (err) {
      ws.host.notify(ws.t("per-agent Bridge tokens unavailable: {0} (falling back to the shared token)", err instanceof Error ? err.message : String(err)), "warn");
    }

    try {
      // Load config before the Bridge so settings.bridgePort applies; default is a
      // stable per-workspace derived port, so registrations survive editor restarts.
      ws.reloadConfig();
      if (seams.startBridge !== false) {
        const preferred = ws.config?.settings.bridgePort ?? derivePort(ws.wsHash);
        const port = await ws.bridge.start(preferred);
        if (ws.bridge.usedFallback) {
          ws.host.notify(
            ws.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and reload).", preferred, port),
            "warn",
          );
        }
        // spec 364 — after Bridge ready + 359 reload recovery, bump generation and auto-rebind suspects.
        void (async () => {
          await ws.recoverPendingHostActionReload();
          await ws.clientRebind?.onListenerReady();
        })();
      }
    } catch (err) {
      ws.host.notify(ws.t("Bridge failed to start: {0}", err instanceof Error ? err.message : String(err)), "error");
    }

    // tachyon.yml edits reflect live (config + watches + views).
    const onConfigChange = () => {
      const portBefore = ws.config?.settings.bridgePort;
      const agentsBefore = new Set(Object.keys(ws.config?.agents ?? {}));
      ws.reloadConfig();
      ws.rebuildWatches();
      deps.onViewsChanged("agents");
      // dogfood p-5a2a83 follow-up: an autostart agent ADDED by a live tachyon.yml edit starts
      // now (parity with the Studio create path), without re-spawning a pre-existing/stopped one.
      void ws.autostartNewlyDeclared(agentsBefore);
      deps.onViewsChanged("commands");
      if (ws.config?.settings.bridgePort !== portBefore) {
        ws.host.notify(ws.t("bridgePort changed — reload the window to rebind the Bridge"), "warn");
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
    const lastVersion = deps.host.getState<string>(`tachyon.version.${ws.wsHash}`);
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
    deps.host.setState(`tachyon.version.${ws.wsHash}`, currentVersion);

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
  attentionOf(agent: string): AgentAttention | undefined {
    return this.monitor.stateOf(agent);
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
    const relPath = path.join(".tachyon", "roles", `${agent}.md`);
    try {
      const abs = path.join(this.workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildRoleDoc(agent, def?.role, def?.instructions), "utf8");
    } catch {
      // a missing role doc just weakens the reminder; the inline role name still re-anchors
    }
    // spec 363 T3 — re-anchor is one of the four primer moments (spawn/restart/resume/re-anchor):
    // always the FULL primer (spec.md — no delta dosing), typed in AFTER the short role reminder
    // so recency still favors the role-doc pointer while the primer restores protocol/repo facts.
    const delegationRecord = readLatestDelegationRecord(this.workspaceRoot, agent)?.record;
    const { primer, beforeFinishing } = renderPrimer({
      agentName: agent,
      delegator: this.manager.delegatorOf(agent),
      parent: this.manager.parentOf(agent),
      gate: delegationRecord ? { behaviorTest: delegationRecord.behaviorTest, owns: delegationRecord.owns, stubPath: delegationRecord.stubPath } : undefined,
      freshWorktree: false,
      verify: this.config?.settings.verify,
    });
    await this.tmux.sendKeys(session, `${roleReminder(def?.role, relPath)}\n\n${primer}\n\n${beforeFinishing}`, true);
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

  /** Canonical declared-agent removal tail. Caller owns deleting the tachyon.yml entry first. */
  forgetAgent(name: string): void {
    forgetAgentFootprint(name, {
      workspaceRoot: this.workspaceRoot,
      ledger: this.ledger,
      removeHarnessHome: (agent) => this.harness.remove(agent),
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
    if (!this.automaticPersistenceNudgesAllowed(agent)) return false;
    if (this.config?.settings.persistence?.silentHooks === false) return false;
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
        } catch {
          /* best-effort */
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
    const state = this.monitor.stateOf(agent)?.state;
    if (state === "working" || state === "throttled" || state === "needs-input" || this.recoveryInFlight.has(agent)) {
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
    this.deps.onViewsChanged("agents");
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
    this.deps.onViewsChanged("agents");
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
  private gcLedger(declaredInConfig: Set<string>, live: Set<string>): void {
    try {
      for (const [name, rec] of this.ledger.all()) {
        if (rec.declared && !declaredInConfig.has(name) && !live.has(name)) {
          forgetAgentFootprint(name, {
            workspaceRoot: this.workspaceRoot,
            ledger: this.ledger,
            removeHarnessHome: (agent) => this.harness.remove(agent),
          });
        }
      }
    } catch { /* best-effort — a faxina must never block activation */ }
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
    if (!file) {
      this.config = undefined;
      return false;
    }
    const { config, errors, warnings } = loadConfigFile(file);
    if (errors.length > 0) {
      this.host.notify(this.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? this.t(" (+{0} more)", errors.length - 1) : ""), "error");
      return false;
    }
    for (const warning of warnings) this.host.notify(this.t("{0}: {1}", path.basename(file), warning), "warn");
    this.config = config;
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

  private triggerLifecycle(): void {
    // Debounced: a burst of events (layout apply, Stop All) becomes one tick.
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    this.lifecycleTrigger = setTimeout(() => {
      void this.lifecycle.tick();
      void this.commandRunner.tick();
      this.deps.onViewsChanged("agents");
      this.deps.onViewsChanged("commands");
    }, 250);
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
    // States with durations ("idle 2m") need periodic re-render even without transitions.
    this.deps.onViewsChanged("agents");
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
        await this.manager.spawn(def.spawn, def.instructions ? { instructions: def.instructions } : undefined);
      } else if (def.instructions) {
        // already up — deliver the prompt to its terminal
        await this.tmux.sendKeys(this.manager.session(def.spawn), def.instructions, true);
      }
      this.deps.onViewsChanged("agents");
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
        await this.manager.restart(agent);
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
    if (!this.reloadConfig()) {
      this.host.notify(this.t("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again"), "warn");
      return;
    }
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
    const declaredAutostart = new Set(
      Object.entries(this.config?.agents ?? {})
        .filter(([, def]) => def.autostart)
        .map(([name]) => name),
    );
    // Spec 211: rebuild ad-hoc defs + lineage from the ledger BEFORE planning resume,
    // so a re-discovered ad-hoc agent is restartable and re-nests under its parent.
    this.manager.rehydrateFromLedger();
    this.gcHarnessHomes(); // spec 226 (H8): drop config homes left by agents no longer declared/tracked
    const declaredInConfig = new Set(Object.keys(this.config?.agents ?? {}));
    this.gcLedger(declaredInConfig, liveSessions); // spec 239: prune stale declared rows
    this.compactSessionOwners(declaredInConfig, liveSessions); // t-123143: prune stale session-owner rows
    this.rehydratePipelines(); // spec 230: restore pipeline runs so a reloaded run's surviving nodes can still complete
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
    for (const agent of pending) {
      try {
        await this.manager.spawn(agent);
      } catch (err) {
        this.host.notify(this.t("autostart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
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
        this.deps.onViewsChanged("agents");
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
    this.deps.onViewsChanged("agents");
  }

  /** Resume every currently-offered agent (best-effort; a failure falls back to fresh). */
  async resumeAllOffered(): Promise<void> {
    for (const item of [...this.resumable]) {
      try {
        await this.manager.resume(item.name, item.record);
      } catch (err) {
        if (err instanceof ResumeUnavailableError && item.record.declared) {
          await this.manager.spawn(item.name).catch(() => undefined);
        }
      }
    }
    this.resumable = [];
    this.deps.onViewsChanged("agents");
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
      fs.writeFileSync(file, text, "utf8");
      this.reloadConfig();
      this.rebuildWatches();
      afterReload?.();
      for (const warning of warnings) this.host.notify(warning, "warn");
      return true;
    } catch (err) {
      this.host.notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  // spec 234 — applyLayoutWithSpawn / applyDefaultLayout removed (layouts feature retired).

  // spec 233 — `saveLayoutAs` (the editor-arrangement capture/prompt feature) was removed here: the
  // layouts feature is discontinued (FEATURES.layouts=false; its commands are `when:false`), so the
  // method was dead code AND the last `vscode` touchpoint in the engine. Removing it completes the
  // engine/UI decoupling. The broader layout-surface cleanup (applyLayout, the tree provider) is a
  // separate follow.

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
      void this.manager.spawn(submit.state.name).then(() => this.deps.onViewsChanged("agents")).catch((err) => {
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
    const manifests = ["package.json", "composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];
    const files = manifests.filter((f) => fs.existsSync(path.join(this.workspaceRoot, f)));
    let packageJson: DetectedProject["packageJson"];
    if (files.includes("package.json")) {
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, "package.json"), "utf8"));
      } catch {
        /* unreadable/invalid → no script suggestions */
      }
    }
    const readText = (f: string) => (files.includes(f) ? safeRead(path.join(this.workspaceRoot, f)) : undefined);
    const stack = detectStack({ files, packageJson, composerJson: readText("composer.json"), gemfile: readText("Gemfile"), installedClis: [] });
    const fromStack = suggestVerify(stack.label, packageJson?.scripts ?? {});
    const commands = Object.keys(this.config?.commands ?? {});
    const runbooks = Object.keys(this.config?.runbooks ?? {});
    return [...new Set([...fromStack, ...commands, ...runbooks])];
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
    if (this.config?.agents[oldName] !== undefined) {
      if (!this.mutateConfig((text) => renameAgentInYml(text ?? "", oldName, newName))) {
        // yml refused after the session moved — move it back so tree and config agree.
        await this.manager.rename(newName, oldName);
        if (wasOpen) this.terminals.open(oldName, this.manager.session(oldName));
        return; // rolled back — the flag correctly stays under oldName
      }
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
    this.deps.onViewsChanged("agents");
  }

  openCommandPane(name: string): void {
    this.terminals.open(`cmd:${name}`, this.commandRunner.session(name), undefined, `$ ${name}`);
  }

  openRunbookStepPane(runbook: string, index: number): void {
    this.terminals.open(`rb:${runbook}:${index}`, this.runbookRunner.stepSession(runbook, index), undefined, `$ ${runbook}#${index + 1}`);
  }

  /** Folder removed from the window (or extension deactivating). tmux sessions survive. */
  async dispose(): Promise<void> {
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
