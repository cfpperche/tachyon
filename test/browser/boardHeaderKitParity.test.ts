import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// t-6da5f0 — maintainer dogfood (screenshot, 0.55.14): the board header's search input, "All agents" select,
// and +Task/Dropped buttons render at visibly different heights on the SAME row. kitLegacyParity.test.ts
// already proves KitSelect's OWN box model matches `.ds-input` in the abstract (a synthetic ui-gate page);
// this drives the REAL shipped bundle + mission-control.css instead, the same way pilotBTaskStudio.test.ts's
// dogfood-round-2 (#1) test proves a REAL row's parity, not just an isolated trigger — the bug here was
// entirely in mission-control.css's own overrides (`.board-search`'s split outer/inner padding, `.ds-btn`'s
// shorter padding token), which a page that never links that stylesheet can't catch.
//
// t-c55f8d (2026-08-01): `dist/webview/mission-control.js` is gone — the board ships inside cockpit.js as a
// Control section. The hand-rolled host page 404'd on that script and the header never rendered. The harness
// route below links the same stylesheet set and pushes the catalog's board VM, so the parity measured is
// still the real header's under the real CSS.
const PREVIEW = "/scripts/webview-preview/index.html?view=cockpit&fixture=mission&width=1100&height=760";

async function loadMissionControl(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}${PREVIEW}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".mc-head", { visible: true, timeout: 15_000 });
}

describe("Board header: Kit vs legacy box-model parity on the real bundle (t-6da5f0)", () => {
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

  it("search box, agent-filter KitSelect, and the +Task/Dropped buttons all compute the same height + baseline", async () => {
    const page = await browser.newPage();
    await loadMissionControl(page, server.origin);

    const boxOf = (selector: string) =>
      page.$eval(selector, (el) => {
        const r = el.getBoundingClientRect();
        return { height: Math.round(r.height), top: Math.round(r.top) };
      });

    const search = await boxOf(".board-search");
    // t-c55f8d: `.mc-scope`, the Board's own workspace dropdown, was DELIBERATELY removed in t-46eb4f —
    // it mirrored the shell's global `controlWsHash`, so Control carried two scope controls that could
    // disagree on screen. Root is chosen once, in Overview. There is nothing left to measure here, and
    // asserting on it kept a removed control alive in the test's name. The filters beside it — which
    // filter this screen's own collection and touch no global state — are the row this test is about.
    const agentSelect = await boxOf('.agent-filter [data-slot="select-trigger"]');
    const taskButton = await boxOf('.mc-head button.ds-btn');

    expect(agentSelect.height).toBe(search.height);
    expect(agentSelect.top).toBe(search.top);
    // t-c55f8d left this pair RED on purpose: on 2026-08-01 the shipped bundle rendered +Task/Dropped
    // at 32px/top 42 while search and the agent filter measured 34px/top 41 — the t-6da5f0 dogfood bug
    // back on the same row, 2px short and 1px low. 7be4265a ("one Button box") had deleted t-6da5f0's
    // `.mc-head .ds-btn` override and folded its padding + font-size into the global `.ds-btn`; two of
    // the three height terms carried over and the third did not, because `.ds-btn` declared
    // `line-height: 1.2` (14.4px at 12px) where `.ds-input` and the trigger left `normal` (16px).
    //
    // t-b8b85c made it green, and NOT by reconciling the numbers a third time: `.ds-btn`, `.ds-input`
    // and `[data-slot="select-trigger"]` now take padding, border-width, font and line box from ONE
    // shared rule in design-system.css, so there is no longer a per-selector copy that can go stale.
    // If this ever reddens again, the structural guard in test/unit/uiPatterns.test.ts should have
    // reddened first — that one runs even when this browser suite is dark, which it was on the day
    // 7be4265a landed (the bundle it loaded 404'd), and which is why the regression got in unseen.
    expect(taskButton.height).toBe(search.height);
    expect(taskButton.top).toBe(search.top);

    // the nominal --ds-control-h is a DERIVED number that is supposed to describe the real box; assert
    // it against the box actually rendered, so the token cannot become decorative the way `.ds-btn`'s
    // old `min-height: 28px` did (it described no button on any screen).
    const nominal = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--ds-control-h").trim(),
    );
    expect(nominal).toBe(`${search.height}px`);

    await page.close();
  });
});
