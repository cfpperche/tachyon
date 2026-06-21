// Pure markdown rendering engine (spec 238 inc 17) — markdown-it → HTML string, no DOM/preact/sanitize.
// Split out so it's unit-testable in node (the webview's markdown.tsx adds DOMPurify + the Preact components).
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import texmath from "markdown-it-texmath";
import taskLists from "markdown-it-task-lists";

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** Syntax-highlight to an escaped HTML string (hljs escapes the code → safe to inject after sanitize). */
export function highlight(code: string, lang?: string): string {
  if (code.length > 20000) return esc(code); // skip the costly highlightAuto on huge blocks (perf)
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return esc(code);
  }
}

// Math via texmath, but a STUB engine: instead of katex at parse time (sync), emit a placeholder span carrying
// the TeX — katex renders it later, lazily (markdown.tsx renderMath). Keeps the bundle katex-free at parse.
const mathStub = {
  renderToString(tex: string, opts?: { displayMode?: boolean }): string {
    return `<span class="tac-math" data-display="${opts?.displayMode ? 1 : 0}" data-tex="${escAttr(tex)}"></span>`;
  },
};

const md: MarkdownIt = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.use(texmath, { engine: mathStub, delimiters: "dollars" });
md.use(taskLists, { enabled: true });
// Code fences → the .codeblock structure with a copy button + hljs highlighting (copy wired via delegation).
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = (t.info || "").trim().split(/\s+/)[0].replace(/^language-/, "");
  return `<div class="codeblock"><button class="copy" type="button" title="Copy code" aria-label="Copy code"><span class="codicon codicon-copy"></span></button><pre><code class="hljs">${highlight(t.content, lang)}</code></pre></div>`;
};

/**
 * markdown-it-task-lists emits a non-interactive `<input type=checkbox>` with malformed (space-less) markup
 * — `<input class="task-list-item-checkbox"type="checkbox">` — which renders as a stray empty text box after
 * sanitize. A transcript is read-only, so we render the checkbox as a styled glyph span instead: robust HTML
 * (no attribute-parsing recovery) that matches the codicon UI. `.task-check[.checked]` is styled in the panel.
 */
function fixTaskCheckboxes(html: string): string {
  return html.replace(/<input\b[^>]*\bclass="task-list-item-checkbox"[^>]*>/g, (tag) =>
    /\bchecked\b/.test(tag)
      ? '<span class="task-check checked" aria-hidden="true"></span>'
      : '<span class="task-check" aria-hidden="true"></span>',
  );
}

/** Render markdown text to an (unsanitized) HTML string. */
export function renderMarkdownHtml(text: string): string {
  return fixTaskCheckboxes(md.render(text));
}

export interface Segment { mermaid: boolean; content: string }
/** Split a message on top-level ```mermaid fences so those render as diagrams and the rest as markdown. */
export function segments(text: string): Segment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segs: Segment[] = [];
  let buf: string[] = [];
  const flush = (): void => { if (buf.length) { segs.push({ mermaid: false, content: buf.join("\n") }); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    if (/^```mermaid\s*$/.test(lines[i].trim())) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i++; }
      segs.push({ mermaid: true, content: body.join("\n") });
      continue; // i is on the closing ``` (or past end); the for-loop ++ skips it
    }
    buf.push(lines[i]);
  }
  flush();
  return segs;
}
