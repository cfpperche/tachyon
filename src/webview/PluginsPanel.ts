import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { detectRuntimes } from "../plugins/engine.js";
import { LOCKFILE_REL_PATH } from "../plugins/lockfile.js";
import { buildPluginsViewModel, type PluginsViewModel } from "../plugins/viewModel.js";

/**
 * spec 250 — the editor-area Plugins View panel (one per workspace root), opened by the sidebar title
 * button `tachyon.openPlugins` (sibling of inspect-tmux). Mirrors the HandoffPanelManager (spec 245):
 * createWebviewPanel + asWebviewUri(dist/webview/plugins.js) + a single VM postMessage, re-posted on
 * an explicit refresh. The HOST gathers the model (detectRuntimes + read the committed lockfile +
 * buildPluginsViewModel — all I/O lives here); the Preact webview renders it (never imports vscode/engine).
 *
 * Step B = this provider + registration + read-only render of the installed list. Install-by-source, the
 * security consent drawer, and the apply actions land in Step C.
 */
export class PluginsPanelManager {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; post: () => void }>();

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
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonPlugins",
      `🧩 Plugins — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "plugins.js"));
    panel.webview.html = html(panel.webview, codiconUri, scriptUri, ws.folderName);

    const post = (): void => {
      void panel.webview.postMessage({ type: "plugins", vm: this.gather(ws) });
    };

    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === "ready" || m?.type === "refresh") post(); // (re)loaded webview / explicit refresh
      // install-by-source / update / reinstall / remove + the consent drawer arrive in Step C.
    });

    panel.onDidDispose(() => {
      this.panels.delete(key);
    });
    this.panels.set(key, { panel, post });
    post();
  }

  /** Assemble the render-ready model: present runtimes + the committed lockfile → the pure view-model.
   *  No update-checks in Step B (those re-resolve the source over the network) — every status is `unknown`. */
  private gather(ws: Workspace): PluginsViewModel {
    const present = detectRuntimes(ws.workspaceRoot);
    let lockfileText: string | undefined;
    try {
      lockfileText = fs.readFileSync(path.join(ws.workspaceRoot, LOCKFILE_REL_PATH), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ONLY a genuine absence is the cold state; a real read failure (EACCES/EISDIR/…) must surface,
      // never masquerade as "no plugins" (which would mislead the Step C actions).
      if (err.code !== "ENOENT") {
        return buildPluginsViewModel({ present, readError: `${LOCKFILE_REL_PATH}: ${err.code ?? "read error"}: ${err.message}` });
      }
      lockfileText = undefined;
    }
    return buildPluginsViewModel({ lockfileText, present });
  }

  /** Re-post to an open panel for this workspace. */
  refresh(wsHash: string): void {
    this.panels.get(wsHash)?.post();
  }

  /** Re-post to every open panel (cheap). */
  refreshAll(): void {
    for (const { post } of this.panels.values()) post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, scriptUri: vscode.Uri, folder: string): string {
  const nonce = getNonce();
  const title = folder.replace(/[<>&]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<title>Plugins — ${title}</title>
<style>
  :root {
    --muted:     var(--vscode-descriptionForeground);
    --border:    var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.22)));
    --focus:     var(--vscode-focusBorder);
    --warn:      var(--vscode-charts-yellow, var(--vscode-list-warningForeground, #cca700));
    --info:      var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    --err:       var(--vscode-errorForeground, var(--vscode-list-errorForeground, #f14c4c));
    --ok:        var(--vscode-charts-green, #89d185);
    --card-bg:   var(--vscode-editorWidget-background, rgba(128,128,128,.06));
    --code-font: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 48px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  button { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; border-radius: 3px; }
  .dim { color: var(--muted); }
  .mono { font-family: var(--code-font); font-size: 12px; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 20px; }

  .head { position: sticky; top: 0; z-index: 5; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); }
  .head-row { display: flex; align-items: center; gap: 12px; padding: 14px 0 10px; }
  .title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 12px; margin: -4px 0 0; }
  .ws-rt b { color: var(--vscode-foreground); font-weight: 600; }
  .actions { margin-left: auto; display: flex; gap: 6px; }
  .act-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; color: var(--vscode-foreground); }
  .act-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }

  .list { padding: 16px 0; display: flex; flex-direction: column; gap: 10px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .pname { font-size: 14px; font-weight: 600; }
  .pver { color: var(--muted); font-size: 12px; }
  .badge { font-size: 11px; line-height: 1.6; padding: 1px 9px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .badge.ok   { color: var(--ok);   border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .badge.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 55%, transparent); }
  .badge.err  { color: var(--err);  border-color: color-mix(in srgb, var(--err) 55%, transparent); }
  .pmeta { color: var(--muted); font-size: 12px; margin-top: 7px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  .src { font-family: var(--code-font); }
  .rt { font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); white-space: nowrap; }
  .rt.has  { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, transparent); }
  .rt.miss { color: var(--muted); opacity: .7; }

  .banner { margin: 16px 0; padding: 12px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--err) 45%, transparent); background: color-mix(in srgb, var(--err) 8%, transparent); color: var(--err); font-size: 12.5px; }
  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty .big { font-size: 14px; color: var(--vscode-foreground); margin-bottom: 6px; }
  .degrade { padding: 56px 24px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
