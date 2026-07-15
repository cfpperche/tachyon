import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { taskMessage, taskDetailErrorMessage, type TaskDetailAction, type TaskDetailVM } from "./task-detail/messages.js";
import { assembleUntrustedSrcdoc } from "./shared/untrustedSrcdoc.js";
import type { TaskDetailProjectionV1 } from "../runtime-api/taskDetailProjection.js";
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: WorkspaceTaskDetailTarget;
  taskId: string;
  lastKnown?: TaskDetailProjectionV1;
  post: () => void | Promise<void>;
  generation: number;
  disposed: boolean;
}

export const TASK_DETAIL_VIEW_TYPE = "tachyonTaskDetail";

export interface TaskDetailPanelState {
  schemaVersion: 1;
  view: typeof TASK_DETAIL_VIEW_TYPE;
  wsHash: string;
  taskId: string;
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
    getWorkspacesOrOpenTaskStudio: (() => WorkspaceTaskDetailTarget[]) | ((ws: WorkspaceTaskDetailTarget, id: string) => void),
    openTaskStudioOrOnTasksChanged: ((ws: WorkspaceTaskDetailTarget, id: string) => void) | (() => void),
    onTasksChangedMaybe?: () => void,
  ) {
    if (onTasksChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOpenTaskStudio as () => WorkspaceTaskDetailTarget[];
      this.openTaskStudio = openTaskStudioOrOnTasksChanged as (ws: WorkspaceTaskDetailTarget, id: string) => void;
      this.onTasksChanged = onTasksChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.openTaskStudio = getWorkspacesOrOpenTaskStudio as (ws: WorkspaceTaskDetailTarget, id: string) => void;
      this.onTasksChanged = openTaskStudioOrOnTasksChanged as () => void;
    }
  }

  private readonly getWorkspaces: () => WorkspaceTaskDetailTarget[];
  private readonly openTaskStudio: (ws: WorkspaceTaskDetailTarget, id: string) => void;
  private readonly onTasksChanged: () => void;

  open(ws: WorkspaceTaskDetailTarget, taskId: string): void {
    const key = panelKey(ws, taskId);
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    // dogfood round 1 (#5, spec 339) — the blob dir is registered here (not just in Task Studio's panel) so
    // asWebviewUri() below can actually resolve `attachment:<id>` refs the body carries.
    const blobRoot = vscode.Uri.file(ws.attachmentBlobRoot(taskId));
    const panel = vscode.window.createWebviewPanel(
      TASK_DETAIL_VIEW_TYPE,
      `Task ${taskId}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // t-b5e6e5 — the native VS Code find widget (Ctrl+F), piggybacking on Mission Control's validation.
      { enableScripts: true, localResourceRoots: [root, blobRoot], retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.attachPanel(panel, ws, taskId);
  }

  deserialize(panel: vscode.WebviewPanel, state: TaskDetailPanelState): void {
    const ws = this.workspaceFor(state.wsHash);
    if (!ws) { panel.dispose(); return; }
    this.attachPanel(panel, ws, state.taskId);
  }

  private workspaceFor(wsHash: string): WorkspaceTaskDetailTarget | undefined {
    return this.getWorkspaces().find((w) => w.wsHash === wsHash);
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: WorkspaceTaskDetailTarget, taskId: string): void {
    const key = panelKey(ws, taskId);
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const blobRoot = vscode.Uri.file(ws.attachmentBlobRoot(taskId));
    panel.title = `Task ${taskId}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root, blobRoot] };
    panel.iconPath = panelIcon(this.extensionUri, "note");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Task ${taskId}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("mermaid-block.css"), uri("task-detail.css")],
      bundle: uri("task-detail.js"),
      mode: "live",
      frameSrc: "self",
      persistedState: { schemaVersion: 1, view: TASK_DETAIL_VIEW_TYPE, wsHash: ws.wsHash, taskId } satisfies TaskDetailPanelState,
    });

    const entry: PanelEntry = { panel, ws, taskId, post: () => {}, generation: 0, disposed: false };
    entry.post = (): Promise<void> => this.postFor(entry);
    panel.webview.onDidReceiveMessage((m: Partial<TaskDetailAction>) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => {
      entry.disposed = true;
      entry.generation += 1;
      this.panels.delete(key);
    });
    this.panels.set(key, entry);
    void entry.post();
  }

  private async postFor(entry: PanelEntry): Promise<void> {
    const generation = ++entry.generation;
    try {
      const detail = await entry.ws.loadTaskDetail(entry.taskId);
      if (entry.disposed || entry.generation !== generation) return;
      entry.lastKnown = detail;
      void entry.panel.webview.postMessage(taskMessage(this.vmFor(entry.panel, entry.ws, entry.taskId, detail, false)));
    } catch {
      if (entry.disposed || entry.generation !== generation) return;
      // the file disappeared or became unparseable — render a tombstone from the LAST KNOWN state, never
      // dispose the panel out from under the user (dueto F8).
      if (entry.lastKnown) {
        void entry.panel.webview.postMessage(taskMessage(this.vmFor(entry.panel, entry.ws, entry.taskId, entry.lastKnown, true)));
      } else {
        void entry.panel.webview.postMessage(taskMessage({ wsHash: entry.ws.wsHash, id: entry.taskId, tombstone: true, journal: [], deps: [], prototypes: { readOnly: false, prototypes: [] } }));
      }
    }
  }

  /** dogfood round 1 (#5, spec 339) — `task.body` carries logical `attachment:<id>` refs (see docMarkdown.ts)
   *  that only Task Studio used to resolve; the detail tab rendered them verbatim, and DOMPurify's URI
   *  allowlist (https:/mailto:/#) then stripped the unresolved `src` outright. Read-only: resolves against
   *  the sidecar's OWN attachment list, never writes anything. */
  private resolveAttachmentRefs(
    panel: vscode.WebviewPanel,
    ws: WorkspaceTaskDetailTarget,
    taskId: string,
    body: string,
    attachments: TaskDetailProjectionV1["imageAttachments"],
  ): string {
    if (!body.includes("attachment:")) return body;
    let out = body;
    for (const att of attachments) {
      if (!att.available) continue;
      let uri: string;
      try {
        uri = panel.webview.asWebviewUri(vscode.Uri.file(ws.attachmentBlobPath(taskId, att.blobRef))).toString();
      } catch {
        continue; // invalid blob ref — leave as-is (same broken-image outcome as today, not a crash)
      }
      out = out.split(`attachment:${att.id}`).join(uri);
    }
    return out;
  }

  private vmFor(
    panel: vscode.WebviewPanel,
    ws: WorkspaceTaskDetailTarget,
    id: string,
    detail: TaskDetailProjectionV1,
    tombstone: boolean,
  ): TaskDetailVM {
    const task = detail.task;
    return {
      wsHash: ws.wsHash,
      id,
      tombstone,
      task: {
        id: task.id,
        title: task.title,
        ...(task.body !== undefined ? { body: this.resolveAttachmentRefs(panel, ws, id, task.body, detail.imageAttachments) } : {}),
        status: task.status,
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.kind !== undefined ? { kind: task.kind } : {}),
        author: task.author,
        ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
        ...(task.artifact_refs !== undefined ? { artifact_refs: task.artifact_refs } : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      journal: detail.journal,
      ...(detail.derived ? { derived: detail.derived } : {}),
      ...(detail.attention?.length ? { attention: detail.attention } : {}),
      deps: detail.deps,
      prototypes: this.prototypeVm(ws, id, detail.prototypes),
    };
  }

  private prototypeVm(
    ws: WorkspaceTaskDetailTarget,
    id: string,
    snapshot: TaskDetailProjectionV1["prototypes"],
  ) {
    return {
      ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
      readOnly: snapshot.readOnly,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      prototypes: snapshot.prototypes.map((p) => ({
        id: p.id, sha256: p.sha256, state: p.state, title: p.title, author: p.author, createdAt: p.createdAt,
        available: p.available, integrity: p.integrity,
        ...(p.needsTaskReconciliation ? { needsTaskReconciliation: true } : {}),
        ...(p.available ? this.prototypeSrcdoc(ws, id, p.id) : {}),
      })),
    };
  }

  private prototypeSrcdoc(ws: WorkspaceTaskDetailTarget, taskId: string, prototypeId: string): { staticSrcdoc?: string } {
    try {
      return { staticSrcdoc: assembleUntrustedSrcdoc(ws.prototypeHtml(taskId, prototypeId), { mode: "prototype-static" }) };
    } catch {
      return {};
    }
  }

  private async handleMessage(entry: PanelEntry, m: Partial<TaskDetailAction>): Promise<void> {
    if (!m?.type) return;
    if (m.type === READY || m.type === "requestSnapshot") { void entry.post(); return; }
    if (m.type === "updateTask" && m.patch) {
      try {
        await entry.ws.updateTask(entry.taskId, m.patch);
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
    if ((m.type === "approvePrototype" || m.type === "rejectPrototype" || m.type === "notePrototype") &&
        typeof m.prototypeId === "string" && typeof m.expectUpdatedAt === "string") {
      try {
        const action = m.type === "approvePrototype" ? "approve" : m.type === "rejectPrototype" ? "reject" : "note";
        await entry.ws.reviewPrototype(entry.taskId, {
          prototypeId: m.prototypeId,
          action,
          expectUpdatedAt: m.expectUpdatedAt,
          ...(m.review ? { review: m.review } : {}),
        });
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskDetailErrorMessage(err instanceof Error ? err.message : String(err)));
      }
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
    for (const entry of this.panels.values()) void entry.post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function panelKey(ws: WorkspaceTaskDetailTarget, taskId: string): string {
  return `${ws.wsHash}:${taskId}`;
}
