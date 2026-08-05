/**
 * t-b24282 — the ONE door the hand-run visual-QA scripts here use to reach the preview harness.
 *
 * The harness renders the surface inside a sized iframe, because an iframe's content box is a real
 * viewport: `?width=360` moves BOTH the box the surface lays out in and the viewport its
 * `@media (max-width: …)` rules evaluate against. Before that, `?width=` sized a div and every media
 * query kept reading the browser window, so a "360px" capture showed a layout the product never
 * produces at 360px. Passing the width here — once — is the whole contract.
 *
 * The cost is that the surface's DOM is not the page's main frame any more, so `page.evaluate` would
 * silently measure the empty shell. Drive the returned frame instead. `page.screenshot()` is unaffected.
 */

/**
 * @param {import("puppeteer-core").Page} page
 * @param {{ view: string, fixture?: string, width?: number, height?: number, origin?: string, waitFor?: string, timeout?: number, settleMs?: number }} options
 * @returns {Promise<import("puppeteer-core").Frame>} the surface frame
 */
export async function openPreview(page, options) {
  const {
    view,
    fixture = "default",
    width,
    height,
    // `PREVIEW_PORT` is the same knob `scripts/webview-preview/serve.mjs` reads, so a second checkout
    // running its own preview server (parallel worktrees share one machine) can be measured without
    // stopping somebody else's on the default port.
    origin = process.env.PREVIEW_ORIGIN ?? `http://localhost:${process.env.PREVIEW_PORT ?? 5174}`,
    waitFor,
    timeout = 45000,
    settleMs = 0,
  } = options;

  const params = new URLSearchParams({ view, fixture });
  if (width !== undefined) params.set("width", String(width));
  if (height !== undefined) params.set("height", String(height));

  await page.goto(`${origin}/scripts/webview-preview/index.html?${params}`, {
    waitUntil: "networkidle0",
    timeout,
  });

  const handle = await page.waitForSelector("iframe#frame", { timeout });
  if (!handle) throw new Error("no preview surface iframe (#frame) — the harness shell did not mount");
  const surface = await handle.contentFrame();
  if (!surface) throw new Error("preview surface iframe (#frame) has no content frame");
  await surface.waitForSelector("#root", { timeout });
  if (waitFor) await surface.waitForSelector(waitFor, { visible: true, timeout });
  if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
  return surface;
}
