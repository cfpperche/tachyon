import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import type { ActivityItem, ActivityViewModel } from "@tachyon/webview-ui/activity/activityView";
import { activityMessage } from "@tachyon/webview-ui/webview/activity/messages";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

/**
 * t-544911 — Activity must open on the latest message and follow a live append.
 *
 * Production door: the shipped `activity.js` bundle inside the preview harness, with the same
 * stylesheet list ActivityPanel links. The host push is the real `activityMessage` envelope
 * `ActivityPanelManager` posts — not a helper that fakes scrollTop.
 *
 * The regression: SDD 410 C.2 retargeted stick-to-bottom onto Control's overflow:auto embed host.
 * SDD 485 D17 made Activity a document-scrolling standalone app again and left that retarget in
 * place. Setting `main.scrollTop` is a no-op when `main` does not overflow, so the window stays
 * at 0 (oldest items + "Load earlier activity").
 */

const VIEWPORT = { width: 880, height: 480 } as const;
const ON_OPEN = "LATEST-ON-OPEN the work is here";
const AFTER_APPEND = "LATEST-AFTER-APPEND a new event arrived";
const WHILE_READING = "LATEST-WHILE-READING should not yank";
const OLDEST = "OLDEST-IN-WINDOW load-earlier sits above this";

function item(sequence: number, title: string, hour: number, minute: number): ActivityItem {
  return {
    sequence,
    kind: "message",
    role: sequence % 2 === 0 ? "user" : "agent",
    title,
    timestamp: `2026-08-16T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
  };
}

function tallVm(lastTitle: string, extra: ActivityItem[] = []): ActivityViewModel {
  const older: ActivityItem[] = Array.from({ length: 48 }, (_, index) =>
    item(index + 1, index === 0 ? OLDEST : `older message ${index + 1}`, 0, index % 60),
  );
  const latest = item(older.length + extra.length + 1, lastTitle, 14, 0);
  const items = [...older, ...extra, latest];
  return {
    tier: "structured",
    runtime: "claude",
    summary: {
      messages: items.length,
      toolsRunning: 0,
      toolsFailed: 0,
      filesChanged: [],
      filesReferenced: [],
      tokens: { input: 4394, output: 1_340_721 },
    },
    items,
    totalItems: 4394,
    hasOlder: true,
    agentState: "working",
  };
}

interface TranscriptMetrics {
  nearBottom: boolean;
  overflow: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  latestVisible: boolean;
  oldestVisible: boolean;
  loadEarlierVisible: boolean;
}

describe("t-544911 — Activity opens on the latest message (production activity.js)", () => {
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

  async function openActivity(page: Page): Promise<Frame> {
    await page.setViewport(VIEWPORT);
    const surface = await openPreview(page, server.origin, {
      query: { view: "activity", fixture: "default" },
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      waitFor: ".feed",
      timeout: HANG_TIMEOUT_MS,
    });
    await surface.waitForFunction(() => document.body.dataset.previewView === "activity", { timeout: HANG_TIMEOUT_MS });
    return surface;
  }

  async function pushVm(surface: Frame, vm: ActivityViewModel, prepended = false): Promise<void> {
    const message = activityMessage("preview", "agent", vm, prepended);
    await surface.evaluate((payload) => {
      window.postMessage(payload, "*");
    }, message);
    const last = vm.items.at(-1)?.title ?? "";
    await surface.waitForFunction((title: string) => document.body.innerText.includes(title), { timeout: HANG_TIMEOUT_MS }, last);
    await surface.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }

  async function metrics(surface: Frame, latestTitle: string): Promise<TranscriptMetrics> {
    return surface.evaluate((latest, oldest) => {
      const el = document.scrollingElement ?? document.documentElement;
      const visible = (text: string): boolean => {
        const nodes = [...document.querySelectorAll("body *")].filter((node) => node.textContent?.includes(text));
        const target = nodes.at(-1);
        if (!target) return false;
        const rect = target.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      };
      return {
        nearBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 140,
        overflow: el.scrollHeight > el.clientHeight + 140,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        latestVisible: visible(latest),
        oldestVisible: visible(oldest),
        loadEarlierVisible: visible("Load earlier activity"),
      };
    }, latestTitle, OLDEST);
  }

  it("a freshly opened Activity lands on the newest item, not Load earlier", async () => {
    const page = await browser.newPage();
    const surface = await openActivity(page);
    await pushVm(surface, tallVm(ON_OPEN));

    const shot = await metrics(surface, ON_OPEN);
    expect(shot.overflow, "the fixture must overflow or this is not the owner's defect").toBe(true);
    expect(shot.nearBottom, `document stayed at ${shot.scrollTop}/${shot.scrollHeight}`).toBe(true);
    expect(shot.latestVisible, "the newest bubble is offscreen").toBe(true);
    expect(shot.loadEarlierVisible, "Load earlier activity is still in view — that is the top of the window").toBe(false);
    expect(shot.oldestVisible, "the oldest loaded item is still in view").toBe(false);
    await page.close();

    const narrow = await browser.newPage();
    await narrow.setViewport({ width: 360, height: 480 });
    const narrowSurface = await openPreview(narrow, server.origin, {
      query: { view: "activity", fixture: "default" },
      width: 360,
      height: 480,
      waitFor: ".feed",
      timeout: HANG_TIMEOUT_MS,
    });
    await pushVm(narrowSurface, tallVm(ON_OPEN));
    const narrowShot = await metrics(narrowSurface, ON_OPEN);
    expect(narrowShot.nearBottom, "360px open also stayed at the top").toBe(true);
    expect(narrowShot.latestVisible).toBe(true);
    await narrow.close();
  });

  it("a live append with the tab open follows when the user is already at the bottom", async () => {
    const page = await browser.newPage();
    const surface = await openActivity(page);
    await pushVm(surface, tallVm(ON_OPEN));
    expect((await metrics(surface, ON_OPEN)).nearBottom).toBe(true);

    const appended = item(49, "mid-feed append", 13, 59);
    await pushVm(surface, tallVm(AFTER_APPEND, [appended]));

    const shot = await metrics(surface, AFTER_APPEND);
    expect(shot.nearBottom, "a new event arrived and the document did not follow").toBe(true);
    expect(shot.latestVisible).toBe(true);
    await page.close();
  });

  it("a live append does not yank the user who scrolled up to read history", async () => {
    const page = await browser.newPage();
    const surface = await openActivity(page);
    await pushVm(surface, tallVm(ON_OPEN));
    await surface.evaluate(() => window.scrollTo(0, 0));
    await surface.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
    expect((await metrics(surface, ON_OPEN)).nearBottom).toBe(false);

    await pushVm(surface, tallVm(WHILE_READING));
    const shot = await metrics(surface, WHILE_READING);
    expect(shot.nearBottom, "reading history was yanked back to the latest event").toBe(false);
    expect(shot.loadEarlierVisible).toBe(true);
    await page.close();
  });

  it("a catch-up push on a still-mounted view (return-to-tab) stays at the latest", async () => {
    const page = await browser.newPage();
    const surface = await openActivity(page);
    const vm = tallVm(ON_OPEN);
    await pushVm(surface, vm);
    expect((await metrics(surface, ON_OPEN)).nearBottom).toBe(true);

    await pushVm(surface, vm);
    const shot = await metrics(surface, ON_OPEN);
    expect(shot.nearBottom, "onReveal catchUp left the document off the latest").toBe(true);
    expect(shot.latestVisible).toBe(true);
    await page.close();
  });
});
