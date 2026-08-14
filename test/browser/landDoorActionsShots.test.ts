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
 * SDD 501 — headless Visual QA for the two doors added to the land block.
 *
 * THE ANCHOR, written from the task's problem statement before the buttons existed (spec.md § Intent):
 * a person standing at the land block, about to decide whether this branch becomes the trunk, can get
 * to the code from where they are standing — without leaving for a terminal, which is what all seven of
 * 2026-08-09's merges did. And three properties have to survive that addition:
 *
 *   (a) the block still reads as ONE decision. Land is what it is about; looking and proposing are
 *       preparation for it, and must not present as three equal buttons (spec.md § Open question 2,
 *       the decision tasks.md hands to Visual QA);
 *   (b) Propose is distinguishable from Land at a glance, on a repository that never opens a PR — the
 *       misclick this block cannot afford, because one of the two is irreversible in practice;
 *   (c) the human can read what the review would compare, in full, at any width they can drag to.
 *       A named base is what stops the review from being read as proof of something it did not show.
 *
 * The verdict this run produced, and what changed because of it, is in
 * `docs/specs/501-review-at-the-land-door/notes.md` § Visual QA.
 *
 * WHY TWO WIDTHS: 880 is the panel's frame, 360 the narrow end — this repo's pair. A row of buttons
 * beside a sentence is precisely the shape that looks right at 880 and collapses at 360.
 *
 * WHAT THIS RUN CANNOT SEE: the quick-pick the review opens is VS Code's own chrome, and so is the
 * diff editor behind it. A headless browser renders the webview and nothing else, so neither is
 * screenshotted here — that surface is the dev host's to show, and it is stated rather than skipped in
 * silence. What IS proved here is that the block never draws a diff of its own.
 *
 * Not part of `verify:full` (needs system Chrome + built `dist/`). Regenerate with:
 *   npm run build && npx vitest run --config vitest.browser.config.ts test/browser/landDoorActionsShots.test.ts
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/t-3eaf77-land-door");
const DIST = path.resolve(__dirname, "../../dist/webview");
const shotPage = path.join(DIST, "land-door-shot.html");

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
  // The sheet list the production panel declares (WorktreesPanel.configFor) — the screen that ships.
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>${read("codicon.css")}${read("design-system.css")}${theme}${read("control-typography.css")}${read("engine-workspace.css")}${read("worktrees.css")}
html,body{margin:0;padding:0;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:13px/1.4 var(--vscode-font-family,system-ui);}
</style></head><body class="vscode-dark"><div id="root">${body}</div></body></html>`;
}

describe("SDD 501 land-door actions headless Visual QA", () => {
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

  it("offers review and propose without turning the land block into three competing buttons", async () => {
    const html = renderStatic(App({
      strings: fixtureStrings,
      model: buildSectionsModel([bundle([
        row("fleet-ui", landSuggestion(READY)),
        row("t-3eaf77", landSuggestion({ ...READY, verified: null, trunkIsAncestorOfHead: false })),
      ])], { section: "worktrees", wsHash: "b349073a" }),
      post: () => {},
    }));

    for (const w of WIDTHS) {
      await page.setViewport({ width: w.px, height: 1600, deviceScaleFactor: 1 });
      writeFileSync(shotPage, pageHtml(html));
      await page.goto(`file://${shotPage}`, { waitUntil: "networkidle0" });
      await page.evaluate(() => document.fonts.ready);

      const geom = await page.evaluate(() => {
        const doc = document.documentElement;
        const blocks = [...document.querySelectorAll('[data-testid="worktree-land"]')];
        if (blocks.length !== 2) return { ok: false as const, reason: `expected 2 land blocks, saw ${blocks.length}` };
        const rows = [...document.querySelectorAll(".ck-land-actions")] as HTMLElement[];
        if (rows.length !== 2) return { ok: false as const, reason: `expected 2 action rows, saw ${rows.length}` };
        const text = (el: Element | null) => (el?.textContent ?? "").trim();
        const ready = blocks[0];
        const readyRow = rows[0];
        const command = ready.querySelector(".ck-land-command") as HTMLElement | null;
        if (!command) return { ok: false as const, reason: "the ready block lost its command" };
        const compare = [...document.querySelectorAll(".ck-land-compare")] as HTMLElement[];
        return {
          ok: true as const,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          // (a) ONE decision: exactly one emphasised control in the whole surface — Copy command. The
          // two doors added here are `default`, which is what keeps them from reading as peers of Land.
          primaryButtons: [...document.querySelectorAll("button")].filter((b) => b.className.includes("ds-btn-primary")).length,
          // Both blocks — including the BLOCKED one — offer both doors.
          reviewButtons: [...document.querySelectorAll("button")].filter((b) => text(b) === "Review these changes").length,
          proposeButtons: [...document.querySelectorAll("button")].filter((b) => text(b) === "Open a pull request").length,
          // (b) distinguishable from Land: the doors sit BELOW the command, behind their own rule.
          actionsBelowCommand: readyRow.getBoundingClientRect().top >= command.getBoundingClientRect().bottom - 1,
          actionsInsideBlock: rows.every((r, i) => r.getBoundingClientRect().right <= blocks[i].getBoundingClientRect().right + 1),
          // (c) the base is legible in full, not clipped to a stub.
          compareTexts: compare.map((c) => text(c)),
          clippedCompare: compare.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
          // Every button is fully inside the viewport — the 360 failure mode.
          buttonsOverflowing: [...document.querySelectorAll(".ck-land-actions button")]
            .filter((b) => b.getBoundingClientRect().right > doc.clientWidth + 1).length,
          // Nothing here draws a diff. VS Code's editor does that, out of this webview's reach.
          diffMarkup: document.querySelectorAll("ins, del, .ck-diff, .diff-hunk").length,
        };
      });

      expect(geom.ok, `land-door geometry at ${w.px}: ${JSON.stringify(geom)}`).toBe(true);
      if (geom.ok) {
        expect(geom.scrollWidth, `no horizontal scroll at ${w.px}px`).toBeLessThanOrEqual(geom.clientWidth + 1);
        expect(geom.primaryButtons, `only Land's copy action is emphasised at ${w.px}px`).toBe(1);
        expect(geom.reviewButtons, `both blocks offer review at ${w.px}px`).toBe(2);
        expect(geom.proposeButtons, `both blocks offer propose at ${w.px}px`).toBe(2);
        expect(geom.actionsBelowCommand, `the doors sit below the command at ${w.px}px`).toBe(true);
        expect(geom.actionsInsideBlock, `the action row stays inside its block at ${w.px}px`).toBe(true);
        expect(geom.clippedCompare, `the compared base is readable in full at ${w.px}px`).toBe(0);
        expect(geom.buttonsOverflowing, `no button runs off the viewport at ${w.px}px`).toBe(0);
        expect(geom.diffMarkup, `Tachyon renders no diff at ${w.px}px`).toBe(0);
        expect(geom.compareTexts[0], `the ready base is named at ${w.px}px`).toContain("main");
        expect(geom.compareTexts[0], `the ready head is named at ${w.px}px`).toContain(HEAD.slice(0, 12));
        expect(geom.compareTexts[1], `the blocked row names only what review proves at ${w.px}px`)
          .toBe("Review opens a committed-history comparison, not the working tree.");
      }

      const png = await page.screenshot({ type: "png", fullPage: true });
      writeFileSync(path.join(OUT_DIR, `land-door-${w.id}.png`), png);
    }
  }, 120_000);
});
