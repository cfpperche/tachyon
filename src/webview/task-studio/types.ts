import type { ArtifactRef, TaskPriority } from "../../tasks/types.js";
import type { RichDocAttachment } from "../../richDoc/types.js";
import type { RichDocAssets, RichDocAttachmentVM, TiptapJSON } from "../rich-doc/types.js";

export interface TaskStudioDepVM {
  id: string;
  title?: string;
  missing: boolean;
}

export type TaskStudioAnchor = "load" | "reimport" | "read-only";

export interface TaskStudioVM {
  workspaceHash: string;
  folder: string;
  mode: "new" | "edit";
  /** the real task id in edit mode; the provisional (pre-reserved) id in new mode. */
  taskId: string;
  title: string;
  kind?: string;
  priority?: TaskPriority;
  /** edit mode only — 325's mutability table forbids setting assignee on a brand-new (inbox) task. */
  assignee?: string;
  deps: TaskStudioDepVM[];
  artifact_refs: ArtifactRef[];
  doc: TiptapJSON;
  attachments: RichDocAttachmentVM[];
  assets: RichDocAssets;
  /** the body-hash anchoring decision (studioModel.decideAnchor) — "new" mode is always "load" (empty doc). */
  anchor: TaskStudioAnchor;
  anchorError?: string;
  /** CAS baseline for the next Save; refreshed on every re-post. Absent in "new" mode (no task yet). */
  expectUpdatedAt?: string;
  /** known agent names for the assignee field's hint affordance (datalist). */
  knownAgents: string[];
}

export type TaskStudioSaveDirty = {
  title?: boolean;
  kind?: boolean;
  priority?: boolean;
  assignee?: boolean;
  deps?: boolean;
  artifact_refs?: boolean;
};

export type TaskStudioHostMessage =
  | { type: "taskStudio"; vm: TaskStudioVM }
  | { type: "attachmentStored"; attachment: RichDocAttachmentVM }
  | { type: "error"; message: string }
  | { type: "saveConflict"; message: string };

export type TaskStudioWebviewMessage =
  | { type: "ready" }
  | { type: "cancel" }
  | { type: "importImage" }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop"; dataBase64: string }
  | {
      type: "storeSketch";
      attachmentId?: string;
      name?: string;
      source: "blank" | "annotate-image";
      baseImageAttachmentId?: string;
      sceneJson: string;
      previewBase64: string;
    }
  | {
      type: "save";
      title: string;
      kind?: string;
      priority?: TaskPriority;
      assignee?: string;
      deps: string[];
      artifact_refs: ArtifactRef[];
      doc: TiptapJSON;
      attachments: RichDocAttachment[];
      dirty: TaskStudioSaveDirty;
      docDirty: boolean;
      /** the CAS baseline the CLIENT last loaded/explicitly-refreshed against (edit mode only) — the client
       *  owns when this advances (never merely because a live fan-out re-post arrived while fields are dirty),
       *  so a genuine concurrent conflict still surfaces as `precondition-failed` instead of being masked. */
      expectUpdatedAt?: string;
    }
  | { type: "reloadLatest" };
