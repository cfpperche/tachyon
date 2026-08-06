import * as vscode from "vscode";
import type { FleetVM } from "../sidebar/types.js";
import type { ActionId } from "../sidebar/actions.js";
import { isAgentRow } from "../sidebar/types.js";
import { agentContextValue } from "../presentation/contextValue.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, fleetErrorMessage, fleetModelMessage } from "./fleet/messages.js";

export const FLEET_VIEW_TYPE = "tachyonFleet";
type FleetRefreshKind = "fleet";

export interface FleetDeps {
  /** t-41117e — same FleetVM projection the sidebar Agents tab reads. */
  loadFleet: (project: string) => Promise<FleetVM>;
  openBoard(project: string): void;
  /** Route a sidebar ActionId with the panel's immutable project. */
  runAction(id: ActionId, name: string, project: string, contextValue: string): Promise<void>;
  continueTask(fromName: string, toName: string, wsHash: string): Promise<void>;
}

/**
 * SDD 485 D7 / t-41117e — Fleet is a dashboard for one immutable project.
 * It reuses the sidebar AgentsRoster (nine statuses). CockpitModel.fleet boolean rows are gone from this surface.
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
      app,
      // sidebar.css paints AgentRow (sdot, .row, metrics); design-system + typography for chrome.
      styleFiles: ["codicon.css", "design-system.css", "control-typography.css", "sidebar.css", "engine-workspace.css"],
      title: () => vscode.l10n.t("Fleet"),
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: fleetStrings() }),
      refreshKindFor: fleetRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) };
      },
    };
  }
  private async send(session: SectionPanelSession<FleetRefreshKind>): Promise<void> {
    try {
      const project = session.target.project;
      if (!project) throw new Error("Fleet dashboard has no project");
      session.post(fleetModelMessage(await this.deps.loadFleet(project)));
    } catch (error) {
      session.post(fleetErrorMessage(error instanceof Error ? error.message : String(error)));
    }
  }
  private async action(session: SectionPanelSession<FleetRefreshKind>, raw: unknown): Promise<void> {
    const message = raw as Record<string, unknown>;
    const project = session.target.project;
    if (!project) throw new Error("Fleet dashboard has no project");
    if (message.type === "openBoard") {
      this.deps.openBoard(project);
      return;
    }
    if (message.type === "continueTask" && typeof message.fromName === "string" && typeof message.toName === "string") {
      await this.deps.continueTask(message.fromName, message.toName, project);
      await this.send(session);
      return;
    }
    if (message.type === "action" && typeof message.id === "string" && typeof message.agent === "string") {
      const id = message.id as ActionId;
      if (id === "continueTask") return; // picker is webview-local
      const fleet = await this.deps.loadFleet(project);
      const vm = fleet.agents.find((a) => a.name === message.agent) ?? fleet.terminals.find((a) => a.name === message.agent);
      const contextValue = vm ? ctxOf(vm) : "agent-running";
      await this.deps.runAction(id, message.agent, project, contextValue);
      await this.send(session);
    }
  }
}

export function fleetRefreshKind(message: unknown): FleetRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "fleet" : undefined;
}

function ctxOf(a: FleetVM["agents"][number]): string {
  const state = a.status === "crashed" ? "crashed" : a.status === "stopped" ? "stopped" : "running";
  return agentContextValue({
    state,
    ai: isAgentRow(a),
    temporary: !!a.adhoc,
    worktree: !!a.worktree,
    verifiable: !!a.verifiable,
    forkable: !!a.forkable,
    harness: !!a.harness,
  });
}

function fleetStrings(): Record<string, string> {
  const t = vscode.l10n.t;
  return {
    fleetTitle: t("Fleet"),
    fleetHint: t("Agents (runtime) — same roster as the sidebar, with nine statuses. Work items are on the Board."),
    openMissionControl: t("Open Board"),
    noneListed: t("Nothing listed yet."),
    continueTask: t("Continue task in…"),
    continueTaskPickTitle: t("Continue {0} task in…"),
    continueTaskPickSubtitle: t("Choose a stopped Saved Agent."),
    continueTaskPickPlaceholder: t("Select an agent"),
    continueTaskPickEmpty: t("No eligible destination agents."),
    continueTaskDestStopped: t("Stopped — available"),
    continueTaskDestRunning: t("Running — stop it first"),
    continueTaskDestDetail: t("Continue the unfinished task from {0}"),
  };
}
