import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import { PinAttachmentStore, PIN_BLOB_SOFT_LIMIT_BYTES, type PinAttachment, type ResolvedPinAttachment } from "../pins/PinAttachmentStore.js";
import type { PinStudioAssets, PinStudioAttachmentVM, PinStudioVM, PinStudioWebviewMessage } from "./pin-studio/types.js";
import type { TiptapJSON } from "../pins/PinStore.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  pinId?: string;
  post: () => void;
}

export class PinStudioPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly refreshAll: () => void,
  ) {}

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
      "tachyonPinStudio",
      pinId ? `Pin Studio — ${pinId}` : `New Pin — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root, blobRoot], retainContextWhenHidden: true },
    );
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const dsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "design-system.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "pin-studio.js"));
    const assets: PinStudioAssets = {
      excalidrawScriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "excalidraw.js")).toString(),
      excalidrawCssUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "excalidraw.css")).toString(),
      excalidrawAssetPath: `${panel.webview.asWebviewUri(root).toString().replace(/\/?$/, "/")}`,
    };
    panel.webview.html = html(panel.webview, codiconUri, dsUri, scriptUri, assets, ws.folderName);

    const post = (): void => {
      try {
        void panel.webview.postMessage({ type: "pinStudio", vm: this.vmFor(panel, ws, assets, pinId, initialTitle) });
      } catch (err) {
        void panel.webview.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
    void entry.panel.webview.postMessage({ type: "attachmentStored", attachment: resolved });
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
      void entry.panel.webview.postMessage({ type: "attachmentStored", attachment: resolved });
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
    void entry.panel.webview.postMessage({ type: "error", message });
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

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, dsUri: vscode.Uri, scriptUri: vscode.Uri, assets: PinStudioAssets, folder: string): string {
  const nonce = getNonce();
  const title = folder.replace(/[<>&]/g, "");
  const assetJson = JSON.stringify(assets).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src ${webview.cspSource}; worker-src blob:; child-src blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${dsUri}">
<title>Pin Studio — ${title}</title>
<style>
  body { padding: 0; background: var(--vscode-editor-background); }
  .studio { min-height: 100vh; display: flex; flex-direction: column; }
  .bar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: var(--ds-3); padding: var(--ds-3) var(--ds-4); border-bottom: 1px solid var(--ds-border); background: var(--vscode-editor-background); }
  .bar > div:first-child { min-width: 220px; flex: 1; }
  .eyebrow { color: var(--ds-muted); font-size: var(--ds-micro); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 3px; }
  .title { width: 100%; box-sizing: border-box; border: 0; outline: 0; background: transparent; color: var(--vscode-editor-foreground); font: 600 20px/1.3 var(--vscode-font-family); padding: 0; }
  .title::placeholder { color: var(--ds-muted); }
  .tag-editor { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 7px; min-height: 22px; }
  .tag-editor input { flex: 1 1 90px; min-width: 72px; max-width: 180px; border: 0; outline: 0; background: transparent; color: var(--vscode-editor-foreground); font: inherit; font-size: var(--ds-small); padding: 2px 0; }
  .tag-editor input::placeholder { color: var(--ds-muted); }
  .tag-chip { display: inline-flex; align-items: center; gap: 3px; max-width: 160px; padding: 1px 5px; border: 1px solid var(--ds-border); border-radius: var(--ds-radius); color: var(--ds-muted); background: transparent; font-size: var(--ds-small); line-height: 1.4; cursor: pointer; }
  .tag-chip:hover { color: var(--vscode-foreground); border-color: var(--ds-accent); }
  .tag-chip .codicon { font-size: 11px; }
  .actions { display: inline-flex; gap: var(--ds-2); align-items: center; }
  .ds-btn.primary { background: var(--ds-btn-bg); color: var(--ds-btn-fg); border-color: transparent; }
  .ds-btn.primary:hover { background: var(--ds-btn-hover); }
  .toolbar { display: flex; gap: 2px; align-items: center; padding: 6px var(--ds-4); border-bottom: 1px solid var(--ds-border); background: var(--vscode-editor-background); }
  .toolbar button, .slash button { border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); border-radius: var(--ds-radius); min-width: 28px; height: 26px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; }
  .toolbar button:hover, .slash button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.16)); }
  .slash { position: fixed; top: 105px; left: var(--ds-4); z-index: 5; display: grid; min-width: 210px; padding: 6px; border: 1px solid var(--ds-border); border-radius: var(--ds-radius); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
  .slash button { justify-content: flex-start; width: 100%; }
  main { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: var(--ds-4); max-width: 1180px; width: 100%; margin: 0 auto; padding: var(--ds-4); box-sizing: border-box; }
  .editor-shell { min-height: 58vh; border: 1px solid var(--ds-border); border-radius: var(--ds-radius); background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editorWidget-background)); }
  .pin-editor { min-height: 58vh; padding: 22px 24px; outline: 0; font-size: 14px; line-height: 1.55; }
  .pin-editor p { margin: 0 0 8px; }
  .pin-editor h1, .pin-editor h2, .pin-editor h3 { line-height: 1.25; margin: 14px 0 8px; }
  .pin-editor img { max-width: 100%; border-radius: var(--ds-radius); border: 1px solid var(--ds-border); display: block; margin: 10px 0; }
  .tachyon-sketch-node { margin: 12px 0; padding: 0; }
  .tachyon-sketch-node img { width: 100%; max-height: 520px; object-fit: contain; background: #fff; }
  .tachyon-sketch-missing { min-height: 120px; display: grid; place-items: center; border: 1px dashed var(--ds-border); border-radius: var(--ds-radius); color: var(--ds-muted); }
  .pin-editor pre { background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14)); padding: 8px 10px; border-radius: var(--ds-radius); overflow-x: auto; }
  .pin-editor code { font-family: var(--ds-mono); }
  .pin-editor ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  .pin-editor li[data-type="taskItem"] { display: flex; gap: 8px; }
  aside { border-left: 1px solid var(--ds-border); padding-left: var(--ds-4); min-width: 0; }
  .drop { width: 100%; display: flex; gap: 8px; align-items: center; justify-content: center; min-height: 64px; border: 1px dashed var(--ds-border); border-radius: var(--ds-radius); background: transparent; color: var(--ds-muted); cursor: pointer; }
  .drop:hover { border-color: var(--ds-accent); color: var(--vscode-foreground); }
  .att-head { margin: var(--ds-4) 0 var(--ds-2); font-size: var(--ds-small); color: var(--ds-muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
  .att { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--ds-border) 65%, transparent); }
  .att img, .missing { width: 42px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid var(--ds-border); display: grid; place-items: center; color: var(--ds-muted); }
  .att-actions { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .att-actions button { border: 1px solid var(--ds-border); border-radius: var(--ds-radius); background: transparent; color: var(--vscode-foreground); font: inherit; font-size: var(--ds-small); padding: 2px 6px; cursor: pointer; }
  .att-actions button:hover { border-color: var(--ds-accent); }
  .att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sketch-modal { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, var(--vscode-editor-background) 94%, black); display: grid; grid-template-rows: auto minmax(0, 1fr); }
  .sketch-bar { display: flex; align-items: center; gap: var(--ds-2); padding: var(--ds-3) var(--ds-4); border-bottom: 1px solid var(--ds-border); }
  .sketch-bar strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sketch-host { min-height: 0; position: relative; }
  .sketch-host > div { position: absolute; inset: 0; }
  .sketch-fail { padding: var(--ds-4); color: var(--ds-danger); }
  .err { position: fixed; left: var(--ds-4); right: var(--ds-4); bottom: var(--ds-4); padding: 8px 10px; border: 1px solid var(--ds-danger); color: var(--ds-danger); background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-radius: var(--ds-radius); box-shadow: 0 8px 24px rgba(0,0,0,.24); }
  .ds-degrade { margin-top: 20vh; }
  @media (max-width: 820px) {
    .bar { align-items: flex-start; flex-direction: column; }
    .actions { width: 100%; justify-content: flex-end; flex-wrap: wrap; }
    main { grid-template-columns: 1fr; }
    aside { border-left: 0; border-top: 1px solid var(--ds-border); padding: var(--ds-4) 0 0; }
  }
</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__tachyonPinAssets=${assetJson};window.EXCALIDRAW_ASSET_PATH=${JSON.stringify(assets.excalidrawAssetPath)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
