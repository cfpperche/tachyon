import * as vscode from "vscode";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelState, type SectionPanelTarget } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { READY } from "./shared/ready.js";
import { pinPreviewMessage } from "./pin-preview/messages.js";
import { pinDocumentModeMessage } from "./pin-preview/messages.js";
import { PinStudioAdapter } from "./PinStudioAdapter.js";
import { decodeStudioMessage, envelope } from "./shared/studio/protocol.js";
import { mapUnknownError } from "./shared/studio/errorTaxonomy.js";
import { handlePinStudioDomainMessage } from "../cockpit/pinStudioDomain.js";
import { PinDocumentEditPolicy, type PinDocumentDraft } from "./pin-preview/editPolicy.js";
import type { PinPatch } from "./pin-studio/domain.js";
import type { WorkspaceSidebarTarget } from "../shell/SidebarTarget.js";
import type { WorkspacePinStudioTarget } from "../shell/PinStudioTarget.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";

export const PIN_DETAIL_VIEW_TYPE = "tachyonPinPreview";
type RefreshKind = "pin";
export interface LegacyPinDetailState { schemaVersion: 1; view: typeof PIN_DETAIL_VIEW_TYPE; wsHash: string; pinId: string }

export class PinDetailPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  private readonly drafts = new Map<string, PinDocumentDraft<PinPatch>>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly getReaders: () => WorkspaceSidebarTarget[],
    private readonly getStudios: () => WorkspacePinStudioTarget[],
    private readonly onPinsChanged: () => void,
    app: WebviewAppEntry = webviewApp("pin-preview"),
    scope?: ControlWorkspaceScope,
  ) { this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope); }

  open(project: string, pinId: string): void { this.manager.open({ project, identity: pinId }); }
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
      styleFiles: ["codicon.css", "design-system.css", "vscode-theme.css", "rich-doc.css", "studio-frame.css", "pin-studio.css", "pin-preview.css"],
      csp: { frameSrc: "self", imgBlob: true, connectSrc: true, workerSrc: "blob" },
      title: (target) => `Pin — ${target.identity ?? ""}`,
      iconName: "eye",
      refreshKindFor: (message) => (message as { type?: unknown } | undefined)?.type === READY ? "pin" : undefined,
      bind: (session) => {
        const pinId = session.target.identity ?? "";
        const target = studioTarget(session.target);
        const studio = target ? new PinStudioAdapter(target) : undefined;
        const policy = new PinDocumentEditPolicy<PinPatch>("read", this.drafts.get(session.key));
        const postError = (error: unknown) => {
          const mapped = mapUnknownError("transport", error);
          session.post(envelope({ type: "error", code: mapped.code, message: mapped.message, source: mapped.source, blocking: mapped.blocking }));
        };
        const sendRead = async () => {
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
          const loaded = await studio.load(pinId);
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
          if (msg.type === "cancel") { policy.clearDraft(); policy.switchMode("read"); session.post(pinDocumentModeMessage("read")); return; }
          if (msg.type === "save" && policy.draft.patch) {
            const result = await studio.save(pinId, policy.draft.patch);
            if (result.status === "ok") { policy.clearDraft(); policy.switchMode("read"); this.onPinsChanged(); session.post(pinDocumentModeMessage("read")); }
            else postError(new Error(result.error.message));
            return;
          }
          handlePinStudioDomainMessage(target, { entityId: pinId, post: (value) => session.post(value) }, msg);
        };
        return {
          replay: () => { void sendRead(); if (policy.mode === "edit" || policy.draft.dirty) void sendEdit(); },
          resync: () => { void sendRead(); if (policy.mode === "edit" || policy.draft.dirty) void sendEdit(); },
          onMessage: (message) => { void onMessage(message); },
          dispose: () => { const draft = policy.close(); if (draft) this.drafts.set(session.key, draft); else this.drafts.delete(session.key); },
        };
      },
    };
  }
}
