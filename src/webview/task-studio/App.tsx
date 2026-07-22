import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import { Button } from "../shared/ui";
import { KitFieldRow, KitLabeledInput, KitSelect } from "../shared/ui/kit";
import { StudioFrame } from "../shared/studio/StudioFrame";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import { createRichDocEditor } from "../rich-doc/tiptap";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "../rich-doc/document";
import { EditorToolbar, SlashMenu } from "../rich-doc/toolbar";
import { SketchModal, VisualsPanel, uriToDataURL, type RichDocExcalidrawSaveResult, type SketchRequest } from "../rich-doc/VisualsPanel";
import { createTaskStudioAdapter } from "../rich-doc/adapter";
import type { RichDocAssets, RichDocAttachmentVM } from "../rich-doc/types";
import type { ArtifactRef, TaskPriority } from "../../tasks/types";
import { TASK_ID_RE } from "../../tasks/types";
import { computeTaskDirty, taskStudioTitleFor, TASK_STUDIO_HOST_MESSAGE_NAMES, type TaskDetailEntity, type TaskFields, type TaskFieldsDirty } from "./domain";
import {
  attachImageMessage,
  cancelMessage,
  dirtyMessage,
  importImageMessage,
  importPrototypeMessage,
  patchMessage,
  readyMessage,
  saveMessage,
  storeSketchMessage,
} from "./messages";
import type { TaskStudioHostMessage } from "./types";
import { PrototypePreview } from "../shared/PrototypePreview";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;
const PRIORITIES: TaskPriority[] = [0, 1, 2, 3];
// spec 342 Pilot B — Radix Select (unlike a native <select>) rejects an empty-string item value, so the
// "no priority set" state needs a real sentinel to stay selectable from the dropdown (not just an unset
// placeholder — the legacy <select> let you pick back to "none" any time, and KitSelect must too).
const NO_PRIORITY = "none";
const PRIORITY_OPTIONS = [{ value: NO_PRIORITY, label: "none" }, ...PRIORITIES.map((p) => ({ value: String(p), label: `P${p}` }))];
const MAX_ARTIFACT_REFS = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// spec F16 — same accepted-type allowlist pin-studio's App.tsx enforces before ever posting a paste/drop to
// the host (SVG is deliberately excluded: an SVG can carry executable script, unlike a raster image).
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const adapter = createTaskStudioAdapter();

interface FieldValues {
  title: string;
  kind: string;
  priority?: TaskPriority;
  assignee: string;
  deps: string[];
  artifact_refs: ArtifactRef[];
}

function fieldsFromEntity(entity: TaskDetailEntity): FieldValues {
  return {
    title: entity.title,
    kind: entity.kind ?? "",
    priority: entity.priority,
    assignee: entity.assignee ?? "",
    deps: entity.deps.map((d) => d.id),
    artifact_refs: entity.artifact_refs,
  };
}

function blankFieldValues(): FieldValues {
  return { title: "", kind: "", priority: undefined, assignee: "", deps: [], artifact_refs: [] };
}

/** spec 350 T3 — the Excalidraw asset locations, injected as `window.*` globals by the panel's
 *  `bootstrapGlobals` (Amendment 2) rather than riding the entity payload — they're webview-static, not
 *  per-task, so they don't belong on `TaskDetailEntity`. */
function readAssets(): RichDocAssets | undefined {
  const w = window as unknown as { EXCALIDRAW_SCRIPT_URI?: string; EXCALIDRAW_CSS_URI?: string; EXCALIDRAW_ASSET_PATH?: string };
  if (!w.EXCALIDRAW_SCRIPT_URI || !w.EXCALIDRAW_CSS_URI || !w.EXCALIDRAW_ASSET_PATH) return undefined;
  return { excalidrawScriptUri: w.EXCALIDRAW_SCRIPT_URI, excalidrawCssUri: w.EXCALIDRAW_CSS_URI, excalidrawAssetPath: w.EXCALIDRAW_ASSET_PATH };
}

/**
 * t-610705 (SDD 410 Phase D, D2) — Control-hosted now: props-driven, same split as every other
 * migrated studio (command-studio-shell/App.tsx's doc comment has the full rationale for
 * routeKey/mountNonce/useStudioFreeze/eager ref updates). Ported from the standalone
 * task-studio/main.tsx's `Root` component (retired), which used to decode the raw postMessage
 * envelope itself and hand this component already-parsed props — that decoding now happens HERE,
 * inline, against the shared studio protocol (types.ts's TaskStudioHostMessage is already the
 * shared-protocol shape; only this component's prop contract predated the migration).
 *
 * Task Studio is the first Control-hosted studio with `concurrency.kind === "cas"`
 * (TaskStudioAdapter.ts) — the OTHER five migrated studios all pass `concurrencyStale: false` to
 * StudioFrame/dirtyGating because they never stale. Rather than wire StudioFrame's generic (and, as
 * of D2, still unexercised) `concurrencyStale`/`onReload` banner, this keeps Task Studio's own
 * richer pre-existing conflict UX (Reload latest / Export local draft) exactly as the standalone
 * panel had it — sourced from the `task/precondition-failed` error code, same as before.
 */
export interface TaskStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
}

export function App({ dispatch, routeKey, mountNonce, incoming }: TaskStudioAppProps) {
  const mount = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const attachmentsRef = useRef<RichDocAttachmentVM[]>([]);
  const pendingSketch = useRef<SketchRequest | null>(null);
  const pendingSketchScenes = useRef(new Map<string, string>());
  const originalRef = useRef<FieldValues | null>(null);
  const depTitlesRef = useRef<Record<string, string | undefined>>({});
  const entityRef = useRef<TaskDetailEntity | undefined>(undefined);
  const hasLoadedRef = useRef(false);
  const editRevisionRef = useRef(0);
  const dirtyRef = useRef(false);

  const [entity, setEntity] = useState<TaskDetailEntity | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [hostConflict, setHostConflict] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState<TaskPriority | undefined>(undefined);
  const [assignee, setAssignee] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [depInput, setDepInput] = useState("");
  const [artifactRefs, setArtifactRefs] = useState<ArtifactRef[]>([]);
  const [artifactInput, setArtifactInput] = useState("");
  const [dirty, setDirty] = useState<TaskFieldsDirty>({});
  const [docDirty, setDocDirty] = useState(false);
  const [expectUpdatedAt, setExpectUpdatedAt] = useState<string | undefined>(undefined);
  const [attachments, setAttachments] = useState<RichDocAttachmentVM[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [freshFields, setFreshFields] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [sketch, setSketch] = useState<SketchRequest | null>(null);

  const isNew = entity !== undefined && entity.expectUpdatedAt === undefined;

  const post = (msg: object): void => dispatch.post({ ...msg, routeKey, mountNonce });

  const markDirty = (field: keyof TaskFieldsDirty) => setDirty((d) => (d[field] ? d : { ...d, [field]: true }));

  const currentStoredDoc = () => toStoredDoc((editorRef.current?.getJSON() ?? { type: "doc", content: [] }) as never);
  const currentFields = (): TaskFields => {
    const doc = currentStoredDoc();
    return {
      title,
      ...(kind.trim() ? { kind: kind.trim() } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(!isNew && assignee.trim() ? { assignee: assignee.trim() } : {}),
      deps,
      artifact_refs: artifactRefs,
      doc,
      attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM),
      ...(entityRef.current?.bodyBaseline !== undefined ? { bodyBaseline: entityRef.current.bodyBaseline } : {}),
      dirty,
      docDirty,
      ...(expectUpdatedAt !== undefined ? { expectUpdatedAt } : {}),
    };
  };

  const dirtyComputed = computeTaskDirty(entity, currentFields());
  dirtyRef.current = dirtyComputed;

  const { frozen, saving: saveInFlight, frozenRef, freezeForSave } = useStudioFreeze({
    post: dispatch.post,
    getSnapshot: () => ({ dirty: dirtyRef.current, editRevision: editRevisionRef.current, patch: currentFields() }),
  });

  const resetEditorFrom = (loadedEntity: TaskDetailEntity) => {
    const fields = fieldsFromEntity(loadedEntity);
    originalRef.current = fields;
    depTitlesRef.current = Object.fromEntries(loadedEntity.deps.map((d) => [d.id, d.title]));
    setTitle(fields.title);
    setKind(fields.kind);
    setPriority(fields.priority);
    setAssignee(fields.assignee);
    setDeps(fields.deps);
    setDepInput("");
    setArtifactRefs(fields.artifact_refs);
    setArtifactInput("");
    setDirty({});
    setDocDirty(false);
    setExpectUpdatedAt(loadedEntity.expectUpdatedAt);
    attachmentsRef.current = loadedEntity.attachments;
    setAttachments(loadedEntity.attachments);
    setError(undefined);
    setFreshFields([]);
    if (mount.current) {
      editorRef.current?.destroy();
      editorRef.current = createRichDocEditor(
        mount.current,
        toEditorDoc(loadedEntity.doc, loadedEntity.attachments),
        (file, source) => void attachFile(file, source),
        () => setSlashOpen(true),
        () => setDocDirty(true),
      );
    }
    setDocVersion((v) => v + 1);
  };

  // Re-handshake whenever the binding identity changes (fresh mount OR a same-route re-entry the
  // host rebound) — resets ALL local state so a stale entity never lingers across bindings, same
  // pattern as every other migrated studio.
  useEffect(() => {
    hasLoadedRef.current = false;
    entityRef.current = undefined;
    setEntity(undefined);
    editorRef.current?.destroy();
    editorRef.current = null;
    attachmentsRef.current = [];
    originalRef.current = null;
    depTitlesRef.current = {};
    pendingSketch.current = null;
    pendingSketchScenes.current.clear();
    const blank = blankFieldValues();
    setTitle(blank.title);
    setKind(blank.kind);
    setPriority(blank.priority);
    setAssignee(blank.assignee);
    setDeps(blank.deps);
    setDepInput("");
    setArtifactRefs(blank.artifact_refs);
    setArtifactInput("");
    setDirty({});
    setDocDirty(false);
    setExpectUpdatedAt(undefined);
    setAttachments([]);
    setDocVersion(0);
    setError(undefined);
    setFreshFields([]);
    setSlashOpen(false);
    setSketch(null);
    setLoadFailed(false);
    setHostError(undefined);
    setHostConflict(undefined);
    setReady(false);
    dispatch.post(readyMessage({ routeKey, mountNonce }));
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, mountNonce]);

  useEffect(() => {
    if (!incoming) return;
    const decoded = decodeStudioMessage<TaskStudioHostMessage>(incoming.message, TASK_STUDIO_HOST_MESSAGE_NAMES);
    if (!decoded.ok || !decoded.message) {
      setHostError({
        code: "transport/protocol",
        message: `studio protocol: ${decoded.reason ?? "undecodable message"}`,
        source: "transport",
        blocking: true,
      });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
      return;
    }
    const d = decoded.message;
    if (d.type === "load") {
      const wasFirstLoad = !hasLoadedRef.current;
      hasLoadedRef.current = true;
      const prevEntity = entityRef.current;
      entityRef.current = d.entity;
      setEntity(d.entity);
      setHostError(undefined);
      setLoadFailed(false);
      setHostConflict(undefined);
      setReady(true);
      if (wasFirstLoad || !prevEntity) {
        // first load for this mount — full reset, editor (re)created from the loaded doc.
        resetEditorFrom(d.entity);
        return;
      }
      // live merge — a later load push for the SAME mount (e.g. "Reload latest" re-requesting via
      // "ready", spec F10/F18): non-dirty fields adopt the fresh value silently; a dirty field whose
      // loaded value diverged from the fresh one surfaces in the freshness banner (never
      // auto-merged); the rich doc itself NEVER auto-merges regardless of dirty state.
      const fresh = fieldsFromEntity(d.entity);
      const original = originalRef.current ?? fresh;
      const diverged: string[] = [];
      (Object.keys(fresh) as Array<keyof FieldValues>).forEach((key) => {
        const changed = JSON.stringify(fresh[key]) !== JSON.stringify(original[key]);
        if (!changed) return;
        const fieldDirty = key === "artifact_refs" ? dirty.artifact_refs : key === "deps" ? dirty.deps : dirty[key as keyof TaskFieldsDirty];
        if (fieldDirty) { diverged.push(key); return; }
        if (key === "title") setTitle(fresh.title);
        else if (key === "kind") setKind(fresh.kind);
        else if (key === "priority") setPriority(fresh.priority);
        else if (key === "assignee") setAssignee(fresh.assignee);
        else if (key === "deps") setDeps(fresh.deps);
        else if (key === "artifact_refs") setArtifactRefs(fresh.artifact_refs);
      });
      depTitlesRef.current = { ...depTitlesRef.current, ...Object.fromEntries(d.entity.deps.map((dep) => [dep.id, dep.title])) };
      if (!docDirty) {
        attachmentsRef.current = d.entity.attachments;
        setAttachments(d.entity.attachments);
        editorRef.current?.commands.setContent(toEditorDoc(d.entity.doc, d.entity.attachments), { emitUpdate: false });
        setDocVersion((v) => v + 1);
        setExpectUpdatedAt(d.entity.expectUpdatedAt);
      }
      if (!docDirty && Object.keys(dirty).every((k) => !dirty[k as keyof TaskFieldsDirty])) {
        originalRef.current = fresh;
        setExpectUpdatedAt(d.entity.expectUpdatedAt);
      }
      setFreshFields(diverged);
    } else if (d.type === "error") {
      // a CAS conflict (spec 350 T1's `task/precondition-failed`) gets its own banner (with Reload
      // latest/Export local draft) — every other error rides the shell's generic StudioError shape.
      if (d.code === "task/precondition-failed") { setHostConflict(d.message); setReady(true); return; }
      setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
    } else if (d.type === "restore") {
      // t-610705 (Phase D, D2) — KNOWN, DOCUMENTED LIMITATION: a kept draft's `patch.attachments` are
      // the PLAIN stored shape (no resolved `uri`/`previewUri` — those are VM-only, resolved from a
      // real `loadTaskStudio` call). Restoring the doc's text/structure is faithful; any image/sketch
      // node it references may render as a broken thumbnail until the user reloads. None of the other
      // 5 migrated studios carry rich-media state at all, so there is no existing pattern to match —
      // scoped down the same way D2's taskStudioDomain.ts already accepted for `onTasksChanged`.
      const patch = d.snapshot?.patch;
      if (!patch) return;
      setTitle(patch.title);
      setKind(patch.kind ?? "");
      setPriority(patch.priority);
      setAssignee(patch.assignee ?? "");
      setDeps(patch.deps);
      setArtifactRefs(patch.artifact_refs);
      setDirty(patch.dirty);
      setDocDirty(patch.docDirty);
      setExpectUpdatedAt(patch.expectUpdatedAt);
      if (editorRef.current) {
        editorRef.current.commands.setContent(toEditorDoc(patch.doc, attachmentsRef.current), { emitUpdate: false });
        setDocVersion((v) => v + 1);
      }
    } else if (d.type === "attachmentStored") {
      insertAttachment(d.attachment);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  // spec 350 T2/T3 — patch/dirty ride every field change for restore/discard; Save also carries a
  // fresh click-time snapshot (in `onSave` below) so editor updates cannot race this effect.
  useEffect(() => {
    if (!ready || !entity || frozen) return;
    editRevisionRef.current += 1;
    const fields = currentFields();
    post(dirtyMessage(computeTaskDirty(entity, fields)));
    post(patchMessage(fields, editRevisionRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, entity, frozen, title, kind, priority, assignee, deps, artifactRefs, dirty, docDirty, expectUpdatedAt, docVersion]);

  useEffect(() => {
    if (hostError) setError(hostError.message);
  }, [hostError]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    post(attachImageMessage({ mediaType: file.type, name: file.name, source, dataBase64 }));
  };

  const rememberAttachment = (att: RichDocAttachmentVM): RichDocAttachmentVM[] => {
    const next = upsertAttachment(attachmentsRef.current, att);
    attachmentsRef.current = next;
    setAttachments(next);
    return next;
  };

  const insertAttachment = (att: RichDocAttachmentVM) => {
    const transientScene = att.kind === "excalidraw"
      ? pendingSketchScenes.current.get(att.id) ?? pendingSketchScenes.current.get("__pending")
      : undefined;
    pendingSketchScenes.current.delete(att.id);
    pendingSketchScenes.current.delete("__pending");
    const attachmentForState = att.kind === "excalidraw" && transientScene ? { ...att, sceneJson: transientScene } : att;
    const next = rememberAttachment(attachmentForState);
    setDocDirty(true);
    if (att.kind === "image") {
      editorRef.current?.chain().focus().setImage({ src: att.uri ?? att.path, alt: att.name, title: att.name }).updateAttributes("image", { attachmentId: att.id, blobRef: att.blobRef }).run();
      return;
    }
    const pending = pendingSketch.current;
    pendingSketch.current = null;
    if (pending?.insertOnStore !== false) {
      editorRef.current?.chain().focus().insertContent({ type: "tachyonSketch", attrs: { attachmentId: attachmentForState.id, previewSrc: attachmentForState.previewUri ?? `tachyon-pin-sketch:${attachmentForState.id}` } }).run();
    } else {
      refreshSketchPreviews(next);
    }
  };

  if (!ready || !entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Task Studio...</div></div>;
  }

  const run = (fn: (editor: Editor) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
    setSlashOpen(false);
  };

  const refreshSketchPreviews = (nextAttachments = attachmentsRef.current) => {
    const editor = editorRef.current;
    if (!editor) return;
    const stored = toStoredDoc(editor.getJSON() as never);
    editor.commands.setContent(toEditorDoc(stored, nextAttachments), { emitUpdate: false });
    setDocVersion((v) => v + 1);
  };

  const openBlankSketch = () => {
    setSlashOpen(false);
    const request = { name: "Sketch", source: "blank", initialScene: null, insertOnStore: true } satisfies SketchRequest;
    pendingSketch.current = request;
    setSketch(request);
  };

  const openExistingSketch = (att: RichDocAttachmentVM) => {
    if (att.kind !== "excalidraw") return;
    if (!att.sceneJson) { setError("Sketch scene is unavailable"); return; }
    try {
      const request = { attachmentId: att.id, name: att.name, source: att.source, baseImageAttachmentId: att.baseImageAttachmentId, initialScene: JSON.parse(att.sceneJson) as Record<string, unknown>, insertOnStore: false } satisfies SketchRequest;
      pendingSketch.current = request;
      setSketch(request);
    } catch {
      setError("Sketch scene is not valid JSON");
    }
  };

  const openAnnotate = async (att: RichDocAttachmentVM) => {
    if (att.kind !== "image") return;
    if (!att.uri) { setError("Image artifact is unavailable"); return; }
    try {
      const dataURL = await uriToDataURL(att.uri, att.mediaType);
      const request = {
        name: `${att.name} annotation`,
        source: "annotate-image",
        baseImageAttachmentId: att.id,
        baseImage: { attachmentId: att.id, name: att.name, dataURL, mediaType: att.mediaType, ...(att.width !== undefined ? { width: att.width } : {}), ...(att.height !== undefined ? { height: att.height } : {}) },
        initialScene: null,
        insertOnStore: true,
      } satisfies SketchRequest;
      pendingSketch.current = request;
      setSketch(request);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const storeSketch = (request: SketchRequest, result: RichDocExcalidrawSaveResult) => {
    pendingSketchScenes.current.set(request.attachmentId ?? "__pending", result.sceneJson);
    post(storeSketchMessage({
      ...(request.attachmentId ? { attachmentId: request.attachmentId } : {}),
      name: request.name,
      source: request.source,
      ...(request.baseImageAttachmentId ? { baseImageAttachmentId: request.baseImageAttachmentId } : {}),
      sceneJson: result.sceneJson,
      previewBase64: result.previewBase64,
    }));
    setSketch(null);
  };

  const visibleAttachments = docVersion >= 0 && editorRef.current ? attachmentsUsedByDoc(currentStoredDoc(), attachments) : attachments;

  const onSave = () => {
    if (frozenRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) { setError("Task title is required"); return; }
    editRevisionRef.current += 1;
    post(patchMessage(currentFields(), editRevisionRef.current));
    freezeForSave();
    post(saveMessage());
  };

  // t-610705 (Phase D, D2) — re-requesting "ready" makes the host resend a fresh `load` for the
  // current binding (studioHost.ts's `case "ready": await sendStudioLoad(io);`) — the actual fix for
  // what the standalone panel's "Reload latest" button used to do (re-apply whatever `entity` state
  // was already held locally, which a CAS-conflict error never actually refreshed).
  const reloadLatest = () => {
    post(readyMessage({ routeKey, mountNonce }));
  };

  const addDep = () => {
    const candidate = depInput.trim();
    if (!candidate) return;
    if (!TASK_ID_RE.test(candidate)) { setError(`'${candidate}' is not a valid task id`); return; }
    if (candidate === entity.taskId) { setError("A task cannot depend on itself"); return; }
    if (deps.includes(candidate)) { setDepInput(""); return; }
    setDeps((d) => [...d, candidate]);
    setDepInput("");
    setError(undefined);
    markDirty("deps");
  };
  const removeDep = (id: string) => { setDeps((d) => d.filter((x) => x !== id)); markDirty("deps"); };

  const addArtifactRef = () => {
    const raw = artifactInput.trim();
    if (!raw) return;
    const sep = raw.indexOf(":");
    if (sep <= 0 || sep === raw.length - 1) { setError("Artifact refs use the form type:ref"); return; }
    const type = raw.slice(0, sep).trim();
    const ref = raw.slice(sep + 1).trim();
    if (!type || !ref) { setError("Artifact refs use the form type:ref"); return; }
    if (artifactRefs.length >= MAX_ARTIFACT_REFS) { setError(`Tasks can have up to ${MAX_ARTIFACT_REFS} artifact refs`); return; }
    if (artifactRefs.some((a) => a.type === type && a.ref === ref)) { setArtifactInput(""); return; }
    setArtifactRefs((refs) => [...refs, { type, ref }]);
    setArtifactInput("");
    setError(undefined);
    markDirty("artifact_refs");
  };
  const removeArtifactRef = (type: string, ref: string) => { setArtifactRefs((refs) => refs.filter((a) => !(a.type === type && a.ref === ref))); markDirty("artifact_refs"); };

  const assets = readAssets();
  // spec 339 always allowed clicking Save unless the sidecar anchor is read-only (a no-op save on an
  // unmodified task is a valid, dogfooded path — it just disposes the panel), so `dirty: true` is
  // passed unconditionally here (never gating on it) — but StudioFrame's own invariant (dueto F9/F10:
  // "an adapter cannot show a blocking error while leaving Save clickable") still applies now that
  // Task Studio rides the same shared frame as every other migrated studio, so blockingErrorCount/
  // saveInFlight/concurrencyStale still gate exactly like they do everywhere else.
  const canSave = computeCanSave({ dirty: true, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false })
    && entity.anchor !== "read-only";

  return (
    <>
      <StudioFrame
        title={taskStudioTitleFor(isNew ? "new" : "edit", entity.taskId, entity)}
        errors={hostError ? [hostError] : []}
        dirty={dirtyComputed}
        saveInFlight={saveInFlight}
        loadFailed={loadFailed}
        canSave={canSave}
        frozen={frozen}
        onSave={onSave}
        onCancel={() => post(cancelMessage())}
        headerActions={
          <>
            <Button icon="file-media" onClick={() => post(importImageMessage())}>Import</Button>
            <Button icon="preview" onClick={() => post(importPrototypeMessage())}>Import prototype</Button>
            <Button icon="edit" onClick={openBlankSketch}>Sketch</Button>
          </>
        }
        regions={{
          fields: (
            <>
              <div class="eyebrow">{isNew ? adapter.newLabel() : adapter.editLabel(entity.taskId)}</div>
              <input class="title" value={title} onInput={(e) => { setTitle((e.currentTarget as HTMLInputElement).value); markDirty("title"); }} placeholder="Task title" aria-label="Task title" />

              <KitFieldRow class="ts-fields">
                <div class="ts-field">
                  <KitLabeledInput
                    label="Kind"
                    value={kind}
                    maxLength={64}
                    placeholder="kind"
                    onInput={(v) => { setKind(v); markDirty("kind"); }}
                  />
                </div>
                <div class="ts-field">
                  <span class="ds-section">Priority</span>
                  <KitSelect
                    aria-label="Priority"
                    value={priority !== undefined ? String(priority) : NO_PRIORITY}
                    onValueChange={(v) => { setPriority(v === NO_PRIORITY ? undefined : (Number(v) as TaskPriority)); markDirty("priority"); }}
                    options={PRIORITY_OPTIONS}
                  />
                </div>
                <div class="ts-field">
                  <KitLabeledInput
                    label="Assignee"
                    value={assignee}
                    maxLength={64}
                    placeholder={isNew ? "assign during triage" : "assignee"}
                    disabled={isNew}
                    title={isNew ? "Assignee is set during triage, once the task leaves Inbox" : undefined}
                    list="ts-known-agents"
                    onInput={(v) => { setAssignee(v); markDirty("assignee"); }}
                  />
                  <datalist id="ts-known-agents">{entity.knownAgents.map((a) => <option key={a} value={a} />)}</datalist>
                </div>
              </KitFieldRow>

              <KitFieldRow class="ts-chip-fields">
                <div class="ts-chip-field" aria-label="Dependencies">
                  <span class="ts-chip-label">Deps</span>
                  {deps.map((id) => {
                    const label = depTitlesRef.current[id] ? `${id} · ${depTitlesRef.current[id]}` : id;
                    return (
                      <button key={id} class="chip-pill" type="button" title={label} aria-label={`Remove dependency ${id}`} onClick={() => removeDep(id)}>
                        <span class="chip-pill-text">{label}</span><Icon name="close" />
                      </button>
                    );
                  })}
                  <input value={depInput} placeholder="t-xxxxxx" aria-label="Add dependency"
                    onInput={(e) => setDepInput((e.currentTarget as HTMLInputElement).value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDep(); } }} />
                </div>
                <div class="ts-chip-field" aria-label="Artifact refs">
                  <span class="ts-chip-label">Artifacts</span>
                  {artifactRefs.map((a) => {
                    const label = `${a.type}:${a.ref}`;
                    return (
                      <button
                        key={label}
                        class="chip-pill"
                        type="button"
                        title={label}
                        aria-label={`Remove artifact ${label}`}
                        onClick={() => removeArtifactRef(a.type, a.ref)}
                      >
                        <span class="chip-pill-text">{label}</span><Icon name="close" />
                      </button>
                    );
                  })}
                  <input value={artifactInput} placeholder="type:ref" aria-label="Add artifact ref"
                    onInput={(e) => setArtifactInput((e.currentTarget as HTMLInputElement).value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addArtifactRef(); } }} />
                </div>
              </KitFieldRow>

              {entity.anchor === "read-only" && (
                <div class="ts-banner ts-banner-err"><Icon name="lock" /> The rich doc sidecar is unreadable ({entity.anchorError}) — scalar fields still save, but body/attachments are read-only until this is fixed.</div>
              )}
              {entity.anchor === "reimport" && (
                <div class="ts-banner"><Icon name="info" /> Imported from the task's current body (an external edit or missing sidecar) — richer formatting beyond markdown may be gone, content is not.</div>
              )}
              {freshFields.length > 0 && (
                <div class="ts-banner">
                  <Icon name="sync" /> Changed elsewhere while editing: {freshFields.join(", ")}.
                </div>
              )}
              {hostConflict && (
                <div class="ts-banner ts-banner-err">
                  <Icon name="warning" /> Someone else updated this task first.
                  <Button onClick={reloadLatest}>Reload latest</Button>
                  <Button onClick={() => { void navigator.clipboard?.writeText(`${title}\n\n(unsaved local draft)`); }}>Export local draft</Button>
                </div>
              )}
            </>
          ),
          richDoc: (
            <>
              <EditorToolbar run={run} onOpenSketch={openBlankSketch} onToggleSlash={() => setSlashOpen((v) => !v)} />
              {slashOpen && <SlashMenu run={run} onOpenSketch={openBlankSketch} />}
              <div class="editor-shell" onDragOver={(e) => e.preventDefault()}>
                <div ref={mount} />
              </div>
            </>
          ),
          previewVisual: (
            <>
              <VisualsPanel attachments={visibleAttachments} onImport={() => post(importImageMessage())} onAnnotate={(a) => void openAnnotate(a)} onEditSketch={openExistingSketch} />
              <PrototypePreview value={entity.prototypes ?? { readOnly: false, prototypes: [] }} />
            </>
          ),
        }}
      />
      {sketch && assets && <SketchModal assets={assets} request={sketch} onCancel={() => { pendingSketch.current = null; setSketch(null); }} onSave={storeSketch} onError={setError} />}
      {error && <div class="err" role="alert">{error}</div>}
    </>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
