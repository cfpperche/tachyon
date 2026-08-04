/**
 * Map a click on a displayed screenshot (object-fit: contain) to CSS viewport coordinates.
 * Pure math — unit-tested without Chrome.
 */

export type DisplayClick = {
  /** Click x relative to the displayed image element (CSS pixels of the <img>). */
  x: number;
  y: number;
  /** Rendered size of the <img> element. */
  displayW: number;
  displayH: number;
  /** Intrinsic CSS viewport size of the captured page (from puppeteer viewport / screenshot metadata). */
  cssW: number;
  cssH: number;
};

export type ViewportPoint = { x: number; y: number };

/**
 * object-fit: contain letterboxes the source inside displayW×displayH.
 * Returns null if the click landed in the letterbox (outside the content box).
 */
export function mapDisplayClickToViewport(input: DisplayClick): ViewportPoint | null {
  const { x, y, displayW, displayH, cssW, cssH } = input;
  if (!(displayW > 0 && displayH > 0 && cssW > 0 && cssH > 0)) return null;
  if (!(Number.isFinite(x) && Number.isFinite(y))) return null;

  const scale = Math.min(displayW / cssW, displayH / cssH);
  const contentW = cssW * scale;
  const contentH = cssH * scale;
  const offsetX = (displayW - contentW) / 2;
  const offsetY = (displayH - contentH) / 2;

  const localX = x - offsetX;
  const localY = y - offsetY;
  if (localX < 0 || localY < 0 || localX > contentW || localY > contentH) return null;

  return {
    x: localX / scale,
    y: localY / scale,
  };
}
