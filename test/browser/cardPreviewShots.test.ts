import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { CARD_PREVIEW_ROWS } from "@tachyon/webview-ui/sidebar/cardPreviewRows";
import { CARD_TEMPLATE_VERSION, DEFAULT_CARD_TEMPLATE, type CardTemplate } from "@tachyon/shared/sidebar/cardTemplate.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * SDD 479 phase 4 — the DURABLE visual evidence.
 *
 * The rest of this spec's suite proves the card's structure in text. That is the right check for a
 * refactor, and the wrong one for "does a configured card still read as a card": a person reviewing
 * this feature needs to SEE it. So this file renders the real `AgentRow` with the real, shipped
 * `dist/webview/sidebar.css` in a real browser and writes PNGs a human can look at and attach to a
 * validation.
 *
 * It lives in `test/browser/` on purpose: that project is NOT part of `verify:full` (it needs a system
 * Chrome and a built `dist/`), so the gate stays fast while the artifacts stay reproducible by one
 * command:
 *
 *     npm run build && npx vitest run --config vitest.browser.config.ts test/browser/cardPreviewShots.test.ts
 *
 * Each scenario is shot at the sidebar's real width and at its narrowest, because a template's damage
 * usually shows up first when the card is squeezed.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/479-card-templates");
const DIST = EXTENSION_WEBVIEW_DIST;
const WIDTHS = [
  { id: "320", px: 320 },
  { id: "narrow-220", px: 220 },
];

const HIDE_ALL: CardTemplate = { version: CARD_TEMPLATE_VERSION, header: ["status-dot", "name"], meta: [], footer: ["actions"] };
const CURATED: CardTemplate = {
  version: CARD_TEMPLATE_VERSION,
  header: ["status-dot", "name", "model", "metrics-pill"],
  meta: ["harness", "branch", "evidence"],
  footer: ["focus", "actions"],
};

/** A page that loads the SHIPPED stylesheets, so the shot is the card as it renders in the sidebar. */
function pageHtml(bodyHtml: string, width: number): string {
  const css = ["codicon.css", "design-system.css", "sidebar.css"]
    .map((f) => `<style>${readFileSync(path.join(DIST, f), "utf8")}</style>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">${css}
<style>
  /* VS Code supplies these at runtime; pin a dark-theme approximation so the shot is deterministic. */
  :root {
    --vscode-sideBar-background:#181818; --vscode-editor-background:#1f1f1f; --vscode-foreground:#cccccc;
    --vscode-font-family:system-ui,sans-serif; --vscode-font-size:13px;
    --vscode-descriptionForeground:#9d9d9d; --vscode-disabledForeground:#8a8a8a;
    --vscode-list-hoverBackground:#2a2d2e; --vscode-list-inactiveSelectionBackground:#37373d;
    --vscode-panel-border:#2b2b2b; --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#fff;
    --vscode-textCodeBlock-background:#0000004d; --vscode-button-background:#0078d4; --vscode-button-foreground:#fff;
    /* The status dot and every badge tone resolve through these; without them --ds-ok/--ds-warn/--ds-err
       fall through to nothing and a running agent's dot renders INVISIBLE — a shot that under-reports
       what the card shows. Pinned to VS Code's dark-theme chart colors. */
    --vscode-charts-green:#89d185; --vscode-charts-yellow:#cca700; --vscode-charts-red:#f14c4c;
    --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7;
    --vscode-errorForeground:#f14c4c; --vscode-list-warningForeground:#cca700;
    --vscode-testing-iconPassed:#89d185; --vscode-terminal-ansiGreen:#89d185;
    --vscode-terminal-ansiYellow:#cca700; --vscode-terminal-ansiRed:#f14c4c;
    --vscode-widget-border:#3c3c3c; --vscode-editorWidget-border:#3c3c3c; --vscode-focusBorder:#0078d4;
  }
  body { margin:0; width:${width}px; }
  #shot { width:${width}px; }
</style></head><body><div id="shot">${bodyHtml}</div></body></html>`;
}

describe("SDD 479 phase 4 — durable card previews", () => {
  let browser: Browser;
  let page: Page;
  let AgentRow: (props: unknown) => unknown;
  let CardTemplateRefusalBanner: (props: unknown) => unknown;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"));
    AgentRow = mod.AgentRow as typeof AgentRow;
    CardTemplateRefusalBanner = mod.CardTemplateRefusalBanner as typeof CardTemplateRefusalBanner;
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    // A manifest beside the PNGs: what each shot is, so a reviewer does not have to guess.
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# SDD 479 — agent card previews\n\nRendered by \`test/browser/cardPreviewShots.test.ts\` from the real \`AgentRow\`\nand the shipped \`dist/webview/sidebar.css\`. Regenerate with:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/cardPreviewShots.test.ts\n\`\`\`\n\n${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function shoot(name: string, bodyHtml: string, width: number): Promise<void> {
    await page.setViewport({ width: width + 40, height: 900, deviceScaleFactor: 2 });
    await page.setContent(pageHtml(bodyHtml, width), { waitUntil: "load" });
    const target = await page.$("#shot");
    const file = path.join(OUT_DIR, `${name}.png`);
    await target!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size, `${name}.png is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  const rowsWith = (template: CardTemplate | undefined, rows = CARD_PREVIEW_ROWS): string =>
    rows.map((f) => renderStatic(AgentRow({ a: f.row, flash: false, ...(template ? { cardTemplate: { base: template } } : {}) }))).join("");

  it("shoots the DEFAULT card — the layout every workspace gets with no configuration", async () => {
    for (const w of WIDTHS) await shoot(`default-${w.id}`, rowsWith(undefined), w.px);
    expect(DEFAULT_CARD_TEMPLATE.meta.length).toBeGreaterThan(0);
  }, 60_000);

  it("shoots a CONFIGURED card — badges reordered and several hidden", async () => {
    for (const w of WIDTHS) await shoot(`configured-${w.id}`, rowsWith(CURATED), w.px);
  }, 60_000);

  it("shoots RE-ADMISSION — a template hiding every badge, on rows that cannot recover", async () => {
    // The ratified escape hatch, seen rather than asserted: `meta: []`, yet the auth-required row still
    // carries its badge because the product puts it back for that row.
    const rows = CARD_PREVIEW_ROWS.filter((f) => ["error", "attention", "healthy"].includes(f.id));
    for (const w of WIDTHS) await shoot(`auth-required-readmitted-${w.id}`, rowsWith(HIDE_ALL, rows), w.px);
  }, 60_000);

  it("shoots the REFUSAL banner — a written template that could not be honored", async () => {
    const banner = renderStatic(
      CardTemplateRefusalBanner({
        refusal: {
          file: "tachyon.yml",
          errors: [
            "settings.sidebar.cardTemplate.meta[1]: unknown component 'cpu-graph' — the catalog is status-dot, name, model, …",
            "settings.sidebar.cardTemplate.version: unknown template version 7 (this Tachyon understands version 1)",
          ],
        },
      }),
    );
    // The banner sits above the cards it explains, so the shot shows the fallback AND its reason.
    for (const w of WIDTHS) await shoot(`refusal-${w.id}`, banner + rowsWith(undefined, CARD_PREVIEW_ROWS.slice(0, 2)), w.px);
  }, 60_000);

  it("shoots a terminal row beside an agent one — the V1 boundary, visibly", async () => {
    const terminal: AgentVM = { name: "dev", kind: "terminal", status: "running", sub: "npm run dev", harness: true };
    const agent = CARD_PREVIEW_ROWS[0]!.row;
    const html = [terminal, agent]
      .map((row) => renderStatic(AgentRow({ a: row, flash: false, cardTemplate: { base: HIDE_ALL } })))
      .join("");
    for (const w of WIDTHS) await shoot(`terminal-unaffected-${w.id}`, html, w.px);
  }, 60_000);
});
