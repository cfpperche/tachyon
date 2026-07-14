import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { WorkspaceProbePresentationTarget } from "../shell/WorkspacePresentation.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { probesMessage, type ProbesVM } from "./probes/messages.js";

export const PROBES_VIEW_TYPE = "tachyonProbes";

export interface ProbesPanelState {
  schemaVersion: 1;
  view: typeof PROBES_VIEW_TYPE;
  wsHash: string;
  caller?: string;
}

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
    private readonly getWorkspaces: () => WorkspaceProbePresentationTarget[],
  ) {}

  /** spec 322 — panels are keyed per (workspace, caller) so two agents' probe views can sit side by side
   *  (mirrors the Activity panels). `caller` undefined = the unfiltered view — an internal/debug escape
   *  hatch for caller-less or orphaned records, never surfaced in the UI. */
  open(wsHash?: string, caller?: string, revivedPanel?: vscode.WebviewPanel): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) { revivedPanel?.dispose(); return; }
    const key = `${ws.wsHash}\0${caller ?? "*"}`;
    const existing = this.panels.get(key);
    if (existing) {
      revivedPanel?.dispose();
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.render();
      return;
    }

    const title = caller ? `Probes — ${caller}` : `Probes — ${ws.folderName}`;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = revivedPanel ?? vscode.window.createWebviewPanel(
      PROBES_VIEW_TYPE,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.title = title;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.iconPath = panelIcon(this.extensionUri, "search"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: [uri("design-system.css"), uri("probes.css")],
      bundle: uri("probes.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: PROBES_VIEW_TYPE, wsHash: ws.wsHash, ...(caller ? { caller } : {}) } satisfies ProbesPanelState,
    });

    let disposed = false;
    let renderToken = 0;
    let lastVm: ProbesVM | undefined;
    const post = (): void => { if (lastVm) void panel.webview.postMessage(probesMessage(lastVm)); };
    const render = (): void => {
      const myToken = ++renderToken; // only the latest render may write (codex UI #4 — no stale overwrite)
      void ws.probeView(caller).then(
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

  deserialize(panel: vscode.WebviewPanel, state: ProbesPanelState): void {
    this.open(state.wsHash, state.caller, panel);
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
