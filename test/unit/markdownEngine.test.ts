import { describe, it, expect } from "vitest";
import { renderMarkdownHtml, segments } from "../../src/webview/activity/markdownEngine.js";

describe("markdownEngine (spec 238 inc 17)", () => {
  it("renders GFM tables", () => {
    const html = renderMarkdownHtml("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders task lists as checkbox inputs", () => {
    const html = renderMarkdownHtml("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked"); // the [x] item
    expect(html).toContain("contains-task-list");
  });

  it("renders blockquotes and headings", () => {
    expect(renderMarkdownHtml("> quote")).toContain("<blockquote>");
    expect(renderMarkdownHtml("## Heading")).toContain("<h2>");
  });

  it("emits a .codeblock with a copy button + hljs-highlighted code (not raw)", () => {
    const html = renderMarkdownHtml("```js\nconst x = 1;\n```");
    expect(html).toContain('class="codeblock"');
    expect(html).toContain('class="copy"');
    expect(html).toContain('class="hljs"');
    expect(html).toContain("hljs-keyword"); // `const` highlighted
  });

  it("emits lazy math placeholders (inline $…$ and display $$…$$), not rendered katex", () => {
    const inline = renderMarkdownHtml("mass $E=mc^2$ done");
    expect(inline).toContain('class="tac-math"');
    expect(inline).toContain('data-display="0"');
    expect(inline).toContain("data-tex=");
    const display = renderMarkdownHtml("$$\\int_0^1 x\\,dx$$");
    expect(display).toContain('data-display="1"');
  });

  it("escapes raw HTML (html:false) — no injection", () => {
    const html = renderMarkdownHtml("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("segments: splits top-level ```mermaid blocks from the surrounding markdown", () => {
    const segs = segments("intro text\n```mermaid\nflowchart TD\nA-->B\n```\noutro **bold**");
    expect(segs.map((s) => s.mermaid)).toEqual([false, true, false]);
    expect(segs[1].content).toBe("flowchart TD\nA-->B");
    expect(segs[0].content).toContain("intro text");
    expect(segs[2].content).toContain("outro **bold**");
  });

  it("segments: a message with no mermaid is a single md segment", () => {
    const segs = segments("just **markdown** here");
    expect(segs).toHaveLength(1);
    expect(segs[0].mermaid).toBe(false);
  });

  // The "all renders" validation: a single message exercising EVERY render the Activity view supports today.
  it("the full all-renders message produces every render type", () => {
    const message = [
      "## Health route — **bold**, *italic*, ~~strike~~",
      "",
      "| field | type | note |",
      "|---|---|---|",
      "| status | string | always \"ok\" |",
      "",
      "- [x] returns 200",
      "- [ ] auth",
      "",
      "> Note: uptime is process uptime.",
      "",
      "See the [Express docs](https://expressjs.com/).",
      "",
      "```js",
      "router.get('/', (req, res) => res.json({ status: 'ok' }));",
      "```",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "Inline $E=mc^2$ and display:",
      "",
      "$$\\int_0^1 x\\,dx = \\tfrac12$$",
      "",
      "```mermaid",
      "flowchart TD",
      "A-->B",
      "```",
    ].join("\n");

    const segs = segments(message);
    const mdHtml = segs.filter((s) => !s.mermaid).map((s) => renderMarkdownHtml(s.content)).join("\n");

    // chat markdown
    expect(mdHtml).toContain("<h2>");
    expect(mdHtml).toContain("<strong>");
    expect(mdHtml).toContain("<em>");
    expect(mdHtml).toMatch(/<s>|<del>/); // strikethrough
    // table
    expect(mdHtml).toContain("<table>");
    expect(mdHtml).toContain("<th>field</th>");
    // task list
    expect(mdHtml).toContain('type="checkbox"');
    expect(mdHtml).toContain("checked");
    // blockquote
    expect(mdHtml).toContain("<blockquote>");
    // link
    expect(mdHtml).toContain('href="https://expressjs.com/"');
    // code blocks (highlight + copy button)
    expect((mdHtml.match(/class="codeblock"/g) ?? []).length).toBe(2);
    expect(mdHtml).toMatch(/hljs-\w+/); // code got syntax-highlighted (some token span)
    // math inline + display
    expect(mdHtml).toContain('data-display="0"'); // $E=mc^2$
    expect(mdHtml).toContain('data-display="1"'); // $$…$$
    // mermaid extracted as its own segment
    const mermaid = segs.filter((s) => s.mermaid);
    expect(mermaid).toHaveLength(1);
    expect(mermaid[0].content).toContain("flowchart TD");
  });
});
