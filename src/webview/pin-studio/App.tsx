import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import type { PinStudioAssets, PinStudioAttachmentVM } from "./types";
import type { PinDetailEntity, PinFields } from "./domain";
import { computePinDirty, pinStudioTitleFor } from "./domain";
import type { StudioError } from "../shared/studio/errorTaxonomy";
import { StudioFrame } from "../shared/studio/StudioFrame";
import { createRichDocEditor } from "../rich-doc/tiptap";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "../rich-doc/document";
import { EditorToolbar, SlashMenu } from "../rich-doc/toolbar";
import { SketchModal, VisualsPanel, uriToDataURL, type RichDocExcalidrawSaveResult, type SketchRequest } from "../rich-doc/VisualsPanel";
import { createPinStudioAdapter } from "../rich-doc/adapter";
import { Button } from "../shared/ui";
import { attachImageMessage, cancelMessage, dirtyMessage, importImageMessage, patchMessage, saveMessage, storeSketchMessage } from "./messages";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface PinStudioDispatch {
  post(msg: unknown): void;
}

declare global {
  interface Window {
    __tachyonPinAssets?: PinStudioAssets;
  }
}

const adapter = createPinStudioAdapter();

function readAssets(): PinStudioAssets | undefined {
  const w = window as unknown as { __tachyonPinAssets?: PinStudioAssets };
  return w.__tachyonPinAssets;
}

export function App({
  entity,
  saveInFlight,
  loadFailed,
  dispatch,
  hostError,
}: {
  entity?: PinDetailEntity;
  saveInFlight: boolean;
  loadFailed: boolean;
  dispatch: PinStudioDispatch;
  hostError?: StudioError;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const attachmentsRef = useRef<PinStudioAttachmentVM[]>([]);
  const pendingSketch = useRef<SketchRequest | null>(null);
  const pendingSketchScenes = useRef(new Map<string, string>());
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [attachments, setAttachments] = useState<PinStudioAttachmentVM[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [slashOpen, setSlashOpen] = useState(false);
  const [sketch, setSketch] = useState<SketchRequest | null>(null);

  useEffect(() => {
    if (!entity || !mount.current) return;
    setTitle(entity.title);
    setTags(entity.tags);
    setTagInput("");
    attachmentsRef.current = entity.attachments;
    setAttachments(entity.attachments);
    setError(undefined);
    editorRef.current?.destroy();
    editorRef.current = createRichDocEditor(
      mount.current,
      toEditorDoc(entity.doc, entity.attachments),
      (file, source) => void attachFile(file, source),
      () => setSlashOpen(true),
      () => setDocVersion((v) => v + 1),
    );
    setDocVersion((v) => v + 1);
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [entity?.workspaceHash, entity?.pinId]);

  useEffect(() => {
    if (hostError) setError(hostError.message);
  }, [hostError]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const currentStoredDoc = () => toStoredDoc((editorRef.current?.getJSON() ?? { type: "doc", content: [] }) as never);
  const currentFields = (): PinFields => {
    const doc = currentStoredDoc();
    return { title, tags, doc, attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM) };
  };

  useEffect(() => {
    if (!entity) return;
    const fields = currentFields();
    const dirty = computePinDirty(entity, fields);
    dispatch.post(dirtyMessage(dirty));
    dispatch.post(patchMessage(fields));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, title, tags, docVersion, attachments]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    dispatch.post(attachImageMessage({ mediaType: file.type, name: file.name, source, dataBase64 }));
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
      editorRef.current?.chain().focus().setImage({
        src: att.uri ?? att.path,
        alt: att.name,
        title: att.name,
      }).updateAttributes("image", { attachmentId: att.id, blobRef: att.blobRef }).run();
      return;
    }
    const pending = pendingSketch.current;
    pendingSketch.current = null;
    if (pending?.insertOnStore !== false) {
      editorRef.current?.chain().focus().insertContent({
        type: "tachyonSketch",
        attrs: { attachmentId: attachmentForState.id, previewSrc: attachmentForState.previewUri ?? `tachyon-pin-sketch:${attachmentForState.id}` },
      }).run();
    } else {
      refreshSketchPreviews(next);
    }
  };

  useEffect(() => {
    const win = window as unknown as { __tachyonPinStored?: (att: PinStudioAttachmentVM) => void };
    win.__tachyonPinStored = insertAttachment;
    return () => {
      if (win.__tachyonPinStored === insertAttachment) delete win.__tachyonPinStored;
    };
  });

  if (!entity) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Pin Studio...</div></div>;
  }
  const loaded = entity;

  const run = (fn: (editor: Editor) => void) => {
    const editor = editorRef.current;
    if (editor) fn(editor);
    setSlashOpen(false);
  };
  const save = () => {
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
    const doc = currentStoredDoc();
    const fields = { title: trimmed, tags: finalTags, doc, attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM) };
    dispatch.post(patchMessage(fields));
    dispatch.post(saveMessage(fields));
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
    dispatch.post(storeSketchMessage({
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

  const isNew = loaded.pinId === undefined;
  const assets = readAssets();
  const dirty = computePinDirty(loaded, currentFields());

  return (
    <>
      <StudioFrame
        title={pinStudioTitleFor(isNew ? "new" : "edit", loaded.pinId, loaded)}
        errors={hostError ? [hostError] : []}
        dirty={dirty}
        saveInFlight={saveInFlight}
        loadFailed={loadFailed}
        canSave={!saveInFlight}
        onSave={save}
        onCancel={() => dispatch.post(cancelMessage())}
        regions={{
          fields: (
            <>
              <div class="eyebrow">{isNew ? adapter.newLabel() : adapter.editLabel(loaded.pinId!)}</div>
              <input class="title" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder="Pin title" aria-label="Pin title" />
          <div class="tag-editor" aria-label="Pin tags">
            {tags.map((tag) => (
              // A bespoke interactive remove-tag control (the whole pill removes on click) — not the kit's static
              // Chip span; renamed off the reserved `chip` token. A removable Chip variant is a kit follow-up.
              <button class="tag-pill" type="button" title={`Remove tag ${tag}`} onClick={() => removeTag(tag)}>
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
              <div class="editor-shell" onDragOver={(e) => e.preventDefault()}>
                <div ref={mount} />
              </div>
            </>
          ),
          previewVisual: (
            <VisualsPanel
              attachments={visibleAttachments}
              onImport={() => dispatch.post(importImageMessage())}
              onAnnotate={(a) => void openAnnotate(a)}
              onEditSketch={openExistingSketch}
            />
          ),
          sideActions: (
            <div class="pin-side-actions">
              <Button icon="file-media" onClick={() => dispatch.post(importImageMessage())}>Import</Button>
              <Button icon="edit" onClick={openBlankSketch}>Sketch</Button>
            </div>
          ),
        }}
      />
      {sketch && assets && <SketchModal assets={assets} request={sketch} onCancel={() => { pendingSketch.current = null; setSketch(null); }} onSave={storeSketch} onError={setError} />}
      {error && <div class="err" role="alert">{error}</div>}
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
