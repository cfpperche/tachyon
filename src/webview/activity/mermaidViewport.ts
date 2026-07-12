/**
 * Pure math for read-only Mermaid diagram navigation (spec 374 / t-3febb9).
 * No DOM — unit-tested in Node. Scale is relative to the natural SVG size (1 = 100%).
 */

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const ZOOM_STEP = 1.15;

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
export type ViewTransform = { scale: number; tx: number; ty: number };

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Fit content into viewport; never upscales past 1 (small diagrams stay natural). */
export function fitScale(viewport: Size, content: Size): number {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return 1;
  return clampScale(Math.min(1, viewport.w / content.w, viewport.h / content.h));
}

/** Fit-to-width only (matches historical max-width:100% open framing). */
export function fitWidthScale(viewportW: number, contentW: number): number {
  if (contentW <= 0 || viewportW <= 0) return 1;
  return clampScale(Math.min(1, viewportW / contentW));
}

export function clampPan(
  t: ViewTransform,
  viewport: Size,
  content: Size,
): ViewTransform {
  const sw = content.w * t.scale;
  const sh = content.h * t.scale;
  let { tx, ty } = t;

  if (sw <= viewport.w) {
    tx = (viewport.w - sw) / 2;
  } else {
    const minTx = viewport.w - sw;
    const maxTx = 0;
    tx = Math.min(maxTx, Math.max(minTx, tx));
  }

  if (sh <= viewport.h) {
    ty = (viewport.h - sh) / 2;
  } else {
    const minTy = viewport.h - sh;
    const maxTy = 0;
    ty = Math.min(maxTy, Math.max(minTy, ty));
  }

  return { scale: t.scale, tx, ty };
}

/**
 * Zoom so the content point under `origin` (viewport coords) stays fixed.
 * `origin` is relative to the viewport top-left.
 */
export function zoomAtPoint(
  t: ViewTransform,
  nextScale: number,
  origin: Point,
  viewport: Size,
  content: Size,
): ViewTransform {
  const scale = clampScale(nextScale);
  if (scale === t.scale) return clampPan(t, viewport, content);
  // content point under origin: (origin - t) / scale
  const cx = (origin.x - t.tx) / t.scale;
  const cy = (origin.y - t.ty) / t.scale;
  const tx = origin.x - cx * scale;
  const ty = origin.y - cy * scale;
  return clampPan({ scale, tx, ty }, viewport, content);
}

export function panBy(
  t: ViewTransform,
  dx: number,
  dy: number,
  viewport: Size,
  content: Size,
): ViewTransform {
  return clampPan({ scale: t.scale, tx: t.tx + dx, ty: t.ty + dy }, viewport, content);
}

/** True when scaled content overflows the viewport in either axis (pan useful). */
export function canPan(t: ViewTransform, viewport: Size, content: Size): boolean {
  return content.w * t.scale > viewport.w + 0.5 || content.h * t.scale > viewport.h + 0.5;
}

/**
 * Apply a wheel delta as vertical pan; returns whether the event was fully consumed
 * (if false, caller should let the page scroll).
 */
export function wheelPanConsume(
  t: ViewTransform,
  deltaY: number,
  viewport: Size,
  content: Size,
): { next: ViewTransform; consumed: boolean } {
  if (!canPan(t, viewport, content)) {
    return { next: t, consumed: false };
  }
  const next = panBy(t, 0, -deltaY, viewport, content);
  // If pan didn't move (already at edge in that direction), don't consume.
  const moved = next.tx !== t.tx || next.ty !== t.ty;
  return { next, consumed: moved };
}

export function formatScalePercent(scale: number): string {
  return `${Math.round(clampScale(scale) * 100)}%`;
}

export function initialTransform(viewport: Size, content: Size): ViewTransform {
  const scale = fitWidthScale(viewport.w, content.w);
  // Prefer width fit; if height still overflows a max-height viewport, use full fit.
  const fitted = content.h * scale > viewport.h ? fitScale(viewport, content) : scale;
  return clampPan({ scale: fitted, tx: 0, ty: 0 }, viewport, content);
}

export function reset100(viewport: Size, content: Size): ViewTransform {
  return clampPan({ scale: 1, tx: 0, ty: 0 }, viewport, content);
}

export function fitTransform(viewport: Size, content: Size): ViewTransform {
  const scale = fitScale(viewport, content);
  return clampPan({ scale, tx: 0, ty: 0 }, viewport, content);
}
