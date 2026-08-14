import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { strings as fixtureStrings } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { buildSectionsModel, type WorkspaceBundle, type WorktreeRow } from "../../src/sections/model.js";
import { landSuggestion, type LandFacts } from "@tachyon/engine/worktree/land.js";

/**
 * t-7cb971 — headless Visual QA for the land suggestion on a Worktrees row.
 *
 * THE ANCHOR, written from the task's problem statement before the block existed: a person who has
 * broken the trunk three times running this merge by hand opens the row and can tell, without reading
 * any code, (a) whether this delivery is safe to land right now, (b) what proved each precondition or
 * what to do about the ones that failed, and (c) can take the exact command in one action — and never
 * receives a command they should not trust. The command is the one string here that must be readable
 * in FULL at any width a person can drag to: a land command clipped to a stub is worse than absent,
 * because it looks copyable.
 *
 * WHY TWO WIDTHS. 880 is the panel's own frame; 360 is the narrow end. A single width hides the class
 * of defect that matters here — a long mono string next to a button, which at 880 looks fine and at
 * 360 leaves the command a few characters wide.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/landSuggestionShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-7cb971-land-suggestion");
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "land-suggestion-shot.html");

const WIDTHS = [
  { id: "880", px: 880 },
  { id: "360", px: 360 },
];

const HEAD = "9f3c1ab27d5e408b6c1d90ffae2b7c1d4e88a021";
const READY: LandFacts = {
  head: HEAD,
  branch: "tachyon/change/fleet-ui",
  trunkRef: "main",
  primaryPath: "/home/goat/tachyon",
  dirty: false,
  commits: 2,
  verified: { tree: "41d0c7a9be2201fe3b6c8d47a05e91cc73b2f8de", at: "2026-08-07T16:41:09.220Z" },
  trunkIsAncestorOfHead: true,
  trunkHead: null,
  primaryBranch: "main",
  primaryDirty: false,
};

const UNLANDED = {
  state: "needs-review" as const,
  reasons: ["2 commit(s) not contained in base or in 'main'; land or integrate them into the trunk before removing"],
  pathExists: true,
  dirty: false,
  aheadOfBase: 2,
  containedInBase: false,
  containedInTrunk: false,
  trunkRef: "main",
};

function row(id: string, land: WorktreeRow["land"]): WorktreeRow {
  return {
    id,
    kind: "change",
    path: `/home/goat/.cache/tachyon/worktrees/b349073a/change/${id}`,
    branch: `tachyon/change/${id}`,
    status: "active",
    slug: id,
    folder: "tachyon",
    wsHash: "b349073a",
    tachyonCreatedBranch: true,
    classification: UNLANDED,
    land,
  };
}

function bundle(worktrees: WorktreeRow[]): WorkspaceBundle {
  return {
    control: {
      folderName: "tachyon",
      workspaceRoot: "/home/goat/tachyon",
      wsHash: "b349073a",
      bridgeUrl: "http://127.0.0.1:1",
      identity: null,
      agents: { total: 0, running: 0 },
      authConfigured: "unknown",
      notes: [],
    } as WorkspaceBundle["control"],
    agents: [],
    worktrees,
    approvals: [],
  };
}

function pageHtml(body: string): string {
  const read = (f: string) => readFileSync(path.join(DIST, f), "utf8");
  const theme = readFileSync(path.resolve(__dirname, "../../scripts/webview-preview/theme-dark.css"), "utf8");
  // The same sheet list the production panel declares (WorktreesPanel.configFor), so the shot is of the
  // screen that ships rather than of an unstyled approximation of it.
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${read("codicon.css")}${read("design-system.css")}${theme}${read("control-typography.css")}${read("engine-workspace.css")}${read("worktrees.css")}
html,body{margin:0;padding:0;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:13px/1.4 var(--vscode-font-family,system-ui);}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("t-7cb971 land suggestion headless Visual QA", () => {
  let browser: Browser;
  let page: Page;
  let App: (props: unknown) => unknown;

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    App = (await loadWebviewModule(path.resolve(__dirname, "../../src/webview/worktrees/App.tsx"), { packageResolution: true })).App as typeof App;
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
  });

  it("the command is readable in full and the verdict is legible at 880 and 360", async () => {
    const html = renderStatic(App({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([
        row("fleet-ui", landSuggestion(READY)),
        row("t-7cb971", landSuggestion({ ...READY, verified: null, trunkIsAncestorOfHead: false })),
      ])], { section: "worktrees", wsHash: "b349073a" }),
      post: () => {},
    }));

    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 1400, deviceScaleFactor: 1 });
      writeFileSync(shotPage, pageHtml(html));
      await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);

      const geom = await page.evaluate(() => {
        const doc = document.documentElement;
        const blocks = [...document.querySelectorAll('[data-testid="worktree-land"]')];
        if (blocks.length !== 2) return { ok: false as const, reason: `expected 2 land blocks, saw ${blocks.length}` };
        const cmd = document.querySelector(".ck-land-command-text") as HTMLElement | null;
        if (!cmd) return { ok: false as const, reason: "no command element" };
        const checks = [...document.querySelectorAll(".ck-land-checks li")];
        return {
          ok: true as const,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          // Exactly one command: the blocked delivery must offer none.
          commands: document.querySelectorAll(".ck-land-command-text").length,
          blockedNotices: document.querySelectorAll(".ck-land-blocked").length,
          // The command wraps rather than being clipped — nothing hidden past its own box.
          commandClipped: cmd.scrollWidth > cmd.clientWidth + 1,
          commandInsideBlock: cmd.getBoundingClientRect().right <= blocks[0].getBoundingClientRect().right + 1,
          checks: checks.length,
          // Every check sentence is fully rendered, not truncated to a stub.
          clippedChecks: checks.filter((li) => {
            const body = li.querySelector(".ck-land-check-body") as HTMLElement | null;
            return !body || body.scrollWidth > body.clientWidth + 1;
          }).length,
          // The ✓/✕ marks keep their column so wrapped sentences stay aligned.
          markColumns: new Set([...document.querySelectorAll(".ck-land-mark")].map((m) => Math.round(m.getBoundingClientRect().left))).size,
        };
      });

      expect(geom.ok, `land block geometry at ${w.px}: ${JSON.stringify(geom)}`).toBe(true);
      if (geom.ok) {
        expect(geom.scrollWidth, `no horizontal scroll at ${w.px}px`).toBeLessThanOrEqual(geom.clientWidth + 1);
        expect(geom.commands, `only the ready delivery offers a command at ${w.px}px`).toBe(1);
        expect(geom.blockedNotices, `the blocked delivery says so at ${w.px}px`).toBe(1);
        expect(geom.commandClipped, `the land command must not be clipped at ${w.px}px`).toBe(false);
        expect(geom.commandInsideBlock, `the command stays inside its block at ${w.px}px`).toBe(true);
        expect(geom.checks, `both blocks list five preconditions at ${w.px}px`).toBe(10);
        expect(geom.clippedChecks, `no clipped check sentence at ${w.px}px`).toBe(0);
        expect(geom.markColumns, `the ✓/✕ marks share one column at ${w.px}px`).toBe(1);
      }

      const png = await page.screenshot({ type: "png", fullPage: true });
      writeFileSync(path.join(OUT_DIR, `land-suggestion-${w.id}.png`), png);
    }
  }, 120_000);
});
