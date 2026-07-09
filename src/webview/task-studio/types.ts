import type { StudioConcurrencyState, StudioRestoreSnapshot } from "../shared/studio/protocol.js";
import type { RichDocAttachmentVM } from "../rich-doc/types.js";
import type { TaskDetailEntity, TaskPatch } from "./domain.js";

export type { TaskDetailEntity, TaskFields, TaskPatch, TaskStudioAnchor, TaskStudioDepVM } from "./domain.js";

/**
 * spec 339/350 T2 — the SHARED host<->webview envelope for the Task Studio view, now riding the studio
 * shell's protocol: core lifecycle (load/error/restore/patch/dirty/save/cancel) + Task Studio's two
 * registered domain round trips (importImage/attachImage/storeSketch in, attachmentStored out).
 */

/** Host -> webview messages this surface actually receives (core + its registered domain messages). */
export type TaskStudioHostMessage =
  | { type: "load"; entity: TaskDetailEntity; concurrency: StudioConcurrencyState; saveInFlight?: boolean; studioProtocolVersion: number }
  | { type: "error"; code: string; message: string; source?: "validation" | "persistence" | "transport"; blocking: boolean; studioProtocolVersion: number }
  | { type: "restore"; snapshot: StudioRestoreSnapshot<string, TaskPatch> | null; studioProtocolVersion: number }
  | { type: "attachmentStored"; attachment: RichDocAttachmentVM; studioProtocolVersion: number };

/** Webview -> host messages this surface sends. */
export type TaskStudioWebviewMessage =
  | { type: "ready"; studioProtocolVersion: number }
  | { type: "patch"; patch: TaskPatch; studioProtocolVersion: number }
  | { type: "dirty"; dirty: boolean; studioProtocolVersion: number }
  | { type: "save"; studioProtocolVersion: number }
  | { type: "cancel"; studioProtocolVersion: number }
  | { type: "importImage"; studioProtocolVersion: number }
  | { type: "importPrototype"; studioProtocolVersion: number }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string; studioProtocolVersion: number }
  | {
      type: "storeSketch";
      attachmentId?: string;
      name?: string;
      source: "blank" | "annotate-image";
      baseImageAttachmentId?: string;
      sceneJson: string;
      previewBase64: string;
      studioProtocolVersion: number;
    };
