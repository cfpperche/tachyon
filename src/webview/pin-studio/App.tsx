import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import type { PinStudioAssets, PinStudioAttachmentVM, PinStudioVM, PinStudioWebviewMessage } from "./types";
import { createPinEditor } from "./tiptap";
import { attachmentFromVM, attachmentsForSave, attachmentsUsedByDoc, toEditorDoc, toStoredDoc, upsertAttachment } from "./document";
import { dataURLWithMediaType } from "./data-url";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_TAGS = 12;
const MAX_TAG_LEN = 32;

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface PinStudioDispatch {
  post(msg: PinStudioWebviewMessage): void;
}

interface SketchRequest {
  attachmentId?: string;
  name: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  initialScene?: Record<string, unknown> | null;
  baseImage?: {
    attachmentId: string;
    name: string;
    dataURL: string;
    mediaType: string;
    width?: number;
    height?: number;
  };
  insertOnStore: boolean;
}

interface TachyonExcalidrawSaveResult {
  sceneJson: string;
  previewBase64: string;
  elementCount: number;
}

interface TachyonExcalidrawSession {
  save(): Promise<TachyonExcalidrawSaveResult>;
  unmount(): void;
}

declare global {
  interface Window {
    __tachyonPinAssets?: PinStudioAssets;
    EXCALIDRAW_ASSET_PATH?: string;
    __tachyonExcalidraw?: {
      mount(container: HTMLElement, options?: Record<string, unknown>): TachyonExcalidrawSession;
    };
  }
}

export function App({ vm, dispatch, hostError }: { vm?: PinStudioVM; dispatch: PinStudioDispatch; hostError?: string }) {
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
    if (!vm || !mount.current) return;
    setTitle(vm.title);
    setTags(vm.tags);
    setTagInput("");
    attachmentsRef.current = vm.attachments;
    setAttachments(vm.attachments);
    setError(undefined);
    editorRef.current?.destroy();
    editorRef.current = createPinEditor(
      mount.current,
      toEditorDoc(vm.doc, vm.attachments),
      (file, source) => void attachFile(file, source),
      () => setSlashOpen(true),
      () => setDocVersion((v) => v + 1),
    );
    setDocVersion((v) => v + 1);
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [vm?.workspaceHash, vm?.pinId, vm?.mode]);

  useEffect(() => {
    if (hostError) setError(hostError);
  }, [hostError]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    dispatch.post({ type: "attachImage", mediaType: file.type, name: file.name, source, dataBase64 });
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

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Pin Studio...</div></div>;
  }

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
    dispatch.post({ type: "save", title: trimmed, tags: finalTags, doc, attachments: attachmentsForSave(doc, attachmentsRef.current).map(attachmentFromVM) });
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

  const storeSketch = (request: SketchRequest, result: TachyonExcalidrawSaveResult) => {
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

  return (
    <div class="studio">
      <header class="bar">
        <div>
          <div class="eyebrow">{vm.mode === "new" ? "New pin" : `Editing ${vm.pinId}`}</div>
          <input class="title" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder="Pin title" aria-label="Pin title" />
          <div class="tag-editor" aria-label="Pin tags">
            {tags.map((tag) => (
              <button class="tag-chip" type="button" title={`Remove tag ${tag}`} onClick={() => removeTag(tag)}>
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
        </div>
        <div class="actions">
          <button class="ds-btn" type="button" onClick={() => dispatch.post({ type: "importImage" })}><Icon name="file-media" /> Import</button>
          <button class="ds-btn" type="button" onClick={openBlankSketch}><Icon name="edit" /> Sketch</button>
          <button class="ds-btn" type="button" onClick={() => dispatch.post({ type: "cancel" })}>Cancel</button>
          <button class="ds-btn primary" type="button" onClick={save}><Icon name="save" /> Save</button>
        </div>
      </header>

      <div class="toolbar" aria-label="Formatting">
        <button title="Bold" onClick={() => run((e) => e.chain().focus().toggleBold().run())}><strong>B</strong></button>
        <button title="Italic" onClick={() => run((e) => e.chain().focus().toggleItalic().run())}><em>I</em></button>
        <button title="Code" onClick={() => run((e) => e.chain().focus().toggleCode().run())}><Icon name="code" /></button>
        <button title="Bulleted list" onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}><Icon name="list-unordered" /></button>
        <button title="Numbered list" onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}><Icon name="list-ordered" /></button>
        <button title="Task list" onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><Icon name="checklist" /></button>
        <button title="Block quote" onClick={() => run((e) => e.chain().focus().toggleBlockquote().run())}><Icon name="quote" /></button>
        <button title="Insert sketch" onClick={openBlankSketch}><Icon name="edit" /></button>
        <button title="Slash commands" onClick={() => setSlashOpen((v) => !v)}><Icon name="symbol-keyword" /></button>
      </div>

      {slashOpen && (
        <div class="slash">
          <button onClick={() => run((e) => e.chain().focus().setParagraph().run())}><Icon name="text-size" /> Paragraph</button>
          <button onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}><Icon name="symbol-string" /> Heading</button>
          <button onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}><Icon name="list-unordered" /> Bulleted list</button>
          <button onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><Icon name="checklist" /> Task list</button>
          <button onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}><Icon name="code" /> Code block</button>
          <button onClick={openBlankSketch}><Icon name="edit" /> Sketch</button>
        </div>
      )}

      <main>
        <div class="editor-shell" onDragOver={(e) => e.preventDefault()}>
          <div ref={mount} />
        </div>
        <aside>
          <button class="drop" type="button" onClick={() => dispatch.post({ type: "importImage" })}>
            <Icon name="cloud-upload" />
            <span>Paste, drop, import, or annotate screenshots</span>
          </button>
          <div class="att-head">Visuals · {visibleAttachments.length}</div>
          {visibleAttachments.length === 0 ? <div class="ds-dim">No screenshots or sketches attached.</div> : visibleAttachments.map((a) => (
            <div class="att" key={a.id}>
              {attachmentPreview(a) ? <img src={attachmentPreview(a)} alt="" /> : <span class="missing"><Icon name="warning" /></span>}
              <div>
                <div class="att-name">{a.name}</div>
                <div class="ds-dim">{attachmentSizeLabel(a)}</div>
                <div class="att-actions">
                  {a.kind === "image" && <button type="button" onClick={() => void openAnnotate(a)}>Annotate</button>}
                  {a.kind === "excalidraw" && <button type="button" onClick={() => openExistingSketch(a)}>Edit</button>}
                </div>
              </div>
            </div>
          ))}
        </aside>
      </main>
      {sketch && vm.assets && <SketchModal assets={vm.assets} request={sketch} onCancel={() => { pendingSketch.current = null; setSketch(null); }} onSave={storeSketch} onError={setError} />}
      {error && <div class="err" role="alert">{error}</div>}
    </div>
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

function SketchModal({
  assets,
  request,
  onCancel,
  onSave,
  onError,
}: {
  assets: PinStudioAssets;
  request: SketchRequest;
  onCancel: () => void;
  onSave: (request: SketchRequest, result: TachyonExcalidrawSaveResult) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<TachyonExcalidrawSession | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setLoadError(undefined);
    ensureExcalidraw(assets)
      .then(() => {
        if (disposed || !host.current || !window.__tachyonExcalidraw) return;
        session.current = window.__tachyonExcalidraw.mount(host.current, {
          initialScene: request.initialScene,
          baseImage: request.baseImage,
          theme: "dark",
          onReady: () => setReady(true),
        });
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      session.current?.unmount();
      session.current = null;
    };
  }, [assets, request]);

  const save = async () => {
    try {
      const result = await session.current?.save();
      if (!result) throw new Error("Sketch editor is not ready");
      onSave(request, result);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div class="sketch-modal">
      <div class="sketch-bar">
        <strong>{request.name}</strong>
        <button class="ds-btn" type="button" onClick={onCancel}>Cancel</button>
        <button class="ds-btn primary" type="button" disabled={!ready || !!loadError} onClick={() => void save()}><Icon name="save" /> Save sketch</button>
      </div>
      <div class="sketch-host">
        {loadError && <div class="sketch-fail">{loadError}</div>}
        <div ref={host} />
      </div>
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

function attachmentPreview(att: PinStudioAttachmentVM): string | undefined {
  return att.kind === "image" ? att.uri : att.previewUri;
}

function attachmentSizeLabel(att: PinStudioAttachmentVM): string {
  return att.kind === "image" ? `${Math.round(att.size / 1024)} KB` : `${Math.round(att.previewSize / 1024)} KB preview`;
}

function uriToDataURL(uri: string, mediaType: string): Promise<string> {
  return fetch(uri)
    .then((response) => {
      if (!response.ok) throw new Error(`Unable to read image artifact (${response.status})`);
      return response.blob();
    })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const value = String(reader.result ?? "");
        resolve(dataURLWithMediaType(value, mediaType));
      };
      reader.readAsDataURL(blob);
    }));
}

let excalidrawLoad: Promise<void> | undefined;

function ensureExcalidraw(assets: PinStudioAssets): Promise<void> {
  if (window.__tachyonExcalidraw) return Promise.resolve();
  if (excalidrawLoad) return excalidrawLoad;
  window.EXCALIDRAW_ASSET_PATH = assets.excalidrawAssetPath;
  excalidrawLoad = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${cssEscape(assets.excalidrawCssUri)}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = assets.excalidrawCssUri;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = assets.excalidrawScriptUri;
    script.onload = () => window.__tachyonExcalidraw ? resolve() : reject(new Error("Excalidraw bundle loaded without registering the Tachyon bridge"));
    script.onerror = () => reject(new Error("Failed to load Excalidraw bundle"));
    document.body.appendChild(script);
  });
  return excalidrawLoad;
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
