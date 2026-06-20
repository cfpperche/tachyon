import type { ComponentChildren } from "preact";

/**
 * A compact, SAFE markdown renderer for activity bubbles (spec 238 #1). Produces Preact vnodes (text is
 * escaped by Preact — no innerHTML), covering the high-value subset: code fences, inline code, bold/italic,
 * links + bare URLs, ordered/unordered lists, headings, paragraphs. Not full CommonMark — enough to make
 * agent messages readable instead of showing raw **bold** and dead URLs.
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/;

/** Inline spans: code / bold / italic / links / bare URLs. */
export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let rest = text;
  let key = 0;
  while (rest.length) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (mm) out.push(<a key={key++} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
      else out.push(tok);
    } else out.push(<a key={key++} href={tok} target="_blank" rel="noreferrer">{tok}</a>);
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

/** Block-level markdown → vnodes. */
export function renderMarkdown(text: string): ComponentChildren {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ComponentChildren[] = [];
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i++; }
      i++; // closing fence
      blocks.push(<pre key={key++}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { blocks.push(<div key={key++} class="md-h">{inline(h[2])}</div>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const lis: ComponentChildren[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        lis.push(<li key={lis.length}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key++}>{lis}</ol> : <ul key={key++}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i].trim()) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push(<p key={key++}>{inline(para.join("\n"))}</p>);
  }
  return blocks;
}
