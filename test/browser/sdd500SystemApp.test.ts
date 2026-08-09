import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * ANCHOR (written from spec.md's problem statement, before the screen was built):
 *
 *   System answers "is Tachyon up and healthy, and if not, where?" as ONE screen — a summary strip
 *   that is a rollup of the workspace detail directly beneath it, not two pages stapled together. The
 *   summary must never contradict the cards, because it is computed from them. Both halves must read
 *   cleanly at desktop and narrow widths with no horizontal overflow, and when an engine is in `error`
 *   that must be obvious from the TOP of the page without opening anything.
 *
 * This replaces `t3bcd57OverviewJumpRemoved.test.ts`, which measured the same two widths against the
 * Overview half. The coverage it held — real bundle, two widths, no overflow — is kept here rather
 * than deleted with the surface it happened to be written against.
 */
const OUT = process.env.SDD500_SHOT_DIR ?? ".tachyon/vqa/visual-qa";
const WIDTHS = [880, 360];

describe("SDD 500 — System reads as one screen at both widths", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), args: ["--no-sandbox"] });
    page = await browser.newPage();
  });

  afterAll(async () => { await browser?.close(); await server?.close(); });

  /** the summary strip as label -> value, read off the live DOM. */
  const readMetrics = (surface: Awaited<ReturnType<typeof openPreview>>) =>
    surface.evaluate(() => {
      const out: Record<string, string> = {};
      for (const tile of document.querySelectorAll(".ck-metrics .ck-metric")) {
        const label = tile.querySelector(".label")?.textContent?.trim();
        const value = tile.querySelector(".value")?.textContent?.trim();
        if (label && value !== undefined) out[label] = value;
      }
      return out;
    });

  for (const width of WIDTHS) {
    it(`carries both halves with no horizontal overflow at ${width}`, async () => {
      // t-b24282 — the harness frame is an iframe, so one `?width=` moves both the layout box and the
      // viewport `@media` reads. The browser viewport is set only so the capture is not cropped.
      await page.setViewport({ width, height: 1200 });
      const surface = await openPreview(page, server.origin, {
        query: { view: "system", fixture: "default" },
        width,
        height: 1200,
        waitFor: '[data-testid="control-system"]',
      });
      expect(await surface.evaluate(() => window.innerWidth)).toBe(width);
      expect(
        await surface.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `horizontal overflow at ${width}`,
      ).toBe(true);

      // the rollup AND the detail it rolls up, on one screen — the whole claim of the merge.
      expect(await surface.evaluate(() => document.querySelectorAll(".ck-metrics .ck-metric").length)).toBe(6);
      expect(await surface.evaluate(() => document.querySelectorAll(".ci-ws").length)).toBe(1);
      expect(await surface.evaluate(() => !!document.querySelector(".ci-log"))).toBe(true);

      // every action both pages carried, reachable from this one.
      const actions = await surface.evaluate(() => document.body.innerText);
      for (const label of ["Auto-refresh", "Refresh", "Copy diagnostics", "Run Doctor"]) {
        expect(actions, `${label} is not on the merged screen`).toContain(label);
      }

      await page.screenshot({ path: `${OUT}/sdd500-system-${width}.png`, fullPage: true });
    });
  }

  it("the summary agrees with the card, because it is computed from it", async () => {
    await page.setViewport({ width: 880, height: 1200 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "system", fixture: "default" },
      width: 880,
      height: 1200,
      waitFor: '[data-testid="control-system"]',
    });
    const metrics = await readMetrics(surface);
    const cards = await surface.evaluate(() =>
      [...document.querySelectorAll(".ci-ws")].map((ws) => ws.querySelector(".ds-badge")?.textContent?.trim()),
    );
    expect(cards).toEqual(["Attached"]);
    expect(metrics.Workspaces).toBe(String(cards.length));
    expect(metrics.Engines).toBe("1");
    expect(metrics.Errors).toBe("0");
  });

  it("a failing engine is obvious from the top of the page", async () => {
    await page.setViewport({ width: 880, height: 1200 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "system", fixture: "engine-error" },
      width: 880,
      height: 1200,
      waitFor: '[data-testid="control-system"]',
    });
    const metrics = await readMetrics(surface);
    expect(metrics.Errors, "the Errors counter did not follow the failing row").toBe("1");
    expect(metrics.Engines).toBe("0");
    // and the counter is toned, not merely numerically correct — the glance has to carry the alarm.
    expect(await surface.evaluate(() => !!document.querySelector(".ck-metric.warn"))).toBe(true);
    // the failure text stays readable rather than breaking mid-word (the Visual QA finding that
    // changed `.ci-kv .v` from `word-break: break-all` to `overflow-wrap: anywhere`).
    const errorText = await surface.evaluate(() =>
      [...document.querySelectorAll(".ci-kv .v")].map((v) => v.textContent ?? "").find((t) => t.includes("handshake")) ?? "",
    );
    expect(errorText).toContain("no response");
    await page.screenshot({ path: `${OUT}/sdd500-system-error-880.png`, fullPage: true });
  });

  it("two roots in the window still draw one card, and the counter says which scope it means", async () => {
    await page.setViewport({ width: 880, height: 1200 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "system", fixture: "multi-workspace-window" },
      width: 880,
      height: 1200,
      waitFor: '[data-testid="control-system"]',
    });
    // `buildCockpitModel` scopes `control.workspaces` to the selected root: one card, always.
    expect(await surface.evaluate(() => document.querySelectorAll(".ci-ws").length)).toBe(1);
    const metrics = await readMetrics(surface);
    expect(metrics.Workspaces, "the value must match the cards, never the window").toBe("1");
    const sub = await surface.evaluate(() => document.querySelector(".ck-metric .sub")?.textContent?.trim() ?? "");
    expect(sub, "the window's count must say its own scope").toBe("of 2 in this window");
  });
});
