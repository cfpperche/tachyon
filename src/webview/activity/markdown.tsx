import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import DOMPurify from "dompurify";
import { highlight, renderMarkdownHtml, segments } from "./markdownEngine";
import { SANITIZE_OPTIONS } from "./markdownSanitizeConfig";
import {
  ZOOM_STEP,
  type Size,
  type ViewTransform,
  canPan,
  fitTransform,
  formatScalePercent,
  initialTransform,
  panBy,
  reset100,
  wheelPanConsume,
  zoomAtPoint,
} from "./mermaidViewport";

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

/** Measure natural SVG content size (ignores CSS max-width shrink). */
function measureSvgContent(stage: HTMLElement): Size | null {
  const svg = stage.querySelector("svg");
  if (!svg) return null;
  // Prefer explicit non-% width/height (Mermaid often sets both + viewBox).
  const wAttr = parseFloat(svg.getAttribute("width") || "");
  const hAttr = parseFloat(svg.getAttribute("height") || "");
  const widthIsPct = String(svg.getAttribute("width") || "").includes("%");
  if (wAttr > 0 && hAttr > 0 && !widthIsPct) {
    return { w: wAttr, h: hAttr };
  }
  // viewBox user units ≈ natural size when width is 100% / missing.
  const vb = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { w: vb[2], h: vb[3] };
  }
  try {
    const bb = svg.getBBox();
    if (bb.width > 0 && bb.height > 0) return { w: bb.width, h: bb.height };
  } catch { /* getBBox can throw if not in DOM / empty */ }
  const r = svg.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return { w: r.width, h: r.height };
  return null;
}

/**
 * Read-only zoom/pan viewport for a rendered Mermaid SVG (spec 374).
 * First-party chrome only; transform state is ephemeral; does not mutate `code`/SVG source.
 */
function MermaidDiagramView({ svg }: { svg: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [t, setT] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ x: number; y: number; t: ViewTransform } | null>(null);
  /** User zoom/pan/fit/reset — stop auto re-frame on resize after intentional nav. */
  const userTouchedRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const contentRef = useRef(content);
  contentRef.current = content;
  const viewportSizeRef = useRef(viewport);
  viewportSizeRef.current = viewport;

  const frameFromDom = useCallback(() => {
    const stage = stageRef.current;
    const vpEl = viewportRef.current;
    if (!stage || !vpEl) return;
    const measured = measureSvgContent(stage);
    setContent(measured);
    if (!measured) {
      setT({ scale: 1, tx: 0, ty: 0 });
      return;
    }
    const vp = { w: vpEl.clientWidth, h: vpEl.clientHeight };
    setViewport(vp);
    if (vp.w > 0 && vp.h > 0) setT(initialTransform(vp, measured));
    else setT({ scale: 1, tx: 0, ty: 0 });
  }, []);

  // Inject SVG (host-owned node; Mermaid already ran securityLevel:strict).
  // Defer measure one frame so clientWidth/Height reflect laid-out viewport height
  // (same-tick measure after innerHTML often saw min-height only → microscopic scale).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.innerHTML = svg;
    userTouchedRef.current = false;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (!cancelled) frameFromDom();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [svg, frameFromDom]);

  // Keep viewport size in sync (panel resize / feed width). Auto re-frame until the user navigates.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const vp = { w: el.clientWidth, h: el.clientHeight };
      const prev = viewportSizeRef.current;
      setViewport(vp);
      const c = contentRef.current;
      if (!c || vp.w <= 0 || vp.h <= 0) return;
      if (!userTouchedRef.current || prev.w <= 0 || prev.h <= 0) {
        setT(initialTransform(vp, c));
      } else {
        setT((cur) => panBy(cur, 0, 0, vp, c)); // re-clamp only after user zoom/pan
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const applyZoom = useCallback((factor: number, origin?: { x: number; y: number }) => {
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!c || vp.w <= 0) return;
    userTouchedRef.current = true;
    const cur = tRef.current;
    const originPt = origin ?? { x: vp.w / 2, y: vp.h / 2 };
    setT(zoomAtPoint(cur, cur.scale * factor, originPt, vp, c));
  }, []);

  const doFit = useCallback(() => {
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!c || vp.w <= 0) return;
    userTouchedRef.current = true;
    setT(fitTransform(vp, c));
  }, []);

  const doReset = useCallback(() => {
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!c || vp.w <= 0) return;
    userTouchedRef.current = true;
    setT(reset100(vp, c));
  }, []);

  // Wheel: Ctrl/Cmd+wheel zoom; plain wheel pans when overflow else pass-through.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const c = contentRef.current;
      const vp = viewportSizeRef.current;
      if (!c || vp.w <= 0) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        userTouchedRef.current = true;
        const rect = el.getBoundingClientRect();
        const origin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        // Trackpad pinch often sends small deltaY with ctrlKey; exponential step from delta.
        const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        // Fine-grained: scale by magnitude for large deltas
        const steps = Math.min(4, Math.max(1, Math.round(Math.abs(e.deltaY) / 100)));
        let next = tRef.current;
        for (let i = 0; i < steps; i++) {
          next = zoomAtPoint(next, next.scale * factor, origin, vp, c);
        }
        setT(next);
        return;
      }
      const { next, consumed } = wheelPanConsume(tRef.current, e.deltaY, vp, c);
      if (consumed) {
        e.preventDefault();
        userTouchedRef.current = true;
        setT(next);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!c || !canPan(tRef.current, vp, c)) return;
    userTouchedRef.current = true;
    dragRef.current = { x: e.clientX, y: e.clientY, t: tRef.current };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!d || !c) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    userTouchedRef.current = true;
    setT(panBy(d.t, dx, dy, vp, c));
  };
  const onPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const c = contentRef.current;
    const vp = viewportSizeRef.current;
    if (!c || vp.w <= 0) return;
    const key = e.key;
    if (key === "+" || key === "=") { e.preventDefault(); applyZoom(ZOOM_STEP); return; }
    if (key === "-" || key === "_") { e.preventDefault(); applyZoom(1 / ZOOM_STEP); return; }
    if (key === "0") { e.preventDefault(); doReset(); return; }
    if (key === "f" || key === "F") { e.preventDefault(); doFit(); return; }
    const step = e.shiftKey ? 40 : 20;
    if (key === "ArrowLeft") { e.preventDefault(); userTouchedRef.current = true; setT(panBy(tRef.current, step, 0, vp, c)); return; }
    if (key === "ArrowRight") { e.preventDefault(); userTouchedRef.current = true; setT(panBy(tRef.current, -step, 0, vp, c)); return; }
    if (key === "ArrowUp") { e.preventDefault(); userTouchedRef.current = true; setT(panBy(tRef.current, 0, step, vp, c)); return; }
    if (key === "ArrowDown") { e.preventDefault(); userTouchedRef.current = true; setT(panBy(tRef.current, 0, -step, vp, c)); return; }
  };

  const pannable = content ? canPan(t, viewport, content) : false;
  const scaleLabel = formatScalePercent(t.scale);

  return (
    <div class="mmd-view">
      <div class="mmd-nav" role="toolbar" aria-label="diagram navigation">
        <button type="button" class="mmd-nav-btn" title="Zoom out (−)" aria-label="Zoom out" onClick={() => applyZoom(1 / ZOOM_STEP)}>
          <span class="codicon codicon-zoom-out" />
        </button>
        <button type="button" class="mmd-nav-btn" title="Zoom in (+)" aria-label="Zoom in" onClick={() => applyZoom(ZOOM_STEP)}>
          <span class="codicon codicon-zoom-in" />
        </button>
        <button type="button" class="mmd-nav-btn" title="Fit to view (F)" aria-label="Fit to view" onClick={doFit}>
          <span class="codicon codicon-screen-full" />
        </button>
        <button type="button" class="mmd-nav-btn" title="Reset to 100% (0)" aria-label="Reset to 100 percent" onClick={doReset}>
          100%
        </button>
        <span class="mmd-scale" aria-live="polite">{scaleLabel}</span>
      </div>
      <div
        class={`mmd-viewport${dragging ? " dragging" : ""}${pannable ? " pannable" : ""}`}
        ref={viewportRef}
        tabIndex={0}
        role="group"
        aria-label={`diagram viewport, scale ${scaleLabel}. Opens fit-to-width for reading; Fit shrinks fully. Ctrl+scroll zoom; drag pan when overflow. Keys: + − 0 F, arrows pan.`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          class="mmd-stage"
          ref={stageRef}
          style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}
        />
      </div>
    </div>
  );
}

/** A ```mermaid block rendered to SVG (securityLevel strict). Caches by content; an always-visible toggle
 *  flips diagram↔source; a load/parse failure falls back to source — never breaks the view.
 *  Diagram view offers ephemeral read-only zoom/pan (spec 374) — never mutates `code`. */
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
          <button type="button" class="mmd-toggle" onClick={() => setRaw(!raw)}>
            <span class={`codicon codicon-${showSource ? "graph" : "code"}`} /> {showSource ? "Diagram" : "Source"}
          </button>
        )}
      </div>
      {showSource
        ? <pre class="mmd-src"><code class="hljs" dangerouslySetInnerHTML={{ __html: highlight(code, "mermaid") }} /></pre>
        : !svg
          ? <div class="mmd-loading"><span class="codicon codicon-loading" /> rendering diagram…</div>
          : <MermaidDiagramView key={svg.slice(0, 64)} svg={svg} />}
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
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
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
