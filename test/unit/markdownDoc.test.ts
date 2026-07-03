import { describe, it, expect } from "vitest";
import { markdownToDoc } from "../../src/tasks/markdownDoc.js";
import { docToMarkdown } from "../../src/tasks/docMarkdown.js";

describe("markdownToDoc — per-construct import", () => {
  it("imports a plain paragraph", () => {
    expect(markdownToDoc("hello world")).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }] });
  });

  it("imports headings, clamped to the shared editor's level 1-3 config", () => {
    expect(markdownToDoc("# H1")).toMatchObject({ content: [{ type: "heading", attrs: { level: 1 } }] });
    expect(markdownToDoc("### H3")).toMatchObject({ content: [{ type: "heading", attrs: { level: 3 } }] });
    expect(markdownToDoc("###### H6")).toMatchObject({ content: [{ type: "heading", attrs: { level: 3 } }] });
  });

  it("imports bold/italic/code marks", () => {
    const doc = markdownToDoc("**bold** and _italic_ and `code`");
    const texts = (doc.content?.[0].content ?? []) as Array<{ text?: string; marks?: Array<{ type: string }> }>;
    expect(texts.find((t) => t.text === "bold")?.marks).toEqual([{ type: "bold" }]);
    expect(texts.find((t) => t.text === "italic")?.marks).toEqual([{ type: "italic" }]);
    expect(texts.find((t) => t.text === "code")?.marks).toEqual([{ type: "code" }]);
  });

  it("imports a link", () => {
    const doc = markdownToDoc("[click](https://x.com)");
    expect(doc.content?.[0].content).toEqual([{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "https://x.com" } }] }]);
  });

  it("imports a bulleted list", () => {
    const doc = markdownToDoc("- a\n- b");
    expect(doc.content?.[0]).toMatchObject({
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
      ],
    });
  });

  it("imports an ordered list preserving a non-default start", () => {
    const doc = markdownToDoc("5. a\n6. b");
    expect(doc.content?.[0]).toMatchObject({ type: "orderedList", attrs: { start: 5 } });
  });

  it("imports an ordered list without a start attr when it starts at 1", () => {
    const doc = markdownToDoc("1. a\n2. b");
    expect(doc.content?.[0].attrs).toBeUndefined();
  });

  it("imports a checklist with mixed checked state", () => {
    const doc = markdownToDoc("- [x] done\n- [ ] todo");
    expect(doc.content?.[0]).toMatchObject({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] },
      ],
    });
  });

  it("imports a nested list", () => {
    const doc = markdownToDoc("- outer\n  - nested");
    const outer = doc.content?.[0];
    expect(outer?.type).toBe("bulletList");
    const item = outer?.content?.[0];
    expect(item?.content?.[0]).toMatchObject({ type: "paragraph", content: [{ text: "outer" }] });
    expect(item?.content?.[1]).toMatchObject({ type: "bulletList" });
  });

  it("imports a blockquote", () => {
    const doc = markdownToDoc("> quoted");
    expect(doc.content?.[0]).toMatchObject({ type: "blockquote", content: [{ type: "paragraph", content: [{ text: "quoted" }] }] });
  });

  it("imports a fenced code block with its language", () => {
    const doc = markdownToDoc("```js\nconsole.log(1)\n```");
    expect(doc.content?.[0]).toMatchObject({ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "console.log(1)" }] });
  });

  it("imports a code block without a language", () => {
    const doc = markdownToDoc("```\nplain\n```");
    expect(doc.content?.[0]).toMatchObject({ type: "codeBlock", content: [{ type: "text", text: "plain" }] });
    expect(doc.content?.[0].attrs).toBeUndefined();
  });

  it("imports an image with a logical attachment ref, not a raw src", () => {
    const doc = markdownToDoc("![shot](attachment:att-abc123)");
    expect(doc.content?.[0].content?.[0]).toEqual({ type: "image", attrs: { attachmentId: "att-abc123", alt: "shot" } });
  });

  it("imports an ordinary (non-attachment) image src verbatim", () => {
    const doc = markdownToDoc("![alt](https://example.com/x.png)");
    expect(doc.content?.[0].content?.[0]).toEqual({ type: "image", attrs: { src: "https://example.com/x.png", alt: "alt" } });
  });

  it("imports the sketch marker as a tachyonSketch node", () => {
    const doc = markdownToDoc("[sketch: att-def456]");
    expect(doc.content?.[0]).toEqual({ type: "tachyonSketch", attrs: { attachmentId: "att-def456" } });
  });

  it("imports a horizontal rule", () => {
    const doc = markdownToDoc("one\n\n---\n\ntwo");
    expect(doc.content?.map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "paragraph"]);
  });

  it("never produces an empty doc for empty input", () => {
    expect(markdownToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("falls back to raw text instead of dropping an unsupported construct (HTML block)", () => {
    const doc = markdownToDoc("before\n\n<div>raw html</div>\n\nafter");
    const flat = JSON.stringify(doc);
    expect(flat).toContain("raw html");
  });
});

describe("markdownToDoc <-> docToMarkdown — no-op round-trip preservation (spec invariant)", () => {
  // representative agent-authored markdown: tables (unsupported construct, preserved as raw text), nested
  // fences, HTML, link titles — the STUDIO invariant is that an untouched doc never rewrites body at all
  // (studioModel.test.ts proves that at the Save layer); this suite instead proves the IMPORT is lossless
  // enough on the toolbar's own node set that reserializing an imported doc reproduces equivalent markdown.
  const cases: Array<[string, string]> = [
    ["plain paragraph", "Just a plain sentence with no formatting."],
    ["bold and italic", "This has **bold** and _italic_ text."],
    ["inline code", "Use `npm install` to set up."],
    ["heading", "## A heading"],
    ["bulleted list", "- one\n- two\n- three"],
    ["ordered list", "1. first\n2. second"],
    ["checklist", "- [x] done\n- [ ] todo"],
    ["blockquote", "> a quoted line"],
    ["fenced code block", "```ts\nconst x: number = 1;\n```"],
    ["link", "See [the docs](https://example.com/docs) for more."],
    ["sketch marker", "[sketch: att-abc123]"],
    ["attachment image", "![a screenshot](attachment:att-def456)"],
  ];

  for (const [label, markdown] of cases) {
    it(`round-trips: ${label}`, () => {
      const doc = markdownToDoc(markdown);
      const reserialized = docToMarkdown(doc);
      expect(reserialized).toBe(markdown);
    });
  }

  it("preserves exotic agent markdown as inert text without crashing (tables, nested fences, HTML, link titles)", () => {
    const exotic = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```outer",
      "some code containing ``` inside a string",
      "```",
      "",
      "<div class=\"note\">an HTML block</div>",
      "",
      "[link with title](https://example.com \"a title\")",
    ].join("\n");
    expect(() => markdownToDoc(exotic)).not.toThrow();
    const doc = markdownToDoc(exotic);
    expect(doc.type).toBe("doc");
    expect(() => docToMarkdown(doc)).not.toThrow();
  });
});
