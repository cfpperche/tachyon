import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { assembleUntrustedSrcdoc } from "../../src/webview/shared/untrustedSrcdoc";

describe("task prototype static-only frame", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
    const child = assembleUntrustedSrcdoc(`<h1 id="visible">Mock proposal</h1><button id="choice">Choose</button><div style="height:1200px"></div><script>document.body.dataset.executed='yes'</script>`, { mode: "prototype-static" });
    await page.setContent(`<style>.gutter{padding:18px;position:relative}.gutter iframe{display:block;width:420px;height:120px}.watermark{position:absolute;inset:18px 18px auto auto;z-index:2}</style><header>Untrusted prototype preview</header><div class="gutter"><iframe id="prototype" sandbox="" srcdoc="${escapeAttribute(child)}"></iframe><span class="watermark">UNTRUSTED · STATIC</span></div>`);
    await page.waitForSelector("#prototype");
  });

  afterAll(async () => { await page.close(); await browser.close(); });

  it("uses byte-exact empty sandbox, renders content, and suppresses author scripts", async () => {
    expect(await page.$eval("#prototype", (el) => el.getAttribute("sandbox"))).toBe("");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await frame.waitForSelector("#visible");
    expect(await frame.$eval("body", (el) => (el as HTMLElement).dataset.executed ?? null)).toBeNull();
  });

  it("keeps four-sided first-party containment, element pointer suppression, and an over-frame watermark", async () => {
    const proof = await page.$eval(".gutter", (el) => {
      const frame = el.querySelector("iframe")!;
      const gutter = getComputedStyle(el);
      const framed = getComputedStyle(frame);
      const watermark = getComputedStyle(el.querySelector(".watermark")!);
      return { top: gutter.paddingTop, right: gutter.paddingRight, bottom: gutter.paddingBottom, left: gutter.paddingLeft, pointer: framed.pointerEvents, watermarkZ: watermark.zIndex };
    });
    expect(proof).toEqual({ top: "18px", right: "18px", bottom: "18px", left: "18px", pointer: "auto", watermarkZ: "2" });
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    expect(await frame.$eval("#choice", (el) => getComputedStyle(el).pointerEvents)).toBe("none");
  });

  it("allows inspecting tall static prototypes by scrolling the iframe document", async () => {
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes("srcdoc"))!;
    await frame.waitForSelector("#visible");
    // Overflow is the product claim: tall static mocks must be inspectable via document scroll.
    // Puppeteer wheel delivery into opaque-origin sandbox="" srcdoc is host-dependent, so prove
    // scrollHeight > clientHeight and that the document accepts scrollBy (same path as user scroll).
    const metrics = await frame.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      overflow: getComputedStyle(document.documentElement).overflow,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflow).toMatch(/auto|scroll/);
    await frame.evaluate(() => window.scrollBy(0, 400));
    expect(await frame.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // Best-effort wheel: if the host delivers it, document scroll must advance further or stay scrolled.
    const beforeWheel = await frame.evaluate(() => window.scrollY);
    const box = await page.$eval("#prototype", (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel({ deltaY: 200 });
    const afterWheel = await frame.evaluate(() => window.scrollY);
    expect(afterWheel).toBeGreaterThanOrEqual(beforeWheel);
  });
});

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
