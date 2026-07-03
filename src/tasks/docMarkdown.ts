import type { TiptapJSON } from "../richDoc/types.js";

/**
 * spec 339 (T4) — pure, DOM-free Tiptap-JSON → markdown serializer for the task fields the pin/task studio
 * toolbar exposes (paragraph, heading, bold/italic/code marks, links, bullet/ordered/checklist, blockquote,
 * code block, image → logical attachment ref, sketch → a bespoke one-line marker). No upstream markdown
 * serializer library — the node set is small and closed (plan.md's "Key decisions").
 *
 * Truncation (spec F3/F20): total output ≤4000 code points INCLUDING the marker, cut preferring a block
 * boundary then a line boundary, never splitting a surrogate pair, closing an open fenced code block before
 * the marker when it fits. The marker is a stable, non-localized ASCII string so it's machine-detectable.
 */

export const TASK_BODY_MAX_CODEPOINTS = 4000;
export const TRUNCATION_MARKER = "\n\n[truncated: full doc in Task Studio]";

export function docToMarkdown(doc: TiptapJSON): string {
  return truncateBody(serializeDoc(doc));
}

/** Exported separately so truncation-boundary behavior is unit-testable independent of the serializer. */
export function truncateBody(full: string): string {
  const codePoints = Array.from(full);
  if (codePoints.length <= TASK_BODY_MAX_CODEPOINTS) return full;

  const markerLen = Array.from(TRUNCATION_MARKER).length;
  const budget = Math.max(0, TASK_BODY_MAX_CODEPOINTS - markerLen);
  let prefix = codePoints.slice(0, budget).join("");

  // prefer a block boundary (blank line), then a line boundary, scanning backward within the budgeted cut
  const blockIdx = prefix.lastIndexOf("\n\n");
  const lineIdx = prefix.lastIndexOf("\n");
  if (blockIdx > 0) prefix = prefix.slice(0, blockIdx);
  else if (lineIdx > 0) prefix = prefix.slice(0, lineIdx);

  // close an open fenced code block before the marker, but only when it still fits the budget
  const fenceCount = (prefix.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    const closing = "\n```";
    if (Array.from(prefix).length + Array.from(closing).length + markerLen <= TASK_BODY_MAX_CODEPOINTS) {
      prefix += closing;
    }
  }

  let result = prefix + TRUNCATION_MARKER;
  const resultLen = Array.from(result).length;
  if (resultLen > TASK_BODY_MAX_CODEPOINTS) {
    // pathological safety net (shouldn't trigger given the budget math above) — hard-clamp without splitting a surrogate pair
    result = Array.from(result).slice(0, TASK_BODY_MAX_CODEPOINTS - markerLen).join("") + TRUNCATION_MARKER;
  }
  return result;
}

function serializeDoc(doc: TiptapJSON): string {
  return (doc.content ?? [])
    .map((node) => serializeBlock(node, ""))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function serializeBlock(node: TiptapJSON, indent: string): string {
  switch (node.type) {
    case "paragraph":
      return indent + serializeInline(node.content ?? []);
    case "heading": {
      const level = clamp(Number(node.attrs?.level) || 1, 1, 6);
      return `${indent}${"#".repeat(level)} ${serializeInline(node.content ?? [])}`;
    }
    case "blockquote": {
      const inner = (node.content ?? []).map((c) => serializeBlock(c, "")).filter(Boolean).join("\n\n");
      return inner
        .split("\n")
        .map((line) => (line ? `${indent}> ${line}` : `${indent}>`))
        .join("\n");
    }
    case "codeBlock": {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `${indent}\`\`\`${language}\n${text}\n${indent}\`\`\``;
    }
    case "bulletList":
      return (node.content ?? []).map((li) => serializeListItem(li, "- ", indent)).filter(Boolean).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start) || 1;
      return (node.content ?? [])
        .map((li, i) => serializeListItem(li, `${start + i}. `, indent))
        .filter(Boolean)
        .join("\n");
    }
    case "taskList":
      return (node.content ?? []).map((li) => serializeTaskItem(li, indent)).filter(Boolean).join("\n");
    case "image":
      return serializeImage(node);
    case "tachyonSketch":
      return serializeSketch(node);
    case "horizontalRule":
      return `${indent}---`;
    default:
      return flattenText(node);
  }
}

function serializeListItem(item: TiptapJSON, marker: string, indent: string): string {
  const [first, ...rest] = item.content ?? [];
  const firstLine = `${indent}${marker}${first ? serializeInline(first.content ?? []) : ""}`;
  const childIndent = indent + " ".repeat(marker.length);
  const nested = rest.map((c) => serializeBlock(c, childIndent)).filter(Boolean);
  return [firstLine, ...nested].join("\n");
}

function serializeTaskItem(item: TiptapJSON, indent: string): string {
  const checked = item.attrs?.checked === true;
  const marker = checked ? "- [x] " : "- [ ] ";
  const [first, ...rest] = item.content ?? [];
  const firstLine = `${indent}${marker}${first ? serializeInline(first.content ?? []) : ""}`;
  const childIndent = `${indent}  `;
  const nested = rest.map((c) => serializeBlock(c, childIndent)).filter(Boolean);
  return [firstLine, ...nested].join("\n");
}

function serializeImage(node: TiptapJSON): string {
  const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  const attachmentId = typeof node.attrs?.attachmentId === "string" ? node.attrs.attachmentId : undefined;
  const ref = attachmentId ? `attachment:${attachmentId}` : typeof node.attrs?.src === "string" ? node.attrs.src : "";
  return `![${alt}](${ref})`;
}

function serializeSketch(node: TiptapJSON): string {
  const attachmentId = typeof node.attrs?.attachmentId === "string" ? node.attrs.attachmentId : "";
  return `[sketch: ${attachmentId}]`;
}

function serializeInline(nodes: TiptapJSON[]): string {
  return nodes.map(serializeInlineNode).join("");
}

function serializeInlineNode(node: TiptapJSON): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "image") return serializeImage(node);
  if (node.type !== "text") return "";
  const marks = node.marks ?? [];
  const hasCode = marks.some((m) => m.type === "code");
  const link = marks.find((m) => m.type === "link");
  let text: string;
  if (hasCode) {
    text = `\`${node.text ?? ""}\``;
  } else {
    text = escapeMarkdown(node.text ?? "");
    if (marks.some((m) => m.type === "italic")) text = `_${text}_`;
    if (marks.some((m) => m.type === "bold")) text = `**${text}**`;
  }
  if (link && typeof link.attrs?.href === "string") text = `[${text}](${link.attrs.href})`;
  return text;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]]/g, (ch) => `\\${ch}`);
}

/** Fallback for any node type outside the supported set — preserve raw text so nothing is silently dropped. */
function flattenText(node: TiptapJSON): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(flattenText).join("");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
