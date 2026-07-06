import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { PinAttachmentStore, PIN_BLOB_SOFT_LIMIT_BYTES, type PinAttachment } from "../pins/PinAttachmentStore.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { attachmentStoredMessage } from "./pin-studio/messages.js";
import { PinStudioAdapter, type PinDetailEntity, type PinFields, type PinPatch } from "./pin-studio/domain.js";
import type { PinStudioAttachmentVM } from "./pin-studio/types.js";

/**
 * spec 350 Phase 4 — Pin Studio's host wiring now matches Task/Agent: one `StudioPanelManagerBase` per
 * workspace, a thin `PinStudioAdapter` for load/save/dirty hooks, and only three domain actions
 * (`importImage`, `attachImage`, `storeSketch`) left in this wrapper. Rich doc and visuals render through
 * `StudioFrame`'s declared `richDoc` and `previewVisual` regions; Import/Sketch are header actions.
 */
const surface: StudioSurfaceConfig = {
  viewType: "tachyonPinStudio",
  bundleFile: "pin-studio.js",
  styleFiles: ["codicon.css", "design-system.css", "rich-doc.css", "studio-frame.css", "pin-studio.css"],
  imgBlob: true,
  connectSrc: true,
  workerSrc: "blob",
  childSrc: "blob",
  iconName: "pinned",
  extraLocalResourceRoots: (wsKey) => {
    const ws = currentPinStudioWorkspaces.get(wsKey);
    return ws ? [vscode.Uri.file(new PinAttachmentStore(ws.workspaceRoot).blobDir)] : [];
  },
  bootstrapGlobals: (uri) => ({
    __tachyonPinAssets: {
      excalidrawScriptUri: uri("excalidraw.js"),
      excalidrawCssUri: uri("excalidraw.css"),
      excalidrawAssetPath: uri("").replace(/\/?$/, "/"),
    },
    EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
  }),
};

export const PIN_STUDIO_VIEW_TYPE = surface.viewType;
export type PinStudioPanelState = StudioPanelState<PinPatch>;
const currentPinStudioWorkspaces = new Map<string, Workspace>();

interface WorkspaceEntry {
  adapter: PinStudioAdapter;
  base: StudioPanelManagerBase<PinDetailEntity, PinFields, PinPatch>;
}

export class PinStudioPanelManager {
  private readonly workspaces = new Map<string, WorkspaceEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrRefreshAll: (() => Workspace[]) | (() => void),
    refreshAllMaybe?: () => void,
  ) {
    if (refreshAllMaybe) {
      this.getWorkspaces = getWorkspacesOrRefreshAll as () => Workspace[];
      this.onPinsChanged = refreshAllMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onPinsChanged = getWorkspacesOrRefreshAll as () => void;
    }
  }

  private readonly getWorkspaces: () => Workspace[];
  private readonly onPinsChanged: () => void;

  openNew(ws: Workspace, initialTitle = ""): void {
    const entry = this.baseFor(ws);
    entry.adapter.setInitialTitle(initialTitle);
    entry.base.openNew(ws.wsHash);
  }

  openExisting(ws: Workspace, pinId: string): void {
    this.baseFor(ws).base.openExisting(ws.wsHash, pinId);
  }

  refreshAll(): void {
    for (const { base } of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const { base } of this.workspaces.values()) base.dispose();
    for (const wsKey of this.workspaces.keys()) currentPinStudioWorkspaces.delete(wsKey);
    this.workspaces.clear();
  }

  captureSnapshot(ws: Workspace, entityId?: string): StudioRestoreSnapshot<string, PinPatch> | undefined {
    return this.workspaces.get(ws.wsHash)?.base.captureSnapshot(ws.wsHash, entityId);
  }

  restoreFromSnapshot(ws: Workspace, snapshot: StudioRestoreSnapshot<string, PinPatch>): void {
    this.baseFor(ws).base.restoreFromSnapshot(ws.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: PinStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsKey);
    if (!ws) { panel.dispose(); return; }
    this.baseFor(ws).base.deserializePanel(panel, state);
  }

  private baseFor(ws: Workspace): WorkspaceEntry {
    currentPinStudioWorkspaces.set(ws.wsHash, ws);
    let entry = this.workspaces.get(ws.wsHash);
    if (!entry) {
      const adapter = new PinStudioAdapter(ws);
      const base = new StudioPanelManagerBase<PinDetailEntity, PinFields, PinPatch>(
        this.extensionUri,
        surface,
        adapter,
        this.onPinsChanged,
        (ctx, message) => this.handleDomainMessage(ws, ctx, message),
      );
      entry = { adapter, base };
      this.workspaces.set(ws.wsHash, entry);
    }
    return entry;
  }

  private handleDomainMessage(ws: Workspace, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type === "importImage") { void this.importImage(ws, ctx); return; }
    if (message.type === "attachImage") { this.attachImage(ws, ctx, message as Extract<PinStudioDomainMessage, { type: "attachImage" }>); return; }
    if (message.type === "storeSketch") { this.storeSketch(ws, ctx, message as Extract<PinStudioDomainMessage, { type: "storeSketch" }>); return; }
  }

  private async importImage(ws: Workspace, ctx: StudioDomainMessageContext): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] },
      title: "Import image into pin",
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

  private attachImage(ws: Workspace, ctx: StudioDomainMessageContext, m: Extract<PinStudioDomainMessage, { type: "attachImage" }>): void {
    try {
      const estimated = Math.floor((m.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("pin image exceeds 10 MB limit");
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
    source: Extract<PinAttachment, { kind: "image" }>["source"],
  ): void {
    const store = new PinAttachmentStore(ws.workspaceRoot);
    const att = store.putImage({ data, mediaType, name, source });
    ctx.post(attachmentStoredMessage(resolveAttachmentForWebview(store, store.resolveAttachment(att), ctx)));
    if (store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES) {
      void vscode.window.showWarningMessage("Tachyon pin images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.");
    }
  }

  private storeSketch(ws: Workspace, ctx: StudioDomainMessageContext, m: Extract<PinStudioDomainMessage, { type: "storeSketch" }>): void {
    try {
      const store = new PinAttachmentStore(ws.workspaceRoot);
      const existing = ctx.entityId
        ? ws.pinStore.readDetail(ctx.entityId).attachments.find((att) => att.kind === "excalidraw" && att.id === m.attachmentId)
        : undefined;
      const att = store.putExcalidraw({
        sceneJson: m.sceneJson,
        previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
        name: m.name,
        source: m.source,
        ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
        ...(existing?.kind === "excalidraw" ? { existing } : {}),
      });
      ctx.post(attachmentStoredMessage(resolveAttachmentForWebview(store, store.resolveAttachment(att), ctx, { includeSketchScene: false })));
      if (store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES) {
        void vscode.window.showWarningMessage("Tachyon pin visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.");
      }
    } catch (err) {
      postDomainError(ctx, err instanceof Error ? err.message : String(err));
    }
  }
}

type PinStudioDomainMessage =
  | { type: "importImage" }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }
  | { type: "storeSketch"; attachmentId?: string; name?: string; source: "blank" | "annotate-image"; baseImageAttachmentId?: string; sceneJson: string; previewBase64: string };

function postDomainError(ctx: StudioDomainMessageContext, message: string): void {
  ctx.post(envelope({ type: "error" as const, code: "pin/domain-error", message, source: "persistence" as const, blocking: true }));
}

function resolveAttachmentForWebview(
  store: PinAttachmentStore,
  att: ReturnType<PinAttachmentStore["resolveAttachment"]>,
  ctx: StudioDomainMessageContext,
  opts: { includeSketchScene?: boolean } = {},
): PinStudioAttachmentVM {
  if (att.kind === "excalidraw") {
    return {
      ...att,
      ...(att.previewAvailable ? { previewUri: ctx.asWebviewUri(store.blobPath(att.previewBlobRef)) } : {}),
      ...(opts.includeSketchScene !== false && att.sceneAvailable ? { sceneJson: store.readExcalidrawScene(att) } : {}),
    };
  }
  return {
    ...att,
    ...(att.available ? { uri: ctx.asWebviewUri(store.blobPath(att.blobRef)) } : {}),
  };
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
