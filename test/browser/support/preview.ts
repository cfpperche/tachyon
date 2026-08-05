import type { Frame, Page } from "puppeteer-core";

/**
 * t-b24282 — the ONE door into the preview harness for the browser suite.
 *
 * The harness renders the surface inside a sized iframe, because that is the only element whose content
 * box is a real viewport: `?width=360` moves both the box the surface lays out in AND the viewport its
 * `@media (max-width: …)` rules evaluate against. The cost is that the surface's DOM is no longer the
 * page's main frame, and puppeteer's `page.$eval`/`page.waitForSelector` only ever see the main frame —
 * they would silently find nothing. So every caller goes through here and drives the returned `Frame`.
 *
 * `page.screenshot()` and `page.$("#frame")` still work from the page: `#frame` IS the iframe element, so
 * screenshotting it captures exactly the surface at exactly the requested size.
 */

/** The surface frame inside an already-loaded harness page. Fails loud rather than returning the page. */
export async function previewSurface(page: Page, timeout = 15_000): Promise<Frame> {
  const handle = await page.waitForSelector("iframe#frame", { timeout }).catch(() => null);
  if (!handle) {
    throw new Error(
      "no preview surface iframe (#frame) — the harness shell did not mount. Run `npm run build` so " +
        "dist/webview-preview/shell.js exists, and check the page loaded scripts/webview-preview/index.html.",
    );
  }
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("preview surface iframe (#frame) has no content frame");
  // the shell points the frame at surface.html; until that navigation commits the frame is about:blank.
  await frame.waitForSelector("#root", { timeout });
  return frame;
}

export interface OpenPreviewOptions {
  /** view + fixture + any extra harness params (`theme`, `showWidth`, …). */
  query: Record<string, string | number>;
  /** the frame width to measure at. Omit to take the view's own `route.frame` width. */
  width?: number;
  /** the frame height. Omit to take the view's own `route.frame` height. */
  height?: number;
  /** a selector inside the surface to wait for before returning. */
  waitFor?: string;
  timeout?: number;
}

/**
 * Navigate `page` to the harness and return the surface frame. Width/height are passed ONCE, to the
 * harness — deliberately NOT to `page.setViewport`, because the browser window is no longer what the
 * surface measures against. A test that shrinks the window instead gets the mirror-image lie: media
 * queries fire, but the surface still lays out at the route's wide frame.
 */
export async function openPreview(
  page: Page,
  origin: string,
  { query, width, height, waitFor, timeout = 15_000 }: OpenPreviewOptions,
): Promise<Frame> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  if (width !== undefined) params.set("width", String(width));
  if (height !== undefined) params.set("height", String(height));
  await page.goto(`${origin}/scripts/webview-preview/index.html?${params}`, { waitUntil: "networkidle0" });
  const frame = await previewSurface(page, timeout);
  if (waitFor) await frame.waitForSelector(waitFor, { visible: true, timeout });
  return frame;
}
