import { Editor, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import FileHandler from "@tiptap/extension-file-handler";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import type { TiptapJSON } from "../../pins/types";
import { EMPTY_DOC } from "./document";

const PinImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: { attachmentId?: string | null }) => attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {},
      },
      blobRef: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-blob-ref"),
        renderHTML: (attrs: { blobRef?: string | null }) => attrs.blobRef ? { "data-blob-ref": attrs.blobRef } : {},
      },
    };
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
});

export const PinSketch = Node.create({
  name: "tachyonSketch",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs: { attachmentId?: string | null }) => attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {},
      },
      previewSrc: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-preview-src"),
        renderHTML: (attrs: { previewSrc?: string | null }) => attrs.previewSrc ? { "data-preview-src": attrs.previewSrc } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "figure[data-tachyon-sketch]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const src = typeof HTMLAttributes.previewSrc === "string"
      ? HTMLAttributes.previewSrc
      : typeof HTMLAttributes["data-preview-src"] === "string"
        ? HTMLAttributes["data-preview-src"]
        : "";
    return [
      "figure",
      mergeAttributes(HTMLAttributes, { "data-tachyon-sketch": "true", class: "tachyon-sketch-node" }),
      src ? ["img", { src, alt: "Pin sketch preview" }] : ["div", { class: "tachyon-sketch-missing" }, "Sketch preview unavailable"],
    ];
  },
});

export function createPinEditor(
  element: HTMLElement,
  doc: TiptapJSON | null,
  onFile: (file: File, source: "paste" | "drop") => void,
  onSlash: () => void,
  onChange: () => void = () => {},
): Editor {
  return new Editor({
    element,
    content: doc ?? EMPTY_DOC,
    onUpdate: onChange,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: "Write details, paste a screenshot, or type / for blocks..." }),
      Link.configure({ openOnClick: false }),
      PinImage.configure({ allowBase64: false }),
      PinSketch,
      TaskList,
      TaskItem.configure({ nested: true }),
      FileHandler.configure({
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        onPaste: (_editor, files) => files.forEach((file) => onFile(file, "paste")),
        onDrop: (_editor, files) => files.forEach((file) => onFile(file, "drop")),
      }),
    ],
    editorProps: {
      attributes: { class: "pin-editor" },
      handleKeyDown: (_view, event) => {
        if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          setTimeout(onSlash, 0);
        }
        return false;
      },
    },
  });
}
