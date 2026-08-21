import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { AgentVM } from "@tachyon/shared/sidebar/types.js";

/**
 * t-a96e82 visual + behavior anchor, written from the card before the CSS change:
 *
 * Hovering the agent card (the name, the task line, anywhere that is not `.actions`) must paint
 * the overflow trigger and keep the ruler at `max-width: 0`. Hovering `.actions` itself (the `...`)
 * is what opens the ruler. Pins and terminal rows stay all-or-none. Keyboard: focus-within on the
 * row shows `...`; focus-within on `.actions` opens the ruler. An open menu keeps the trigger.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-a96e82");
const EVIDENCE_DIR = path.resolve(__dirname, "../../docs/research/evidence-t-a96e82");
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

const PIN_HTML = `<div class="pin" data-name="a pin">
  <button class="box" type="button" role="checkbox" aria-checked="false" aria-label="Mark done: a pin"></button>
  <div class="pin-body"><span class="txt">Investigate slow refresh</span></div>
  <div class="actions" role="group" aria-label="pin actions">
    <button class="act" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">···</button>
  </div>
</div>`;

type Cluster = {
  maxWidth: string;
  maxWidthPx: number;
  revealOpacity: string;
  revealWidth: number;
  actionsHover: boolean;
  actionsPointerEvents: string;
  actionsOpacity: string;
  moreVisible: boolean;
  inActions: boolean;
};

async function measureCluster(page: Page, row: ElementHandle<Element>, x?: number, y?: number): Promise<Cluster> {
  return page.evaluate((el, px, py) => {
    const reveal = el.querySelector(".action-reveal") as HTMLElement | null;
    const more = el.querySelector('[aria-label="More actions"]') as HTMLElement;
    const toolbar = el.querySelector(":scope > .actions") as HTMLElement;
    const revealStyle = reveal ? getComputedStyle(reveal) : null;
    const toolbarStyle = getComputedStyle(toolbar);
    const moreBox = more.getBoundingClientRect();
    const hit = px == null || py == null ? null : document.elementFromPoint(px, py);
    const maxWidth = revealStyle?.maxWidth ?? "none";
    return {
      maxWidth,
      maxWidthPx: maxWidth === "none" || maxWidth === "" ? Number.NaN : parseFloat(maxWidth),
      revealOpacity: revealStyle?.opacity ?? "",
      revealWidth: reveal?.getBoundingClientRect().width ?? 0,
      actionsHover: toolbar.matches(":hover"),
      actionsPointerEvents: toolbarStyle.pointerEvents,
      actionsOpacity: toolbarStyle.opacity,
      moreVisible: moreBox.width > 0 && toolbarStyle.opacity === "1",
      inActions: !!hit?.closest(".actions"),
    };
  }, row, x ?? null, y ?? null);
}

describe("t-a96e82 — agent card toolbar has two triggers", () => {
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
    writeFileSync(path.join(OUT_DIR, "README.md"), `# t-a96e82 — agent toolbar two triggers\n\n${artifacts.map((f) => `- \`${f}\``).join("\n")}\n`);
    if (process.env.TACHYON_SHOT_EVIDENCE === "1") {
      writeFileSync(path.join(EVIDENCE_DIR, "keyboard.md"), keyboardLog.join("\n") + "\n");
    }
  });

  const agent = (name: string): AgentVM => ({
    name, model: "GPT-5.1 Codex", status: "running", kind: "agent", attention: "working",
    focus: { source: "task", taskId: "t-a96e82", taskStatus: "active", text: "toolbar two triggers", full: "toolbar two triggers" },
    checklist: { kind: "step", position: 2, total: 4, text: "hover on the card must not open the ruler" },
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
    const dests = [path.join(OUT_DIR, name)];
    if (process.env.TACHYON_SHOT_EVIDENCE === "1") dests.push(path.join(EVIDENCE_DIR, name));
    for (const dest of dests) {
      await shot.screenshot({ path: dest as `${string}.png` });
      expect(statSync(dest).size).toBeGreaterThan(1000);
    }
    artifacts.push(name);
  }

  it("pointer on the card outside .actions keeps max-width 0; pointer on .actions opens the ruler", async () => {
    const shot = await loadShot(360, "dark", cards(3));
    const rows = await page.$$(".row");
    expect(rows.length).toBe(3);
    const row = rows[1];

    await page.mouse.move(400, 500);
    await new Promise((r) => setTimeout(r, 160));

    const name = await row.$(".name");
    const nameBox = await name!.boundingBox();
    if (!nameBox) throw new Error("missing .name box");
    const outsideX = nameBox.x + Math.min(12, nameBox.width / 2);
    const outsideY = nameBox.y + nameBox.height / 2;
    await page.mouse.move(outsideX, outsideY);
    await new Promise((r) => setTimeout(r, 220));
    const onCard = await measureCluster(page, row, outsideX, outsideY);
    expect(onCard.inActions, "pointer is on the card, not inside .actions").toBe(false);
    expect(onCard.actionsHover, "card hover must not match .actions:hover").toBe(false);
    expect(onCard.maxWidthPx, "1. pointer on card outside .actions → ruler max-width 0").toBe(0);
    expect(onCard.moreVisible, "card hover still paints the ...").toBe(true);
    expect(onCard.actionsPointerEvents, "card hover must not arm the whole overlay as a pointer target").toBe("none");

    const more = await row.$('[aria-label="More actions"]');
    const moreBox = await more!.boundingBox();
    if (!moreBox) throw new Error("missing more box");
    const onX = moreBox.x + moreBox.width / 2;
    const onY = moreBox.y + moreBox.height / 2;
    await page.mouse.move(onX, onY);
    await new Promise((r) => setTimeout(r, 220));
    const onActions = await measureCluster(page, row, onX, onY);
    expect(onActions.inActions, "pointer is inside .actions").toBe(true);
    expect(onActions.actionsHover, "pointer on .actions matches :hover").toBe(true);
    expect(onActions.maxWidthPx, "2. pointer on .actions → ruler opens").toBeGreaterThan(0);
    expect(onActions.revealOpacity).toBe("1");

    await save(shot, "assert-card-vs-actions-360-dark.png");
  }, 60_000);

  it("four pointer states at both widths and both themes, plus keyboard parity", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const shot = await loadShot(width, theme, cards(3));
        const rows = await page.$$(".row");
        expect(rows.length).toBe(3);

        await page.mouse.move(width + 20, 500);
        await new Promise((r) => setTimeout(r, 160));
        const rest = await measureCluster(page, rows[1]);
        expect(rest, `${theme}/${width} rest`).toMatchObject({ moreVisible: false, revealOpacity: "0", maxWidthPx: 0 });
        await save(shot, `rest-${width}-${theme}.png`);

        const name = await rows[1].$(".name");
        await name!.hover();
        await new Promise((r) => setTimeout(r, 220));
        const hoverCard = await measureCluster(page, rows[1]);
        expect(hoverCard.moreVisible, `${theme}/${width} hover-card shows ...`).toBe(true);
        expect(hoverCard.maxWidthPx, `${theme}/${width} hover-card ruler max-width`).toBe(0);
        expect(hoverCard.actionsHover, `${theme}/${width} hover-card is not .actions:hover`).toBe(false);
        await save(shot, `hover-card-${width}-${theme}.png`);

        const more = await rows[1].$('[aria-label="More actions"]');
        await more!.hover();
        await new Promise((r) => setTimeout(r, 220));
        const hoverEllipsis = await measureCluster(page, rows[1]);
        expect(hoverEllipsis.moreVisible, `${theme}/${width} hover-ellipsis shows ...`).toBe(true);
        expect(hoverEllipsis.maxWidthPx, `${theme}/${width} hover-ellipsis opens ruler`).toBeGreaterThan(0);
        expect(hoverEllipsis.revealOpacity).toBe("1");
        await save(shot, `hover-ellipsis-${width}-${theme}.png`);

        await page.mouse.move(width + 20, 500);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await rows[1].evaluate((el) => {
          el.querySelector('[aria-label="More actions"]')?.setAttribute("aria-expanded", "true");
        });
        await page.evaluate((html) => {
          document.getElementById("shot")?.insertAdjacentHTML("beforeend", html);
        }, MENU_HTML);
        await new Promise((r) => setTimeout(r, 280));
        const menuOpen = await measureCluster(page, rows[1]);
        expect(menuOpen.moreVisible, `${theme}/${width} menu-open keeps ... with pointer off card`).toBe(true);
        expect(menuOpen.maxWidthPx, `${theme}/${width} menu-open does not force the ruler`).toBe(0);
        expect(menuOpen.revealOpacity, `${theme}/${width} menu-open ruler opacity`).toBe("0");
        await save(shot, `menu-open-${width}-${theme}.png`);
      }
    }

    const kbBody = renderStatic(AgentRow({
      a: { ...agent("reviewer"), resources: { cpuPct: 12, memMb: 420 } },
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
      const measured = await measureCluster(page, row);
      tabStops.push(
        `tab ${i + 1}: focus="${active.label}" inRow=${active.inRow} inActions=${active.inActions} moreVisible=${measured.moreVisible} ruler=${measured.maxWidthPx > 0 ? "open" : "closed"}`,
      );
      if (active.label === "More actions") {
        expect(measured.moreVisible).toBe(true);
        expect(measured.maxWidthPx).toBeGreaterThan(0);
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
        await new Promise((r) => setTimeout(r, 280));
        const afterOpen = await measureCluster(page, row);
        tabStops.push(
          `menu open (focus on first item, pointer off card): moreVisible=${afterOpen.moreVisible} ruler=${afterOpen.maxWidthPx > 0 ? "open" : "closed"}`,
        );
        expect(afterOpen.moreVisible).toBe(true);
        expect(afterOpen.maxWidthPx, "open menu must not keep the ruler").toBe(0);
        break;
      }
    }
    keyboardLog.push("Keyboard walkthrough at 360/dark (card with metrics peek):", ...tabStops);
    expect(tabStops.some((line) => /focus="Expand metrics/.test(line) && line.includes("ruler=closed") && line.includes("moreVisible=true")),
      "tab to peek (row, not actions) shows ... and keeps the ruler closed").toBe(true);
    expect(tabStops.some((line) => line.includes('focus="More actions"') && line.includes("ruler=open")),
      "tab to ... opens the ruler").toBe(true);
    await save(kbShot, "keyboard-menu-360-dark.png");
  }, 120_000);

  it("pins and terminal rows still reveal the whole toolbar on row hover", async () => {
    const terminal = renderStatic(AgentRow({
      a: { name: "dev", kind: "terminal", status: "running", sub: "npm run dev" } satisfies AgentVM,
      flash: false,
    }));
    const shot = await loadShot(360, "dark", `${PIN_HTML}${terminal}`);
    const pin = await page.$(".pin");
    const term = await page.$(".row");
    if (!pin || !term) throw new Error("missing pin or terminal row");

    await page.mouse.move(400, 500);
    await new Promise((r) => setTimeout(r, 120));
    const pinRest = await pin.evaluate((el) => getComputedStyle(el.querySelector(".actions") as HTMLElement).opacity);
    const termRest = await term.evaluate((el) => getComputedStyle(el.querySelector(":scope > .actions") as HTMLElement).opacity);
    expect(pinRest, "pin hidden at rest").toBe("0");
    expect(termRest, "terminal hidden at rest").toBe("0");

    const pinTxt = await pin.$(".txt");
    await pinTxt!.hover();
    await new Promise((r) => setTimeout(r, 180));
    const pinHover = await pin.evaluate((el) => {
      const actions = el.querySelector(".actions") as HTMLElement;
      return { opacity: getComputedStyle(actions).opacity, pointerEvents: getComputedStyle(actions).pointerEvents };
    });
    expect(pinHover.opacity, "pin row hover shows the toolbar").toBe("1");
    expect(pinHover.pointerEvents, "pin row hover keeps the all-or-none target").toBe("auto");

    const termName = await term.$(".name");
    await termName!.hover();
    await new Promise((r) => setTimeout(r, 180));
    const termHover = await term.evaluate((el) => {
      const actions = el.querySelector(":scope > .actions") as HTMLElement;
      const acts = [...actions.querySelectorAll(".act")].filter((n) => getComputedStyle(n).opacity !== "0");
      return {
        opacity: getComputedStyle(actions).opacity,
        pointerEvents: getComputedStyle(actions).pointerEvents,
        actCount: actions.querySelectorAll(".act").length,
        visibleActs: acts.length,
        hasReveal: !!actions.querySelector(".action-reveal"),
      };
    });
    expect(termHover.hasReveal, "terminal is not an agent-actions split").toBe(false);
    expect(termHover.opacity, "terminal row hover shows the toolbar").toBe("1");
    expect(termHover.pointerEvents, "terminal row hover keeps the all-or-none target").toBe("auto");
    expect(termHover.actCount, "terminal paints its acts, not a clipped strip").toBeGreaterThan(0);
    await save(shot, "pin-and-terminal-hover-360-dark.png");
  }, 60_000);
});
