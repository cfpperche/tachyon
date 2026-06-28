import * as vscode from "vscode";
import * as fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { HANDOFF_TEMPLATE } from "../handoff/ProjectHandoffStore.js";
import type { HandoffViewModel, HandoffNoteVM } from "./handoff/handoffViewModel.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { handoffMessage } from "./handoff/messages.js";

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
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Handoff — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("handoff.css")],
      bundle: uri("handoff.js"),
      mode: "live",
    });

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
      void panel.webview.postMessage(handoffMessage(vm));
    };

    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === READY || m?.type === "refresh") { post(); return; } // (re)loaded webview / explicit refresh
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
