import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import hljs from "highlight.js/lib/common";

// Mermaid is loaded ON DEMAND (its ~3MB iife is injected as a <script> only when the first ```mermaid block
// appears) and cached. window.* globals are seeded by the host html.
declare global {
  // eslint-disable-next-line no-var
  interface Window { mermaid?: { initialize(c: unknown): void; render(id: string, src: string): Promise<{ svg: string }> }; __mermaidSrc?: string; __codeThemeForced?: string }
}
let mermaidLoad: Promise<NonNullable<Window["mermaid"]>> | null = null;
let mermaidReady = false;
let mmdSeq = 0;
const SVG_CACHE_MAX = 64;
const svgCache = new Map<string, string>(); // keyed by `${theme}::${code}` so a theme switch never serves stale colors
function cacheSvg(key: string, svg: string): void {
  if (svgCache.size >= SVG_CACHE_MAX) { const oldest = svgCache.keys().next().value; if (oldest) svgCache.delete(oldest); }
  svgCache.set(key, svg);
}

function mermaidTheme(): "default" | "dark" {
  const forced = window.__codeThemeForced;
  if (forced === "light") return "default";
  if (forced === "dark") return "dark";
  return document.body.classList.contains("vscode-light") ? "default" : "dark";
}

function loadMermaid(): Promise<NonNullable<Window["mermaid"]>> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise((resolve, reject) => {
    const src = window.__mermaidSrc;
    if (!src) { reject(new Error("no mermaid source")); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error("mermaid missing")));
    s.onerror = () => reject(new Error("mermaid load failed"));
    document.head.appendChild(s);
  });
  return mermaidLoad;
}

/** A ```mermaid block rendered to SVG (securityLevel strict). Caches by content; falls back to the code
 *  block on a load/parse failure or when the user asks for the source — never breaks the view. */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(`${mermaidTheme()}::${code}`) ?? null);
  const [failed, setFailed] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    // Reset per-code so a refreshed/streamed block that first failed recovers when valid content arrives.
    const key = `${mermaidTheme()}::${code}`;
    const cached = svgCache.get(key);
    setSvg(cached ?? null); setFailed(false); setRaw(false);
    if (cached) return;
    let alive = true;
    loadMermaid()
      .then((m) => {
        if (!mermaidReady) { m.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() }); mermaidReady = true; }
        return m.render(`tac-mmd-${mmdSeq++}`, code);
      })
      .then((res) => { if (alive) { cacheSvg(key, res.svg); setSvg(res.svg); } }) // `alive` drops stale results
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [code]);

  if (failed || raw) {
    return (
      <div class="mmd-src">
        {!failed && <button class="mmd-back" title="Show diagram" onClick={() => setRaw(false)}><span class="codicon codicon-graph" /> diagram</button>}
        <CodeBlock code={code} lang="mermaid" />
      </div>
    );
  }
  if (!svg) return <div class="mmd-loading"><span class="codicon codicon-loading" /> rendering diagram…</div>;
  return (
    <div class="mmd">
      <button class="rawtoggle" title="Show source" aria-label="Show mermaid source" onClick={() => setRaw(true)}><span class="codicon codicon-code" /></button>
      <div class="mmd-svg" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));

/** Syntax-highlight to an escaped HTML string (hljs escapes the code → safe for dangerouslySetInnerHTML). */
function highlight(code: string, lang?: string): string {
  if (code.length > 20000) return esc(code); // skip the costly highlightAuto on huge blocks (perf)
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return esc(code);
  }
}

/** A fenced code block: syntax-highlighted (highlight.js) + a copy-to-clipboard button (visible feedback). */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const copy = () => {
    const done = (s: "ok" | "fail") => { setState(s); setTimeout(() => setState("idle"), 1200); };
    // navigator.clipboard can reject in a webview (focus/permission) — surface the failure, never swallow it.
    const p = navigator.clipboard?.writeText(code);
    if (p) p.then(() => done("ok")).catch(() => done("fail"));
    else done("fail");
  };
  const icon = state === "ok" ? "check" : state === "fail" ? "error" : "copy";
  // Memoize so we don't re-run highlight.js on every chat re-render (only when this block's code changes).
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div class="codeblock">
      <button class={`copy${state === "fail" ? " fail" : ""}`} title={state === "fail" ? "Copy failed" : "Copy code"} aria-label="Copy code" onClick={copy}>
        <span class={`codicon codicon-${icon}`} />
      </button>
      <pre><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

/**
 * A compact, SAFE markdown renderer for activity bubbles (spec 238 #1). Produces Preact vnodes (text is
 * escaped by Preact — no innerHTML), covering the high-value subset: code fences, inline code, bold/italic,
 * links + bare URLs, ordered/unordered lists, headings, paragraphs. Not full CommonMark — enough to make
 * agent messages readable instead of showing raw **bold** and dead URLs.
 */

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/;

/** Only http(s) targets are linked — never javascript:/command:/file: etc. */
function isWebUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

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
      // Only link safe web schemes — a transcript could carry javascript:/command:/file: targets.
      if (mm && isWebUrl(mm[2])) out.push(<a key={key++} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
      else if (mm) out.push(mm[1]);
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
    const fence = /^```([\w+#-]+)?/.exec(line.trim());
    if (fence) {
      const lang = fence[1]?.replace(/^language-/, ""); // normalize ```language-ts → ts
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i++; }
      i++; // closing fence
      const src = body.join("\n");
      blocks.push(lang === "mermaid"
        ? <MermaidBlock key={key++} code={src} />
        : <CodeBlock key={key++} code={src} lang={lang} />);
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
