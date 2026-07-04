import type { ArtifactRef, TaskPriority } from "../../tasks/types.js";
import type { RichDocAttachment } from "../../richDoc/types.js";
import type { RichDocAttachmentVM, TiptapJSON } from "../rich-doc/types.js";

/**
 * spec 350 T1 — Task Studio's vscode-free entity/fields/patch shapes + the adapter's declared dirty/title
 * hooks, mirroring pipeline-studio/domain.ts's convention: both TaskStudioAdapter.ts (host) and this
 * surface's App.tsx (webview) import THIS module directly, so dirty-tracking never drifts between the two.
 *
 * `TaskDetailEntity` is the load-time snapshot the shell's `load` message carries — the same information
 * task-studio/types.ts's pre-migration `TaskStudioVM` held, minus the webview-static `assets` (excalidraw
 * script/css URIs, entity-independent — carried via the panel's `bootstrapGlobals` instead once the shell
 * supports that passthrough) and minus `mode` (owned by the shell's PanelEntry, not the entity).
 */

export interface TaskStudioDepVM {
  id: string;
  title?: string;
  missing: boolean;
}

export type TaskStudioAnchor = "load" | "reimport" | "read-only";

export interface TaskDetailEntity {
  taskId: string;
  workspaceHash: string;
  folder: string;
  title: string;
  kind?: string;
  priority?: TaskPriority;
  assignee?: string;
  deps: TaskStudioDepVM[];
  artifact_refs: ArtifactRef[];
  doc: TiptapJSON;
  attachments: RichDocAttachmentVM[];
  anchor: TaskStudioAnchor;
  anchorError?: string;
  /** CAS baseline for the next Save (the shell's `revisionOf`) — absent for a task that doesn't exist yet. */
  expectUpdatedAt?: string;
  knownAgents: string[];
}

export interface TaskFieldsDirty {
  title?: boolean;
  kind?: boolean;
  priority?: boolean;
  assignee?: boolean;
  deps?: boolean;
  artifact_refs?: boolean;
}

/** The webview's current field snapshot; doubles as `TPatch` (Pipeline's convention: the shell's `save`
 *  message carries whatever the webview last set via `patch`, verbatim — no separate serialization step). */
export interface TaskFields {
  title: string;
  kind?: string;
  priority?: TaskPriority;
  assignee?: string;
  deps: string[];
  artifact_refs: ArtifactRef[];
  doc: TiptapJSON;
  attachments: RichDocAttachment[];
  dirty: TaskFieldsDirty;
  docDirty: boolean;
  /** the CAS baseline the CLIENT last loaded/explicitly-refreshed against (edit mode only) — the client owns
   *  when this advances (never merely because a live fan-out re-post arrived while fields are dirty), so a
   *  genuine concurrent conflict still surfaces as a shell conflict instead of being masked. */
  expectUpdatedAt?: string;
}

export type TaskPatch = TaskFields;

export function computeTaskDirty(_entity: TaskDetailEntity | undefined, fields: TaskFields): boolean {
  return fields.docDirty || Object.values(fields.dirty).some(Boolean);
}

export function serializeTaskPatch(fields: TaskFields, dirty: boolean): TaskPatch | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardTaskFields(fields: TaskFields): boolean {
  return !fields.docDirty && !Object.values(fields.dirty).some(Boolean);
}

export function taskStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: TaskDetailEntity | undefined): string {
  if (mode === "new") return entity?.folder ? `New Task — ${entity.folder}` : "New Task";
  return `Task Studio — ${entity?.taskId ?? entityId ?? ""}`;
}
