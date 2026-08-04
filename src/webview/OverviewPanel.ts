import * as vscode from "vscode";
import { buildCockpitModel, collectNeedsFor, formatCockpitDiagnostics, type CockpitWorkspaceBundle } from "../cockpit/model.js";
import { cockpitStrings } from "./controlStrings.js";
import { POLL, READY, overviewModelMessage } from "./overview/messages.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";

export const OVERVIEW_VIEW_TYPE = "tachyonOverview";
type RefreshKind = "overview";
export interface OverviewDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<CockpitWorkspaceBundle[]>;
  /** Inbox metric shortcut — openSection stays because that tile still posts it. */
  openSection(section: string, project: string): void;
}

export class OverviewPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: OverviewDeps, app: WebviewAppEntry = webviewApp("overview"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }
  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return { app, styleFiles: ["codicon.css", "design-system.css", "engine-workspace.css", "overview.css"],
      title: () => vscode.l10n.t("Overview"), bootstrapGlobals: () => ({ __TACHYON_STRINGS__: cockpitStrings() }),
      refreshKindFor: overviewRefreshKind, bind: (session) => { const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) }; } };
  }
  private async send(session: SectionPanelSession<RefreshKind>): Promise<void> {
    const bundles = await this.deps.collect(collectNeedsFor("overview"));
    session.post(overviewModelMessage(buildCockpitModel(bundles, { section: "overview", wsHash: session.target.project })));
  }
  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const message = raw as Record<string, unknown>; const project = session.target.project;
    if (!project) throw new Error("Overview dashboard has no project");
    if (message.type === "openSection" && typeof message.section === "string") this.deps.openSection(message.section, project);
    else if (message.type === "copyDiagnostics") {
      const bundles = await this.deps.collect();
      await vscode.env.clipboard.writeText(formatCockpitDiagnostics(buildCockpitModel(bundles, { section: "overview", wsHash: project })));
    }
  }
}
export function overviewRefreshKind(message: unknown): RefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type; return type === READY || type === POLL ? "overview" : undefined;
}
