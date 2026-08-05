import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { previewSurface } from "./support/preview";
import type { PinPreviewVM } from "../../src/sidebar/types";

// t-321e9d — maintainer dogfood: a pin body with an inline image rendered the literal placeholder text
// "[Image]" instead of the actual image, even though the Visuals aside resolved + showed its thumbnail fine.
// Root cause: pin-preview's App only ever rendered the flattened plain-text `body` (produced by
// `pinDocPreview`, which turns an `image` node into the "[Image]" string), never the real doc. The fix
// threads the raw doc + resolved attachments to the webview and renders it through `toEditorDoc` + `StaticDoc`
// — same resolution pipeline the Studio/editor uses. This drives the REAL dist/webview/pin-preview.js bundle,
// same protocol shape as pilotBTaskStudio.test.ts, to prove the DOM actually contains an `<img>`.
const FIXTURE_VM: PinPreviewVM = {
  id: "pin-c429fb",
  title: "Board header dogfood screenshot",
  by: "human",
  done: false,
  tags: ["dogfood"],
  body: "[Image]",
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "See the screenshot below." }] },
      { type: "image", attrs: { attachmentId: "att-shot", blobRef: "shot-blob" } },
    ],
  },
  attachments: [
    { id: "att-shot", kind: "image", name: "shot.png", available: true, uri: "https://example.invalid/shot.png", detail: "PNG · 42 KB" },
  ],
};

async function loadPinPreview(page: Page, origin: string, vm: PinPreviewVM): Promise<Frame> {
  // pin-preview/main.tsx signals ready from a `useEffect`, which preact/hooks flushes via
  // requestAnimationFrame — a BACKGROUND (non-active) tab gets that throttled by Chrome, which can stall the
  // ready handshake under heavy multi-browser contention. Forcing this page to the front keeps rAF live.
  //
  // t-1c745f: under full `test:browser` load, ready can fire before the test installs its listener (lost
  // handshake). Re-post the pinPreview VM until `.body` mounts — late inject is accepted once Root listens.
  await page.bringToFront();
  await page.goto(`${origin}/scripts/webview-preview/index.html?view=pin-preview&fixture=with-image`, {
    waitUntil: "domcontentloaded",
  });
  // t-b24282 — the surface renders inside the shell's sized iframe, so the VM is posted into THAT window.
  const surface = await previewSurface(page);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.bringToFront();
    await surface.evaluate((v) => window.postMessage({ type: "pinPreview", vm: v }, "*"), vm);
    try {
      await surface.waitForSelector(".body", { visible: true, timeout: 250 });
      return surface;
    } catch {
      // Root not listening yet — retry.
    }
  }
  throw new Error("Pin Preview never rendered .body after pinPreview VM injects");
}

describe("Pin Preview renders inline doc images (t-321e9d)", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("renders a real <img> in the body instead of the literal '[Image]' placeholder", async () => {
    const page = await browser.newPage();
    const surface = await loadPinPreview(page, server.origin, FIXTURE_VM);

    const bodyText = await surface.$eval(".body", (el) => el.textContent ?? "");
    expect(bodyText).not.toContain("[Image]");

    const img = await surface.$eval(".body img", (el) => (el as HTMLImageElement).src);
    expect(img).toBe("https://example.invalid/shot.png");

    // the Visuals aside keeps resolving its own thumbnail independently (already worked pre-fix).
    const visualImg = await surface.$eval(".visual img", (el) => (el as HTMLImageElement).src);
    expect(visualImg).toBe("https://example.invalid/shot.png");

    await page.close();
  });
});
