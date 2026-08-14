import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";

/**
 * SDD 479 phase 4 — the preview MOUNTED, in a real DOM.
 *
 * `cardTemplateBlock.test.ts` can only render this block statically (node, no DOM), so it asserts that
 * no second renderer or stylesheet exists. That leaves the two claims a reviewer actually cares about
 * unproven: **does the shadow root really mount real cards**, and **does anything overflow**. Both need
 * layout, so they need a browser — and both are measured here rather than described:
 *
 *   - the block is compiled from source and MOUNTED with preact into a real page;
 *   - the assertions read `shadowRoot` and `getBoundingClientRect`/`scrollWidth` through the live DOM;
 *   - the shots are of the mounted block, not of markup assembled for a screenshot.
 *
 * This is still not VS Code. It is a real browser running the real component and the real stylesheet,
 * which is what makes "the shadow root works" and "nothing overflows" checkable at all; the remaining
 * question — does it look right INSIDE the extension host — is the human dogfood, and the dev-host
 * pointer is armed for it.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/479-card-templates");
const ROOT = path.resolve(__dirname, "../..");
const DIST = EXTENSION_WEBVIEW_DIST;

/** Compile an entry that mounts the real block, with the sidebar stylesheet URI already provided. */
async function bundleMount(sidebarCssHref: string): Promise<string> {
  const entry = `
    import { render } from "preact";
    import { CardTemplateBlock } from ${JSON.stringify(path.join(ROOT, "packages/webview-ui/src/webview/shared/control/CardTemplateBlock.tsx"))};
    window.__tachyonCardPreviewCss = ${JSON.stringify(sidebarCssHref)};
    const s = new Proxy({}, { get: (_t, k) => String(k) });
    render(<CardTemplateBlock s={s} onOpenConfig={() => {}} />, document.getElementById("root"));
  `;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "tsx", sourcefile: "mount.tsx" },
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "silent",
  });
  return built.outputFiles[0].text;
}

describe("SDD 479 phase 4 — the shadow preview, mounted and measured", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 2 });

    // The stylesheet is served as a data: URI — the same file the extension ships, reaching the shadow
    // root exactly as a webview URI would, without needing a server.
    const sidebarCss = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
    const href = `data:text/css;base64,${Buffer.from(sidebarCss, "utf8").toString("base64")}`;
    const script = await bundleMount(href);
    const settingsCss = ["control-typography.css", "engine-workspace.css", "settings.css"]
      .map((file) => readFileSync(path.join(DIST, file), "utf8"))
      .join("\n");
    const designCss = readFileSync(path.join(DIST, "design-system.css"), "utf8");
    const codiconCss = readFileSync(path.join(DIST, "codicon.css"), "utf8");

    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8">
       <style>${codiconCss}</style><style>${designCss}</style><style>${settingsCss}</style>
       <style>
         :root{--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#ccc;
           --vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-panel-border:#2b2b2b;
           --vscode-charts-green:#89d185;--vscode-charts-yellow:#cca700;--vscode-errorForeground:#f14c4c;
           --vscode-list-warningForeground:#cca700;--vscode-widget-border:#3c3c3c;--vscode-focusBorder:#0078d4;
           --vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-textCodeBlock-background:#0000004d;
           --vscode-descriptionForeground:#9d9d9d;--vscode-disabledForeground:#8a8a8a;}
         body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);
           font:var(--vscode-font-size) var(--vscode-font-family);width:900px;}
       </style></head><body><div id="root"></div><script>${script}</script></body></html>`,
      { waitUntil: "load" },
    );
    await page.waitForSelector('[data-testid="card-template-preview"]', { timeout: 10_000 });
    // the stylesheet inside the shadow root must have finished loading before anything is measured
    await page.waitForFunction(
      () => {
        const host = document.querySelector('[data-testid="card-template-preview"]') as HTMLElement | null;
        const link = host?.shadowRoot?.querySelector("link") as HTMLLinkElement | null;
        return !!link?.sheet;
      },
      { timeout: 10_000 },
    );
  }, 120_000);

  afterAll(async () => { await browser?.close(); });

  it("really attaches a shadow root, and real cards render INSIDE it", async () => {
    const facts = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="card-template-preview"]') as HTMLElement;
      const root = host.shadowRoot!;
      const rows = [...root.querySelectorAll(".row")];
      return {
        hasShadow: !!root,
        stylesheetLoaded: !!(root.querySelector("link") as HTMLLinkElement | null)?.sheet,
        rowCount: rows.length,
        // a real card, not an empty div: it has a name, and CSS actually applied to it
        firstName: (rows[0]?.querySelector(".name") as HTMLElement | null)?.textContent ?? "",
        rowDisplay: rows[0] ? getComputedStyle(rows[0]).display : "",
        badgeCount: root.querySelectorAll(".ds-badge").length,
      };
    });
    expect(facts.hasShadow).toBe(true);
    expect(facts.stylesheetLoaded, "the sidebar stylesheet did not load inside the shadow root").toBe(true);
    // five preview rows × two widths
    expect(facts.rowCount).toBe(10);
    expect(facts.firstName).toContain("orchestrator");
    expect(facts.badgeCount).toBeGreaterThan(0);
    // proof the SHEET applied, not merely that it downloaded: sidebar.css sets `.row { display: flex }`
    expect(facts.rowDisplay).toBe("flex");
  });

  it("keeps the sidebar stylesheet OUT of the host page — no bleed into Control", async () => {
    const bled = await page.evaluate(() => {
      // `.ck-settings-block` is Control's own chrome; if sidebar.css had leaked, its `body`/`.row`
      // rules would be in the page's stylesheets. Check the document's own sheets for a sidebar rule.
      const sheets = [...document.styleSheets];
      return sheets.some((sheet) => {
        try {
          return [...sheet.cssRules].some((r) => r.cssText.includes(".sdot") || r.cssText.includes(".row-meta"));
        } catch { return false; }
      });
    });
    expect(bled, "sidebar.css rules reached the host page's stylesheets").toBe(false);
  });

  it("overflows nothing: every preview pane and every card fits its width", async () => {
    const overflow = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="card-template-preview"]') as HTMLElement;
      const root = host.shadowRoot!;
      const panes = [...root.querySelectorAll("div[style*='width']")].filter((el) =>
        /width:\s*(320|220)px/.test((el as HTMLElement).getAttribute("style") ?? ""),
      ) as HTMLElement[];
      const paneOverflow = panes.map((p) => ({ w: p.clientWidth, scroll: p.scrollWidth, over: p.scrollWidth - p.clientWidth }));
      const doc = document.documentElement;
      return {
        panes: paneOverflow,
        pageOverflowX: doc.scrollWidth - doc.clientWidth,
        paneCount: panes.length,
      };
    });
    expect(overflow.paneCount).toBe(2);
    // The page itself must never scroll sideways — the spec's narrow-sidebar criterion.
    expect(overflow.pageOverflowX, "the Settings page scrolls horizontally").toBeLessThanOrEqual(0);
    for (const pane of overflow.panes) {
      // Each pane clips its own content (overflow:hidden) rather than pushing the layout wider.
      expect(pane.scroll - pane.w, `a ${pane.w}px preview pane overflowed by ${pane.over}px`).toBeLessThanOrEqual(0);
    }
  });

  it("captures the mounted block as durable evidence", async () => {
    const file = path.join(OUT_DIR, "settings-block-mounted.png");
    await page.screenshot({ path: file as `${string}.png`, fullPage: true });
    expect(statSync(file).size).toBeGreaterThan(1000);

    const previewOnly = path.join(OUT_DIR, "settings-block-shadow-preview.png");
    const host = await page.$('[data-testid="card-template-preview"]');
    await host!.screenshot({ path: previewOnly as `${string}.png` });
    expect(statSync(previewOnly).size).toBeGreaterThan(1000);
  }, 60_000);
});
