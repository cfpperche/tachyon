import type { CockpitModel, CockpitSectionId } from "../../cockpit/model.js";
import { READY } from "../shared/ready.js";

export const INIT = "init" as const;
export const MODEL = "model" as const;

export interface CockpitStrings {
  title: string;
  subtitle: string;
  navOverview: string;
  navEngine: string;
  navFleet: string;
  navApprovals: string;
  navMission: string;
  navValidations: string;
  navHandoff: string;
  navWorktrees: string;
  navDeliveries: string;
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
  openMissionControl: string;
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
  handoffTitle: string;
  handoffHint: string;
  worktreesTitle: string;
  worktreesHint: string;
  deliveriesTitle: string;
  deliveriesHint: string;
  runtimeTitle: string;
  runtimeHint: string;
  runtimeConfigTitle: string;
  runtimeConfigHint: string;
  runtimeConfigPrototype: string;
  runtimeConfigGlobal: string;
  runtimeConfigWorkspace: string;
  runtimeConfigRuntime: string;
  runtimeConfigScope: string;
  runtimeConfigCapabilitiesTitle: string;
  runtimeConfigDetected: string;
  runtimeConfigKnown: string;
  runtimeConfigCapabilities: string;
  runtimeConfigOther: string;
  runtimeConfigOtherHint: string;
  runtimeConfigSourceFile: string;
  runtimeConfigUsedBy: string;
  runtimeConfigConfigured: string;
  runtimeConfigEnabled: string;
  runtimeConfigDisabled: string;
  runtimeConfigReload: string;
  runtimeConfigOpenFile: string;
  runtimeConfigSave: string;
  runtimeConfigViewRaw: string;
  tmuxTitle: string;
  tmuxHint: string;
  pluginsTitle: string;
  pluginsHint: string;
  settingsTitle: string;
  settingsHint: string;
  workspaces: string;
  engines: string;
  agents: string;
  errors: string;
  bridges: string;
  approvals: string;
  worktrees: string;
  deliveries: string;
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
  settingsOpenTachyon: string;
  settingsOpenConfig: string;
  settingsDoctor: string;
  companionTitle: string;
  companionHint: string;
  companionBody: string;
  companionTabTools: string;
  companionTabToolsHelp: string;
  companionAllowedHosts: string;
  companionAllowedHostsHelp: string;
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
  declared: string;
  adhoc: string;
  agent: string;
  change: string;
  /** spec 444 — Worktrees hygiene groups + actions. */
  wtReadyTitle: string;
  wtReadyDesc: string;
  wtReviewTitle: string;
  wtReviewDesc: string;
  wtOccupiedTitle: string;
  wtOccupiedDesc: string;
  wtRecordTitle: string;
  wtRecordDesc: string;
  wtRemoveCheckout: string;
  wtForgetRecord: string;
  wtAlsoDeleteBranch: string;
  wtSelectAll: string;
  wtClearSelection: string;
  wtSelected: string;
  wtReviewConfirm: string;
  wtConfirmTitle: string;
  wtConfirmBody: string;
  wtConfirmRun: string;
  wtCancel: string;
  wtEngineUnavailable: string;
  wtBlocked: string;
  wtOccupiedBy: string;
  wtShowAll: string;
  /** t-43c6fa — Deliveries tab classification badges (spec 365 signals, now actually surfaced). */
  dlvMissingRef: string;
  dlvLive: string;
  dlvUnmerged: string;
}

export type CockpitAction =
  | { type: typeof READY }
  | { type: "refresh" }
  | { type: "copyDiagnostics" }
  | { type: "openSettings" }
  | { type: "openDoctor" }
  | { type: "setSection"; section: CockpitSectionId }
  /** t-d16a39 — shell-level workspace scope; "" selects "All workspaces". */
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
  | { type: "copyText"; text: string }
  | { type: "openConfigFile"; wsHash?: string }
  | { type: "engineLogClear"; wsHash: string }
  | { type: "engineLogJournal"; wsHash: string }
  /** SDD 414 — patch settings.companion.tabTools for one workspace. */
  | { type: "setCompanionTabTools"; wsHash: string; enabled: boolean }
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
  /** spec 444 — remove a classified-safe checkout by registry id. The engine re-validates
   *  fail-closed (occupancy, dirty, ownership) on every call; a stale UI verdict is refused, never
   *  forced through. `deleteBranch` is explicit per-click consent, honored only for
   *  Tachyon-created branches (service-enforced). */
  | { type: "worktreeRemove"; id: string; deleteBranch?: boolean; wsHash?: string }
  /** spec 444 — forget a record-only tombstone row (registry only; disk untouched). */
  | { type: "worktreeForgetRecord"; id: string; wsHash?: string }
  /** spec 444 — batch cleanup: each item is an individual forget/remove the engine re-validates
   *  independently, so an entry whose state changed since the preview drops out with a stated
   *  reason instead of failing (or forcing) the whole batch. */
  | { type: "worktreeBatchCleanup"; items: Array<{ id: string; op: "remove" | "forget"; wsHash?: string }> };

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
  | { type: "studioNavAbort"; txnId: string };

export const readyMessage = (): CockpitAction => ({ type: READY });
export const refreshAction = (): CockpitAction => ({ type: "refresh" });
export const copyDiagnosticsAction = (): CockpitAction => ({ type: "copyDiagnostics" });
export const openSettingsAction = (): CockpitAction => ({ type: "openSettings" });
export const openDoctorAction = (): CockpitAction => ({ type: "openDoctor" });
export const setSectionAction = (section: CockpitSectionId): CockpitAction => ({ type: "setSection", section });
export const navigateReturnAction = (routeKey: string): CockpitAction => ({ type: "navigateReturn", routeKey });
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
export const setCompanionTabToolsAction = (wsHash: string, enabled: boolean): CockpitAction => ({
  type: "setCompanionTabTools",
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
