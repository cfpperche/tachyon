import fs from "node:fs";
import { randomUUID } from "node:crypto";
import {
  encodePinStudioStagedPayloadV1,
  parsePinStudioStagedPayloadV1,
  type PinStudioApplyActionV1,
  type PinStudioImagePayloadV1,
  type PinStudioSketchPayloadV1,
  type PinStudioStagedPayloadV1,
} from "../runtime-api/pinStudioCommands.js";
import {
  projectPinStudio,
  type PinStudioProjectionV1,
} from "../runtime-api/pinStudioProjection.js";
import { PinAttachmentStore } from "../pins/PinAttachmentStore.js";
import type { PinStore } from "../pins/PinStore.js";
import {
  putPinStudioImage,
  putPinStudioSketch,
  savePinStudio,
} from "../pins/pinStudioService.js";
import type { PinAttachment } from "../pins/types.js";
import type { StudioSaveResult } from "../webview/shared/studio/adapter.js";
import type { PinDetailEntity, PinPatch } from "../webview/pin-studio/domain.js";
import type { PinStudioAttachmentVM } from "../webview/pin-studio/types.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface PinStudioImageInput {
  data: Buffer;
  mediaType: string;
  name?: string;
  source: "paste" | "drop" | "import";
}

export interface PinStudioSketchInput {
  attachmentId?: string;
  name?: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  sceneJson: string;
  previewData: Buffer;
}

export interface PinStudioAttachmentResult {
  attachment: PinStudioAttachmentVM;
  overSoftLimit: boolean;
}

export interface WorkspacePinStudioTarget extends WorkspacePresentationTarget {
  loadPinStudio(pinId: string | undefined): Promise<PinDetailEntity>;
  savePinStudio(pinId: string | undefined, patch: PinPatch): Promise<StudioSaveResult>;
  putPinStudioImage(input: PinStudioImageInput): Promise<PinStudioAttachmentResult>;
  putPinStudioSketch(pinId: string | undefined, input: PinStudioSketchInput): Promise<PinStudioAttachmentResult>;
  /** t-610705 (Phase D, D3) — still used by SidebarTarget.ts's pin-preview path; unrelated to the
   *  retired webview-localResourceRoots mechanism this port removes (see hydrateAttachment below). */
  attachmentBlobRoot(): string;
}

export interface LegacyPinStudioSource extends WorkspacePresentationTarget {
  readonly pinStore: PinStore;
}

/** Compatibility target until activation performs the one-time WorkspaceClient registry cutover. */
export function legacyPinStudioTarget(source: LegacyPinStudioSource): WorkspacePinStudioTarget {
  return {
    workspaceRoot: source.workspaceRoot,
    wsHash: source.wsHash,
    folderName: source.folderName,
    loadPinStudio: async (pinId) => pinId
      ? hydrateProjection(source, projectPinStudio(source.pinStore, pinId))
      : emptyEntity(source),
    savePinStudio: async (pinId, rawPatch) => {
      const payload = validatePayload("save", { schemaVersion: 1, patch: rawPatch });
      if (!("patch" in payload)) throw new Error("Pin Studio save payload has the wrong shape");
      return serviceSaveResult(savePinStudio(source.pinStore, pinId, payload.patch));
    },
    putPinStudioImage: async (input) => {
      const payload = imagePayload(input);
      const stored = putPinStudioImage(source.workspaceRoot, payload);
      return { attachment: hydrateAttachment(source.workspaceRoot, stored.attachment), overSoftLimit: stored.overSoftLimit };
    },
    putPinStudioSketch: async (pinId, input) => {
      const payload = sketchPayload(input);
      const stored = putPinStudioSketch(source.workspaceRoot, source.pinStore, pinId, payload);
      return {
        attachment: hydrateAttachment(source.workspaceRoot, stored.attachment, false),
        overSoftLimit: stored.overSoftLimit,
      };
    },
    attachmentBlobRoot: () => new PinAttachmentStore(source.workspaceRoot).blobDir,
  };
}

export function workspacePinStudioTarget(client: WorkspaceClient): WorkspacePinStudioTarget {
  const identity = workspacePresentationTarget(client);
  const apply = async (
    action: PinStudioApplyActionV1,
    payload: PinStudioStagedPayloadV1,
    pinId?: string,
  ) => {
    const staged = client.stagePayload(encodePinStudioStagedPayloadV1(payload));
    try {
      const result = await client.invoke(`pin-studio:${randomUUID()}`, {
        schemaVersion: 1,
        method: "pin.studio.apply",
        input: { action, ...(pinId !== undefined ? { pinId } : {}), payload: staged.ref },
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "pin.studio.apply" || result.action !== action) {
        throw new Error("persistent engine returned a mismatched Pin Studio result");
      }
      return result;
    } finally {
      staged.discard();
    }
  };
  return {
    ...identity,
    loadPinStudio: async (pinId) => {
      if (!pinId) return emptyEntity(identity);
      const result = await client.query({ schemaVersion: 1, method: "pin.studio", input: { id: pinId } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "pin.studio") throw new Error("Pin Studio query returned the wrong view");
      return hydrateProjection(identity, result.view.studio);
    },
    savePinStudio: async (pinId, rawPatch) => {
      const payload = validatePayload("save", { schemaVersion: 1, patch: rawPatch });
      const result = await apply("save", payload, pinId);
      if (result.outcome !== "saved") throw new Error("persistent engine returned a non-save Pin Studio outcome");
      if (pinId !== undefined && result.pinId !== pinId) throw new Error("persistent engine changed the saved Pin identity");
      return { status: "ok" };
    },
    putPinStudioImage: async (input) => {
      const result = await apply("put-image", imagePayload(input));
      if (result.outcome !== "attachment-stored" || result.attachment?.kind !== "image") {
        throw new Error("persistent engine returned a non-image Pin Studio outcome");
      }
      return {
        attachment: hydrateAttachment(identity.workspaceRoot, result.attachment),
        overSoftLimit: result.overSoftLimit!,
      };
    },
    putPinStudioSketch: async (pinId, input) => {
      const result = await apply("put-sketch", sketchPayload(input), pinId);
      if (result.outcome !== "attachment-stored" || result.attachment?.kind !== "excalidraw") {
        throw new Error("persistent engine returned a non-sketch Pin Studio outcome");
      }
      return {
        attachment: hydrateAttachment(identity.workspaceRoot, result.attachment, false),
        overSoftLimit: result.overSoftLimit!,
      };
    },
    attachmentBlobRoot: () => new PinAttachmentStore(identity.workspaceRoot).blobDir,
  };
}

function hydrateProjection(
  identity: WorkspacePresentationTarget,
  projection: PinStudioProjectionV1,
): PinDetailEntity {
  return {
    workspaceHash: identity.wsHash,
    folder: identity.folderName,
    pinId: projection.pinId,
    title: projection.title,
    tags: projection.tags,
    doc: projection.doc,
    attachments: projection.attachments.map((attachment) => hydrateAttachment(identity.workspaceRoot, attachment)),
    expectUpdatedAt: projection.expectUpdatedAt,
  };
}

/** t-610705 (Phase D, D3) — ported from TaskStudioTarget.ts's D2 fix: a Control-hosted studio route
 *  was never handed a live `webview.asWebviewUri` (the retired studioHost.ts called
 *  `adapter.load(entityId)` with no StudioLoadContext). The OLD standalone-panel
 *  `context?.asWebviewUri(...) ?? store.blobPath(...)` fallback would silently leak a bare
 *  filesystem path as `uri` on that path (unusable by the webview, no scheme, no local-resource-root
 *  grant). Embedding the bytes as a `data:` URI instead needs no per-route `localResourceRoots`
 *  grant at all — this is what D2's `imgBlob`/`connectSrc`/`workerSrc:"blob"` CSP grants
 *  (Cockpit.ts) exist to support client-side.
 */
function hydrateAttachment(
  workspaceRoot: string,
  attachment: PinAttachment,
  includeSketchScene = true,
): PinStudioAttachmentVM {
  const store = new PinAttachmentStore(workspaceRoot);
  const resolved = store.resolveAttachment(attachment);
  if (resolved.kind === "image") {
    let uri: string | undefined;
    if (resolved.available) {
      try { uri = dataUri(resolved.mediaType, fs.readFileSync(store.blobPath(resolved.blobRef))); } catch { /* stale blob */ }
    }
    return { ...resolved, ...(uri ? { uri } : {}) };
  }
  let previewUri: string | undefined;
  let sceneJson: string | undefined;
  if (resolved.previewAvailable) {
    try { previewUri = dataUri("image/png", fs.readFileSync(store.blobPath(resolved.previewBlobRef))); } catch { /* stale blob */ }
  }
  if (includeSketchScene && resolved.sceneAvailable) {
    try { sceneJson = store.readExcalidrawScene(resolved); } catch { /* stale or corrupt scene */ }
  }
  return { ...resolved, ...(previewUri ? { previewUri } : {}), ...(sceneJson ? { sceneJson } : {}) };
}

function dataUri(mediaType: string, data: Buffer): string {
  return `data:${mediaType};base64,${data.toString("base64")}`;
}

function imagePayload(input: PinStudioImageInput): PinStudioImagePayloadV1 {
  const value = validatePayload("put-image", {
    schemaVersion: 1,
    mediaType: input.mediaType,
    ...(input.name !== undefined ? { name: input.name } : {}),
    source: input.source,
    dataBase64: input.data.toString("base64"),
  });
  if (!("dataBase64" in value) || !("mediaType" in value)) throw new Error("Pin Studio image payload has the wrong shape");
  return value;
}

function sketchPayload(input: PinStudioSketchInput): PinStudioSketchPayloadV1 {
  const value = validatePayload("put-sketch", {
    schemaVersion: 1,
    ...(input.attachmentId !== undefined ? { attachmentId: input.attachmentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    source: input.source,
    ...(input.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: input.baseImageAttachmentId } : {}),
    sceneJson: input.sceneJson,
    previewBase64: input.previewData.toString("base64"),
  });
  if (!("sceneJson" in value)) throw new Error("Pin Studio sketch payload has the wrong shape");
  return value;
}

function validatePayload(action: PinStudioApplyActionV1, value: unknown): PinStudioStagedPayloadV1 {
  return parsePinStudioStagedPayloadV1(action, Buffer.from(JSON.stringify(value), "utf8"));
}

function serviceSaveResult(result: ReturnType<typeof savePinStudio>): StudioSaveResult {
  if (result.status === "ok") return { status: "ok" };
  if (result.status === "conflict") {
    return { status: "conflict", error: { code: "pin/conflict", message: result.message } };
  }
  return { status: "error", error: { code: "pin/save-failed", message: result.message, source: "persistence" } };
}

function emptyEntity(identity: WorkspacePresentationTarget): PinDetailEntity {
  return {
    workspaceHash: identity.wsHash,
    folder: identity.folderName,
    title: "",
    tags: [],
    doc: null,
    attachments: [],
  };
}
