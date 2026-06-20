import * as vscode from "vscode";

/**
 * spec 237 — the Tachyon sidebar webview (Preact). The host glue: it serves the shell HTML (CSP + the
 * VS Code theme CSS in <style> + the codicon font) and loads the bundled Preact app (`dist/webview/
 * sidebar.js`) which renders into #root. All UI/logic lives in the bundle (`src/webview/sidebar/*`);
 * this file holds no inline app code. Shown only when `tachyon.sidebar.experimental` is on (which hides
 * the native tree). Visual prototype: the bundle renders SAMPLE data — real fleet data lands when the
 * rules layer is extracted (see docs/specs/237).
 */
export class SidebarPrototypeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonSidebarPrototype";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const codiconUri = view.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const sidebarUri = view.webview.asWebviewUri(vscode.Uri.joinPath(root, "sidebar.js"));
    view.webview.html = html(view.webview, codiconUri, sidebarUri);
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, sidebarUri: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<style>
  :root {
    --hover: var(--vscode-list-hoverBackground);
    --sel: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.22)));
    --focus: var(--vscode-focusBorder);
    --ok: var(--vscode-testing-iconPassed, #4caf50);
    --warn: var(--vscode-list-warningForeground, #cca700);
    --err: var(--vscode-list-errorForeground, #f14c4c);
    --idle: var(--vscode-disabledForeground, #8a8a8a);
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body { margin: 0; padding: 6px 0 28px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }

  /* cmd+K trigger — styled as an Agent-Studio input */
  .kbar { margin: 4px 8px 6px; display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--vscode-input-background); color: var(--muted); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; cursor: text; }
  .kbar:hover { border-color: var(--focus); }
  .kbar .codicon { font-size: 13px; }
  .kbar .kgrow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .kbar .kbd { font-size: 10px; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; opacity: .85; }

  /* Icon tabs — equal width, never overflow */
  .tabs { display: flex; gap: 1px; padding: 0 6px; border-bottom: 1px solid var(--border); }
  .tab { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 6px 0 7px; cursor: pointer; color: var(--muted); position: relative; border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--focus); }
  .tab .codicon { font-size: 16px; }
  .tab .cnt { font-size: 9px; opacity: .6; }

  /* active section title */
  .sec { display: flex; align-items: baseline; gap: 6px; padding: 9px 12px 2px; }
  .sec b { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .sec .scount { color: var(--muted); font-size: 11px; opacity: .7; }

  .panel { display: none; }
  .panel.active { display: block; }

  /* Status group headers */
  .grp { display: flex; align-items: center; gap: 6px; padding: 7px 12px 3px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; cursor: pointer; user-select: none; }
  .grp .chev { font-size: 9px; transition: transform .12s; opacity: .8; }
  .grp.collapsed .chev { transform: rotate(-90deg); }
  .grp .gcount { margin-left: auto; opacity: .65; }
  .grp.collapsed + .grp-body { display: none; }

  /* Rows — 2 lines; meta wraps; never overflows */
  .row { display: flex; flex-direction: column; gap: 1px; padding: 4px 12px; position: relative; }
  .row:hover { background: var(--hover); }
  .row.flash { animation: flash 1s ease-out; }
  @keyframes flash { 0%,28% { background: var(--sel); } 100% { background: transparent; } }
  .row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .sdot.running { background: var(--ok); }
  .sdot.needs { background: var(--warn); box-shadow: 0 0 5px var(--warn); }
  .sdot.idle { background: var(--idle); }
  .sdot.stopped { background: transparent; border: 1px solid var(--idle); }
  .sdot.crashed { background: var(--err); }
  .name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .row.child { padding-left: 26px; }
  .row.child::before { content: "↳"; position: absolute; left: 13px; top: 4px; color: var(--muted); opacity: .7; }
  .row-meta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding-left: 15px; }
  .row-meta:empty { display: none; }
  .msub { color: var(--muted); font-size: 11px; }
  /* Badges: muted by default — color reserved for status semantics (attention / verify) */
  .badge { font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .badge.attn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
  .badge.err { color: var(--err); border-color: color-mix(in srgb, var(--err) 55%, transparent); }

  /* hover action overlay — toolbar idiom; absolute so it never widens the row */
  .actions { display: none; position: absolute; right: 8px; top: 2px; gap: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); padding: 1px 2px; border-radius: 4px; box-shadow: 0 0 0 1px var(--border); }
  .row:hover .actions { display: flex; }
  .act { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 4px; cursor: pointer; color: var(--muted); }
  .act .codicon { font-size: 14px; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); color: var(--vscode-foreground); }

  .empty { padding: 10px 14px; color: var(--muted); font-style: italic; font-size: 12px; }
  .pin { display: flex; gap: 8px; padding: 5px 12px; align-items: flex-start; }
  .pin .box { width: 13px; height: 13px; border: 1px solid var(--muted); border-radius: 3px; flex: none; margin-top: 1px; display: grid; place-items: center; }
  .pin .box.done { background: var(--ok); border-color: var(--ok); color: var(--vscode-editor-background); }
  .pin .box .codicon { font-size: 11px; }
  .pin.done .txt { text-decoration: line-through; color: var(--muted); }

  /* Bridge — quiet footer status bar */
  .foot { position: fixed; bottom: 0; left: 0; right: 0; display: flex; align-items: center; gap: 6px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top: 1px solid var(--border); padding: 4px 12px; font-size: 11px; }
  .foot .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 6px var(--ok); flex: none; }
  .foot b { font-weight: 600; }
  .foot .fmeta { color: var(--muted); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* cmd+K palette */
  .cmdk { display: none; position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.42); }
  .cmdk.open { display: block; }
  .cmdk-panel { position: absolute; top: 8%; left: 8px; right: 8px; background: var(--vscode-quickInput-background, var(--vscode-editor-background)); border: 1px solid var(--focus); border-radius: 6px; overflow: hidden; box-shadow: 0 12px 36px rgba(0,0,0,.5); }
  .cmdk-panel input { width: 100%; padding: 10px 12px; background: transparent; border: none; border-bottom: 1px solid var(--border); color: var(--vscode-foreground); outline: none; font-size: 13px; }
  .cmdk-panel input::placeholder { color: var(--vscode-input-placeholderForeground, var(--muted)); }
  .cmdk-results { max-height: 50vh; overflow-y: auto; padding: 4px 0; }
  .ci-group { padding: 6px 12px 2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); opacity: .8; }
  .ci { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; }
  .ci.sel, .ci:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .ci .codicon { font-size: 14px; opacity: .85; flex: none; }
  .ci .ci-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ci .ci-hint { color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
  .ci.sel .ci-hint { color: inherit; opacity: .75; }
  .cmdk-foot { display: flex; gap: 14px; padding: 6px 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 10px; }
  .cmdk-foot kbd { font-family: inherit; border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; margin-right: 3px; }

  @media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${sidebarUri}"></script>
</body>
</html>`;
}
