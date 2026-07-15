import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { HandoffViewModel, HandoffNoteVM, HandoffDistillTargetVM } from "./handoff/handoffViewModel.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { handoffMessage, type HandoffAction } from "./handoff/messages.js";
import {
  HANDOFF_DISTILL_PROFILES,
  normalizeAdditionalInstruction,
  normalizeHandoffDistillArgs,
} from "../handoff/distill.js";
import { parseHandoffDistillInputV1, type HandoffDistillInputV1 } from "../runtime-api/handoffCommands.js";
import type { WorkspaceHandoffTarget } from "../shell/HandoffTarget.js";
import { notify } from "../workspace/NotificationService.js";

export const HANDOFF_VIEW_TYPE = "tachyonHandoff";

export interface HandoffPanelState {
  schemaVersion: 1;
  view: typeof HANDOFF_VIEW_TYPE;
  wsHash: string;
}

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
    private readonly getWorkspaces: () => WorkspaceHandoffTarget[],
  ) {}

  open(wsHash?: string, revivedPanel?: vscode.WebviewPanel): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) { revivedPanel?.dispose(); return; }
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) {
      revivedPanel?.dispose();
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = revivedPanel ?? vscode.window.createWebviewPanel(
      HANDOFF_VIEW_TYPE,
      `Handoff — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // t-b5e6e5 — the native VS Code find widget (Ctrl+F), piggybacking on Mission Control's validation.
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.attachPanel(panel, ws);
  }

  deserialize(panel: vscode.WebviewPanel, state: HandoffPanelState): void {
    this.open(state.wsHash, panel);
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: WorkspaceHandoffTarget): void {
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    panel.title = `Handoff — ${ws.folderName}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.iconPath = panelIcon(this.extensionUri, "book"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Handoff — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("mermaid-block.css"), uri("handoff.css")],
      bundle: uri("handoff.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: HANDOFF_VIEW_TYPE, wsHash: ws.wsHash } satisfies HandoffPanelState,
    });

    let postGeneration = 0;
    const post = (): void => {
      const generation = ++postGeneration;
      void (async () => {
        const snap = await ws.loadHandoff();
        const notes: HandoffNoteVM[] = snap.notes.map((note) => ({ ...note, evidence: [...note.evidence] }));
        const distillTargets: HandoffDistillTargetVM[] = snap.distillTargets.map((target) => ({ ...target }));
        const vm: HandoffViewModel = {
          folder: ws.folderName,
          exists: snap.exists,
          body: snap.body,
          staleness: snap.staleness,
          pendingCount: snap.pendingCount,
          updatedAt: snap.updatedAt,
          updatedBy: snap.updatedBy,
          revision: snap.revision,
          notes,
          distillTargets,
          distillProfiles: HANDOFF_DISTILL_PROFILES,
        };
        if (generation === postGeneration) void panel.webview.postMessage(handoffMessage(vm));
      })().catch((err) => {
        if (generation === postGeneration) {
          notify(`Could not refresh Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "warn");
        }
      });
    };

    // spec 280 — type the inbound message so a typo'd `m.type === "…"` is a compile error (the typed-union
    // convention shared with sidebar/activity/pin-studio); the field stays optional (the message is untrusted).
    panel.webview.onDidReceiveMessage((m: Partial<HandoffAction>) => {
      if (m?.type === READY || m?.type === "refresh") { post(); return; } // (re)loaded webview / explicit refresh
      if (m?.type === "openFile") {
        void ws.ensureHandoffFile().then(async (filePath) => {
          await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.Beside });
          post();
        }).catch((err) => {
          notify(`Could not open Project Handoff: ${err instanceof Error ? err.message : String(err)}`, "error");
        });
      }
      if (m?.type === "distill") {
        const action = parseDistillAction(m);
        if (!action) {
          notify("Invalid handoff distillation request.", "warn");
          return;
        }
        void ws.startHandoffDistill(action).then((result) => {
          notify(result.mode === "existing"
            ? `Handoff distillation task sent to '${result.agent}'.`
            : `Handoff distillation agent '${result.agent}' started.`);
        }).catch((err) => {
          notify(`Could not start handoff distillation: ${err instanceof Error ? err.message : String(err)}`, "error");
        });
      }
    });

    panel.onDidDispose(() => { postGeneration += 1; this.panels.delete(key); });
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
function parseDistillAction(m: Partial<HandoffAction>): HandoffDistillInputV1 | null {
  if (m.type !== "distill") return null;
  const instructions = normalizeAdditionalInstruction(m.instructions);
  const args = normalizeHandoffDistillArgs(m.mode === "adhoc" ? m.args : undefined);
  const candidate = m.mode === "existing" && typeof m.agent === "string"
    ? { mode: "existing", agent: m.agent.trim(), ...(instructions ? { instructions } : {}) }
    : m.mode === "adhoc" && typeof m.profileId === "string"
      ? { mode: "adhoc", profileId: m.profileId, ...(args ? { args } : {}), ...(instructions ? { instructions } : {}) }
      : undefined;
  if (!candidate) return null;
  try { return parseHandoffDistillInputV1(candidate); } catch { return null; }
}
