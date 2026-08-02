import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

/**
 * t-fb216a — visual evidence for the Plugins card's runtime-coverage notice.
 *
 * ANCHOR (from the task's problem statement, not from what the screen ended up looking like — the
 * complaint being answered is "Painel de Plugins: 'Already up to date.'" with nothing else said):
 *
 *   A human looking at the Plugins panel in a workspace that runs grok can tell, WITHOUT clicking
 *   anything, that an installed plugin supports grok and was never installed for it; can see which
 *   gesture closes that gap; and can see that the gesture does not drop the gate for the runtimes
 *   that already have it. A plugin that IS covered stays quiet.
 *
 * Measured at 880 and 360 (this repo's pair). The narrow width is the one that matters here: the
 * notice is a prose paragraph living inside a card whose header is already a flex row of badges and
 * buttons, and a sentence that only reads at desktop width is the classic per-row collapse.
 *
 * Drives the REAL shipped bundle through the dev preview harness with the captured `runtime-gap` VM
 * (whose fidelity to the real builder is pinned by test/unit/webviewPreviewPluginsFixture.test.ts),
 * so this judges the surface a human actually gets.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/fb216a-plugin-runtime-gap");

/**
 * The harness sizes the SURFACE from `&width=`/`&height=`, not from the browser viewport: `#frame` is a
 * fixed-size, `overflow:hidden` box, and the cockpit route's own frame is 1100px wide. Setting only the
 * viewport (the first version of this test) left the surface at 1100 and merely CLIPPED it — every card
 * stayed 1067px at both widths, so "measured at two widths" would have been a fiction, and the overflow
 * check passed vacuously because `documentElement` reports the clip while `body` reports the real 1100.
 * Frame height is generous enough that the last card is inside the box rather than cut off by the clip.
 */
const routeAt = (w: number, h: number) => `?view=cockpit&fixture=plugins-runtime-gap&width=${w}&height=${h}`;
const WIDE = { w: 880, h: 1200 };
const NARROW = { w: 360, h: 1980 };

describe("Plugins card — runtime-coverage notice (t-fb216a)", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# Plugins runtime-coverage notice (t-fb216a)\n\nRendered by \`test/browser/pluginRuntimeGapShots.test.ts\` from the real webview bundle and the\ncaptured \`runtime-gap\` fixture VM (the measured 0.56.158 field state: every card truthfully\n"up to date" while this workspace runs grok and three of four installs never covered it).\nEach shot is also asserted not to scroll horizontally at its width.\n\nRegenerate with:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/pluginRuntimeGapShots.test.ts\n\`\`\`\n\n${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  /** Load the gap fixture at one frame width, prove nothing inside the frame scrolls sideways, capture the shot. */
  async function shoot(name: string, { w, h }: { w: number; h: number }): Promise<void> {
    await page.setViewport({ width: w + 40, height: Math.min(h + 40, 4000), deviceScaleFactor: 2 });
    await page.goto(`${server.origin}/scripts/webview-preview/index.html${routeAt(w, h)}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".pgap", { visible: true, timeout: 5000 });

    // the real check: no DESCENDANT of the frame overflows it. A reviewer scrolling a screenshot cannot
    // see a card that scrolls sideways, and the notice is the widest prose on this surface.
    const measured = await page.evaluate(() => {
      const frame = document.getElementById("frame")!;
      const over = [...frame.querySelectorAll("*")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => `${(e.className || e.tagName).toString().slice(0, 60)} (${e.scrollWidth} > ${e.clientWidth})`);
      const cards = [...document.querySelectorAll(".ds-card")].map((c) => ({
        name: c.querySelector(".pname")?.textContent ?? "",
        width: Math.round(c.getBoundingClientRect().width),
        bottom: Math.round(c.getBoundingClientRect().bottom),
      }));
      return { frameW: frame.clientWidth, over, cards };
    });
    expect(measured.over, `${name}: content overflows the ${w}px frame`).toEqual([]);
    // proves the surface actually REFLOWED to this width instead of being clipped at the route's own frame
    expect(measured.cards.every((c) => c.width < w), `${name}: cards did not reflow to ${w}px`).toBe(true);
    // …and that the last card is inside the clip box, so the shot is not silently missing evidence
    expect(measured.cards.at(-1)!.bottom, `${name}: last card is cut off by the frame`).toBeLessThanOrEqual(h);

    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  it("shoots the notice at 880 (wide)", async () => {
    await shoot("runtime-gap-880", WIDE);
  });

  it("shoots the notice at 360 (narrow)", async () => {
    await shoot("runtime-gap-360", NARROW);
  });

  /**
   * The anchor's four clauses, asserted rather than eyeballed. A screenshot proves the notice RENDERS;
   * only this proves it renders on the right cards and says the three things it has to say.
   */
  it("names the gap on exactly the uncovered cards, and stays quiet on the covered one", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 1 });
    await page.goto(`${server.origin}/scripts/webview-preview/index.html${routeAt(WIDE.w, WIDE.h)}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".pgap", { visible: true, timeout: 5000 });

    const perCard = await page.evaluate(() =>
      [...document.querySelectorAll(".ds-card")]
        .map((card) => ({
          name: card.querySelector(".pname")?.textContent ?? "",
          notice: (card.querySelector(".pgap") as HTMLElement | null)?.innerText ?? null,
        }))
        .filter((c) => c.name),
    );

    const withNotice = perCard.filter((c) => c.notice).map((c) => c.name);
    expect(withNotice).toEqual(["dep-audit", "sdd", "secrets-guard"]);
    expect(perCard.find((c) => c.name === "agent-browser")?.notice).toBeNull();

    const sg = perCard.find((c) => c.name === "secrets-guard")?.notice ?? "";
    expect(sg).toContain("grok"); // names the runtime…
    expect(sg).toContain("This workspace runs"); // …and why it matters HERE
    expect(sg).toContain("Reinstall"); // the gesture that closes it (t-8a062b)
    expect(sg).toMatch(/never removes first/); // the cost, stated rather than left to be discovered
    expect(sg).toContain("claude and codex stay installed"); // …naming exactly what stays protected during it
  });

  /**
   * "Up to date" and an uncovered runtime are true at the same time, and the card must say BOTH. This is
   * the measured complaint: the status word was the only thing on the card, and on its own it read as
   * "nothing to do here".
   */
  it("shows the up-to-date badge and the gap notice on the same card", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 1 });
    await page.goto(`${server.origin}/scripts/webview-preview/index.html${routeAt(WIDE.w, WIDE.h)}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".pgap", { visible: true, timeout: 5000 });

    const card = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".ds-card")].find((c) => c.querySelector(".pname")?.textContent === "secrets-guard");
      return { text: (el as HTMLElement).innerText, hasNotice: !!el?.querySelector(".pgap") };
    });
    expect(card.hasNotice).toBe(true);
    expect(card.text).toContain("up to date");
  });
});
