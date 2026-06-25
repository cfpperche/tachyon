import * as vscode from "vscode";
import type { Workspace } from "../workspace/Workspace.js";
import type { ProbeView, ProbeViewRow } from "../probe/probeView.js";

/**
 * Spec 257 (D9) — the probe observability inspector: a read-only editor-area panel (one per workspace
 * root) listing recent captured probe runs from the ledger/store with their status, reason, age, and an
 * excerpt. The ENGINE owns the data (Workspace.probeView builds it from ProbeStore); this panel renders
 * it. Server-generated HTML (no JS bundle) — a small static report re-rendered on refresh, never the
 * proof of lifecycle correctness (the store is). Opened by the `tachyon.openProbes` toolbar button.
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
      `⌕ Probes — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: false, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const dsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "design-system.css"));

    let disposed = false;
    let renderToken = 0;
    const render = (): void => {
      const myToken = ++renderToken; // only the latest render may write (codex UI #4 — no stale overwrite)
      void ws.probeView().then(
        (view) => {
          if (!disposed && myToken === renderToken) panel.webview.html = html(panel.webview, dsUri, ws.folderName, view);
        },
        (err) => {
          // A load failure is NOT an empty ledger — render a distinct error, never a false "no probes" (codex UI #5).
          if (!disposed && myToken === renderToken) panel.webview.html = errorHtml(panel.webview, dsUri, ws.folderName, err instanceof Error ? err.message : String(err));
        },
      );
    };

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

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function statusGlyph(status: ProbeViewRow["status"]): string {
  if (status === "running") return '<span class="st run">● running</span>';
  if (status === "completed") return '<span class="st ok">✓ completed</span>';
  return '<span class="st fail">✗ failed</span>';
}

function rowHtml(r: ProbeViewRow): string {
  return `<tr>
  <td class="mono">${esc(r.shortId)}</td>
  <td>${statusGlyph(r.status)}</td>
  <td>${esc(r.reason)}</td>
  <td>${esc(r.runtime)}</td>
  <td>${esc(r.archetype)}</td>
  <td>${esc(r.caller)}</td>
  <td class="age">${esc(r.ageLabel)}</td>
  <td class="exc">${esc(r.excerpt)}</td>
</tr>`;
}

function shell(webview: vscode.Webview, dsUri: vscode.Uri, folder: string, bodyHtml: string): string {
  const title = esc(folder);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${dsUri}">
<title>Probes — ${title}</title>
<style>
  body { padding: var(--ds-4); }
  h1 { font-size: var(--ds-large, 1.2em); margin: 0 0 var(--ds-3); }
  .counts { display: flex; gap: var(--ds-3); margin: 0 0 var(--ds-3); color: var(--ds-muted); font-size: var(--ds-small); }
  .counts .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .counts .fail { color: var(--vscode-testing-iconFailed, #f85149); }
  .counts .run { color: var(--vscode-charts-blue, #4daafc); }
  table { border-collapse: collapse; width: 100%; font-size: var(--ds-small); }
  th, td { border-bottom: 1px solid var(--ds-border); padding: 5px 9px; text-align: left; vertical-align: top; }
  th { color: var(--ds-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: var(--ds-micro); }
  .mono { font-family: var(--ds-mono); }
  .age { color: var(--ds-muted); white-space: nowrap; }
  .exc { color: var(--ds-muted); max-width: 420px; overflow-wrap: anywhere; }
  .st.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .st.fail { color: var(--vscode-testing-iconFailed, #f85149); }
  .st.run { color: var(--vscode-charts-blue, #4daafc); }
  .empty, .error { color: var(--ds-muted); max-width: 540px; margin: 48px auto; text-align: center; }
  .error { color: var(--vscode-testing-iconFailed, #f85149); }
  .empty .hint { font-size: var(--ds-small); }
  code { font-family: var(--ds-mono); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18)); padding: 0 4px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>⌕ Captured probes — ${title}</h1>
  ${bodyHtml}
</body>
</html>`;
}

function errorHtml(webview: vscode.Webview, dsUri: vscode.Uri, folder: string, message: string): string {
  return shell(webview, dsUri, folder, `<div class="error"><p>Could not load probes.</p><p class="hint">${esc(message)}</p></div>`);
}

function html(webview: vscode.Webview, dsUri: vscode.Uri, folder: string, view: ProbeView): string {
  const body = view.empty
    ? `<div class="empty"><p>No probes yet.</p><p class="hint">Run one with the <code>probe_agent</code> Bridge tool — an adversarial-review or factual-verify second-model pass.</p></div>`
    : `<div class="counts">
        <span>${view.total} total</span>
        <span class="ok">${view.completed} completed</span>
        <span class="fail">${view.failed} failed</span>
        <span class="run">${view.running} running</span>
      </div>
      <table>
        <thead><tr><th>id</th><th>status</th><th>reason</th><th>runtime</th><th>archetype</th><th>caller</th><th>age</th><th>excerpt</th></tr></thead>
        <tbody>${view.rows.map(rowHtml).join("")}</tbody>
      </table>`;
  return shell(webview, dsUri, folder, body);
}
