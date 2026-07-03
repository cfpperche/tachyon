import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { Workspace } from "../workspace/Workspace.js";
import { buildBoardSnapshot } from "../tasks/boardSnapshot.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { snapshotMessage, taskErrorMessage, type MissionControlAction, type MissionControlVM } from "./mission-control/messages.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  post: () => void;
}

/**
 * spec 335 — the Mission Control board: a singleton editor-area panel per workspace (HandoffPanel pattern),
 * fed by ONE engine-side board-snapshot pass per push (dueto F4 — every card/chip/spotlight in a push reflects
 * a single consistent filesystem view). All mutations route through `ws.taskStore` directly — the board is
 * engine-side, never MCP. `openTaskDetail` is injected so this module never imports TaskDetailPanel (kept as
 * two independent panel managers, wired together in extension.ts).
 */
export class MissionControlPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
    private readonly openTaskDetail: (ws: Workspace, id: string) => void,
  ) {}

  open(wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonMissionControl",
      `Mission Control — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "tasklist");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Mission Control — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("mission-control.css")],
      bundle: uri("mission-control.js"),
      mode: "live",
    });

    const post = (): void => {
      try {
        const vm: MissionControlVM = {
          folder: ws.folderName,
          wsHash: ws.wsHash,
          snapshot: buildBoardSnapshot({ store: ws.taskStore, declaredAgents: Object.keys(ws.config?.agents ?? {}) }),
        };
        void panel.webview.postMessage(snapshotMessage(vm));
      } catch (err) {
        void panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
    };
    const entry: PanelEntry = { panel, ws, post };
    panel.webview.onDidReceiveMessage((m: Partial<MissionControlAction>) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, entry);
    post();
  }

  private async handleMessage(entry: PanelEntry, m: Partial<MissionControlAction>): Promise<void> {
    if (!m?.type) return;
    if (m.type === READY || m.type === "requestSnapshot") { entry.post(); return; }
    if (m.type === "updateTask" && typeof m.id === "string" && m.patch) {
      try {
        await entry.ws.taskStore.update(m.id, m.patch);
        // the store mutated → onTasksChanged fires refreshAll() (wired in extension.ts), which re-posts here too;
        // post() again immediately anyway so THIS panel doesn't wait on that indirection for its own action.
        this.refreshWorkspace(entry.ws);
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return;
    }
    if (m.type === "createTask" && m.input) {
      try {
        await entry.ws.taskStore.create({ ...m.input, author: "human" });
        this.refreshWorkspace(entry.ws);
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "openTask" && typeof m.id === "string") {
      this.openTaskDetail(entry.ws, m.id);
    }
  }

  private refreshWorkspace(ws: Workspace): void {
    for (const entry of this.panels.values()) {
      if (entry.ws.wsHash === ws.wsHash) entry.post();
    }
  }

  /** Re-post to every open panel — onViewsChanged("tasks") carries no wsHash, so refresh them all (cheap). */
  refreshAll(): void {
    for (const { post } of this.panels.values()) post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
