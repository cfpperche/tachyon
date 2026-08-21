import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * t-83bcf4 visual anchor, written before implementation: at rest each agent row keeps an always-visible
 * ellipsis in a corridor only as wide as that resting control. On pointer hover and keyboard focus the
 * primary controls reveal smoothly from right to left. Reduced motion reveals them with no lateral
 * transition. The three states must remain legible at 880px and 360px.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-83bcf4");
const DIST = EXTENSION_WEBVIEW_DIST;
const WIDTHS = [880, 360] as const;
const STYLESHEETS = ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "sidebar.css"];

function rewriteLocalUrls(css: string, fromFile: string): string {
  const dir = path.dirname(fromFile);
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, _q, spec: string) => {
    if (/^(data:|https?:|file:)/i.test(spec)) return match;
    const abs = path.resolve(dir, spec.split(/[?#]/, 1)[0]);
    if (!existsSync(abs)) return match;
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === ".woff2" ? "font/woff2" : ext === ".woff" ? "font/woff" : ext === ".ttf" ? "font/ttf" : "application/octet-stream";
    return `url("data:${mime};base64,${readFileSync(abs).toString("base64")}")`;
  });
}

function pageHtml(body: string, width: number): string {
  const css = STYLESHEETS.map((name) => {
    const file = path.join(DIST, name);
    return `<style>${rewriteLocalUrls(readFileSync(file, "utf8"), file)}</style>`;
  }).join("\n");
  return `<!doctype html><html><head>${css}<style>
    :root { --vscode-sideBar-background:#181818; --vscode-editor-background:#1f1f1f;
      --vscode-foreground:#cccccc; --vscode-font-family:system-ui,sans-serif; --vscode-font-size:13px;
      --vscode-descriptionForeground:#9d9d9d; --vscode-disabledForeground:#8a8a8a;
      --vscode-list-hoverBackground:#2a2d2e; --vscode-list-inactiveSelectionBackground:#37373d;
      --vscode-panel-border:#2b2b2b; --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#fff;
      --vscode-textCodeBlock-background:#0000004d; --vscode-charts-green:#89d185;
      --vscode-charts-yellow:#cca700; --vscode-charts-red:#f14c4c; --vscode-charts-blue:#3794ff;
      --vscode-charts-purple:#b180d7; --vscode-errorForeground:#f14c4c; --vscode-focusBorder:#0078d4; }
    body { margin:0; width:${width}px; background:#181818; color:#ccc; }
    #shot { width:${width}px; padding:8px 0; }
    .state-label { padding:5px 12px 2px; color:#9d9d9d; font:11px system-ui; text-transform:uppercase; }
  </style></head><body><div id="shot">${body}</div></body></html>`;
}

describe("t-83bcf4 — agent action reveal", () => {
  let browser: Browser;
  let page: Page;
  let AgentRow: (props: unknown) => unknown;
  const artifacts: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    AgentRow = (await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"))).AgentRow as typeof AgentRow;
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    writeFileSync(path.join(OUT_DIR, "README.md"), `# t-83bcf4 — agent action reveal\n\n${artifacts.map((f) => `- \`${f}\``).join("\n")}\n`);
  });

  const agent = (name: string): AgentVM => ({
    name, model: "GPT-5.1 Codex", status: "running", kind: "agent", attention: "working",
    focus: { source: "task", taskId: "t-83bcf4", taskStatus: "active", text: "toolbar reveal without covering this line", full: "toolbar reveal without covering this line" },
    checklist: { kind: "step", position: 2, total: 4, text: "verify the resting content corridor remains readable" },
  });

  function rows(): string {
    return ["Rest", "Hover", "Keyboard focus"].map((label) =>
      `<div class="state-label">${label}</div>${renderStatic(AgentRow({ a: agent(label.toLowerCase().replace(/ /g, "-")), flash: false }))}`,
    ).join("");
  }

  it("shows rest, hover, focus, and reduced-motion states at both widths", async () => {
    for (const width of WIDTHS) {
      await page.setViewport({ width: width + 40, height: 720, deviceScaleFactor: 2 });
      await page.setContent(pageHtml(rows(), width), { waitUntil: "load" });
      const shot = await page.$("#shot");

      await page.mouse.move(width + 30, 700);
      await page.addStyleTag({ content: ".row{--action-gutter:80px!important}.row>.actions{opacity:0!important;pointer-events:none!important}" });
      await new Promise((resolve) => setTimeout(resolve, 140));
      const before = `rest-before-${width}.png`;
      await shot!.screenshot({ path: path.join(OUT_DIR, before) as `${string}.png` });
      artifacts.push(before);
      await page.reload({ waitUntil: "load" });
      await page.setContent(pageHtml(rows(), width), { waitUntil: "load" });
      const currentShot = await page.$("#shot");

      const rowsEls = await page.$$(".row");
      await rowsEls[1].hover();
      await rowsEls[2].$eval(".action-reveal .act", (el) => (el as HTMLElement).focus());
      await new Promise((resolve) => setTimeout(resolve, 220));

      const state = await page.evaluate(() => [...document.querySelectorAll(".row")].map((row) => {
        const reveal = row.querySelector(".action-reveal") as HTMLElement;
        const more = row.querySelector('[aria-label="More actions"]') as HTMLElement;
        const toolbar = row.querySelector(":scope > .actions") as HTMLElement;
        const style = getComputedStyle(reveal);
        return {
          focusWithin: row.matches(":focus-within"), revealOpacity: style.opacity,
          revealWidth: reveal.getBoundingClientRect().width, transitionDuration: style.transitionDuration,
          moreVisible: more.getBoundingClientRect().width > 0 && getComputedStyle(toolbar).opacity === "1",
          gutter: getComputedStyle(row).getPropertyValue("--action-gutter").trim(),
        };
      }));
      expect(state[0]).toMatchObject({ revealOpacity: "0", revealWidth: 0, moreVisible: true, gutter: "38px" });
      expect(state[1].revealOpacity).toBe("1");
      expect(state[1].revealWidth).toBeGreaterThan(40);
      expect(state[2].focusWithin).toBe(true);
      expect(state[2].revealOpacity).toBe("1");

      const states = `states-${width}.png`;
      await currentShot!.screenshot({ path: path.join(OUT_DIR, states) as `${string}.png` });
      expect(statSync(path.join(OUT_DIR, states)).size).toBeGreaterThan(1000);
      artifacts.push(states);

      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      const reducedDuration = await rowsEls[2].$eval(".action-reveal", (el) => getComputedStyle(el).transitionDuration);
      expect(reducedDuration).toBe("0s");
      await page.emulateMediaFeatures([]);
    }
  }, 60_000);
});
