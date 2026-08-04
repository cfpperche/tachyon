import * as vscode from "vscode";
import { buildCockpitModel, collectNeedsFor, type CockpitWorkspaceBundle } from "../cockpit/model.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, fleetErrorMessage, fleetModelMessage } from "./fleet/messages.js";

export const FLEET_VIEW_TYPE = "tachyonFleet";
type FleetRefreshKind = "fleet";

export interface FleetDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<CockpitWorkspaceBundle[]>;
  openBoard(project: string): void;
  start(name: string, wsHash: string): Promise<void>;
  stop(name: string, wsHash: string): Promise<void>;
  terminal(name: string, wsHash: string): Promise<void>;
  activity(name: string, wsHash: string): Promise<void>;
  probes(name: string, wsHash: string): Promise<void>;
  edit(name: string, wsHash: string): Promise<void>;
  continueTask(fromName: string, toName: string, wsHash: string): Promise<void>;
}

/**
 * SDD 485 D7 — Fleet is a dashboard because `buildCockpitModel(..., { wsHash })` filters the
 * collected agent rows before exposing `model.fleet`. It had no standalone viewType, so this id is new.
 * After the cutover Control consumes 0 ck-card-list and 0 ci-* classes, but still consumes ck-empty twice
 * in Overview. It therefore keeps linking engine-workspace.css; Fleet links it for ck-card-list and links
 * the typography sheet for ck-mono. This is a measured consumer count, not an inherited CSS rule.
 */
export class FleetPanelManager {
  private readonly manager: SectionPanelManager<FleetRefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: FleetDeps, app: WebviewAppEntry = webviewApp("fleet"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("fleet"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<FleetRefreshKind> {
    return {
      app, styleFiles: ["codicon.css", "design-system.css", "control-typography.css", "engine-workspace.css"],
      title: () => vscode.l10n.t("Fleet"), bootstrapGlobals: () => ({ __TACHYON_STRINGS__: fleetStrings() }),
      refreshKindFor: fleetRefreshKind,
      bind: (session) => { const send = () => void this.send(session); return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) }; },
    };
  }
  private async send(session: SectionPanelSession<FleetRefreshKind>): Promise<void> {
    try { session.post(fleetModelMessage(buildCockpitModel(await this.deps.collect(collectNeedsFor("fleet")), { section: "fleet", wsHash: session.target.project }))); }
    catch (error) { session.post(fleetErrorMessage(error instanceof Error ? error.message : String(error))); }
  }
  private async action(session: SectionPanelSession<FleetRefreshKind>, raw: unknown): Promise<void> {
    const message = raw as Record<string, unknown>;
    const project = session.target.project;
    if (!project) throw new Error("Fleet dashboard has no project");
    if (message.type === "openBoard") this.deps.openBoard(project);
    else if (typeof message.name === "string") {
      if (message.type === "fleetStart") await this.deps.start(message.name, project);
      else if (message.type === "fleetStop") await this.deps.stop(message.name, project);
      else if (message.type === "fleetTerminal") await this.deps.terminal(message.name, project);
      else if (message.type === "fleetActivity") await this.deps.activity(message.name, project);
      else if (message.type === "fleetProbes") await this.deps.probes(message.name, project);
      else if (message.type === "fleetAgentStudio") await this.deps.edit(message.name, project);
      else if (message.type === "fleetContinueTask" && typeof message.toName === "string") await this.deps.continueTask(message.name, message.toName, project);
      else return;
      await this.send(session);
    }
  }
}

export function fleetRefreshKind(message: unknown): FleetRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "fleet" : undefined;
}

function fleetStrings(): Record<string, string> {
  const t = vscode.l10n.t;
  return {
    fleetTitle: t("Fleet"),
    fleetHint: t("Agents (runtime) — start, stop, terminal, activity. Work items are on the Board."),
    openMissionControl: t("Open Board"),
    noneListed: t("Nothing listed yet."),
    running: t("Running"),
    stopped: t("Stopped"),
    temporary: t("Temporary"),
    saved: t("Saved"),
    stop: t("Stop"),
    start: t("Start"),
    openTerminal: t("Open terminal"),
    openActivity: t("Activity"),
    openProbes: t("Probes"),
    continueTask: t("Continue task in…"),
    editAgent: t("Edit"),
    continueTaskPickTitle: t("Continue {0} task in…"),
    continueTaskPickSubtitle: t("Choose a stopped Saved Agent."),
    continueTaskPickPlaceholder: t("Select an agent"),
    continueTaskPickEmpty: t("No eligible destination agents."),
    continueTaskDestStopped: t("Stopped — available"),
    continueTaskDestRunning: t("Running — stop it first"),
    continueTaskDestDetail: t("Continue the unfinished task from {0}"),
  };
}
