import { describe, expect, it } from "vitest";
import { renderMarkdownHtml } from "@tachyon/webview-ui/webview/activity/markdownEngine.js";
import { SANITIZE_ALLOWED_URI_REGEXP } from "@tachyon/webview-ui/webview/activity/markdownSanitizeConfig.js";

// spec 335/356 — the Task Detail body and task journal entries are agent/human-authored and rendered through
// the SAME pipeline Handoff/Activity use (MarkdownView: markdown-it html:false → DOMPurify). DOMPurify itself needs a real
// `window` and can't be imported in a node test (see markdownEngine.test.ts); this file proves the two
// node-testable layers that actually neutralize an attack: (1) markdown-it's html:false escapes any literal
// HTML the body contains — script/iframe/event-handler markup never becomes live DOM; (2) the DOMPurify
// ALLOWED_URI_REGEXP config (extracted pure so it's testable here) closes the URI-scheme gap markdown-it's own
// link validation leaves open (command:/vbscript:/data: — not just javascript:).

describe("markdown hardening — malicious payloads through the renderer (dueto F9)", () => {
  it("escapes a <script> tag embedded in the body — never live-executable", () => {
    const html = renderMarkdownHtml("before\n<script>alert(document.cookie)</script>\nafter");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an <iframe> embed — never a live frame", () => {
    const html = renderMarkdownHtml('<iframe src="https://evil.example/"></iframe>');
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("escapes an inline event-handler attribute (onerror/onload) — text, never a live tag", () => {
    const html = renderMarkdownHtml('<img src=x onerror="alert(1)"><svg onload="alert(2)"></svg>');
    // html:false escapes the angle brackets, so onerror/onload survive only as inert text content —
    // no `<img`/`<svg` markup (with a real `<`) ever reaches the DOM.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;svg");
  });

  it("neutralizes a javascript: link at the engine layer (no active href)", () => {
    const html = renderMarkdownHtml("[click me](javascript:alert(document.cookie))");
    expect(html).not.toContain('href="javascript:');
  });

  it("ALLOWED_URI_REGEXP rejects command:/vbscript:/data: — the gap markdown-it's own link validation leaves", () => {
    for (const scheme of ["command:workbench.action.terminal.new", "vbscript:msgbox(1)", "data:text/html,<script>1</script>", "file:///etc/passwd"]) {
      expect(SANITIZE_ALLOWED_URI_REGEXP.test(scheme)).toBe(false);
    }
  });

  it("ALLOWED_URI_REGEXP accepts the links a task body legitimately needs", () => {
    for (const scheme of ["https://example.com/spec", "http://localhost:3000", "mailto:someone@example.com", "#section"]) {
      expect(SANITIZE_ALLOWED_URI_REGEXP.test(scheme)).toBe(true);
    }
  });

  it("journal XSS cases are inert before Task Detail hands them to the shared sanitizer", () => {
    const cases = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "<b>inline html</b>",
      "<not-closed",
      "[bad](javascript:alert(1))",
    ];
    for (const text of cases) {
      const html = renderMarkdownHtml(text);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<b>");
      expect(html).not.toContain('href="javascript:');
    }
  });
});
