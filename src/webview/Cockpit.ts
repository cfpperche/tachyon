import * as vscode from "vscode";
import { controlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { sharedGlobalSettings } from "../config/globalSettings.js";
import type { CockpitGlobalSettingsState } from "../cockpit/model.js";
import * as fs from "node:fs";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { resolveCockpitSection } from "../cockpit/resolveSection.js";
import {
  routes,
  routeKey,
  decodePanelState as decodeCockpitPanelState,
  navSection,
  isSection,
  type CockpitRoute,
  type CockpitNonStudioRoute,
  type CockpitPanelState,
} from "../cockpit/route.js";
import { markCockpitSingletonClaimed, clearCockpitSingletonClaim } from "./cockpitSingleton.js";
import { PanelWorkGate, panelVisibility, type CatchUpDecision } from "./shared/panelWorkGate.js";
import { READY } from "./shared/ready.js";
import {
  buildCockpitModel,
  formatCockpitDiagnostics,
  type CockpitModel,
  type CockpitSectionId,
  type CockpitWorkspaceBundle,
  COLLECT_EVERYTHING,
  collectNeedsFor,
  type CockpitCollectNeeds,
} from "../cockpit/model.js";
import {
  initMessage,
  modelMessage,
  routePendingMessage,
  routeReadyMessage,
  toastMessage,
  type CockpitAction,
  type CockpitStrings,
} from "./cockpit/messages.js";
import type { WorkspaceMissionControlTarget } from "../shell/MissionControlTarget.js";
import type { WorkspacePresentationTarget, WorkspaceProbePresentationTarget } from "../shell/WorkspacePresentation.js";
// SDD 485 C5 — the Board's own envelope no longer travels through Control: the board is a standalone app
// (`src/webview/BoardPanel.ts`) and its `snapshot`/`taskError` messages belong to that panel's client, the
// same way C4's moved to `TaskDetailPanel.ts` one commit earlier.
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";
import { startActivityFeed, type ActivityFeed } from "../cockpit/activityFeed.js";
import type { WorkspaceActivityTarget } from "../shell/ActivityTarget.js";
import {
  activityMessage,
  imageDataMessage,
  shareAgentTargetsMessage,
  SHARE_EXTERNAL,
  COPY_SHARE_TEXT,
  SHARE_TO_AGENT,
  type ActivityWebviewMessage,
  type ExternalShareChannel,
} from "./activity/messages.js";
import { withActivityShareKeys, resolveActivityShare, internalSharePrompt } from "../activity/activityShare.js";
import type { ActivityViewModel } from "../activity/activityView.js";
import { probesMessage } from "./probes/messages.js";
import { handoffMessage, type HandoffAction } from "./handoff/messages.js";
import type { HandoffViewModel, HandoffNoteVM, HandoffDistillTargetVM } from "./handoff/handoffViewModel.js";
import { HANDOFF_DISTILL_PROFILES, normalizeAdditionalInstruction, normalizeHandoffDistillArgs } from "../handoff/distill.js";
import { parseHandoffDistillInputV1, type HandoffDistillInputV1 } from "../runtime-api/handoffCommands.js";
import type { WorkspaceHandoffTarget } from "../shell/HandoffTarget.js";
import {
  approvalsMessage,
  approvalErrorMessage,
  type ApprovalAction,
} from "./approval/messages.js";
import { buildApprovalViewModel } from "./approval/viewModel.js";
import { buildValidationsViewModel } from "./validations/viewModel.js";
// SDD 485 D4 — the Saved Agent proposal/removal reads, their digest source and the pending-approval
// projection all left with the Inbox renderer: this file was their only caller, because the Inbox was
// the only surface that decided them. They are `HumanInboxPanel.ts`'s imports now.
import type { HumanInboxKind } from "../humanInbox/model.js";
import { parseCardTemplate } from "../sidebar/cardTemplate.js";
import {
  validationsMessage,
  validationErrorMessage,
  type ValidationsAction,
} from "./validations/messages.js";
import type { ApprovalDecision } from "../bridge/approvalRequest.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import { isStudioRoute, parentRoute } from "../cockpit/route.js";
import {
  reconcileStudioTeardown,
  stopStudioBinding,
  ensureStudioBinding,
  handleStudioMessage,
  handleStudioNavCheckpointAck,
  beginStudioNavTransaction,
  currentStudioBindingFor,
  refreshStudioReferenceData,
  sendStudioLoad,
  type StudioRoute,
} from "../cockpit/studioHost.js";
import { makeStudioAdapterFactory, makeStudioDomainDispatch, type CockpitStudios } from "../cockpit/studioRegistry.js";
export type { CockpitStudios };

export const COCKPIT_VIEW_TYPE = "tachyonCockpit";

// t-610705 (Phase C.0) — the persisted-state shape (schemaVersion 1|2, decode boundary) now lives
// in src/cockpit/route.ts alongside the route it carries; re-exported here so extension.ts's
// `import type { CockpitPanelState } from "./webview/Cockpit.js"` stays unchanged.
export type { CockpitPanelState };
export { decodeCockpitPanelState };

/**
 * Task-store wiring Control still needs after SDD 485 C5 moved the Board out into its own app.
 *
 * The name is kept rather than churned: `getWorkspaces` is what the Validations section resolves its own
 * workspace through, and `openTaskStudio`/`onTasksChanged` are what the Board app and the studio routes use.
 * What left with the Board is the RENDERING, not this dependency.
 */
export interface CockpitMissionBoard {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  /**
   * t-610705 (Phase D, D2) — Task Studio isn't migrated yet (it shares StudioPanelManagerBase with 8
   * other panels; deferred to its own design pass). Since SDD 485 C4/C5 it is called by the task-detail APP
   * and the Board APP through the same extension.ts wiring, not by a Control-native surface.
   * Typed on the shared WorkspacePresentationTarget base (not the narrower WorkspaceMissionControlTarget)
   * since the task-detail route also calls this with its own WorkspaceTaskDetailTarget — the real
   * implementation (extension.ts) only ever needs `wsHash` to look up the underlying workspace.
   */
  openTaskStudio: (ws: WorkspacePresentationTarget, id?: string) => void;
  onTasksChanged: () => void;
}

export interface CockpitApprovals {
  getWorkspaces: () => WorkspacePresentationTarget[];
  resolve: (wsHash: string, id: string, decision: ApprovalDecision) => Promise<void>;
}

export interface CockpitValidations {
  getWorkspaces: () => WorkspaceMissionControlTarget[];
  onValidationsChanged: () => void;
}

/** t-610705 (Phase C.3) — Project Handoff folds into a section (no new route kind — the plan.md
 *  distinction from Fleet's subroutes: Handoff is workspace-scoped like Approvals/Validations, not
 *  an entity with its own immutable locator). WorkspaceHandoffTarget already carries everything the
 *  host needs — same minimal-wrapper shape as CockpitTaskDetail/CockpitActivity/CockpitProbes. */
export interface CockpitHandoff {
  getWorkspaces: () => WorkspaceHandoffTarget[];
}

/**
 * SDD 485 C4 — what Control still needs from the task detail, now that it does not render one.
 *
 * `getWorkspaces` stays for ONE reason: the attachments local-resource grant at panel creation, which Task
 * Studio's rich-doc editor also depends on. The reading/mutating half went to `TaskDetailPanel.ts`.
 *
 * `openDocument` is the whole of the new relationship: Control asks for a task's own editor tab, and the
 * `wsHash` it passes is the document's identity from that moment on — never re-derived from Control's shell
 * scope afterwards.
 */
export interface CockpitTaskDetail {
  getWorkspaces: () => WorkspaceTaskDetailTarget[];
  openDocument: (wsHash: string, taskId: string) => void;
  openEditDocument?: (wsHash: string, taskId: string) => void;
}
export interface CockpitPinDetail {
  openDocument: (wsHash: string, pinId: string) => void;
  openEditDocument: (wsHash: string, pinId: string) => void;
}

/** t-610705 (Phase C.2) — one agent's normalized activity feed, a subroute of Fleet. */
export interface CockpitActivity {
  getWorkspaces: () => WorkspaceActivityTarget[];
}

/** t-610705 (Phase C.2) — captured probe runs, a subroute of Fleet. */
export interface CockpitProbes {
  getWorkspaces: () => WorkspaceProbePresentationTarget[];
}


/**
 * Control — editor visual hub.
 * Embedded product surfaces: Approvals, Inbox, Runtime Ops,
 * plus rich native Fleet / Worktrees / Settings modules.
 * NOT embedded: Task Detail/Studio, Pins, form studios (Agent/Terminal/Command/Runbook/Schedule).
 * Schedules stay in the sidebar (not a Control tab).
 */
export interface CockpitDeps {
  extensionUri: vscode.Uri;
  /** t-af3eef — `needs` says which expensive slices this view consumes; omitted means everything. */
  collect: (needs?: CockpitCollectNeeds) => Promise<CockpitWorkspaceBundle[]>;
  missionBoard: CockpitMissionBoard;
  taskDetail: CockpitTaskDetail;
  pinDetail?: CockpitPinDetail;
  activity: CockpitActivity;
  probes: CockpitProbes;
  handoff: CockpitHandoff;
  /** t-610705 (Phase D) — StudioPanelManagerBase-based editors migrated onto a Control route
   *  (studios-routes-design.md). D0 only wires `studio:"command"`; D1-D3 add the rest onto the SAME
   *  getWorkspaces() list (WorkspaceStudioTarget already covers command/terminal/runbook/schedule/
   *  agent uniformly — task/pin need their own narrower CockpitDeps entries when their PR lands). */
  studios: CockpitStudios;
  approvals: CockpitApprovals;
  validations: CockpitValidations;
  /*
   * SDD 485 D4 — the two Saved Agent commit ports (`approveSavedAgentProposal`, SDD 482 phase 4C, and
   * `approveSavedAgentRemoval`, t-afe120) left with the Inbox renderer, because the Inbox was their only
   * caller: they are what an APPROVAL on that surface redeems. They are `HumanInboxDeps`' now, still
   * optional for the same reason — a host that has not wired one says so out loud rather than accepting a
   * click and doing nothing — and still supplied by the extension, never reachable from the Bridge.
   */
  /**
   * SDD 485 D3 — open (or reveal) the Runtime Ops APP. Control no longer renders Runtime Ops, so the
   * doors it still owns for that screen — Overview's Jump card and a persisted/deep-linked
   * `section:runtime` — leave Control instead of navigating inside it. Takes NO argument, like D1's
   * `openTmux` and unlike D2's `openPlugins`: `window` cardinality is precisely the statement that this
   * screen is not about a project, so there is nothing to key it on.
   */
  openRuntimeOps: () => void;
  /** SDD 485 D8 — open Runtime Config as a project dashboard. */
  openRuntimeConfig: (wsHash?: string) => void;
  /** SDD 485 D9 — open Execution as a project dashboard. */
  openExecutionGraph: (wsHash?: string) => void;
  /**
   * SDD 485 D4 — open (or reveal) the Human Inbox APP for one project. Control no longer renders the
   * Inbox, so the doors it still owns for that screen — Overview's "Waiting on you" metric, its Jump
   * card, and a persisted/deep-linked `section:inbox` — leave Control instead of navigating inside it.
   * Takes the project, like D2's `openPlugins`: `dashboard` cardinality is one panel PER PROJECT,
   * because everything this surface reads is rooted at one workspace root.
   */
  openHumanInbox: (wsHash?: string) => void;
  /**
   * SDD 485 D4 — the same app, landing on ONE ITEM. `inbox-item` is a subroute INSIDE the app rather
   * than an app of its own (the queue is a thing a human works down, and two items side by side is a
   * product decision nobody asked for), so this is not a second panel: it opens or reveals that
   * project's panel and navigates it, which is exactly what Control did to its single panel.
   */
  openHumanInboxItem: (wsHash: string, itemKind: HumanInboxKind, itemId: string) => void;
  /**
   * SDD 485 D2 — open (or reveal) the Plugins APP for one project. Control no longer renders Plugins, so
   * the doors it still owns for that screen — Overview's Jump card and a persisted/deep-linked
   * `section:plugins` — leave Control instead of navigating inside it. Takes the project, because
   * `dashboard` cardinality is one panel PER PROJECT and that project is half the panel's key. Sibling of
   * C5's `openBoard` and D1's `openTmux`.
   */
  openPlugins: (wsHash?: string) => void;
  /**
   * SDD 485 D1 — open (or reveal) the tmux APP. Control no longer renders the inspector, so the two doors
   * it still owns for that screen — Overview's Jump card and a persisted/deep-linked `section:tmux` — leave
   * Control instead of navigating inside it. No argument: `window` cardinality means there is exactly one
   * panel and nothing to key it on. Sibling of C4's `taskDetail.openDocument` and C5's `openBoard`.
   */
  openTmux: () => void;
  /**
   * SDD 485 C5 — open (or reveal) the Board APP for a project. Control no longer renders the board, so every
   * "go to the Board" affordance it still owns — Overview's Jump card, Fleet's action, the launcher tile —
   * leaves Control instead of navigating inside it. `wsHash` is the project Control's own scope resolves to;
   * the app keys its panel on it. Sibling of C4's `taskDetail.openDocument`, and for the same reason.
   */
  openBoard: (wsHash?: string) => void;
  /** SDD 485 D7 — open Fleet as a project dashboard; persisted/deep-linked section routes redirect. */
  openFleet: (wsHash?: string) => void;
  openSettings: () => void;
  openOverview: (wsHash?: string) => void;
  openDoctor: () => void;
  revealPath: (fsPath: string) => void;
  openConfigFile: (wsHash?: string) => Promise<void>;
  /** SDD 414 — settings.companion.tabTools for one workspace engine. */
  setCompanionTabTools: (wsHash: string, enabled: boolean) => Promise<void>;
  /** t-585d5c — write the idle-notification window; `undefined` resets to the product default. */
  setIdleAfterMinutes: (wsHash: string, minutes?: number | "never") => Promise<void>;
  /** SDD 420 — settings.companion.allowedHosts for one workspace engine. */
  setCompanionAllowedHosts: (wsHash: string, hosts: string[]) => Promise<void>;
  /** SDD 414/422 — host-authoritative unpair; deviceId clears one row, omit clears all. */
  unpairCompanionDevice: (wsHash: string, deviceId?: string) => Promise<void>;
  /**
   * SDD 414 — mint short-lived pair code + baseUrl (same as tachyon.pairCompanion / companion.pair-code).
   * Result is pushed as a one-shot webview message — not polled into CockpitModel.
   */
  issueCompanionPairCode: (wsHash: string) => Promise<{
    ok: true;
    code: string;
    baseUrl: string;
    baseUrls?: string[];
    expiresAt: string;
    protocolVersion?: number;
    prefix?: string;
    qrPayload?: string;
    openUrl?: string;
    qrDataUrl?: string;
  } | { ok: false; reason: string }>;
}

export function cockpitStrings(): CockpitStrings {
  const t = vscode.l10n.t;
  return {
    title: t("Control"),
    subtitle: t("Project sysadmin"),
    navOverview: t("Overview"),
    navEngine: t("Engine"),
    navFleet: t("Fleet"),
    navInbox: t("Inbox"),
    navApprovals: t("Approvals"),
    navMission: t("Board"),
    navValidations: t("Validations"),
    navHandoff: t("Handoff"),
    navWorktrees: t("Worktrees"),
    navRuntime: t("Runtime Ops"),
    navRuntimeConfig: t("Runtime Config"),
    navTmux: t("tmux"),
    navPlugins: t("Plugins"),
    navSettings: t("Settings"),
    back: t("Back"),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon workspace attached in this window."),
    copyDiagnostics: t("Copy diagnostics"),
    openMissionControl: t("Open Board"),
    openSettings: t("Open Settings"),
    openDoctor: t("Run Doctor"),
    copied: t("Diagnostics copied"),
    overviewTitle: t("Overview"),
    overviewHint: t("Health snapshot. Fleet = agents (sidebar); Board = work queue."),
    engineTitle: t("Engine / Bridge"),
    fleetTitle: t("Fleet"),
    fleetHint: t("Agents (runtime) — start, stop, terminal, activity. Work items are on the Board."),
    approvalsTitle: t("Approvals"),
    approvalsHint: t("Human gates that block the fleet (embedded)."),
    missionTitle: t("Board"),
    missionHint: t("Work queue — tasks and lanes. Agents live in the sidebar Fleet."),
    validationsTitle: t("Validations"),
    validationsHint: t("Validation queue — close dogfoods and checks (not on the Board)."),
    navExecutionGraph: t("Execution"),
    settingsTitle: t("Settings"),
    settingsHint: t("Personal machine preferences and shared project policy — two files, two authorities."),
    workspaces: t("Workspaces"),
    engines: t("Engines"),
    agents: t("Agents"),
    errors: t("Errors"),
    bridges: t("Bridges"),
    approvals: t("Approvals"),
    inbox: t("Waiting on you"),
    worktrees: t("Worktrees"),
    attached: t("attached"),
    error: t("error"),
    none: t("none"),
    state: t("State"),
    pid: t("PID"),
    version: t("Version"),
    instance: t("Instance"),
    started: t("Started"),
    bundle: t("Bundle"),
    protocol: t("Protocol"),
    url: t("URL"),
    port: t("Port"),
    auth: t("Auth"),
    root: t("Root"),
    hash: t("Hash"),
    running: t("running"),
    stopped: t("stopped"),
    checkedAt: t("Checked"),
    navLoading: t("Loading…"),
    navStalled: t("This is taking longer than expected."),
    navRetry: t("Retry"),
    open: t("Open"),
    noneListed: t("Nothing listed for this workspace yet."),
    kind: t("Kind"),
    branch: t("Branch"),
    status: t("Status"),
    phase: t("Phase"),
    path: t("Path"),
    name: t("Name"),
    start: t("Start"),
    stop: t("Stop"),
    openTerminal: t("Terminal"),
    openActivity: t("Activity"),
    openProbes: t("Probes"),
    editAgent: t("Edit"),
    continueTask: t("Continue task in…"),
    continueTaskPickTitle: t("Continue task from {0} in…"),
    continueTaskPickSubtitle: t(
      "Starts a new session on the destination with a focused handoff — not a native resume of the source session.",
    ),
    continueTaskPickPlaceholder: t("Filter destination agents…"),
    continueTaskPickEmpty: t("No other declared agent to continue into"),
    continueTaskDestStopped: t("stopped"),
    continueTaskDestRunning: t("running — stop first"),
    continueTaskDestDetail: t("New session with focused handoff from {0}"),
    continueTaskNoDest: t("No other declared agent to continue into (need a stopped destination)."),
    reveal: t("Reveal"),
    copyPath: t("Copy path"),
    copyId: t("Copy id"),
    openConfig: t("Open workspace settings"),
    // t-7b4bb5 — two authorities, named so the dual open buttons do not look like a split mind.
    settingsBody: t(
      "Tachyon keeps two settings files on purpose: one for you on this machine, one for the project shared with the team. They own different knobs — they are not two places for the same list.",
    ),
    settingsScopeGlobalTitle: t("Global (personal)"),
    settingsScopeGlobalHint: t(
      "Your machine preferences — agent pane, git path, Activity theme. Not committed; recovery path when Control will not open.",
    ),
    settingsScopeWorkspaceTitle: t("Workspace (project)"),
    settingsScopeWorkspaceHint: t(
      "Shared project policy in tachyon.yml — agents, agent limit, memory cap, schedules, Companion, idle notify, worktree reveal. Versioned with the repo, so the whole team gets it.",
    ),
    settingsFileLabel: t("File:"),
    settingsOpenTachyon: t("Open global settings"),
    settingsOpenConfig: t("Open workspace settings"),
    settingsDoctor: t("Run Doctor"),
    settingsWritesTo: t("Writes to"),
    settingsWritesToEither: t("Writes to either — you pick below"),
    settingsWritesToNothing: t("Reads only"),
    cardTemplateTitle: t("Agent card layout"),
    cardTemplateHint: t("Choose which elements an agent card shows, and in what order."),
    cardTemplateComposer: t("Choose the elements"),
    cardTemplateBody: t("Compose a layout here, watch the real card update, then paste the YAML into tachyon.yml. Nothing is saved from this block."),
    cardTemplateYamlHint: t("Paste this under your workspace's tachyon.yml. Regions you did not change are left out, so they follow the default."),
    cardTemplateCopy: t("Copy YAML"),
    cardTemplateReset: t("Reset to default"),
    cardTemplateCriticalNote: t("shown anyway when a row is in this state"),
    cardTemplateInlineNote: t("renders inside another element"),
    // SDD 479 phase 5 — ratified fork 1 made this sentence part of the feature: without it, a
    // personal override quietly contradicting the project reads as a broken project template.
    cardTemplateInEffect: t("In effect right now:"),
    cardTemplatePersonalActive: t("your personal override in your Tachyon settings file — it wins over every project template below"),
    cardTemplatePersonalRefused: t("your personal override was REFUSED and ignored; the cards fall back to each project's template"),
    cardTemplatePersonalNone: t("no personal override — each project's own template decides"),
    cardTemplateProjectNone: t("uses Tachyon's default card"),
    cardTemplateProjectConfigured: t("has its own template in tachyon.yml"),
    cardTemplateProjectRefused: t("its tachyon.yml template was refused; showing the default card"),
    cardTemplateHomeLabel: t("Write this layout to:"),
    cardTemplateHomeProject: t("This project (tachyon.yml)"),
    cardTemplateHomePersonal: t("Just me (Tachyon settings file)"),
    cardTemplateCopyJson: t("Copy JSON"),
    cardTemplateJsonHint: t("Paste this under \"sidebar\": { \"cardTemplate\": ... } in your Tachyon settings file. It applies to every project you open, and wins over their templates; regions you did not change keep whatever each project chose."),
    cardTemplateOpenSettings: t("Open settings"),
    companionTitle: t("Companion"),
    companionHint: t("Pair Tachyon Companion and opt-in first-person browser tools for agents (user_browser_*)."),
    companionBody: t(
      "When tab tools are on, agents see user_browser_* on the Bridge. Pairing Companion is still required to run them. Generate a pair code here (or via the command palette).",
    ),
    companionTabTools: t("List Companion tab tools for agents"),
    companionTabToolsHelp: t("Writes settings.companion.tabTools in tachyon.yml and refreshes the Bridge tool list."),
    companionAllowedHosts: t("Allowed hosts (optional)"),
    companionAllowedHostsHelp: t(
      "One host or glob per line (example.com, *.herokuapp.com). Empty = all hosts. Writes settings.companion.allowedHosts in tachyon.yml.",
    ),
    companionAllowedHostsPlaceholder: t("example.com\n*.herokuapp.com"),
    // t-585d5c — the unit and the bounds are IN the strings, because a bare number field is where a
    // person guesses seconds and gets minutes.
    idleNotifyTitle: t("Idle agent notifications"),
    idleNotifyHelp: t(
      "How long a child agent may sit idle before Tachyon notifies its parent. 1-10080 minutes (7 days). Writes settings.agentNotifications.idleAfterMinutes in tachyon.yml and applies on the next check — no restart.",
    ),
    idleNotifyUnit: t("minutes"),
    idleNotifyUsingDefault: t("Using the default ({0} min) — nothing written in tachyon.yml"),
    idleNotifyOff: t("Notifications are off for this workspace"),
    idleNotifyOffLabel: t("Turn notifications off"),
    idleNotifySave: t("Save"),
    idleNotifyReset: t("Back to default"),
    // t-aaad95 — Control -> Settings edits BOTH scopes now that VS Code contributes nothing.
    globalSettingsTitle: t("Your Tachyon settings"),
    globalSettingsHint: t("Per-person, per-machine. Kept in a plain file you can also edit by hand — that file is the recovery path when Control itself will not open."),
    globalSettingsFileLabel: t("File:"),
    globalSettingsOpenFile: t("Open global settings"),
    globalSettingsRefused: t("This file was refused and the last good version is in use — fix it and it reloads by itself:"),
    globalSettingsCodeTheme: t("Activity code theme"),
    globalSettingsCodeThemeHelp: t("Syntax-highlight palette for code blocks in Activity."),
    globalSettingsCodeThemeAuto: t("Follow the editor"),
    globalSettingsCodeThemeDark: t("Dark"),
    globalSettingsCodeThemeLight: t("Light"),
    globalSettingsAgentPane: t("Agent pane"),
    globalSettingsAgentPaneHelp: t("The first-party agent pane. The integrated terminal stays available either way."),
    globalSettingsGitPath: t("Path to git"),
    globalSettingsGitPathHelp: t("Leave empty to use the git extension's git.path, then common install locations, then git on PATH."),
    globalSettingsSave: t("Save"),
    globalSettingsLive: t("takes effect immediately"),
    globalSettingsNeedsReopen: t("applies the next time Control is opened"),
    workspaceSettingsTitle: t("This project's settings"),
    workspaceSettingsHint: t("Agent limit, memory cap, task notifications and worktree reveal live in tachyon.yml, so they travel with the repo and the whole team gets them."),
    companionAllowedHostsSave: t("Save allowed hosts"),
    companionPaired: t("Paired"),
    companionNotPaired: t("Not paired"),
    allWorkspaces: t("All workspaces"),
    companionPickWorkspace: t("Select a single workspace in Overview to manage Companion settings."),
    companionBaseUrl: t("Engine Base URL"),
    companionShowPairCode: t("Show pair code"),
    companionCopyBaseUrl: t("Copy URL"),
    companionPairCodeLabel: t("Code"),
    companionPairUrlLabel: t("URL"),
    companionPairExpires: t("Expires"),
    companionPairExpired: t("Code expired — generate a new one."),
    companionCopyCode: t("Copy code"),
    companionCopyUrl: t("Copy URL"),
    companionCopyAll: t("Copy all"),
    companionNewCode: t("New code"),
    companionPairUnavailable: t("Companion pairing unavailable — ensure the Bridge is listening."),
    companionPairQrLabel: t("Mobile QR"),
    companionPairQrHint: t(
      "Scan with your phone camera — opens Companion Mobile and pairs automatically. PC and phone must be on the same Tailscale tailnet (settings.companion.lanAccess: true).",
    ),
    companionPairCandidatesLabel: t("URL"),
    companionCopyPayload: t("Copy QR payload"),
    companionLanAccessHint: t(
      "Mobile uses Tailscale only (not raw Wi‑Fi IPs). Install Tailscale on PC + phone, same account/tailnet, then generate a code.",
    ),
    devicesTitle: t("Connected devices"),
    devicesHint: t("Companion devices paired to this workspace engine (browser or mobile)."),
    devicesEmpty: t("No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh."),
    devicesUnpair: t("Unpair"),
    devicesLive: t("Live"),
    devicesOffline: t("Offline"),
    devicesKindBrowser: t("Browser"),
    devicesKindMobile: t("Mobile"),
    devicesPairedAt: t("Paired"),
    // SDD 482 phase 5 (`t-5e1113`) — the ratified product vocabulary; these two badges are the whole
    // user-visible surface for the distinction.
    //
    // t-4cc561 updated the claim that used to sit here. It said every OTHER occurrence of "declared"
    // or "ad-hoc" was a frozen field/config/wire value, so the rename was two lines and not a sweep.
    // That stopped being true: the species names are now gone from identifiers, comments and copy
    // across the shell and engine. What IS still frozen, deliberately, is the narrow set that crosses
    // a boundary — the sidebar wire's `adhoc` flag, the `mode: "adhoc"` handoff discriminant, and the
    // ledger's persisted shape. Those are renamed only with a protocol bump, never as nomenclature.
    saved: t("Saved"),
    temporary: t("Temporary"),
    agent: t("agent"),
    change: t("change"),
  };
}

let panel: vscode.WebviewPanel | undefined;
let currentRoute: CockpitRoute = routes.section("overview");
/**
 * t-610705 (Phase D, D3) — the last COMMITTED route that was NOT itself a studio route, tracked
 * separately from `currentRoute` (design-dueto probe-43bca1cc blockers): a pin's `returnRoute` must
 * survive re-entry to the SAME pin (routeKey-based idempotent re-entry never re-derives it from
 * `currentRoute`, which would already be the pin route itself) and chained pin↔other-studio
 * navigation (an intervening studio visit must not overwrite it). Reset to the Overview default
 * whenever a panel is disposed (see the `onDidDispose` handler below) so a later fresh panel never
 * inherits a disposed panel's provenance.
 */
let lastCommittedNonStudioRoute: CockpitNonStudioRoute = routes.section("overview");
/**
 * t-610705 (Phase C.0) — bumped on every route change AND every workspace-scope change (both are
 * "the world changed" events). Async send*() functions capture this at the start and re-check it
 * after their awaits; a mismatch means a newer navigation/scope-switch has superseded this call,
 * so its result must be discarded rather than posted (closes the router design dueto's "out-of-
 * order module pushes can render data for the wrong route" finding). Replaces the old
 * mission-only `missionGeneration` counter with one mechanism shared by every section.
 */
let navEpoch = 0;

/**
 * t-610705 (Phase D, D3) — captures `lastCommittedNonStudioRoute` into a pin route's own
 * `returnRoute` slot at the moment it commits, IF one hasn't already been captured (a persisted/
 * revived pin route already carries its own real returnRoute — never overwritten). Every other
 * studio's `returnRoute` stays `null` (never read — `studioParentSection` answers their parent).
 */
function captureReturnRoute(route: CockpitRoute): CockpitRoute {
  if (!isStudioRoute(route) || route.studio !== "pin" || route.returnRoute !== null) return route;
  return { ...route, returnRoute: lastCommittedNonStudioRoute };
}

/**
 * SDD 485 C4 — how Control opens a task's document. Set from `deps.taskDetail.openDocument` when a panel is
 * created, because `navigate()` is module-scoped and has no `deps` in reach; cleared with the panel.
 */
let openTaskDocument: ((wsHash: string, taskId: string) => void) | undefined;
let openTaskEditDocument: ((wsHash: string, taskId: string) => void) | undefined;
let openPinEditDocument: ((wsHash: string, pinId: string) => void) | undefined;

/**
 * SDD 485 C5 — the same seam for the Board: `navigate()` is module-scoped and has no `deps` in reach, so the
 * open is bound from `deps.openBoard` when a panel is created and cleared with it.
 */
let openBoardDocument: (() => void) | undefined;

/**
 * SDD 485 D1 — and the same seam for tmux. Third of these, and they are deliberately three plain slots
 * rather than a table: each is bound from a DIFFERENT `deps` member with a different signature (a task
 * takes an identity, the Board takes a project, tmux takes nothing — which is its cardinality showing), so
 * a table would have to erase exactly the distinction Phase D is here to make explicit.
 */
let openTmuxApp: (() => void) | undefined;

/**
 * SDD 485 D2 — and the same seam for Plugins. Fourth of these, and the second to carry a project: a
 * `dashboard` panel opens AGAINST one, which is exactly the distinction a shared table would erase.
 */
let openPluginsApp: (() => void) | undefined;

/**
 * SDD 485 D3 — and the same seam for Runtime Ops. Fifth of these, and the second that takes NOTHING: a
 * `window` app has no project to open against, and the slot's empty signature is that fact showing in the
 * type — the same way `openPluginsApp`'s project shows a dashboard's.
 */
let openRuntimeOpsApp: (() => void) | undefined;
let openRuntimeConfigApp: (() => void) | undefined;
let openExecutionGraphApp: (() => void) | undefined;
let openSettingsApp: (() => void) | undefined;
let openOverviewApp: (() => void) | undefined;

/**
 * SDD 485 D4 — and the same seam for the Human Inbox. Sixth and seventh of these, and the first PAIR:
 * this surface leaves Control with two route kinds rather than one, because its item detail stays a
 * subroute of the app instead of becoming a document. Both land on the same panel — the second one
 * navigates it — which is the shape a `document` app would NOT have had.
 */
let openInboxApp: (() => void) | undefined;
let openInboxItemApp: ((wsHash: string, itemKind: HumanInboxKind, itemId: string) => void) | undefined;
let openFleetApp: (() => void) | undefined;

function navigate(route: CockpitRoute): void {
  if (route.kind === "studio-edit" && route.studio === "task") {
    openTaskEditDocument?.(route.wsHash, route.entityId);
    route = routes.section("overview");
  }
  if (route.kind === "studio-edit" && route.studio === "pin") {
    openPinEditDocument?.(route.wsHash, route.entityId);
    route = routes.section("overview");
  }
  if (route.kind === "task-detail") {
    // SDD 485 C4 — Control has no task-detail renderer any more, so this route can never COMMIT here. It
    // still arrives: from persisted window state written before the cutover, from a deep link, and from
    // Task Studio's breadcrumb (`parentRoute(studio-edit, "task")`). All three mean the same thing now —
    // open that task's own tab.
    //
    // Placed at the ONE commit point every navigation intent reaches (see this function's own contract
    // below) rather than at each caller: a redirect that has to be remembered per call site is a redirect
    // the next caller forgets. This is a shim with NO UI, which is the only kind `spec.md` lets survive an
    // atomic cutover.
    //
    // SDD 485 C5 — it used to land Control on the Board, which was then a section. The Board is an app now,
    // so Control lands on Overview and does NOT also open a Board tab: the human asked for a task, and the
    // task's tab is what just opened. Opening a second panel they did not ask for is not a redirect.
    openTaskDocument?.(route.wsHash, route.taskId);
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "mission") {
    // SDD 485 C5 — and the same for the Board itself. Nine doors could ask Control for it (two commands, the
    // launcher tile, two legacy serializers, a revived route, Overview's Jump card, Fleet's action, a studio
    // exit); guarding each is nine guards and one that gets forgotten. Here it is one, at the point every
    // one of them funnels through, next to C4's for exactly the same reason.
    openBoardDocument?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "fleet") {
    // SDD 485 D7 — Fleet's launcher, Overview jump, subroute breadcrumbs and old section state all
    // converge here. The app opens against Control's current project; Control commits Overview.
    openFleetApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "tmux") {
    // SDD 485 D1 — and the same for tmux. Four doors could ask Control for it (the `tachyon.inspectServer`
    // command, the launcher tile, Overview's Jump card, and a revived/deep-linked `section:tmux`), and the
    // Overview card is the one that proves the placement: it posts `onSetSection("tmux")` from inside the
    // client and never touches extension.ts, so a redirect living in the command wiring would have missed
    // it entirely. Here, every door funnels through one commit point — same reason as C4's and C5's above.
    openTmuxApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "plugins") {
    // SDD 485 D2 — and the same for Plugins. Four doors could ask Control for it (the
    // `tachyon.openPlugins` command, the launcher tile, Overview's Jump card, and a revived/deep-linked
    // `section:plugins`), and the Jump card is again the one that proves the placement: it posts
    // `onSetSection("plugins")` from inside the client and never touches extension.ts. Fourth entry in
    // this block, and the block is now the readable inventory of what has left Control.
    openPluginsApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "runtime") {
    // SDD 485 D3 — and the same for Runtime Ops. Four doors could ask Control for it (the
    // `tachyon.openControlRuntime` command — which `tachyon.showRuntimeUsage` also routes through — the
    // launcher tile, Overview's Jump card, and a revived/deep-linked `section:runtime`). Fifth entry, and
    // by now the block is the readable inventory of what has left Control: task detail, Board, tmux,
    // Plugins, Runtime Ops.
    openRuntimeOpsApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "runtime-config") {
    // SDD 485 D8 — launcher, Overview jump, persisted state and deep links converge at this shim.
    openRuntimeConfigApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "execution-graph") {
    openExecutionGraphApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "settings") {
    // SDD 485 D10 — Settings leaves through the same single commit point as D3-D9. Control commits
    // Overview; malformed/unknown section ids are normalized to Overview before reaching this point.
    openSettingsApp?.();
    route = routes.section("overview");
  }
  if (route.kind === "inbox-item") {
    // SDD 485 D4 — the Inbox's item route, and the FIRST redirect in this block that carries identity
    // rather than only a destination. It still arrives from three places: a `tachyon.openHumanInbox`
    // deep link (the "Review" doorbell, whose whole point is landing on THAT item), persisted window
    // state written before this cutover, and a revived route. All three mean the same thing now — open
    // that project's Inbox tab and show the item on it.
    //
    // Control lands on Overview rather than on `section("inbox")`: chaining into the redirect below
    // would be harmless (same panel) but would say the human asked for two things when they asked for
    // one, and C4 already paid for a redirect that opened a surface nobody requested.
    openInboxItemApp?.(route.wsHash, route.itemKind, route.itemId);
    route = routes.section("overview");
  }
  if (route.kind === "section" && route.section === "inbox") {
    // SDD 485 D4 — and the section itself. Five doors could ask Control for it (the
    // `tachyon.openHumanInbox` command with no target, the launcher tile, Overview's Jump card,
    // Overview's "Waiting on you" METRIC — a second in-client door this screen has and the others did
    // not — and a revived/deep-linked `section:inbox`). Sixth entry in this block, which is by now the
    // readable inventory of what has left Control: task detail, Board, tmux, Plugins, Runtime Ops, Inbox.
    openInboxApp?.();
    route = routes.section("overview");
  }
  // SDD 485 D11 — every legacy landing route, including malformed-section recovery, funnels here.
  // Overview opens in its project dashboard; Control commits a renderer it still owns.
  if (route.kind === "section" && route.section === "overview") {
    openOverviewApp?.();
    route = routes.section("approvals");
  }
  reconcileActivityTeardown(route);
  reconcileStudioTeardown(route);
  currentRoute = captureReturnRoute(route);
  if (!isStudioRoute(currentRoute)) lastCommittedNonStudioRoute = currentRoute;
  navEpoch += 1;
  // t-ac79a7 — announce the committed destination BEFORE any awaited loading. This is the one
  // commit point every navigation intent reaches (requestNavigate's pass-through, the studio
  // transaction's commit closure, onCancelled/onSaved, setSection), so emitting here gives every
  // route kind the pending half of the bracket without a per-route call site to keep in sync.
  // Synchronous by construction: the model push behind it waits on deps.collect(), and the whole
  // point is that the client must not have to wait for that to know the click was accepted.
  panel?.webview.postMessage(routePendingMessage(routeKey(currentRoute)));
}

/**
 * t-610705 (Phase D, D0) — the ONE gate for a navigation intent while `currentRoute` might be a
 * dirty studio form (studios-routes-design.md's navigation-transaction FSM). Every existing
 * `navigate()` call site that represents a NAVIGATION INTENT (as opposed to `navigate()`'s use as
 * the transaction's own commit closure) goes through this instead. Off a non-studio route it's a
 * synchronous pass-through — zero behavior change for every route kind that existed before D0.
 */
async function requestNavigate(route: CockpitRoute, live: vscode.WebviewPanel, afterCommit?: () => Promise<void>): Promise<void> {
  // t-610705 (Phase D, D0) — a same-identity re-entry (reopening the route you're already on — e.g.
  // a repeat command-palette invocation, or a legacy-serializer redirect racing an already-open
  // Control) is a NO-OP for an EDIT route: nothing is actually being navigated away from (same
  // entity), so it must never trigger a dirty-form checkpoint. Matches `ensureStudioBinding`'s/
  // `navigate()`'s own idempotent-on-same-identity convention used everywhere else in this router
  // (found via a test that hung waiting on an unanswered checkpoint for exactly this case).
  //
  // round-5 fix — deliberately NOT extended to "studio-new": every "create a new X" invocation for
  // the same studio+workspace shares the identical routeKey (no entityId to distinguish them), so
  // treating that as "same identity" would silently keep a stale/dirty draft across what the user
  // may intend as a genuinely NEW creation attempt, bypassing the checkpoint entirely. A clean
  // studio-new re-invocation still commits instantly either way (no dirty form == no visible modal),
  // so this only changes behavior for the case that actually needs protecting.
  if (!isStudioRoute(currentRoute) || (route.kind === "studio-edit" && currentRoute.kind === "studio-edit" && routeKey(route) === routeKey(currentRoute))) {
    navigate(route);
    if (afterCommit) await afterCommit();
    return;
  }
  const outcome = await beginStudioNavTransaction(
    { post: (m) => live.webview.postMessage(m), isCurrent: () => panel === live },
    () => navigate(route),
  );
  if (outcome === "busy") {
    notify("Another navigation is already in progress in Control.", "warn");
    return;
  }
  if (outcome === "committed" && afterCommit) await afterCommit();
  // "aborted" (Stay, timeout, or a rejected Save) — currentRoute is untouched, the studio form is
  // still mounted and (per beginStudioNavTransaction's contract) unfrozen; nothing further to do.
}

/** t-d16a39 — the ONE shell-level workspace scope. undefined = "All workspaces" (aggregate
 *  sections aggregate; per-workspace sections fall back to the first workspace). Replaces the
 *  former pair of per-section scope aliases and Plugins' derived fallback. */
let pushApprovals: (() => void) | undefined;
let pushValidations: (() => void) | undefined;
let pushHandoff: (() => void) | undefined;
let pushProbes: (() => void) | undefined;
let pushStudioReferenceData: (() => void) | undefined;
let pushTaskStudioEntity: (() => void) | undefined;
let pushPinStudioEntity: (() => void) | undefined;
let doOpenActivityTranscript: (() => void) | undefined;
let wiredPanel: vscode.WebviewPanel | undefined;

/**
 * SDD 485 B1 — every push Control can be asked to make from OUTSIDE itself (extension.ts's
 * `views-changed` fan-out and the engine-side mutation paths that share it). Navigation, the READY
 * handshake and a webview action are NOT here on purpose: those only happen while a human is looking
 * at the panel, and gating them would delay the very interaction that proves it is visible.
 */
type ControlRefreshKind =
  | "shell-poll"
  | "probes" | "handoff" | "approvals" | "validations"
  | "studio-reference" | "task-studio" | "pin-studio";

function pushControlRefresh(kind: ControlRefreshKind): void {
  switch (kind) {
    case "shell-poll": pushControlPoll?.(); return;
    case "probes": pushProbes?.(); return;
    case "handoff": pushHandoff?.(); return;
    case "approvals": pushApprovals?.(); return;
    case "validations": pushValidations?.(); return;
    case "studio-reference": pushStudioReferenceData?.(); return;
    case "task-studio": pushTaskStudioEntity?.(); return;
    case "pin-studio": pushPinStudioEntity?.(); return;
  }
}

/** SDD 485 B1 — hidden ⇒ journal the invalidation and do nothing. Undefined gate = no panel, and the
 *  push slots are undefined too, so the call is already a no-op — pass it through rather than hide it. */
let controlGate: PanelWorkGate<ControlRefreshKind> | undefined;
/**
 * The shell's own periodic refresh (`sendModel()` + `sendSectionModule()`), wired in `openCockpit`
 * where those live. It is BOTH the client 3s poll's body and the gate's resync branch — the resync
 * is deliberately not a bespoke path but the one Control already runs twenty times a minute.
 */
let pushControlPoll: (() => void) | undefined;
/** Test/instrumentation seam — what the last reveal decided (delta vs resync, and from how deep). */
let lastControlCatchUp: CatchUpDecision<ControlRefreshKind> | undefined;

function refreshControl(kind: ControlRefreshKind): void {
  if (controlGate) controlGate.run(kind, () => pushControlRefresh(kind));
  else pushControlRefresh(kind);
}

/**
 * SDD 485 B2 — the upstream event cursor expired or the engine changed incarnation
 * (`WorkspaceClient.resynced` / `engineChanged`). While Control is hidden its journal can no longer
 * prove what changed, so the reveal must rebuild rather than replay. Called from extension.ts's
 * subscriber, alongside the `refreshAll()` it already did.
 */
export function markControlSourceResync(): void {
  controlGate?.markSourceResync();
}

/** SDD 485 B3 — what the panel is holding back right now, for a guard that counts WORK. */
export function __controlGateProbe(): { visible: boolean; pending: number; lastCatchUp: CatchUpDecision<ControlRefreshKind> | undefined } {
  return { visible: controlGate?.visible ?? false, pending: controlGate?.pending ?? 0, lastCatchUp: lastControlCatchUp };
}

/* SDD 485 C5 — `refreshCockpitMissionBoard()` is gone with the board's renderer, exactly as C4's
 * `refreshCockpitTaskDetail()` went one commit earlier. The fan-out door for the board belongs to
 * `BoardPanelManager.refresh()` now, which extension.ts's `onTasksChanged` calls in its place; leaving a
 * Control-side wrapper behind would be the second live path this cutover exists to prevent. */

/** t-610705 (Phase C.2) — refresh an open agent-probes/workspace-probes subroute after the probe
 *  ledger changes (wired into extension.ts's onViewsChanged("probes"), replacing the retired
 *  ProbeResultPanelManager.refreshAll()). A no-op off a probes route. */
export function refreshCockpitProbes(): void {
  refreshControl("probes");
}

/** t-610705 (Phase D, D1a) — re-fetch reference data (catalogs, not the entity) for an open studio
 *  route after an external tachyon.yml change (wired into extension.ts's onViewsChanged("commands")/
 *  refreshAll, replacing the retired RunbookStudioPanelManager/ScheduleStudioPanelManager's
 *  `refreshReferenceData()`). A no-op off a studio route (mirrors refreshCockpitProbes); a no-op for
 *  a studio whose adapter never changes its own referenceData externally is harmless (best-effort,
 *  see studioHost.ts's refreshStudioReferenceData doc comment). */
export function refreshCockpitStudioReferenceData(): void {
  refreshControl("studio-reference");
}

/** t-610705 (Phase D, D2) — re-send a fresh `load` for an open Task Studio binding after ANY task
 *  mutation, from ANY source (board drag/edit, detail edit, MCP tool call) — the same fan-out the
 *  retired standalone TaskStudioPanelManager wired via `base.refreshAll()` into `onTasksChanged`.
 *  Task and Pin (D3, see refreshCockpitPinStudioEntity below) are the two migrated studios whose
 *  underlying entity can change out from under an open binding through paths OTHER than Save — the
 *  other 4 studios' entities have no such external-mutation path, so they have no equivalent push.
 *  A no-op off a task studio-edit route, and best-effort (sendStudioLoad already tolerates a load
 *  failure) otherwise. */
export function refreshCockpitTaskStudioEntity(): void {
  refreshControl("task-studio");
}

/** t-610705 (Phase D, D3) — Pin's equivalent of refreshCockpitTaskStudioEntity above: the retired
 *  standalone PinStudioPanelManager wired `base.refreshAll()` into the SAME broad `refreshAll()`
 *  fan-out extension.ts already calls after worktree/plugin/reference-data changes (pins can be
 *  created/deleted from the sidebar tree while a DIFFERENT pin's studio tab is open) — ported as-is,
 *  same call site, rather than narrowed to a pin-specific event that didn't exist before this port. */
export function refreshCockpitPinStudioEntity(): void {
  refreshControl("pin-studio");
}

/** t-610705 (Phase C.2) — the palette "Open Raw Transcript" escape hatch, wired to the CURRENT
 *  route rather than a tracked "most recently active" panel (that concept doesn't survive
 *  collapsing to a single shared binding — see activityBinding's doc comment). Off an agent-activity
 *  route, notifies instead of guessing which agent the human meant. */
export function openCockpitAgentTranscript(): void {
  doOpenActivityTranscript?.();
}

/** Refresh embedded Approvals after resolve/fan-out. */
export function refreshCockpitApprovals(): void {
  refreshControl("approvals");
}

export function refreshCockpitValidations(): void {
  refreshControl("validations");
  // SDD 485 D4 — the Inbox is a projection over the same stores, so any push that refreshes one of its
  // sources must refresh the aggregate too, or the unified count silently goes stale the moment a
  // validation is closed from the Validations tab. That fan-out did not disappear when the Inbox left
  // Control; it moved to `HumanInboxPanelManager.refresh()`, called beside this function and beside
  // `refreshCockpitApprovals` in extension.ts — the same shape C5 left for the Board's counts. This is
  // the FIRST Phase D surface with a real fan-out door: tmux, Plugins and Runtime Ops are all polled
  // rather than watched, and each recorded that its `refresh()` had no caller yet. This one has two.
}

/** t-610705 (Phase C.3) — re-post the Handoff snapshot (wired into onViewsChanged("handoff"),
 *  replacing the retired HandoffPanelManager.refreshAll()). A no-op off the handoff section. */
export function refreshCockpitHandoff(): void {
  refreshControl("handoff");
}

// SDD 485 C5 — the bounded/coalesced agent-liveness pass went WITH the board: it stays in
// src/cockpit/missionVm.ts (a pure function of a workspace target, with no Control in it) and
// `BoardPanelManager` owns the instance now. Control kept no copy — an unused one is a second
// coalescing window waiting to disagree with the real one.

/** SDD 485 C5 — kept for the sections that still resolve a workspace the Control-scope way (Validations, and
 *  the Board/studio hand-offs, which need a wsHash to open AGAINST). The Board APP no longer resolves like
 *  this: a dashboard panel is opened against a project and that project is half its key, so
 *  `BoardPanelManager` looks its own workspace up strictly. */
function resolveMissionWs(board: CockpitMissionBoard, prefer?: string): WorkspaceMissionControlTarget | undefined {
  const all = board.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWorkspaceScope.current) {
    const hit = all.find((w) => w.wsHash === controlWorkspaceScope.current);
    if (hit) return hit;
  }
  return all[0];
}

function resolveApprovalWs(appr: CockpitApprovals, prefer?: string): WorkspacePresentationTarget | undefined {
  const all = appr.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWorkspaceScope.current) {
    const hit = all.find((w) => w.wsHash === controlWorkspaceScope.current);
    if (hit) return hit;
  }
  return all[0];
}

function resolveHandoffWs(handoff: CockpitHandoff, prefer?: string): WorkspaceHandoffTarget | undefined {
  const all = handoff.getWorkspaces();
  if (all.length === 0) return undefined;
  if (prefer) {
    const hit = all.find((w) => w.wsHash === prefer);
    if (hit) return hit;
  }
  if (controlWorkspaceScope.current) {
    const hit = all.find((w) => w.wsHash === controlWorkspaceScope.current);
    if (hit) return hit;
  }
  return all[0];
}

/**
 * t-610705 (Phase C.2) — Control hosts AT MOST ONE active Activity feed at a time (unlike the
 * retired standalone panel's one-Map-slot-per-agent). A hardening dueto (probe-2d90286d) found that
 * navEpoch alone can't protect a live watcher's async continuations from posting into whatever feed
 * replaced it: navEpoch bumps on ANY navigation (including unrelated ones, e.g. a shell workspace-
 * scope switch, which must NOT tear down an open activity feed — same "immutable locator" reasoning
 * as task-detail). So this gets its OWN generation counter, bumped only when the activity route
 * itself starts/stops, and every callback/continuation in activityFeed.ts checks it via `isCurrent`
 * before touching the shared webview.
 */
let activityBinding: { generation: number; wsHash: string; agent: string; feed: ActivityFeed } | undefined;
let activityGeneration = 0;

function stopActivityBinding(): void {
  activityBinding?.feed.stop();
  activityBinding = undefined;
}

/**
 * Teardown ONLY — called synchronously from `navigate()` (the one place `currentRoute` changes) so
 * an orphaned watcher can never survive a route change regardless of what the caller does next
 * (closes the dueto's "lifecycle must be owned by route transition, not by rendering" finding).
 * Starting a FRESH binding needs `deps`/`live` (openCockpit's closure), so that half lives in
 * `ensureActivityBinding` below, called from sendSectionModule — same convention as task-detail's
 * sendTaskDetail, always invoked right after `sendModel()` by every existing caller.
 */
function reconcileActivityTeardown(route: CockpitRoute): void {
  if (route.kind === "agent-activity" && activityBinding && activityBinding.wsHash === route.wsHash && activityBinding.agent === route.agent) {
    return; // same feed re-entered — sendSectionModule's ensureActivityBinding will replay it, not restart it
  }
  stopActivityBinding();
}

/** Ported verbatim from the retired HandoffPanelManager. */
function parseHandoffDistillAction(m: Partial<HandoffAction>): HandoffDistillInputV1 | null {
  if (m.type !== "distill") return null;
  const instructions = normalizeAdditionalInstruction(m.instructions);
  const args = normalizeHandoffDistillArgs(m.mode === "adhoc" ? m.args : undefined);
  const candidate = m.mode === "existing" && typeof m.agent === "string"
    ? { mode: "existing", agent: m.agent.trim(), ...(instructions ? { instructions } : {}) }
    : m.mode === "adhoc" && typeof m.profileId === "string"
      ? { mode: "adhoc", profileId: m.profileId, ...(args ? { args } : {}), ...(instructions ? { instructions } : {}) }
      : undefined;
  if (!candidate) return null;
  try { return parseHandoffDistillInputV1(candidate); } catch { return null; }
}

function sectionTitle(s: CockpitStrings, section: CockpitSectionId): string {
  const map: Partial<Record<CockpitSectionId, string>> = {
    mission: s.navMission,
    validations: s.navValidations,
    approvals: s.navApprovals,
    plugins: s.navPlugins,
    runtime: s.navRuntime,
    "runtime-config": s.navRuntimeConfig,
    tmux: s.navTmux,
    engine: s.navEngine,
  };
  return map[section] ? `${s.title} — ${map[section]}` : s.title;
}

export async function openCockpit(
  deps: CockpitDeps,
  opts?: {
    section?: CockpitSectionId;
    route?: CockpitRoute;
    revivedPanel?: vscode.WebviewPanel;
    wsHash?: string;
    approvalWsHash?: string;
  },
): Promise<void> {
  const s = cockpitStrings();
  // t-610705 (Phase C.0) — the router design dueto's "retired-panel revive redirects can overwrite
  // a live cockpit session" finding: VS Code does not guarantee revive order across view types.
  // If a legacy shim's redirect raced ahead of the Cockpit's OWN trusted revival and already
  // created a duplicate panel, the real revival is authoritative — retire the interim duplicate.
  if (opts?.revivedPanel && panel && panel !== opts.revivedPanel) {
    const stale = panel;
    panel = undefined;
    stale.dispose();
  }
  // t-610705 (Phase D, D0) — captured BEFORE the reveal/create block below: a FRESH panel has no
  // live binding to protect (nothing to lose), so its initial route commits unguarded; REVEALING or
  // redirecting into an EXISTING panel might be interrupting a dirty studio form, so that path goes
  // through requestNavigate() once `live` exists a few lines down.
  const revealingExisting = !!panel && !opts?.revivedPanel;
  // t-d16a39 — the legacy per-section opt name feeds the ONE shell scope (callers unchanged).
  // SDD 485 C5 — the board's own alias went with it: its last caller, `tachyon.missionControl`, opens the
  // app now, which keys its panel on a project rather than moving Control's scope.
  if (opts?.wsHash) controlWorkspaceScope.set(opts.wsHash);
  if (opts?.approvalWsHash) controlWorkspaceScope.set(opts.approvalWsHash);

  const creating = !panel || !!opts?.revivedPanel;
  if (panel && !opts?.revivedPanel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    // t-4d59d3 — every localResourceRoot the panel will EVER need is granted here, once, at
    // creation: dist/webview plus each workspace's stable task-attachments parent (covers every
    // task's blob dir — read-only mapping via asWebviewUri, still confined to the attachments
    // tree). Reassigning `webview.options` later on a LIVE panel makes VS Code recreate the
    // webview's inner iframe, and that reload can wedge at the fake.html placeholder — the whole
    // Control surface went permanently blank the moment a Board card was clicked (the old
    // sendTaskDetail did exactly that per-navigation re-grant; see its comment below). A workspace
    // folder added AFTER Control opened won't have its root here — its task images degrade to
    // broken thumbnails until Control is reopened, which beats a blank panel.
    const creationResourceRoots = [
      vscode.Uri.joinPath(deps.extensionUri, "dist", "webview"),
      ...deps.taskDetail.getWorkspaces().map((w) => vscode.Uri.file(w.attachmentsRoot())),
    ];
    panel = opts?.revivedPanel ?? vscode.window.createWebviewPanel(COCKPIT_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: creationResourceRoots,
    });
    panel.title = s.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: creationResourceRoots,
    };
    panel.iconPath = panelIcon(deps.extensionUri, "pulse");
    markCockpitSingletonClaimed();
    // t-a632eb — this teardown belongs to THIS panel, so it must only run when THIS panel is still
    // the live one. `panel` is module-scoped and the guard used to ask `if (panel)` — "is there a
    // panel?" rather than "is the dead one mine?". VS Code does not order panel revivals (see
    // cockpitSingleton.ts), so a Control opened by a retired-panel shim can be superseded by
    // Control's own `revivedPanel` revive and dispose AFTERWARDS. Under the old guard that late
    // disposal nulled the LIVE panel's wiring, bumped navEpoch, reset the route and released the
    // singleton claim — after which the model push below is suppressed forever and every section
    // of the shell renders "No Tachyon workspace attached in this window."
    // SDD 485 B1/B2 — one gate per live panel. Created HERE (not per refresh) because the journal
    // it keeps while hidden is the panel's, and it must die with the panel: a gate outliving its
    // panel would replay a delta into a webview nobody owns any more.
    controlGate?.dispose();
    lastControlCatchUp = undefined;
    controlGate = new PanelWorkGate<ControlRefreshKind>(panelVisibility(panel), {
      replay: (kind) => pushControlRefresh(kind),
      resync: () => pushControlPoll?.(),
      // Unconditional: the activity log grows without emitting a single `views-changed`, so its
      // catch-up cannot hang off the journal's decision (see panelWorkGate.ts's `onReveal`).
      onReveal: () => activityBinding?.feed.catchUp(),
      onCatchUp: (decision) => { lastControlCatchUp = decision; },
    });
    const disposingPanel = panel;
    const disposingGate = controlGate;
    panel.onDidDispose(() => {
      if (panel === disposingPanel) {
        panel = undefined;
        disposingGate.dispose();
        if (controlGate === disposingGate) controlGate = undefined;
        pushControlPoll = undefined;
        clearCockpitSingletonClaim();
        pushApprovals = undefined;
        pushValidations = undefined;
        pushHandoff = undefined;
        pushProbes = undefined;
        pushStudioReferenceData = undefined;
        pushTaskStudioEntity = undefined;
        pushPinStudioEntity = undefined;
        doOpenActivityTranscript = undefined;
        openTaskDocument = undefined;
        openTaskEditDocument = undefined;
        openPinEditDocument = undefined;
        openBoardDocument = undefined;
        openTmuxApp = undefined;
        openPluginsApp = undefined;
        openRuntimeOpsApp = undefined;
        openRuntimeConfigApp = undefined;
        openExecutionGraphApp = undefined;
        openSettingsApp = undefined;
        openOverviewApp = undefined;
        openInboxApp = undefined;
        openInboxItemApp = undefined;
        openFleetApp = undefined;
        wiredPanel = undefined;
        navEpoch += 1;
        // t-610705 (Phase D, D3) — a later fresh panel must never inherit a disposed panel's route
        // provenance (design-dueto probe-43bca1cc: module-scoped router state outlives any one panel).
        currentRoute = routes.section("overview");
        lastCommittedNonStudioRoute = routes.section("overview");
        stopActivityBinding();
        stopStudioBinding();
      }
    });
  }
  const live = panel;
  // SDD 485 C4 — bound BEFORE the initial navigate below, because that navigate is exactly the call a
  // revived/deep-linked task-detail route arrives through, and a redirect wired later would miss it.
  openTaskDocument = (wsHash, taskId) => deps.taskDetail.openDocument(wsHash, taskId);
  openTaskEditDocument = (wsHash, taskId) => deps.taskDetail.openEditDocument?.(wsHash, taskId);
  openPinEditDocument = (wsHash, pinId) => deps.pinDetail?.openEditDocument(wsHash, pinId);
  // SDD 485 C5 — same seam, same reason, and the scope handed over is the one Control itself would have
  // rendered (`resolveMissionWs`, which already prefers the shell scope `opts.wsHash` set a few lines
  // above). A launcher click, a Jump card and a Fleet action therefore land on the SAME project's panel —
  // and re-opening reveals it rather than making a second, which is what `cardinality: "dashboard"` buys.
  openBoardDocument = () => deps.openBoard(resolveMissionWs(deps.missionBoard)?.wsHash);
  // SDD 485 D1 — no scope to resolve and none to pass: `window` cardinality is precisely the statement that
  // this screen is not about a project, so there is nothing here for a scope change to retarget.
  openTmuxApp = () => deps.openTmux();
  // SDD 485 D2 — the fourth of these seams, and the second that carries a project: a dashboard panel is
  // opened AGAINST one, so the scope handed over is the one Control itself would have rendered the section
  // for. A launcher click, a Jump card and a revived route therefore land on the SAME project's panel — and
  // re-opening reveals it rather than making a second, which is what `cardinality: "dashboard"` buys.
  openPluginsApp = () => deps.openPlugins(controlWorkspaceScope.current);
  // SDD 485 D3 — no scope to resolve and none to pass, exactly like D1's tmux: `window` cardinality is the
  // statement that this screen is not about a project. Passing `controlWorkspaceScope.current` here would
  // compile and be wrong — `sectionPanelKey` REFUSES a project for a `window` app, which is the refusal
  // that member exists for.
  openRuntimeOpsApp = () => deps.openRuntimeOps();
  // SDD 485 D4 — a dashboard, so the scope handed over is the one Control itself would have rendered the
  // section for (D2's shape). The item door passes the ROUTE's own immutable wsHash instead, never the
  // shell scope: an entity route carries its workspace as identity, and here that workspace also decides
  // which root the item's evidence may resolve against — so taking it from the selector would be a
  // containment bug as well as a navigation one. That rule is older than this migration; what changed is
  // that it now also picks which PANEL answers.
  openInboxApp = () => deps.openHumanInbox(controlWorkspaceScope.current);
  openInboxItemApp = (wsHash, itemKind, itemId) => deps.openHumanInboxItem(wsHash, itemKind, itemId);
  openFleetApp = () => deps.openFleet(controlWorkspaceScope.current);
  openRuntimeConfigApp = () => deps.openRuntimeConfig(controlWorkspaceScope.current);
  openExecutionGraphApp = () => deps.openExecutionGraph(controlWorkspaceScope.current);
  openSettingsApp = () => deps.openSettings();
  openOverviewApp = () => deps.openOverview(controlWorkspaceScope.current);

  if (opts?.route) {
    if (revealingExisting) await requestNavigate(opts.route, live);
    else navigate(opts.route);
  } else if (opts?.section) {
    const target = routes.section(resolveCockpitSection(opts.section));
    if (revealingExisting) await requestNavigate(target, live);
    else navigate(target);
  } else if (!revealingExisting) {
    navigate(routes.section("overview"));
  }

  /**
   * SDD 479 phase 5 — read the PERSONAL override the way the sidebar reads it, so Control's statement
   * about what is in effect cannot disagree with the cards themselves.
   *
   * Same key, same validator, same "an empty object is not an attempt to configure anything" rule as
   * `SidebarPrototype.cardTemplateFor`. What differs is only the question being asked: the sidebar
   * needs the resolved template, this needs whether one exists and whether it was honored.
   */
  /** t-aaad95 — the global file's state as Control shows it, including a refusal it must not hide. */
  const globalSettingsState = (): CockpitGlobalSettingsState => {
    const store = sharedGlobalSettings();
    const current = store.current();
    const refusal = store.refusal();
    return {
      file: store.file,
      activityCodeTheme: current.activityCodeTheme,
      agentPaneEnabled: current.agentPaneEnabled,
      gitPath: current.gitPath,
      hasCardTemplate: current.sidebarCardTemplate !== undefined,
      ...(refusal ? { refusal: refusal.errors } : {}),
    };
  };

  const personalCardTemplateState = (): { state: "none" | "active" | "refused"; errors?: string[] } => {
    const written = sharedGlobalSettings().current().sidebarCardTemplate;
    if (written === undefined || written === null) return { state: "none" };
    if (typeof written === "object" && !Array.isArray(written) && Object.keys(written as object).length === 0) {
      return { state: "none" };
    }
    const parsed = parseCardTemplate(written, "sidebar.cardTemplate");
    return parsed.config ? { state: "active" } : { state: "refused", errors: parsed.errors };
  };

  const sendModel = async () => {
    const epoch = navEpoch;
    let model: CockpitModel;
    try {
      // t-af3eef — collect only what this section reads. The section is computed once, below, and
      // reused for the needs, so there is exactly one authority for "which view is this" and the
      // needs cannot drift from the model that gets built. Navigation to a section that reads
      // neither classified slice no longer waits on either.
      const section = navSection(currentRoute) ?? "overview";
      const bundles = await deps.collect(collectNeedsFor(section));
      // t-610705 (Phase D, D3) — navSection(currentRoute) is null for pin (nav-less); "overview"
      // here is only "which background section data stays warm underneath the studio form", NOT a
      // claim that the Overview tab is active (tab highlighting is suppressed client-side instead —
      // see cockpit/App.tsx's `isNavlessStudio`).
      model = buildCockpitModel(bundles, {
        section,
        wsHash: controlWorkspaceScope.current,
        personalCardTemplate: personalCardTemplateState(),
        globalSettings: globalSettingsState(),
      });
    } catch (err) {
      model = buildCockpitModel(
        [
          {
            control: {
              folderName: "(cockpit)",
              workspaceRoot: "",
              wsHash: "error",
              bridgeUrl: "",
              identityError: err instanceof Error ? err.message : String(err),
            },
            agents: [],
            worktrees: [],
            approvals: [],
          },
        ],
        { section: navSection(currentRoute) ?? "overview", wsHash: controlWorkspaceScope.current },
      );
    }
    // t-610705 (Phase C.1) — carries the exact route when it's a subroute; buildCockpitModel stays
    // route-shape-agnostic (see the field's doc comment on CockpitModel).
    if (currentRoute.kind !== "section") model.activeRoute = currentRoute;
    if (isStudioRoute(currentRoute)) {
      // t-610705 (Phase D, D0) — ensure-if-missing HERE too (not just in sendSectionModule): the
      // cockpit-level "ready" handler calls sendModel() BEFORE sendSectionModule(), and the client
      // needs `studioMountNonce` on THIS push to complete its own mount handshake. Idempotent on an
      // existing binding (routeKey match), so calling it from both places is safe.
      ensureStudioBinding(currentRoute, makeStudioAdapterFactory(deps.studios));
      const b = currentStudioBindingFor(currentRoute);
      if (b) {
        model.studioMountNonce = b.mountNonce;
        model.studioPersisted = b.persisted;
      }
    }
    if (panel === live && navEpoch === epoch) {
      live.webview.postMessage(modelMessage(model));
      live.title = sectionTitle(s, navSection(currentRoute) ?? "overview");
    }
  };

  const sendApprovals = async () => {
    if (panel !== live || !isSection(currentRoute, "approvals")) return;
    const epoch = navEpoch;
    const ws = resolveApprovalWs(deps.approvals);
    if (!ws) {
      live.webview.postMessage(approvalErrorMessage("No Tachyon workspace for Approvals."));
      return;
    }
    try {
      const vm = buildApprovalViewModel({ workspaceRoot: ws.workspaceRoot, folder: ws.folderName, wsHash: ws.wsHash });
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(approvalsMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  const sendValidations = async () => {
    if (panel !== live || !isSection(currentRoute, "validations")) return;
    const epoch = navEpoch;
    const ws = resolveMissionWs({ ...deps.missionBoard, getWorkspaces: deps.validations.getWorkspaces });
    if (!ws) {
      live.webview.postMessage(validationErrorMessage("No Tachyon workspace for Validations."));
      return;
    }
    try {
      const vm = buildValidationsViewModel({ folder: ws.folderName, wsHash: ws.wsHash, validations: ws.listValidations() });
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(validationsMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      live.webview.postMessage(validationErrorMessage(err instanceof Error ? err.message : String(err)));
    }
  };

  /*
   * SDD 485 D4 — the Human Inbox's five host functions left with the renderer: `inboxSources`,
   * `buildInboxVm`, `returnToInbox`, `sendInbox` and `sendInboxItem`. They live in
   * `src/webview/HumanInboxPanel.ts` now, where the two that were route-gated here (`sendInbox` /
   * `sendInboxItem` each no-oped off its own route) collapse into ONE `send()` reading that panel's own
   * subroute slot, and where `resolveApprovalWs`'s fallback chain becomes a STRICT lookup because the
   * project is half the panel's key.
   */

  // t-610705 (Phase C.3) — ported verbatim from the retired HandoffPanelManager's post(): a load
  // failure notifies (a toast), it does NOT post a distinct error VM — the client keeps whatever it
  // last had (or the loading state if nothing yet). Handoff's own VM already models "no file yet"
  // via `exists: false`, which isn't a failure case at all.
  const sendHandoff = async () => {
    // t-ace77f — a detail route now, so the workspace comes from the ROUTE's own immutable locator
    // (the router's rule for every entity route): switching Control's workspace scope while a
    // handoff document is open must not swap the document under the reader.
    if (panel !== live || currentRoute.kind !== "project-handoff") return;
    const epoch = navEpoch;
    const ws = resolveHandoffWs(deps.handoff, currentRoute.wsHash);
    if (!ws) return;
    try {
      const snap = await ws.loadHandoff();
      if (panel !== live || navEpoch !== epoch) return;
      const notes: HandoffNoteVM[] = snap.notes.map((note) => ({ ...note, evidence: [...note.evidence] }));
      const distillTargets: HandoffDistillTargetVM[] = snap.distillTargets.map((target) => ({ ...target }));
      const vm: HandoffViewModel = {
        folder: ws.folderName,
        exists: snap.exists,
        body: snap.body,
        staleness: snap.staleness,
        pendingCount: snap.pendingCount,
        updatedAt: snap.updatedAt,
        updatedBy: snap.updatedBy,
        revision: snap.revision,
        notes,
        distillTargets,
        distillProfiles: HANDOFF_DISTILL_PROFILES,
      };
      live.webview.postMessage(handoffMessage(vm));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch) return;
      notify(`Could not refresh Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  };

  const handleHandoffAction = async (m: Partial<HandoffAction>): Promise<boolean> => {
    // "refresh" is NOT handled here — it is the same wire string as the shell's own poll
    // (`case "refresh"` in the main switch below), which already calls sendSectionModule() →
    // sendHandoff() for the active section. Only Handoff's OWN action types need a dedicated
    // handler. ("ready" used to need the same warning; t-6ced6f answers it above this chain, so it
    // can no longer arrive here at all.)
    if (!m?.type || currentRoute.kind !== "project-handoff") return false;
    const routeWsHash = currentRoute.wsHash;
    if (m.type === "openFile") {
      const ws = resolveHandoffWs(deps.handoff, routeWsHash);
      if (ws) {
        try {
          const filePath = await ws.ensureHandoffFile();
          await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
          await sendHandoff();
        } catch (err) {
          notify(`Could not open Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      return true;
    }
    if (m.type === "distill") {
      const ws = resolveHandoffWs(deps.handoff, routeWsHash);
      const action = parseHandoffDistillAction(m);
      if (!action) {
        notify("Invalid handoff distillation request.", "warn");
        return true;
      }
      if (ws) {
        try {
          const result = await ws.startHandoffDistill(action);
          notify(result.mode === "existing"
            ? `Handoff distillation task sent to '${result.agent}'.`
            : `Handoff distillation agent '${result.agent}' started.`);
        } catch (err) {
          notify(`Could not start handoff distillation: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      }
      return true;
    }
    return false;
  };

  // t-527767 — shared by onCancelled (every studio) and onSaved (Pin/Task only — see onSaved's own
  // scoping comment below) since the "where does this studio route's exit land" computation is
  // IDENTICAL for both triggers; only whether-to-navigate-at-all differs.
  // t-c3c819 — task-detail is only a valid exit destination for a REAL, already-saved task; Task
  // Studio's staged-create pattern opens a brand-new task straight into studio-edit with a
  // pre-minted, still-unsaved id, and task-detail(id) for that id 404s ("never found on disk").
  // SDD 485 C5 — that fallback used to be the Board section. The Board is a standalone app now, and
  // `navigate()` would turn a `section("mission")` here into "open a Board tab" — a panel appearing on a
  // CANCEL is a surprise, not a recovery. So the exit lands on Overview, Control's own landing screen, and
  // the Board stays one launcher click away. The rule this line exists for is unchanged: a never-persisted
  // task must not exit to task-detail(id).
  const studioExitTarget = (route: StudioRoute, persisted: boolean): CockpitRoute => {
    const parent = parentRoute(route);
    return parent?.kind === "task-detail" && !persisted ? routes.section("overview") : parent ?? routes.section("overview");
  };

  // t-610705 (Phase D, D0) — studio-envelope dispatch (ready/patch/dirty/save/cancel/domain). The
  // io/hooks capabilities are the SAME injected-capability shape activityFeed.ts established (post +
  // isCurrent), so a torn-down/replaced binding's in-flight work can never post into whatever
  // replaced it — see studioHost.ts's module doc for the full nav-transaction rationale.
  const studioIo = { post: (m: unknown) => live.webview.postMessage(m), isCurrent: () => panel === live };
  const studioDomainDispatch = makeStudioDomainDispatch(deps.studios);
  const dispatchStudioMessage = (raw: unknown): Promise<boolean> =>
    handleStudioMessage(studioIo, raw, {
      onChanged: deps.studios.onChanged,
      notify,
      handleDomainMessage: (ctx, message) => {
        if (isStudioRoute(currentRoute)) studioDomainDispatch(currentRoute, ctx, message);
      },
      // t-cdd4e1 — Cancel discards the draft server-side but never navigated anywhere; the studio
      // route just sat there with no visible effect. Navigate to the SAME destination the route's
      // own breadcrumb would (parentRoute already resolves pin's captured returnRoute vs every other
      // studio's flat/task-detail parent generically — no separate branching needed here, same as
      // "setSection"/"navigateReturn" below reuse it). Calls navigate() DIRECTLY, not requestNavigate
      // — Cancel is designed as an unconfirmed direct discard (see the "cancel" case's own comment in
      // studioHost.ts), so it must bypass beginStudioNavTransaction's checkpoint entirely rather than
      // re-prompt a dialog the user just explicitly opted out of by clicking Cancel.
      onCancelled: (persisted) => {
        if (!isStudioRoute(currentRoute)) return;
        navigate(studioExitTarget(currentRoute, persisted));
        void (async () => {
          await sendModel();
          await sendSectionModule();
        })();
      },
      // t-527767 — maintainer directive 2026-07-23: Pin/Task Studio read as "create/edit → return to
      // the list" — Save should navigate away automatically, same destination Cancel/Back already
      // use. Deliberately scoped to just these two: the other 5 studios (command/terminal/runbook/
      // schedule/agent) read more like config editors, where staying open to keep tweaking is the
      // better default — a maintainer decision, not an oversight (can extend later if it proves
      // wanted). Calls navigate() DIRECTLY, same as onCancelled — a save that just succeeded has
      // nothing left to confirm-discard, so this bypasses beginStudioNavTransaction's checkpoint the
      // same way Cancel does.
      onSaved: (persisted) => {
        if (!isStudioRoute(currentRoute)) return;
        if (currentRoute.studio !== "pin" && currentRoute.studio !== "task") return;
        navigate(studioExitTarget(currentRoute, persisted));
        void (async () => {
          await sendModel();
          await sendSectionModule();
        })();
      },
    });

  /**
   * SDD 485 D3 — Control no longer RENDERS Runtime Ops; the app does (`RuntimeOpsPanel.ts`). What used to
   * live here — `sendRuntime` and the two action handlers — moved there whole. The `navEpoch` guard it
   * carried did NOT move, and its absence is deliberate: that guard stopped one route's snapshot landing
   * under another route's screen, and a `window` app's panel has no route to change (C4 recorded the same
   * non-guard for the task detail).
   */

  /**
   * SDD 485 C4 — Control no longer RENDERS a task detail; the app does (`TaskDetailPanel.ts`). What used to
   * live here — `sendTaskDetail`, `handleTaskDetailAction`, `resolveTaskDetailWs` and the single
   * its single last-known tombstone slot — moved into that app's `bind`, where that cache is per
   * panel rather than per singleton and the workspace is resolved from the panel's own frozen target rather
   * than from a route this host happens to be on.
   *
   * What is left of the task detail in this file is a REDIRECT with no UI, and it is deliberately at the one
   * commit point every navigation reaches (`navigate`): a task-detail route arriving from persisted window
   * state, a deep link or Task Studio's breadcrumb opens the document's own tab and lands Control on Mission.
   * Two live renderers of one screen is what `spec.md` forbids; a shim that opens the one renderer is what it
   * explicitly allows.
   */

  const resolveActivityWs = (wsHash: string): WorkspaceActivityTarget | undefined =>
    deps.activity.getWorkspaces().find((w) => w.wsHash === wsHash);

  // t-610705 (Phase C.2) — action-resolution bookkeeping for the CURRENT activity binding (openFile's
  // allow-list, share/transcript resolution). Deliberately host-side state distinct from
  // activityFeed.ts's own closure: that module owns feed MECHANICS only, this owns what a webview
  // ACTION is allowed to touch — same split TaskDetailPanel's tombstone cache keeps from taskDetailVm.ts.
  let activityKnownPaths = new Set<string>();
  let activityLatestVm: ActivityViewModel | undefined;
  let activityTranscriptPath: string | undefined;

  /**
   * Start-if-missing only. `navigate()` already tore down any MISMATCHED binding synchronously
   * (reconcileActivityTeardown) — by the time this runs, either a binding for the CURRENT identity
   * already exists (re-entry / cockpit READY on an unchanged route: nothing to do, the live watcher
   * already covers it) or none exists at all (fresh entry: start one). Called from sendSectionModule,
   * same convention every other route's content-push already follows (always right after sendModel()).
   */
  const ensureActivityBinding = () => {
    if (currentRoute.kind !== "agent-activity") return;
    const route = currentRoute;
    if (activityBinding && activityBinding.wsHash === route.wsHash && activityBinding.agent === route.agent) return;
    const ws = resolveActivityWs(route.wsHash);
    if (!ws) return; // a stale revive/deep-link — no matching workspace; the route stays open, empty.
    const generation = ++activityGeneration;
    const capturedPanel = live;
    const isCurrent = () => panel === capturedPanel && activityBinding?.generation === generation;
    const feed = startActivityFeed(ws, route.agent, {
      isCurrent,
      // SDD 485 B1 — Control hidden behind another tab: the feed stops reading, building and posting.
      // Its catch-up is driven from the gate's `onReveal` (below) rather than from a journaled
      // invalidation, because the activity log moves without any `views-changed` at all.
      paused: () => controlGate !== undefined && !controlGate.visible,
      post: (vm, prepended) => {
        if (!isCurrent()) return;
        const shareVm = withActivityShareKeys(route.agent, vm);
        activityLatestVm = shareVm;
        activityKnownPaths = new Set([...shareVm.summary.filesChanged, ...shareVm.summary.filesReferenced]);
        activityTranscriptPath = shareVm.sourcePath;
        capturedPanel.webview.postMessage(activityMessage(route.wsHash, route.agent, shareVm, prepended));
      },
      postImage: (id, dataUri) => {
        if (!isCurrent()) return;
        capturedPanel.webview.postMessage(imageDataMessage(route.wsHash, route.agent, id, dataUri));
      },
    });
    activityBinding = { generation, wsHash: route.wsHash, agent: route.agent, feed };
  };

  const resolveActivityShareOrNotify = (agent: string, sequence: unknown, key: unknown) => {
    const resolved = resolveActivityShare(agent, activityLatestVm, sequence, key);
    if (!resolved.ok) {
      notify("That Activity item is no longer available. Refresh the Activity view and try again.", "warn");
      return undefined;
    }
    return resolved.payload;
  };

  const copyActivityShareText = async (agent: string, sequence: unknown, key: unknown): Promise<void> => {
    const payload = resolveActivityShareOrNotify(agent, sequence, key);
    if (!payload) return;
    await vscode.env.clipboard.writeText(payload.text);
    notify("Activity share text copied.");
  };

  // t-a983e1 — channel chosen in-webview product QuickPicker (no vscode.showQuickPick).
  const shareActivityExternal = async (
    agent: string,
    sequence: unknown,
    key: unknown,
    channel: ExternalShareChannel,
  ): Promise<void> => {
    const payload = resolveActivityShareOrNotify(agent, sequence, key);
    if (!payload) return;
    const label = channel === "email" ? "Email" : "WhatsApp";
    const preview = payload.text.length > 1400 ? `${payload.text.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : payload.text;
    const ok = await showNotification(`Share this Activity item via ${label}?`, "info", ["Open"], { modal: true, detail: preview });
    if (ok !== "Open") return;
    if (channel === "email") {
      const subject = encodeURIComponent(`Tachyon Activity from ${agent}`);
      const body = encodeURIComponent(payload.urlText);
      await vscode.env.openExternal(vscode.Uri.parse(`mailto:?subject=${subject}&body=${body}`));
    } else {
      await vscode.env.openExternal(vscode.Uri.parse(`https://wa.me/?text=${encodeURIComponent(payload.urlText)}`));
    }
  };

  const runningActivityAgentTargets = async (ws: WorkspaceActivityTarget, sourceAgent: string): Promise<Array<{ name: string; description: string }>> => {
    const context = await ws.activityContext(sourceAgent);
    return context.targets.items.map((target) => ({
      name: target.name,
      description: target.lifetime === "saved" ? "Saved Agent" : "Temporary Agent",
    }));
  };

  /** Prepare path: list targets → post SHARE_AGENT_TARGETS for in-webview QuickPicker. */
  const prepareShareActivityToAgent = async (
    wsHash: string,
    sourceAgent: string,
    sequence: unknown,
    key: unknown,
  ): Promise<void> => {
    if (typeof sequence !== "number" || typeof key !== "string" || !key) return;
    // Ensure the share payload still resolves (same warn as execute path).
    if (!resolveActivityShareOrNotify(sourceAgent, sequence, key)) return;
    const ws = resolveActivityWs(wsHash);
    if (!ws) return;
    const targets = await runningActivityAgentTargets(ws, sourceAgent);
    if (targets.length === 0) {
      notify("No other running Tachyon agent is available for this Activity share.");
      return;
    }
    live.webview.postMessage(shareAgentTargetsMessage(sequence, key, targets));
  };

  // t-a983e1 — destination already chosen in-webview; host revalidates + modal confirm + paste.
  const shareActivityToAgent = async (
    wsHash: string,
    sourceAgent: string,
    sequence: unknown,
    key: unknown,
    toAgent: string,
  ): Promise<void> => {
    const payload = resolveActivityShareOrNotify(sourceAgent, sequence, key);
    if (!payload) return;
    const ws = resolveActivityWs(wsHash);
    if (!ws) return;
    // t-610705 (Phase C.2, hardening dueto probe-2d90286d MAJOR) — this flow spans a user-paced
    // QuickPicker + modal confirm; capture the binding generation now and recheck before the
    // actual side effect (ws.sendAgentInput) so navigating away mid-flow silently abandons the
    // paste instead of sending it into whatever agent/workspace is now on screen.
    const myGeneration = activityBinding?.generation;
    if (activityBinding?.generation !== myGeneration) return;
    const stillLive = (await runningActivityAgentTargets(ws, sourceAgent)).some((t) => t.name === toAgent);
    if (!stillLive) {
      notify(`Agent '${toAgent}' is no longer available.`, "warn");
      return;
    }
    const prompt = internalSharePrompt(payload);
    const preview = prompt.length > 1400 ? `${prompt.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : prompt;
    const ok = await showNotification(`Paste Activity context into '${toAgent}'?`, "info", ["Paste"], { modal: true, detail: preview });
    if (ok !== "Paste") return;
    if (activityBinding?.generation !== myGeneration) return;
    await ws.sendAgentInput(toAgent, prompt, false);
    notify(`Activity context pasted into '${toAgent}' (not submitted).`);
  };

  const handleActivityAction = async (m: Partial<ActivityWebviewMessage>): Promise<boolean> => {
    if (!m?.type || currentRoute.kind !== "agent-activity") return false;
    const route = currentRoute;
    if (m.type === "openFile" && typeof m.path === "string" && activityKnownPaths.has(m.path)) {
      void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      return true;
    }
    if (m.type === "terminal") {
      void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", route.agent, route.wsHash);
      return true;
    }
    if (m.type === "loadOlder") {
      activityBinding?.feed.loadOlder();
      return true;
    }
    if (m.type === COPY_SHARE_TEXT) {
      void copyActivityShareText(route.agent, m.sequence, m.key);
      return true;
    }
    if (m.type === SHARE_EXTERNAL) {
      const channel = m.channel === "email" || m.channel === "whatsapp" ? m.channel : undefined;
      if (!channel) {
        notify("Share channel missing — pick Email or WhatsApp in the Activity picker.", "warn");
        return true;
      }
      void shareActivityExternal(route.agent, m.sequence, m.key, channel);
      return true;
    }
    if (m.type === SHARE_TO_AGENT) {
      if (typeof m.toAgent === "string" && m.toAgent) {
        void shareActivityToAgent(route.wsHash, route.agent, m.sequence, m.key, m.toAgent);
      } else {
        // Prepare: push targets for product QuickPicker (t-a983e1).
        void prepareShareActivityToAgent(route.wsHash, route.agent, m.sequence, m.key);
      }
      return true;
    }
    return false;
  };

  const resolveProbesWs = (wsHash: string): WorkspaceProbePresentationTarget | undefined =>
    deps.probes.getWorkspaces().find((w) => w.wsHash === wsHash);

  // t-610705 (Phase C.2) — mirrors the retired ProbeResultPanelManager's renderToken (same-route
  // double-call ordering guard) — deliberately a SEPARATE counter from navEpoch/activityGeneration,
  // since two sendProbes() calls for the SAME route+epoch can legitimately overlap (e.g. cockpit
  // READY racing the refreshCockpitProbes fan-out).
  let probesRequestToken = 0;

  const sendProbes = async () => {
    if (panel !== live) return;
    if (currentRoute.kind !== "agent-probes" && currentRoute.kind !== "workspace-probes") return;
    const route = currentRoute;
    const epoch = navEpoch;
    const myToken = ++probesRequestToken;
    const ws = resolveProbesWs(route.wsHash);
    if (!ws) {
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: "", error: "No Tachyon workspace for Probes." }));
      return;
    }
    const caller = route.kind === "agent-probes" ? route.agent : undefined;
    try {
      const view = await ws.probeView(caller);
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: ws.folderName, view }));
    } catch (err) {
      if (panel !== live || navEpoch !== epoch || myToken !== probesRequestToken) return;
      live.webview.postMessage(probesMessage({ folder: ws.folderName, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const sendSectionModule = async () => {
    // t-ac79a7 — the ready half of the navigation bracket. Captured here (not after the awaits)
    // because `currentRoute` can be superseded while a module loads; the client matches this key
    // against its pending one and ignores a stale ready instead of clearing a newer navigation's
    // pending state.
    const readyEpoch = navEpoch;
    const readyKey = routeKey(currentRoute);
    if (isSection(currentRoute, "validations")) await sendValidations();
    else if (currentRoute.kind === "project-handoff") await sendHandoff();
    else if (isSection(currentRoute, "approvals")) await sendApprovals();
    else if (currentRoute.kind === "agent-activity") ensureActivityBinding();
    else if (currentRoute.kind === "agent-probes" || currentRoute.kind === "workspace-probes") await sendProbes();
    else if (isStudioRoute(currentRoute)) {
      // t-610705 (Phase D, D0) — start-if-missing only, same idempotent-on-same-identity convention
      // as ensureActivityBinding: the actual content push happens once the mounted studio App's OWN
      // "ready" (studio-envelope) handshake matches this binding's routeKey+mountNonce (round-2 F3).
      ensureStudioBinding(currentRoute, makeStudioAdapterFactory(deps.studios));
    }
    // t-ac79a7 — same liveness guard every send*() above uses: a module that finished loading for a
    // route the user already navigated away from must not report itself ready.
    if (panel === live && navEpoch === readyEpoch) live.webview.postMessage(routeReadyMessage(readyKey));
  };

  /**
   * SDD 485 B1/B2 — the shell's periodic refresh, in one place: the client's 3s poll calls it, and
   * the gate's resync branch calls the same thing.
   *
   * `sendModel()` is the push a delta never carries — nothing in the `views-changed` fan-out asks
   * for it, so a hidden panel that missed a scope- or fleet-shaped change cannot recover it kind by
   * kind — and `sendSectionModule()` is already the complete "refresh whatever route is mounted"
   * dispatcher, wider than the fan-out (it reaches runtime-config and the studios too). Reusing the poll
   * body rather than inventing a resync path means the recovery is the code Control runs twenty
   * times a minute, not a branch that only ever executes on reveal.
   */
  const shellPoll = async (): Promise<void> => {
    await sendModel();
    await sendSectionModule();
  };
  pushControlPoll = () => { void shellPoll(); };
  pushApprovals = () => { void sendApprovals(); };
  pushValidations = () => { void sendValidations(); };
  pushHandoff = () => { void sendHandoff(); };
  pushProbes = () => { void sendProbes(); };
  // t-610705 (Phase D, D1a) — no "sendX" wrapper needed: refreshStudioReferenceData already takes
  // the io capability directly (same studioIo the studio-envelope dispatch above uses), and is a
  // no-op with no binding — the isStudioRoute guard here just avoids the pointless call off-route.
  pushStudioReferenceData = () => { if (isStudioRoute(currentRoute)) void refreshStudioReferenceData(studioIo); };
  pushTaskStudioEntity = () => { if (isStudioRoute(currentRoute) && currentRoute.studio === "task") void sendStudioLoad(studioIo); };
  pushPinStudioEntity = () => { if (isStudioRoute(currentRoute) && currentRoute.studio === "pin") void sendStudioLoad(studioIo); };
  doOpenActivityTranscript = () => {
    if (currentRoute.kind !== "agent-activity") {
      notify("Open an agent's Activity view first, then run “Open Raw Transcript”.");
      return;
    }
    if (activityTranscriptPath && fs.existsSync(activityTranscriptPath)) {
      void vscode.window.showTextDocument(vscode.Uri.file(activityTranscriptPath), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } else {
      notify("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
    }
  };

  /**
   * SDD 485 C5 — Control no longer RENDERS the board, so its snapshot sender, its action handler and the
   * agent-liveness instance that fed them moved into `BoardPanel.ts`'s `bind`, one commit after C4's task
   * detail made the same journey. What is left of the board in this file is a REDIRECT with no UI, at
   * `navigate()`'s one commit point.
   */

  const handleApprovalAction = async (m: Partial<ApprovalAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "resolve" && typeof m.id === "string" && (m.decision === "approved" || m.decision === "denied")) {
      const ws = resolveApprovalWs(deps.approvals);
      if (!ws) return true;
      try {
        await deps.approvals.resolve(ws.wsHash, m.id, m.decision);
        await sendApprovals();
      } catch (err) {
        live.webview.postMessage(approvalErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return true;
    }
    return false;
  };

  const handleValidationsAction = async (m: Partial<ValidationsAction>): Promise<boolean> => {
    if (!m?.type) return false;
    if (m.type === "refreshValidations") {
      await sendValidations();
      return true;
    }
    // t-3990c3 — this handler used to resolve a workspace (and short-circuit `return true`) for
    // EVERY inbound message reaching it, not just its own action types: when
    // deps.validations.getWorkspaces() was empty, `if (!ws) return true` swallowed ANY message —
    // including "ready" — so Control never initialized at all with zero validations-capable
    // workspaces attached (discovered via t-610705 Phase C.2's cockpitActivity tests, which send a
    // bare "ready" through the full chain instead of a route that intercepts it earlier).
    if (m.type !== "closeValidationItem" && m.type !== "assignValidation") return false;
    const ws = resolveMissionWs({ ...deps.missionBoard, getWorkspaces: deps.validations.getWorkspaces });
    if (!ws) return true;
    try {
      if (m.type === "closeValidationItem" && typeof m.id === "string" && typeof m.note === "string" && m.outcome) {
        await ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.note });
      } else if (m.type === "assignValidation" && typeof m.id === "string" && typeof m.assignee === "string" && m.expect) {
        await ws.assignValidation(m.id, m.assignee, m.expect);
      } else {
        return false;
      }
      deps.validations.onValidationsChanged();
      await sendValidations();
    } catch (err) {
      const actionId = "id" in m && typeof m.id === "string" ? m.id : undefined;
      live.webview.postMessage(validationErrorMessage(err instanceof Error ? err.message : String(err), actionId));
    }
    return true;
  };

  if (wiredPanel !== live) {
    wiredPanel = live;
    // SDD 485 C6 — the sidebar owns the visible selector. Control observes the same window store so
    // its still-embedded sections re-scope, while standalone panel targets remain frozen at open.
    const scopeSubscription = controlWorkspaceScope.onDidChange(async () => {
      if (panel !== live) return;
      navEpoch += 1;
      await sendModel();
      await sendSectionModule();
    });
    live.onDidDispose(() => scopeSubscription.dispose());

    live.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (panel !== live || !msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      const type = msg.type;

      /**
       * t-6ced6f — READY is answered HERE, above the per-route chain, and never reaches it.
       *
       * READY is the SHELL's handshake (spec 278), not any route's action: it is the only source of
       * the `init` that carries `strings`, and without it cockpit/App.tsx renders
       * `if (!s) return <div class="ds-empty" />` — an entirely blank Control tab. It used to be
       * answered at the BOTTOM of this listener, behind nine handlers that each get to `return true`
       * and end dispatch, so any one of them could consume the panel's one handshake and leave the
       * shell unmounted.
       *
       * Three did, through three different doors: t-3990c3 (`handleValidationsAction` swallowed EVERY
       * message when no workspace had validations), `handleHandoffAction` (carries a comment warning
       * that it must not), and t-2f6cdd (`handleTaskDetailAction` answered READY deliberately, so a
       * panel opened straight onto task-detail — what the Attention card's "Open" creates — never
       * initialized). Each was fixed alone; nothing stopped a fourth.
       *
       * Hoisting it makes the whole class unreachable instead of forbidden by convention: no route
       * handler can swallow a message it is never offered. `cockpitReadyHandshake.test.ts` asserts
       * this for every route kind the Control can open.
       *
       * The `studioProtocolVersion` guard is NOT incidental, and "no handler has a legitimate reason
       * to see READY" is too strong a claim without it. The studio protocol reuses this exact wire
       * string for its OWN per-mount handshake — `envelope({ type: "ready", routeKey, mountNonce })`
       * — which `dispatchStudioMessage` must receive to bind the mount and post the `load`. Matching
       * on `type` alone starved every studio of it, committing this very bug in the other direction
       * (cockpitStudio.test.ts caught it, 7 failures). The SHELL's ready is the BARE one; an
       * enveloped ready is the studio's and falls through to its dispatcher below.
       */
      if (type === READY && msg.studioProtocolVersion === undefined) {
        live.webview.postMessage(initMessage(s));
        await sendModel();
        await sendSectionModule();
        // t-610705 (Phase C.2) — a (re)loaded cockpit webview's client-side image cache is empty;
        // ensureActivityBinding() above is a no-op when the binding already exists (the shared 3s
        // poll must never touch it — see route.ts's refreshPolicy doc), so THIS is the one place
        // that explicitly recovers a still-live feed's images after a reload.
        if (currentRoute.kind === "agent-activity") activityBinding?.feed.replayImages();
        return;
      }

      // SDD 485 C4/C5 — the task-detail and board action handlers are both GONE from this chain: each is
      // its own app with its own client, so the "openTask" shape collision this chain used to order
      // around has no claimant left in Control at all.
      if (await handleApprovalAction(msg as Partial<ApprovalAction>)) return;
      if (await handleValidationsAction(msg as Partial<ValidationsAction>)) return;
      // t-610705 (Phase C.2) — no shape collision with any registry above (openFile/terminal/
      // loadOlder/shareExternal/copyShareText/shareToAgent are unique to Activity); route-gated
      // (route.kind !== "agent-activity" → false) same as every other handler in this chain.
      if (await handleActivityAction(msg as Partial<ActivityWebviewMessage>)) return;
      // t-610705 (Phase C.3) — "openFile"/"distill" are unique to Handoff; route-gated the same way.
      if (await handleHandoffAction(msg as Partial<HandoffAction>)) return;
      // t-610705 (Phase D, D0) — studio-envelope messages carry `studioProtocolVersion`, a field no
      // other action in this chain has; `handleStudioMessage` returns false (falls through) when
      // there's no current binding or the message doesn't decode, so this is safe unconditionally.
      if (await dispatchStudioMessage(msg)) return;

      // SDD 485 D3 — the two runtime-ops action arms left with the renderer. They are
      // `RuntimeOpsPanelManager.handleAction` now, reached through the manager's own `onMessage` seam
      // rather than through this chain.

      const c = msg as unknown as CockpitAction;
      switch (c.type) {
        case "studioNavCheckpointAck":
          if (typeof c.txnId === "string") handleStudioNavCheckpointAck(c);
          return;
        // t-6ced6f — no `case READY:` here. It is answered at the TOP of this listener, before the
        // per-route chain, and returns there; a second site would be a second thing to keep in sync.
        case "refresh":
          // SDD 485 B1 — the LOUDEST hidden-work door in Control, and not one the `views-changed`
          // fan-out reaches: `retainContextWhenHidden` keeps the client's own 3s timer alive behind
          // another tab, so a panel nobody is looking at used to run a full model collect twenty
          // times a minute, forever. Gated like every other refresh; the reveal replays exactly what
          // the next tick would have done.
          refreshControl("shell-poll");
          return;
        case "setSection":
          // t-610705 (Phase C.0) — sugar over navigate(); C.1+ adds a "navigate" message carrying
          // real subroute params once there's a subroute to send. Bumps navEpoch, so any in-flight
          // send*() from the section being left discards its result instead of posting it late.
          // t-610705 (Phase D, D0) — the load-bearing requestNavigate call site: a nav-tab click
          // while a dirty studio route is active goes through the navigation-transaction FSM.
          await requestNavigate(routes.section(resolveCockpitSection(c.section)), live, async () => {
            await sendModel();
            await sendSectionModule();
          });
          return;
        case "openProjectHandoff": {
          // t-ace77f — same resolve-then-navigate shape as fleetActivity: pick the workspace ONCE
          // at dispatch time (Control's current scope, falling back like every other action), then
          // bake that hash into the route as the document's immutable locator.
          const ws = resolveHandoffWs(deps.handoff);
          if (ws) {
            await requestNavigate(routes.projectHandoff(ws.wsHash), live, async () => {
              await sendModel();
              await sendSectionModule();
            });
          }
          return;
        }
        case "navigateReturn":
          // t-610705 (Phase D, D3) — pin's ONLY breadcrumb action. The DESTINATION is deliberately
          // never client-sent (design-dueto probe-43bca1cc: a client-sent route payload widens the
          // trust boundary from "pick one of N enum values" to "send back an arbitrary route object"
          // for no real benefit) — the host is the sole authority on where "back" goes, reading its
          // OWN already-sanitized `currentRoute.returnRoute`. `c.routeKey` is the client's identity
          // snapshot of the pin route it was showing when clicked — checked against the CURRENT
          // route before acting (design-dueto probe-12f603f3 major finding: without this, a delayed
          // click from a pin the user already navigated away from could fire against whatever pin is
          // current by the time this handler runs, navigating to the WRONG pin's returnRoute — a
          // stale-message confused-deputy bug, not route-payload injection, but still a real navigate-
          // to-the-wrong-place bug).
          if (!isStudioRoute(currentRoute) || currentRoute.studio !== "pin" || routeKey(currentRoute) !== c.routeKey) return;
          await requestNavigate(currentRoute.returnRoute ?? routes.section("overview"), live, async () => {
            await sendModel();
            await sendSectionModule();
          });
          return;
        case "navigateStudioParent":
          // SDD 485 C4 — Task Studio's breadcrumb when its parent is the task's own detail. Same
          // stale-click guard as "navigateReturn" above, and the same rule about destinations: the host
          // derives it (`parentRoute`), the client only says which route it was looking at. The parent it
          // computes is a task-detail route, which `navigate()` turns into "open that task's own tab".
          if (!isStudioRoute(currentRoute) || routeKey(currentRoute) !== c.routeKey) return;
          await requestNavigate(parentRoute(currentRoute) ?? routes.section("overview"), live, async () => {
            await sendModel();
            await sendSectionModule();
          });
          return;
        case "switchControlWorkspace":
          // t-d16a39 — "" = All workspaces. Re-send model (aggregate sections re-scope) AND the
          // active section's module (per-workspace sections re-resolve).
          // t-610705 (Phase C.0) — a scope switch also bumps navEpoch: it's the same "the world
          // changed" event class as navigation (a slow response built for the old scope must not
          // land after the switch).
          controlWorkspaceScope.set(c.wsHash || undefined);
          return;
        case "copyDiagnostics": {
          try {
            // A diagnostics dump is explicitly a full picture of the world, so it pays for both
            // classified reads on purpose — the one place where the old always-collect cost is right.
            const bundles = await deps.collect(COLLECT_EVERYTHING);
            const text = formatCockpitDiagnostics(buildCockpitModel(bundles, { section: navSection(currentRoute) ?? "overview" }));
            await vscode.env.clipboard.writeText(text);
            live.webview.postMessage(toastMessage(s.copied, "ok"));
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        }
        case "openSettings":
          deps.openSettings();
          return;
        // t-aaad95 — Control writes the global Tachyon file directly. It is a shell-owned, per-person
        // file: routing it through the engine would put a machine-local preference on the workspace
        // wire for no gain. `update` re-validates through the same parser a hand edit goes through,
        // so Control cannot write a document the loader would then refuse.
        case "setGlobalSettings":
          try {
            sharedGlobalSettings().update(c.patch);
            await sendModel();
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        case "openGlobalSettingsFile":
          await vscode.commands.executeCommand("tachyon.openGlobalSettings");
          return;
        // t-aaad95 — the personal override's home is the global Tachyon file now, and opening it is
        // also the documented recovery path when Control itself will not open.
        case "openPersonalCardTemplate":
          await vscode.commands.executeCommand("tachyon.openGlobalSettings");
          return;
        case "openDoctor":
          deps.openDoctor();
          return;
        case "revealPath":
          if (typeof c.path === "string" && c.path) deps.revealPath(c.path);
          return;
        case "copyText":
          if (typeof c.text === "string") {
            await vscode.env.clipboard.writeText(c.text);
            live.webview.postMessage(toastMessage(s.copied, "ok"));
          }
          return;
        case "openConfigFile":
          try {
            await deps.openConfigFile(typeof c.wsHash === "string" ? c.wsHash : undefined);
          } catch (err) {
            live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
          }
          return;
        case "setIdleAfterMinutes":
          // t-585d5c — the value was already validated by the runtime-api schema this calls into, so
          // the only check here is the shape the wire could malform.
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              await deps.setIdleAfterMinutes(c.wsHash, c.minutes);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  c.minutes === undefined
                    ? vscode.l10n.t("Idle notifications back to the default")
                    : c.minutes === "never"
                      ? vscode.l10n.t("Idle notifications turned off")
                      : vscode.l10n.t("Idle notifications after {0} min", String(c.minutes)),
                  "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "setCompanionTabTools":
          if (typeof c.wsHash === "string" && c.wsHash && typeof c.enabled === "boolean") {
            try {
              await deps.setCompanionTabTools(c.wsHash, c.enabled);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  c.enabled
                    ? vscode.l10n.t("Companion tab tools listed for agents")
                    : vscode.l10n.t("Companion tab tools hidden from agents"),
                "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "setCompanionAllowedHosts":
          if (typeof c.wsHash === "string" && c.wsHash && Array.isArray(c.hosts)) {
            try {
              const hosts = c.hosts.filter((h): h is string => typeof h === "string");
              await deps.setCompanionAllowedHosts(c.wsHash, hosts);
              await sendModel();
              live.webview.postMessage(
                toastMessage(
                  hosts.length === 0
                    ? vscode.l10n.t("Companion allowed hosts cleared (all hosts)")
                    : vscode.l10n.t("Companion allowed hosts updated ({0})", String(hosts.length)),
                "ok",
                ),
              );
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "unpairCompanionDevice":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              const deviceId = typeof c.deviceId === "string" && c.deviceId ? c.deviceId : undefined;
              await deps.unpairCompanionDevice(c.wsHash, deviceId);
              await sendModel();
              live.webview.postMessage(toastMessage(vscode.l10n.t("Companion device unpaired"), "ok"));
            } catch (err) {
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
        case "issueCompanionPairCode":
          if (typeof c.wsHash === "string" && c.wsHash) {
            try {
              const offer = await deps.issueCompanionPairCode(c.wsHash);
              live.webview.postMessage({ type: "companionPairOffer", offer });
              if (offer.ok) {
                live.webview.postMessage(
                  toastMessage(vscode.l10n.t("Companion pair code ready (expires soon)"), "ok"),
                );
              }
            } catch (err) {
              live.webview.postMessage({
                type: "companionPairOffer",
                offer: { ok: false, reason: err instanceof Error ? err.message : String(err) },
              });
              live.webview.postMessage(toastMessage(err instanceof Error ? err.message : String(err), "err"));
            }
          }
          return;
      }
    });
  }

  if (creating) {
    const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
    // t-610705 (SDD 410 Phase B) — CSS co-load: a section's sheet only loads eagerly in the shell
    // when it's the opening section (flash-free first paint); otherwise its URI ships via a
    // bootstrap global and the client injects it when the lazy section body loads
    // (src/webview/shared/lazySectionStyles.ts). Each Phase B PR moves one more surface's sheet
    // from always-eager to this scheme; sheets not yet migrated stay eager unconditionally.
    const approvalsIsActive = isSection(currentRoute, "approvals");
    const validationsIsActive = isSection(currentRoute, "validations");
    const activityIsActive = currentRoute.kind === "agent-activity";
    const probesIsActive = currentRoute.kind === "agent-probes" || currentRoute.kind === "workspace-probes";
    const handoffIsActive = currentRoute.kind === "project-handoff";
    // t-610705 (Phase D, D0/D1a) — studio-frame.css is shared by every StudioPanelManagerBase-based
    // studio (StudioFrame.tsx); each studio's OWN sheet is a separate conditional (D1b/D2/D3 add
    // theirs alongside command/terminal/runbook/schedule here, one `studioX ? uri(...) : undefined`
    // per StudioId — no shared/combined conditional the way mermaid-block.css above is, since each
    // studio's own sheet is genuinely distinct content, not the same href under a different
    // bootstrap-global key).
    const studioIsActive = isStudioRoute(currentRoute);
    const commandStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "command";
    const terminalStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "terminal";
    const runbookStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "runbook";
    const scheduleStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "schedule";
    const agentStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "agent";
    const pinStudioIsActive = isStudioRoute(currentRoute) && currentRoute.studio === "pin";
    // t-610705 (Phase C.2) — ported from the retired standalone ActivityPanel.ts: mermaid/katex load
    // ON DEMAND client-side (activity/markdown.tsx), gated on these globals being present at all —
    // never previously wired into Cockpit.ts's shell (Task Detail's C.1 migration also uses
    // MarkdownView but never needed these either; unrelated pre-existing gap, out of scope here).
    // Static bundle URIs are harmless to include even on a route that never triggers them.
    // t-aaad95 — the global Tachyon file, not VS Code settings. It always resolves a value (the
    // parser fills every field, and a refused document falls back to the last known good), so the
    // defensive `?? "auto"` the old getConfiguration read needed is gone with it.
    const codeTheme = sharedGlobalSettings().current().activityCodeTheme;
    const activityThemeClass = codeTheme === "dark" ? "tac-theme-dark" : codeTheme === "light" ? "tac-theme-light" : "";
    live.webview.html = renderWebviewShell({
      cspSource: live.webview.cspSource,
      title: s.title,
      bodyClass: activityThemeClass || undefined,
      // Task Studio embeds PrototypePreview's sandboxed srcdoc iframe (read-only prototype review), which
      // needs frame-src 'self'. SDD 485 C4 moved the task DETAIL out of Control, so it is no longer the
      // reason this grant exists — the studio route still is. Purely additive to the CSP.
      frameSrc: "self",
      // t-610705 (Phase D, D2) — the CSP tranche the design doc's security-probe requirement exists
      // to gate. Verified against the actual code paths (not copied blind from the retired
      // TaskStudioPanel.ts config), per probe-6a55db50's adversarial review:
      //  - imgBlob: pasted-image blob: URLs rendered inline in the rich-doc editor.
      //  - connectSrc: rich-doc/VisualsPanel.tsx's uriToDataURL() does `fetch(att.uri)` on a same-
      //    origin asWebviewUri resource (the "annotate an existing image" flow) — without this,
      //    that fetch is blocked outright (falls back to default-src 'none').
      //  - workerSrc: "blob" — Excalidraw's own vendor bundle constructs a Worker via
      //    `new Worker(URL.createObjectURL(...))`; confirmed by grepping
      //    node_modules/@excalidraw/excalidraw/dist for the literal `new Worker(` call.
      //  - childSrc: "blob" was DROPPED (present in the old standalone panel's config, copied
      //    forward into the first cut of this diff) — the probe's adversarial pass caught that it's
      //    INERT here: CSP only falls back to child-src for frame/worker loads when frame-src/
      //    worker-src are ABSENT, and this shell always sets frame-src ('self', for the unrelated
      //    PrototypePreview iframe) and worker-src (blob:, above) explicitly — so child-src's blob:
      //    token is never consulted for either. No blob-iframe usage exists in rich-doc/excalidraw
      //    to justify it either way. Removing it shrinks the grant to only what's provably load-
      //    bearing.
      //
      // t-610705 (Phase D, D3) — "CSP tranche 2" (studios-routes-design.md's sequencing table) turns
      // out to add NOTHING new: Pin Studio's attachment/Excalidraw needs are a strict subset of Task
      // Studio's (same putXStudioImage/putXStudioSketch base64-in, dataUri-out pattern — see
      // PinStudioTarget.ts's D3 port of TaskStudioTarget.ts's D2 fix — no CAS, no prototype iframe).
      // The grants below already cover it; re-verified against Pin's actual diff by its own
      // pre-landing adversarial probe rather than assumed. See D2's comment immediately below for
      // each grant's own justification (still accurate, now serving 2 studios instead of 1).
      //
      // Emitted ONCE at panel creation for Control's whole lifetime (this `<meta>` isn't re-rendered
      // per route) — a PERMANENT grant across the entire Cockpit surface, not scoped to when a Task
      // Studio route is actually active. The probe's verdict (SHIP WITH CONDITIONS) and the
      // maintainer's recorded acceptance of the panel-wide-CSP trade-off are in t-610705's journal.
      imgBlob: true,
      connectSrc: true,
      workerSrc: "blob",
      // No nested `[...]` inside this literal — test/unit/cockpitCssParity.test.ts source-scans this
      // exact array via a non-greedy `styles:\s*\[([\s\S]*?)\]` regex, so an inline array literal
      // (e.g. a `...(cond ? [x] : [])` spread) closes the match early at ITS `]` and silently
      // truncates everything after. Ternary-to-undefined + filter keeps the block bracket-free.
      styles: [
        uri("codicon.css"),
        uri("design-system.css"),
        uri("vscode-theme.css"),
        approvalsIsActive ? uri("approval.css") : undefined,
        validationsIsActive ? uri("validations.css") : undefined,
        // one shared conditional for the mermaid stylesheet — task-detail and activity both render
        // markdown that can carry mermaid blocks; a second, separately-gated call for that same file
        // would duplicate the link and fail cockpitCssParity's no-duplicate-link check (its source
        // scan can't tell a real call from one merely mentioned in a comment, so don't write it here).
        (activityIsActive || handoffIsActive) ? uri("mermaid-block.css") : undefined,
        activityIsActive ? uri("activity.css") : undefined,
        probesIsActive ? uri("probes.css") : undefined,
        handoffIsActive ? uri("handoff.css") : undefined,
        // t-610705 (Phase D, D1b) — Agent Studio's Tailwind utilities sheet loads BEFORE studio-frame.css
        // (not alongside its own surface sheet below) — matches the retired standalone panel's
        // styleFiles order exactly (vscode-theme.css → agent-studio-shell.tailwind.css → studio-frame.css
        // → agent-studio-shell.css), so studio-frame.css's own rules still win the cascade over any
        // Tailwind utility class at equal specificity, same as it always has for this surface.
        agentStudioIsActive ? uri("agent-studio-shell.tailwind.css") : undefined,
        // t-610705 (Phase D, D2) — same Tailwind-before-studio-frame ordering as Agent Studio above;
        // rich-doc.css (entity-neutral editor styles, shared with the retired standalone panel + the
        // dev preview harness) loads BEFORE studio-frame.css too — matches the old standalone panel's
        // `styleFiles` order exactly (codicon, design-system, vscode-theme, task-studio.tailwind,
        // rich-doc, studio-frame, task-studio), so studio-frame.css's shell-chrome rules still win the
        // cascade over rich-doc.css at equal specificity, same as they always have for this surface.
        // t-610705 (Phase D, D3) — Pin Studio shares Task Studio's rich-doc.css (same entity-neutral
        // editor sheet, no Tailwind sheet of its own) — one shared conditional, same reasoning as the
        // "*-mermaid" shared conditionals above (a second, separately-gated call for the identical
        // file would duplicate the <link> and fail cockpitCssParity's no-duplicate-link check).
        pinStudioIsActive ? uri("rich-doc.css") : undefined,
        studioIsActive ? uri("studio-frame.css") : undefined,
        commandStudioIsActive ? uri("command-studio-shell.css") : undefined,
        terminalStudioIsActive ? uri("terminal-studio-shell.css") : undefined,
        runbookStudioIsActive ? uri("runbook-studio-shell.css") : undefined,
        scheduleStudioIsActive ? uri("schedule-studio-shell.css") : undefined,
        agentStudioIsActive ? uri("agent-studio-shell.css") : undefined,
        pinStudioIsActive ? uri("pin-studio.css") : undefined,
        // SDD 485 D6 linked `control-typography.css` here because Control used `ck-mono` six times.
        // D10 took the last five with Settings, and the count is now ZERO — measured across
        // `cockpit/` and `shared/`, not assumed. A host that links a sheet it does not consume ships
        // bytes for nothing and, worse, hides when the last consumer left. Removed here; the three
        // apps that DO consume it (Fleet, Worktrees, Settings) keep linking it themselves.
        //
        // D7 predicted this shape would arrive at Phase E, when Control's shell retires. It arrived at
        // D10 instead, and nothing caught it: the Phase A "mirror" rule is about the PAGE-FRAME
        // dependency (a `#root` percentage height must link the sheet that provides the frame), not a
        // general "every linked sheet is consumed". `webviewLinkedSheetUse.test.ts` now asks that
        // second question.
        //
        // SDD 485 D7 — Control has 0 ck-card-list and 0 ci-* consumers after Fleet leaves, but its own
        // no-model fallback still uses `ck-empty`, so THIS sheet stays anchored by exactly one class.
        uri("engine-workspace.css"),
        uri("cockpit.css"),
      ].filter((href): href is string => href !== undefined),
      bundle: uri("cockpit.js"),
      module: true,
      mode: "live",
      // t-610705 (Phase C.0) — always PERSIST v2 (route, not section); decodePanelState still
      // understands a v1 disk record for the restore boundary of a panel closed before this PR.
      persistedState: {
        schemaVersion: 2,
        view: COCKPIT_VIEW_TYPE,
        route: currentRoute,
        ...(controlWorkspaceScope.current ? { wsHash: controlWorkspaceScope.current } : {}),
      } satisfies CockpitPanelState,
      bootstrapGlobals: {
        /**
         * SDD 479 phase 4 — the sidebar stylesheet, for the card preview's SHADOW ROOT only.
         *
         * Deliberately NOT a `__tachyonSectionStyles` entry: every key in that map is co-loaded into
         * `<head>` by `loadSectionStylesheet` (and `cockpitCssParity.test.ts` enforces that pairing).
         * `sidebar.css` is a global sheet — it styles `body`, `#root`, `.row` — so reaching this page's
         * head would restyle Control. It travels alone, and only the shadow root links it.
         */
        __tachyonCardPreviewCss: uri("sidebar.css"),
        __tachyonSectionStyles: {
          approvals: uri("approval.css"),
          validations: uri("validations.css"),
          "activity-mermaid": uri("mermaid-block.css"),
          activity: uri("activity.css"),
          probes: uri("probes.css"),
          "handoff-mermaid": uri("mermaid-block.css"),
          handoff: uri("handoff.css"),
          // per-studio "studio-frame-<id>" keys (not one shared "studio-frame") — see
          // cockpit/App.tsx's doc comment on the lazy studio blocks for why: same convention as the
          // 3 "*-mermaid" keys above, one distinct key per client call site even though every key
          // resolves to the same studio-frame.css href.
          "studio-frame-command": uri("studio-frame.css"),
          "studio-command": uri("command-studio-shell.css"),
          "studio-frame-terminal": uri("studio-frame.css"),
          "studio-terminal": uri("terminal-studio-shell.css"),
          "studio-frame-runbook": uri("studio-frame.css"),
          "studio-runbook": uri("runbook-studio-shell.css"),
          "studio-frame-schedule": uri("studio-frame.css"),
          "studio-schedule": uri("schedule-studio-shell.css"),
          "studio-frame-agent": uri("studio-frame.css"),
          "studio-agent-tailwind": uri("agent-studio-shell.tailwind.css"),
          "studio-agent": uri("agent-studio-shell.css"),
          // t-610705 (Phase D, D3) — own key even though it resolves to the SAME rich-doc.css href as
          // "studio-task-richdoc" — matches the per-studio-key convention "studio-frame-<id>" already
          // uses (one distinct key per client call site, not a shared key across two lazy blocks).
          "studio-frame-pin": uri("studio-frame.css"),
          "studio-pin-richdoc": uri("rich-doc.css"),
          "studio-pin": uri("pin-studio.css"),
        },
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: codeTheme,
        // t-610705 (Phase D, D2) — Task Studio's VisualsPanel/SketchModal read these three
        // `window.*` globals (task-studio/App.tsx's `readAssets()`) to locate the Excalidraw bundle —
        // same shape TaskStudioPanel.ts's (retired) standalone `bootstrapGlobals` already provided,
        // now emitted unconditionally like every other bootstrap global here (harmless on a route
        // that never mounts Task Studio — same reasoning Phase C.2's mermaid/katex URIs already use).
        EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
        EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
        EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
      },
    });
  } else {
    await sendModel();
    await sendSectionModule();
  }
}
