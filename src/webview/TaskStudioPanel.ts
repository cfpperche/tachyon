import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { panelIcon } from "./shared/panelIcon.js";
import type { Workspace } from "../workspace/Workspace.js";
import { renderWebviewShell } from "./shared/shell.js";
import { TaskAttachmentStore, TASK_BLOB_SOFT_LIMIT_BYTES } from "../tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody, type TaskDetail } from "../tasks/TaskDetailStore.js";
import { decideAnchor, composeDirtyPatch, isEmptyPatch } from "../tasks/studioModel.js";
import { docToMarkdown } from "../tasks/docMarkdown.js";
import { markdownToDoc } from "../tasks/markdownDoc.js";
import { mintTaskId } from "../tasks/TaskStore.js";
import { EMPTY_DOC } from "./rich-doc/document.js";
import type { RichDocAssets, RichDocAttachmentVM } from "./rich-doc/types.js";
import type { RichDocAttachment, ResolvedRichDocAttachment } from "../richDoc/types.js";
import { taskStudioMessage, attachmentStoredMessage, errorMessage, saveConflictMessage } from "./task-studio/messages.js";
import type { TaskStudioDepVM, TaskStudioVM, TaskStudioWebviewMessage } from "./task-studio/types.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  mode: "new" | "edit";
  taskId: string;
  post: () => void;
}

/**
 * spec 339 — Task Studio: a new-task singleton panel per workspace + one panel per task id (the
 * PinStudioPanelManager pattern). New-task mode reserves a task id up front (`mintTaskId()`) so the
 * attachment namespace exists before the task does; `TaskDetailStore.createStaged` is what actually mints
 * the task using that exact id (T3). Edit mode loads through the body-hash anchoring model (`studioModel`).
 */
export class TaskStudioPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onTasksChanged: () => void,
  ) {}

  openNew(ws: Workspace): void {
    const key = panelKey(ws, "new");
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
    this.open(ws, "new", mintTaskId(), key);
  }

  openExisting(ws: Workspace, taskId: string): void {
    const key = panelKey(ws, taskId);
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
    this.open(ws, "edit", taskId, key);
  }

  private open(ws: Workspace, mode: "new" | "edit", taskId: string, key: string): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const blobRoot = vscode.Uri.file(new TaskAttachmentStore(ws.workspaceRoot, taskId).blobDir);
    const title = mode === "new" ? `New Task — ${ws.folderName}` : `Task Studio — ${taskId}`;
    const panel = vscode.window.createWebviewPanel(
      "tachyonTaskStudio",
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root, blobRoot], retainContextWhenHidden: true },
    );
    panel.iconPath = panelIcon(this.extensionUri, "tasklist");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    const assets: RichDocAssets = {
      excalidrawScriptUri: uri("excalidraw.js"),
      excalidrawCssUri: uri("excalidraw.css"),
      excalidrawAssetPath: `${panel.webview.asWebviewUri(root).toString().replace(/\/?$/, "/")}`,
    };
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      // spec 342 Pilot B — vscode-theme.css + task-studio.tailwind.css added for the Kit components the
      // fields row now uses (order: design-system → vscode-theme → Tailwind → surface CSS, see
      // test/unit/cssOrderSnapshot.test.ts).
      styles: [uri("codicon.css"), uri("design-system.css"), uri("vscode-theme.css"), uri("task-studio.tailwind.css"), uri("rich-doc.css"), uri("task-studio.css")],
      bundle: uri("task-studio.js"),
      mode: "live",
      imgBlob: true,
      connectSrc: true,
      workerSrc: "blob",
      childSrc: "blob",
      bootstrapGlobals: { EXCALIDRAW_ASSET_PATH: assets.excalidrawAssetPath },
    });

    const entry: PanelEntry = { panel, ws, mode, taskId, post: () => {} };
    entry.post = (): void => {
      try {
        const vm = this.vmFor(panel, ws, assets, mode, taskId);
        void panel.webview.postMessage(taskStudioMessage(vm));
      } catch (err) {
        void panel.webview.postMessage(errorMessage(err instanceof Error ? err.message : String(err)));
      }
    };
    panel.webview.onDidReceiveMessage((m: TaskStudioWebviewMessage) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, entry);
    entry.post();
  }

  private vmFor(panel: vscode.WebviewPanel, ws: Workspace, assets: RichDocAssets, mode: "new" | "edit", taskId: string): TaskStudioVM {
    const knownAgents = Object.keys(ws.config?.agents ?? {});
    if (mode === "new") {
      return { workspaceHash: ws.wsHash, folder: ws.folderName, mode: "new", taskId, title: "", deps: [], artifact_refs: [], doc: EMPTY_DOC, attachments: [], assets, anchor: "load", knownAgents };
    }
    const task = ws.taskStore.get(taskId);
    const detailStore = new TaskDetailStore(ws.workspaceRoot);
    const read = detailStore.read(taskId);
    const decision = decideAnchor(task, read);
    let doc = EMPTY_DOC;
    let attachments: RichDocAttachmentVM[] = [];
    if (decision.action === "load" && read.status === "ok") {
      doc = read.detail.doc;
      attachments = this.attachmentsForPanel(panel, ws, taskId, detailStore.resolveAttachments(taskId, read.detail.attachments));
    } else if (decision.action === "reimport") {
      doc = markdownToDoc(task.body ?? "");
    }
    return {
      workspaceHash: ws.wsHash,
      folder: ws.folderName,
      mode: "edit",
      taskId,
      title: task.title,
      ...(task.kind !== undefined ? { kind: task.kind } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      deps: resolveDeps(ws, task.deps ?? []),
      artifact_refs: task.artifact_refs ?? [],
      doc,
      attachments,
      assets,
      anchor: decision.action,
      ...(decision.action === "read-only" ? { anchorError: decision.reason } : {}),
      expectUpdatedAt: task.updatedAt,
      knownAgents,
    };
  }

  private attachmentsForPanel(panel: vscode.WebviewPanel, ws: Workspace, taskId: string, attachments: ResolvedRichDocAttachment[]): RichDocAttachmentVM[] {
    const store = new TaskAttachmentStore(ws.workspaceRoot, taskId);
    return attachments.map((att) => {
      if (att.kind === "excalidraw") {
        let previewUri: string | undefined;
        let sceneJson: string | undefined;
        if (att.previewAvailable) {
          try { previewUri = panel.webview.asWebviewUri(vscode.Uri.file(store.blobPath(att.previewBlobRef))).toString(); } catch { /* invalid refs stay unavailable */ }
        }
        if (att.sceneAvailable) {
          try { sceneJson = store.readExcalidrawScene(att); } catch { /* missing/corrupt scenes render as unavailable */ }
        }
        return { ...att, ...(previewUri ? { previewUri } : {}), ...(sceneJson ? { sceneJson } : {}) };
      }
      let uri: string | undefined;
      if (att.available) {
        try { uri = panel.webview.asWebviewUri(vscode.Uri.file(store.blobPath(att.blobRef))).toString(); } catch { /* invalid refs stay unavailable */ }
      }
      return { ...att, ...(uri ? { uri } : {}) };
    });
  }

  private async handleMessage(entry: PanelEntry, m: TaskStudioWebviewMessage): Promise<void> {
    if (!m?.type) return;
    if (m.type === "ready" || m.type === "reloadLatest") { entry.post(); return; }
    if (m.type === "cancel") { this.cancel(entry); return; }
    if (m.type === "importImage") { await this.importImage(entry); return; }
    if (m.type === "attachImage") { this.attachImage(entry, m); return; }
    if (m.type === "storeSketch") { this.storeSketch(entry, m); return; }
    if (m.type === "save") { await this.save(entry, m); return; }
  }

  /** Cancelling a NEW-task panel that never saved leaves an orphaned provisional attachment namespace behind
   *  (no task, no sidecar ever referenced it) — clean it up best-effort, same as a failed staged create. */
  private cancel(entry: PanelEntry): void {
    if (entry.mode === "new") {
      try { fs.rmSync(new TaskAttachmentStore(entry.ws.workspaceRoot, entry.taskId).taskAttachmentsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    entry.panel.dispose();
  }

  private async importImage(entry: PanelEntry): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] },
      title: "Import image into task",
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    const mediaType = mediaTypeFor(file);
    if (!mediaType) { this.postError(entry, "Unsupported image type"); return; }
    try {
      const data = fs.readFileSync(file);
      this.storeImageAttachment(entry, data, mediaType, path.basename(file), "import");
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private attachImage(entry: PanelEntry, m: Extract<TaskStudioWebviewMessage, { type: "attachImage" }>): void {
    try {
      const estimated = Math.floor((m.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("task image exceeds 10 MB limit");
      this.storeImageAttachment(entry, Buffer.from(stripDataPrefix(m.dataBase64), "base64"), m.mediaType, m.name, m.source);
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private storeImageAttachment(entry: PanelEntry, data: Buffer, mediaType: string, name: string | undefined, source: Extract<RichDocAttachment, { kind: "image" }>["source"]): void {
    const store = new TaskAttachmentStore(entry.ws.workspaceRoot, entry.taskId);
    const att = store.putImage({ data, mediaType, name, source });
    const resolved = this.attachmentsForPanel(entry.panel, entry.ws, entry.taskId, [store.resolveAttachment(att)])[0];
    void entry.panel.webview.postMessage(attachmentStoredMessage(resolved));
    if (store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES) {
      void vscode.window.showWarningMessage("Tachyon task images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.");
    }
  }

  private storeSketch(entry: PanelEntry, m: Extract<TaskStudioWebviewMessage, { type: "storeSketch" }>): void {
    try {
      const store = new TaskAttachmentStore(entry.ws.workspaceRoot, entry.taskId);
      const existing = entry.mode === "edit"
        ? new TaskDetailStore(entry.ws.workspaceRoot).read(entry.taskId)
        : { status: "missing" as const };
      const existingAtt = existing.status === "ok" ? existing.detail.attachments.find((att) => att.kind === "excalidraw" && att.id === m.attachmentId) : undefined;
      const att = store.putExcalidraw({
        sceneJson: m.sceneJson,
        previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
        name: m.name,
        source: m.source,
        ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
        ...(existingAtt?.kind === "excalidraw" ? { existing: existingAtt } : {}),
      });
      const resolved = this.attachmentsForPanel(entry.panel, entry.ws, entry.taskId, [store.resolveAttachment(att)])[0];
      void entry.panel.webview.postMessage(attachmentStoredMessage(resolved));
      if (store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES) {
        void vscode.window.showWarningMessage("Tachyon task visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.");
      }
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private async save(entry: PanelEntry, m: Extract<TaskStudioWebviewMessage, { type: "save" }>): Promise<void> {
    const detailStore = new TaskDetailStore(entry.ws.workspaceRoot);
    if (entry.mode === "new") {
      try {
        await detailStore.createStaged(entry.ws.taskStore, entry.taskId, {
          title: m.title,
          ...(m.kind ? { kind: m.kind } : {}),
          ...(m.priority !== undefined ? { priority: m.priority } : {}),
          ...(m.artifact_refs.length ? { artifact_refs: m.artifact_refs } : {}),
          ...(m.deps.length ? { deps: m.deps } : {}),
          doc: m.doc,
          attachments: m.attachments,
          body: docToMarkdown(m.doc),
        });
        this.onTasksChanged();
        entry.panel.dispose();
      } catch (err) {
        // staged-create failure cleanup (T7): nothing was persisted under this id — remove any attachment
        // blobs the user uploaded during editing so they don't linger as an orphan namespace.
        try { fs.rmSync(new TaskAttachmentStore(entry.ws.workspaceRoot, entry.taskId).taskAttachmentsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        this.postError(entry, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    try {
      const previousRead = detailStore.read(entry.taskId);
      const previousAttachments: RichDocAttachment[] = previousRead.status === "ok" ? previousRead.detail.attachments : [];
      const body = m.docDirty ? docToMarkdown(m.doc) : undefined;
      const patch = composeDirtyPatch(
        {
          title: m.title,
          kind: m.kind ?? null,
          priority: m.priority ?? null,
          assignee: m.assignee ?? null,
          deps: m.deps.length ? m.deps : null,
          artifact_refs: m.artifact_refs.length ? m.artifact_refs : null,
        },
        m.dirty,
        // TaskStore rejects an empty-string body outright (boundedString requires non-empty) — an emptied
        // doc must clear the field with `null` instead, never send `body: ""`.
        { ...(body !== undefined ? { body: body.trim() ? body : null } : {}), ...(m.expectUpdatedAt !== undefined ? { expectUpdatedAt: m.expectUpdatedAt } : {}) },
      );
      if (isEmptyPatch(patch)) { entry.panel.dispose(); return; }

      let updated;
      try {
        updated = await entry.ws.taskStore.update(entry.taskId, patch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("precondition-failed")) { void entry.panel.webview.postMessage(saveConflictMessage(message)); return; }
        throw err;
      }
      if (body !== undefined) {
        const detail: TaskDetail = { schemaVersion: 1, taskId: entry.taskId, doc: m.doc, attachments: m.attachments, bodyHash: hashBody(body), taskUpdatedAt: updated.updatedAt };
        detailStore.write(detail);
        detailStore.gcRemovedAttachments(entry.taskId, previousAttachments, m.attachments);
      }
      this.onTasksChanged();
      entry.panel.dispose();
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private postError(entry: PanelEntry, message: string): void {
    void entry.panel.webview.postMessage(errorMessage(message));
  }

  /** Re-post to every open Studio panel — part of the shared onTasksChanged fan-out (extension.ts). */
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

function resolveDeps(ws: Workspace, deps: string[]): TaskStudioDepVM[] {
  return deps.map((id) => {
    try {
      const dep = ws.taskStore.get(id);
      return { id, title: dep.title, missing: false };
    } catch {
      return { id, missing: true };
    }
  });
}

function stripDataPrefix(value: string): string {
  const i = value.indexOf(",");
  return i >= 0 ? value.slice(i + 1) : value;
}

function mediaTypeFor(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return undefined;
}
