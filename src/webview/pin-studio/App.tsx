import { useEffect, useRef, useState } from "preact/hooks";
import type { Editor } from "@tiptap/core";
import type { PinStudioAttachmentVM, PinStudioVM, PinStudioWebviewMessage } from "./types";
import { createPinEditor } from "./tiptap";
import { attachmentFromVM, toEditorDoc, toStoredDoc } from "./document";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface PinStudioDispatch {
  post(msg: PinStudioWebviewMessage): void;
}

export function App({ vm, dispatch, hostError }: { vm?: PinStudioVM; dispatch: PinStudioDispatch; hostError?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [title, setTitle] = useState("");
  const [attachments, setAttachments] = useState<PinStudioAttachmentVM[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [slashOpen, setSlashOpen] = useState(false);

  useEffect(() => {
    if (!vm || !mount.current) return;
    setTitle(vm.title);
    setAttachments(vm.attachments);
    setError(undefined);
    editorRef.current?.destroy();
    editorRef.current = createPinEditor(
      mount.current,
      toEditorDoc(vm.doc, vm.attachments),
      (file, source) => void attachFile(file, source),
      () => setSlashOpen(true),
    );
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [vm?.workspaceHash, vm?.pinId, vm?.mode]);

  useEffect(() => {
    if (hostError) setError(hostError);
  }, [hostError]);

  const attachFile = async (file: File, source: "paste" | "drop") => {
    if (!ALLOWED.has(file.type)) { setError(`Unsupported image type: ${file.type || "unknown"}`); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError("Image exceeds the 10 MB limit"); return; }
    const dataBase64 = await fileToBase64(file);
    dispatch.post({ type: "attachImage", mediaType: file.type, name: file.name, source, dataBase64 });
  };

  const insertAttachment = (att: PinStudioAttachmentVM) => {
    setAttachments((cur) => [...cur.filter((a) => a.id !== att.id), att]);
    editorRef.current?.chain().focus().setImage({
      src: att.uri ?? att.path,
      alt: att.name,
      title: att.name,
    }).updateAttributes("image", { attachmentId: att.id, blobRef: att.blobRef }).run();
  };

  useEffect(() => {
    (window as unknown as { __tachyonPinStored?: (att: PinStudioAttachmentVM) => void }).__tachyonPinStored = insertAttachment;
    return () => { delete (window as unknown as { __tachyonPinStored?: unknown }).__tachyonPinStored; };
  }, []);

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
    const doc = toStoredDoc((editorRef.current?.getJSON() ?? { type: "doc", content: [] }) as never);
    dispatch.post({ type: "save", title: trimmed, doc, attachments: attachments.map(attachmentFromVM) });
  };

  return (
    <div class="studio">
      <header class="bar">
        <div>
          <div class="eyebrow">{vm.mode === "new" ? "New pin" : `Editing ${vm.pinId}`}</div>
          <input class="title" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} placeholder="Pin title" aria-label="Pin title" />
        </div>
        <div class="actions">
          <button class="ds-btn" type="button" onClick={() => dispatch.post({ type: "importImage" })}><Icon name="file-media" /> Import</button>
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
        <button title="Slash commands" onClick={() => setSlashOpen((v) => !v)}><Icon name="symbol-keyword" /></button>
      </div>

      {slashOpen && (
        <div class="slash">
          <button onClick={() => run((e) => e.chain().focus().setParagraph().run())}><Icon name="text-size" /> Paragraph</button>
          <button onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}><Icon name="symbol-string" /> Heading</button>
          <button onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}><Icon name="list-unordered" /> Bulleted list</button>
          <button onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><Icon name="checklist" /> Task list</button>
          <button onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}><Icon name="code" /> Code block</button>
        </div>
      )}

      <main>
        <div class="editor-shell" onDragOver={(e) => e.preventDefault()}>
          <div ref={mount} />
        </div>
        <aside>
          <button class="drop" type="button" onClick={() => dispatch.post({ type: "importImage" })}>
            <Icon name="cloud-upload" />
            <span>Paste, drop, or import screenshots</span>
          </button>
          <div class="att-head">Images · {attachments.length}</div>
          {attachments.length === 0 ? <div class="ds-dim">No screenshots attached.</div> : attachments.map((a) => (
            <div class="att" key={a.id}>
              {a.uri ? <img src={a.uri} alt="" /> : <span class="missing"><Icon name="warning" /></span>}
              <div><div class="att-name">{a.name}</div><div class="ds-dim">{Math.round(a.size / 1024)} KB</div></div>
            </div>
          ))}
        </aside>
      </main>
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
