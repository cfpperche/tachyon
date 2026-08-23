import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * 515 — visual evidence that the plugin install chooser is OURS.
 *
 * ANCHOR (the owner's rule, stated after 0.93.55 shipped with the editor's dialog in this door):
 *
 *   Choosing a plugin archive happens INSIDE the Plugins panel, in the same chooser the app installer
 *   uses. Not `vscode.window.showOpenDialog` — which under a remote/WSL window degrades to a lone
 *   "Folder path" text field floating over the editor, with no idea what a plugin package is and no
 *   memory of where the archives are.
 *
 * Two screens, because the picker has two and they are the whole design: it OPENS on the archives
 * already lying around (the "recent files" idea — the file someone wants is usually one they just built
 * or downloaded), and it BROWSES from there when the scan did not find what they meant. The first
 * version of the app picker shipped with only the flat list and could not do the one thing a file
 * picker exists for, which is why the second screen is worth a shot of its own.
 *
 * Measured at 880 and 360 — the same two widths every other Plugins shot uses.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/515-plugin-zip-picker");

const WIDE = { w: 880, h: 900 };
const NARROW = { w: 360, h: 900 };

/** What the host would post: the nearby scan, and one directory browsed into. */
const SUGGESTIONS = {
  type: "zips",
  candidates: [
    { path: "/home/goat/Downloads/sdd-1.9.0.zip", name: "sdd-1.9.0.zip", dir: "/home/goat/Downloads" },
    { path: "/home/goat/tachyon/dist/agent-browser-3.2.0.zip", name: "agent-browser-3.2.0.zip", dir: "/home/goat/tachyon/dist" },
    { path: "/tmp/tachyon-build/demo.zip", name: "demo.zip", dir: "/tmp/tachyon-build" },
  ],
  roots: ["/home/goat/tachyon", "/home/goat/Downloads", "/home/goat/Desktop", "/tmp"],
};

const BROWSED = {
  type: "zips",
  candidates: [],
  roots: [],
  listing: {
    dir: "/home/goat/Downloads",
    parent: "/home/goat",
    entries: [
      { name: "archive", path: "/home/goat/Downloads/archive", kind: "dir" },
      { name: "plugins", path: "/home/goat/Downloads/plugins", kind: "dir" },
      { name: "agent-browser-3.2.0.zip", path: "/home/goat/Downloads/agent-browser-3.2.0.zip", kind: "zip" },
      { name: "sdd-1.9.0.zip", path: "/home/goat/Downloads/sdd-1.9.0.zip", kind: "zip" },
    ],
  },
};

const SCREENS = [
  { id: "suggestions", message: SUGGESTIONS, waitText: "sdd-1.9.0.zip" },
  { id: "browsing", message: BROWSED, waitText: "Downloads" },
] as const;

describe("515 — the plugin install chooser is the product's own", () => {
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
        `# Plugin install chooser (spec 515)\n\n` +
          `Rendered by \`test/browser/pluginZipPickerShots.test.ts\` from the real webview bundle.\n\n` +
          `## Anchor\n\n` +
          `Choosing a plugin archive happens inside the Plugins panel, in the same \`PathPicker\` the app ` +
          `installer uses — never \`vscode.window.showOpenDialog\`. It opens on the archives already lying ` +
          `around and browses from there.\n\n` +
          `Regenerate:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/pluginZipPickerShots.test.ts\n\`\`\`\n\n` +
          `${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function shoot(name: string, message: unknown, waitText: string, { w, h }: { w: number; h: number }): Promise<void> {
    await page.setViewport({ width: w + 40, height: h + 40, deviceScaleFactor: 2 });
    const surface = await openPreview(page, server.origin, { query: { view: "plugins", fixture: "default" }, width: w, height: h });
    await surface.waitForFunction(() => document.querySelectorAll(".ds-card").length > 0, { timeout: 8000 });
    // The picker is opened by a host message, exactly as it is in the product: the webview owns no
    // filesystem and invents no candidates of its own.
    await surface.evaluate((m: unknown) => { window.postMessage(m, "*"); }, message);
    await surface.waitForSelector('[data-testid="plugin-zip-picker"]', { timeout: 8000 });
    await surface.waitForFunction(
      (text: string) => document.querySelector('[data-testid="plugin-zip-picker"]')?.textContent?.includes(text) ?? false,
      { timeout: 8000 },
      waitText,
    );

    const measured = await surface.evaluate(() => {
      const panel = document.querySelector('[data-testid="plugin-zip-picker"] .pp-panel') as HTMLElement | null;
      const box = panel?.getBoundingClientRect();
      return {
        mounted: !!panel,
        width: box ? Math.round(box.width) : 0,
        right: box ? Math.round(box.right) : 0,
        bottom: box ? Math.round(box.bottom) : 0,
        // A picker whose own rows overflow it is the failure the flat first version had — but an
        // element that ELLIPSIZES always measures wider than its box, and that is truncation working
        // rather than a layout breaking. So the check exempts exactly those and no others.
        crumbs: (document.querySelector('[data-testid="path-picker-crumbs"]') as HTMLElement | null)?.innerText ?? "",
        over: [...document.querySelectorAll('[data-testid="plugin-zip-picker"] *')]
          .filter((e) => e.scrollWidth > e.clientWidth + 1)
          .filter((e) => getComputedStyle(e).textOverflow !== "ellipsis")
          .map((e) => `${(e.className || e.tagName).toString().slice(0, 60)} (${e.scrollWidth} > ${e.clientWidth})`),
      };
    });
    expect(measured.mounted, `${name}: the picker did not mount`).toBe(true);
    expect(measured.right, `${name}: the picker runs past the ${w}px frame`).toBeLessThanOrEqual(w);
    expect(measured.bottom, `${name}: the picker is cut off by the ${h}px frame`).toBeLessThanOrEqual(h);
    expect(measured.over, `${name}: the picker's own content overflows it`).toEqual([]);
    // 515 — the root crumb IS a slash; a separator after it printed `/ / home / goat`.
    expect(measured.crumbs, `${name}: the breadcrumb doubled the root separator`).not.toMatch(/^\s*\/\s*\//);

    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  for (const screen of SCREENS) {
    it(`shoots the ${screen.id} screen at 880`, async () => {
      await shoot(`${screen.id}-880`, screen.message, screen.waitText, WIDE);
    });
    it(`shoots the ${screen.id} screen at 360`, async () => {
      await shoot(`${screen.id}-360`, screen.message, screen.waitText, NARROW);
    });
  }
});
