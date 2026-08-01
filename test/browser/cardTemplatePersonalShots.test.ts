import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { CockpitStrings } from "../../src/webview/cockpit/messages";

/**
 * SDD 479 phase 5 — the two surfaces this phase adds, seen rather than asserted.
 *
 * Both are SENTENCES a human has to be able to read and act on, which no structural test can judge:
 * the statement of which home is in effect, and the banner that appears when a personal override was
 * refused. The unit suite proves they carry the right words; these shots prove they are legible, and
 * assert mechanically that neither turns a narrow panel into a horizontally-scrolling page.
 *
 * Not part of `verify:full` (needs a system Chrome and a built `dist/`). Regenerate with:
 *
 *     npm run build && npx vitest run --config vitest.browser.config.ts test/browser/cardTemplatePersonalShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/479-personal-card-template");
const DIST = path.resolve(__dirname, "../../dist/webview");
const WIDTHS = [
  { id: "880", px: 880 },
  { id: "narrow-360", px: 360 },
];

const STRINGS = {
  cardTemplateInEffect: "In effect right now:",
  cardTemplatePersonalActive: "your personal override in VS Code settings — it wins over every project template below",
  cardTemplatePersonalRefused: "your personal override was REFUSED and ignored; the cards fall back to each project's template",
  cardTemplatePersonalNone: "no personal override — each project's own template decides",
  cardTemplateProjectNone: "uses Tachyon's default card",
  cardTemplateProjectConfigured: "has its own template in tachyon.yml",
  cardTemplateProjectRefused: "its tachyon.yml template was refused; showing the default card",
} as unknown as CockpitStrings;

/** The codicon @font-face points at a relative url that resolves to nothing under `setContent`. */
function inlineCodiconFont(css: string): string {
  const font = readFileSync(path.join(DIST, "codicon.ttf")).toString("base64");
  return css.replace(/url\(["']?\.\/codicon\.ttf[^)]*["']?\)/, `url(data:font/ttf;base64,${font})`);
}

function pageHtml(bodyHtml: string, width: number, sheets: string[]): string {
  const css = sheets
    .map((f) => {
      const raw = readFileSync(path.join(DIST, f), "utf8");
      return `<style>${f === "codicon.css" ? inlineCodiconFont(raw) : raw}</style>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">${css}
<style>
  :root {
    --vscode-sideBar-background:#181818; --vscode-editor-background:#1f1f1f; --vscode-foreground:#cccccc;
    --vscode-font-family:system-ui,sans-serif; --vscode-font-size:13px;
    --vscode-descriptionForeground:#9d9d9d; --vscode-disabledForeground:#8a8a8a;
    --vscode-list-hoverBackground:#2a2d2e; --vscode-panel-border:#2b2b2b;
    --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#fff;
    --vscode-input-background:#313131; --vscode-textCodeBlock-background:#0000004d;
    --vscode-button-background:#0078d4; --vscode-button-foreground:#fff;
    --vscode-charts-green:#89d185; --vscode-charts-yellow:#cca700; --vscode-charts-red:#f14c4c;
    --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7;
    --vscode-errorForeground:#f14c4c; --vscode-list-warningForeground:#cca700;
    --vscode-widget-border:#3c3c3c; --vscode-editorWidget-border:#3c3c3c; --vscode-focusBorder:#0078d4;
  }
  html, body { margin:0; }
  body { width:${width}px; background: var(--vscode-editor-background); padding: 8px; box-sizing: border-box; }
  #shot { width:100%; }
</style></head><body><div id="shot">${bodyHtml}</div></body></html>`;
}

describe("SDD 479 phase 5 — the personal override's two surfaces", () => {
  let browser: Browser;
  let page: Page;
  let CardTemplateInEffect: (props: unknown) => unknown;
  let CardTemplateRefusalBanner: (props: unknown) => unknown;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const block = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/cockpit/CardTemplateBlock.tsx"));
    CardTemplateInEffect = block.CardTemplateInEffect as typeof CardTemplateInEffect;
    const sidebar = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/sidebar/App.tsx"));
    CardTemplateRefusalBanner = sidebar.CardTemplateRefusalBanner as typeof CardTemplateRefusalBanner;
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# SDD 479 phase 5 — the personal card-template override\n\nRendered by \`test/browser/cardTemplatePersonalShots.test.ts\` from the real components and\nthe shipped stylesheets. Every shot is also asserted not to scroll horizontally at its width.\nRegenerate with:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/cardTemplatePersonalShots.test.ts\n\`\`\`\n\n${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function shoot(name: string, bodyHtml: string, width: number, sheets: string[]): Promise<void> {
    await page.setViewport({ width, height: 700, deviceScaleFactor: 2 });
    await page.setContent(pageHtml(bodyHtml, width, sheets), { waitUntil: "load" });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${name} scrolls horizontally at ${width}px`).toBeLessThanOrEqual(overflow.clientWidth);
    const target = await page.$("#shot");
    const file = path.join(OUT_DIR, `${name}.png`);
    await target!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(500);
    written.push(path.basename(file));
  }

  const CONTROL_SHEETS = ["codicon.css", "design-system.css", "vscode-theme.css", "cockpit.css"];
  const SIDEBAR_SHEETS = ["codicon.css", "design-system.css", "sidebar.css"];

  it("shoots the statement when a personal override is winning", async () => {
    const html = renderStatic(
      CardTemplateInEffect({
        s: STRINGS,
        state: {
          personal: "active",
          projects: [
            { folder: "tachyon", configured: true, refused: false },
            { folder: "docs-site", configured: false, refused: false },
          ],
        },
      }),
    );
    for (const w of WIDTHS) await shoot(`in-effect-personal-${w.id}`, html, w.px, CONTROL_SHEETS);
  }, 60_000);

  it("shoots the statement when the personal override was refused", async () => {
    // The case the whole sentence exists for: without it, this is indistinguishable from a project
    // template that simply did not apply.
    const html = renderStatic(
      CardTemplateInEffect({
        s: STRINGS,
        state: {
          personal: "refused",
          personalErrors: [
            "sidebar.cardTemplate.meta[0]: unknown component 'cpu-graph' — the catalog is status-dot, name, model, …",
          ],
          projects: [{ folder: "tachyon", configured: true, refused: false }],
        },
      }),
    );
    for (const w of WIDTHS) await shoot(`in-effect-refused-${w.id}`, html, w.px, CONTROL_SHEETS);
  }, 60_000);

  it("shoots the statement when nothing personal is set", async () => {
    const html = renderStatic(
      CardTemplateInEffect({
        s: STRINGS,
        state: {
          personal: "none",
          projects: [
            { folder: "tachyon", configured: true, refused: false },
            { folder: "legacy", configured: false, refused: true },
          ],
        },
      }),
    );
    for (const w of WIDTHS) await shoot(`in-effect-none-${w.id}`, html, w.px, CONTROL_SHEETS);
  }, 60_000);

  it("shoots the sidebar banner a refused PERSONAL override raises", async () => {
    // Distinct wording from the project banner: this one falls back to the project's card, which may
    // itself be a written template — saying "the default" there would name a layout nobody is seeing.
    const html = renderStatic(
      CardTemplateRefusalBanner({
        refusal: {
          // t-aaad95 — the personal home is a FILE now, and the banner shows its path. A screenshot
          // built from the retired settings-key wording would keep passing while showing a home that
          // no longer exists, which is the one thing a shot test is supposed to prevent.
          file: "/home/you/.tachyon/settings.json · sidebar.cardTemplate",
          errors: [
            "sidebar.cardTemplate.meta[0]: unknown component 'cpu-graph' — the catalog is status-dot, name, model, …",
            "sidebar.cardTemplate.version: unknown template version 7 (this Tachyon understands version 1)",
          ],
        },
        personal: true,
      }),
    );
    for (const w of [{ id: "340", px: 340 }, { id: "narrow-220", px: 220 }]) {
      await shoot(`sidebar-personal-refusal-${w.id}`, html, w.px, SIDEBAR_SHEETS);
    }
  }, 60_000);
});
