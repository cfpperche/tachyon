import * as vscode from "vscode";
import { renderWebviewShell } from "./shared/shell.js";
import type { DesignModeWebviewMessage } from "./design-mode/messages.js";
import { designModeEvent, READY } from "./design-mode/messages.js";
export interface DesignModePanelController {
  handleDesignModeWebviewMessage(message: DesignModeWebviewMessage): Promise<void>;
  initialDesignModeUi(): Promise<void>;
  setDesignModeUiSink(sink: ((event: Record<string, unknown>) => void) | null): void;
}
export class DesignModePanel {
  private panel: vscode.WebviewPanel | null = null;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: DesignModePanelController,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const title = vscode.l10n.t("Design Mode");
    const panel = vscode.window.createWebviewPanel(
      "tachyonDesignMode",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [root],
      },
    );
    this.panel = panel;
    const uri = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("design-mode.css")],
      bundle: uri("design-mode.js"),
      module: true,
      mode: "live",
      surface: "tachyonDesignMode",
    });
    this.controller.setDesignModeUiSink((event) => {
      void panel.webview.postMessage(designModeEvent(event));
    });
    panel.webview.onDidReceiveMessage((raw: DesignModeWebviewMessage) => {
      if (raw?.type === READY) void this.controller.initialDesignModeUi();
      else void this.controller.handleDesignModeWebviewMessage(raw);
    });
    panel.onDidDispose(() => {
      this.panel = null;
      this.controller.setDesignModeUiSink(null);
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this.controller.setDesignModeUiSink(null);
  }
}
