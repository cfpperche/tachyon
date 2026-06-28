import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { Workspace } from "../workspace/Workspace.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { probesMessage, type ProbesVM } from "./probes/messages.js";

/**
 * Spec 257 (D9) — the probe observability inspector: a read-only editor-area panel (one per workspace root)
 * listing recent captured probe runs with their status, reason, age, and an excerpt. The ENGINE owns the data
 * (Workspace.probeView builds it from ProbeStore); this panel renders it. Opened by `tachyon.openProbes`.
 *
 * spec 279 — converted from inline server-generated HTML to the preact-bundle convention (probes/main.tsx). A
 * `preact-live` read-only surface: the host posts the model on the webview's ready handshake and re-posts on
 * refresh; the webview sends no inbound actions. The host is now a thin shell (no inline UI markup).
 */
export class ProbeResultPanelManager {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; render: () => void }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  open(wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.render();
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonProbes",
      `Probes — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "search"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Probes — ${ws.folderName}`,
      styles: [uri("design-system.css"), uri("probes.css")],
      bundle: uri("probes.js"),
      mode: "live",
    });

    let disposed = false;
    let renderToken = 0;
    let lastVm: ProbesVM | undefined;
    const post = (): void => { if (lastVm) void panel.webview.postMessage(probesMessage(lastVm)); };
    const render = (): void => {
      const myToken = ++renderToken; // only the latest render may write (codex UI #4 — no stale overwrite)
      void ws.probeView().then(
        (view) => { if (!disposed && myToken === renderToken) { lastVm = { folder: ws.folderName, view }; post(); } },
        // A load failure is NOT an empty ledger — render a distinct error, never a false "no probes" (codex UI #5).
        (err) => { if (!disposed && myToken === renderToken) { lastVm = { folder: ws.folderName, error: err instanceof Error ? err.message : String(err) }; post(); } },
      );
    };

    // a (re)loaded webview signals ready → (re)push the current model.
    panel.webview.onDidReceiveMessage((m: { type?: string } | undefined) => { if (m?.type === READY) post(); });

    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(key);
    });
    this.panels.set(key, { panel, render });
    render();
  }

  /** Re-render every open panel — wired into onViewsChanged("probes"). */
  refreshAll(): void {
    for (const { render } of this.panels.values()) render();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
