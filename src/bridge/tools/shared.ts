import { z } from "zod";
import type { ZodErrorMap } from "zod";
import { AgentManager } from "../../agents/AgentManager.js";
import { removeAgentWorktree } from "../../agents/agentRemovalCascade.js";
import type { AgentWorktreeRemovalPorts } from "../../agents/agentRemovalCascade.js";
import { TmuxQueueError } from "../../tmux/TmuxService.js";
import type { TmuxService } from "../../tmux/TmuxService.js";
import { paneTranscriptExists, readPaneTranscript } from "../../agents/paneTranscript.js";
import type { PinStore, TiptapJSON } from "../../pins/PinStore.js";
import type { TaskStore } from "../../tasks/TaskStore.js";
import type { Task } from "../../tasks/types.js";
import { codePointLength, TASK_AUTHORING_LIMITS, taskAuthoringLimitMessage } from "../../tasks/taskAuthoring.js";
import type { TaskAuthoringLimitField } from "../../tasks/taskAuthoring.js";
import type { ContinuityStore } from "../../continuity/ContinuityStore.js";
import type { ProjectHandoffStore } from "../../handoff/ProjectHandoffStore.js";
import type { ValidationStore } from "../../validations/ValidationStore.js";
import type { ValidationActor } from "../../validations/types.js";
import type { Waiters, WaitCondition } from "../Waiters.js";
import { WaitOutputConcurrencyGate } from "../waitForOutput.js";
import { inLifecycleScope, lifecycleScopeRefusal } from "../lifecycleScope.js";
import type { LifecycleTool } from "../lifecycleScope.js";
import type { BackstopAcknowledgement } from "../../workspace/TemporaryBackstopMonitor.js";
import type { RuntimeConditionReportV1 } from "../../runtimeOps/runtimeCondition.js";
import type { CommandRunner } from "../../commands/CommandRunner.js";
import type { RunbookRunner } from "../../commands/RunbookRunner.js";
import { composerProfileFor } from "../../runtime/composerRegion.js";
import type { Scheduler } from "../../schedule/Scheduler.js";
import type { ProposalStore } from "../../schedule/ProposalStore.js";
import { parseEvery, parseAt } from "../../config/loadConfig.js";
import type { ScheduleDef } from "../../config/loadConfig.js";
import type { Severity, EvidenceView } from "../../worktree/evidence.js";
import type { ProbeService } from "../../probe/ProbeService.js";
import type { NoticeQueueMetadata } from "../NoticeQueue.js";
import { resolveActor } from "../callerIdentity.js";
import type { CallerSnapshot, CallerIdentityRegistry, CallerScope } from "../callerIdentity.js";
import { redactSecrets } from "../redact.js";
import type { HostActionBrokerResult } from "../../host-action/index.js";
import type { ManagedWorktreeService } from "../../worktree/ManagedWorktreeService.js";
import type { ChangedFile } from "../../worktree/review.js";
import type { TaskNotificationEvent } from "../../tasks/taskNotificationPolicy.js";
import type { TaskPrototypeSnapshot } from "../../tasks/TaskPrototypeStore.js";
import { RuntimeLaunchPreflightError } from "../../runtime/launchPreflight.js";
import { RuntimeLaunchReadinessError } from "../../runtime/launchReadiness.js";
import type { EvolutionStore } from "../../evolution/EvolutionStore.js";

export type NotifyLevel = "info" | "warn" | "error";
/**
 * t-8d190f — `submit-unconfirmed` is a THIRD outcome, distinct from both. The line was typed and Enter
 * was pressed, but Tachyon never observed it leave the composer, so it may be sitting staged in the
 * recipient's editor. It is not `notified` (nothing is proven delivered) and not `queued` (nothing is
 * held for a later flush); reporting either would be the bug this task fixes.
 */
export type NoticeDeliveryResult = {
  status: "notified" | "queued" | "submit-unconfirmed";
  dropped?: number;
  queued?: number;
  /** Why confirmation failed, propagated from the tmux submit receipt. */
  submitReason?: string;
  /**
   * t-a53dd9 — set when the wait is on a HUMAN, not on the recipient's turn. A queue held because the
   * recipient is mid-turn ends by itself in seconds; one held because a person is typing into that
   * pane ends when they submit, or at the TTL with the loss reported to them. The sender is told
   * which, because "queued" alone is what makes a doorbell that never lands look like one that did.
   */
  heldFor?: "human-draft";
};
/**
 * t-fb1453 — one definition, imported rather than restated. The second copy that used to live here
 * could not express the `origin` requirement, so a caller binding a notice to a child's identity got
 * no compiler help deciding whether that notice outlives the child.
 */
export type NoticeSourceMetadata = NoticeQueueMetadata;

export interface BridgeDeps {
  /** Workspace root used by best-effort local discovery tools. */
  workspaceRoot: string;
  /**
   * t-099be8 — validate-then-write the workspace tachyon.yml (agent self-edit gate).
   * When present, enables `write_tachyon_config`. Must refuse invalid configs without writing.
   */
  writeTachyonConfig?: (
    yamlText: string,
  ) => { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };
  manager: AgentManager;
  tmux: TmuxService;
  /** Shared human↔agent project checklist (.tachyon/pins.json). */
  pins: PinStore;
  /** spec 325 — project work queue entity (.tachyon/tasks/*.json). */
  tasks: TaskStore;
  /** SDD 421 — canonical Agent Evolution profiles, reviews, and candidates. */
  evolution?: EvolutionStore;
  /** spec 344 — project validation queue entity (.tachyon/validations/*.json), independent from SDD. */
  validations: ValidationStore;
  /** spec 241 — per-agent continuity briefs (.tachyon/continuity/<agent>.md). Enables get/set/status_continuity. */
  continuity?: ContinuityStore;
  /** spec 241 — current activity seq for an agent (the freshness anchor); undefined when unknown. */
  currentActivitySeq?: (agent: string) => number | undefined;
  /** spec 241 — fired after a continuity mutation — wired to the sidebar badge refresh. */
  onContinuityChanged?: (agent: string) => void;
  /** spec 245 — the shared per-project handoff (.tachyon/HANDOFF.md + handoff-notes.jsonl). Enables the 3 handoff tools. */
  handoff?: ProjectHandoffStore;
  /** spec 245 — last project activity timestamp (ISO) for handoff staleness; null/undefined when unknown. */
  lastActivityAt?: () => string | null;
  /** spec 245 — fired after a handoff mutation — wired to the sidebar panel refresh. `agent` is set when an agent
   *  APPENDED a note (inc F: the host anchors the append-nudge to that agent's activity seq); absent on an owner rewrite. */
  onHandoffChanged?: (agent?: string) => void;
  /** Surfaces a message to the human — wired to vscode.window.show*Message in the extension. */
  notify: (message: string, level: NotifyLevel) => void;
  /** spec 257 — the captured headless A2A probe lane. Enables probe_agent + read_probe_result. */
  probe?: ProbeService;
  /** spec 257 — the cwd probes run in (the workspace root); falls back to process.cwd(). */
  probeCwd?: () => string;
  /** spec 257 — how long a sync probe_agent call holds before handing back a runId (default 120_000). */
  probeSyncCapMs?: number;
  /** Attention state of an agent ("working" | "idle" | "needs-input"), when monitoring is active. */
  attentionOf?: (agent: string) => string | undefined;
  /**
   * SDD 420 — tab-scoped Companion tools. All require opaque companion tabId
   * (from user_browser_tabs_list). Blocks until extension fulfills or times out.
   */
  companionTabTabsList?: (opts?: { timeoutMs?: number }) => Promise<unknown>;
  companionTabSnapshot?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabAct?: (input: {
    kind: "click" | "type" | "fill";
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    text?: string;
    value?: string;
    submit?: boolean;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabScreenshot?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    format?: "jpeg" | "png";
    quality?: number;
    scope?: "viewport" | "full_page" | "element";
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabEval?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    expression: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabConsole?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    limit?: number;
    timeoutMs?: number;
  }) => Promise<unknown>;
  /** SDD 420 P0 — navigate / scroll / keys / wait / tab lifecycle. */
  companionTabNavigate?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    action: "goto" | "back" | "forward" | "reload";
    url?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabScroll?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    direction?: "up" | "down" | "left" | "right";
    pixels?: number;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabPressKey?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    key: string;
    modifiers?: string[];
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabWaitFor?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    what: "element" | "text" | "navigation" | "load";
    ref?: string;
    selector?: string;
    text?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabOpen?: (opts: {
    url?: string;
    active?: boolean;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabActivate?: (opts: {
    tabId: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabClose?: (opts: {
    tabId: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  /** SDD 420 P1 — directed read / find / hover / select / check. */
  companionTabGet?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    what: "text" | "html" | "value" | "attribute" | "state";
    attribute?: string;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabFind?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    text: string;
    limit?: number;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabHover?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabSelectOption?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    value?: string;
    label?: string;
    index?: number;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabCheck?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    checked: boolean;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabDrag?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    sourceRef?: string;
    sourceSelector?: string;
    targetRef?: string;
    targetSelector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabUpload?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    files: Array<{ name: string; mimeType: string; base64: string }>;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabDownload?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabNetwork?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    limit?: number;
    urlContains?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabListFrames?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  companionTabDialog?: (opts: {
    tabId: string;
    expectedDocumentToken?: string;
    action: "accept" | "dismiss" | "read";
    text?: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  /**
   * SDD 414 — human settings opt-in (settings.companion.tabTools).
   * When true, register user_browser_* tools on this Bridge request so agents can
   * discover them. Absent/false → tools omitted (no list pollution).
   */
  companionTabToolsEnabled?: () => boolean;
  /**
   * @deprecated Prefer always-register when `ideBrowserRequest` is wired.
   * Kept for tests that gate registration without a request fn. Live engines
   * register ide_browser_* / design_mode_chat_reply whenever `ideBrowserRequest`
   * is present; offline calls fail with bridge_offline (companion-style).
   */
  ideBrowserToolsEnabled?: () => boolean;
  /**
   * Call the shell IDE browser bridge: route like "/navigate", optional JSON body.
   * Returns { ok, data | error } envelope. Presence of this dep registers the tools.
   */
  ideBrowserRequest?: (
    route: string,
    body?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
  /** SDD 420 optional host allowlist. */
  companionAllowedHosts?: () => string[] | undefined;
  /**
   * SDD 420 — last-snapshot @e metadata for safety (name/href/selector).
   * When agents click with only ref=@eN, gate still sees resolved labels.
   */
  companionRefHints?: (
    tabId: string,
    ref: string,
  ) => { selector?: string; name?: string; href?: string; elementText?: string } | undefined;
  /**
   * SDD 414 — true while a Companion device session is live on this engine.
   * Checked at call time when tab tools are enabled; not used to hide tools from the list.
   */
  companionBrowserPaired?: () => boolean;
  /** True when the target has a profile-backed non-empty composer draft, as of the last attention poll. */
  composerOccupiedOf?: (agent: string) => boolean | undefined;
  /**
   * t-a53dd9 — the same question asked of the pane NOW rather than of the poll. Callers that are
   * about to WRITE into someone else's terminal must prefer this: the cached answer can be seconds
   * old, and the state it misses is a human who started typing since the last capture. Resolves
   * `undefined` for a runtime with no declared composer, which means "cannot answer" — fall back to
   * `composerOccupiedOf`, never to "clear".
   */
  composerDraftNow?: (agent: string) => Promise<boolean | undefined>;
  /** spec 341 — semantic agent notice delivery; queues unsafe recipients instead of raw pane submit. */
  deliverNotice?: (target: string, line: string, metadata?: NoticeSourceMetadata) => Promise<NoticeDeliveryResult>;
  /**
   * t-fb1453 — metadata binding a queued notice to the SENDER that authored it. Named for the origin
   * it carries (`agent-authored`), not for the field it fills: an authored notice survives its author,
   * and a future caller that wants a host poke's expire-with-the-child semantics must not reach for
   * this one by accident.
   */
  authoredNoticeMetadata?: (agent: string) => NoticeSourceMetadata;
  /** t-9552f3 — mark sender as having completed a doorbell this session (attention/backstop reconciliation). */
  markCompletionHint?: (agent: string) => void;
  /** Fired after any pin mutation — wired to the sidebar refresh. */
  onPinsChanged?: () => void;
  /** Fired after a human approval request is recorded, so the host can show the approval view. */
  onApprovalRequested?: (request: { id: string; requester: string }) => void;
  /**
   * t-8e9b5e — fired after a Saved Agent proposal is recorded. Without this the proposal was a
   * first-class Human Inbox item that rang nothing, and it expires in 24h — so one nobody saw did
   * not wait, it died.
   */
  onSavedAgentProposed?: (proposal: { id: string; name: string; proposer: string }) => void;
  /**
   * t-afe120 — fired after a Saved Agent REMOVAL proposal is recorded. Same doorbell doctrine as
   * create proposals: a pending removal that rings nothing expires unseen.
   */
  onSavedAgentRemovalProposed?: (proposal: { id: string; name: string; proposer: string }) => void;
  /**
   * t-afe120 — inspect a profile-backed Saved Agent for removal proposals. Returns identity facts the
   * digest binds to; undefined when the name is not a canonical profile agent.
   */
  inspectSavedAgentProfile?: (name: string) => Promise<{ agentId: string; revision: string } | undefined>;
  /** Fired after any task mutation — wired to the future Board/task view refresh. */
  onTasksChanged?: (event?: { reason: "task-mutated" | "journal-appended"; id?: string }) => void;
  /** Human-facing task mutation event sink. Best-effort; separate from assignee pane notices. */
  onTaskNotificationEvent?: (event: TaskNotificationEvent) => void;
  /** Fired after any validation mutation — wired to Board refresh. */
  onValidationsChanged?: () => void;
  /**
   * t-e76acc — fired when work lands on a HUMAN: a validation created with `executor: "human"`, or
   * one handed to a human by an update. The measured asymmetry this closes (report § 1.1) is that an
   * approval notifies its human and a validation never did — so the same notice/badge treatment
   * applies here, and DELIBERATELY not the injection semantics: resolving an approval writes into the
   * requester's tmux session because an agent is blocked on it, while a validation is evidence
   * waiting to be read and nothing is blocked on it.
   */
  onHumanValidationPending?: (validation: { id: string; title: string; author: string }) => void;
  /** Event-driven waiter registry — enables wait_for_agent (absent = tool returns an error). */
  waiters?: Waiters;
  /** One-shot command runner — enables run_command/list_commands. */
  commands?: CommandRunner;
  /** Step-by-step runbook runner — enables run_runbook. */
  runbooks?: RunbookRunner;
  /** Schedule engine — enables list_schedules (active timers). */
  scheduler?: Scheduler;
  /** Pending agent-proposed schedules — enables propose_schedule. */
  proposals?: ProposalStore;
  /** Fired after a proposal is created — routed to the exact Human Inbox item. */
  onScheduleProposed?: (proposal: { id: string; name: string; by: string }) => void;
  /** spec 273 — attach one non-binary evidence record to a worktree agent. Enables attach_evidence. */
  attachEvidence?: (input: AttachEvidenceInput) => Promise<{ ok: boolean; id?: string; reason?: string }>;
  /** spec 273 — read a worktree agent's evidence records (fresh + stale-flagged). Enables list_evidence. */
  listEvidence?: (agent: string) => Promise<EvidenceView[]>;
  /** t-6f0377 — cheap, non-destructive self-context renewal, deferred by the host until idle. */
  requestContextCompaction?: (agent: string) => Promise<{ status: "pending"; replaced?: "compact" | "fresh" }>;
  /** t-6f0377 — destructive fresh-context renewal. Kept as a separate port so it cannot be selected accidentally. */
  requestFreshContext?: (agent: string) => Promise<{ status: "pending"; replaced?: "compact" | "fresh" }>;
  /**
   * t-0bebf6 — answer the host's idle/stall poke about a child: "inspected, decided, leave it".
   * Returns null when there is no outstanding poke for that child, which is what keeps the door from
   * doubling as a pre-emptive mute. Enables acknowledge_agent.
   */
  acknowledgeIdlePoke?: (agent: string) => BackstopAcknowledgement | null;
  /**
   * t-458497 — the derived runtime-condition projection (`projectRuntimeCondition`). Enables
   * runtime_condition. A CACHED read by contract: it must never collect from a provider, because a
   * Bridge tool that spawns a runtime process to answer a question is a measurement door wearing a
   * read door's name.
   */
  runtimeCondition?: () => RuntimeConditionReportV1;
  /** t-7551f9 — continue unfinished task on another agent (new session + focused handoff). */
  continueTask?: (input: {
    fromAgent: string;
    toAgent: string;
    reason?: string;
    taskSummary?: string;
  }) => Promise<{
    ok: true;
    handoffId: string;
    handoffPath: string;
    fromAgent: string;
    toAgent: string;
    fromRuntime: string;
    toRuntime: string;
  }>;
  /** spec 230 — validate + apply a pipeline node's complete_node signal (per-node nonce auth, codex M1). */
  completeNode?: (input: { runId: string; nodeId: string; nonce: string; summary?: string }) => Promise<{ ok: boolean; reason?: string }>;
  /** spec 351 — the Bridge-resolved caller for THIS request (Bridge.ts threads a fresh one in per call).
   *  Undefined only when `registerTools` is called directly without going through Bridge.ts (some tests) —
   *  treated the same as kind "legacy" (fully-trusting bypass) everywhere it's read, for parity. */
  caller?: CallerSnapshot;
  /** spec 351 — the digest-only registry + scope, threaded alongside `caller` ONLY so a legacy-token call
   *  can check "is the declared name a currently-LIVE agent identity" (the t-d7b3a9 spoof guard); never
   *  used to re-resolve `caller` itself (that already happened once, in Bridge.ts). */
  callerRegistry?: CallerIdentityRegistry;
  callerScope?: CallerScope;
  /** spec 351 (dueto F8) — plaintext secrets Tachyon still holds (the shared/legacy token), for exact-match
   *  redaction of freshly-captured LIVE pane text before it's ever returned over the Bridge. Per-agent
   *  tokens are never in this list (digest-only — their plaintext isn't retained) but still get caught by
   *  redactSecrets' syntactic patterns (env assignment / Bearer header). */
  knownSecrets?: () => readonly string[];
  /** spec 359 — governed host-action runner. Enables run_host_action; caller identity is deps.caller, never a tool param. */
  runHostAction?: (input: { action: string; args?: unknown; timeoutMs?: number; caller: CallerSnapshot }) => Promise<HostActionBrokerResult>;
  /** t-35d95a — latch the CALLER's own agent as awaiting-human (AttentionMonitor.flagAwaitingHuman),
   *  publishing to the owned Attention Stack/badge wiring. Enables request_human_attention; absent = no-op tool. */
  flagAwaitingHuman?: (agent: string, reason: string) => void;
  /** spec 392 — managed worktree registry + change worktree create/remove. */
  managedWorktrees?: ManagedWorktreeService;
  runtimeCredentialHygiene?: (input: { dryRun: boolean; agentNames: string[] }) => Promise<unknown>;
  /**
   * SDD 494 Part 4 — read-only roster reconciliation: per agent, membership, the four presence
   * facts, the derived disagreement state, and the door that would remove it. Enables
   * `reconcile_roster`; absent on a Bridge stood up without a workspace.
   */
  savedAgentRosterReconciliation?: () => Promise<unknown>;
  /**
   * t-d06da3 — the ports the SHARED agent-removal cascade needs (`agentRemovalCascade`), so
   * `dismiss_agent` runs the same worktree step the engine's `config.agent.delete` runs instead of
   * being a third door with no worktree step at all. `Workspace` satisfies this interface directly,
   * which is how the operation service already calls the cascade.
   *
   * Optional for the same reason every other capability here is: a Bridge stood up without a
   * workspace (tests, `registerTools` called directly) keeps the pre-t-d06da3 behaviour, which is
   * correct there because a Temporary with no engine cannot own a checkout either.
   */
  agentWorktrees?: AgentWorktreeRemovalPorts;
  /**
   * t-75e9c7 — the diff-vs-baseRef git read `agent_touched_files` needs (working-tree compare, spec
   * 213), threaded separately from `agentWorktrees` because that port is scoped to removal and this
   * one is a plain read no removal call needs. `Workspace.worktrees` (a `WorktreeManager`) satisfies
   * this directly. Optional for the same reason every other capability here is.
   */
  touchedFiles?: (cwd: string, baseRef: string) => Promise<ChangedFile[]>;
  /** t-004255 — current branch merge-base for drift-free agent_touched_files comparisons. */
  touchedFilesMergeBase?: (cwd: string, leftRef: string, rightRef: string) => Promise<string | undefined>;
}

/**
 * spec 351 — the actor-vs-subject wrapper every identity-bearing tool param routes through: omitted
 * declared value resolves to the Bridge-resolved caller; an explicit value that matches is fine; anything
 * else is a structured mismatch. `deps.caller` missing (registerTools called directly, bypassing Bridge.ts)
 * degrades to kind "legacy" — the same fully-trusting bypass a pre-351 direct-call test already relied on.
 */
export function resolveDeclaredActor(deps: Pick<BridgeDeps, "caller" | "callerRegistry" | "callerScope">, declared: string | undefined) {
  return resolveActor({
    caller: deps.caller ?? { kind: "legacy" },
    declared,
    registry: deps.callerRegistry,
    scope: deps.callerScope ?? { workspaceId: "", instanceId: "" },
  });
}

/**
 * t-bec361 — the WHICH-TARGETS gate for the three by-name lifecycle/input doors. Returns the refusal
 * text when the call is out of scope, `undefined` when it may proceed.
 *
 * Scoped to a caller the Bridge resolved as an AGENT, and to nothing else. A missing `deps.caller`
 * (registerTools called directly, bypassing Bridge.ts) and every non-agent kind — master, external,
 * legacy, human — pass through untouched: those are the human's operation tokens, and the sidebar's
 * own Kill must not be narrowed by a rule written for agent-to-agent calls.
 */
export function lifecycleScopeGuard(
  deps: Pick<BridgeDeps, "caller" | "manager">,
  tool: LifecycleTool,
  target: string,
): string | undefined {
  const caller = deps.caller;
  if (caller?.kind !== "agent" || !caller.name) return undefined;
  if (inLifecycleScope(caller.name, target, deps.manager)) return undefined;
  return lifecycleScopeRefusal(tool, caller.name, target, deps.manager);
}

export function contextRenewalRequestRefusal(input: {
  agent: string;
  mode: "compact" | "fresh";
  composerOccupied: boolean;
  pendingApprovalId?: string;
  attention?: string;
  continuityExists: boolean;
}): string | undefined {
  if (input.composerOccupied) return `renew_context refused for '${input.agent}': the composer contains a draft`;
  if (input.pendingApprovalId) return `renew_context refused for '${input.agent}': human approval '${input.pendingApprovalId}' is pending`;
  if (input.attention === "needs-input" || input.attention === "throttled") {
    return `renew_context refused for '${input.agent}': attention state is '${input.attention}'`;
  }
  if (input.mode === "fresh" && !input.continuityExists) {
    return `fresh context refused for '${input.agent}': no continuity brief exists`;
  }
  return undefined;
}

/** spec 273 — the input to attach_evidence (producer is self-declared, per the bridge's caller model). */
export interface AttachEvidenceInput {
  targetAgent: string;
  producer: string;
  kind: string;
  severity: Severity;
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
  artifacts?: string[];
  onBehalfOf?: string;
  sourceRunId?: string;
}

/** Validates a proposed schedule (same rules as config) before storing it. */
export function validateProposedSchedule(s: ScheduleDef): string | null {
  const hasEvery = s.every !== undefined;
  const hasAt = s.at !== undefined;
  if (hasEvery === hasAt) return "exactly one of 'every' or 'at' is required";
  if (hasEvery && parseEvery(s.every as string) === null) return "every must be like '30m', '1h', '2h'";
  if (hasAt && parseAt(s.at as string) === null) return "at must be 'HH:MM' (24h)";
  const hasRun = s.run !== undefined;
  const hasSpawn = s.spawn !== undefined;
  if (hasRun === hasSpawn) return "exactly one of 'run' or 'spawn' is required";
  return null;
}

/** Bridge projection deliberately excludes raw HTML. Agent-authored strings are nested under an explicit
 * untrusted envelope; ids, hashes, lifecycle and integrity are host-validated first-party metadata. */
export function prototypeBridgeView(snapshot: TaskPrototypeSnapshot): unknown {
  const summaries = snapshot.prototypes.map((p) => ({
    id: p.id,
    sha256: p.sha256,
    byteSize: p.byteSize,
    policyVersion: p.policyVersion,
    state: p.state,
    createdAt: p.createdAt,
    ...(p.approvedAt ? { approvedAt: p.approvedAt, approvedBy: p.approvedBy } : {}),
    ...(p.supersededBy ? { supersededBy: p.supersededBy } : {}),
    available: p.available,
    integrity: p.integrity,
    ...(p.needsTaskReconciliation ? { needsTaskReconciliation: true } : {}),
    untrustedAgentAuthored: {
      title: p.title,
      author: p.author,
      reviews: p.reviews.map((review) => ({ action: review.action, at: review.at, by: review.by, sha256: review.sha256, ...(review.text ? { text: review.text } : {}) })),
    },
  }));
  return {
    schemaVersion: 1,
    readOnly: snapshot.readOnly,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    summaries,
    ...(snapshot.approved?.available ? {
      activeApprovedAnchor: {
        id: snapshot.approved.id,
        sha256: snapshot.approved.sha256,
        path: snapshot.approved.relativePath,
        contentIsUntrusted: true,
      },
    } : {}),
  };
}

/** Waiter key namespace for command completions (no clash with agent names). */
export const CMD_WAIT_PREFIX = "cmd:";

/** Shared by the MCP tool and the extension's internal command — one wait semantics. */
export async function executeWait(
  deps: Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
  name: string,
  until: WaitCondition,
  timeoutSec: number,
): Promise<{ met: boolean; state: string; exitCode?: number; waitedMs: number }> {
  const states = await deps.manager.agentStates();
  const current = states.get(name);
  if (!current) return { met: until === "dead", state: "gone", waitedMs: 0 };
  if (current.dead) return { met: until === "dead", state: "dead", exitCode: current.exitCode, waitedMs: 0 };
  const attention = deps.attentionOf?.(name);
  if (attention === until) return { met: true, state: attention, waitedMs: 0 };
  if (!deps.waiters) throw new Error("waiting is not available on this Bridge");
  const result = await deps.waiters.wait(name, until, timeoutSec * 1000);
  if (result.state === "timeout") {
    // report the live state at timeout so the caller can decide (and call again)
    return { ...result, state: deps.attentionOf?.(name) ?? "working" };
  }
  return result;
}

export const AGENT_NAME = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "agent name must start with a letter and use [a-zA-Z0-9_-]");

export const TASK_ID = z.string().regex(/^t-[0-9a-f]{6}$/, "task id must be t-<6hex>");
export const TASK_STATUS = z.enum(["inbox", "triaged", "active", "landed", "done", "dropped"]);
export const TASK_PRIORITY = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const TASK_ARTIFACT_REF = z.object({
  type: z.string().min(1).max(64),
  ref: z.string().min(1).max(500),
  role: z.enum(["deliverable", "relation"]).optional(),
});
export const createTaskLimitErrorMap = (field: TaskAuthoringLimitField): ZodErrorMap => (issue, ctx) => {
  if (issue.code !== "too_big") return { message: ctx.defaultError };
  const received = Array.isArray(ctx.data) ? ctx.data.length : codePointLength(String(ctx.data));
  return { message: taskAuthoringLimitMessage(field, received, Number(issue.maximum)) };
};
export const createTaskString = (field: TaskAuthoringLimitField, maximum: number) =>
  z.string({ errorMap: createTaskLimitErrorMap(field) }).max(maximum);
export const CREATE_TASK_ARTIFACT_REF = z.object({
  type: createTaskString("artifact_refs.type", TASK_AUTHORING_LIMITS.artifactRefType).min(1),
  ref: createTaskString("artifact_refs.ref", TASK_AUTHORING_LIMITS.artifactRefValue).min(1),
  role: z.enum(["deliverable", "relation"]).optional(),
});
export const TASK_EXPECT = z.object({
  assignee: z.string().min(1).max(64).nullable().optional(),
  status: TASK_STATUS.optional(),
  updatedAt: z.string().min(1).optional(),
}).optional();
export const TASK_AWAITING_HUMAN_KIND = z.enum(["decision", "validation", "dogfood"]);
export const EVOLUTION_REVIEW_ID = z.string().regex(/^review-[A-Za-z0-9_-]+$/, "review id must be review-<id>");
export const EVOLUTION_SKILL_FILE = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(256 * 1024),
  executable: z.boolean().optional(),
});
export const EVOLUTION_PROPOSAL = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("learning"),
    content: z.string().min(1).max(4000),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("skill"),
    operation: z.enum(["create", "update"]),
    name: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    reason: z.string().min(1).max(2000),
    expectedTargetDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    files: z.array(EVOLUTION_SKILL_FILE).min(1).max(64),
  }),
]);
export const VALIDATION_ID = z.string().regex(/^v-[0-9a-f]{6}$/, "validation id must be v-<6hex>");
export const VALIDATION_STATUS = z.enum(["pending", "triaged", "running", "closed"]);
export const VALIDATION_EXECUTOR = z.enum(["human", "agent", "either"]);
export const VALIDATION_OUTCOME = z.enum(["passed", "failed", "skipped"]);
export const VALIDATION_EXPECT = z.object({
  assignee: z.string().min(1).max(64).nullable().optional(),
  status: VALIDATION_STATUS.optional(),
  updatedAt: z.string().min(1).optional(),
}).optional();

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * t-fbefec — who proposed a schedule, resolved from the token rather than stamped. The human who
 * approves a proposal is authorizing a config-as-code write, and "agent" (the literal this used to
 * record for every caller) does not tell them WHICH of the fleet asked, nor that a non-agent caller
 * asked at all. Non-agent kinds render parenthesized, which `AGENT_NAME_RE` forbids, so a caller
 * kind can never be mistaken for — or collide with — a real agent name.
 */
export function proposalAuthor(deps: Pick<BridgeDeps, "caller">): string {
  const caller = deps.caller ?? { kind: "legacy" as const };
  return caller.kind === "agent" && caller.name ? caller.name : `(${caller.kind})`;
}

/** t-98256c — the validation actor is the Bridge-resolved caller, never a tool field (spec 351). */
export function validationActor(deps: Pick<BridgeDeps, "caller">): ValidationActor {
  const caller = deps.caller ?? { kind: "legacy" as const };
  return caller.kind === "agent" && caller.name ? { kind: "agent", name: caller.name } : { kind: caller.kind };
}

export function runtimeLaunchFailure(err: unknown): RuntimeLaunchPreflightError | RuntimeLaunchReadinessError | undefined {
  if (err instanceof RuntimeLaunchPreflightError || err instanceof RuntimeLaunchReadinessError) return err;
  if (err instanceof AggregateError) {
    const cause = runtimeLaunchFailure(err.cause);
    if (cause) return cause;
    for (const nested of err.errors) {
      const failure = runtimeLaunchFailure(nested);
      if (failure) return failure;
    }
  }
  return undefined;
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const launchFailure = runtimeLaunchFailure(err);
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    isError: true,
    ...(launchFailure
      ? {
          structuredContent: {
            error: {
              code: launchFailure.code,
              message,
              ...(launchFailure instanceof RuntimeLaunchPreflightError && launchFailure.model ? { model: launchFailure.model } : {}),
              ...(launchFailure instanceof RuntimeLaunchPreflightError && launchFailure.suggestions.length ? { suggestions: launchFailure.suggestions } : {}),
              // SDD 477 / t-0338fc — an auth refusal is only useful if the caller learns what a HUMAN
              // must do; a coordinator that reads a bare code will just retry into the same wall.
              ...(launchFailure instanceof RuntimeLaunchPreflightError && launchFailure.humanAction ? { humanAction: launchFailure.humanAction } : {}),
            },
          },
        }
      : err instanceof TmuxQueueError
      ? {
          structuredContent: {
            error: {
              message,
              code: err.code,
              op: err.op,
              ...(err.queueWaitTimeoutMs === undefined ? {} : { queueWaitTimeoutMs: err.queueWaitTimeoutMs }),
            },
          },
        }
      : {}),
  };
}

export const MAX_PIN_TITLE_CHARS = 120;

export function normalizeCreatePinInput(input: { title?: string; text?: string; detail?: string }): { title: string; detail?: string } {
  const explicitTitle = collapseWhitespace(input.title);
  const rawText = trimText(input.text);
  const rawDetail = trimText(input.detail);
  const source = rawDetail || rawText || explicitTitle;
  if (!source) throw new Error("create_pin requires title, text, or detail");

  const title = explicitTitle ? truncatePinTitle(explicitTitle) : derivePinTitle(source);
  const detail = rawDetail || (shouldKeepPinDetail(rawText, title) ? rawText : "");
  return detail && collapseWhitespace(detail) !== title ? { title, detail } : { title };
}

export function derivePinTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => collapseWhitespace(line)).find(Boolean) ?? collapseWhitespace(text);
  const firstSentence = firstLine.match(/^.{20,}?[.!?](?:\s|$)/)?.[0]?.trim() ?? firstLine;
  return truncatePinTitle(firstSentence || "Untitled pin");
}

export function shouldKeepPinDetail(text: string, title: string): boolean {
  if (!text) return false;
  if (collapseWhitespace(text) === title) return false;
  return text.includes("\n") || collapseWhitespace(text).length > MAX_PIN_TITLE_CHARS;
}

export function truncatePinTitle(text: string): string {
  const compact = collapseWhitespace(text);
  if (compact.length <= MAX_PIN_TITLE_CHARS) return compact;
  return `${compact.slice(0, MAX_PIN_TITLE_CHARS - 3).trimEnd()}...`;
}

export function trimText(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function collapseWhitespace(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function plainTextDoc(text: string): TiptapJSON {
  const paragraphs = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs.map((block) => ({ type: "paragraph", content: inlineTextNodes(block) })) : [{ type: "paragraph" }],
  };
}

export function inlineTextNodes(block: string): TiptapJSON[] {
  const lines = block.split(/\r?\n/);
  const nodes: TiptapJSON[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line) nodes.push({ type: "text", text: line });
  });
  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

export function definedPatch<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * t-f638bd — the acknowledgement a task mutation owes its caller, and nothing more.
 *
 * Every task mutation used to answer with the whole task, pretty-printed. Measured over 129 real
 * `update_task` calls in the harness transcripts that is 316KB / ~134k tokens of echo — the caller
 * re-reading a body it just sent, or never asked for. The board's own orchestrator abandoned a
 * nine-task bookkeeping pass mid-way to protect its context, which is the tool forcing a choice
 * between governing the board and doing the work.
 *
 * What a mutation genuinely owes back is what the caller could NOT have known: that it committed,
 * at which `updatedAt` (the CAS token for the next `expect`), and which fields the STORE changed
 * on its own — `assignee` unset by a return to inbox, `awaitingHuman` dropped by any transition.
 * `cleared` is why this is a receipt and not just an ack: those are the surprises. Anyone who wants
 * the document calls `get_task`, or passes `include:"task"` here.
 */
export function taskReceipt(before: Task | undefined, after: Task, requested: string[]): string {
  const changed = requested.filter((field) => field !== "expect");
  const cleared = before
    ? (["assignee", "awaitingHuman", "evolutionCompletion"] as const).filter(
        (field) => before[field] !== undefined && after[field] === undefined && !changed.includes(field),
      )
    : [];
  return JSON.stringify({
    id: after.id,
    status: after.status,
    updatedAt: after.updatedAt,
    changed,
    ...(cleared.length ? { cleared } : {}),
  });
}

export async function managedEntry(deps: Pick<BridgeDeps, "manager">, name: string) {
  return (await deps.manager.list()).find((a) => a.name === name);
}

/** What the Bridge needs to SAY about a checkout it just took down — the record, plus git's verdict on the branch. */
export interface DismissedWorktree {
  path: string;
  branch: string;
  branchKept: boolean;
  alreadyAbsent: boolean;
}

/**
 * t-d06da3 — the worktree half of `dismiss_agent`, and the reason it is a call rather than code.
 *
 * `agentRemovalCascade` was extracted by t-e722ce "so BOTH doors can call the same code instead of two
 * copies drifting" — the engine's `config.agent.delete` and Agent Studio's Forget. This was a THIRD
 * door: it called `dismissTemporary` and nothing else, so an owned checkout and its registry row would
 * have outlived the row that owned them. Invisible until now only because a Temporary could not own a
 * worktree; lifting that refusal one screen up is what makes it visible, which is `t-33ae3f` for the
 * third time if this door keeps its own copy.
 *
 * WHICH OCCUPANCY GATES A TEMPORARY DISMISS NEEDS — the question `tasks.md` refused to let the code
 * answer implicitly. `removeAgentWorktree` carries three, and all three are load-bearing HERE:
 *
 *  - `liveDescendants` — the one that matters MOST for a Temporary and least for a Saved Agent. A
 *    parented child with no `worktree:true` runs in its parent's cwd by construction, so dismissing an
 *    isolated parent while a child still runs there deletes the ground under a live agent. Only the
 *    Temporary lifecycle can produce that arrangement.
 *  - the measured `probeAgentOccupancy` gate (t-4736b4) — the entry's `running` flag above comes from
 *    `manager.list()`, the last-known-good inventory, which is exactly the stale snapshot t-4736b4
 *    found lying in both directions on a removal path. A checkout cannot be removed under a live shell
 *    anyway, so this is git's precondition, not ceremony.
 *  - `releaseOwnedWorktreeForRemoval`'s ownership + `assertRemovalOccupancyFree` check — it is what
 *    stops this door releasing a checkout some OTHER agent is quarantining.
 *
 * What is deliberately NOT reused is the engine door's extra `stopAgentSessionForDelete` step. On this
 * path it would be a second run of the same probe → kill → re-probe the cascade just did, and for an
 * entry with no checkout it would add a brand-new way for a dismiss that works today to refuse
 * ("occupancy unverifiable") when tmux is slow. Reusing a gate that does not apply is the ceremony the
 * spec's first non-goal forbids; this one does not apply.
 */
export async function dismissOwnedWorktree(
  deps: Pick<BridgeDeps, "agentWorktrees" | "notify">,
  name: string,
): Promise<DismissedWorktree | undefined> {
  const ports = deps.agentWorktrees;
  const record = ports?.ledger.get(name)?.worktree;
  if (!ports || !record) return undefined;
  // `deleteBranch: true`, the same argument the engine door passes. The shared cascade soft-removes
  // the checkout (dirty files make every end-of-life door refuse) and runs `git branch -d`, so a
  // branch holding commits that are not merged survives and the receipt says so.
  const receipt = await removeAgentWorktree(ports, name, true);
  const released = {
    path: record.path,
    branch: record.branch,
    branchKept: !receipt.branchDeleted,
    alreadyAbsent: receipt.checkoutAlreadyAbsent === true,
  };
  // Said out loud rather than left in a return value nobody reads (t-da80ed): the caller of
  // `dismiss_agent` is usually an agent, and the branch that outlives the checkout is the human's
  // only handle on work that was never merged.
  if (released.branchKept) {
    deps.notify(
      `dismissed '${name}' and removed its worktree; branch '${released.branch}' was KEPT — it holds commits that are not merged`,
      "warn",
    );
  }
  return released;
}

export function dismissReceipt(name: string, released: DismissedWorktree | undefined): string {
  if (!released) return `agent '${name}' dismissed`;
  const checkout = released.alreadyAbsent
    ? `its worktree at ${released.path} was already gone (ownership released)`
    : `its worktree at ${released.path} was removed`;
  const branch = released.branchKept
    ? `branch '${released.branch}' was kept — it holds unmerged commits, or Tachyon did not create it`
    : `branch '${released.branch}' was deleted`;
  return `agent '${name}' dismissed; ${checkout}; ${branch}`;
}

export function outputCapabilities(
  info: Awaited<ReturnType<BridgeDeps["manager"]["list"]>>[number],
  deps: Pick<BridgeDeps, "manager" | "workspaceRoot">,
) {
  const retained = deps.manager.postmortemTail(info.name);
  // t-6a6a00 — after an extension reload the in-memory `retained` cache is gone and a clean-exit
  // dead pane may already have been reaped, but the durable pipe-pane transcript survives both.
  const durable = !info.running && !retained && paneTranscriptExists(deps.workspaceRoot, info.name);
  const canReadOutput = info.running || info.dead || !!retained || durable;
  const readOutputState = info.running ? "live" : info.dead || retained || durable ? "postmortem" : "unavailable";
  // Same identity question Fleet asks: only a Temporary instance can be dismissed; a Saved one always
  // exists in its store and must be removed there. Read off the ROSTER's resolved answer — a Saved
  // agent that has never been started has no ledger row, and asking its instance policy directly would
  // report it as dismissible through the Bridge.
  const canDismiss = info.lifetime === "temporary" && !info.running;
  return {
    canReadOutput,
    readOutputState,
    ...(!canReadOutput ? { readOutputReason: "no live pane or retained postmortem output is available" } : {}),
    canDismiss,
    ...(!canDismiss
      ? { dismissReason: info.lifetime === "saved" ? "Saved Agents (declared in tachyon.yml) must be deleted from config" : "agent is still running" }
      : {}),
  };
}

export function limitText(text: string, maxLines: number, maxBytes: number, alreadyTruncated = false) {
  const originalText = text;
  const lines = text.split("\n");
  let output = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  let truncated = alreadyTruncated || output !== originalText;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = Buffer.from(output, "utf8").subarray(-maxBytes).toString("utf8");
    truncated = true;
  }
  return { output, truncated, maxLines, maxBytes };
}

export async function postmortemTailFor(
  deps: Pick<BridgeDeps, "manager" | "tmux" | "knownSecrets" | "workspaceRoot">,
  name: string,
  lines: number,
) {
  const retained = deps.manager.postmortemTail(name, lines); // already redacted at capture time (AgentManager)
  if (retained) return { ...retained, source: "retained" };
  const session = deps.manager.session(name);
  if (await deps.tmux.hasSession(session)) {
    try {
      const output = redactSecrets(await deps.tmux.capturePane(session, lines), deps.knownSecrets?.());
      const limited = limitText(output, lines, AgentManager.POSTMORTEM_MAX_BYTES);
      return { text: limited.output, truncated: limited.truncated, maxLines: limited.maxLines, maxBytes: limited.maxBytes, source: "tmux" };
    } catch {
      return undefined;
    }
  }
  // t-6a6a00 — no live session and nothing retained in memory (e.g. an extension reload dropped the
  // cache, or the row was never a clean-exit dead pane): fall back to the durable pipe-pane transcript.
  const durable = readPaneTranscript(deps.workspaceRoot, name, { knownSecrets: deps.knownSecrets?.(), maxLines: lines, maxBytes: AgentManager.POSTMORTEM_MAX_BYTES });
  if (durable) return { ...durable, source: "durable" };
  return undefined;
}

export async function deliverNoticeFallback(deps: BridgeDeps, session: string, line: string, agent?: string): Promise<NoticeDeliveryResult> {
  if (typeof deps.tmux.sendSubmittedLine === "function") {
    // t-8d190f — confirm rather than assume. Without a Workspace this is the path notify_agent takes,
    // so it is exactly where an unsubmitted line used to be reported as delivered.
    const receipt = await deps.tmux.sendSubmittedLine(session, line, {
      composer: composerProfileFor(agent ? deps.manager.defOf(agent)?.cmd : undefined),
    });
    if (receipt.status === "submit-unconfirmed") {
      return { status: "submit-unconfirmed", submitReason: receipt.reason };
    }
  } else {
    await deps.tmux.sendKeys(session, line, true);
  }
  return { status: "notified" };
}

/**
 * t-ea86e6 — best-effort notice fired from update_task when a patch assigns a task to a live agent.
 * Same liveness gate notify_agent uses (kindOf === "agent" + hasSession); silently skips a terminal,
 * unknown, or stopped target — assignment must not depend on whether the assignee happens to be online.
 * Never throws: a delivery failure must not surface as an update_task error.
 */
export async function notifyTaskAssignee(deps: BridgeDeps, assignee: string, task: { id: string; title: string }): Promise<void> {
  try {
    if (deps.manager.kindOf(assignee) !== "agent") return;
    const session = deps.manager.session(assignee);
    if (!(await deps.tmux.hasSession(session))) return;
    const line = `[tachyon] task ${task.id} assigned to you: ${task.title}. Open it with get_task("${task.id}") and begin it.`;
    if (deps.deliverNotice) {
      await deps.deliverNotice(assignee, line);
    } else {
      await deliverNoticeFallback(deps, session, line);
    }
  } catch {
    // best-effort — assigning a task must never fail because notifying the assignee did.
  }
}

export async function notifyTaskJournalAppended(deps: BridgeDeps, task: { id: string; title: string; assignee?: string; status: string }, author: string): Promise<void> {
  if (!task.assignee || task.assignee === author || task.status !== "active") return;
  await notifyTaskAssignee(deps, task.assignee, { id: task.id, title: `journal updated: ${task.title}` });
}

export function resolvedJournalAuthor(deps: Pick<BridgeDeps, "caller">): string {
  const caller = deps.caller ?? { kind: "legacy" as const };
  if (caller.kind !== "agent" && caller.kind !== "human" && caller.kind !== "external" && caller.kind !== "master") {
    throw new Error("CALLER_REQUIRED: append_task_note requires a Bridge-resolved caller; legacy sessions cannot journal");
  }
  const name = caller.kind === "agent" ? caller.name : caller.kind;
  if (!name) throw new Error("CALLER_REQUIRED: append_task_note requires a concrete caller identity");
  return name;
}

export function taskNotificationActor(deps: Pick<BridgeDeps, "caller">): string {
  const caller = deps.caller ?? { kind: "legacy" as const };
  return caller.kind === "agent" ? (caller.name ?? "agent") : caller.kind;
}

export function emitTaskNotification(deps: BridgeDeps, event: TaskNotificationEvent): void {
  try {
    deps.onTaskNotificationEvent?.(event);
  } catch {
    // A successful task mutation must not fail because its human-facing toast could not be delivered.
  }
}

/**
 * t-48f504 — undo a board claim whose launch then failed, returning the row to exactly the status and
 * assignee the claim decision read.
 *
 * Best-effort by construction, and loud when it cannot: the caller is already being handed the spawn
 * failure, and replacing that with a rollback error would hide the thing it actually asked about. But
 * a claim left standing for an agent that does not exist is a board that lies, so the human hears it
 * through `notify` rather than nowhere.
 */
export async function releaseSpawnClaim(deps: BridgeDeps, claimed: Task, prior: Task): Promise<void> {
  try {
    const released = await deps.tasks.update(claimed.id, {
      status: prior.status,
      assignee: prior.assignee ?? null,
      expect: { updatedAt: claimed.updatedAt },
    });
    deps.onTasksChanged?.({ reason: "task-mutated", id: released.id });
    emitTaskNotification(deps, { type: "statusChanged", task: released, actor: taskNotificationActor(deps), from: "active", to: prior.status });
  } catch (error) {
    deps.notify(
      `task '${claimed.id}' was claimed for agent '${claimed.assignee ?? "?"}' whose spawn then failed, and the claim ` +
        `could not be released (${error instanceof Error ? error.message : String(error)}); the board shows work for an ` +
        "agent that is not running — return it to " + `'${prior.status}' by hand`,
      "warn",
    );
  }
}

// t-384a3f — the Bridge is stateless-per-request (registerTools runs once per POST, see Bridge.ts's
// createMcp), so the concurrency gate can't live as a local inside registerTools — it would reset on
// every call and cap nothing. Keyed by AgentManager (one stable instance per workspace/Bridge, same
// lifetime as TmuxService's own op queue it's protecting) so concurrent requests across the whole
// workspace share one gate, never leaking across unrelated Bridge instances (e.g. separate tests).
export const waitOutputGates = new WeakMap<AgentManager, WaitOutputConcurrencyGate>();
export function waitOutputGateFor(manager: AgentManager): WaitOutputConcurrencyGate {
  let gate = waitOutputGates.get(manager);
  if (!gate) {
    gate = new WaitOutputConcurrencyGate();
    waitOutputGates.set(manager, gate);
  }
  return gate;
}

/** The Bridge tools. Schema-validated MCP handlers over AgentManager and workspace services. */
