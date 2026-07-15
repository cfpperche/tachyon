import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { WorkspacePinStudioTarget } from "../shell/PinStudioTarget.js";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioPanelState, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import { envelope, type StudioRestoreSnapshot } from "./shared/studio/protocol.js";
import { attachmentStoredMessage } from "./pin-studio/messages.js";
import { PinStudioAdapter } from "./PinStudioAdapter.js";
import type { PinDetailEntity, PinFields, PinPatch } from "./pin-studio/domain.js";
import { notify } from "../workspace/NotificationService.js";

/** Editor-only Pin Studio host. All workspace reads and mutations cross WorkspacePinStudioTarget. */
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
    const target = currentPinStudioTargets.get(wsKey);
    return target ? [vscode.Uri.file(target.attachmentBlobRoot())] : [];
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
const currentPinStudioTargets = new Map<string, WorkspacePinStudioTarget>();

interface WorkspaceEntry {
  adapter: PinStudioAdapter;
  base: StudioPanelManagerBase<PinDetailEntity, PinFields, PinPatch>;
}

export class PinStudioPanelManager {
  private readonly workspaces = new Map<string, WorkspaceEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrRefreshAll: (() => WorkspacePinStudioTarget[]) | (() => void),
    refreshAllMaybe?: () => void,
  ) {
    if (refreshAllMaybe) {
      this.getWorkspaces = getWorkspacesOrRefreshAll as () => WorkspacePinStudioTarget[];
      this.onPinsChanged = refreshAllMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.onPinsChanged = getWorkspacesOrRefreshAll as () => void;
    }
  }

  private readonly getWorkspaces: () => WorkspacePinStudioTarget[];
  private readonly onPinsChanged: () => void;

  openNew(target: WorkspacePinStudioTarget, initialTitle = ""): void {
    const entry = this.baseFor(target);
    entry.adapter.setInitialTitle(initialTitle);
    entry.base.openNew(target.wsHash);
  }

  openExisting(target: WorkspacePinStudioTarget, pinId: string): void {
    this.baseFor(target).base.openExisting(target.wsHash, pinId);
  }

  refreshAll(): void {
    for (const { base } of this.workspaces.values()) base.refreshAll();
  }

  dispose(): void {
    for (const { base } of this.workspaces.values()) base.dispose();
    for (const wsKey of this.workspaces.keys()) currentPinStudioTargets.delete(wsKey);
    this.workspaces.clear();
  }

  captureSnapshot(target: WorkspacePinStudioTarget, entityId?: string): StudioRestoreSnapshot<string, PinPatch> | undefined {
    return this.workspaces.get(target.wsHash)?.base.captureSnapshot(target.wsHash, entityId);
  }

  restoreFromSnapshot(target: WorkspacePinStudioTarget, snapshot: StudioRestoreSnapshot<string, PinPatch>): void {
    this.baseFor(target).base.restoreFromSnapshot(target.wsHash, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: PinStudioPanelState): void {
    const target = this.getWorkspaces().find((candidate) => candidate.wsHash === state.wsKey);
    if (!target) { panel.dispose(); return; }
    this.baseFor(target).base.deserializePanel(panel, state);
  }

  private baseFor(target: WorkspacePinStudioTarget): WorkspaceEntry {
    currentPinStudioTargets.set(target.wsHash, target);
    let entry = this.workspaces.get(target.wsHash);
    if (!entry) {
      const adapter = new PinStudioAdapter(target);
      const base = new StudioPanelManagerBase<PinDetailEntity, PinFields, PinPatch>(
        this.extensionUri,
        surface,
        adapter,
        this.onPinsChanged,
        (ctx, message) => this.handleDomainMessage(target, ctx, message),
      );
      entry = { adapter, base };
      this.workspaces.set(target.wsHash, entry);
    }
    return entry;
  }

  private handleDomainMessage(target: WorkspacePinStudioTarget, ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type === "importImage") { void this.importImage(target, ctx); return; }
    if (message.type === "attachImage") { void this.attachImage(target, ctx, message as Extract<PinStudioDomainMessage, { type: "attachImage" }>); return; }
    if (message.type === "storeSketch") { void this.storeSketch(target, ctx, message as Extract<PinStudioDomainMessage, { type: "storeSketch" }>); return; }
  }

  private async importImage(target: WorkspacePinStudioTarget, ctx: StudioDomainMessageContext): Promise<void> {
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
      const stored = await target.putPinStudioImage({
        data: fs.readFileSync(file),
        mediaType,
        name: path.basename(file),
        source: "import",
      }, { asWebviewUri: ctx.asWebviewUri });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifyImageSoftLimit();
    } catch (error) {
      postDomainError(ctx, error instanceof Error ? error.message : String(error));
    }
  }

  private async attachImage(
    target: WorkspacePinStudioTarget,
    ctx: StudioDomainMessageContext,
    message: Extract<PinStudioDomainMessage, { type: "attachImage" }>,
  ): Promise<void> {
    try {
      const estimated = Math.floor((message.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("pin image exceeds 10 MB limit");
      const stored = await target.putPinStudioImage({
        data: Buffer.from(stripDataPrefix(message.dataBase64), "base64"),
        mediaType: message.mediaType,
        ...(message.name !== undefined ? { name: message.name } : {}),
        source: message.source,
      }, { asWebviewUri: ctx.asWebviewUri });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifyImageSoftLimit();
    } catch (error) {
      postDomainError(ctx, error instanceof Error ? error.message : String(error));
    }
  }

  private async storeSketch(
    target: WorkspacePinStudioTarget,
    ctx: StudioDomainMessageContext,
    message: Extract<PinStudioDomainMessage, { type: "storeSketch" }>,
  ): Promise<void> {
    try {
      const stored = await target.putPinStudioSketch(ctx.entityId, {
        ...(message.attachmentId !== undefined ? { attachmentId: message.attachmentId } : {}),
        ...(message.name !== undefined ? { name: message.name } : {}),
        source: message.source,
        ...(message.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: message.baseImageAttachmentId } : {}),
        sceneJson: message.sceneJson,
        previewData: Buffer.from(stripDataPrefix(message.previewBase64), "base64"),
      }, { asWebviewUri: ctx.asWebviewUri });
      ctx.post(attachmentStoredMessage(stored.attachment));
      if (stored.overSoftLimit) notifySketchSoftLimit();
    } catch (error) {
      postDomainError(ctx, error instanceof Error ? error.message : String(error));
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

function notifyImageSoftLimit(): void {
  notify("Tachyon pin images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.", "warn", { prefix: false });
}

function notifySketchSoftLimit(): void {
  notify("Tachyon pin visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.", "warn", { prefix: false });
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
