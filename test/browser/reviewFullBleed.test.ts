import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * t-abe33b — review body full-bleed, local opt-out.
 *
 * ANCHOR (from the owner's looking-at-0.93.12 request, written before the CSS change):
 *
 *   The Review header keeps the shared `.ds-page` inset — title and actions have comfortable
 *   side spacing. The two-column body (file list + diff) is flush with the left, right, and
 *   bottom edges of the webview. The body's top border still separates header from content.
 *   Diff code is not hidden under the scrollbar. The file-list/diff divider stays interior
 *   and reachable when the list hits the left edge. Board (a document surface) keeps its
 *   existing page-pad margins — this is not a global `.ds-page` change.
 *
 * Measured at 880 and 360. Drives the real review and board bundles through the preview harness.
 */

const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-abe33b");
const WIDE = { w: 880, h: 900 };
const NARROW = { w: 360, h: 900 };

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

type ReviewGeom = {
  frameW: number;
  frameH: number;
  padX: number;
  padBottom: number;
  titleLeft: number;
  body: Box;
  files: Box | null;
  filesBorderRight: string;
  bodyFlex: string;
  bodyBorderTop: string;
  paneClientRight: number | null;
  codeRight: number | null;
  scrollbarTakesLayout: number | null;
};

type BoardGeom = {
  frameW: number;
  frameH: number;
  padX: number;
  padBottom: number;
  headPadX: number;
  boardPadX: number;
  boardPadBottom: number;
  colLeft: number;
};

describe("t-abe33b — review body full-bleed", () => {
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
        `# t-abe33b — review body full-bleed\n\n` +
          `Anchor: header keeps the shared page inset; the two-column body is flush with the ` +
          `left, right and bottom edges; the body top border stays; Board keeps its page pad.\n\n` +
          `Regenerate:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/reviewFullBleed.test.ts\n\`\`\`\n\n` +
          `${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function measureReview(surface: Frame): Promise<ReviewGeom> {
    return surface.evaluate(() => {
      const tokenPad = (name: string): number => {
        const probe = document.createElement("div");
        probe.style.paddingLeft = `var(${name})`;
        document.body.appendChild(probe);
        const n = parseFloat(getComputedStyle(probe).paddingLeft);
        probe.remove();
        return n;
      };
      const rect = (sel: string): Box | null => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const pane = document.querySelector(".review-pane") as HTMLElement | null;
      const code = document.querySelector(".review-code");
      const files = document.querySelector(".review-files");
      const body = document.querySelector(".review-body") as HTMLElement | null;
      const title = document.querySelector(".ds-page-chrome-title");
      return {
        frameW: document.documentElement.clientWidth,
        frameH: document.documentElement.clientHeight,
        padX: tokenPad("--ds-page-pad-x"),
        padBottom: tokenPad("--ds-page-pad-bottom"),
        titleLeft: title?.getBoundingClientRect().left ?? -1,
        body: rect(".review-body")!,
        files: rect(".review-files"),
        filesBorderRight: files ? getComputedStyle(files).borderRightWidth : "",
        bodyFlex: body ? getComputedStyle(body).flexDirection : "",
        bodyBorderTop: body ? getComputedStyle(body).borderTopWidth : "",
        paneClientRight: pane ? pane.getBoundingClientRect().left + pane.clientWidth : null,
        codeRight: code ? code.getBoundingClientRect().right : null,
        scrollbarTakesLayout: pane ? pane.offsetWidth - pane.clientWidth : null,
      };
    });
  }

  async function measureBoard(surface: Frame): Promise<BoardGeom> {
    return surface.evaluate(() => {
      const tokenPad = (name: string): number => {
        const probe = document.createElement("div");
        probe.style.paddingLeft = `var(${name})`;
        document.body.appendChild(probe);
        const n = parseFloat(getComputedStyle(probe).paddingLeft);
        probe.remove();
        return n;
      };
      const head = document.querySelector(".mc-head") as HTMLElement;
      const board = document.querySelector(".board") as HTMLElement;
      const col = document.querySelector(".col");
      return {
        frameW: document.documentElement.clientWidth,
        frameH: document.documentElement.clientHeight,
        padX: tokenPad("--ds-page-pad-x"),
        padBottom: tokenPad("--ds-page-pad-bottom"),
        headPadX: parseFloat(getComputedStyle(head).paddingLeft),
        boardPadX: parseFloat(getComputedStyle(board).paddingLeft),
        boardPadBottom: parseFloat(getComputedStyle(board).paddingBottom),
        colLeft: col?.getBoundingClientRect().left ?? -1,
      };
    });
  }

  async function shoot(name: string): Promise<void> {
    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  function expectBleed(g: ReviewGeom, width: number): void {
    expect(g.frameW, `surface did not reflow to ${width}`).toBe(width);
    expect(g.padX).toBeGreaterThan(0);
    expect(g.titleLeft).toBeGreaterThanOrEqual(g.padX - 1);
    expect(g.titleLeft).toBeLessThanOrEqual(g.padX + 2);
    expect(Math.abs(g.body.left), "body must sit on the left edge").toBeLessThanOrEqual(1);
    expect(Math.abs(g.body.right - g.frameW), "body must sit on the right edge").toBeLessThanOrEqual(1);
    expect(Math.abs(g.body.bottom - g.frameH), "body must sit on the bottom edge").toBeLessThanOrEqual(1);
    expect(parseFloat(g.bodyBorderTop), "body top border must remain").toBeGreaterThan(0);
    if (g.codeRight !== null && g.paneClientRight !== null) {
      expect(g.codeRight, "diff code must not sit under the scrollbar").toBeLessThanOrEqual(g.paneClientRight + 1);
    }
  }

  it("bleeds the body at 880 and keeps the header inset", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 2 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "review", fixture: "default" },
      width: WIDE.w,
      height: WIDE.h,
      waitFor: "[data-testid=review-root]",
    });
    const g = await measureReview(surface);
    await shoot("review-880");
    expectBleed(g, WIDE.w);
    expect(g.bodyFlex).toBe("row");
    expect(g.files).not.toBeNull();
    expect(Math.abs(g.files!.left), "file list sits on the left edge").toBeLessThanOrEqual(1);
    expect(g.files!.right, "divider stays interior, not on the frame edge").toBeGreaterThan(g.padX + 40);
    expect(parseFloat(g.filesBorderRight), "file/diff divider remains").toBeGreaterThan(0);
  });

  it("bleeds the body at 360 when the columns stack", async () => {
    await page.setViewport({ width: NARROW.w + 40, height: NARROW.h + 40, deviceScaleFactor: 2 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "review", fixture: "default" },
      width: NARROW.w,
      height: NARROW.h,
      waitFor: "[data-testid=review-root]",
    });
    const g = await measureReview(surface);
    await shoot("review-360");
    expectBleed(g, NARROW.w);
    expect(g.bodyFlex).toBe("column");
  });

  it("leaves Board's page-pad inset alone at 880", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 2 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "board", fixture: "default" },
      width: WIDE.w,
      height: WIDE.h,
      waitFor: ".mc-root",
    });
    const g = await measureBoard(surface);
    await shoot("board-880");
    expect(g.padX).toBeGreaterThan(0);
    expect(g.headPadX, "Board header must keep page-pad-x").toBe(g.padX);
    expect(g.boardPadX, "Board columns must keep page-pad-x").toBe(g.padX);
    expect(g.boardPadBottom, "Board must keep page-pad-bottom").toBe(g.padBottom);
    expect(Math.abs(g.colLeft - g.padX), "first Board column stays inset by page-pad-x").toBeLessThanOrEqual(1);
  });
});
