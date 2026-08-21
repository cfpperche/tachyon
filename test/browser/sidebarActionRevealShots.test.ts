import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * t-91884b visual anchor, written before the screenshots: at rest the agent card shows no overflow
 * trigger (the 38px corridor stays empty). Hovering the card (the name, not the trigger) paints the
 * `...` only. Hovering the `...` itself opens the ruler. An open menu keeps the `...` visible after
 * the pointer leaves the card. Keyboard: focus-within on the row shows `...`; focus-within on
 * `.actions` opens the ruler. Reduced motion still drops the lateral transition.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-91884b");
const EVIDENCE_DIR = path.resolve(__dirname, "../../docs/research/evidence-t-91884b");
const DIST = EXTENSION_WEBVIEW_DIST;
const REPO = path.resolve(__dirname, "../..");
const WIDTHS = [880, 360] as const;
const THEMES = ["dark", "light"] as const;
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

function pageHtml(body: string, width: number, theme: "dark" | "light"): string {
  const css = STYLESHEETS.map((name) => {
    const file = path.join(DIST, name);
    return `<style>${rewriteLocalUrls(readFileSync(file, "utf8"), file)}</style>`;
  }).join("\n");
  const themeFile = path.join(REPO, "scripts/webview-preview", `theme-${theme}.css`);
  const themeCss = readFileSync(themeFile, "utf8");
  return `<!doctype html><html data-theme="${theme}"><head>${css}<style>${themeCss}</style><style>
    html, body { margin:0; width:${width}px; background:var(--vscode-sideBar-background); color:var(--vscode-foreground);
      font:13px var(--vscode-font-family, system-ui); }
    #shot { width:${width}px; padding:8px 0 24px; min-height: 160px; }
  </style></head><body><div id="shot">${body}</div></body></html>`;
}

const MENU_HTML = `<div class="menu-backdrop"><div class="more-menu" role="menu" aria-label="Actions" style="left:168px;top:44px">
  <button class="more-item" type="button" role="menuitem"><span>Stop graceful</span></button>
  <button class="more-item" type="button" role="menuitem"><span>Edit in Studio</span></button>
  <button class="more-item" type="button" role="menuitem"><span>Remove</span></button>
</div></div>`;

type RowState = {
  toolbarOpacity: string;
  moreVisible: boolean;
  revealOpacity: string;
  revealWidth: number;
  gutter: string;
  focusWithin: boolean;
  actionsHover: boolean;
};

async function measureRow(row: ElementHandle<Element>): Promise<RowState> {
  return row.evaluate((el) => {
    const reveal = el.querySelector(".action-reveal") as HTMLElement;
    const more = el.querySelector('[aria-label="More actions"]') as HTMLElement;
    const toolbar = el.querySelector(":scope > .actions") as HTMLElement;
    const revealStyle = getComputedStyle(reveal);
    const toolbarStyle = getComputedStyle(toolbar);
    const moreBox = more.getBoundingClientRect();
    return {
      toolbarOpacity: toolbarStyle.opacity,
      moreVisible: moreBox.width > 0 && toolbarStyle.opacity === "1",
      revealOpacity: revealStyle.opacity,
      revealWidth: reveal.getBoundingClientRect().width,
      gutter: getComputedStyle(el).getPropertyValue("--action-gutter").trim(),
      focusWithin: el.matches(":focus-within"),
      actionsHover: toolbar.matches(":hover"),
    };
  });
}

describe("t-91884b — agent overflow trigger aims", () => {
  let browser: Browser;
  let page: Page;
  let AgentRow: (props: unknown) => unknown;
  const artifacts: string[] = [];
  const keyboardLog: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    AgentRow = (await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"))).AgentRow as typeof AgentRow;
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    writeFileSync(path.join(OUT_DIR, "README.md"), `# t-91884b — agent overflow trigger\n\n${artifacts.map((f) => `- \`${f}\``).join("\n")}\n`);
    writeFileSync(path.join(EVIDENCE_DIR, "keyboard.md"), keyboardLog.join("\n") + "\n");
  });

  const agent = (name: string): AgentVM => ({
    name, model: "GPT-5.1 Codex", status: "running", kind: "agent", attention: "working",
    focus: { source: "task", taskId: "t-91884b", taskStatus: "active", text: "toolbar aims at the ellipsis", full: "toolbar aims at the ellipsis" },
    checklist: { kind: "step", position: 2, total: 4, text: "verify the resting corridor stays empty" },
  });

  function cards(count = 3): string {
    return Array.from({ length: count }, (_, i) =>
      renderStatic(AgentRow({ a: agent(i === 1 ? "reviewer" : `agent-${i + 1}`), flash: false })),
    ).join("");
  }

  async function loadShot(width: number, theme: "dark" | "light", body: string): Promise<ElementHandle<Element>> {
    await page.setViewport({ width: width + 40, height: 520, deviceScaleFactor: 2 });
    await page.setContent(pageHtml(body, width, theme), { waitUntil: "load" });
    const shot = await page.$("#shot");
    if (!shot) throw new Error("missing #shot");
    return shot;
  }

  async function save(shot: ElementHandle<Element>, name: string): Promise<void> {
    const dests = [path.join(OUT_DIR, name), path.join(EVIDENCE_DIR, name)];
    for (const dest of dests) {
      await shot.screenshot({ path: dest as `${string}.png` });
      expect(statSync(dest).size).toBeGreaterThan(1000);
    }
    artifacts.push(name);
  }

  it("four pointer states at both widths and both themes, plus keyboard parity", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const shot = await loadShot(width, theme, cards(3));
        const rows = await page.$$(".row");
        expect(rows.length).toBe(3);

        await page.mouse.move(width + 20, 500);
        await new Promise((r) => setTimeout(r, 160));
        const rest = await measureRow(rows[1]);
        expect(rest, `${theme}/${width} rest`).toMatchObject({ moreVisible: false, revealOpacity: "0", revealWidth: 0, gutter: "38px" });
        await save(shot, `rest-${width}-${theme}.png`);

        const name = await rows[1].$(".name");
        await name!.hover();
        await new Promise((r) => setTimeout(r, 220));
        const hoverCard = await measureRow(rows[1]);
        expect(hoverCard.moreVisible, `${theme}/${width} hover-card shows ...`).toBe(true);
        expect(hoverCard.revealOpacity, `${theme}/${width} hover-card keeps ruler closed`).toBe("0");
        expect(hoverCard.revealWidth, `${theme}/${width} hover-card ruler width`).toBe(0);
        await save(shot, `hover-card-${width}-${theme}.png`);

        const more = await rows[1].$('[aria-label="More actions"]');
        await more!.hover();
        await new Promise((r) => setTimeout(r, 220));
        const hoverEllipsis = await measureRow(rows[1]);
        expect(hoverEllipsis.moreVisible, `${theme}/${width} hover-ellipsis shows ...`).toBe(true);
        expect(hoverEllipsis.revealOpacity, `${theme}/${width} hover-ellipsis opens ruler`).toBe("1");
        expect(hoverEllipsis.revealWidth, `${theme}/${width} hover-ellipsis ruler width`).toBeGreaterThan(40);
        await save(shot, `hover-ellipsis-${width}-${theme}.png`);

        await page.mouse.move(width + 20, 500);
        await rows[1].evaluate((el) => {
          el.querySelector('[aria-label="More actions"]')?.setAttribute("aria-expanded", "true");
        });
        await page.evaluate((html) => {
          document.getElementById("shot")?.insertAdjacentHTML("beforeend", html);
        }, MENU_HTML);
        await new Promise((r) => setTimeout(r, 160));
        const menuOpen = await measureRow(rows[1]);
        expect(menuOpen.moreVisible, `${theme}/${width} menu-open keeps ... with pointer off card`).toBe(true);
        expect(menuOpen.revealOpacity, `${theme}/${width} menu-open does not force the ruler`).toBe("0");
        await save(shot, `menu-open-${width}-${theme}.png`);
      }
    }

    const kbBody = renderStatic(AgentRow({
      a: {
        ...agent("reviewer"),
        resources: { cpuPct: 12, memMb: 420 },
      },
      flash: false,
    }));
    const kbShot = await loadShot(360, "dark", kbBody);
    const row = (await page.$$(".row"))[0];
    await page.mouse.move(5, 5);
    await page.focus("body");
    await new Promise((r) => setTimeout(r, 80));

    const tabStops: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      await new Promise((r) => setTimeout(r, 180));
      const active = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          label: el?.getAttribute("aria-label") ?? el?.tagName ?? "none",
          inActions: !!el?.closest(".actions"),
          inRow: !!el?.closest(".row"),
        };
      });
      const measured = await measureRow(row);
      tabStops.push(
        `tab ${i + 1}: focus="${active.label}" inRow=${active.inRow} inActions=${active.inActions} moreVisible=${measured.moreVisible} ruler=${measured.revealOpacity === "1" ? "open" : "closed"}`,
      );
      if (active.label === "More actions") {
        expect(measured.moreVisible).toBe(true);
        expect(measured.revealOpacity).toBe("1");
        await page.keyboard.press("Enter");
        await row.evaluate((el) => {
          el.querySelector('[aria-label="More actions"]')?.setAttribute("aria-expanded", "true");
        });
        await page.evaluate((html) => {
          document.querySelector(".menu-backdrop")?.remove();
          document.getElementById("shot")?.insertAdjacentHTML("beforeend", html);
          document.querySelector<HTMLElement>(".more-item")?.focus();
        }, MENU_HTML);
        await page.mouse.move(5, 5);
        await new Promise((r) => setTimeout(r, 180));
        const afterOpen = await measureRow(row);
        tabStops.push(
          `menu open (focus on first item, pointer off card): moreVisible=${afterOpen.moreVisible} ruler=${afterOpen.revealOpacity === "1" ? "open" : "closed"}`,
        );
        expect(afterOpen.moreVisible).toBe(true);
        break;
      }
    }
    keyboardLog.push("Keyboard walkthrough at 360/dark (card with metrics peek):", ...tabStops);
    expect(tabStops.some((line) => /focus="Expand metrics/.test(line) && line.includes("ruler=closed") && line.includes("moreVisible=true")),
      "tab to peek (row, not actions) shows ... and keeps the ruler closed").toBe(true);
    expect(tabStops.some((line) => line.includes('focus="More actions"') && line.includes("ruler=open")),
      "tab to ... opens the ruler").toBe(true);
    await save(kbShot, "keyboard-menu-360-dark.png");

    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const reduced = await row.$eval(".action-reveal", (el) => getComputedStyle(el).transitionDuration);
    expect(reduced).toBe("0s");
  }, 120_000);
});
