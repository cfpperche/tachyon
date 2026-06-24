import * as vscode from "vscode";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { HANDOFF_TEMPLATE } from "../handoff/ProjectHandoffStore.js";
import type { HandoffViewModel, HandoffNoteVM } from "./handoff/handoffViewModel.js";

/**
 * spec 245 inc D — the Project Handoff editor-area panel (one per workspace root). A read-only DOCUMENT view
 * of the shared, curated handoff (`.tachyon/HANDOFF.md`) + the pending-note lane + a staleness badge. Mirrors
 * the ActivityPanelManager (spec 238): createWebviewPanel + asWebviewUri(dist/webview/handoff.js) + a single
 * snapshot postMessage, re-posted when the engine fires onViewsChanged("handoff"). No live-tail / paging — the
 * handoff is a small static doc, not a growing feed. The ENGINE owns the snapshot; the UI renders it.
 */
export class HandoffPanelManager {
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
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonHandoff",
      `◆ Handoff — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const dsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "design-system.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "handoff.js"));
    panel.webview.html = html(panel.webview, codiconUri, dsUri, scriptUri, ws.folderName);

    const post = (): void => {
      const snap = ws.handoffStore.snapshot(ws.lastActivityAt?.() ?? null);
      // inc G — the snapshot now carries the pending rows (one source for the panel + the Bridge `get`; no
      // re-implementing the pending rule here — keeps list + badge count in lockstep).
      const notes: HandoffNoteVM[] = snap.pending.map((n) => ({ ts: n.ts, agent: n.agent, kind: n.kind, summary: n.summary, evidence: n.evidence }));
      const vm: HandoffViewModel = {
        folder: ws.folderName,
        exists: snap.exists,
        body: snap.body,
        staleness: snap.staleness,
        pendingCount: snap.pendingCount,
        updatedAt: snap.meta?.updated_at ?? "",
        updatedBy: snap.meta?.updated_by ?? "",
        revision: snap.revision,
        notes,
      };
      void panel.webview.postMessage({ type: "handoff", vm });
    };

    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === "ready" || m?.type === "refresh") { post(); return; } // (re)loaded webview / explicit refresh
      if (m?.type === "openFile") {
        // Open the canonical handoff read/write; create it from the 4-section template when it doesn't exist
        // yet (the cold-start "Open" affordance) so the user lands in a real, editable file.
        const filePath = ws.handoffStore.canonicalPath;
        if (!fs.existsSync(filePath)) {
          ws.handoffStore.setCanonical(HANDOFF_TEMPLATE, undefined, "human");
          post(); // the file now exists → refresh the panel out of the cold-start state
        }
        void vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
    });

    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, { panel, post });
    post();
  }

  /** Re-post the snapshot to an open panel for this workspace (wired into onViewsChanged("handoff")). */
  refresh(wsHash: string): void {
    this.panels.get(wsHash)?.post();
  }

  /** Re-post to every open panel — onViewsChanged("handoff") carries no wsHash, so refresh them all (cheap). */
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

function html(webview: vscode.Webview, codiconUri: vscode.Uri, dsUri: vscode.Uri, scriptUri: vscode.Uri, folder: string): string {
  const nonce = getNonce();
  const title = folder.replace(/[<>&]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${dsUri}">
<title>Handoff — ${title}</title>
<style>
  /* spec 252 — panel-specific deltas only; shared tokens + components live in design-system.css (.ds-*). */
  .codicon-loading { animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Header: a single inline row — title (.ds-title) + staleness badge (.ds-badge) + actions (.ds-btn) */
  .head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: var(--ds-3); flex-wrap: wrap; padding: var(--ds-3) var(--ds-4); background: var(--vscode-editor-background); border-bottom: 1px solid var(--ds-border); }
  .head .actions { margin-left: auto; display: inline-flex; align-items: center; gap: var(--ds-2); }
  .head .ds-btn .codicon { font-size: 13px; }

  /* Body */
  .body, .notes { max-width: 880px; margin: 0 auto; padding: var(--ds-4) var(--ds-4) 0; }
  .meta { color: var(--ds-muted); font-size: var(--ds-small); display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: var(--ds-3); }

  /* Cold-start empty state — the Open button reads as primary in this context */
  .cold { max-width: 560px; margin: 56px auto 0; text-align: center; color: var(--ds-muted); display: flex; flex-direction: column; align-items: center; gap: var(--ds-2); }
  .cold .codicon { font-size: 30px; opacity: .5; }
  .cold .ds-btn { margin-top: var(--ds-2); background: var(--ds-btn-bg); color: var(--ds-btn-fg); border-color: transparent; }
  .cold .ds-btn:hover { background: var(--ds-btn-hover); }

  .ds-degrade .codicon { font-size: 24px; opacity: .5; display: block; margin: 0 auto 10px; }

  /* Pending notes — a quiet secondary list */
  .notes h2 { font-size: var(--ds-small); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--ds-muted); display: flex; align-items: center; gap: 6px; margin: var(--ds-5) 0 var(--ds-2); padding-top: var(--ds-4); border-top: 1px solid var(--ds-border); }
  .notes h2 .codicon { font-size: 13px; }
  .notes .empty { font-style: italic; padding: 2px 0 var(--ds-2); }
  .note { padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--ds-border) 60%, transparent); }
  .note:last-child { border-bottom: 0; }
  .note-top { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
  .note .nglyph { flex: none; }
  .note .nagent { font-weight: 600; }
  .note .nage { color: var(--ds-muted); font-size: var(--ds-micro); }
  .note .nsum { min-width: 0; overflow-wrap: anywhere; }
  .note .nevidence { color: var(--ds-muted); font-size: var(--ds-micro); font-family: var(--ds-mono); margin: 2px 0 0 20px; overflow-wrap: anywhere; }

  /* Markdown body — the same language as the Activity panel (renderMarkdownHtml output) */
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 6px; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; font-weight: 600; line-height: 1.3; }
  .md h1 { font-size: 1.4em; } .md h2 { font-size: 1.25em; } .md h3 { font-size: 1.12em; } .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .md li { margin: 1px 0; }
  .md code { font-family: var(--ds-mono); font-size: .92em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18)); padding: 0 4px; border-radius: 3px; }
  .md pre { margin: 6px 0; padding: 8px 10px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14)); border-radius: var(--ds-radius); overflow-x: auto; }
  .md pre code { background: none; padding: 0; }
  .md a { color: var(--ds-link); }
  .md blockquote { margin: 6px 0; padding: 2px 10px; border-left: 3px solid var(--ds-border); color: var(--ds-muted); }
  .md hr { border: 0; border-top: 1px solid var(--ds-border); margin: 12px 0; }
  .md em { color: var(--ds-muted); }
  .md table { border-collapse: collapse; margin: 6px 0; display: block; overflow-x: auto; max-width: 100%; }
  .md th, .md td { border: 1px solid var(--ds-border); padding: 4px 9px; text-align: left; }
  .md th { background: var(--vscode-editorWidget-background, rgba(128,128,128,.12)); font-weight: 600; }
  .md .codeblock .copy { display: none; } /* read-only doc: hide the activity copy-button affordance */
  .md ul.contains-task-list { list-style: none; padding-left: 18px; }
  .md .task-check { display: inline-block; box-sizing: border-box; width: 13px; height: 13px; margin: 0 6px 0 -18px; border: 1px solid var(--ds-muted); border-radius: 3px; vertical-align: -2px; position: relative; }
  .md .task-check.checked { background: var(--vscode-textLink-foreground, #4daafc); border-color: transparent; }
  .md .task-check.checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 3px; height: 6px; border: solid var(--vscode-editor-background, #1e1e1e); border-width: 0 2px 2px 0; transform: rotate(45deg); }

  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
