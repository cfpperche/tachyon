import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import { Button } from "../shared/ui";
import { StudioFrame } from "../shared/studio/StudioFrame";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { decodeStudioMessage, type StudioDispatch } from "../shared/studio/protocol";
import { canSave as computeCanSave } from "../shared/studio/dirtyGating";
import { useStudioFreeze } from "../shared/studio/useStudioFreeze";
import { createRichDocEditor } from "../rich-doc/tiptap";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "../rich-doc/document";
import { EditorToolbar, SlashMenu } from "../rich-doc/toolbar";
import { SketchModal, VisualsPanel, uriToDataURL, type RichDocExcalidrawSaveResult, type SketchRequest } from "../rich-doc/VisualsPanel";
import { createPinStudioAdapter } from "../rich-doc/adapter";
import type { PinStudioAssets, PinStudioAttachmentVM } from "./types";
import { computePinDirty, pinStudioTitleFor, PIN_STUDIO_HOST_MESSAGE_NAMES, type PinDetailEntity, type PinFields } from "./domain";
import { attachImageMessage, cancelMessage, dirtyMessage, importImageMessage, patchMessage, readyMessage, saveMessage, storeSketchMessage } from "./messages";
import type { PinStudioHostMessage } from "./types";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;

const adapter = createPinStudioAdapter();

/** spec 350 T3 — the Excalidraw asset locations, injected as `window.*` globals by Cockpit.ts's
 *  bootstrapGlobals (shared with Task Studio, D2) — webview-static, not per-pin. */
function readAssets(): PinStudioAssets | undefined {
  const w = window as unknown as { EXCALIDRAW_SCRIPT_URI?: string; EXCALIDRAW_CSS_URI?: string; EXCALIDRAW_ASSET_PATH?: string };
  if (!w.EXCALIDRAW_SCRIPT_URI || !w.EXCALIDRAW_CSS_URI || !w.EXCALIDRAW_ASSET_PATH) return undefined;
  return { excalidrawScriptUri: w.EXCALIDRAW_SCRIPT_URI, excalidrawCssUri: w.EXCALIDRAW_CSS_URI, excalidrawAssetPath: w.EXCALIDRAW_ASSET_PATH };
}

interface FieldValues {
  title: string;
  tags: string[];
}

function fieldsFromEntity(entity: PinDetailEntity): FieldValues {
  return { title: entity.title, tags: entity.tags };
}

/**
 * t-610705 (SDD 410 Phase D, D3) — Control-hosted now: props-driven, same split as every other
 * migrated studio (command-studio-shell/App.tsx has the full rationale for routeKey/mountNonce/
 * useStudioFreeze/eager ref updates; task-studio/App.tsx — D2 — is the closer sibling: same
 * rich-doc/Excalidraw editor stack). Ported from the standalone pin-studio/main.tsx's `Root`
 * component (retired), which decoded the raw postMessage envelope itself and handed this component
 * already-parsed props — that decoding now happens HERE, inline, against the shared studio protocol.
 *
 * Pin is the SIMPLEST rich-doc studio: `concurrency.kind === "none"` (PinStudioAdapter.ts, unlike
 * Task Studio's "cas") — no conflict banner, no live-merge divergence tracking needed; a live "load"
 * push for the same mount just re-applies non-dirty fields directly (see the "load" branch below).
 */
export interface PinStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
  /** t-bf3498 — the route's "← Parent" back-link, rendered under the studio title. */
  backLink?: ComponentChildren;
}

export function App({ dispatch, routeKey, mountNonce, incoming, backLink }: PinStudioAppProps) {
  const mount = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const attachmentsRef = useRef<PinStudioAttachmentVM[]>([]);
  const pendingSketch = useRef<SketchRequest | null>(null);
  const pendingSketchScenes = useRef(new Map<string, string>());
  const entityRef = useRef<PinDetailEntity | undefined>(undefined);
  const hasLoadedRef = useRef(false);
  const editRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  // t-112627 — the entity a first-load's editor still needs to mount against, once `mount.current`
  // actually exists; see the effect below for why this can't happen inline in resetEditorFrom.
  const pendingEditorEntity = useRef<PinDetailEntity | null>(null);

  const [entity, setEntity] = useState<PinDetailEntity | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hostError, setHostError] = useState<StudioError | undefined>(undefined);
  const [ready, setReady] = useState(false);

  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [attachments, setAttachments] = useState<PinStudioAttachmentVM[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  // t-cdd4e1 — explicit dirty flag set only by TipTap's onUpdate firing; see computePinDirty's doc
  // comment (domain.ts) for why a structural JSON diff against the loaded doc false-positives.
  const [docDirty, setDocDirty] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [slashOpen, setSlashOpen] = useState(false);
  const [sketch, setSketch] = useState<SketchRequest | null>(null);

  const isNew = entity !== undefined && entity.pinId === undefined;

  const post = (msg: object): void => dispatch.post({ ...msg, routeKey, mountNonce });

  const currentStoredDoc = () => toStoredDoc((editorRef.current?.getJSON() ?? { type: "doc", content: [] }) as never);
  const currentFields = (): PinFields => {
    const doc = currentStoredDoc();
    return {
      title,
      tags,
      doc,
      attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM),
      docDirty,
      ...(entityRef.current?.expectUpdatedAt ? { expectUpdatedAt: entityRef.current.expectUpdatedAt } : {}),
    };
  };

  const dirtyComputed = computePinDirty(entity, currentFields());
  dirtyRef.current = dirtyComputed;

  const { frozen, saving: saveInFlight, frozenRef, freezeForSave } = useStudioFreeze({
    post: dispatch.post,
    getSnapshot: () => ({ dirty: dirtyRef.current, editRevision: editRevisionRef.current, patch: currentFields() }),
  });

  const resetEditorFrom = (loadedEntity: PinDetailEntity) => {
    const fields = fieldsFromEntity(loadedEntity);
    setTitle(fields.title);
    setTags(fields.tags);
    setTagInput("");
    attachmentsRef.current = loadedEntity.attachments;
    setAttachments(loadedEntity.attachments);
    setError(undefined);
    setDocDirty(false);
    // t-112627 — resetEditorFrom runs synchronously inside the "load" message handler, in the same
    // tick as the setEntity/setReady that will cause StudioFrame's richDoc region (gated on
    // `ready && entity`, below) to render for the FIRST time — `mount.current` is still null here on
    // a fresh binding, so creating the editor inline silently no-ops and the editor never mounts.
    // Stash the entity and let the effect below (which runs after the DOM has actually committed)
    // create it once `mount.current` is real.
    pendingEditorEntity.current = loadedEntity;
    setDocVersion((v) => v + 1);
  };

  // Runs after every commit; cheap no-op once there's no pending entity. Mounts the editor as soon as
  // the richDoc region's mount div has actually appeared in the DOM (t-112627) — see resetEditorFrom.
  useEffect(() => {
    const loadedEntity = pendingEditorEntity.current;
    if (!loadedEntity || !mount.current) return;
    pendingEditorEntity.current = null;
    editorRef.current?.destroy();
    editorRef.current = createRichDocEditor(
      mount.current,
      toEditorDoc(loadedEntity.doc, loadedEntity.attachments),
      (file, source) => void attachFile(file, source),
      () => setSlashOpen(true),
      () => { setDocVersion((v) => v + 1); setDocDirty(true); },
    );
    setDocVersion((v) => v + 1);
  });

  // Re-handshake whenever the binding identity changes (fresh mount OR a same-route re-entry the
  // host rebound) — resets ALL local state so a stale entity never lingers across bindings, same
  // pattern as every other migrated studio.
  useEffect(() => {
    hasLoadedRef.current = false;
    entityRef.current = undefined;
    setEntity(undefined);
    editorRef.current?.destroy();
    editorRef.current = null;
    pendingEditorEntity.current = null;
    attachmentsRef.current = [];
    pendingSketch.current = null;
    pendingSketchScenes.current.clear();
    setTitle("");
    setTags([]);
    setTagInput("");
    setAttachments([]);
    setDocVersion(0);
    setError(undefined);
    setSlashOpen(false);
    setSketch(null);
    setLoadFailed(false);
    setHostError(undefined);
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
    const decoded = decodeStudioMessage<PinStudioHostMessage>(incoming.message, PIN_STUDIO_HOST_MESSAGE_NAMES);
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
      setReady(true);
      if (wasFirstLoad || !prevEntity) {
        // first load for this mount — full reset, editor (re)created from the loaded doc.
        resetEditorFrom(d.entity);
        return;
      }
      // live merge — a later load push for the SAME mount (e.g. the refreshCockpitPinStudioEntity
      // fan-out after an external pin.create/pin.delete elsewhere): concurrency:"none" (unlike Task
      // Studio's "cas") means there is no conflict to detect. A fully clean binding (nothing dirty at
      // all — `dirtyRef.current`, computed relative to the entity BEFORE this push, per-render at the
      // top of this component) adopts the fresh scalars, attachments, AND doc; any local edit blocks
      // ALL of it until Save/Cancel/reload — simpler and more conservative than Task Studio's D2
      // per-field divergence tracking, appropriate for Pin's much smaller 2-field-plus-doc shape (an
      // in-progress edit must never be silently rewritten under the cursor, same rule every rich-doc
      // studio uses).
      if (!dirtyRef.current) {
        setTitle(d.entity.title);
        setTags(d.entity.tags);
        attachmentsRef.current = d.entity.attachments;
        setAttachments(d.entity.attachments);
        editorRef.current?.commands.setContent(toEditorDoc(d.entity.doc, d.entity.attachments), { emitUpdate: false });
        setDocVersion((v) => v + 1);
      }
    } else if (d.type === "error") {
      setHostError({ code: d.code, message: d.message, source: d.source ?? "persistence", blocking: d.blocking });
      if (!entityRef.current) setLoadFailed(true);
      setReady(true);
    } else if (d.type === "restore") {
      // t-610705 (Phase D, D3) — same documented limitation as Task Studio's D2 restore path: a kept
      // draft's `patch.attachments` are the PLAIN stored shape (no resolved `uri`/`previewUri` — VM-
      // only, resolved from a real `loadPinStudio` call). Restoring the doc's text/structure is
      // faithful; any image/sketch node it references may render as a broken thumbnail until reload.
      const patch = d.snapshot?.patch;
      if (!patch) return;
      setTitle(patch.title);
      setTags(patch.tags);
      if (editorRef.current) {
        editorRef.current.commands.setContent(toEditorDoc(patch.doc, attachmentsRef.current), { emitUpdate: false });
        setDocVersion((v) => v + 1);
      }
    } else if (d.type === "attachmentStored") {
      insertAttachment(d.attachment);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.seq]);

  // patch/dirty ride every field change; Save also carries a fresh click-time snapshot (in `onSave`
  // below) so editor updates cannot race this effect.
  useEffect(() => {
    if (!ready || !entity || frozen) return;
    editRevisionRef.current += 1;
    const fields = currentFields();
    post(dirtyMessage(computePinDirty(entity, fields)));
    post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, entity, frozen, title, tags, docVersion, docDirty]);

  useEffect(() => {
    if (hostError) setError(hostError.message);
  }, [hostError]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    post(attachImageMessage({ mediaType: file.type, name: file.name, source, dataBase64 }));
  };

  const rememberAttachment = (att: PinStudioAttachmentVM): PinStudioAttachmentVM[] => {
    const next = upsertAttachment(attachmentsRef.current, att);
    attachmentsRef.current = next;
    setAttachments(next);
    return next;
  };

  const insertAttachment = (att: PinStudioAttachmentVM) => {
    const transientScene = att.kind === "excalidraw"
      ? pendingSketchScenes.current.get(att.id) ?? pendingSketchScenes.current.get("__pending")
      : undefined;
    pendingSketchScenes.current.delete(att.id);
    pendingSketchScenes.current.delete("__pending");
    const attachmentForState = att.kind === "excalidraw" && transientScene ? { ...att, sceneJson: transientScene } : att;
    const next = rememberAttachment(attachmentForState);
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
    return (
      <>
        {backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}
        <div class="ds-degrade rd-degrade"><span class="codicon codicon-loading" /><div>Loading Pin Studio...</div></div>
      </>
    );
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

  const openExistingSketch = (att: PinStudioAttachmentVM) => {
    if (att.kind !== "excalidraw") return;
    if (!att.sceneJson) { setError("Sketch scene is unavailable"); return; }
    try {
      const request = {
        attachmentId: att.id,
        name: att.name,
        source: att.source,
        baseImageAttachmentId: att.baseImageAttachmentId,
        initialScene: JSON.parse(att.sceneJson) as Record<string, unknown>,
        insertOnStore: false,
      } satisfies SketchRequest;
      pendingSketch.current = request;
      setSketch(request);
    } catch {
      setError("Sketch scene is not valid JSON");
    }
  };

  const openAnnotate = async (att: PinStudioAttachmentVM) => {
    if (att.kind !== "image") return;
    if (!att.uri) { setError("Image artifact is unavailable"); return; }
    try {
      const dataURL = await uriToDataURL(att.uri, att.mediaType);
      const request = {
        name: `${att.name} annotation`,
        source: "annotate-image",
        baseImageAttachmentId: att.id,
        baseImage: {
          attachmentId: att.id,
          name: att.name,
          dataURL,
          mediaType: att.mediaType,
          ...(att.width !== undefined ? { width: att.width } : {}),
          ...(att.height !== undefined ? { height: att.height } : {}),
        },
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

  const commitTagInput = () => {
    const candidate = normalizeTag(tagInput);
    if (!candidate) { setTagInput(""); return; }
    if (candidate.length > MAX_TAG_LEN) { setError(`Tags are limited to ${MAX_TAG_LEN} characters`); return; }
    if (tags.length >= MAX_TAGS && !tags.includes(candidate)) { setError(`Pins can have up to ${MAX_TAGS} tags`); return; }
    const next = normalizeTagList([...tags, tagInput]);
    if (next.length === tags.length) {
      setTagInput("");
    } else {
      setTags(next);
      setTagInput("");
      setError(undefined);
    }
  };
  const removeTag = (tag: string) => setTags((cur) => cur.filter((t) => t !== tag));

  const onSave = () => {
    if (frozenRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) { setError("Pin title is required"); return; }
    const pendingTag = normalizeTag(tagInput);
    if (pendingTag.length > MAX_TAG_LEN) { setError(`Tags are limited to ${MAX_TAG_LEN} characters`); return; }
    if (pendingTag && tags.length >= MAX_TAGS && !tags.includes(pendingTag)) { setError(`Pins can have up to ${MAX_TAGS} tags`); return; }
    const finalTags = tagInput.trim() ? normalizeTagList([...tags, tagInput]) : tags;
    if (finalTags !== tags) {
      setTags(finalTags);
      setTagInput("");
    }
    editRevisionRef.current += 1;
    post(patchMessage({ ...currentFields(), title: trimmed, tags: finalTags }));
    freezeForSave();
    post(saveMessage());
  };

  const assets = readAssets();
  const canSave = computeCanSave({ dirty: true, blockingErrorCount: hostError?.blocking ? 1 : 0, saveInFlight, concurrencyStale: false });

  return (
    <>
      <StudioFrame
        title={pinStudioTitleFor(isNew ? "new" : "edit", entity.pinId, entity)}
        backLink={backLink}
        errors={hostError ? [hostError] : []}
        dirty={dirtyComputed}
        saveInFlight={saveInFlight}
        loadFailed={loadFailed}
        canSave={canSave}
        frozen={frozen}
        onSave={onSave}
        onCancel={() => post(cancelMessage())}
        // t-cdd4e1 — Import/Sketch are StudioFrame's own documented headerActions slot ("left of
        // Cancel/Save"); they were wired into regions.sideActions instead, which renders at the
        // BOTTOM of the whole studio body (.sf-side-actions), nowhere near the header.
        headerActions={
          <>
            <Button icon="file-media" onClick={() => post(importImageMessage())}>Import</Button>
            <Button icon="edit" onClick={openBlankSketch}>Sketch</Button>
          </>
        }
        regions={{
          fields: (
            <>
              <div class="rd-eyebrow">{isNew ? adapter.newLabel() : adapter.editLabel(entity.pinId!)}</div>
              <input class="rd-title" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder="Pin title" aria-label="Pin title" />
              <div class="tag-editor" aria-label="Pin tags">
                {tags.map((tag) => (
                  // A bespoke interactive remove-tag control (the whole pill removes on click) — not the kit's
                  // static Chip span; renamed off the reserved `chip` token. A removable Chip variant is a kit follow-up.
                  <button key={tag} class="tag-pill" type="button" title={`Remove tag ${tag}`} onClick={() => removeTag(tag)}>
                    #{tag}<Icon name="close" />
                  </button>
                ))}
                <input value={tagInput} aria-label="Add pin tag" placeholder={tags.length ? "Add tag" : "Add tags"}
                  onInput={(e) => setTagInput((e.currentTarget as HTMLInputElement).value)}
                  onBlur={commitTagInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitTagInput(); }
                    if (e.key === "Backspace" && !tagInput) setTags((cur) => cur.slice(0, -1));
                  }} />
              </div>
            </>
          ),
          richDoc: (
            <>
              <EditorToolbar run={run} onOpenSketch={openBlankSketch} onToggleSlash={() => setSlashOpen((v) => !v)} />
              {slashOpen && <SlashMenu run={run} onOpenSketch={openBlankSketch} />}
              <div class="rd-editor-shell" onDragOver={(e) => e.preventDefault()}>
                <div ref={mount} />
              </div>
            </>
          ),
          previewVisual: (
            <VisualsPanel
              attachments={visibleAttachments}
              onImport={() => post(importImageMessage())}
              onAnnotate={(a) => void openAnnotate(a)}
              onEditSketch={openExistingSketch}
            />
          ),
        }}
      />
      {sketch && assets && <SketchModal assets={assets} request={sketch} onCancel={() => { pendingSketch.current = null; setSketch(null); }} onSave={storeSketch} onError={setError} />}
      {error && <div class="rd-err" role="alert">{error}</div>}
    </>
  );
}

function normalizeTag(value: string): string {
  return value.normalize("NFKC").trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
}

function normalizeTagList(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag || tag.length > MAX_TAG_LEN || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
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
