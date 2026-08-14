import { describe, it, expect } from "vitest";
import { docToMarkdown, truncateBody, TASK_BODY_MAX_CODEPOINTS, TRUNCATION_MARKER } from "@tachyon/shared/tasks/docMarkdown.js";
import type { TiptapJSON } from "@tachyon/shared/richDoc/types.js";

const doc = (...content: TiptapJSON[]): TiptapJSON => ({ type: "doc", content });
const p = (...content: TiptapJSON[]): TiptapJSON => ({ type: "paragraph", content });
const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>): TiptapJSON => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

describe("docToMarkdown — per-node serialization", () => {
  it("serializes a plain paragraph", () => {
    expect(docToMarkdown(doc(p(text("hello world"))))).toBe("hello world");
  });

  it("serializes multiple paragraphs separated by a blank line", () => {
    expect(docToMarkdown(doc(p(text("one")), p(text("two"))))).toBe("one\n\ntwo");
  });

  it("serializes headings 1-3", () => {
    expect(docToMarkdown(doc({ type: "heading", attrs: { level: 1 }, content: [text("H1")] }))).toBe("# H1");
    expect(docToMarkdown(doc({ type: "heading", attrs: { level: 2 }, content: [text("H2")] }))).toBe("## H2");
    expect(docToMarkdown(doc({ type: "heading", attrs: { level: 3 }, content: [text("H3")] }))).toBe("### H3");
  });

  it("serializes bold, italic, and code marks", () => {
    expect(docToMarkdown(doc(p(text("bold", [{ type: "bold" }]))))).toBe("**bold**");
    expect(docToMarkdown(doc(p(text("italic", [{ type: "italic" }]))))).toBe("_italic_");
    expect(docToMarkdown(doc(p(text("code", [{ type: "code" }]))))).toBe("`code`");
  });

  it("combines bold and italic on the same run", () => {
    expect(docToMarkdown(doc(p(text("both", [{ type: "italic" }, { type: "bold" }]))))).toBe("**_both_**");
  });

  it("serializes a link mark", () => {
    expect(docToMarkdown(doc(p(text("click", [{ type: "link", attrs: { href: "https://x.com" } }]))))).toBe("[click](https://x.com)");
  });

  it("escapes markdown-significant characters in plain text but not inside code", () => {
    expect(docToMarkdown(doc(p(text("1 * 2 and _x_ and [y]"))))).toBe("1 \\* 2 and \\_x\\_ and \\[y\\]");
    expect(docToMarkdown(doc(p(text("a*b", [{ type: "code" }]))))).toBe("`a*b`");
  });

  it("serializes a bulleted list", () => {
    const list: TiptapJSON = { type: "bulletList", content: [{ type: "listItem", content: [p(text("a"))] }, { type: "listItem", content: [p(text("b"))] }] };
    expect(docToMarkdown(doc(list))).toBe("- a\n- b");
  });

  it("serializes an ordered list honoring a non-default start", () => {
    const list: TiptapJSON = { type: "orderedList", attrs: { start: 5 }, content: [{ type: "listItem", content: [p(text("a"))] }, { type: "listItem", content: [p(text("b"))] }] };
    expect(docToMarkdown(doc(list))).toBe("5. a\n6. b");
  });

  it("serializes a checklist with mixed checked state", () => {
    const list: TiptapJSON = {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] },
        { type: "taskItem", attrs: { checked: false }, content: [p(text("todo"))] },
      ],
    };
    expect(docToMarkdown(doc(list))).toBe("- [x] done\n- [ ] todo");
  });

  it("serializes a nested list inside a list item", () => {
    const nested: TiptapJSON = { type: "bulletList", content: [{ type: "listItem", content: [p(text("nested"))] }] };
    const list: TiptapJSON = { type: "bulletList", content: [{ type: "listItem", content: [p(text("outer")), nested] }] };
    expect(docToMarkdown(doc(list))).toBe("- outer\n  - nested");
  });

  it("serializes a blockquote", () => {
    expect(docToMarkdown(doc({ type: "blockquote", content: [p(text("quoted"))] }))).toBe("> quoted");
  });

  it("serializes a multi-paragraph blockquote", () => {
    expect(docToMarkdown(doc({ type: "blockquote", content: [p(text("one")), p(text("two"))] }))).toBe("> one\n>\n> two");
  });

  it("serializes a code block with a language", () => {
    expect(docToMarkdown(doc({ type: "codeBlock", attrs: { language: "js" }, content: [text("console.log(1)")] }))).toBe("```js\nconsole.log(1)\n```");
  });

  it("serializes a code block without a language", () => {
    expect(docToMarkdown(doc({ type: "codeBlock", content: [text("plain")] }))).toBe("```\nplain\n```");
  });

  it("serializes an image as a logical attachment reference, never a filesystem path", () => {
    expect(docToMarkdown(doc(p({ type: "image", attrs: { attachmentId: "att-abc123", alt: "shot", src: "https://webview-uri/whatever" } })))).toBe("![shot](attachment:att-abc123)");
  });

  it("serializes a sketch as the bespoke one-line marker", () => {
    expect(docToMarkdown(doc({ type: "tachyonSketch", attrs: { attachmentId: "att-def456" } }))).toBe("[sketch: att-def456]");
  });

  it("serializes a hard break", () => {
    expect(docToMarkdown(doc(p(text("line one"), { type: "hardBreak" }, text("line two"))))).toBe("line one  \nline two");
  });

  it("serializes a horizontal rule", () => {
    expect(docToMarkdown(doc({ type: "horizontalRule" }))).toBe("---");
  });

  it("never drops content from an unsupported node type (best-effort text fallback)", () => {
    const weird: TiptapJSON = { type: "somethingUnsupported", content: [p(text("kept"))] };
    expect(docToMarkdown(doc(weird))).toBe("kept");
  });

  it("renders an empty doc as an empty string", () => {
    expect(docToMarkdown({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
  });
});

describe("truncateBody — exact boundary rules (spec F3/F20)", () => {
  it("leaves a body at or under the limit completely unchanged", () => {
    const body = "x".repeat(TASK_BODY_MAX_CODEPOINTS);
    expect(truncateBody(body)).toBe(body);
    expect(truncateBody("short")).toBe("short");
  });

  it("truncates so the TOTAL length including the marker is within the limit", () => {
    const body = "y".repeat(TASK_BODY_MAX_CODEPOINTS + 500);
    const result = truncateBody(body);
    expect(Array.from(result).length).toBeLessThanOrEqual(TASK_BODY_MAX_CODEPOINTS);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("prefers a block boundary (blank line) over a mid-word hard cut", () => {
    const markerLen = Array.from(TRUNCATION_MARKER).length;
    const budget = TASK_BODY_MAX_CODEPOINTS - markerLen;
    // exactly one block boundary well inside the budget, then filler that pushes the total past the limit
    const before = "a".repeat(budget - 500);
    const body = `${before}\n\n${"b".repeat(2000)}`;
    const result = truncateBody(body);
    expect(result).toBe(`${before}${TRUNCATION_MARKER}`);
  });

  it("falls back to a single line boundary when no block boundary exists in budget", () => {
    const markerLen = Array.from(TRUNCATION_MARKER).length;
    const budget = TASK_BODY_MAX_CODEPOINTS - markerLen;
    // exactly one line boundary (no blank line anywhere) well inside the budget
    const before = "a".repeat(budget - 500);
    const body = `${before}\n${"b".repeat(2000)}`;
    const result = truncateBody(body);
    expect(result).toBe(`${before}${TRUNCATION_MARKER}`);
  });

  it("never splits a surrogate pair (astral emoji at the cut boundary)", () => {
    const emoji = "😀"; // a single code point, two UTF-16 code units
    const filler = emoji.repeat(3000);
    const result = truncateBody(filler);
    // every remaining code point in the prefix must be a complete, valid character (no lone surrogate)
    const prefix = result.slice(0, result.length - TRUNCATION_MARKER.length);
    expect([...prefix].every((ch) => ch.length <= 2 && !/[\uD800-\uDFFF]/.test(ch.length === 1 ? ch : ""))).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(TASK_BODY_MAX_CODEPOINTS);
  });

  it("closes an open fenced code block before the marker when it fits", () => {
    const markerLen = Array.from(TRUNCATION_MARKER).length;
    const budget = TASK_BODY_MAX_CODEPOINTS - markerLen;
    // an open fence starting well before the budget, with no closing fence or blank line before the cut
    const before = "```js\n" + "code line without blank lines or closing fence ".repeat(200);
    const trimmedBefore = before.slice(0, budget - 300); // land the cut squarely inside the fence, no boundary nearby
    const body = trimmedBefore + "x".repeat(2000);
    const result = truncateBody(body);
    const beforeMarker = result.slice(0, result.length - TRUNCATION_MARKER.length);
    const fenceCount = (beforeMarker.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0); // fence was closed
    expect(beforeMarker.endsWith("\n```")).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(TASK_BODY_MAX_CODEPOINTS);
  });

  it("the marker itself is a stable, non-localized ASCII string", () => {
    expect(TRUNCATION_MARKER).toBe("\n\n[truncated: full doc in Task Studio]");
    expect(/^[\x00-\x7F]*$/.test(TRUNCATION_MARKER)).toBe(true);
  });
});
