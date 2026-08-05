import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * t-4e5f11 — visual evidence for the Plugins card freshness states after the version+payload oracle.
 *
 * ANCHOR (from the owner's decision, not from the finished screen):
 *
 *   A human looking at an installed plugin card can tell, WITHOUT clicking, whether (a) the source is
 *   truly current, (b) a labeled newer version exists, or (c) the source content changed under the SAME
 *   version label — and in case (c) the primary button says "Reapply", not "Update", so it does not
 *   contradict the badge "source changed · still vX". "Update available · v{same}" without a qualifier
 *   is refused. Downgrade remains a consent-only force path (card still maps isDowngrade → up-to-date;
 *   pre-existing, not introduced here) — captured as the steady up-to-date card, not a fourth badge.
 *
 * Measured at 880 and 360. Drives the real webview bundle through the preview harness.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-4e5f11-plugin-freshness");

const WIDE = { w: 880, h: 1400 };
const NARROW = { w: 360, h: 2200 };

const FIXTURES = [
  { id: "up-to-date", fixture: "default", waitText: "up to date" },
  { id: "update-available", fixture: "update-available", waitText: "update available" },
  { id: "source-changed", fixture: "source-changed", waitText: "source changed" },
] as const;

describe("Plugins card — freshness states (t-4e5f11)", () => {
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
        `# Plugins freshness states (t-4e5f11)\n\n` +
          `Rendered by \`test/browser/pluginSourceChangedShots.test.ts\` from the real webview bundle.\n\n` +
          `## Anchor\n\n` +
          `Badge text true about the version AND the world. Same-version content drift uses ` +
          `"source changed · still vX" + Reapply — never bare "update available · v{same}" and never ` +
          `"up to date" when bytes differ.\n\n` +
          `## Downgrade note\n\n` +
          `Pre-existing: \`deriveUpdateCheck\` maps \`isDowngrade\` → card \`up-to-date\` (force lives in the ` +
          `consent drawer). This task did not invent a fourth card badge for it; the up-to-date shot is the ` +
          `card face of that path.\n\n` +
          `Regenerate:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/pluginSourceChangedShots.test.ts\n\`\`\`\n\n` +
          `${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function shoot(name: string, fixture: string, waitText: string, { w, h }: { w: number; h: number }): Promise<void> {
    await page.setViewport({ width: w + 40, height: Math.min(h + 40, 4000), deviceScaleFactor: 2 });
    // t-b24282 — one number sizes the surface's own viewport; its DOM lives in the returned frame.
    const surface = await openPreview(page, server.origin, { query: { view: "plugins", fixture }, width: w, height: h });
    await surface.waitForFunction(
      (text: string) => document.body.innerText.toLowerCase().includes(text.toLowerCase()),
      { timeout: 8000 },
      waitText,
    );

    const measured = await surface.evaluate(() => {
      const over = [...document.querySelectorAll("*")]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => `${(e.className || e.tagName).toString().slice(0, 60)} (${e.scrollWidth} > ${e.clientWidth})`);
      const cards = [...document.querySelectorAll(".ds-card")].map((c) => ({
        name: c.querySelector(".pname")?.textContent ?? "",
        width: Math.round(c.getBoundingClientRect().width),
        bottom: Math.round(c.getBoundingClientRect().bottom),
        text: (c as HTMLElement).innerText,
      }));
      return { over, cards, previewView: document.body.dataset.previewView, previewFixture: document.body.dataset.previewFixture };
    });
    expect(measured.previewView, `${name}: wrong preview view`).toBe("plugins");
    expect(measured.previewFixture, `${name}: wrong fixture`).toBe(fixture);
    expect(measured.over, `${name}: content overflows the ${w}px frame`).toEqual([]);
    expect(measured.cards.every((c) => c.width < w), `${name}: cards did not reflow to ${w}px`).toBe(true);
    if (measured.cards.length > 0) {
      expect(measured.cards.at(-1)!.bottom, `${name}: last card is cut off by the frame`).toBeLessThanOrEqual(h);
    }

    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  for (const f of FIXTURES) {
    it(`shoots ${f.id} at 880`, async () => {
      await shoot(`${f.id}-880`, f.fixture, f.waitText, WIDE);
    });
    it(`shoots ${f.id} at 360`, async () => {
      await shoot(`${f.id}-360`, f.fixture, f.waitText, NARROW);
    });
  }

  it("source-changed card says still vX and offers Reapply, not Update", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 1 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "plugins", fixture: "source-changed" },
      width: WIDE.w,
      height: WIDE.h,
    });
    await surface.waitForFunction(() => document.body.innerText.includes("source changed"), { timeout: 8000 });

    const card = await surface.evaluate(() => {
      const el = [...document.querySelectorAll(".ds-card")].find((c) => c.querySelector(".pname")?.textContent === "secrets-guard");
      const text = (el as HTMLElement | undefined)?.innerText ?? "";
      const buttons = [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
      return { text, buttons };
    });
    expect(card.text).toMatch(/source changed/i);
    expect(card.text).toMatch(/still v2\.0\.1/i);
    expect(card.text).not.toMatch(/update available/i);
    expect(card.buttons).toContain("Reapply");
    expect(card.buttons).not.toContain("Update");
  });

  it("update-available card still offers Update with a newer version label", async () => {
    await page.setViewport({ width: WIDE.w + 40, height: WIDE.h + 40, deviceScaleFactor: 1 });
    const surface = await openPreview(page, server.origin, {
      query: { view: "plugins", fixture: "update-available" },
      width: WIDE.w,
      height: WIDE.h,
    });
    await surface.waitForFunction(() => document.body.innerText.includes("update available"), { timeout: 8000 });

    const card = await surface.evaluate(() => {
      const el = [...document.querySelectorAll(".ds-card")].find((c) => c.querySelector(".pname")?.textContent === "visual-qa");
      const text = (el as HTMLElement | undefined)?.innerText ?? "";
      const buttons = [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");
      return { text, buttons };
    });
    expect(card.text).toMatch(/update available/i);
    expect(card.text).toMatch(/v0\.2\.0/);
    expect(card.buttons).toContain("Update");
  });
});
