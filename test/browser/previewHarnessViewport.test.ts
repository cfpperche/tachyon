import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview, previewSurface } from "./support/preview";

// t-b24282 — the harness's OWN width contract, measured through the door an operator actually uses.
//
// The defect this pins: `?width=360` used to size a DIV inside a 1280px page, so the surface reflowed by
// container width while `window.innerWidth` stayed 1280 and EVERY `@media (max-width: …)` stayed dormant.
// A narrow screenshot taken that way shows a layout the product never produces at that width — false
// green, which is worse than no measurement at all. The browser viewport alone is the mirror-image lie:
// media queries fire, but the surface keeps the route's wide frame and overflows the viewport, inventing
// horizontal overflow that does not exist.
//
// So this file asserts BOTH halves from ONE knob, deliberately WITHOUT the caller touching the browser
// viewport: `?width=` must move the viewport the surface evaluates `@media` against AND the box it lays
// out in, and `documentElement.scrollWidth` must come back equal to the width that was asked for.

const OPERATOR_VIEWPORT = { width: 1280, height: 900 } as const;

describe("t-b24282 — ?width= alone pins the surface viewport, not just a container", () => {
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

  async function open(page: Page, width: number): Promise<Frame> {
    // the operator sets NOTHING but the harness parameter — a wide browser window, one narrow request.
    await page.setViewport({ ...OPERATOR_VIEWPORT });
    return openPreview(page, server.origin, {
      query: { view: "plugins", fixture: "default" },
      width,
      height: 760,
      waitFor: ".installed-toolbar",
    });
  }

  it("fires a `@media (max-width: 400px)` rule at ?width=360", async () => {
    const page = await browser.newPage();
    const surface = await open(page, 360);

    const probe = await surface.evaluate(() => {
      // a rule that can ONLY apply through the viewport: `@media` never reads a parent box.
      const style = document.createElement("style");
      style.textContent =
        "#t-b24282-probe { outline: 1px solid red } @media (max-width: 400px) { #t-b24282-probe { outline-width: 7px } }";
      document.head.appendChild(style);
      const el = document.createElement("div");
      el.id = "t-b24282-probe";
      document.body.appendChild(el);
      return {
        innerWidth: window.innerWidth,
        matches: window.matchMedia("(max-width: 400px)").matches,
        outlineWidth: getComputedStyle(el).outlineWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    expect(probe.innerWidth).toBe(360);
    expect(probe.matches).toBe(true);
    expect(probe.outlineWidth).toBe("7px");
    // the guard from the task: no invented horizontal overflow, and no width other than the one asked for.
    expect(probe.scrollWidth).toBe(360);
    await page.close();
  });

  it("applies the real plugins `@media (max-width: 720px)` block at ?width=360", async () => {
    const page = await browser.newPage();
    const surface = await open(page, 360);

    const columns = await surface.$eval(".installed-toolbar", (el) => getComputedStyle(el).gridTemplateColumns);
    // the breakpoint collapses the toolbar to a single column; a container-only shrink never reaches it.
    expect(columns.split(" ").length).toBe(1);
    await page.close();
  });

  it("leaves the same rules dormant at ?width=880", async () => {
    const page = await browser.newPage();
    const surface = await open(page, 880);

    const probe = await surface.evaluate(() => ({
      innerWidth: window.innerWidth,
      matches: window.matchMedia("(max-width: 400px)").matches,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    const columns = await surface.$eval(".installed-toolbar", (el) => getComputedStyle(el).gridTemplateColumns);

    expect(probe.innerWidth).toBe(880);
    expect(probe.matches).toBe(false);
    expect(probe.scrollWidth).toBe(880);
    expect(columns.split(" ").length).toBeGreaterThan(1);
    await page.close();
  });

  it("leaves content below the fold reachable instead of clipping it", async () => {
    // the third gotcha in t-b24282: the old `#frame` div was `overflow: hidden` with no scrollbar, so
    // anything past the frame height was unreachable — scrolling did nothing. A viewport scrolls.
    const page = await browser.newPage();
    const surface = await openPreview(page, server.origin, {
      query: { view: "plugins", fixture: "default" },
      width: 360,
      height: 300,
      waitFor: ".installed-toolbar",
    });

    const scrolled = await surface.evaluate(() => {
      const before = window.scrollY;
      window.scrollTo(0, 400);
      return {
        overflows: document.documentElement.scrollHeight > window.innerHeight,
        before,
        after: window.scrollY,
      };
    });

    expect(scrolled.overflows).toBe(true);
    expect(scrolled.before).toBe(0);
    expect(scrolled.after).toBeGreaterThan(0);
    await page.close();
  });

  it("refuses to render the surface opened outside the sized frame", async () => {
    // the second door: surface.html on its own inherits the BROWSER viewport, which is the defect. It
    // must fail loud rather than render something that looks like a clean 360px screenshot.
    const page = await browser.newPage();
    await page.setViewport({ ...OPERATOR_VIEWPORT });
    await page.goto(`${server.origin}/scripts/webview-preview/surface.html?view=plugins&fixture=default&width=360`, {
      waitUntil: "networkidle0",
    });

    const text = await page.$eval("#root", (el) => el.textContent || "");
    expect(text).toContain("opened directly");
    expect(await page.$(".installed-toolbar")).toBeNull();
    await page.close();
  });

  it("refuses to render a frame sized differently from the width it was asked for", async () => {
    // The surface re-checks the shell's arithmetic from inside, so the two readers of the number have to
    // agree. Without this, a shell that loses a pixel to a border (box-sizing) would shift every
    // breakpoint by that pixel and no test would say so — it would just quietly measure 359.
    const page = await browser.newPage();
    await page.setViewport({ ...OPERATOR_VIEWPORT });
    await page.goto(`${server.origin}/scripts/webview-preview/index.html?view=plugins&fixture=default&width=880`, {
      waitUntil: "networkidle0",
    });

    const message = await page.evaluate(async () => {
      const wrong = document.createElement("iframe");
      wrong.style.cssText = "width:500px;height:760px;border:0";
      wrong.src = "/scripts/webview-preview/surface.html?view=plugins&fixture=default&width=360&height=760";
      document.body.appendChild(wrong);
      await new Promise((resolve) => wrong.addEventListener("load", resolve, { once: true }));
      return wrong.contentDocument?.getElementById("root")?.textContent ?? "";
    });

    expect(message).toContain("frame width mismatch");
    expect(message).toContain("?width=360");
    expect(message).toContain("500px");
    await page.close();
  });
});

// t-4a477f — the catalog door is the other half of t-b24282. routes.json URLs carry view+fixture
// and no `?width=`, because one entry is photographed at 880 and at 360. The visual-qa skill
// then shrinks the OUTER window and screenshots that page. Before this, the iframe stayed at
// route.frame (900 for Agent Studio) and the photo was a crop of the wide layout — the
// isolationtruth 360 shot that invented t-cd554e. The shell must pass the photo's width into
// the iframe when the catalog omitted it. Explicit `?width=` is still the puppeteer door above.
describe("t-4a477f — catalog URL + outer viewport pins the iframe, not a crop of route.frame", () => {
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

  // The catalog URL the skill actually opens: no width query. Agent Studio dense-edit is the
  // incident surface (ev-2026-08-12T19:58:40.615Z-2); its route.frame is 900 and its check
  // grid collapses only when `@media (max-width: 720px)` sees a 360 iframe.
  const catalogUrl = (origin: string) =>
    `${origin}/scripts/webview-preview/index.html?view=agent-studio-shell&fixture=dense-edit`;

  async function openCatalogAt(page: Page, width: number): Promise<Frame> {
    await page.setViewport({ width, height: 1200 });
    await page.goto(catalogUrl(server.origin), { waitUntil: "networkidle0" });
    const surface = await previewSurface(page);
    await surface.waitForSelector(".ash-check-grid", { visible: true });
    return surface;
  }

  it("at an outer 360px window, the catalog URL's iframe viewport is 360 and the 720px rules fire", async () => {
    const page = await browser.newPage();
    const surface = await openCatalogAt(page, 360);

    const probe = await surface.evaluate(() => {
      const grid = document.querySelector(".ash-check-grid");
      return {
        innerWidth: window.innerWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns : "",
        matches: window.matchMedia("(max-width: 720px)").matches,
      };
    });

    expect(probe.innerWidth, "catalog URL photographed at 360 must not keep route.frame (900)").toBe(360);
    expect(probe.matches).toBe(true);
    expect(probe.columns.split(" ").length).toBe(1);
    await page.close();
  });

  it("at an outer 880px window, the same catalog URL stays the wide layout", async () => {
    const page = await browser.newPage();
    const surface = await openCatalogAt(page, 880);

    const probe = await surface.evaluate(() => {
      const grid = document.querySelector(".ash-check-grid");
      return {
        innerWidth: window.innerWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns : "",
        matches: window.matchMedia("(max-width: 720px)").matches,
      };
    });

    expect(probe.innerWidth).toBe(880);
    expect(probe.matches).toBe(false);
    expect(probe.columns.split(" ").length).toBe(3);
    await page.close();
  });

  it("resizing the outer window after a catalog load moves the iframe with it", async () => {
    const page = await browser.newPage();
    await openCatalogAt(page, 880);
    await page.setViewport({ width: 360, height: 1200 });
    await page.waitForFunction(
      () => {
        const frame = document.querySelector("iframe#frame") as HTMLIFrameElement | null;
        return frame?.contentWindow?.innerWidth === 360;
      },
      { timeout: 5_000 },
    );
    const surface = await previewSurface(page);
    const probe = await surface.evaluate(() => ({
      innerWidth: window.innerWidth,
      matches: window.matchMedia("(max-width: 720px)").matches,
    }));
    expect(probe.innerWidth).toBe(360);
    expect(probe.matches).toBe(true);
    await page.close();
  });
});
