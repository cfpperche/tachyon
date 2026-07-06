import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { PinAttachmentStore, PIN_BLOB_SOFT_LIMIT_BYTES, type PinAttachment, type ResolvedPinAttachment } from "../pins/PinAttachmentStore.js";
import type { PinStudioAssets, PinStudioAttachmentVM, PinStudioVM, PinStudioWebviewMessage } from "./pin-studio/types.js";
import type { TiptapJSON } from "../pins/PinStore.js";
import { renderWebviewShell } from "./shared/shell.js";
import { pinStudioMessage, attachmentStoredMessage, errorMessage } from "./pin-studio/messages.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  pinId?: string;
  post: () => void;
}

export const PIN_STUDIO_VIEW_TYPE = "tachyonPinStudio";

export interface PinStudioPanelState {
  schemaVersion: 1;
  view: typeof PIN_STUDIO_VIEW_TYPE;
  wsHash: string;
  pinId?: string;
  initialTitle?: string;
}

export class PinStudioPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    getWorkspacesOrRefreshAll: (() => Workspace[]) | (() => void),
    refreshAllMaybe?: () => void,
  ) {
    if (refreshAllMaybe) {
      this.getWorkspaces = getWorkspacesOrRefreshAll as () => Workspace[];
      this.refreshAll = refreshAllMaybe;
    } else {
      this.getWorkspaces = () => [];
      this.refreshAll = getWorkspacesOrRefreshAll as () => void;
    }
  }

  private readonly getWorkspaces: () => Workspace[];
  private readonly refreshAll: () => void;

  openNew(ws: Workspace, initialTitle = ""): void {
    this.open(ws, undefined, initialTitle);
  }

  openExisting(ws: Workspace, pinId: string): void {
    this.open(ws, pinId);
  }

  private open(ws: Workspace, pinId?: string, initialTitle = ""): void {
    const key = panelKey(ws, pinId);
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const blobRoot = vscode.Uri.file(new PinAttachmentStore(ws.workspaceRoot).blobDir);
    const panel = vscode.window.createWebviewPanel(
      PIN_STUDIO_VIEW_TYPE,
      pinId ? `Pin Studio — ${pinId}` : `New Pin — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root, blobRoot], retainContextWhenHidden: true },
    );
    this.attachPanel(panel, ws, pinId, initialTitle);
  }

  deserialize(panel: vscode.WebviewPanel, state: PinStudioPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsHash);
    if (!ws) { panel.dispose(); return; }
    this.attachPanel(panel, ws, state.pinId, state.initialTitle ?? "");
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: Workspace, pinId?: string, initialTitle = ""): void {
    const key = panelKey(ws, pinId);
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const blobRoot = vscode.Uri.file(new PinAttachmentStore(ws.workspaceRoot).blobDir);
    panel.title = pinId ? `Pin Studio — ${pinId}` : `New Pin — ${ws.folderName}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [root, blobRoot] };
    panel.iconPath = panelIcon(this.extensionUri, "pinned"); // spec 282 — contextual editor-tab icon
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    const assets: PinStudioAssets = {
      excalidrawScriptUri: uri("excalidraw.js"),
      excalidrawCssUri: uri("excalidraw.css"),
      excalidrawAssetPath: `${panel.webview.asWebviewUri(root).toString().replace(/\/?$/, "/")}`,
    };
    // spec 280 — pin-studio keeps its excalidraw CSP (connect/worker/child-src) + asset bootstrap via the shell.
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Pin Studio — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("rich-doc.css"), uri("pin-studio.css")],
      bundle: uri("pin-studio.js"),
      mode: "live",
      imgBlob: true,
      connectSrc: true,
      workerSrc: "blob",
      childSrc: "blob",
      bootstrapGlobals: { __tachyonPinAssets: assets, EXCALIDRAW_ASSET_PATH: assets.excalidrawAssetPath },
      persistedState: {
        schemaVersion: 1,
        view: PIN_STUDIO_VIEW_TYPE,
        wsHash: ws.wsHash,
        ...(pinId !== undefined ? { pinId } : {}),
        ...(initialTitle ? { initialTitle } : {}),
      } satisfies PinStudioPanelState,
    });

    const post = (): void => {
      try {
        void panel.webview.postMessage(pinStudioMessage(this.vmFor(panel, ws, assets, pinId, initialTitle)));
      } catch (err) {
        void panel.webview.postMessage(errorMessage(err instanceof Error ? err.message : String(err)));
      }
    };
    const entry: PanelEntry = { panel, ws, pinId, post };
    panel.webview.onDidReceiveMessage((m: PinStudioWebviewMessage) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => { this.panels.delete(key); });
    this.panels.set(key, entry);
    post();
  }

  private vmFor(panel: vscode.WebviewPanel, ws: Workspace, assets: PinStudioAssets, pinId?: string, initialTitle = ""): PinStudioVM {
    if (!pinId) {
      return { workspaceHash: ws.wsHash, folder: ws.folderName, mode: "new", title: initialTitle, tags: [], doc: null, attachments: [], assets };
    }
    const detail = ws.pinStore.readDetail(pinId);
    return {
      workspaceHash: ws.wsHash,
      folder: ws.folderName,
      mode: "edit",
      pinId,
      title: detail.summary.text,
      tags: detail.summary.tags ?? [],
      doc: detail.doc,
      attachments: this.attachmentsForPanel(panel, ws, detail.attachments),
      assets,
    };
  }

  private attachmentsForPanel(panel: vscode.WebviewPanel, ws: Workspace, attachments: ResolvedPinAttachment[], opts: { includeSketchScene?: boolean } = {}): PinStudioAttachmentVM[] {
    const includeSketchScene = opts.includeSketchScene ?? true;
    const store = new PinAttachmentStore(ws.workspaceRoot);
    return attachments.map((att) => {
      if (att.kind === "excalidraw") {
        let previewUri: string | undefined;
        let sceneJson: string | undefined;
        if (att.previewAvailable) {
          try { previewUri = panel.webview.asWebviewUri(vscode.Uri.file(store.blobPath(att.previewBlobRef))).toString(); } catch { /* invalid refs stay unavailable */ }
        }
        if (includeSketchScene && att.sceneAvailable) {
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

  private async handleMessage(entry: PanelEntry, m: PinStudioWebviewMessage): Promise<void> {
    if (!m?.type) return;
    if (m.type === "ready") { entry.post(); return; }
    if (m.type === "cancel") { entry.panel.dispose(); return; }
    if (m.type === "importImage") { await this.importImage(entry); return; }
    if (m.type === "attachImage") { this.attachImage(entry, m); return; }
    if (m.type === "storeSketch") { this.storeSketch(entry, m); return; }
    if (m.type === "save") { this.save(entry, m); return; }
  }

  private async importImage(entry: PanelEntry): Promise<void> {
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
    if (!mediaType) { this.postError(entry, "Unsupported image type"); return; }
    try {
      const data = fs.readFileSync(file);
      this.storeImageAttachment(entry, data, mediaType, path.basename(file), "import");
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private attachImage(entry: PanelEntry, m: Extract<PinStudioWebviewMessage, { type: "attachImage" }>): void {
    try {
      const estimated = Math.floor((m.dataBase64.length * 3) / 4);
      if (estimated > 10 * 1024 * 1024 + 8) throw new Error("pin image exceeds 10 MB limit");
      this.storeImageAttachment(entry, Buffer.from(stripDataPrefix(m.dataBase64), "base64"), m.mediaType, m.name, m.source);
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private storeImageAttachment(entry: PanelEntry, data: Buffer, mediaType: string, name: string | undefined, source: Extract<PinAttachment, { kind: "image" }>["source"]): void {
    const store = new PinAttachmentStore(entry.ws.workspaceRoot);
    const att = store.putImage({ data, mediaType, name, source });
    const resolved = this.attachmentsForPanel(entry.panel, entry.ws, [store.resolveAttachment(att)])[0];
    void entry.panel.webview.postMessage(attachmentStoredMessage(resolved));
    if (store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES) {
      void vscode.window.showWarningMessage("Tachyon pin images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.");
    }
  }

  private storeSketch(entry: PanelEntry, m: Extract<PinStudioWebviewMessage, { type: "storeSketch" }>): void {
    try {
      const store = new PinAttachmentStore(entry.ws.workspaceRoot);
      const existing = entry.pinId
        ? entry.ws.pinStore.readDetail(entry.pinId).attachments.find((att) => att.kind === "excalidraw" && att.id === m.attachmentId)
        : undefined;
      const att = store.putExcalidraw({
        sceneJson: m.sceneJson,
        previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
        name: m.name,
        source: m.source,
        ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
        ...(existing?.kind === "excalidraw" ? { existing } : {}),
      });
      const resolved = this.attachmentsForPanel(entry.panel, entry.ws, [store.resolveAttachment(att)], { includeSketchScene: false })[0];
      void entry.panel.webview.postMessage(attachmentStoredMessage(resolved));
      if (store.totalBlobBytes() > PIN_BLOB_SOFT_LIMIT_BYTES) {
        void vscode.window.showWarningMessage("Tachyon pin visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.");
      }
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private save(entry: PanelEntry, m: Extract<PinStudioWebviewMessage, { type: "save" }>): void {
    try {
      const rich = !isEmptyDoc(m.doc) || m.attachments.length > 0;
      const tags = m.tags ?? [];
      if (entry.pinId) {
        if (rich) entry.ws.pinStore.saveDetail(entry.pinId, { text: m.title, tags, doc: m.doc, attachments: m.attachments });
        else entry.ws.pinStore.clearDetail(entry.pinId, m.title, new Date().toISOString(), tags);
      } else if (rich) {
        entry.ws.pinStore.createRich(m.title, "human", { tags, doc: m.doc, attachments: m.attachments });
      } else {
        entry.ws.pinStore.create(m.title, "human", { tags });
      }
      this.refreshAll();
      entry.panel.dispose();
    } catch (err) {
      this.postError(entry, err instanceof Error ? err.message : String(err));
    }
  }

  private postError(entry: PanelEntry, message: string): void {
    void entry.panel.webview.postMessage(errorMessage(message));
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function panelKey(ws: Workspace, pinId?: string): string {
  return `${ws.wsHash}:${pinId ?? "new"}`;
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

function isEmptyDoc(doc: TiptapJSON): boolean {
  const content = doc.content ?? [];
  if (content.length === 0) return true;
  if (content.length !== 1) return false;
  const only = content[0];
  return only?.type === "paragraph" && (!only.content || only.content.length === 0);
}
