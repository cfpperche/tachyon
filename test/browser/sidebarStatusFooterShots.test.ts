import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTENSION_WEBVIEW_DIST } from "./support/extensionLayout.js";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { type FleetVM, type StatusNoticeVM, type TabId } from "@tachyon/shared/sidebar/types.js";
import { SAMPLE } from "../../scripts/webview-preview/fixtures/sidebar.js";
/**
 * t-bd9fb8 / SDD 512 fatia 2 — headless Visual QA + height cost of the status footer.
 *
 * THE ANCHOR, written from the problem statement before the footer was painted:
 *
 *   A fixed footer, outside the tab panel, shows the current action-less notice. The level is a
 *   word (info/warn/error), not color alone. A long message (median 135, max 161) has a path to
 *   the rest — ellipsis-only is the original defect. The row is compact: it must not eat a list
 *   row of height when there are few agents. When there is no notice, the footer is gone.
 *
 * Not part of `verify:full` (needs system Chrome + a built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/sidebarStatusFooterShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-bd9fb8-sidebar-status-footer");
const DISMISS_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-c820cb-sidebar-status-dismiss");
const DIST = EXTENSION_WEBVIEW_DIST;
const shotPage = path.join(DIST, "sidebar-status-footer-shot.html");

const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
] as const;

const SHORT: StatusNoticeVM = {
  message: "Nothing to review",
  level: "info",
  at: "2026-08-17T12:00:00.000Z",
};

const LONG: StatusNoticeVM = {
  message: "an action-less notice is precisely the branch that routes to setStatusBarMessage — clipped by width, erased on a timer, no button. That is where the owner's run grok login first went.",
  level: "error",
  at: "2026-08-17T12:00:00.000Z",
};

function withNotice(notice?: StatusNoticeVM): FleetVM {
  return { ...SAMPLE, ...(notice ? { statusNotice: notice } : {}) };
}

function pageHtml(body: string): string {
  const tokens = readFileSync(path.join(DIST, "tokens.css"), "utf8");
  const faces = readFileSync(path.join(DIST, "faces.css"), "utf8");
  const ds = readFileSync(path.join(DIST, "design-system.css"), "utf8");
  const sidebar = readFileSync(path.join(DIST, "sidebar.css"), "utf8");
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  // Inlined next to this file so `url("./codicon.ttf")` resolves — the dismiss control is a .act
  // Icon, and without the font the 22px hit target is an empty square (t-c820cb evidence).
  const codicon = readFileSync(path.join(DIST, "codicon.css"), "utf8");
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${codicon}${tokens}${faces}${theme}${ds}${sidebar}
html,body{margin:0;padding:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:12px/1.4 var(--vscode-font-family,system-ui);}
body{display:flex;flex-direction:column;min-height:100vh}
#root{display:flex;flex-direction:column;flex:1;min-height:0;height:100vh}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-bd9fb8 sidebar status footer — height and two-width shots", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: { fleets?: FleetVM[]; initialTab?: TabId }) => unknown;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    mkdirSync(DISMISS_DIR, { recursive: true });
    const mod = await loadWebviewModule(path.resolve(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
    browser = await puppeteer.launch({
      executablePath: resolveChromeExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(shotPage, { force: true });
    if (written.length) {
      writeFileSync(
        path.join(OUT_DIR, "README.md"),
        `# t-bd9fb8 — sidebar status footer\n\nAnchor: fixed footer, level as a word, path to the rest of a long message, one operator row when present.\n\n${written.map((f) => `- \`${f}\``).join("\n")}\n`,
        "utf8",
      );
    }
  });

  async function load(props: Parameters<typeof App>[0], width: { id: string; px: number }) {
    await page.setViewport({ width: width.px, height: 760, deviceScaleFactor: 1 });
    writeFileSync(shotPage, pageHtml(renderStatic(App(props))));
    await page.goto(`file://${shotPage}`, { waitUntil: "load" });
  }

  async function shoot(name: string) {
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file });
    expect(statSync(file).size, `${file} is empty`).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  const geometry = () => page.evaluate(() => {
    const box = (el: Element | null) => (el ? el.getBoundingClientRect().toJSON() as {
      x: number; y: number; width: number; height: number; top: number; bottom: number;
    } : null);
    const footer = document.querySelector("[data-testid='sidebar-status-footer']");
    const message = document.querySelector(".status-footer-message");
    const dismiss = document.querySelector("[data-testid='sidebar-status-dismiss']");
    const dismissIcon = dismiss?.querySelector(".codicon");
    return {
      footer: box(footer),
      kbar: box(document.querySelector(".kbar")),
      row: box(document.querySelector(".row")),
      panel: box(document.querySelector("#sidebar-panel")),
      messageBox: box(message),
      dismissBox: box(dismiss),
      dismissGlyph: dismissIcon ? getComputedStyle(dismissIcon, "::before").content : "",
      level: footer?.getAttribute("data-level") ?? null,
      levelText: document.querySelector(".status-footer .notice-level")?.textContent ?? "",
      message: message?.textContent ?? "",
      detailsOpen: document.querySelector(".status-footer details")?.hasAttribute("open") ?? false,
      footerTop: footer ? footer.getBoundingClientRect().top : null,
      panelBottom: document.querySelector("#sidebar-panel")?.getBoundingClientRect().bottom ?? null,
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  it("collapsed cost is one operator row, not a list row, at both widths", async () => {
    const costs: Array<{ width: string; footer: number; kbar: number; row: number }> = [];
    for (const w of WIDTHS) {
      await load({ fleets: [withNotice(SHORT)], initialTab: "Agents" }, w);
      await shoot(`short-info-${w.id}`);
      const g = await geometry();
      expect(g.footer, `@ ${w.id}`).not.toBeNull();
      expect(g.kbar, `@ ${w.id}`).not.toBeNull();
      expect(g.row, `@ ${w.id}`).not.toBeNull();
      expect(g.level, `@ ${w.id}`).toBe("info");
      expect(g.levelText, `@ ${w.id}`).toBe("info");
      expect(g.message, `@ ${w.id}`).toBe("Nothing to review");
      expect(g.detailsOpen, `@ ${w.id}`).toBe(false);
      // Pinned under the panel, not inside the scrolling list.
      expect(g.footer!.top, `@ ${w.id}: footer above the panel`).toBeGreaterThanOrEqual((g.panelBottom ?? 0) - 1);
      // Compact: same density family as the search bar, and cheaper than one agent card.
      expect(g.footer!.height, `@ ${w.id}: taller than the search bar`).toBeLessThanOrEqual(g.kbar!.height + 2);
      expect(g.footer!.height, `@ ${w.id}: ate a list row`).toBeLessThan(g.row!.height);
      expect(g.docWidth, `@ ${w.id}: horizontal overflow`).toBeLessThanOrEqual(g.viewportWidth);
      costs.push({ width: w.id, footer: g.footer!.height, kbar: g.kbar!.height, row: g.row!.height });
    }
    writeFileSync(path.join(OUT_DIR, "height.json"), `${JSON.stringify(costs, null, 2)}\n`);
    written.push("height.json");
  }, 60_000);

  it("a 161-char error keeps a path to the rest and stays with the agent list", async () => {
    for (const w of WIDTHS) {
      await load({ fleets: [withNotice(LONG)], initialTab: "Agents" }, w);
      const closed = await geometry();
      expect(closed.level, `@ ${w.id}`).toBe("error");
      expect(closed.levelText, `@ ${w.id}`).toBe("error");
      expect(closed.message, `@ ${w.id}`).toBe(LONG.message);
      expect(closed.detailsOpen, `@ ${w.id}`).toBe(false);
      const closedHeight = closed.footer!.height;
      await shoot(`long-error-closed-${w.id}`);

      await page.click(".status-footer-summary");
      const open = await geometry();
      expect(open.detailsOpen, `@ ${w.id}`).toBe(true);
      expect(open.message, `@ ${w.id}`).toBe(LONG.message);
      expect(open.footer!.height, `@ ${w.id}: open did not reveal more`).toBeGreaterThan(closedHeight);
      expect(open.docWidth, `@ ${w.id}: expand overflowed sideways`).toBeLessThanOrEqual(open.viewportWidth);
      await shoot(`long-error-open-${w.id}`);
    }
  }, 60_000);

  it("absent notice costs no height", async () => {
    await load({ fleets: [withNotice()], initialTab: "Agents" }, WIDTHS[1]);
    const g = await geometry();
    expect(g.footer).toBeNull();
    await shoot("absent-360");
  }, 60_000);

  it("t-c820cb — dismiss control and leftover message width at both widths, short and long", async () => {
    const leftovers: Array<{
      case: string;
      width: number;
      messageWidth: number;
      dismissWidth: number;
      footerWidth: number;
    }> = [];
    const writtenDismiss: string[] = [];
    const shootDismiss = async (name: string) => {
      const file = path.join(DISMISS_DIR, `${name}.png`);
      await page.screenshot({ path: file });
      expect(statSync(file).size, `${file} is empty`).toBeGreaterThan(1000);
      writtenDismiss.push(path.basename(file));
    };

    for (const notice of [
      { id: "short", vm: SHORT },
      { id: "long", vm: LONG },
    ] as const) {
      for (const w of WIDTHS) {
        await load({ fleets: [withNotice(notice.vm)], initialTab: "Agents" }, w);
        const g = await geometry();
        expect(g.footer, `${notice.id}@${w.id}`).not.toBeNull();
        expect(g.dismissBox, `${notice.id}@${w.id}: no dismiss control`).not.toBeNull();
        expect(g.messageBox, `${notice.id}@${w.id}: no message box`).not.toBeNull();
        expect(g.dismissBox!.width, `${notice.id}@${w.id}: dismiss invisible`).toBeGreaterThan(0);
        expect(g.dismissGlyph, `${notice.id}@${w.id}: close glyph missing`).not.toMatch(/^(|none|""|'')$/)
        expect(g.messageBox!.width, `${notice.id}@${w.id}: message crushed`).toBeGreaterThan(80);
        expect(g.docWidth, `${notice.id}@${w.id}: overflow`).toBeLessThanOrEqual(g.viewportWidth);
        leftovers.push({
          case: notice.id,
          width: w.px,
          messageWidth: Math.round(g.messageBox!.width),
          dismissWidth: Math.round(g.dismissBox!.width),
          footerWidth: Math.round(g.footer!.width),
        });
        await shootDismiss(`${notice.id}-${w.id}`);
      }
    }

    writeFileSync(path.join(DISMISS_DIR, "leftover.json"), `${JSON.stringify(leftovers, null, 2)}\n`);
    writeFileSync(
      path.join(DISMISS_DIR, "README.md"),
      `# t-c820cb — sidebar status footer dismiss\n\nAnchor: the footer shows a dismiss control next to the message at 880 and 360, short and long. The full message stays reachable via details. No timer.\n\nLeftover message widths (px):\n\n${leftovers.map((r) => `- ${r.case} @ ${r.width}: message ${r.messageWidth} after a ${r.dismissWidth} control`).join("\n")}\n\n${writtenDismiss.map((f) => `- \`${f}\``).join("\n")}\n`,
      "utf8",
    );
  }, 60_000);
});
