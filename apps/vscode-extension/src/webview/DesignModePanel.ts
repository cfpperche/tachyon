import * as vscode from "vscode";
import {
  errorMessage,
  modelMessage,
  READY,
  type DesignModeAction,
} from "@tachyon/webview-ui/webview/design-mode/messages";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  onIdeBrowserUiStateChanged,
  readIdeBrowserUiState,
} from "./ide-browser-bridge/register.js";

export const DESIGN_MODE_VIEW_TYPE = "tachyonDesignModeApp";
type RefreshKind = "design-mode";

export class DesignModePanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  private readonly stateSubscription: vscode.Disposable;

  constructor(
    extensionUri: vscode.Uri,
    app: WebviewAppEntry = webviewApp("design-mode"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
    this.stateSubscription = onIdeBrowserUiStateChanged(() => this.manager.refresh("design-mode"));
  }

  open(project: string): void { this.manager.open({ project }); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.stateSubscription.dispose(); this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "design-mode.css"],
      title: () => vscode.l10n.t("Design Mode"),
      bootstrapGlobals: () => {
        const t = vscode.l10n.t;
        return { __TACHYON_DESIGN_MODE_STRINGS__: {
          title: t("Design Mode"),
          hint: t("Controls for the Integrated Browser overlay."),
          off: t("Off"),
          disabledTitle: t("Integrated Browser is disabled"),
          disabledBody: t("Enable it in Settings before opening or arming Design Mode."),
          openSettings: t("Open Settings"),
          armed: t("Armed"),
          disarmed: t("Disarmed"),
          on: t("ON"),
          armedBody: t("Picker, viewport tools, and annotations are active in the browser page. Navigations re-inject the overlay."),
          disarmedBody: t("Arm the overlay, then work in the Integrated Browser page."),
          revealBrowser: t("Reveal browser"),
          openBrowser: t("Open browser"),
          disarm: t("Disarm"),
          arm: t("Arm Design Mode"),
        } };
      },
      refreshKindFor: (message) => message && typeof message === "object"
        && (message as { type?: unknown }).type === READY ? "design-mode" : undefined,
      bind: (session) => ({
        replay: () => this.send(session),
        resync: () => this.send(session),
        onMessage: (raw) => void this.action(session, raw),
      }),
    };
  }

  private send(session: SectionPanelSession<RefreshKind>): void {
    session.post(modelMessage(readIdeBrowserUiState()));
  }

  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const action = raw as Partial<DesignModeAction>;
    try {
      if (action.type === "openBrowser") {
        await vscode.commands.executeCommand("tachyon.ideBrowserBridge.open");
      } else if (action.type === "setDesignMode" && typeof action.on === "boolean") {
        await vscode.commands.executeCommand(
          action.on ? "tachyon.ideBrowserBridge.designModeOn" : "tachyon.ideBrowserBridge.designModeOff",
        );
      } else if (action.type === "openSettings") {
        await vscode.commands.executeCommand("tachyon.openControl", "settings");
      } else {
        return;
      }
      this.send(session);
    } catch (error) {
      session.post(errorMessage(error instanceof Error ? error.message : String(error)));
    }
  }
}
