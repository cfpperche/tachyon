import type { CockpitModel, CockpitSectionId } from "../../../cockpit/model.js";
import { READY } from "../ready.js";

export const INIT = "init" as const;
export const MODEL = "model" as const;

export interface CockpitStrings {
  title: string;
  subtitle: string;
  navOverview: string;
  navEngine: string;
  navFleet: string;
  /** t-e76acc — the unified Human Inbox tab (approvals + validations, one navigation). */
  navInbox: string;
  navApprovals: string;
  navMission: string;
  navValidations: string;
  navHandoff: string;
  navWorktrees: string;
  navRuntime: string;
  navRuntimeConfig: string;
  navTmux: string;
  navPlugins: string;
  navSettings: string;
  /** t-610705 (Phase D, D3) — pin's breadcrumb generic label, for a returnRoute kind with no fixed
   *  nav-tab name of its own (agent-activity/agent-probes/workspace-probes — every OTHER studio's
   *  breadcrumb already has a specific label: the parent section's own nav name, or "Board" for
   *  Task's task-detail parent). */
  back: string;
  refresh: string;
  auto: string;
  empty: string;
  copyDiagnostics: string;
  openBoard: string;
  openSettings: string;
  openDoctor: string;
  copied: string;
  overviewTitle: string;
  overviewHint: string;
  engineTitle: string;
  fleetTitle: string;
  fleetHint: string;
  approvalsTitle: string;
  approvalsHint: string;
  missionTitle: string;
  missionHint: string;
  validationsTitle: string;
  validationsHint: string;
  settingsTitle: string;
  settingsHint: string;
  workspaces: string;
  engines: string;
  agents: string;
  errors: string;
  bridges: string;
  approvals: string;
  /** t-e76acc — Overview's single "waiting on a human" metric label. */
  inbox: string;
  worktrees: string;
  attached: string;
  error: string;
  none: string;
  state: string;
  pid: string;
  version: string;
  instance: string;
  started: string;
  bundle: string;
  protocol: string;
  url: string;
  port: string;
  auth: string;
  root: string;
  hash: string;
  running: string;
  stopped: string;
  checkedAt: string;
  /** t-ac79a7 — navigation feedback: progress label, stalled banner, and its retry. */
  navLoading: string;
  navStalled: string;
  navRetry: string;
  open: string;
  noneListed: string;
  kind: string;
  branch: string;
  status: string;
  phase: string;
  path: string;
  name: string;
  start: string;
  stop: string;
  openTerminal: string;
  openActivity: string;
  openProbes: string;
  editAgent: string;
  /** SDD 443 — continue unfinished task on another agent (new session + handoff). */
  continueTask: string;
  /** QuickPicker title: "Continue task from {0} in…" */
  continueTaskPickTitle: string;
  /** Honesty line under the picker title. */
  continueTaskPickSubtitle: string;
  continueTaskPickPlaceholder: string;
  continueTaskPickEmpty: string;
  continueTaskDestStopped: string;
  continueTaskDestRunning: string;
  continueTaskDestDetail: string;
  continueTaskNoDest: string;
  reveal: string;
  copyPath: string;
  copyId: string;
  openConfig: string;
  settingsBody: string;
  /** t-7b4bb5 — dual-scope explainer cards at the top of Control → Settings. */
  settingsScopeGlobalTitle: string;
  settingsScopeGlobalHint: string;
  settingsScopeWorkspaceTitle: string;
  settingsScopeWorkspaceHint: string;
  settingsFileLabel: string;
  settingsOpenTachyon: string;
  settingsOpenConfig: string;
  settingsDoctor: string;
  settingsWritesTo: string;
  settingsWritesToEither: string;
  settingsWritesToNothing: string;
  /** SDD 479 phase 4 — the Control → Settings card-template block. */
  cardTemplateTitle: string;
  cardTemplateHint: string;
  cardTemplateComposer: string;
  cardTemplateBody: string;
  cardTemplateYamlHint: string;
  cardTemplateCopy: string;
  cardTemplateReset: string;
  cardTemplateCriticalNote: string;
  cardTemplateInlineNote: string;
  /** SDD 479 phase 5 — the "which home is in effect" statement and the personal home's controls. */
  cardTemplateInEffect: string;
  cardTemplatePersonalActive: string;
  cardTemplatePersonalRefused: string;
  cardTemplatePersonalNone: string;
  cardTemplateProjectNone: string;
  cardTemplateProjectConfigured: string;
  cardTemplateProjectRefused: string;
  cardTemplateHomeLabel: string;
  cardTemplateHomeProject: string;
  cardTemplateHomePersonal: string;
  cardTemplateCopyJson: string;
  cardTemplateJsonHint: string;
  cardTemplateOpenSettings: string;
  companionTitle: string;
  companionHint: string;
  companionBody: string;
  companionTabTools: string;
  companionTabToolsHelp: string;
  companionAllowedHosts: string;
  companionAllowedHostsHelp: string;
  /** SDD 488 F4 — Integrated Browser GA gate. */
  ideBrowserTitle: string;
  ideBrowserHint: string;
  ideBrowserBody: string;
  ideBrowserEnabled: string;
  ideBrowserEnabledHelp: string;
  // t-585d5c — Control -> Settings, idle-notification window.
  idleNotifyTitle: string;
  idleNotifyHelp: string;
  idleNotifyUnit: string;
  idleNotifyUsingDefault: string;
  idleNotifyOff: string;
  idleNotifyOffLabel: string;
  idleNotifySave: string;
  idleNotifyReset: string;
  // t-aaad95 — Control -> Settings owns both scopes now that VS Code contributes none.
  globalSettingsTitle: string;
  globalSettingsHint: string;
  globalSettingsFileLabel: string;
  globalSettingsOpenFile: string;
  globalSettingsRefused: string;
  globalSettingsCodeTheme: string;
  globalSettingsCodeThemeHelp: string;
  globalSettingsCodeThemeAuto: string;
  globalSettingsCodeThemeDark: string;
  globalSettingsCodeThemeLight: string;
  globalSettingsAgentPane: string;
  globalSettingsAgentPaneHelp: string;
  globalSettingsGitPath: string;
  globalSettingsGitPathHelp: string;
  globalSettingsSave: string;
  globalSettingsLive: string;
  globalSettingsNeedsReopen: string;
  workspaceSettingsTitle: string;
  workspaceSettingsHint: string;
  companionAllowedHostsPlaceholder: string;
  companionAllowedHostsSave: string;
  companionPaired: string;
  companionNotPaired: string;
  companionPickWorkspace: string;
  companionBaseUrl: string;
  /** SDD 414 — Control pair-code affordance (command palette still works). */
  companionShowPairCode: string;
  companionCopyBaseUrl: string;
  companionPairCodeLabel: string;
  companionPairUrlLabel: string;
  companionPairExpires: string;
  companionPairExpired: string;
  companionCopyCode: string;
  companionCopyUrl: string;
  companionCopyAll: string;
  companionNewCode: string;
  companionPairUnavailable: string;
  companionPairQrLabel: string;
  companionPairQrHint: string;
  companionPairCandidatesLabel: string;
  companionCopyPayload: string;
  companionLanAccessHint: string;
  devicesTitle: string;
  devicesHint: string;
  devicesEmpty: string;
  devicesUnpair: string;
  devicesLive: string;
  devicesOffline: string;
  devicesKindBrowser: string;
  devicesKindMobile: string;
  devicesPairedAt: string;
  saved: string;
  temporary: string;
  agent: string;
  change: string;
}

export type CockpitAction =
  | { type: typeof READY }
  | { type: "refresh" }
  | { type: "copyDiagnostics" }
  | { type: "openSettings" }
  | { type: "openPersonalCardTemplate" }
  | { type: "openDoctor" }
  | { type: "setSection"; section: CockpitSectionId }
  /** t-d16a39 — shell-level workspace scope. t-72ff5a — always a real wsHash: the "all workspaces"
   *  aggregate was removed when the selection moved to the sidebar chrome and began to scope its tabs. */
  | { type: "switchControlWorkspace"; wsHash: string }
  | { type: "fleetStart"; name: string; wsHash?: string }
  | { type: "fleetStop"; name: string; wsHash?: string }
  | { type: "fleetTerminal"; name: string; wsHash?: string }
  | { type: "fleetActivity"; name: string; wsHash?: string }
  /** t-610705 (Phase D, D1c) — Fleet's own "Probes" button (the agent-probes subroute existed since
   *  C.2 but was only ever reachable via the agent-less `tachyon.openProbes` command). */
  | { type: "fleetProbes"; name: string; wsHash?: string }
  /** t-610705 (Phase D, D1c) — Fleet's own "Edit" button, opening the agent's definition in Agent or
   *  Terminal Studio (same kind-routed dispatch as the sidebar's `tachyon.editAgentStudioItem`). */
  | { type: "fleetAgentStudio"; name: string; wsHash?: string }
  /** SDD 443 — Continue task in… (webview QuickPicker chose destination; host invokes only). */
  | { type: "fleetContinueTask"; name: string; toName: string; wsHash?: string }
  | { type: "revealPath"; path: string }
  | { type: "openRuntimeConfigSource"; path: string }
  | { type: "saveRuntimeConfigChanges"; runtime: "codex" | "claude" | "grok"; documentId: string; expectedRevision?: string; changes: Array<{ kind: "setting"; key: string; value: unknown } | { kind: "set-mcp-enabled"; name: string; enabled: boolean }> }
  | { type: "copyText"; text: string }
  | { type: "openConfigFile"; wsHash?: string }
  | { type: "engineLogClear"; wsHash: string }
  | { type: "engineLogJournal"; wsHash: string }
  /** SDD 414 — patch settings.companion.tabTools for one workspace. */
  | { type: "setCompanionTabTools"; wsHash: string; enabled: boolean }
  /** SDD 488 F4 — patch settings.ideBrowser.enabled for one workspace. */
  | { type: "setIdeBrowserEnabled"; wsHash: string; enabled: boolean }
  // t-585d5c — `minutes` absent means "reset to the product default", which REMOVES the key rather
  // than writing the default number; `"never"` is the explicit off.
  | { type: "setIdleAfterMinutes"; wsHash: string; minutes?: number | "never" }
  | { type: "setGlobalSettings"; patch: { activityCodeTheme?: "auto" | "dark" | "light"; agentPaneEnabled?: boolean; gitPath?: string } }
  | { type: "openGlobalSettingsFile" }
  /** SDD 420 — patch settings.companion.allowedHosts for one workspace. */
  | { type: "setCompanionAllowedHosts"; wsHash: string; hosts: string[] }
  /** SDD 414/422 — host unpair; deviceId clears one row, omit clears all. */
  | { type: "unpairCompanionDevice"; wsHash: string; deviceId?: string }
  /** SDD 414 — mint a short-lived pair code (same op as tachyon.pairCompanion). */
  | { type: "issueCompanionPairCode"; wsHash: string }
  /**
   * t-610705 (Phase D, D0) — the client's reply to a `studioNavCheckpoint` host push: the EXACT
   * freeze-moment state (studios-routes-design.md's navigation-transaction FSM). Cockpit-level, not
   * a studio-envelope message — this is about ROUTE navigation, which is Cockpit's job. `patch` is
   * opaque to the router (the studio's own domain shape); the host only ever stores or hands it back
   * to that same studio's adapter, never inspects it.
   */
  | { type: "studioNavCheckpointAck"; txnId: string; dirty: boolean; editRevision: number; patch: unknown }
  /** t-610705 (Phase D, D3) — pin's ONE breadcrumb action. `routeKey` carries NO destination (the
   *  host still reads its own `currentRoute.returnRoute`, never anything client-sent) — it's the
   *  client's identity snapshot of the pin route it was showing when the button was clicked, echoed
   *  back so the host can detect a stale/queued click (design-dueto probe-12f603f3 major finding: a
   *  delayed click from pin A processed after a fast navigation to pin B would otherwise navigate to
   *  B's returnRoute instead of being silently dropped). See Cockpit.ts's "navigateReturn" case. */
  | { type: "navigateReturn"; routeKey: string }
  /**
   * SDD 485 C4 — "go to this studio route's parent", for the one studio whose parent is NOT a flat
   * section: Task Studio's edit route, whose parent is the task's own detail (`route.ts`'s parentRoute).
   * That used to be answered by posting Task Detail's `openTask` and letting Control navigate in place;
   * the task detail is its own app now, so the destination is no longer a section the client can name.
   *
   * Same trust shape as `navigateReturn` above, and for the same reason: the client sends NO destination,
   * only its identity snapshot of the route it was showing, so a queued click from a route the human has
   * already left is dropped instead of firing against whatever is current. The host derives the
   * destination from `parentRoute(currentRoute)` — and `navigate()` is what turns a task-detail parent
   * into "open that task's tab, land Control on the Board".
   */
  | { type: "navigateStudioParent"; routeKey: string }
  /** t-ace77f — Overview's Handoff entry: the host resolves the workspace and navigates to the
   *  `project-handoff` route. No section to switch to any more — the tab is gone. */
  | { type: "openProjectHandoff" }
  ;

/** Ephemeral pair offer — not part of the polled CockpitModel. */
export type CompanionPairOffer =
  | {
      ok: true;
      code: string;
      baseUrl: string;
      /** SDD 422 — loopback + LAN candidates for multi-NIC hosts. */
      baseUrls?: string[];
      expiresAt: string;
      protocolVersion?: number;
      prefix?: string;
      /** Compact JSON for mobile QR payload (also embedded in openUrl hash). */
      qrPayload?: string;
      /**
       * Deep link: engine-served PWA + #pair= payload.
       * QR encodes this so camera scan opens the browser and auto-pairs.
       */
      openUrl?: string;
      /** PNG data URL of openUrl (preferred) or qrPayload. */
      qrDataUrl?: string;
    }
  | { ok: false; reason: string };

export type CockpitHostMessage =
  | { type: typeof INIT; strings: CockpitStrings }
  | { type: typeof MODEL; model: CockpitModel }
  /** Product toast (t-963b66). `tone` optional for back-compat (defaults to info). */
  | { type: "toast"; text: string; tone?: "info" | "ok" | "warn" | "err"; context?: string }
  | { type: "companionPairOffer"; offer: CompanionPairOffer }
  /** t-610705 (Phase D, D0) — host asks the mounted studio form to freeze and report its exact
   *  state; see `studioNavCheckpointAck` above. */
  | { type: "studioNavCheckpoint"; txnId: string }
  /** t-610705 (Phase D, D0) — "Stay" (or a rejected Save) — the client unfreezes, nothing lost. */
  | { type: "studioNavAbort"; txnId: string }
  /**
   * t-ac79a7 — the navigation-feedback bracket. `routePending` is posted SYNCHRONOUSLY from
   * `navigate()` (Cockpit.ts), the single commit point every navigation intent funnels through, so
   * it reaches the client before the host does any awaited work. That matters because the model
   * push behind it waits on `deps.collect()` — a serial per-workspace sweep of engine round-trips
   * (see t-af3eef) — which is why a Board click used to leave the screen untouched for seconds and
   * then swap abruptly: the client learned nothing until that finished.
   *
   * `routeReady` closes the bracket from the end of `sendSectionModule()`, the one place that
   * finishes loading the active route's module. One emit each — every route kind gets the
   * pending/ready pair with no per-route duplication.
   *
   * `routeKey` identifies WHICH navigation, so a stale ready (a superseded route finishing after a
   * newer one started) can be ignored rather than clearing the wrong pending state.
   */
  | { type: "routePending"; routeKey: string }
  | { type: "routeReady"; routeKey: string };

export const readyMessage = (): CockpitAction => ({ type: READY });
export const refreshAction = (): CockpitAction => ({ type: "refresh" });
export const copyDiagnosticsAction = (): CockpitAction => ({ type: "copyDiagnostics" });
export const openSettingsAction = (): CockpitAction => ({ type: "openSettings" });
export const openDoctorAction = (): CockpitAction => ({ type: "openDoctor" });
export const setSectionAction = (section: CockpitSectionId): CockpitAction => ({ type: "setSection", section });
export const navigateReturnAction = (routeKey: string): CockpitAction => ({ type: "navigateReturn", routeKey });
export const navigateStudioParentAction = (routeKey: string): CockpitAction => ({ type: "navigateStudioParent", routeKey });
/**
 * SDD 479 phase 5 — open the settings editor filtered to the personal card-template key. A distinct
 * action from `openConfigFile`: one home is a file in the repo, the other a key in VS Code settings,
 * and the block's button must land on the one the person actually picked.
 */
export const openPersonalCardTemplateAction = (): CockpitAction => ({ type: "openPersonalCardTemplate" });

export const openProjectHandoffAction = (): CockpitAction => ({ type: "openProjectHandoff" });
export const switchControlWorkspaceAction = (wsHash: string): CockpitAction => ({ type: "switchControlWorkspace", wsHash });
export const fleetStartAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetStart",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetStopAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetStop",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetTerminalAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetTerminal",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetActivityAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetActivity",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetProbesAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetProbes",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetAgentStudioAction = (name: string, wsHash?: string): CockpitAction => ({
  type: "fleetAgentStudio",
  name,
  ...(wsHash ? { wsHash } : {}),
});
export const fleetContinueTaskAction = (
  name: string,
  toName: string,
  wsHash?: string,
): CockpitAction => ({
  type: "fleetContinueTask",
  name,
  toName,
  ...(wsHash ? { wsHash } : {}),
});
export const revealPathAction = (path: string): CockpitAction => ({ type: "revealPath", path });
export const copyTextAction = (text: string): CockpitAction => ({ type: "copyText", text });
export const openConfigFileAction = (wsHash?: string): CockpitAction => ({
  type: "openConfigFile",
  ...(wsHash ? { wsHash } : {}),
});
export const engineLogClearAction = (wsHash: string): CockpitAction => ({ type: "engineLogClear", wsHash });
export const engineLogJournalAction = (wsHash: string): CockpitAction => ({ type: "engineLogJournal", wsHash });
export const setGlobalSettingsAction = (
  patch: { activityCodeTheme?: "auto" | "dark" | "light"; agentPaneEnabled?: boolean; gitPath?: string },
): CockpitAction => ({ type: "setGlobalSettings", patch });

export const openGlobalSettingsFileAction = (): CockpitAction => ({ type: "openGlobalSettingsFile" });

export const setIdleAfterMinutesAction = (wsHash: string, minutes?: number | "never"): CockpitAction => ({
  type: "setIdleAfterMinutes",
  wsHash,
  ...(minutes === undefined ? {} : { minutes }),
});

export const setCompanionTabToolsAction = (wsHash: string, enabled: boolean): CockpitAction => ({
  type: "setCompanionTabTools",
  wsHash,
  enabled,
});
export const setIdeBrowserEnabledAction = (wsHash: string, enabled: boolean): CockpitAction => ({
  type: "setIdeBrowserEnabled",
  wsHash,
  enabled,
});
export const setCompanionAllowedHostsAction = (wsHash: string, hosts: string[]): CockpitAction => ({
  type: "setCompanionAllowedHosts",
  wsHash,
  hosts,
});
export const unpairCompanionDeviceAction = (wsHash: string, deviceId?: string): CockpitAction => ({
  type: "unpairCompanionDevice",
  ...(deviceId ? { deviceId } : {}),
  wsHash,
});
export const issueCompanionPairCodeAction = (wsHash: string): CockpitAction => ({
  type: "issueCompanionPairCode",
  wsHash,
});
export const studioNavCheckpointAckAction = (txnId: string, dirty: boolean, editRevision: number, patch: unknown): CockpitAction => ({
  type: "studioNavCheckpointAck",
  txnId,
  dirty,
  editRevision,
  patch,
});

export const initMessage = (strings: CockpitStrings): CockpitHostMessage => ({ type: INIT, strings });
export const modelMessage = (model: CockpitModel): CockpitHostMessage => ({ type: MODEL, model });
/** Host → webview product toast. Prefer tone: err on failures, ok on success. */
export const toastMessage = (
  text: string,
  tone: "info" | "ok" | "warn" | "err" = "info",
  context?: string,
): CockpitHostMessage => ({
  type: "toast",
  text,
  tone,
  ...(context ? { context } : {}),
});
/**
 * t-ac79a7 — the two thresholds a pending navigation escalates through, shared so the behavioural
 * tests assert against the same numbers the UI uses instead of re-declaring them.
 *
 * NAV_SLOW_MS: how long a navigation may take before the SHELL shows a progress bar. The actuated
 * element acknowledges the click at 0ms regardless; this only keeps a fast navigation from flashing
 * chrome on and off.
 * NAV_STALL_MS: the bound past which the UI stops claiming progress it cannot observe and offers a
 * retry instead. Without it a host that never answers leaves a spinner running forever.
 */
export const NAV_SLOW_MS = 300;
export const NAV_STALL_MS = 15_000;

export const routePendingMessage = (routeKey: string): CockpitHostMessage => ({ type: "routePending", routeKey });
export const routeReadyMessage = (routeKey: string): CockpitHostMessage => ({ type: "routeReady", routeKey });
export const studioNavCheckpointMessage = (txnId: string): CockpitHostMessage => ({ type: "studioNavCheckpoint", txnId });
export const studioNavAbortMessage = (txnId: string): CockpitHostMessage => ({ type: "studioNavAbort", txnId });
export const companionPairOfferMessage = (offer: CompanionPairOffer): CockpitHostMessage => ({
  type: "companionPairOffer",
  offer,
});

/** Clipboard blob matching tachyon.pairCompanion (code + baseUrl + expires). */
export function formatCompanionPairClipboard(offer: Extract<CompanionPairOffer, { ok: true }>): string {
  const urls = offer.baseUrls?.length ? offer.baseUrls.join(",") : offer.baseUrl;
  const base = `code=${offer.code} baseUrl=${offer.baseUrl} expires=${offer.expiresAt}`;
  const bits = [base];
  if (offer.openUrl) bits.push(`openUrl=${offer.openUrl}`);
  if (offer.qrPayload) bits.push(`qrPayload=${offer.qrPayload}`);
  if (offer.baseUrls?.length) bits.push(`baseUrls=${urls}`);
  return bits.join(" ");
}
