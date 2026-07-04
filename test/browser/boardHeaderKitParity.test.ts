import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import type { MissionControlVM } from "../../src/webview/mission-control/messages";

// t-6da5f0 — maintainer dogfood (screenshot, 0.55.14): the board header's search input, "All agents" select,
// and +Task/Dropped buttons render at visibly different heights on the SAME row. kitLegacyParity.test.ts
// already proves KitSelect's OWN box model matches `.ds-input` in the abstract (a synthetic ui-gate page);
// this drives the REAL dist/webview/mission-control.js bundle + mission-control.css instead, the same way
// pilotBTaskStudio.test.ts's dogfood-round-2 (#1) test proves a REAL row's parity, not just an isolated
// trigger — the bug here was entirely in mission-control.css's own overrides (`.board-search`'s split outer/
// inner padding, `.ds-btn`'s shorter padding token), which a page that never links that stylesheet can't catch.
const FIXTURE_VM: MissionControlVM = {
  folder: "/tmp/demo",
  wsHash: "ws1",
  workspaces: [{ hash: "ws1", folder: "/tmp/demo" }],
  snapshot: { views: [], allowedDropStatuses: {}, chips: [] },
};

function hostPage(cspSource: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${cspSource}/dist/webview/codicon.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/design-system.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/vscode-theme.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/mission-control.tailwind.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/mission-control.css">
<title>mission-control board header parity</title></head>
<body><div id="root"></div><script src="${cspSource}/dist/webview/mission-control.js"></script></body></html>`;
}

async function loadMissionControl(page: Page, origin: string, vm: MissionControlVM): Promise<void> {
  await page.setContent(hostPage(origin), { waitUntil: "domcontentloaded" });
  await page.evaluate((v) => {
    const onReady = (e: MessageEvent) => {
      const d = e.data as { type?: string } | undefined;
      if (d?.type === "ready") {
        window.removeEventListener("message", onReady);
        window.postMessage({ type: "snapshot", vm: v }, "*");
      }
    };
    window.addEventListener("message", onReady);
  }, vm);
  await page.waitForSelector(".mc-head", { visible: true, timeout: 5000 });
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

  it("workspace select, search box, agent-filter KitSelect, and the +Task/Dropped buttons all compute the same height + baseline", async () => {
    const page = await browser.newPage();
    await loadMissionControl(page, server.origin, FIXTURE_VM);

    const boxOf = (selector: string) =>
      page.$eval(selector, (el) => {
        const r = el.getBoundingClientRect();
        return { height: Math.round(r.height), top: Math.round(r.top) };
      });

    const search = await boxOf(".board-search");
    const workspaceSelect = await boxOf('.mc-scope [data-slot="select-trigger"]');
    const agentSelect = await boxOf('.agent-filter [data-slot="select-trigger"]');
    const taskButton = await boxOf('.mc-head button.ds-btn');

    expect(workspaceSelect.height).toBe(search.height);
    expect(workspaceSelect.top).toBe(search.top);
    expect(agentSelect.height).toBe(search.height);
    expect(agentSelect.top).toBe(search.top);
    expect(taskButton.height).toBe(search.height);
    expect(taskButton.top).toBe(search.top);

    await page.close();
  });
});
