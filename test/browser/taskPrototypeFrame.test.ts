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
    const child = assembleUntrustedSrcdoc(`<h1 id="visible">Mock proposal</h1><script>document.body.dataset.executed='yes'</script>`, { mode: "prototype-static" });
    await page.setContent(`<style>.gutter{padding:18px;position:relative}.gutter iframe{pointer-events:none}.watermark{position:absolute;inset:18px 18px auto auto;z-index:2}</style><header>Untrusted prototype preview</header><div class="gutter"><iframe id="prototype" sandbox="" srcdoc="${escapeAttribute(child)}"></iframe><span class="watermark">UNTRUSTED · STATIC</span></div>`);
    await page.waitForSelector("#prototype");
  });

  afterAll(async () => { await page.close(); await browser.close(); });

  it("uses byte-exact empty sandbox, renders content, and suppresses author scripts", async () => {
    expect(await page.$eval("#prototype", (el) => el.getAttribute("sandbox"))).toBe("");
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    await frame.waitForSelector("#visible");
    expect(await frame.$eval("body", (el) => (el as HTMLElement).dataset.executed ?? null)).toBeNull();
  });

  it("keeps four-sided first-party containment, pointer suppression, and an over-frame watermark", async () => {
    const proof = await page.$eval(".gutter", (el) => {
      const frame = el.querySelector("iframe")!;
      const gutter = getComputedStyle(el);
      const framed = getComputedStyle(frame);
      const watermark = getComputedStyle(el.querySelector(".watermark")!);
      return { top: gutter.paddingTop, right: gutter.paddingRight, bottom: gutter.paddingBottom, left: gutter.paddingLeft, pointer: framed.pointerEvents, watermarkZ: watermark.zIndex };
    });
    expect(proof).toEqual({ top: "18px", right: "18px", bottom: "18px", left: "18px", pointer: "none", watermarkZ: "2" });
  });
});

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
