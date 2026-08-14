import MarkdownIt from "markdown-it";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";

type Token = ReturnType<MarkdownIt["parse"]>[number];

/**
 * spec 339 (T4) — pure, DOM-free markdown → Tiptap-JSON import via markdown-it's token stream (plan.md's
 * "the existing markdown-it token stream"). This is the REIMPORT path of the body-hash anchoring model: an
 * external (agent) edit to `task.body` always wins, and this is how that body becomes an editable doc again.
 * Fidelity beyond the toolbar's node set is best-effort (unsupported constructs fall back to raw text, never
 * silently dropped) — the no-op preservation invariant (studioModel.ts) is what actually protects content;
 * this module only needs to render something reasonable, not round-trip byte-for-byte.
 */

const md: MarkdownIt = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function markdownToDoc(markdown: string): TiptapJSON {
  const tokens = md.parse(markdown, {});
  const cursor = new Cursor(tokens);
  const content = parseBlocks(cursor);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

class Cursor {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  next(): Token {
    return this.tokens[this.i++];
  }
}

function parseBlocks(cursor: Cursor, stopType?: string): TiptapJSON[] {
  const nodes: TiptapJSON[] = [];
  while (cursor.peek() && (!stopType || cursor.peek()!.type !== stopType)) {
    const node = parseBlock(cursor);
    if (node) nodes.push(node);
  }
  if (stopType && cursor.peek()) cursor.next();
  return nodes;
}

function parseBlock(cursor: Cursor): TiptapJSON | null {
  const t = cursor.next();
  switch (t.type) {
    case "heading_open": {
      const level = clampHeadingLevel(Number(t.tag.slice(1)) || 1);
      const content = parseInlineAt(cursor);
      cursor.next(); // heading_close
      return { type: "heading", attrs: { level }, ...(content.length ? { content } : {}) };
    }
    case "paragraph_open": {
      const content = parseInlineAt(cursor);
      cursor.next(); // paragraph_close
      return maybeSketch(content) ?? { type: "paragraph", ...(content.length ? { content } : {}) };
    }
    case "blockquote_open": {
      const inner = parseBlocks(cursor, "blockquote_close");
      return { type: "blockquote", content: inner.length ? inner : [{ type: "paragraph" }] };
    }
    case "bullet_list_open": {
      const items = parseListItems(cursor, "bullet_list_close");
      if (items.length && items.every((item) => item.checked !== undefined)) {
        return { type: "taskList", content: items.map((item) => ({ type: "taskItem", attrs: { checked: item.checked === true }, content: item.content })) };
      }
      return { type: "bulletList", content: items.map((item) => ({ type: "listItem", content: item.content })) };
    }
    case "ordered_list_open": {
      const startAttr = t.attrGet ? t.attrGet("start") : null;
      const start = startAttr !== null ? Number(startAttr) : undefined;
      const items = parseListItems(cursor, "ordered_list_close");
      return {
        type: "orderedList",
        ...(start !== undefined && start !== 1 ? { attrs: { start } } : {}),
        content: items.map((item) => ({ type: "listItem", content: item.content })),
      };
    }
    case "fence":
    case "code_block": {
      const language = (t.info || "").trim().split(/\s+/)[0] || undefined;
      const text = stripOneTrailingNewline(t.content ?? "");
      return { type: "codeBlock", ...(language ? { attrs: { language } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) };
    }
    case "hr":
      return { type: "horizontalRule" };
    default:
      return t.content ? { type: "paragraph", content: [{ type: "text", text: t.content }] } : null;
  }
}

interface ListItemBlocks {
  checked?: boolean;
  content: TiptapJSON[];
}

function parseListItems(cursor: Cursor, stopType: string): ListItemBlocks[] {
  const items: ListItemBlocks[] = [];
  while (cursor.peek() && cursor.peek()!.type !== stopType) {
    cursor.next(); // list_item_open
    const blocks = parseBlocks(cursor, "list_item_close");
    items.push(extractTaskMarker(blocks));
  }
  if (cursor.peek()) cursor.next(); // stopType
  return items;
}

/** Detects the `- [ ] `/`- [x] ` prefix docMarkdown.ts emits for checklist items and strips it back off. */
function extractTaskMarker(blocks: TiptapJSON[]): ListItemBlocks {
  const first = blocks[0];
  const firstText = first?.type === "paragraph" ? first.content?.[0] : undefined;
  if (!firstText || firstText.type !== "text" || typeof firstText.text !== "string") return { content: blocks };
  const match = /^\[([ xX])]\s(.*)$/s.exec(firstText.text);
  if (!match) return { content: blocks };
  const checked = match[1].toLowerCase() === "x";
  const restText = match[2];
  const restContent = (first!.content ?? []).slice(1);
  const newContent = restText.length > 0 ? [{ ...firstText, text: restText }, ...restContent] : restContent;
  const newFirst: TiptapJSON = { ...first!, ...(newContent.length ? { content: newContent } : { content: undefined }) };
  if (!newContent.length) delete newFirst.content;
  return { checked, content: [newFirst, ...blocks.slice(1)] };
}

function parseInlineAt(cursor: Cursor): TiptapJSON[] {
  const inline = cursor.next(); // "inline" token
  return parseInline(inline);
}

function parseInline(inlineToken: Token): TiptapJSON[] {
  const nodes: TiptapJSON[] = [];
  const markStack: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
  for (const child of inlineToken.children ?? []) {
    switch (child.type) {
      case "text":
        if (child.content) nodes.push(textNode(child.content, markStack));
        break;
      case "softbreak":
        nodes.push(textNode(" ", markStack));
        break;
      case "hardbreak":
        nodes.push({ type: "hardBreak" });
        break;
      case "strong_open":
        markStack.push({ type: "bold" });
        break;
      case "strong_close":
        popMark(markStack, "bold");
        break;
      case "em_open":
        markStack.push({ type: "italic" });
        break;
      case "em_close":
        popMark(markStack, "italic");
        break;
      case "code_inline":
        nodes.push(textNode(child.content, [...markStack, { type: "code" }]));
        break;
      case "link_open":
        markStack.push({ type: "link", attrs: { href: child.attrGet ? child.attrGet("href") ?? "" : "" } });
        break;
      case "link_close":
        popMark(markStack, "link");
        break;
      case "image": {
        const src = child.attrGet ? child.attrGet("src") ?? "" : "";
        nodes.push(imageNodeFromSrc(src, child.content ?? ""));
        break;
      }
      default:
        if (child.content) nodes.push(textNode(child.content, markStack));
    }
  }
  return nodes;
}

function textNode(text: string, marks: Array<{ type: string; attrs?: Record<string, unknown> }>): TiptapJSON {
  return { type: "text", text, ...(marks.length ? { marks: marks.map((m) => ({ ...m })) } : {}) };
}

function popMark(stack: Array<{ type: string }>, type: string): void {
  const idx = stack.map((m) => m.type).lastIndexOf(type);
  if (idx >= 0) stack.splice(idx, 1);
}

function imageNodeFromSrc(src: string, alt: string): TiptapJSON {
  const match = /^attachment:(.+)$/.exec(src);
  if (match) return { type: "image", attrs: { attachmentId: match[1], alt } };
  return { type: "image", attrs: { src, alt } };
}

/** Detects the `[sketch: <id>]` one-line marker docMarkdown.ts emits when it's the sole paragraph content. */
function maybeSketch(content: TiptapJSON[]): TiptapJSON | undefined {
  if (content.length !== 1 || content[0].type !== "text") return undefined;
  const match = /^\[sketch: (\S+)]$/.exec(content[0].text ?? "");
  if (!match) return undefined;
  return { type: "tachyonSketch", attrs: { attachmentId: match[1] } };
}

function clampHeadingLevel(level: number): number {
  // the shared editor is configured for heading levels 1-3 (rich-doc/tiptap.ts); clamp a wider agent-authored
  // level down rather than producing a doc the editor schema doesn't recognize (documented lossy import).
  return Math.min(3, Math.max(1, level));
}

function stripOneTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
