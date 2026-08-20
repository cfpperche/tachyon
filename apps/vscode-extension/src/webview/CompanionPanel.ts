import * as vscode from "vscode";
import {
  buildSectionsModel,
  collectNeedsFor,
  type WorkspaceBundle,
} from "@tachyon/webview-ui/sections/model";
import { cockpitStrings } from "./controlStrings.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { MODEL, POLL } from "@tachyon/webview-ui/webview/companion/messages";

export const COMPANION_VIEW_TYPE = "tachyonCompanion";
export interface CompanionDeps {
  collect: (
    needs?: ReturnType<typeof collectNeedsFor>,
  ) => Promise<WorkspaceBundle[]>;
  setCompanionTabTools(wsHash: string, enabled: boolean): Promise<void>;
  setCompanionAllowedHosts(wsHash: string, hosts: string[]): Promise<void>;
  unpairCompanionDevice(wsHash: string, deviceId?: string): Promise<void>;
  issueCompanionPairCode(wsHash: string): Promise<unknown>;
}
export class CompanionPanelManager {
  private readonly manager: SectionPanelManager<"companion">;
  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: CompanionDeps,
    app: WebviewAppEntry = webviewApp("companion"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(
      extensionUri,
      this.configFor(app),
      scope,
    );
  }
  open(project: string): void {
    this.manager.open({ project });
  }
  refresh(): void {
    this.manager.refresh("companion");
  }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    this.manager.deserialize(panel, state);
  }
  dispose(): void {
    this.manager.dispose();
  }
  private configFor(app: WebviewAppEntry): SectionAppConfig<"companion"> {
    return {
      app,
      styleFiles: [
        "codicon.css",
        "tokens.css",
        "faces.css",
        "design-system.css",
        "quick-picker.css",
        "companion.css",
      ],
      title: () => vscode.l10n.t("Companion"),
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: cockpitStrings() }),
      refreshKindFor: (m) => {
        const t = (m as { type?: unknown })?.type;
        return t === "ready" || t === POLL ? "companion" : undefined;
      },
      bind: (session) => ({
        replay: () => void this.send(session),
        resync: () => void this.send(session),
        onMessage: (raw) => void this.action(session, raw),
      }),
    };
  }
  private async send(session: SectionPanelSession<"companion">): Promise<void> {
    const project = session.target.project;
    if (!project) throw new Error("Companion dashboard has no project");
    const bundles = await this.deps.collect(collectNeedsFor("settings"));
    const model = buildSectionsModel(bundles, {
      section: "settings",
      wsHash: project,
    });
    session.post({
      type: MODEL,
      model: {
        companion: model.companion,
        ...(model.companionNeedsWorkspacePick
          ? { needsWorkspacePick: true }
          : {}),
      },
    });
  }
  private async action(
    session: SectionPanelSession<"companion">,
    raw: unknown,
  ): Promise<void> {
    const c = raw as Record<string, any>;
    const project = session.target.project;
    if (!project) return;
    if (c.type === "setCompanionTabTools" && typeof c.enabled === "boolean")
      await this.deps.setCompanionTabTools(project, c.enabled);
    else if (c.type === "setCompanionAllowedHosts" && Array.isArray(c.hosts))
      await this.deps.setCompanionAllowedHosts(
        project,
        c.hosts.filter((h: unknown): h is string => typeof h === "string"),
      );
    else if (c.type === "unpairCompanionDevice")
      await this.deps.unpairCompanionDevice(
        project,
        typeof c.deviceId === "string" ? c.deviceId : undefined,
      );
    else if (c.type === "issueCompanionPairCode") {
      session.post({
        type: "companionPairOffer",
        offer: await this.deps.issueCompanionPairCode(project),
      });
      return;
    } else if (c.type === "copyText" && typeof c.text === "string") {
      await vscode.env.clipboard.writeText(c.text);
      return;
    } else return;
    await this.send(session);
  }
}
