import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { Workspace } from "../workspace/Workspace.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import type { Task, TaskDerived, TaskAttention, TaskUpdateInput, TaskView } from "../tasks/types.js";
import { taskMessage, taskDetailErrorMessage, type TaskDetailAction, type TaskDetailVM, type TaskDepVM } from "./task-detail/messages.js";
import { TaskDetailStore } from "../tasks/TaskDetailStore.js";
import { TaskAttachmentStore } from "../tasks/TaskAttachmentStore.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  taskId: string;
  lastKnown?: TaskView;
  post: () => void;
}

/**
 * spec 335 — the Task Detail panel: one editor tab PER task id (PinStudioPanelManager pattern), independent of
 * any board filter. A task moving to Done/Dropped keeps its open tab live; a task that disappears or becomes
 * unparseable renders a read-only tombstone with the last known state — this manager never disposes a panel
 * out from under the user (dueto F8).
 */
export class TaskDetailPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly openTaskStudio: (ws: Workspace, id: string) => void,
    private readonly onTasksChanged: () => void,
  ) {}

  open(ws: Workspace, taskId: string): void {
    const key = panelKey(ws, taskId);
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    // dogfood round 1 (#5, spec 339) — the blob dir is registered here (not just in Task Studio's panel) so
    // asWebviewUri() below can actually resolve `attachment:<id>` refs the body carries.
    const blobRoot = vscode.Uri.file(new TaskAttachmentStore(ws.workspaceRoot, taskId).blobDir);
    const panel = vscode.window.createWebviewPanel(
      "tachyonTaskDetail",
      `Task ${taskId}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // t-b5e6e5 — the native VS Code find widget (Ctrl+F), piggybacking on Mission Control's validation.
      { enableScripts: true, localResourceRoots: [root, blobRoot], retainContextWhenHidden: true, enableFindWidget: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "note");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Task ${taskId}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("task-detail.css")],
      bundle: uri("task-detail.js"),
      mode: "live",
    });

    const entry: PanelEntry = { panel, ws, taskId, post: () => {} };
    entry.post = (): void => this.postFor(entry);
    panel.webview.onDidReceiveMessage((m: Partial<TaskDetailAction>) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, entry);
    entry.post();
  }

  private postFor(entry: PanelEntry): void {
    try {
      const view = entry.ws.taskStore.getView(entry.taskId);
      entry.lastKnown = view;
      void entry.panel.webview.postMessage(taskMessage(this.vmFor(entry.panel, entry.ws, entry.taskId, view, false)));
    } catch {
      // the file disappeared or became unparseable — render a tombstone from the LAST KNOWN state, never
      // dispose the panel out from under the user (dueto F8).
      if (entry.lastKnown) {
        void entry.panel.webview.postMessage(taskMessage(this.vmFor(entry.panel, entry.ws, entry.taskId, entry.lastKnown, true)));
      } else {
        void entry.panel.webview.postMessage(taskMessage({ wsHash: entry.ws.wsHash, id: entry.taskId, tombstone: true, deps: [] }));
      }
    }
  }

  /** dogfood round 1 (#5, spec 339) — `task.body` carries logical `attachment:<id>` refs (see docMarkdown.ts)
   *  that only Task Studio used to resolve; the detail tab rendered them verbatim, and DOMPurify's URI
   *  allowlist (https:/mailto:/#) then stripped the unresolved `src` outright. Read-only: resolves against
   *  the sidecar's OWN attachment list, never writes anything. */
  private resolveAttachmentRefs(panel: vscode.WebviewPanel, ws: Workspace, taskId: string, body: string): string {
    if (!body.includes("attachment:")) return body;
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    const read = detailStore.read(taskId);
    if (read.status !== "ok" || read.detail.attachments.length === 0) return body;
    const store = new TaskAttachmentStore(ws.workspaceRoot, taskId);
    let out = body;
    for (const att of detailStore.resolveAttachments(taskId, read.detail.attachments)) {
      if (att.kind !== "image" || !att.available) continue;
      let uri: string;
      try {
        uri = panel.webview.asWebviewUri(vscode.Uri.file(store.blobPath(att.blobRef))).toString();
      } catch {
        continue; // invalid blob ref — leave as-is (same broken-image outcome as today, not a crash)
      }
      out = out.split(`attachment:${att.id}`).join(uri);
    }
    return out;
  }

  private vmFor(panel: vscode.WebviewPanel, ws: Workspace, id: string, view: TaskView, tombstone: boolean): TaskDetailVM {
    const task: Task = view.task;
    const deps = resolveDeps(ws, task.deps ?? []);
    const derived: TaskDerived | undefined = view.derived;
    const attention: TaskAttention[] | undefined = view.attention;
    return {
      wsHash: ws.wsHash,
      id,
      tombstone,
      task: {
        id: task.id,
        title: task.title,
        ...(task.body !== undefined ? { body: this.resolveAttachmentRefs(panel, ws, id, task.body) } : {}),
        status: task.status,
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.kind !== undefined ? { kind: task.kind } : {}),
        author: task.author,
        ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
        ...(task.artifact_refs !== undefined ? { artifact_refs: task.artifact_refs } : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      ...(derived ? { derived } : {}),
      ...(attention?.length ? { attention } : {}),
      deps,
    };
  }

  private async handleMessage(entry: PanelEntry, m: Partial<TaskDetailAction>): Promise<void> {
    if (!m?.type) return;
    if (m.type === READY || m.type === "requestSnapshot") { entry.post(); return; }
    if (m.type === "updateTask" && m.patch) {
      try {
        await entry.ws.taskStore.update(entry.taskId, m.patch as TaskUpdateInput);
        // dogfood round 1 (#1) — the one shared fan-out (injected from extension.ts): re-posts this panel,
        // every other Detail panel, every Mission Control panel, and the sidebar.
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskDetailErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "openTask" && typeof m.id === "string") {
      this.open(entry.ws, m.id);
      return;
    }
    if (m.type === "openTaskStudio") {
      this.openTaskStudio(entry.ws, entry.taskId);
      // dogfood round 1 (#4, spec 339) — Studio takes over editing; the originating detail tab shouldn't
      // linger. onDidDispose (registered in open()) already removes it from `panels`.
      entry.panel.dispose();
    }
  }

  /** Re-post to every open detail panel — independent of any board filter (dueto F8); part of the shared
   *  onTasksChanged fan-out (extension.ts), wired into onViewsChanged("tasks") and called directly by both
   *  panel managers after their own engine-side mutations. */
  refreshAll(): void {
    for (const entry of this.panels.values()) entry.post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function panelKey(ws: Workspace, taskId: string): string {
  return `${ws.wsHash}:${taskId}`;
}

function resolveDeps(ws: Workspace, deps: string[]): TaskDepVM[] {
  return deps.map((id) => {
    try {
      const dep = ws.taskStore.get(id);
      return { id, title: dep.title, status: dep.status, missing: false };
    } catch {
      return { id, missing: true };
    }
  });
}
