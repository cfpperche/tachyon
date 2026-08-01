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
    // t-c55f8d — THIS PAIR IS RED ON PURPOSE, and the red is the point: measured 2026-08-01 on the
    // shipped bundle, +Task/Dropped compute 32px at top 42 while search and the agent filter compute
    // 34px at top 41. That is the t-6da5f0 dogfood bug back on the same row, 2px short and 1px low.
    //
    // How it came back: 7be4265a ("one Button box") deleted the `.mc-head .ds-btn` override t-6da5f0
    // had added, folding its padding + font-size into the global `.ds-btn`. Those two thirds carried
    // over; the third did not — `.ds-btn` still declares `line-height: 1.2` (14.4px at 12px font),
    // while `.ds-input` and the Kit select-trigger leave line-height `normal` (~15.6px). 8+8 padding
    // + 2 border + 14.4 = 32.4 against 34.
    //
    // NOT fixed here: this is a product defect in a shared token, not a stale assertion. `.ds-btn` is
    // the one button box for every surface in the extension, so raising it to match the input row is a
    // repo-wide visual change that belongs to whoever owns the design system, with its own dogfood.
    // Left failing so it is finally visible — this guard was dark (the bundle it loaded 404'd) on the
    // day 7be4265a landed, which is exactly why the regression got in unseen.
    expect(taskButton.height).toBe(search.height);
    expect(taskButton.top).toBe(search.top);

    await page.close();
  });
});
