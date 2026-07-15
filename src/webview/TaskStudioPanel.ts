import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceTaskStudioTarget } from "../shell/TaskStudioTarget.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import type { StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { envelope } from "./shared/studio/protocol.js";
import { TaskStudioAdapter } from "./TaskStudioAdapter.js";
import { mintTaskId } from "../tasks/TaskStore.js";
import { attachmentStoredMessage } from "./task-studio/messages.js";
import type { TaskDetailEntity, TaskFields, TaskPatch } from "./task-studio/domain.js";
import { notify } from "../workspace/NotificationService.js";

/**
 * Task Studio's editor-only host wiring: thin over `StudioPanelManagerBase` + `TaskStudioAdapter`. One base
 * instance is keyed by the target's `wsHash`; all reads and mutations cross `WorkspaceTaskStudioTarget`, so
 * neither the panel nor adapter retains a concrete Workspace/store lifecycle.
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
  frameSrc: "self",
  bootstrapGlobals: (uri) => ({
    EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
    EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
    EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
  }),
};

export const TASK_STUDIO_VIEW_TYPE = surface.viewType;
export type TaskStudioPanelState = StudioPanelState<TaskPatch>;

interface WorkspaceEntry {
  target: WorkspaceTaskStudioTarget;
  base: StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch>;
}

export class TaskStudioPanelManager {
  private readonly workspaces = new Map<string, WorkspaceEntry>();
  /** the task id reserved for this workspace's currently-open (or most recently opened) new-task panel. */
  private readonly pendingNewId = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrOnTasksChanged: (() => WorkspaceTaskStudioTarget[]) | (() => void),
    onTasksChangedMaybe?: () => void,
  ) {
    if (onTasksChangedMaybe) {
      this.getWorkspaces = getWorkspacesOrOnTasksChanged as () => WorkspaceTaskStudioTarget[];
      this.onTasksChanged = onTasksChangedMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onTasksChanged = getWorkspacesOrOnTasksChanged as () => void;
    }
  }

  private readonly getWorkspaces: () => WorkspaceTaskStudioTarget[];
  private readonly onTasksChanged: () => void;

  openNew(target: WorkspaceTaskStudioTarget): void {
    const base = this.baseFor(target);
    const pending = this.pendingNewId.get(target.wsHash);
    const id = pending !== undefined && base.captureSnapshot(target.wsHash, pending) !== undefined ? pending : mintTaskId();
    this.pendingNewId.set(target.wsHash, id);
    base.openExisting(target.wsHash, id);
  }

  openExisting(target: WorkspaceTaskStudioTarget, taskId: string): void {
    this.baseFor(target).openExisting(target.wsHash, taskId);
  }

  refreshAll(): void {
    for (const { base } of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const { base } of this.workspaces.values()) base.dispose();
    this.workspaces.clear();
  }

  captureSnapshot(target: WorkspaceTaskStudioTarget, entityId?: string): StudioRestoreSnapshot<string, TaskPatch> | undefined {
    return this.workspaces.get(target.wsHash)?.base.captureSnapshot(target.wsHash, entityId);
  }

  restoreFromSnapshot(target: WorkspaceTaskStudioTarget, snapshot: StudioRestoreSnapshot<string, TaskPatch>): void {
    this.baseFor(target).restoreFromSnapshot(target.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: TaskStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).deserializePanel(panel, state);
  }

  private baseFor(target: WorkspaceTaskStudioTarget): StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch> {
    let entry = this.workspaces.get(target.wsHash);
    if (!entry) {
      const base = new StudioPanelManagerBase<TaskDetailEntity, TaskFields, TaskPatch>(
        this.extensionUri,
        surface,
        new TaskStudioAdapter(target),
        this.onTasksChanged,
        (ctx, message) => this.handleDomainMessage(target, ctx, message),
      );
      entry = { target, base };
      this.workspaces.set(target.wsHash, entry);
    }
    return entry.base;
  }

  private handleDomainMessage(target: WorkspaceTaskStudioTarget, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type === "importImage") { void this.importImage(target, ctx); return; }
    if (message.type === "importPrototype") { void this.importPrototype(target, ctx); return; }
    if (message.type === "attachImage") { void this.attachImage(target, ctx, message as Extract<TaskStudioDomainMessage, { type: "attachImage" }>); return; }
    if (message.type === "storeSketch") { void this.storeSketch(target, ctx, message as Extract<TaskStudioDomainMessage, { type: "storeSketch" }>); return; }
  }

  private async importPrototype(target: WorkspaceTaskStudioTarget, ctx: StudioDomainMessageContext): Promise<void> {
    if (!ctx.entityId) return;
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { HTML: ["html", "htm"] }, title: "Import static task prototype" });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size > 512 * 1024) throw new Error("prototype HTML exceeds 524288 bytes");
      const html = fs.readFileSync(file, "utf8");
      await target.importTaskStudioPrototype(ctx.entityId, { html, title: path.basename(file) });
      this.onTasksChanged();
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private async importImage(target: WorkspaceTaskStudioTarget, ctx: StudioDomainMessageContext): Promise<void> {
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
      if (!ctx.entityId) return;
      const stored = await target.putTaskStudioImage(ctx.entityId, {
        data: fs.readFileSync(file),
        mediaType,
        name: path.basename(file),
        source: "import",
      });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifyImageSoftLimit();
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private async attachImage(target: WorkspaceTaskStudioTarget, ctx: StudioDomainMessageContext, m: Extract<TaskStudioDomainMessage, { type: "attachImage" }>): Promise<void> {
    try {
      if (!ctx.entityId) return;
      const estimated = Math.floor((m.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("task image exceeds 10 MB limit");
      const stored = await target.putTaskStudioImage(ctx.entityId, {
        data: Buffer.from(stripDataPrefix(m.dataBase64), "base64"),
        mediaType: m.mediaType,
        ...(m.name !== undefined ? { name: m.name } : {}),
        source: m.source,
      });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifyImageSoftLimit();
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }

  private async storeSketch(target: WorkspaceTaskStudioTarget, ctx: StudioDomainMessageContext, m: Extract<TaskStudioDomainMessage, { type: "storeSketch" }>): Promise<void> {
    if (!ctx.entityId) return;
    try {
      const stored = await target.putTaskStudioSketch(ctx.entityId, {
        ...(m.attachmentId !== undefined ? { attachmentId: m.attachmentId } : {}),
        sceneJson: m.sceneJson,
        previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
        ...(m.name !== undefined ? { name: m.name } : {}),
        source: m.source,
        ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
      });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifySketchSoftLimit();
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }
}

/** the webview -> host domain message shapes (mirrors task-studio/types.ts's TaskStudioWebviewMessage's
 *  domain members) — kept local since `onDomainMessage`'s `message` param is only typed as `{ type: string }`. */
type TaskStudioDomainMessage =
  | { type: "importImage" }
  | { type: "importPrototype" }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }
  | { type: "storeSketch"; attachmentId?: string; name?: string; source: "blank" | "annotate-image"; baseImageAttachmentId?: string; sceneJson: string; previewBase64: string };

function postDomainError(ctx: StudioDomainMessageContext, message: string): void {
  ctx.post(envelope({ type: "error" as const, code: "persistence/unknown", message, blocking: true }));
}

function notifyImageSoftLimit(): void {
  notify("Tachyon task images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.", "warn", { prefix: false });
}

function notifySketchSoftLimit(): void {
  notify("Tachyon task visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.", "warn", { prefix: false });
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
