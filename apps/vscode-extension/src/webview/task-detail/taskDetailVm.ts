/**
 * t-610705 (SDD 410 Phase C.1) — the Task Detail view-model builder, ported from the retired
 * TaskDetailPanel.ts's private methods (vmFor/resolveAttachmentRefs/prototypeVm/prototypeSrcdoc) so
 * Control's embedded task-detail route can build the SAME projection the standalone panel did.
 *
 * Preserves the standalone panel's tombstone contract verbatim (dueto F8, spec 335): a task that
 * disappears or becomes unparseable renders from the LAST KNOWN projection instead of an empty
 * screen — this module never decides to redirect away on a load failure, only the caller's
 * "no last-known state at all" fallback does (a bare not-found VM, same shape the original used).
 */
import type { TaskDetailProjectionV1 } from "@tachyon/engine/runtime-api/taskDetailProjection.js";
import type { WorkspaceTaskDetailTarget } from "../../shell/TaskDetailTarget.js";
import { assembleUntrustedSrcdoc } from "@tachyon/shared/webview/shared/untrustedSrcdoc.js";
import type { TaskDetailVM } from "@tachyon/webview-ui/webview/task-detail/messages";

/** Resolves `panel.webview.asWebviewUri` — injected so this module stays vscode-free. */
export type ResolveBlobUri = (localPath: string) => string;

/** dogfood round 1 (#5, spec 339) — `task.body` carries logical `attachment:<id>` refs (see
 *  docMarkdown.ts) that only Task Studio used to resolve; the detail view rendered them verbatim,
 *  and DOMPurify's URI allowlist (https:/mailto:/#) then stripped the unresolved `src` outright.
 *  Read-only: resolves against the sidecar's OWN attachment list, never writes anything. */
function resolveAttachmentRefs(
  ws: WorkspaceTaskDetailTarget,
  taskId: string,
  body: string,
  attachments: TaskDetailProjectionV1["imageAttachments"],
  resolveBlobUri: ResolveBlobUri,
): string {
  if (!body.includes("attachment:")) return body;
  let out = body;
  for (const att of attachments) {
    if (!att.available) continue;
    let uri: string;
    try {
      uri = resolveBlobUri(ws.attachmentBlobPath(taskId, att.blobRef));
    } catch {
      continue; // invalid blob ref — leave as-is (same broken-image outcome as today, not a crash)
    }
    out = out.split(`attachment:${att.id}`).join(uri);
  }
  return out;
}

function prototypeSrcdoc(ws: WorkspaceTaskDetailTarget, taskId: string, prototypeId: string): { staticSrcdoc?: string } {
  try {
    return { staticSrcdoc: assembleUntrustedSrcdoc(ws.prototypeHtml(taskId, prototypeId), { mode: "prototype-static" }) };
  } catch {
    return {};
  }
}

function prototypeVm(ws: WorkspaceTaskDetailTarget, id: string, snapshot: TaskDetailProjectionV1["prototypes"]): NonNullable<TaskDetailVM["prototypes"]> {
  return {
    ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
    readOnly: snapshot.readOnly,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    prototypes: snapshot.prototypes.map((p) => ({
      id: p.id, sha256: p.sha256, state: p.state, title: p.title, author: p.author, createdAt: p.createdAt,
      available: p.available, integrity: p.integrity,
      ...(p.needsTaskReconciliation ? { needsTaskReconciliation: true } : {}),
      ...(p.available ? prototypeSrcdoc(ws, id, p.id) : {}),
    })),
  };
}

export function buildTaskDetailVm(
  ws: WorkspaceTaskDetailTarget,
  id: string,
  detail: TaskDetailProjectionV1,
  tombstone: boolean,
  resolveBlobUri: ResolveBlobUri,
): TaskDetailVM {
  const task = detail.task;
  return {
    wsHash: ws.wsHash,
    id,
    tombstone,
    task: {
      id: task.id,
      title: task.title,
      ...(task.body !== undefined ? { body: resolveAttachmentRefs(ws, id, task.body, detail.imageAttachments, resolveBlobUri) } : {}),
      status: task.status,
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.kind !== undefined ? { kind: task.kind } : {}),
      author: task.author,
      ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
      ...(task.artifact_refs !== undefined ? { artifact_refs: task.artifact_refs } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    journal: detail.journal,
    ...(detail.attention?.length ? { attention: detail.attention } : {}),
    deps: detail.deps,
    prototypes: prototypeVm(ws, id, detail.prototypes),
  };
}

/** The bare not-found shape the standalone panel posted when there was no last-known state at all. */
export function emptyTombstoneVm(wsHash: string, taskId: string): TaskDetailVM {
  return { wsHash, id: taskId, tombstone: true, journal: [], deps: [], prototypes: { readOnly: false, prototypes: [] } };
}
