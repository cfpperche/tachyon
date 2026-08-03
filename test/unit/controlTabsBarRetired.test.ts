import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { cockpitFixtures, strings as cockpitStrings, runtimeConfigFixtureSnapshot } from "../../scripts/webview-preview/fixtures/cockpit.js";
import { COCKPIT_SECTION_ORDER, type CockpitModel, type CockpitSectionId } from "../../src/cockpit/model.js";
import { CONTROL_SECTION_NAV } from "../../src/cockpit/sectionNav.js";
import { SAMPLE, type FleetVM } from "../../src/sidebar/types.js";

/**
 * t-aa2780 — Control has no section tab strip. The sidebar's Control tab is the navigation.
 *
 * Removing a nav bar is the easy half. These guards pin the four things that had to survive it, each
 * of which the strip was silently answering for something else:
 *
 *  1. the strip is gone and the content inherits its space (nothing renders above <main> on a section);
 *  2. the subroute "← Back" chrome — a DIFFERENT branch — still renders, and TAB_META still feeds it;
 *  3. every one of the twelve sections says which section it is, in its own body, including while a
 *     code-split chunk is still loading (that window used to be covered by the strip from outside);
 *  4. the engine log-error dot did not evaporate: it has a destination, in the sidebar, on both the
 *     always-visible tab icon and the tile that says which section to open.
 *
 * Plus the navigation-semantics decision, pinned as an ABSENCE (5): the launcher grid deliberately is
 * not a tablist and carries no `aria-selected` — the sidebar cannot observe which section Control is
 * showing, so a selection claim from here would go stale silently. See ControlGrid's own doc comment.
 */

const repoRoot = path.resolve(__dirname, "../..");
const SHELL_TSX = path.join(repoRoot, "src/webview/cockpit/App.tsx");
const SIDEBAR_TSX = path.join(repoRoot, "src/webview/sidebar/App.tsx");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * The H1 each section is expected to put on screen. Deliberately the LITERAL product text rather than
 * a lookup into the same strings the component reads: a guard that derives its expectation from the
 * subject cannot notice the subject losing its title.
 *
 * Five render their own PageChrome from the shell. The code-split ones (inbox, runtime)
 * are photographed at their Suspense fallback — a static serializer can never resolve a
 * lazy chunk — so what this asserts for them is precisely the loading-window identity that used to come
 * from the tab strip, worded as the launcher tile the human clicked. The remaining two are in
 * RADIX_BOUND below.
 */
const SECTION_HEADING: Record<CockpitSectionId, string> = {
  overview: "Overview",
  engine: "Engine / Bridge",
  fleet: "Fleet",
  inbox: "Inbox",
  mission: "Board",
  worktrees: "Managed worktrees",
  "execution-graph": "Execution graph",
  runtime: "Runtime Ops",
  "runtime-config": "Runtime Config",
  settings: "Settings",
  // Not on COCKPIT_SECTION_ORDER — listed because the record is keyed by CockpitSectionId and a new
  // section must be answered here, not silently skipped. `approvals`/`validations` are deep-link only;
  // `mission` (SDD 485 C5), `tmux` (D1), `plugins` (D2) and `runtime` (D3) HAVE launcher tiles but are
  // standalone apps, so Control renders no section for any of them and this suite never asks it to.
  approvals: "Approvals",
  plugins: "Plugins",
  tmux: "tmux",
  validations: "Validations",
};

/**
 * The two sections this suite CANNOT render, named rather than quietly skipped.
 *
 * Both mount a Radix `KitSelect`, whose Popper measures a real element (`placement.split` on a live
 * floating-ui state). There is no layout in a static serializer and no honest way to fake one, so
 * their heading is checked at the source instead — a weaker guard, and said so. What actually proves
 * these two paint their H1 is the headless Visual QA pass over the preview harness, which renders them
 * in a real browser; Overview is Control's landing screen, so it is the first thing that pass sees.
 */
const RADIX_BOUND: ReadonlyArray<{ id: CockpitSectionId; chrome: RegExp }> = [
  { id: "overview", chrome: /<PageChrome\s+title=\{s\.overviewTitle\}/ },
  { id: "runtime-config", chrome: /<PageChrome\s+title=\{s\.runtimeConfigTitle\}/ },
];
const RENDERABLE = COCKPIT_SECTION_ORDER.filter((id) => !RADIX_BOUND.some((r) => r.id === id));

/** The fixture whose model IS this section with no subroute on top of it. */
function sectionModel(id: CockpitSectionId): CockpitModel {
  const hit = Object.values(cockpitFixtures).find((f) => f.vm.section === id && !f.vm.activeRoute);
  if (!hit) throw new Error(`no cockpit fixture for section '${id}'`);
  return hit.vm;
}

const headings = (html: string): string[] =>
  [...html.matchAll(/<h1 class="ds-page-chrome-title">([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());

describe("t-aa2780 — Control renders no section tab strip", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  const renderSection = (id: CockpitSectionId): string =>
    renderStatic(Shell({
      strings: cockpitStrings,
      model: sectionModel(id),
      runtimeConfigSnapshot: runtimeConfigFixtureSnapshot,
      inspector: {},
    }));

  it("no section renders the .ck-tabs strip", () => {
    for (const id of RENDERABLE) {
      const html = renderSection(id);
      expect(html, `${id} must not render the tab strip`).not.toContain("ck-tabs");
    }
    // Scoped to the strip's own class on purpose: a section BODY may legitimately own tabs of its own
    // (Engine's log sources, Plugins' Installed/Marketplace), and a blanket "no role=tab in Control"
    // would fail on those while proving nothing about the navigation. What must be gone is the SHELL's
    // strip — the header assertion below is the structural half of that.
  });

  it("the content inherits the strip's space — nothing chrome-like sits above <main> on a section", () => {
    for (const id of RENDERABLE) {
      const html = renderSection(id);
      expect(html, `${id} must render no top header`).not.toContain('class="ck-top"');
      // The only nodes before <main> are the two zero-height nav-feedback affordances (t-ac79a7): the
      // absolutely-positioned progress bar and the visually-hidden live region. Neither takes layout.
      const before = html.slice(0, html.indexOf("<main"));
      expect(before, `${id} renders unexpected chrome above the content: ${before}`)
        .toBe('<div class="ck-root"><div aria-live="polite" class="ck-sr-only" data-testid="control-nav-status" role="status"></div>');
    }
  });

  it("the dead tab-strip CSS was removed, not left behind", () => {
    const css = read("src/webview/cockpit/cockpit.css");
    expect(css).not.toContain(".ck-tabs");
    expect(css).not.toContain(".ck-tab-dot");
    // the subroute chrome the strip's branch shared a stylesheet with is untouched.
    expect(css).toContain(".ck-top--fullpage");
    expect(css).toContain(".ck-chrome--fullpage");
  });
});

describe("t-aa2780 — the subroute breadcrumb, and TAB_META under it, survived", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  // One per breadcrumb wiring: the two that read TAB_META for their label (handoff, studio-command),
  // and the one with a fixed label (inbox-item). All three must still paint the row.
  // SDD 485 C4 — `task-detail` was the fourth and left with its subroute; its fixture is gone too.
  const SUBROUTES = [
    { fixture: "handoff", testid: "control-handoff-breadcrumb", label: "Overview" },
    { fixture: "studio-command", testid: "control-studio-breadcrumb", label: "Fleet" },
  ] as const;
  // SDD 485 D4 — `inbox-item` was the third and left with the Human Inbox app; its fixture is gone too,
  // the same way C4's `task-detail` went. The affordance did NOT disappear with it: the app renders its
  // own back button now (`inbox-item-back`), because that breadcrumb was the EMBED HOST's chrome and a
  // standalone item route has no host to draw it. `humanInboxApp.test.ts` owns that claim.

  it("every subroute still renders its ← Back row, with the label TAB_META supplies", () => {
    for (const { fixture, testid, label } of SUBROUTES) {
      const vm = cockpitFixtures[fixture].vm;
      const html = renderStatic(Shell({ strings: cockpitStrings, model: vm, inspector: {} }));
      expect(html, `${fixture} lost its fullpage chrome`).toContain('class="ck-top ck-top--fullpage"');
      expect(html, `${fixture} lost its breadcrumb`).toContain(`data-testid="${testid}"`);
      expect(html, `${fixture} breadcrumb lost its label`).toContain(label);
    }
  });

  it("TAB_META is still the breadcrumb's label source (removing it breaks ← Back, not just the tabs)", () => {
    const src = read("src/webview/cockpit/App.tsx");
    expect(src).toContain("const TAB_META: Record<CockpitSectionId, { icon: string; navKey: keyof CockpitStrings }>");
    expect((src.match(/s\[TAB_META\[parent\.section\]\.navKey\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("t-aa2780 — every section says which section it is", () => {
  let Shell: (props: unknown) => unknown;
  beforeAll(async () => {
    Shell = (await loadWebviewModule(SHELL_TSX, { packageResolution: true })).App as (props: unknown) => unknown;
  });

  it("every section this harness can render puts its own heading on screen", () => {
    for (const id of RENDERABLE) {
      const html = renderStatic(Shell({
        strings: cockpitStrings,
        model: sectionModel(id),
        runtimeConfigSnapshot: runtimeConfigFixtureSnapshot,
        inspector: {},
      }));
      expect(headings(html), `section '${id}' renders no page heading — it is anonymous without the tab strip`)
        .toContain(SECTION_HEADING[id]);
    }
  });

  it("the two Radix-bound sections carry a PageChrome title (source-level; the visual pass is the real proof)", () => {
    const src = read("src/webview/cockpit/App.tsx");
    for (const { id, chrome } of RADIX_BOUND) {
      expect(src, `section '${id}' lost its PageChrome title`).toMatch(chrome);
    }
    // Runtime Config states it on BOTH arms: the loaded editor and the no-snapshot/unavailable screen,
    // which was the one section body that used to render a bare, unnamed message.
    expect((src.match(/<PageChrome\s+title=\{s\.runtimeConfigTitle\}/g) ?? []).length).toBe(2);
  });

  it("every launcher tile has a heading here — a new tile needs one", () => {
    // SDD 485 C5 — the launcher offers twelve; eleven are sections Control renders and one (Board) opens
    // a standalone app. Both need a name a human can read, so the record spans the tiles, not the sections.
    expect(CONTROL_SECTION_NAV).toHaveLength(12);
    for (const tile of CONTROL_SECTION_NAV) expect(SECTION_HEADING[tile.id]?.length ?? 0).toBeGreaterThan(0);
    for (const id of COCKPIT_SECTION_ORDER) expect(SECTION_HEADING[id]?.length ?? 0).toBeGreaterThan(0);
  });

  it("a lazy section names itself WHILE loading, which is when it used to be anonymous", () => {
    // Rendered at the Suspense fallback (see staticPreact's suspense note): heading present, chunk not.
    //
    // SDD 485 D4 — driven through Validations now. This case has been repointed THREE times by the same
    // force: Plugins was its vehicle until D2, Runtime Ops until D3, the Inbox until D4, and each time the
    // section it drove became a standalone app. The property under test belongs to the SHELL, not to any
    // one section, so what the repoints record is which lazy sections Control still owns — TWO after this
    // one (`approvals`, `validations`), and both are compatibility routes rather than Phase D targets, so
    // the next migration to take a lazy section will have to bring its own vehicle or retire this case.
    const html = renderStatic(Shell({ strings: cockpitStrings, model: sectionModel("validations"), inspector: {} }));
    expect(headings(html)).toContain("Validations");
    expect(html).toContain("ds-empty-state--loading");
  });

});

describe("t-aa2780 — the engine log-error dot has a destination", () => {
  let SidebarApp: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;
  beforeAll(async () => {
    SidebarApp = (await loadWebviewModule(SIDEBAR_TSX)).App as typeof SidebarApp;
  });

  const clean: FleetVM = { ...SAMPLE, folder: { hash: "ws", name: "Project" } };
  const erroring: FleetVM = { ...clean, engineLogHasError: true };

  it("Control's own tab dot is gone from the shell", () => {
    expect(read("src/webview/cockpit/App.tsx")).not.toContain("ck-tab-dot");
    expect(read("src/webview/cockpit/App.tsx")).not.toContain("logHasError");
  });

  it("lights the sidebar's Control tab — visible from EVERY tab, not only the launcher", () => {
    // Rendered on ATTENTIONS, a tab that is not Control: the dot is on the strip, so it survives
    // whichever panel the human is actually reading.
    const html = renderStatic(SidebarApp({ fleets: [erroring], initialTab: "Attentions" }));
    expect(html).toContain('data-testid="tab-control-engine-dot"');
    // and it says so to a screen reader, on the button itself — the glyph is decorative.
    expect(html).toContain('aria-label="Control, errors in engine log"');
  });

  it("lights the Engine TILE, so the alarm has an address", () => {
    const html = renderStatic(SidebarApp({ fleets: [erroring], initialTab: "Control" }));
    expect(html).toContain('data-testid="control-tile-engine-dot"');
    expect(html).toContain('aria-label="Engine, errors in engine log"');
    // exactly one tile lights: eleven other sections are not the engine.
    expect((html.match(/class="ds-btn ctl-tile has-err"/g) ?? []).length).toBe(1);
  });

  it("stays dark when no root reports errors, and when no root MEASURED them", () => {
    for (const fleets of [[clean], [{ ...clean, engineLogHasError: false }]]) {
      const html = renderStatic(SidebarApp({ fleets, initialTab: "Control" }));
      expect(html).not.toContain("engine-dot");
      expect(html).not.toContain("has-err");
    }
  });

  it("multi-root folds with some(): one erroring folder lights the window's one strip", () => {
    const html = renderStatic(SidebarApp({
      fleets: [{ ...clean, folder: { hash: "a", name: "Alpha" } }, { ...erroring, folder: { hash: "b", name: "Beta" } }],
      initialTab: "Attentions",
    }));
    expect(html).toContain('data-testid="tab-control-engine-dot"');
  });

  it("sidebar.css declares both dots", () => {
    const css = read("src/webview/sidebar/sidebar.css");
    expect(css).toContain(".tab-dot");
    expect(css).toContain(".ctl-tile-dot");
  });
});

describe("t-aa2780 — navigation semantics did not regress", () => {
  let SidebarApp: (props: { fleets?: FleetVM[]; initialTab?: string }) => unknown;
  beforeAll(async () => {
    SidebarApp = (await loadWebviewModule(SIDEBAR_TSX)).App as typeof SidebarApp;
  });

  // The serializer emits attributes in NAME order, so the grid opens with its aria-label, not its class.
  const grid = (): string => {
    const html = renderStatic(SidebarApp({ fleets: [{ ...SAMPLE, folder: { hash: "ws", name: "Project" } }], initialTab: "Control" }));
    const marker = html.indexOf('data-testid="control-grid"');
    expect(marker, "the launcher grid did not render").toBeGreaterThan(-1);
    const start = html.lastIndexOf("<div", marker);
    const end = html.indexOf("</div>", html.indexOf('data-testid="control-tile-settings"'));
    return html.slice(start, end);
  };

  it("every one of the twelve destinations is a real keyboard-operable button", () => {
    const html = grid();
    // Twelve <button>s: reachable with Tab, actuated with Enter/Space, exactly like the twelve
    // role="tab" buttons the strip had (which carried no roving tabindex or arrow keys either).
    expect((html.match(/<button/g) ?? []).length).toBe(CONTROL_SECTION_NAV.length);
    expect(html).not.toContain("tabindex=\"-1\"");
    for (const tile of CONTROL_SECTION_NAV) expect(html).toContain(tile.label);
  });

  it("is a LABELLED group, not an unannounced div of icons", () => {
    const html = grid();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Control sections"');
  });

  it("deliberately claims NO selection: the sidebar cannot observe Control's live section", () => {
    const html = grid();
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("aria-current");
    // the decision is argued where a reader of the code will meet it, not only here.
    expect(read("src/webview/sidebar/App.tsx")).toContain("WHY THIS IS NOT A `tablist`");
  });
});
