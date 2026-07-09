import fs from "node:fs";
import type { Workspace } from "../workspace/Workspace.js";
import { TaskAttachmentStore } from "../tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody, type TaskDetail } from "../tasks/TaskDetailStore.js";
import { decideAnchor, composeDirtyPatch, isEmptyPatch } from "../tasks/studioModel.js";
import { docToMarkdown } from "../tasks/docMarkdown.js";
import { markdownToDoc } from "../tasks/markdownDoc.js";
import { mintTaskId } from "../tasks/TaskStore.js";
import type { Task } from "../tasks/types.js";
import { EMPTY_DOC } from "./rich-doc/document.js";
import type { RichDocAttachmentVM } from "./rich-doc/types.js";
import type { RichDocAttachment, ResolvedRichDocAttachment } from "../richDoc/types.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  computeTaskDirty,
  serializeTaskPatch,
  canDiscardTaskFields,
  taskStudioTitleFor,
  type TaskDetailEntity,
  type TaskFields,
  type TaskPatch,
  type TaskStudioDepVM,
} from "./task-studio/domain.js";
import { NO_VALIDATION_ERRORS } from "./shared/studio/errorTaxonomy.js";
import { TaskPrototypeStore } from "../tasks/TaskPrototypeStore.js";
import { assembleUntrustedSrcdoc } from "./shared/untrustedSrcdoc.js";
import type { StudioValidationResult } from "./shared/studio/errorTaxonomy.js";

/** the webview -> host domain messages (native picker + infer/suggest round trips, per the shell's adapter
 *  surface budget) plus the one host -> webview reply; all ride the protocol's registered extension slot. */
export const TASK_STUDIO_DOMAIN_MESSAGE_NAMES = ["importImage", "importPrototype", "attachImage", "storeSketch", "attachmentStored"] as const;

/**
 * spec 350 T1 — TaskStudioAdapter: the StudioHostAdapter<TaskDetailEntity,TaskFields,TaskPatch> WRAPPING
 * TaskDetailStore/TaskAttachmentStore/TaskStore (the 339 storage contract — no store changes, this is a pure
 * consumer). One instance per workspace (mirrors createPipelineStudioAdapter's per-store factory shape).
 *
 * Attachment URIs are inlined as `data:` URIs read straight off disk (base64), not `panel.webview.
 * asWebviewUri` — `StudioHostAdapter.load` has no webview/panel handle to begin with (adapter surface
 * budget: persistence hooks never reach into panel construction), and `data:` is already unconditionally
 * allowed by the shell's base CSP (`shared/shell.ts`'s `img-src ... data:`), so this needs no shell change.
 * This is a wire-format substitution (a plumbing change), not a behavioral one — the same bytes render.
 *
 * "new" mode: the real panel (T2) is expected to pre-mint a task id at open time (`mintTaskId()`) and route
 * through the base's `openExisting(wsKey, mintedId)` rather than `openNew(wsKey)` — exactly like 339's
 * `TaskStudioPanelManager.openNew` did — so the id (and its attachment namespace) stays stable across the
 * whole edit session. `load()` treats "an id with no task behind it yet" as the staged-create case, and
 * `save()` mirrors that same staged-create-vs-CAS-update branch. `entityId === undefined` is handled
 * defensively (the interface contract requires it) but isn't the code path production wiring exercises.
 */
export class TaskStudioAdapter implements StudioHostAdapter<TaskDetailEntity, TaskFields, TaskPatch> {
  entityType = "task";
  domainMessageNames = TASK_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "cas" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeTaskDirty, serializePatch: serializeTaskPatch, canDiscard: canDiscardTaskFields };

  constructor(private readonly ws: Workspace) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: TaskDetailEntity | undefined): string {
    return taskStudioTitleFor(mode, entityId, entity);
  }

  revisionOf(entity: TaskDetailEntity): string {
    return entity.expectUpdatedAt ?? "";
  }

  validate(_fields: TaskFields): StudioValidationResult {
    // 339 never client-side-gated Save on field content (an empty title surfaces as a persistence-time
    // error, caught and shown same as any other store failure) — preserving that exactly means no proactive
    // blocking validation here; `save()`'s try/catch is where a bad title actually fails, same as before.
    return NO_VALIDATION_ERRORS;
  }

  load(entityId: string | undefined): StudioLoadResult<TaskDetailEntity> {
    const knownAgents = Object.keys(this.ws.config?.agents ?? {});
    if (entityId === undefined) {
      return { status: "ok", entity: emptyTaskEntity(this.ws, knownAgents) };
    }
    let task: Task;
    try {
      task = this.ws.taskStore.get(entityId);
    } catch {
      // the pre-minted id for a staged "new" task — nothing persisted under it yet.
      return { status: "ok", entity: emptyTaskEntity(this.ws, knownAgents, entityId) };
    }

    const detailStore = new TaskDetailStore(this.ws.workspaceRoot);
    const read = detailStore.read(entityId);
    const decision = decideAnchor(task, read);
    let doc = EMPTY_DOC;
    let attachments: RichDocAttachmentVM[] = [];
    if (decision.action === "load" && read.status === "ok") {
      doc = read.detail.doc;
      attachments = resolveAttachmentsInline(read.detail.attachments, new TaskAttachmentStore(this.ws.workspaceRoot, entityId), detailStore, entityId);
    } else if (decision.action === "reimport") {
      doc = markdownToDoc(task.body ?? "");
    }
    const bodyBaseline = task.body ?? "";

    return {
      status: "ok",
      entity: {
        taskId: entityId,
        workspaceHash: this.ws.wsHash,
        folder: this.ws.folderName,
        title: task.title,
        ...(task.kind !== undefined ? { kind: task.kind } : {}),
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
        deps: resolveDeps(this.ws, task.deps ?? []),
        artifact_refs: task.artifact_refs ?? [],
        doc,
        attachments,
        bodyBaseline,
        anchor: decision.action,
        ...(decision.action === "read-only" ? { anchorError: decision.reason } : {}),
        expectUpdatedAt: task.updatedAt,
        knownAgents,
        prototypes: prototypeVm(this.ws.workspaceRoot, entityId),
      },
    };
  }

  async save(entityId: string | undefined, patch: TaskPatch): Promise<StudioSaveResult> {
    const id = entityId ?? mintTaskId();
    const detailStore = new TaskDetailStore(this.ws.workspaceRoot);
    // mode comes from `expectUpdatedAt`'s presence, not from checking whether a task exists under `id` —
    // exactly mirrors 339's VM shape (edit-mode load always sets `expectUpdatedAt`; new-mode never does).
    // Existence-checking here would be actively wrong: a genuine mintTaskId() collision (the case
    // TaskStore.create's own EEXIST guard exists for) would then silently fall through to an UPDATE of
    // someone else's task instead of failing loudly as a staged-create collision.
    if (patch.expectUpdatedAt === undefined) return this.saveStaged(id, patch, detailStore);
    return this.saveUpdate(id, patch, detailStore);
  }

  delete(entityId: string): void {
    new TaskDetailStore(this.ws.workspaceRoot).delete(entityId);
  }

  /** spec 350 Amendment 3 — mirrors 339's TaskStudioPanel.ts `cancel()`: a NEW-task session that never saved
   *  leaves an orphaned provisional attachment namespace behind (no task, no sidecar ever referenced it) —
   *  clean it up best-effort. An edit-mode cancel (the task already exists) never deletes anything. */
  onCancel(entityId: string | undefined): void {
    if (entityId === undefined) return;
    try {
      this.ws.taskStore.get(entityId);
      return; // a real, already-existing task — cancel never deletes its attachments
    } catch {
      /* not yet created — safe to sweep the provisional namespace */
    }
    try {
      fs.rmSync(new TaskAttachmentStore(this.ws.workspaceRoot, entityId).taskAttachmentsDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  /** staged create — mirrors 339's TaskStudioPanel.ts `save()` new-mode branch (mint -> temp sidecar ->
   *  TaskStore.create -> promote; best-effort cleanup of the provisional attachment namespace on failure). */
  private async saveStaged(id: string, patch: TaskPatch, detailStore: TaskDetailStore): Promise<StudioSaveResult> {
    try {
      await detailStore.createStaged(this.ws.taskStore, id, {
        title: patch.title,
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.artifact_refs.length ? { artifact_refs: patch.artifact_refs } : {}),
        ...(patch.deps.length ? { deps: patch.deps } : {}),
        doc: patch.doc,
        attachments: patch.attachments,
        body: docToMarkdown(patch.doc),
      });
      return { status: "ok" };
    } catch (err) {
      try {
        fs.rmSync(new TaskAttachmentStore(this.ws.workspaceRoot, id).taskAttachmentsDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return { status: "error", error: { code: "persistence/staged-create-failed", message: errorMessage(err), source: "persistence" } };
    }
  }

  /** CAS update — mirrors 339's TaskStudioPanel.ts `save()` edit-mode branch (dirty-field-only patch, doc ->
   *  markdown only when the doc itself was dirty, sidecar write + attachment GC gated on that same dirty). */
  private async saveUpdate(id: string, patch: TaskPatch, detailStore: TaskDetailStore): Promise<StudioSaveResult> {
    try {
      const previousRead = detailStore.read(id);
      const previousAttachments: RichDocAttachment[] = previousRead.status === "ok" ? previousRead.detail.attachments : [];
      const nextBody = docToMarkdown(patch.doc);
      const bodyChanged = patch.bodyBaseline === undefined ? patch.docDirty : nextBody !== patch.bodyBaseline;
      const body = bodyChanged ? nextBody : undefined;
      const composed = composeDirtyPatch(
        {
          title: patch.title,
          kind: patch.kind ?? null,
          priority: patch.priority ?? null,
          assignee: patch.assignee ?? null,
          deps: patch.deps.length ? patch.deps : null,
          artifact_refs: patch.artifact_refs.length ? patch.artifact_refs : null,
        },
        patch.dirty,
        {
          ...(body !== undefined ? { body: body.trim() ? body : null } : {}),
          ...(patch.expectUpdatedAt !== undefined ? { expectUpdatedAt: patch.expectUpdatedAt } : {}),
        },
      );
      if (isEmptyPatch(composed)) return { status: "ok" };

      let updated: Task;
      try {
        updated = await this.ws.taskStore.update(id, composed);
      } catch (err) {
        const message = errorMessage(err);
        if (message.startsWith("precondition-failed")) return { status: "conflict", error: { code: "task/precondition-failed", message } };
        throw err;
      }
      if (body !== undefined) {
        const detail: TaskDetail = { schemaVersion: 1, taskId: id, doc: patch.doc, attachments: patch.attachments, bodyHash: hashBody(body), taskUpdatedAt: updated.updatedAt };
        detailStore.write(detail);
        detailStore.gcRemovedAttachments(id, previousAttachments, patch.attachments);
      }
      return { status: "ok" };
    } catch (err) {
      return { status: "error", error: { code: "persistence/save-failed", message: errorMessage(err), source: "persistence" } };
    }
  }
}

function emptyTaskEntity(ws: Workspace, knownAgents: string[], taskId = "new"): TaskDetailEntity {
  return {
    taskId,
    workspaceHash: ws.wsHash,
    folder: ws.folderName,
    title: "",
    deps: [],
    artifact_refs: [],
    doc: EMPTY_DOC,
    attachments: [],
    anchor: "load",
    knownAgents,
    prototypes: { readOnly: false, prototypes: [] },
  };
}

function prototypeVm(workspaceRoot: string, taskId: string) {
  const store = new TaskPrototypeStore(workspaceRoot, taskId);
  const snapshot = store.read();
  return {
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    readOnly: snapshot.readOnly,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    prototypes: snapshot.prototypes.map((p) => ({
      id: p.id, sha256: p.sha256, state: p.state, title: p.title, author: p.author, createdAt: p.createdAt,
      available: p.available, integrity: p.integrity,
      ...(p.needsTaskReconciliation ? { needsTaskReconciliation: true } : {}),
      ...(p.available ? { staticSrcdoc: assembleUntrustedSrcdoc(store.readHtml(p.id), { mode: "prototype-static" }) } : {}),
    })),
  };
}

function resolveDeps(ws: Workspace, deps: string[]): TaskStudioDepVM[] {
  return deps.map((id) => {
    try {
      const dep = ws.taskStore.get(id);
      return { id, title: dep.title, missing: false };
    } catch {
      return { id, missing: true };
    }
  });
}

function resolveAttachmentsInline(attachments: RichDocAttachment[], store: TaskAttachmentStore, detailStore: TaskDetailStore, taskId: string): RichDocAttachmentVM[] {
  return detailStore.resolveAttachments(taskId, attachments).map((att: ResolvedRichDocAttachment) => {
    if (att.kind === "excalidraw") {
      let previewUri: string | undefined;
      let sceneJson: string | undefined;
      if (att.previewAvailable) {
        try {
          previewUri = dataUri("image/png", fs.readFileSync(store.blobPath(att.previewBlobRef)));
        } catch {
          /* invalid refs stay unavailable */
        }
      }
      if (att.sceneAvailable) {
        try {
          sceneJson = store.readExcalidrawScene(att);
        } catch {
          /* missing/corrupt scenes render as unavailable */
        }
      }
      return { ...att, ...(previewUri ? { previewUri } : {}), ...(sceneJson ? { sceneJson } : {}) };
    }
    let uri: string | undefined;
    if (att.available) {
      try {
        uri = dataUri(att.mediaType, fs.readFileSync(store.blobPath(att.blobRef)));
      } catch {
        /* invalid refs stay unavailable */
      }
    }
    return { ...att, ...(uri ? { uri } : {}) };
  });
}

function dataUri(mediaType: string, data: Buffer): string {
  return `data:${mediaType};base64,${data.toString("base64")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
