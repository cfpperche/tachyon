import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";
import { REVIEW_FILES_WIDTH_DEFAULT_REM, REVIEW_FILES_WIDTH_STORAGE_KEY } from "@tachyon/webview-ui/webview/review/filesWidth.js";

/**
 * t-2f7e8c — review file-list column is resizable; today's 16rem is the default, not the ceiling.
 *
 * ANCHOR (from the owner's looking-at-0.93.13 request, written before the divider landed):
 *
 *   The Review file list opens at today's 16rem width before any resize, so the screen matches
 *   0.93.13 on first paint. A long path such as
 *   apps/vscode-extension/media/companion-mobile/app.js.map is truncated at that default — several
 *   files that share the prefix are indistinguishable. After the column is widened, that same path
 *   is fully readable. The divider is reachable by Tab and the arrow keys. At 360 the columns
 *   stack, the divider is gone, and the body stays full-bleed.
 *
 * Measured at 880 and 360. Drives the real review bundle through the preview harness.
 */

const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-2f7e8c");
const WIDE = { w: 880, h: 900 };
const NARROW = { w: 360, h: 900 };
const LONG_PATH = "apps/vscode-extension/media/companion-mobile/app.js.map";
const LONG_TESTID = `review-file-${LONG_PATH}`;

type SplitGeom = {
  frameW: number;
  rootPx: number;
  filesWidth: number;
  override: string;
  splitDisplay: string;
  bodyFlex: string;
  pathText: string;
  pathTruncated: boolean;
  stored: string | null;
};

describe("t-2f7e8c — review file list is resizable", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# t-2f7e8c — review file-list resize\n\n` +
          `Anchor: default column is today's 16rem (0.93.13); a long companion-mobile path is ` +
          `truncated at that default and fully readable after widening; at 360 the columns stack ` +
          `and the divider is gone.\n\n` +
          `Regenerate:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/reviewFilesSplit.test.ts\n\`\`\`\n\n` +
          `${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function clearStoredWidth(): Promise<void> {
    await page.goto(`${server.origin}/scripts/webview-preview/index.html`);
    await page.evaluate((key) => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }, REVIEW_FILES_WIDTH_STORAGE_KEY);
  }

  async function openReview(width: number, height: number, keepStored = false): Promise<Frame> {
    if (!keepStored) await clearStoredWidth();
    await page.setViewport({ width: width + 40, height: height + 40, deviceScaleFactor: 2 });
    return openPreview(page, server.origin, {
      query: { view: "review", fixture: "long-paths" },
      width,
      height,
      waitFor: "[data-testid=review-root]",
    });
  }

  async function measure(surface: Frame): Promise<SplitGeom> {
    return surface.evaluate((testid: string) => {
      const files = document.querySelector(".review-files") as HTMLElement | null;
      const body = document.querySelector(".review-body") as HTMLElement | null;
      const split = document.querySelector("[data-testid=review-files-split]") as HTMLElement | null;
      const row = document.querySelector(`[data-testid="${testid}"] .review-file-path`) as HTMLElement | null;
      return {
        frameW: document.documentElement.clientWidth,
        rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        filesWidth: files?.getBoundingClientRect().width ?? -1,
        override: body?.style.getPropertyValue("--review-files-width") ?? "",
        splitDisplay: split ? getComputedStyle(split).display : "missing",
        bodyFlex: body ? getComputedStyle(body).flexDirection : "",
        pathText: row?.textContent ?? "",
        pathTruncated: row ? row.scrollWidth > row.clientWidth + 1 : false,
        stored: (() => {
          try { return localStorage.getItem("tachyon.review.filesWidthRem"); } catch { return null; }
        })(),
      };
    }, LONG_TESTID);
  }

  async function shoot(name: string): Promise<void> {
    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  async function widen(surface: Frame): Promise<void> {
    await surface.evaluate(() => {
      const split = document.querySelector("[data-testid=review-files-split]") as HTMLElement | null;
      if (!split) throw new Error("missing review-files-split");
      split.focus();
    });
    // 20 rem past today's 16rem — enough for the companion-mobile path, not End-to-max.
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
  }

  it("opens at today's 16rem and truncates the long path, then shows it after widening", async () => {
    const surface = await openReview(WIDE.w, WIDE.h);
    const before = await measure(surface);
    await shoot("review-880-default");
    expect(before.frameW).toBe(WIDE.w);
    expect(before.override, "first paint must not set a width override").toBe("");
    expect(before.stored).toBeNull();
    expect(Math.abs(before.filesWidth - REVIEW_FILES_WIDTH_DEFAULT_REM * before.rootPx)).toBeLessThanOrEqual(2);
    expect(before.pathText).toBe(LONG_PATH);
    expect(before.pathTruncated, "the motivating long path must be truncated at the default width").toBe(true);
    expect(before.splitDisplay).not.toBe("none");
    expect(before.splitDisplay).not.toBe("missing");

    await widen(surface);
    const after = await measure(surface);
    await shoot("review-880-wide");
    expect(after.override, "widening must set --review-files-width").not.toBe("");
    expect(after.filesWidth).toBeGreaterThan(before.filesWidth + 40);
    expect(after.pathText).toBe(LONG_PATH);
    expect(after.pathTruncated, "the long path must be fully readable after widening").toBe(false);
    expect(after.stored).not.toBeNull();
  });

  it("widens by pointer drag", async () => {
    const surface = await openReview(WIDE.w, WIDE.h);
    const before = await measure(surface);
    await surface.evaluate(() => {
      const split = document.querySelector("[data-testid=review-files-split]") as HTMLElement | null;
      const files = document.querySelector(".review-files") as HTMLElement | null;
      if (!split || !files) throw new Error("missing split or files");
      const r = files.getBoundingClientRect();
      split.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.right, clientY: r.top + 40, button: 0, bubbles: true }));
      split.dispatchEvent(new PointerEvent("pointermove", { clientX: r.right + 180, clientY: r.top + 40, bubbles: true }));
      split.dispatchEvent(new PointerEvent("pointerup", { clientX: r.right + 180, clientY: r.top + 40, bubbles: true }));
    });
    const after = await measure(surface);
    expect(after.filesWidth).toBeGreaterThan(before.filesWidth + 100);
    expect(after.stored).not.toBeNull();
  });

  it("restores the widened width from localStorage after a reload", async () => {
    const surface = await openReview(WIDE.w, WIDE.h);
    await widen(surface);
    const widened = await measure(surface);
    expect(widened.stored).not.toBeNull();

    const reloaded = await openReview(WIDE.w, WIDE.h, true);
    const again = await measure(reloaded);
    expect(again.override).toBe(widened.override);
    expect(Math.abs(again.filesWidth - widened.filesWidth)).toBeLessThanOrEqual(2);
  });

  it("hides the splitter at 360 when the columns stack", async () => {
    const surface = await openReview(NARROW.w, NARROW.h);
    const g = await measure(surface);
    await shoot("review-360-stacked");
    expect(g.frameW).toBe(NARROW.w);
    expect(g.bodyFlex).toBe("column");
    expect(g.splitDisplay).toBe("none");
    expect(g.override, "stacked first paint stays on the CSS default").toBe("");
  });
});
