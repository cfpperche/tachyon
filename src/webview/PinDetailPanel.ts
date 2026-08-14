import * as vscode from "vscode";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelState, type SectionPanelTarget } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { READY } from "@tachyon/webview-ui/webview/shared/ready";
import { pinPreviewMessage } from "@tachyon/webview-ui/webview/pin-preview/messages";
import { pinDocumentModeMessage } from "@tachyon/webview-ui/webview/pin-preview/messages";
import { PinStudioAdapter } from "./PinStudioAdapter.js";
import { decodeStudioMessage, envelope } from "@tachyon/webview-ui/webview/shared/studio/protocol";
import { mapUnknownError } from "./shared/studio/errorTaxonomy";
import { handlePinStudioDomainMessage } from "./pin-studio/pinStudioDomain.js";
import { PinDocumentEditPolicy, type PinDocumentDraft } from "./pin-preview/editPolicy.js";
import type { PinPatch } from "@tachyon/webview-ui/webview/pin-studio/domain";
import type { WorkspaceSidebarTarget } from "../shell/SidebarTarget.js";
import type { WorkspacePinStudioTarget } from "../shell/PinStudioTarget.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { confirmDocumentStudioCancel } from "./shared/studio/documentStudioCancel.js";

export const PIN_DETAIL_VIEW_TYPE = "tachyonPinPreview";
type RefreshKind = "pin";
export interface LegacyPinDetailState { schemaVersion: 1; view: typeof PIN_DETAIL_VIEW_TYPE; wsHash: string; pinId: string }

export class PinDetailPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  private readonly drafts = new Map<string, PinDocumentDraft<PinPatch>>();
  private readonly provisional = new Set<string>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly getReaders: () => WorkspaceSidebarTarget[],
    private readonly getStudios: () => WorkspacePinStudioTarget[],
    private readonly onPinsChanged: () => void,
    app: WebviewAppEntry = webviewApp("pin-preview"),
    scope?: ControlWorkspaceScope,
  ) { this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope); }

  open(project: string, pinId: string): void { this.manager.open({ project, identity: pinId }); }
  /**
   * t-883386 — a brand-new pin opens straight into edit mode, and the mode is derived rather than
   * posted.
   *
   * The version this replaces called `manager.post(…, "edit")` on the line after `manager.open()`.
   * That is a race the create case always LOST: `open` creates the panel, and the post fires before
   * the webview bundle has loaded and mounted, so the message reached no listener. The client then
   * sat in its default read mode over a pin with nothing on disk to read — a blank tab.
   *
   * `provisional` is the same fact expressed where it cannot be lost: `bind` reads it to choose the
   * policy's opening mode, and `replay` announces that mode when the client's READY actually arrives.
   */
  openCreate(project: string, pinId: string): void {
    const target = { project, identity: pinId };
    this.provisional.add(this.manager.keyFor(target));
    this.manager.open(target);
  }
  openEdit(project: string, pinId: string): void {
    const target = { project, identity: pinId };
    this.manager.open(target);
    this.manager.post(target, pinDocumentModeMessage("edit"));
  }
  refresh(): number { return this.manager.refresh("pin"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | LegacyPinDetailState): void {
    const legacy = state as Partial<LegacyPinDetailState>;
    this.manager.deserialize(panel, typeof (state as Partial<SectionPanelState>).project === "string" ? state as SectionPanelState : {
      schemaVersion: 1, view: PIN_DETAIL_VIEW_TYPE, project: legacy.wsHash ?? "", identity: legacy.pinId ?? "",
    });
  }
  get openKeys(): string[] { return this.manager.openKeys; }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    const reader = (target: SectionPanelTarget) => this.getReaders().find((row) => row.wsHash === target.project);
    const studioTarget = (target: SectionPanelTarget) => this.getStudios().find((row) => row.wsHash === target.project);
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "vscode-theme.css", "rich-doc.css", "studio-frame.css", "pin-studio.css", "pin-preview.css"],
      csp: { frameSrc: "self", imgBlob: true, connectSrc: true, workerSrc: "blob" },
      // Pin Studio renders the same shared SketchModal as Task Studio. Keep its static Excalidraw
      // bootstrap on the document host too: without these URLs the app accepts the Sketch click but
      // deliberately renders no modal (`sketch && assets`), leaving every Sketch entry point dead.
      bootstrapGlobals: (_target, uri) => ({
        EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
        EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
        EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
      }),
      title: (target) => `Pin — ${target.identity ?? ""}`,
      iconName: "eye",
      refreshKindFor: (message) => (message as { type?: unknown } | undefined)?.type === READY ? "pin" : undefined,
      bind: (session) => {
        const pinId = session.target.identity ?? "";
        let persisted = !this.provisional.has(session.key);
        const target = studioTarget(session.target);
        const studio = target ? new PinStudioAdapter(target) : undefined;
        // t-883386 — a provisional pin has no read model, so read mode would render nothing. The
        // opening mode is therefore the same fact as `persisted`, not a message that races the mount.
        const policy = new PinDocumentEditPolicy<PinPatch>(persisted ? "read" : "edit", this.drafts.get(session.key));
        const postError = (error: unknown) => {
          const mapped = mapUnknownError("transport", error);
          session.post(envelope({ type: "error", code: mapped.code, message: mapped.message, source: mapped.source, blocking: mapped.blocking }));
        };
        const sendRead = async () => {
          if (!persisted) return;
          const ws = reader(session.target);
          if (!ws) return;
          const detail = await ws.loadPinPreview(pinId, { asWebviewUri: (path) => session.asWebviewUri(path) });
          session.post(pinPreviewMessage({
            ...detail,
            body: detail.title,
            attachments: detail.attachments.map((attachment) => attachment.kind === "image" ? {
              id: attachment.id,
              kind: attachment.kind,
              name: attachment.name,
              available: attachment.available,
              ...(attachment.uri ? { uri: attachment.uri } : {}),
              detail: `${attachment.mediaType.replace(/^image\//, "").toUpperCase()} · ${Math.round(attachment.size / 1024)} KB`,
            } : {
              id: attachment.id,
              kind: attachment.kind,
              name: attachment.name,
              available: attachment.previewAvailable,
              ...(attachment.previewUri ? { previewUri: attachment.previewUri } : {}),
              detail: `Sketch · ${attachment.elementCount} element${attachment.elementCount === 1 ? "" : "s"}`,
            }),
          }));
          policy.receiveHostSnapshot();
        };
        const sendEdit = async () => {
          if (!studio) return;
          const loaded = await studio.load(persisted ? pinId : undefined);
          if (loaded.status !== "ok") { postError(new Error(loaded.error)); return; }
          session.post(envelope({ type: "load", entity: loaded.entity, concurrency: { kind: "cas", expected: studio.revisionOf(loaded.entity) } }));
          if (policy.draft.dirty && policy.draft.patch) {
            session.post(envelope({ type: "restore", snapshot: { schemaVersion: 1, entityType: "pin", mode: "edit", patch: policy.draft.patch } }));
          }
        };
        const onMessage = async (message: unknown) => {
          const action = message as { type?: string; mode?: "read" | "edit" };
          if (action.type === "setPinDocumentMode") {
            if (action.mode !== "read" && action.mode !== "edit") return;
            policy.switchMode(action.mode); session.post(pinDocumentModeMessage(action.mode));
            if (action.mode === "edit") await sendEdit();
            return;
          }
          const decoded = decodeStudioMessage<{ type: string; patch?: PinPatch; dirty?: boolean }>(message, studio?.domainMessageNames ?? []);
          if (!decoded.ok || !decoded.message || !studio || !target) return;
          const msg = decoded.message;
          if (msg.type === "ready") { await sendEdit(); return; }
          if (msg.type === "patch" && msg.patch) { policy.receivePatch(msg.patch); return; }
          if (msg.type === "dirty") { policy.receiveDirty(msg.dirty ?? false); return; }
          if (msg.type === "cancel") {
            const leaveEditMode = () => {
              policy.clearDraft();
              if (!persisted) { this.provisional.delete(session.key); session.close(); return; }
              policy.switchMode("read"); session.post(pinDocumentModeMessage("read"));
            };
            await confirmDocumentStudioCancel(policy.draft.dirty, async () => {
              if (!policy.draft.patch) return false;
              const result = await studio.save(pinId, policy.draft.patch);
              if (result.status !== "ok") { postError(new Error(result.error.message)); return false; }
              persisted = true;
              this.provisional.delete(session.key);
              policy.clearDraft(); policy.switchMode("read"); this.onPinsChanged(); session.post(pinDocumentModeMessage("read"));
              await sendRead();
              return true;
            }, leaveEditMode);
            return;
          }
          if (msg.type === "save" && policy.draft.patch) {
            const result = await studio.save(pinId, policy.draft.patch);
            if (result.status === "ok") {
              persisted = true;
              this.provisional.delete(session.key);
              policy.clearDraft(); policy.switchMode("read"); this.onPinsChanged(); session.post(pinDocumentModeMessage("read"));
              await sendRead();
            }
            else postError(new Error(result.error.message));
            return;
          }
          handlePinStudioDomainMessage(target, { entityId: pinId, post: (value) => session.post(value) }, msg);
        };
        return {
          // t-883386 — the mode is ANNOUNCED here, which is the one moment the client is provably
          // listening: `refreshKindFor` maps the client's own READY to this replay. A create opens
          // with `policy.mode === "edit"` and the client learns it from the same message that a
          // reveal-after-hide uses, so there is no separate path for the case that used to be blank.
          replay: () => { session.post(pinDocumentModeMessage(policy.mode)); void sendRead(); if (policy.mode === "edit" || policy.draft.dirty) void sendEdit(); },
          resync: () => { session.post(pinDocumentModeMessage(policy.mode)); void sendRead(); if (policy.mode === "edit" || policy.draft.dirty) void sendEdit(); },
          onMessage: (message) => { void onMessage(message); },
          dispose: () => {
            const draft = policy.close();
            if (persisted && draft) this.drafts.set(session.key, draft); else this.drafts.delete(session.key);
            this.provisional.delete(session.key);
          },
        };
      },
    };
  }
}
