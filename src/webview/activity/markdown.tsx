import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import DOMPurify from "dompurify";
import { highlight, renderMarkdownHtml, segments } from "./markdownEngine";

// mermaid + katex are loaded ON DEMAND (their iife bundles are injected as <script> only when a
// ```mermaid block / a math span first appears). window.* globals are seeded by the host html.
declare global {
  interface Window {
    mermaid?: { initialize(c: unknown): void; render(id: string, src: string): Promise<{ svg: string }> };
    katex?: { render(tex: string, el: HTMLElement, opts: unknown): void };
    __mermaidSrc?: string; __katexSrc?: string; __katexCssUri?: string; __codeThemeForced?: string;
  }
}

// ───────────────────────── mermaid (on-demand) ─────────────────────────
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

/** A ```mermaid block rendered to SVG (securityLevel strict). Caches by content; an always-visible toggle
 *  flips diagram↔source; a load/parse failure falls back to source — never breaks the view. */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(`${mermaidTheme()}::${code}`) ?? null);
  const [failed, setFailed] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
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
      .then((res) => { if (alive) { cacheSvg(key, res.svg); setSvg(res.svg); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [code]);

  const showSource = raw || failed;
  return (
    <div class="mmd">
      <div class="mmd-bar">
        <span class="mmd-label"><span class="codicon codicon-graph" /> {failed ? "diagram (couldn't render)" : "diagram"}</span>
        {!failed && (
          <button class="mmd-toggle" onClick={() => setRaw(!raw)}>
            <span class={`codicon codicon-${showSource ? "graph" : "code"}`} /> {showSource ? "Diagram" : "Source"}
          </button>
        )}
      </div>
      {showSource
        ? <pre class="mmd-src"><code class="hljs" dangerouslySetInnerHTML={{ __html: highlight(code, "mermaid") }} /></pre>
        : !svg
          ? <div class="mmd-loading"><span class="codicon codicon-loading" /> rendering diagram…</div>
          : <div class="mmd-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}

// ───────────────────────── katex (on-demand) ─────────────────────────
let katexLoad: Promise<NonNullable<Window["katex"]>> | null = null;
function loadKatex(): Promise<NonNullable<Window["katex"]>> {
  if (window.katex) return Promise.resolve(window.katex);
  if (katexLoad) return katexLoad;
  const p = new Promise<NonNullable<Window["katex"]>>((resolve, reject) => {
    const cssUri = window.__katexCssUri;
    if (cssUri && !document.querySelector("link[data-katex]")) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = cssUri; l.setAttribute("data-katex", "1"); document.head.appendChild(l);
    }
    const src = window.__katexSrc;
    if (!src) { reject(new Error("no katex source")); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => (window.katex ? resolve(window.katex) : reject(new Error("katex missing")));
    s.onerror = () => reject(new Error("katex load failed"));
    document.head.appendChild(s);
  });
  katexLoad = p;
  p.catch(() => { katexLoad = null; }); // a transient failure shouldn't poison every later math render
  return p;
}
/** Render any not-yet-rendered `.tac-math` placeholder spans in `root` (loads katex on first use). */
function renderMath(root: HTMLElement): void {
  const spans = root.querySelectorAll<HTMLElement>(".tac-math:not([data-rendered])");
  if (!spans.length) return;
  loadKatex().then((katex) => {
    spans.forEach((s) => {
      if (s.hasAttribute("data-rendered")) return; // a concurrent pass may have already done this span
      const tex = s.getAttribute("data-tex") ?? "";
      const display = s.getAttribute("data-display") === "1";
      // trust:false (default, set explicitly) blocks \href/\html*; throwOnError:false renders errors inline.
      try { katex.render(tex, s, { displayMode: display, throwOnError: false, trust: false, output: "html" }); }
      catch { s.textContent = tex; }
      s.setAttribute("data-rendered", "1");
    });
  }).catch(() => { /* katex unavailable → leave the raw TeX text in place */ });
}

let purifyHooked = false;
function sanitize(html: string): string {
  if (!purifyHooked) {
    purifyHooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noreferrer"); }
    });
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"], ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i });
}

// ───────────────────────── public API ─────────────────────────
/** Plain text with ONLY http(s) URLs linkified — for the HUMAN's own typed prompt (no markdown parsing). */
export function linkify(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /https?:\/\/[^\s)]+/g;
  let last = 0, m: RegExpExecArray | null, key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<a key={key++} href={m[0]} target="_blank" rel="noreferrer">{m[0]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A sanitized markdown HTML segment + copy-button delegation + lazy math rendering. */
function MdHtml({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => sanitize(renderMarkdownHtml(text)), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest(".copy");
      if (!btn) return;
      const code = btn.parentElement?.querySelector("code");
      const icon = btn.querySelector(".codicon");
      const flash = (name: string) => { if (icon) { icon.className = `codicon codicon-${name}`; setTimeout(() => { icon.className = "codicon codicon-copy"; }, 1200); } };
      // navigator.clipboard may be absent in a webview → the `?.` returns undefined; guard before `.then`.
      const p = navigator.clipboard?.writeText(code?.textContent ?? "");
      if (p) p.then(() => flash("check")).catch(() => flash("error"));
      else flash("error");
    };
    el.addEventListener("click", onClick);
    renderMath(el);
    return () => el.removeEventListener("click", onClick);
  }, [html]);
  return <div class="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Render an agent message: ```mermaid blocks → diagrams, everything else → sanitized markdown-it HTML. */
export function MarkdownView({ text }: { text: string }) {
  const segs = useMemo(() => segments(text), [text]);
  return <>{segs.map((s, i) => (s.mermaid ? <MermaidBlock key={i} code={s.content} /> : <MdHtml key={i} text={s.content} />))}</>;
}
