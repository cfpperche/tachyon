import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

// t-b24282 — `width` goes to the harness ONCE and lands on the surface's own viewport, so the 620px
// `@media` in design-system.css that this file is about actually evaluates at 360.
//
// t-5f2b5b — the two subjects used to be Fleet and the Board. The Fleet app is deleted (owner decision,
// 2026-08-07: the sidebar Agents tab is the only fleet), so its ROW moved rather than disappearing: the
// claim here is about the SHARED PageChrome action region under `@media max-width 620`, and dropping to a
// single subject would leave that primitive measured on one page only. The Human Inbox is the replacement
// with the same shape Fleet had — title + hint + an action in `PageChrome`'s actions slot.
const SURFACES = {
  inbox: { view: "human-inbox", fixture: "list", waitFor: "[data-testid=inbox-counts]" },
  mission: { view: "board", fixture: "default", waitFor: ".mc-head-tools" },
} as const;

async function loadFixture(
  page: Page,
  origin: string,
  fixture: keyof typeof SURFACES,
  width: number,
): Promise<Frame> {
  const surface = SURFACES[fixture];
  await page.setViewport({ width, height: 760 });
  return openPreview(page, origin, {
    query: { view: surface.view, fixture: surface.fixture },
    width,
    height: 760,
    waitFor: surface.waitFor,
  });
}

type ReflowBox = {
  containerBottom: number;
  containerRight: number;
  actionsLeft: number;
  actionsRight: number;
  actionsTop: number;
  mainBottom: number;
};

async function measure(
  surface: Frame,
  container: string,
  main: string,
  actions: string,
): Promise<ReflowBox> {
  return surface.$eval(
    container,
    (element, selectors) => {
      const box = (selector: string) =>
        element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const root = element.getBoundingClientRect();
      const mainBox = box(selectors.main);
      const actionsBox = box(selectors.actions);
      return {
        containerBottom: root.bottom,
        containerRight: root.right,
        actionsLeft: actionsBox.left,
        actionsRight: actionsBox.right,
        actionsTop: actionsBox.top,
        mainBottom: mainBox.bottom,
      };
    },
    { main, actions },
  );
}

describe("t-ededdd — shared action regions reflow instead of leaving the viewport", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
    });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it.each([
    // t-41117e — the action-bearing shared region is PageChrome, not ListRow. The reflow claim is
    // unchanged: @media max-width 620 on shared primitives. ListRow remains covered wherever a surface
    // still uses it. t-5f2b5b — the first subject is the Human Inbox now; see SURFACES above.
    {
      fixture: "inbox" as const,
      container: ".ds-page-chrome",
      main: ".ds-page-chrome-text",
      actions: ".ds-page-chrome-actions",
    },
    {
      fixture: "mission" as const,
      container: ".ds-page-chrome",
      main: ".ds-page-chrome-text",
      actions: ".ds-page-chrome-actions",
    },
  ])(
    "puts $fixture actions below content and entirely inside the container at 360px",
    async ({ fixture, container, main, actions }) => {
      const page = await browser.newPage();
      const surface = await loadFixture(page, server.origin, fixture, 360);
      const result = await measure(surface, container, main, actions);

      expect(result.actionsTop).toBeGreaterThanOrEqual(result.mainBottom);
      expect(result.actionsRight).toBeLessThanOrEqual(result.containerRight);
      expect(result.actionsRight).toBeGreaterThan(result.actionsLeft);
      expect(result.containerBottom).toBeGreaterThanOrEqual(result.actionsTop);
      await page.close();
    },
  );

  it.each([
    {
      fixture: "inbox" as const,
      container: ".ds-page-chrome",
      main: ".ds-page-chrome-text",
      actions: ".ds-page-chrome-actions",
    },
    {
      fixture: "mission" as const,
      container: ".ds-page-chrome",
      main: ".ds-page-chrome-text",
      actions: ".ds-page-chrome-actions",
    },
  ])(
    "keeps the established side-by-side $fixture composition at 880px",
    async ({ fixture, container, main, actions }) => {
      const page = await browser.newPage();
      const surface = await loadFixture(page, server.origin, fixture, 880);
      const result = await measure(surface, container, main, actions);

      expect(result.actionsTop).toBeLessThan(result.mainBottom);
      expect(result.actionsRight).toBeLessThanOrEqual(result.containerRight);
      await page.close();
    },
  );
});
