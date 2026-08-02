/**
 * t-6e2952 — sidebar WebviewView host for the Control launcher grid.
 *
 * Opens sections ONLY through `tachyon.openControl` (optional section arg) → `openCockpit`, so a
 * click never creates a second Control panel or races the singleton claim. See Cockpit.ts:1204-1212
 * (out-of-order dispose of a superseded panel must not tear down the live one).
 */

import * as vscode from "vscode";
import { CONTROL_SECTION_NAV } from "../cockpit/sectionNav.js";
import { isCockpitSectionId } from "../cockpit/resolveSection.js";
import { READY } from "./shared/ready.js";
import { renderWebviewShell } from "./shared/shell.js";
import { tilesMessage, type ControlLauncherTile } from "./control-launcher/messages.js";

export class ControlLauncherProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonControlLauncher";
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.title = vscode.l10n.t("Control");
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const uri = (f: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    view.webview.onDidReceiveMessage((m: { type?: string; section?: string }) => void this.handleMessage(m));
    // Same CSP posture as the fleet sidebar: nonce-only scripts, no cspSource in script-src.
    view.webview.html = renderWebviewShell({
      cspSource: view.webview.cspSource,
      title: vscode.l10n.t("Control"),
      styles: [uri("codicon.css"), uri("design-system.css"), uri("control-launcher.css")],
      bundle: uri("control-launcher.js"),
      mode: "live",
      scriptCspSource: false,
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private localizedTiles(): ControlLauncherTile[] {
    const t = vscode.l10n.t;
    // Literals keep the l10n extractor honest (same labels as Cockpit.strings()).
    const labels: Record<string, string> = {
      overview: t("Overview"),
      engine: t("Engine"),
      fleet: t("Fleet"),
      inbox: t("Inbox"),
      mission: t("Board"),
      worktrees: t("Worktrees"),
      "execution-graph": t("Execution"),
      runtime: t("Runtime Ops"),
      "runtime-config": t("Runtime Config"),
      tmux: t("tmux"),
      plugins: t("Plugins"),
      settings: t("Settings"),
    };
    return CONTROL_SECTION_NAV.map((tile) => ({
      id: tile.id,
      icon: tile.icon,
      label: labels[tile.id] ?? tile.label,
    }));
  }

  private pushTiles(): void {
    const view = this.view;
    if (!view) return;
    void view.webview.postMessage(tilesMessage(this.localizedTiles()));
  }

  private async handleMessage(m: { type?: string; section?: string }): Promise<void> {
    if (m?.type === READY) {
      this.pushTiles();
      return;
    }
    if (m?.type === "openSection" && typeof m.section === "string" && isCockpitSectionId(m.section)) {
      // Optional section arg is handled by the openControl registration in extension.ts.
      // openCockpit already reveals the existing panel and requestNavigate()s when live.
      await vscode.commands.executeCommand("tachyon.openControl", m.section);
    }
  }
}
