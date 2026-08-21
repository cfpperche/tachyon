import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __getExecutedCommands, __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../apps/vscode-extension/src/webview/SidebarPrototype.js";
import { initializeVsCodeNotifications } from "../../apps/vscode-extension/src/workspace/notify.js";
import { WEBVIEW_SURFACES } from "../../apps/vscode-extension/src/webview/surfaces.js";
import { CONTROL_SECTION_NAV } from "@tachyon/webview-ui/webview/sidebar/sectionNav.js";
import { sortRows } from "@tachyon/webview-ui/sidebar/sortRows.js";
import { encodeLauncherCustom, moveLauncherTile } from "@tachyon/webview-ui/sidebar/launcherOrder.js";
import { TABS, type FleetVM, type TabId } from "@tachyon/shared/sidebar/types.js";
import { SAMPLE } from "../../scripts/webview-preview/fixtures/sidebar.js";
import { loadWebviewModule, renderStatic, renderStaticWithElements, type RenderedElement } from "../helpers/staticPreact.js";

/**
 * t-6e2952 — the Control launcher is a TAB in the sidebar's icon row, not a sidebar VIEW.
 *
 * The first delivery (0.56.161) registered a second WebviewViewProvider (`tachyonControlLauncher`),
 * which VS Code renders as a collapsible "CONTROL" section STACKED ABOVE the Tachyon panel — two
 * panels where the requirement is one. These guards pin the three things that made it wrong:
 * where the tab lives, that no second view exists, and that a tile carries its section to the host.
 */

const repoRoot = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

function fakeView(): { view: vscode.WebviewView; receive: (msg: unknown) => void } {
  const handlers: Array<(msg: unknown) => void> = [];
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      handlers.push(cb);
      return { dispose() {} };
    },
    html: "",
  };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewView;
  return { view, receive: (msg: unknown) => { for (const cb of handlers) cb(msg); } };
}

async function loadApp() {
  const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"));
  return mod.App as (props: { fleets?: FleetVM[]; initialTab?: TabId; dispatch?: unknown }) => unknown;
}

describe("t-6e2952 — Control is a tab in the existing sidebar row", () => {
  it("sits SECOND in the row, right after Attentions, with the Control command's icon", () => {
    expect(TABS.map((t) => t.id)).toEqual([
      "Attentions", "Control", "Agents", "Terminals", "Pipelines", "Schedules", "Pins",
    ]);
    // $(dashboard) is what package.json declares for tachyon.openControl — same glyph, same product thing.
    expect(TABS[1]).toEqual({ id: "Control", icon: "dashboard" });
    const pkg = JSON.parse(read("apps/vscode-extension/package.json")) as { contributes: { commands: Array<{ command: string; icon?: string }> } };
    expect(pkg.contributes.commands.find((c) => c.command === "tachyon.openControl")?.icon).toBe("$(dashboard)");
  });

  it("adds NO sidebar view: the launcher has no viewType, no bundle and no host file", () => {
    const pkg = JSON.parse(read("apps/vscode-extension/package.json")) as { contributes: { views: { tachyon: Array<{ id: string }> } } };
    const viewIds = pkg.contributes.views.tachyon.map((v) => v.id);
    expect(viewIds).toEqual(["tachyonSidebarPrototype", "tachyonPluginSurfaces"]);
    expect(WEBVIEW_SURFACES.some((s) => s.viewId === "tachyonControlLauncher" || s.view === "control-launcher")).toBe(false);
    expect(existsSync(path.join(repoRoot, "packages/webview-ui/src/webview/ControlLauncherProvider.ts"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "packages/webview-ui/src/webview/control-launcher"))).toBe(false);
    for (const file of ["apps/vscode-extension/src/extension.ts", "esbuild.mjs", "scripts/webview-preview/routes.json"]) {
      expect(read(file)).not.toContain("ControlLauncher");
      expect(read(file)).not.toContain("control-launcher");
    }
  });

  it("renders the twelve section tiles from the shared catalog, in catalog order", async () => {
    const App = await loadApp();
    const html = renderStatic(App({ fleets: [SAMPLE], initialTab: "Control" }));
    expect(html).toContain('data-testid="control-grid"');
    const sections = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(CONTROL_SECTION_NAV.map((s) => s.id));
    for (const tile of CONTROL_SECTION_NAV) {
      expect(html).toContain(`data-testid="control-tile-${tile.id}"`);
      expect(html).toContain(tile.label);
    }
    // every tile is wired (the static serializer prints function props as [fn] — a lost handler diffs).
    expect((html.match(/onClick="\[fn\]"/g) ?? []).length).toBeGreaterThanOrEqual(CONTROL_SECTION_NAV.length);
  });

  it("mounts ONE grid for the window — Control is a singleton, not a per-folder section", async () => {
    const App = await loadApp();
    const twoRoots: FleetVM[] = [
      { ...SAMPLE, folder: { hash: "a", name: "Alpha" } },
      { ...SAMPLE, folder: { hash: "b", name: "Beta" } },
    ];
    const html = renderStatic(App({ fleets: twoRoots, initialTab: "Control" }));
    expect((html.match(/data-testid="control-grid"/g) ?? []).length).toBe(1);
    // no folder header above it (the per-folder map is not entered for this tab). Asserted on the
    // folder GROUP itself, not on "no workspace name appears anywhere": SDD 485 C6 put the project
    // selector in this tab's header row, and it lists workspace names as options by design. The name
    // was only ever a proxy for the header, and the proxy stopped being equivalent to the property.
    expect(html).not.toContain('class="grp folder');
    expect(html).not.toContain("folder-body");
    // and the grid lives INSIDE the one tabpanel, never above the tab strip.
    const app = read("packages/webview-ui/src/webview/sidebar/App.tsx");
    expect(app.split('class="tabs"')[0] ?? "").not.toContain("<ControlGrid");
    // t-374df3 — non-vacuity guard for the line above, nothing more: with no `<ControlGrid` in the
    // file at all, that split assertion passes by being empty. It counted `=== 1` and so went red on
    // rendering the grid from two branches (loading + loaded) — the current pattern in this very App
    // (`appPagePad.test.ts:87` asserts that shape with a count of 2), which changes nothing about
    // where the grid lives. How MANY get mounted is asserted on the rendered HTML above, not here.
    expect((app.match(/<ControlGrid/g) ?? []).length,
      "App.tsx mounts no <ControlGrid at all — the tab-strip assertion above passed vacuously")
      .toBeGreaterThan(0);
  });
});

describe("t-6e2952 — a tile routes its section to the one Control panel", () => {
  beforeEach(() => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
  });

  it("passes the section to tachyon.openControl (openCockpit navigates an open panel, never opens a second)", () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
    const { view, receive } = fakeView();
    provider.resolveWebviewView(view);

    receive({ type: "global", op: "openControl", sectionId: "mission" });

    expect(__getExecutedCommands().at(-1)).toEqual({ command: "tachyon.openControl", args: ["mission"] });
  });

  it("never forwards an unknown section: a bogus id degrades to a plain open", () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
    const { view, receive } = fakeView();
    provider.resolveWebviewView(view);

    receive({ type: "global", op: "openControl", sectionId: "../../etc/passwd" });
    expect(__getExecutedCommands().at(-1)).toEqual({ command: "tachyon.openControl", args: [] });

    receive({ type: "global", op: "openControl" });
    expect(__getExecutedCommands().at(-1)).toEqual({ command: "tachyon.openControl", args: [] });
  });

  it("every catalog section is a section the command actually accepts", () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
    const { view, receive } = fakeView();
    provider.resolveWebviewView(view);

    for (const tile of CONTROL_SECTION_NAV) receive({ type: "global", op: "openControl", sectionId: tile.id });

    expect(__getExecutedCommands().filter((c) => c.command === "tachyon.openControl").map((c) => c.args[0]))
      .toEqual(CONTROL_SECTION_NAV.map((t) => t.id));
  });
});

/**
 * t-50daeb metade 1 — the launcher sorts A–Z with the SAME machine the Agents tab uses.
 *
 * Two halves, because the delivery has two failure shapes the card names:
 *   • the launcher loses the sort (the grid stops honoring the pref), and
 *   • the preference stops surviving a reload (host no longer persists or no longer seeds the FIRST
 *     fleet push with it — the no-flicker contract from SidebarPrototype.ts:219).
 *
 * The DEFAULT is deliberately not alphabetical: `LAUNCHER_ORDER` holds the SDD 500 product positions
 * ("system takes the position Overview held"), and a sort control that silently replaced them with
 * A–Z for everyone would change the product default through the back door. So no-prefs ⇒ product
 * order is asserted here with the same weight as the two sorted modes.
 */
describe("t-50daeb — the launcher grid sorts A–Z and keeps the choice", () => {
  type AppProps = {
    fleets?: FleetVM[];
    initialTab?: TabId;
    prefs?: { agents?: string; terminals?: string; launcher?: string };
    dispatch?: { setSort?: (section: string, mode: string) => void };
  };
  let App: (props: AppProps) => unknown;

  beforeEach(async () => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
    const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
  });

  const tileIds = (html: string): string[] => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  const productOrder = CONTROL_SECTION_NAV.map((s) => s.id);
  const sortedIds = (mode: "name-asc" | "name-desc"): string[] =>
    sortRows(CONTROL_SECTION_NAV, mode, (s) => s.label).map((s) => s.id);

  it("sorts the tiles by label in both directions when the pref says so — and NOT before that", () => {
    // Non-vacuity first: the sorted order must actually differ from the product order, or the two
    // assertions below could pass with a grid that ignores prefs entirely.
    expect(sortedIds("name-asc")).not.toEqual(productOrder);

    const asc = tileIds(renderStatic(App({ fleets: [SAMPLE], initialTab: "Control", prefs: { launcher: "name-asc" } })));
    expect(asc).toEqual(sortedIds("name-asc"));

    const desc = tileIds(renderStatic(App({ fleets: [SAMPLE], initialTab: "Control", prefs: { launcher: "name-desc" } })));
    expect(desc).toEqual(sortedIds("name-desc"));
    expect(desc).toEqual([...asc].reverse());

    // The default is the PRODUCT order (SDD 500 positions), never a silent alphabetical takeover.
    const fresh = tileIds(renderStatic(App({ fleets: [SAMPLE], initialTab: "Control" })));
    expect(fresh).toEqual(productOrder);
  });

  it("carries the same flip control on Control, and a click from product order asks for name-asc", () => {
    const calls: Array<[string, string]> = [];
    const { elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    // The door production uses, called directly: the flip button's own onClick (SDD 501 pattern —
    // a rendered [fn] proves a handler exists, this proves it dispatches the right section).
    const flip = elements.find((e: RenderedElement) =>
      e.tag === "button" && typeof e.props.onClick === "function" && e.props["aria-label"] === "Sort launcher (Product order); click to sort A–Z",
    );
    expect(flip, "the Control header offers the sort control in its product-order state").toBeDefined();
    (flip!.props.onClick as () => void)();
    expect(calls).toEqual([["launcher", "name-asc"]]);
  });

  /**
   * The host half. WHO ELSE CAN REACH THE PREF:
   *   • Interface × flips the control — setSort must persist to the memento and repush;
   *   • Tachyon × window reload — a fresh provider must serve the saved pref in the FIRST fleet
   *     push, which is the only thing that prevents a product-order → saved-order flicker.
   */
  describe("the preference survives the host and the reload", () => {
    // Providers stay subscribed to the workspace scope until disposed — collected so a harness from
    // one test cannot answer a later test's pushes (the trap sidebarWorkspaceSelection.test.ts hit).
    const live: SidebarPrototypeProvider[] = [];
    beforeEach(() => { for (const p of live.splice(0)) p.dispose(); });
    afterEach(() => { for (const p of live.splice(0)) p.dispose(); });

    function sortHarness(seed: Record<string, unknown> = {}) {
      const store = new Map<string, unknown>(Object.entries(seed));
      const memento = {
        get: <T,>(key: string) => store.get(key) as T | undefined,
        update: async (key: string, value: unknown) => { store.set(key, value); },
        keys: () => [...store.keys()],
      } as unknown as vscode.Memento;
      const posted: Array<{ type?: string; prefs?: { launcher?: string } }> = [];
      const handlers: Array<(msg: unknown) => void> = [];
      const view = {
        webview: {
          cspSource: "vscode-resource:",
          options: undefined,
          asWebviewUri: (uri: unknown) => uri,
          postMessage: async (msg: unknown) => { posted.push(msg as { prefs?: { launcher?: string } }); return true; },
          onDidReceiveMessage: (cb: (msg: unknown) => void) => { handlers.push(cb); return { dispose() {} }; },
          html: "",
        },
        onDidDispose: () => ({ dispose() {} }),
      } as unknown as vscode.WebviewView;
      const target = {
        wsHash: "ws",
        folderName: "Demo",
        loadSidebar: async () => SAMPLE,
      } as never;
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [target], memento);
      live.push(provider);
      provider.resolveWebviewView(view);
      const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
      return {
        store,
        posted,
        settle,
        receive: (msg: unknown) => { for (const cb of handlers) cb(msg); },
        reload: () => {
          // A window reload: the SAME memento, a NEW provider — the first push is all the reloaded
          // webview sees before it paints.
          const fresh = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [target], memento);
          live.push(fresh);
          fresh.resolveWebviewView(view as unknown as vscode.WebviewView);
          return fresh;
        },
      };
    }
    const fleets = (h: { posted: Array<{ type?: string; prefs?: { launcher?: string } }> }) =>
      h.posted.filter((m) => m.type === "fleet");

    it("Interface × flips the control — the choice persists to the memento and rides the repush", async () => {
      const h = sortHarness();
      await h.settle();
      h.receive({ type: "setSort", section: "launcher", mode: "name-desc" });
      await h.settle();

      expect(h.store.get("tachyon.sidebar.sort")).toEqual({ launcher: "name-desc" });
      expect(fleets(h).at(-1)?.prefs?.launcher).toBe("name-desc");
    });

    it("Tachyon × window reload — the saved pref is in the FIRST fleet push, not painted over later", async () => {
      const h = sortHarness({ "tachyon.sidebar.sort": { launcher: "name-asc" } });
      await h.settle();
      expect(fleets(h)[0]?.prefs?.launcher, "the stored pref seeds the first push (no flicker)").toBe("name-asc");

      // …and a choice made this session is still there for the NEXT reload, not just this one.
      h.receive({ type: "setSort", section: "launcher", mode: "name-desc" });
      await h.settle();
      h.reload();
      await h.settle();
      expect(fleets(h).at(-1)?.prefs?.launcher).toBe("name-desc");
    });
  });
});

/**
 * t-539851 — rearranging the launcher. The test DRIVES the gesture (drag or keyboard cut/paste)
 * and asserts the order persisted through setSort. A screenshot cannot drag.
 *
 * Third-mode rule (written): rearranging while the grid is in A–Z writes custom:id,… and leaves A–Z.
 */
describe("t-539851 — drag and keyboard reorder persist the same custom order", () => {
  type AppProps = {
    fleets?: FleetVM[];
    initialTab?: TabId;
    prefs?: { agents?: string; terminals?: string; launcher?: string };
    dispatch?: { setSort?: (section: string, mode: string) => void; global?: (op: string, hash?: string, sectionId?: string) => void };
    initialReorderMode?: boolean;
    initialDraggingSection?: string;
    initialDropTarget?: string;
  };
  let App: (props: AppProps) => unknown;

  beforeEach(async () => {
    const mod = await loadWebviewModule(path.join(repoRoot, "packages/webview-ui/src/webview/sidebar/App.tsx"));
    App = mod.App as typeof App;
  });

  const productOrder = CONTROL_SECTION_NAV.map((s) => s.id);
  const tileEls = (elements: RenderedElement[], id: string): RenderedElement => {
    const el = elements.find((e) => e.tag === "button" && e.props["data-section"] === id);
    if (!el) throw new Error(`no tile ${id}`);
    return el;
  };
  const dragEvent = (id = "") => {
    let stored = id;
    const attrs: Record<string, string> = {};
    const grid = {
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      getAttribute: (k: string) => attrs[k],
    };
    return {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: {
        closest: () => grid,
        querySelector: () => null,
      },
      attrs,
      dataTransfer: {
        setData: (_k: string, v: string) => { stored = v; },
        getData: () => stored,
        effectAllowed: "move",
        dropEffect: "move",
        setDragImage() {},
      },
    };
  };
  const keyEvent = (key: string, mods: { ctrlKey?: boolean } = {}) => ({
    key,
    ctrlKey: !!mods.ctrlKey,
    metaKey: false,
    preventDefault() {},
  });

  it("Interface × drop: dragging system onto mission persists custom: of the moved product order", () => {
    const calls: Array<[string, string]> = [];
    const { elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    const ev = dragEvent();
    (tileEls(elements, "system").props.onDragStart as (e: unknown) => void)(ev);
    (tileEls(elements, "mission").props.onDrop as (e: unknown) => void)(ev);
    expect(calls).toEqual([["launcher", encodeLauncherCustom(moveLauncherTile(productOrder, "system", "mission"))]]);
  });

  it("Interface × keyboard cut/paste: the same assertion as the drop, through Ctrl+X then Ctrl+V", () => {
    const calls: Array<[string, string]> = [];
    const { elements, html } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    expect(html).toContain('data-testid="launcher-live"');
    expect(html).toContain('aria-live="polite"');
    (tileEls(elements, "system").props.onKeyDown as (e: unknown) => void)(keyEvent("x", { ctrlKey: true }));
    (tileEls(elements, "mission").props.onKeyDown as (e: unknown) => void)(keyEvent("v", { ctrlKey: true }));
    expect(calls).toEqual([["launcher", encodeLauncherCustom(moveLauncherTile(productOrder, "system", "mission"))]]);
  });

  it("Interface × drop while A–Z: rearranging leaves name-asc and writes custom of the moved A–Z list", () => {
    const calls: Array<[string, string]> = [];
    const { elements, html } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      prefs: { launcher: "name-asc" },
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    const az = sortRows(CONTROL_SECTION_NAV, "name-asc", (s) => s.label).map((s) => s.id);
    expect([...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1])).toEqual(az);
    const from = az[0]!;
    const to = az[2]!;
    const ev = dragEvent();
    (tileEls(elements, from).props.onDragStart as (e: unknown) => void)(ev);
    (tileEls(elements, to).props.onDrop as (e: unknown) => void)(ev);
    expect(calls).toEqual([["launcher", encodeLauncherCustom(moveLauncherTile(az, from, to))]]);
    expect(calls[0]![1].startsWith("custom:")).toBe(true);
    expect(calls[0]![1]).not.toBe("name-asc");
  });

  it("a saved custom pref paints that order, and the sort control names Custom order", () => {
    const custom = [...productOrder].reverse();
    const html = renderStatic(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      prefs: { launcher: encodeLauncherCustom(custom) },
    }));
    expect([...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1])).toEqual(custom);
    expect(html).toContain("Sort launcher (Custom order); click to sort A–Z");
    expect(html).toContain('data-testid="launcher-sort"');
    expect(html).toContain("codicon-gripper");
  });

  it("keyboard navigation reuses tabKey's grammar: Left/Right/Home/End plus Enter/Space activate", () => {
    const opens: string[] = [];
    const { elements, html } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { global: (_op: string, _hash?: string, sectionId?: string) => { if (sectionId) opens.push(sectionId); } },
    }));
    const system = tileEls(elements, "system");
    expect(system.props.tabindex).toBe(0);
    expect(tileEls(elements, "inbox").props.tabindex).toBe(-1);
    expect(typeof system.props.onKeyDown).toBe("function");
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent("Enter"));
    expect(opens).toEqual(["system"]);
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent(" "));
    expect(opens).toEqual(["system", "system"]);
    // The handlers exist for the same keys tabKey listens to — two grammars in this file would be worse than none.
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent("ArrowRight"));
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent("ArrowLeft"));
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent("Home"));
    (system.props.onKeyDown as (e: unknown) => void)(keyEvent("End"));
    expect(html).toContain('id="ctl-tile-system"');
  });

  it("reordering mode idle shows Done; tiles stay draggable so the next drop can fire", () => {
    const { html, elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      initialReorderMode: true,
    }));
    expect(html).toContain('data-reorder="true"');
    expect(html).toContain('data-testid="launcher-done"');
    expect(html).toContain("Control sections, rearranging");
    expect(tileEls(elements, "system").props.draggable).toBe(true);
  });

  it("Interface × dragover marks the insertion slot before drop, and setSort has not fired yet", () => {
    const calls: Array<[string, string]> = [];
    const { elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    const ev = dragEvent();
    (tileEls(elements, "system").props.onDragStart as (e: unknown) => void)(ev);
    (tileEls(elements, "mission").props.onDragOver as (e: unknown) => void)(ev);
    expect(ev.attrs["data-drop-at"], "the grid names the insertion id during dragover").toBe("mission");
    expect(calls, "persisting on dragover would hide this defect: the final order is already correct today").toEqual([]);
    (tileEls(elements, "mission").props.onDrop as (e: unknown) => void)(ev);
    expect(calls).toEqual([["launcher", encodeLauncherCustom(moveLauncherTile(productOrder, "system", "mission"))]]);
  });

  it("neighbors shift around an empty slot in the drag pose, with nothing written yet", () => {
    const calls: Array<[string, string]> = [];
    const { html } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      initialReorderMode: true,
      initialDraggingSection: "system",
      initialDropTarget: "mission",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    expect(calls).toEqual([]);
    expect(html).toContain('data-drop-at="mission"');
    expect(html).toContain('data-drop-slot="true"');
    expect(html).toContain("is-drop-slot");
    expect([...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1])).toEqual(
      moveLauncherTile(productOrder, "system", "mission"),
    );
  });

  it("Interface × dragend without drop does not persist", () => {
    const calls: Array<[string, string]> = [];
    const { elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    const ev = dragEvent();
    (tileEls(elements, "system").props.onDragStart as (e: unknown) => void)(ev);
    (tileEls(elements, "mission").props.onDragOver as (e: unknown) => void)(ev);
    (tileEls(elements, "system").props.onDragEnd as (e: unknown) => void)(ev);
    expect(calls).toEqual([]);
  });

  it("Interface × Escape during drag does not persist", () => {
    const calls: Array<[string, string]> = [];
    const { elements } = renderStaticWithElements(App({
      fleets: [SAMPLE],
      initialTab: "Control",
      dispatch: { setSort: (section, mode) => calls.push([section, mode]) },
    }));
    const ev = dragEvent();
    (tileEls(elements, "system").props.onDragStart as (e: unknown) => void)(ev);
    (tileEls(elements, "mission").props.onDragOver as (e: unknown) => void)(ev);
    (tileEls(elements, "system").props.onKeyDown as (e: unknown) => void)(keyEvent("Escape"));
    expect(calls).toEqual([]);
  });
});

describe("t-539851 — the custom pref survives the host and the reload", () => {
  const live: SidebarPrototypeProvider[] = [];
  beforeEach(() => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
    for (const p of live.splice(0)) p.dispose();
  });
  afterEach(() => { for (const p of live.splice(0)) p.dispose(); });

  function sortHarness(seed: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(seed));
    const memento = {
      get: <T,>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { store.set(key, value); },
      keys: () => [...store.keys()],
    } as unknown as vscode.Memento;
    const posted: Array<{ type?: string; prefs?: { launcher?: string } }> = [];
    const handlers: Array<(msg: unknown) => void> = [];
    const view = {
      webview: {
        cspSource: "vscode-resource:",
        options: undefined,
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (msg: unknown) => { posted.push(msg as { prefs?: { launcher?: string } }); return true; },
        onDidReceiveMessage: (cb: (msg: unknown) => void) => { handlers.push(cb); return { dispose() {} }; },
        html: "",
      },
      onDidDispose: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewView;
    const target = {
      wsHash: "ws",
      folderName: "Demo",
      loadSidebar: async () => SAMPLE,
    } as never;
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [target], memento);
    live.push(provider);
    provider.resolveWebviewView(view);
    const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    return {
      store,
      posted,
      settle,
      receive: (msg: unknown) => { for (const cb of handlers) cb(msg); },
      reload: () => {
        const fresh = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [target], memento);
        live.push(fresh);
        fresh.resolveWebviewView(view as unknown as vscode.WebviewView);
        return fresh;
      },
    };
  }
  const fleets = (h: { posted: Array<{ type?: string; prefs?: { launcher?: string } }> }) =>
    h.posted.filter((m) => m.type === "fleet");

  it("Interface × drop path — a custom encoding persists to the memento and rides the FIRST reload push", async () => {
    const encoded = encodeLauncherCustom(["companion", "system", "inbox"]);
    const h = sortHarness();
    await h.settle();
    h.receive({ type: "setSort", section: "launcher", mode: encoded });
    await h.settle();
    expect(h.store.get("tachyon.sidebar.sort")).toEqual({ launcher: encoded });
    expect(fleets(h).at(-1)?.prefs?.launcher).toBe(encoded);

    h.reload();
    await h.settle();
    expect(fleets(h).at(-1)?.prefs?.launcher, "the stored custom order seeds the first push (no flicker)").toBe(encoded);
  });

  it("garbage custom encodings are refused — the memento does not take them", async () => {
    const h = sortHarness();
    await h.settle();
    h.receive({ type: "setSort", section: "launcher", mode: "custom:" });
    h.receive({ type: "setSort", section: "launcher", mode: "custom:NOT_VALID" });
    h.receive({ type: "setSort", section: "agents", mode: encodeLauncherCustom(["system"]) });
    await h.settle();
    expect(h.store.get("tachyon.sidebar.sort")).toBeUndefined();
  });
});

