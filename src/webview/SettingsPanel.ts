import * as vscode from "vscode";
import { buildCockpitModel, collectNeedsFor, type CockpitModel, type CockpitWorkspaceBundle } from "../cockpit/model.js";
import { parseCardTemplate } from "../sidebar/cardTemplate.js";
import { sharedGlobalSettings } from "../config/globalSettings.js";
import { cockpitStrings } from "./controlStrings.js";
import { POLL, READY, settingsModelMessage } from "./settings/messages.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";

export const SETTINGS_VIEW_TYPE = "tachyonSettings";
type RefreshKind = "settings";

export interface SettingsDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<CockpitWorkspaceBundle[]>;
  openDoctor(): void;
  openConfigFile(wsHash?: string): Promise<void>;
  setCompanionTabTools(wsHash: string, enabled: boolean): Promise<void>;
  /** SDD 488 F4 — settings.ideBrowser.enabled (human surface + call-time gate). */
  setIdeBrowserEnabled(wsHash: string, enabled: boolean): Promise<void>;
  setIdleAfterMinutes(wsHash: string, minutes?: number | "never"): Promise<void>;
  setCompanionAllowedHosts(wsHash: string, hosts: string[]): Promise<void>;
  unpairCompanionDevice(wsHash: string, deviceId?: string): Promise<void>;
  issueCompanionPairCode(wsHash: string): Promise<unknown>;
}

/** SDD 485 D10 — Settings is project-scoped: companion accepts one wsHash and the historical
 * first-workspace fallback meant "pick a project", not "aggregate projects". */
export class SettingsPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: SettingsDeps,
    app: WebviewAppEntry = webviewApp("settings"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("settings"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "design-system.css", "control-typography.css", "engine-workspace.css", "settings.css"],
      title: () => vscode.l10n.t("Settings"),
      bootstrapGlobals: (_target, uri) => ({
        __TACHYON_STRINGS__: cockpitStrings(),
        __tachyonCardPreviewCss: uri("sidebar.css"),
      }),
      refreshKindFor: settingsRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) };
      },
    };
  }

  private async send(session: SectionPanelSession<RefreshKind>): Promise<void> {
    const project = session.target.project;
    if (!project) throw new Error("Settings dashboard has no project");
    const bundles = await this.deps.collect(collectNeedsFor("settings"));
    session.post(settingsModelMessage(buildCockpitModel(bundles, {
      section: "settings", wsHash: project, personalCardTemplate: personalCardTemplateState(),
      globalSettings: globalSettingsState(),
    })));
  }

  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const c = raw as Record<string, any>;
    const project = session.target.project;
    if (!project) throw new Error("Settings dashboard has no project");
    if (c.type === "openDoctor") this.deps.openDoctor();
    else if (c.type === "openGlobalSettingsFile" || c.type === "openPersonalCardTemplate") {
      await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    } else if (c.type === "openConfigFile") await this.deps.openConfigFile(project);
    else if (c.type === "copyText" && typeof c.text === "string") await vscode.env.clipboard.writeText(c.text);
    else if (c.type === "setGlobalSettings") sharedGlobalSettings().update(c.patch);
    else if (c.type === "setIdleAfterMinutes") await this.deps.setIdleAfterMinutes(project, c.minutes);
    else if (c.type === "setCompanionTabTools" && typeof c.enabled === "boolean") await this.deps.setCompanionTabTools(project, c.enabled);
    else if (c.type === "setIdeBrowserEnabled" && typeof c.enabled === "boolean") await this.deps.setIdeBrowserEnabled(project, c.enabled);
    else if (c.type === "setCompanionAllowedHosts" && Array.isArray(c.hosts)) {
      await this.deps.setCompanionAllowedHosts(project, c.hosts.filter((h: unknown): h is string => typeof h === "string"));
    } else if (c.type === "unpairCompanionDevice") await this.deps.unpairCompanionDevice(project, typeof c.deviceId === "string" ? c.deviceId : undefined);
    else if (c.type === "issueCompanionPairCode") session.post({ type: "companionPairOffer", offer: await this.deps.issueCompanionPairCode(project) });
    else return;
    if (c.type !== "issueCompanionPairCode" && c.type !== "copyText" && c.type !== "openDoctor") await this.send(session);
  }
}

export function settingsRefreshKind(message: unknown): RefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "settings" : undefined;
}

function globalSettingsState(): NonNullable<CockpitModel["globalSettings"]> {
  const store = sharedGlobalSettings(); const current = store.current(); const refusal = store.refusal();
  return { file: store.file, activityCodeTheme: current.activityCodeTheme, agentPaneEnabled: current.agentPaneEnabled,
    gitPath: current.gitPath, hasCardTemplate: current.sidebarCardTemplate !== undefined,
    ...(refusal ? { refusal: refusal.errors } : {}) };
}

function personalCardTemplateState(): { state: "none" | "active" | "refused"; errors?: string[] } {
  const written = sharedGlobalSettings().current().sidebarCardTemplate;
  if (written == null || (typeof written === "object" && !Array.isArray(written) && Object.keys(written).length === 0)) return { state: "none" };
  const parsed = parseCardTemplate(written, "sidebar.cardTemplate");
  return parsed.config ? { state: "active" } : { state: "refused", errors: parsed.errors };
}
