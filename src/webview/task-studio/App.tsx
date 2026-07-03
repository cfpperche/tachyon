import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import { Button } from "../shared/ui";
import { KitFieldRow, KitLabeledInput, KitSelect } from "../shared/ui/kit";
import { createRichDocEditor } from "../rich-doc/tiptap";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "../rich-doc/document";
import { EditorToolbar, SlashMenu } from "../rich-doc/toolbar";
import { SketchModal, VisualsPanel, uriToDataURL, type RichDocExcalidrawSaveResult, type SketchRequest } from "../rich-doc/VisualsPanel";
import { createTaskStudioAdapter } from "../rich-doc/adapter";
import type { RichDocAttachmentVM } from "../rich-doc/types";
import type { ArtifactRef, TaskPriority } from "../../tasks/types";
import { TASK_ID_RE } from "../../tasks/types";
import type { TaskStudioSaveDirty, TaskStudioVM, TaskStudioWebviewMessage } from "./types";

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

export interface TaskStudioDispatch {
  post(msg: TaskStudioWebviewMessage): void;
}

interface FieldValues {
  title: string;
  kind: string;
  priority?: TaskPriority;
  assignee: string;
  deps: string[];
  artifact_refs: ArtifactRef[];
}

function fieldsFromVM(vm: TaskStudioVM): FieldValues {
  return {
    title: vm.title,
    kind: vm.kind ?? "",
    priority: vm.priority,
    assignee: vm.assignee ?? "",
    deps: vm.deps.map((d) => d.id),
    artifact_refs: vm.artifact_refs,
  };
}

export function App({ vm, dispatch, hostError, hostConflict }: { vm?: TaskStudioVM; dispatch: TaskStudioDispatch; hostError?: string; hostConflict?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const attachmentsRef = useRef<RichDocAttachmentVM[]>([]);
  const pendingSketch = useRef<SketchRequest | null>(null);
  const pendingSketchScenes = useRef(new Map<string, string>());
  const originalRef = useRef<FieldValues | null>(null);
  const depTitlesRef = useRef<Record<string, string | undefined>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState<TaskPriority | undefined>(undefined);
  const [assignee, setAssignee] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [depInput, setDepInput] = useState("");
  const [artifactRefs, setArtifactRefs] = useState<ArtifactRef[]>([]);
  const [artifactInput, setArtifactInput] = useState("");
  const [dirty, setDirty] = useState<TaskStudioSaveDirty>({});
  const [docDirty, setDocDirty] = useState(false);
  const [expectUpdatedAt, setExpectUpdatedAt] = useState<string | undefined>(undefined);
  const [attachments, setAttachments] = useState<RichDocAttachmentVM[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const [freshFields, setFreshFields] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [sketch, setSketch] = useState<SketchRequest | null>(null);

  const markDirty = (field: keyof TaskStudioSaveDirty) => setDirty((d) => (d[field] ? d : { ...d, [field]: true }));

  // full reset — initial load, or an explicit "Reload latest" (bumps reloadNonce)
  useEffect(() => {
    if (!vm || !mount.current) return;
    const fields = fieldsFromVM(vm);
    originalRef.current = fields;
    depTitlesRef.current = Object.fromEntries(vm.deps.map((d) => [d.id, d.title]));
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
    setExpectUpdatedAt(vm.expectUpdatedAt);
    attachmentsRef.current = vm.attachments;
    setAttachments(vm.attachments);
    setError(undefined);
    setConflict(undefined);
    setFreshFields([]);
    editorRef.current?.destroy();
    editorRef.current = createRichDocEditor(
      mount.current,
      toEditorDoc(vm.doc, vm.attachments),
      (file, source) => void attachFile(file, source),
      () => setSlashOpen(true),
      () => setDocDirty(true),
    );
    setDocVersion((v) => v + 1);
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm?.workspaceHash, vm?.taskId, vm?.mode, reloadNonce]);

  // live merge — every OTHER vm push (concurrent safety, spec F10/F18): non-dirty fields adopt the fresh
  // value silently; a dirty field whose loaded value diverged from the fresh one surfaces in the freshness
  // banner (never auto-merged); the rich doc itself NEVER auto-merges regardless of dirty state.
  useEffect(() => {
    if (!vm || !originalRef.current || !editorRef.current) return;
    const fresh = fieldsFromVM(vm);
    const original = originalRef.current;
    const diverged: string[] = [];
    (Object.keys(fresh) as Array<keyof FieldValues>).forEach((key) => {
      const changed = JSON.stringify(fresh[key]) !== JSON.stringify(original[key]);
      if (!changed) return;
      const fieldDirty = key === "artifact_refs" ? dirty.artifact_refs : key === "deps" ? dirty.deps : dirty[key as keyof TaskStudioSaveDirty];
      if (fieldDirty) { diverged.push(key); return; }
      // not dirty — safe to adopt transparently
      if (key === "title") setTitle(fresh.title);
      else if (key === "kind") setKind(fresh.kind);
      else if (key === "priority") setPriority(fresh.priority);
      else if (key === "assignee") setAssignee(fresh.assignee);
      else if (key === "deps") setDeps(fresh.deps);
      else if (key === "artifact_refs") setArtifactRefs(fresh.artifact_refs);
    });
    depTitlesRef.current = { ...depTitlesRef.current, ...Object.fromEntries(vm.deps.map((d) => [d.id, d.title])) };
    if (!docDirty) {
      attachmentsRef.current = vm.attachments;
      setAttachments(vm.attachments);
      editorRef.current.commands.setContent(toEditorDoc(vm.doc, vm.attachments), { emitUpdate: false });
      setDocVersion((v) => v + 1);
      setExpectUpdatedAt(vm.expectUpdatedAt);
    }
    if (!docDirty && Object.keys(dirty).every((k) => !dirty[k as keyof TaskStudioSaveDirty])) {
      // nothing at all is dirty — the whole panel is a passive viewer right now, safe to fully re-anchor
      originalRef.current = fresh;
      setExpectUpdatedAt(vm.expectUpdatedAt);
    }
    setFreshFields(diverged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

  useEffect(() => {
    if (hostError) setError(hostError);
  }, [hostError]);

  useEffect(() => {
    if (hostConflict) setConflict(hostConflict);
  }, [hostConflict]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    dispatch.post({ type: "attachImage", mediaType: file.type, name: file.name, source, dataBase64 });
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

  useEffect(() => {
    const win = window as unknown as { __tachyonTaskStored?: (att: RichDocAttachmentVM) => void };
    win.__tachyonTaskStored = insertAttachment;
    return () => {
      if (win.__tachyonTaskStored === insertAttachment) delete win.__tachyonTaskStored;
    };
  });

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Task Studio...</div></div>;
  }

  const run = (fn: (editor: Editor) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
    setSlashOpen(false);
  };

  const currentStoredDoc = () => toStoredDoc((editorRef.current?.getJSON() ?? { type: "doc", content: [] }) as never);

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
    dispatch.post({
      type: "storeSketch",
      ...(request.attachmentId ? { attachmentId: request.attachmentId } : {}),
      name: request.name,
      source: request.source,
      ...(request.baseImageAttachmentId ? { baseImageAttachmentId: request.baseImageAttachmentId } : {}),
      sceneJson: result.sceneJson,
      previewBase64: result.previewBase64,
    });
    setSketch(null);
  };

  const visibleAttachments = docVersion >= 0 && editorRef.current ? attachmentsUsedByDoc(currentStoredDoc(), attachments) : attachments;

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed) { setError("Task title is required"); return; }
    const doc = currentStoredDoc();
    dispatch.post({
      type: "save",
      title: trimmed,
      ...(kind.trim() ? { kind: kind.trim() } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(vm.mode === "edit" && assignee.trim() ? { assignee: assignee.trim() } : {}),
      deps,
      artifact_refs: artifactRefs,
      doc,
      attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM),
      dirty,
      docDirty,
      ...(expectUpdatedAt !== undefined ? { expectUpdatedAt } : {}),
    });
  };

  const reloadLatest = () => {
    dispatch.post({ type: "reloadLatest" });
    setReloadNonce((n) => n + 1);
  };

  const addDep = () => {
    const candidate = depInput.trim();
    if (!candidate) return;
    if (!TASK_ID_RE.test(candidate)) { setError(`'${candidate}' is not a valid task id`); return; }
    if (candidate === vm.taskId) { setError("A task cannot depend on itself"); return; }
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

  return (
    <div class="studio">
      <header class="bar">
        <div>
          <div class="eyebrow">{vm.mode === "new" ? adapter.newLabel() : adapter.editLabel(vm.taskId)}</div>
          <input class="title" value={title} onInput={(e) => { setTitle((e.currentTarget as HTMLInputElement).value); markDirty("title"); }} placeholder="Task title" aria-label="Task title" />
        </div>
        <div class="actions">
          <Button icon="file-media" onClick={() => dispatch.post({ type: "importImage" })}>Import</Button>
          <Button icon="edit" onClick={openBlankSketch}>Sketch</Button>
          <Button onClick={() => dispatch.post({ type: "cancel" })}>Cancel</Button>
          <Button variant="primary" icon="save" onClick={save} disabled={vm.anchor === "read-only"}>Save</Button>
        </div>
      </header>

      {/* spec 342 Pilot B — before: plain `<label class="ts-field">` wrappers around a raw `<input
         class="ds-input">` (Kind/Assignee) and the legacy `Select` (Priority). After: KitFieldRow (a thin
         re-export of the SAME FieldRow, so the row rhythm is byte-identical) with KitLabeledInput
         (Kind/Assignee) and KitSelect (Priority) — see notes.md's T7 entry for the exact parity notes
         (label presentation moves to Kit's own `ds-section` look; Priority's "none" state needed a
         non-empty sentinel value since Radix Select rejects an empty-string item). */}
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
          {/* dogfood round 1 (#2) — Kind/Assignee's KitLabeledInput renders its own `ds-section` label
             (uppercase, T7's deliberate look); Priority's plain `<span>` never got the same treatment, so
             three adjacent fields in one row showed two different label styles. `ds-section` here matches
             them, purely visual — the KitSelect↔label association still goes through `aria-label` below. */}
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
            placeholder={vm.mode === "new" ? "assign during triage" : "assignee"}
            disabled={vm.mode === "new"}
            title={vm.mode === "new" ? "Assignee is set during triage, once the task leaves Inbox" : undefined}
            list="ts-known-agents"
            onInput={(v) => { setAssignee(v); markDirty("assignee"); }}
          />
          <datalist id="ts-known-agents">{vm.knownAgents.map((a) => <option key={a} value={a} />)}</datalist>
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
          {artifactRefs.map((a) => (
            <button key={`${a.type}:${a.ref}`} class="chip-pill" type="button" title={`Remove ${a.type}:${a.ref}`} onClick={() => removeArtifactRef(a.type, a.ref)}>
              {a.type}:{a.ref}<Icon name="close" />
            </button>
          ))}
          <input value={artifactInput} placeholder="type:ref" aria-label="Add artifact ref"
            onInput={(e) => setArtifactInput((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addArtifactRef(); } }} />
        </div>
      </KitFieldRow>

      {vm.anchor === "read-only" && (
        <div class="ts-banner ts-banner-err"><Icon name="lock" /> The rich doc sidecar is unreadable ({vm.anchorError}) — scalar fields still save, but body/attachments are read-only until this is fixed.</div>
      )}
      {vm.anchor === "reimport" && (
        <div class="ts-banner"><Icon name="info" /> Imported from the task's current body (an external edit or missing sidecar) — richer formatting beyond markdown may be gone, content is not.</div>
      )}
      {freshFields.length > 0 && (
        <div class="ts-banner">
          <Icon name="sync" /> Changed elsewhere while editing: {freshFields.join(", ")}.
        </div>
      )}
      {conflict && (
        <div class="ts-banner ts-banner-err">
          <Icon name="warning" /> Someone else updated this task first.
          <Button onClick={reloadLatest}>Reload latest</Button>
          <Button onClick={() => { void navigator.clipboard?.writeText(`${title}\n\n(unsaved local draft)`); }}>Export local draft</Button>
        </div>
      )}

      <EditorToolbar run={run} onOpenSketch={openBlankSketch} onToggleSlash={() => setSlashOpen((v) => !v)} />
      {slashOpen && <SlashMenu run={run} onOpenSketch={openBlankSketch} />}

      <main>
        <div class="editor-shell" onDragOver={(e) => e.preventDefault()}>
          <div ref={mount} />
        </div>
        <VisualsPanel attachments={visibleAttachments} onImport={() => dispatch.post({ type: "importImage" })} onAnnotate={(a) => void openAnnotate(a)} onEditSketch={openExistingSketch} />
      </main>
      {sketch && vm.assets && <SketchModal assets={vm.assets} request={sketch} onCancel={() => { pendingSketch.current = null; setSketch(null); }} onSave={storeSketch} onError={setError} />}
      {error && <div class="err" role="alert">{error}</div>}
    </div>
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
