import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import type { StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { envelope } from "./shared/studio/protocol.js";
import { TaskStudioAdapter } from "./TaskStudioAdapter.js";
import { TaskAttachmentStore, TASK_BLOB_SOFT_LIMIT_BYTES } from "../tasks/TaskAttachmentStore.js";
import { TaskDetailStore } from "../tasks/TaskDetailStore.js";
import { mintTaskId } from "../tasks/TaskStore.js";
import type { RichDocAttachment } from "../richDoc/types.js";
import { attachmentStoredMessage } from "./task-studio/messages.js";
import type { TaskDetailEntity, TaskFields, TaskPatch } from "./task-studio/domain.js";

/**
 * spec 350 T2 — Task Studio's host wiring: thin over `StudioPanelManagerBase` + `TaskStudioAdapter`. Public
 * entry points (`openNew`/`openExisting`/`refreshAll`/`dispose`) are UNCHANGED from 339 — extension.ts's
 * wiring (src/extension.ts:451-459,1046) needed zero edits. One `StudioPanelManagerBase` instance per
 * workspace (keyed by `wsHash`) since the base itself has no workspace concept — the adapter is what's
 * workspace-scoped (`new TaskStudioAdapter(ws)`).
 *
 * `openNew` mints a task id up front (`mintTaskId()`) and routes through the base's `openExisting`, exactly
 * like 339 did — the pre-minted id (and its attachment namespace) stays stable through the whole edit
 * session; the base's own reveal-on-reopen dedup then applies unchanged. A second `openNew` call before the
 * first session closes reuses the SAME pending id (checked via `captureSnapshot` — `undefined` means that
 * panel isn't open anymore, so a fresh id is minted instead) — same "one new-task panel per workspace"
 * behavior 339 had, without needing a disposal callback the base doesn't expose.
 *
 * Known, accepted, non-behavioral gaps vs 339 (cosmetic, outside the 339 authoring contract — body-hash
 * anchoring/dirty-patch/staged-create/freshness-banner — so not blocking this migration): the base's `open()`
 * doesn't set `panel.iconPath` or `enableFindWidget`, so the Task Studio tab loses its custom icon and native
 * Ctrl+F stops working inside the panel. Not fixed here — a further additive `StudioSurfaceConfig` field,
 * same shape as Amendment 2, if wanted later.
 */
const surface: StudioSurfaceConfig = {
  viewType: "tachyonTaskStudio",
  bundleFile: "task-studio.js",
  // spec 342 Pilot B — vscode-theme.css + task-studio.tailwind.css for the Kit components the fields row
  // uses (order: design-system → vscode-theme → Tailwind → surface CSS, see cssOrderSnapshot.test.ts).
  styleFiles: ["codicon.css", "design-system.css", "vscode-theme.css", "task-studio.tailwind.css", "rich-doc.css", "studio-frame.css", "task-studio.css"],
  imgBlob: true,
  connectSrc: true,
  workerSrc: "blob",
  childSrc: "blob",
  bootstrapGlobals: (uri) => ({
    EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
    EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
    EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
  }),
};

export const TASK_STUDIO_VIEW_TYPE = surface.viewType;
export type TaskStudioPanelState = StudioPanelState<TaskPatch>;

interface WorkspaceEntry {
  ws: Workspace;
  base: StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch>;
}

export class TaskStudioPanelManager {
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  /** the task id reserved for this workspace's currently-open (or most recently opened) new-task panel. */
  private readonly pendingNewId = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnTasksChanged: (() => Workspace[]) | (() => void),
    onTasksChangedMaybe?: () => void,
  ) {
    if (onTasksChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnTasksChanged as () => Workspace[];
      this.onTasksChanged = onTasksChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onTasksChanged = getWorkspacesOrOnTasksChanged as () => void;
    }
  }

  private readonly getWorkspaces: () => Workspace[];
  private readonly onTasksChanged: () => void;

  openNew(ws: Workspace): void {
    const base = this.baseFor(ws);
    const pending = this.pendingNewId.get(ws.wsHash);
    const id = pending !== undefined && base.captureSnapshot(ws.wsHash, pending) !== undefined ? pending : mintTaskId();
    this.pendingNewId.set(ws.wsHash, id);
    base.openExisting(ws.wsHash, id);
  }

  openExisting(ws: Workspace, taskId: string): void {
    this.baseFor(ws).openExisting(ws.wsHash, taskId);
  }

  refreshAll(): void {
    for (const { base } of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const { base } of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(ws: Workspace, entityId?: string): StudioRestoreSnapshot<string, TaskPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.base.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: Workspace, snapshot: StudioRestoreSnapshot<string, TaskPatch>): void {
    this.baseFor(ws).restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: TaskStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(ws: Workspace): StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch> {
    let entry = this.workspaces.get(ws.wsHash);
    if (!entry) {
      const base = new StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch>(
        this.extensionUri,
        surface,
        new TaskStudioAdapter(ws),
        this.onTasksChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      entry = { ws, base };
      this.workspaces.set(ws.wsHash, entry);
    }
    return entry.base;
  }

  private handleDomainMessage(ws: Workspace, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type === "importImage") { void this.importImage(ws, ctx); return; }
    if (message.type === "attachImage") { this.attachImage(ws, ctx, message as Extract<TaskStudioDomainMessage, { type: "attachImage" }>); return; }
    if (message.type === "storeSketch") { this.storeSketch(ws, ctx, message as Extract<TaskStudioDomainMessage, { type: "storeSketch" }>); return; }
  }

  private async importImage(ws: Workspace, ctx: StudioDomainMessageContext): Promise<void> {
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
    if (!mediaType) { postDomainError(ctx, "Unsupported image type"); return; }
    try {
      const data = fs.readFileSync(file);
      this.storeImageAttachment(ws, ctx, data, mediaType, path.basename(file), "import");
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private attachImage(ws: Workspace, ctx: StudioDomainMessageContext, m: Extract<TaskStudioDomainMessage, { type: "attachImage" }>): void {
    try {
      const estimated = Math.floor((m.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("task image exceeds 10 MB limit");
      this.storeImageAttachment(ws, ctx, Buffer.from(stripDataPrefix(m.dataBase64), "base64"), m.mediaType, m.name, m.source);
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private storeImageAttachment(
    ws: Workspace,
    ctx: StudioDomainMessageContext,
    data: Buffer,
    mediaType: string,
    name: string | undefined,
    source: Extract<RichDocAttachment, { kind: "image" }>["source"],
  ): void {
    if (!ctx.entityId) return;
    const store = new TaskAttachmentStore(ws.workspaceRoot, ctx.entityId);
    const att = store.putImage({ data, mediaType, name, source });
    ctx.post(attachmentStoredMessage(resolveAttachmentInline(store, att)));
    if (store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES) {
      void vscode.window.showWarningMessage("Tachyon task images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.");
    }
  }

  private storeSketch(ws: Workspace, ctx: StudioDomainMessageContext, m: Extract<TaskStudioDomainMessage, { type: "storeSketch" }>): void {
    if (!ctx.entityId) return;
    try {
      const store = new TaskAttachmentStore(ws.workspaceRoot, ctx.entityId);
      const existingRead = new TaskDetailStore(ws.workspaceRoot).read(ctx.entityId);
      const existingAtt = existingRead.status === "ok" ? existingRead.detail.attachments.find((a) => a.kind === "excalidraw" && a.id === m.attachmentId) : undefined;
      const att = store.putExcalidraw({
        sceneJson: m.sceneJson,
        previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
        name: m.name,
        source: m.source,
        ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
        ...(existingAtt?.kind === "excalidraw" ? { existing: existingAtt } : {}),
      });
      ctx.post(attachmentStoredMessage(resolveAttachmentInline(store, att)));
      if (store.totalBlobBytes() > TASK_BLOB_SOFT_LIMIT_BYTES) {
        void vscode.window.showWarningMessage("Tachyon task visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.");
      }
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }
}

/** the webview -> host domain message shapes (mirrors task-studio/types.ts's TaskStudioWebviewMessage's
 *  domain members) — kept local since `onDomainMessage`'s `message` param is only typed as `{ type: string }`. */
type TaskStudioDomainMessage =
  | { type: "importImage" }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }
  | { type: "storeSketch"; attachmentId?: string; name?: string; source: "blank" | "annotate-image"; baseImageAttachmentId?: string; sceneJson: string; previewBase64: string };

function postDomainError(ctx: StudioDomainMessageContext, message: string): void {
  ctx.post(envelope({ type: "error" as const, code: "persistence/unknown", message, blocking: true }));
}

function resolveAttachmentInline(store: TaskAttachmentStore, att: RichDocAttachment) {
  const resolved = store.resolveAttachment(att);
  if (resolved.kind === "excalidraw") {
    return {
      ...resolved,
      ...(resolved.previewAvailable ? { previewUri: dataUri("image/png", fs.readFileSync(store.blobPath(resolved.previewBlobRef))) } : {}),
      ...(resolved.sceneAvailable ? { sceneJson: store.readExcalidrawScene(resolved) } : {}),
    };
  }
  return { ...resolved, ...(resolved.available ? { uri: dataUri(resolved.mediaType, fs.readFileSync(store.blobPath(resolved.blobRef))) } : {}) };
}

function dataUri(mediaType: string, data: Buffer): string {
  return `data:${mediaType};base64,${data.toString("base64")}`;
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
