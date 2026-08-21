import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../shared/ui";
import { sanitizeMarkup } from "../activity/markdown";
import type { ReviewBinaryAsset, ReviewBinarySide } from "./messages";

declare global {
  interface Window {
    PDFJS_WORKER_URI?: string;
    PDFJS_VIEWER_URI?: string;
    MODEL_VIEWER_URI?: string;
    __tachyonPdfjs?: typeof import("pdfjs-dist");
  }
}

// Markdown's URI allow-list also rejects every non-URI SVG value (dimensions,
// paths, transforms). Extend the same allowed schemes with colon-free SVG
// attribute values; protocol-bearing command/data/file/javascript values stay blocked.
const SVG_ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#|[^:]*$)/i;

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  const prior = scripts.get(src);
  if (prior) return prior;
  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
  scripts.set(src, pending);
  pending.catch(() => scripts.delete(src));
  return pending;
}

function Raster({ side }: { side: ReviewBinarySide }) {
  return <img class="review-binary-image" src={side.uri} alt={`${side.label} image`} />;
}

function Svg({ side }: { side: ReviewBinarySide }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    void fetch(side.uri).then((response) => response.text()).then((raw) => {
      // The same DOMPurify door and URI policy as MarkdownView, with DOMPurify's own SVG vocabulary enabled.
      const clean = sanitizeMarkup(raw, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_ATTR: ["viewBox", "width", "height", "x", "y", "cx", "cy", "r", "d", "rx", "ry", "font-size"],
        ALLOWED_URI_REGEXP: SVG_ALLOWED_URI_REGEXP,
      });
      if (alive) {
        setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`);
      }
    });
    return () => { alive = false; };
  }, [side.uri]);
  return src ? <img class="review-binary-svg" src={src} alt={`${side.label} SVG`} /> : <p class="review-empty">Loading SVG…</p>;
}

function Pdf({ side }: { side: ReviewBinarySide }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let task: { destroy(): Promise<void> } | undefined;
    const viewerUri = window.PDFJS_VIEWER_URI;
    void (viewerUri ? loadScript(viewerUri) : Promise.reject(new Error("PDF viewer unavailable"))).then(async () => {
      const pdfjs = window.__tachyonPdfjs;
      if (!pdfjs) throw new Error("PDF viewer failed to initialize");
      if (window.PDFJS_WORKER_URI) pdfjs.GlobalWorkerOptions.workerSrc = window.PDFJS_WORKER_URI;
      const loading = pdfjs.getDocument({ url: side.uri });
      task = loading;
      const document = await loading.promise;
      if (cancelled) return;
      setPages(document.numPages);
      const pdfPage = await document.getPage(page);
      const viewport = pdfPage.getViewport({ scale: 1.35 });
      const target = canvas.current;
      if (!target || cancelled) return;
      const context = target.getContext("2d");
      if (!context) return;
      target.width = viewport.width;
      target.height = viewport.height;
      await pdfPage.render({ canvas: target, canvasContext: context, viewport }).promise;
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; void task?.destroy(); };
  }, [side.uri, page]);
  return <div class="review-pdf">
    {error ? <p class="review-empty">PDF failed to render: {error}</p> : null}
    <canvas ref={canvas} aria-label={`${side.label} PDF page ${page}`} />
    {pages > 1 ? <div class="review-binary-controls">
      <Button variant="default" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button variant="default" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</Button>
    </div> : null}
  </div>;
}

function Model({ side }: { side: ReviewBinarySide }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const viewerUri = window.MODEL_VIEWER_URI;
    void (viewerUri ? loadScript(viewerUri) : Promise.reject(new Error("3D viewer unavailable")))
      .then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);
  if (!ready) return <p class="review-empty">Loading 3D viewer…</p>;
  return <model-viewer class="review-model" src={side.uri} camera-controls auto-rotate shadow-intensity="1" alt={`${side.label} 3D model`} />;
}

function Viewer({ asset, side }: { asset: ReviewBinaryAsset; side: ReviewBinarySide }) {
  if (asset.family === "raster") return <Raster side={side} />;
  if (asset.family === "svg") return <Svg side={side} />;
  if (asset.family === "pdf") return <Pdf side={side} />;
  return <Model side={side} />;
}

export function BinaryReview({ asset }: { asset: ReviewBinaryAsset }) {
  const [selected, setSelected] = useState<"base" | "current">(asset.sides.some((side) => side.side === "current") ? "current" : "base");
  useEffect(() => setSelected(asset.sides.some((side) => side.side === "current") ? "current" : "base"), [asset]);
  const sideBySide = (asset.family === "raster" || asset.family === "svg") && asset.sides.length === 2;
  if (sideBySide) return <div class="review-binary-sides">
    {asset.sides.map((side) => <section class="review-binary-side" key={side.side}><h2>{side.label}</h2><Viewer asset={asset} side={side} /></section>)}
  </div>;
  const active = asset.sides.find((side) => side.side === selected) ?? asset.sides[0];
  return <div class="review-binary-single">
    {asset.sides.length > 1 ? <div class="review-binary-tabs" role="tablist" aria-label="Binary diff side">
      {asset.sides.map((side) => <Button key={side.side} variant={side.side === active.side ? "primary" : "default"} onClick={() => setSelected(side.side)}>{side.label}</Button>)}
    </div> : <h2>{active.label}</h2>}
    <Viewer asset={asset} side={active} />
  </div>;
}

declare module "preact" {
  namespace JSX { interface IntrinsicElements { "model-viewer": Record<string, unknown> } }
}
