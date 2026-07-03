import type { Editor } from "@tiptap/core";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface EditorToolbarProps {
  run: (fn: (editor: Editor) => void) => void;
  onOpenSketch: () => void;
  onToggleSlash: () => void;
}

/** The pin/task studio formatting toolbar (bold/italic/code/lists/checklist/quote/sketch/slash) — entity-neutral. */
export function EditorToolbar({ run, onOpenSketch, onToggleSlash }: EditorToolbarProps) {
  return (
    <div class="toolbar" aria-label="Formatting">
      <button title="Bold" onClick={() => run((e) => e.chain().focus().toggleBold().run())}><strong>B</strong></button>
      <button title="Italic" onClick={() => run((e) => e.chain().focus().toggleItalic().run())}><em>I</em></button>
      <button title="Code" onClick={() => run((e) => e.chain().focus().toggleCode().run())}><Icon name="code" /></button>
      <button title="Bulleted list" onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}><Icon name="list-unordered" /></button>
      <button title="Numbered list" onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}><Icon name="list-ordered" /></button>
      <button title="Task list" onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><Icon name="checklist" /></button>
      <button title="Block quote" onClick={() => run((e) => e.chain().focus().toggleBlockquote().run())}><Icon name="quote" /></button>
      <button title="Insert sketch" onClick={onOpenSketch}><Icon name="edit" /></button>
      <button title="Slash commands" onClick={onToggleSlash}><Icon name="symbol-keyword" /></button>
    </div>
  );
}

export interface SlashMenuProps {
  run: (fn: (editor: Editor) => void) => void;
  onOpenSketch: () => void;
}

/** open when EditorToolbarProps.slashOpen is true. */
export function SlashMenu({ run, onOpenSketch }: SlashMenuProps) {
  return (
    <div class="slash">
      <button onClick={() => run((e) => e.chain().focus().setParagraph().run())}><Icon name="text-size" /> Paragraph</button>
      <button onClick={() => run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}><Icon name="symbol-string" /> Heading</button>
      <button onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}><Icon name="list-unordered" /> Bulleted list</button>
      <button onClick={() => run((e) => e.chain().focus().toggleTaskList().run())}><Icon name="checklist" /> Task list</button>
      <button onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}><Icon name="code" /> Code block</button>
      <button onClick={onOpenSketch}><Icon name="edit" /> Sketch</button>
    </div>
  );
}
