import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __getExecutedCommands, __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import { initializeVsCodeNotifications } from "../../src/workspace/notify.js";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";
import { CONTROL_SECTION_NAV } from "../../src/webview/sidebar/sectionNav.js";
import { SAMPLE, TABS, type FleetVM, type TabId } from "@tachyon/shared/sidebar/types.js";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";

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
  const mod = await loadWebviewModule(path.join(repoRoot, "src/webview/sidebar/App.tsx"));
  return mod.App as (props: { fleets?: FleetVM[]; initialTab?: TabId; dispatch?: unknown }) => unknown;
}

describe("t-6e2952 — Control is a tab in the existing sidebar row", () => {
  it("sits SECOND in the row, right after Attentions, with the Control command's icon", () => {
    expect(TABS.map((t) => t.id)).toEqual([
      "Attentions", "Control", "Agents", "Terminals", "Pipelines", "Schedules", "Commands", "Runbooks", "Pins",
    ]);
    // $(dashboard) is what package.json declares for tachyon.openControl — same glyph, same product thing.
    expect(TABS[1]).toEqual({ id: "Control", icon: "dashboard" });
    const pkg = JSON.parse(read("package.json")) as { contributes: { commands: Array<{ command: string; icon?: string }> } };
    expect(pkg.contributes.commands.find((c) => c.command === "tachyon.openControl")?.icon).toBe("$(dashboard)");
  });

  it("adds NO sidebar view: the launcher has no viewType, no bundle and no host file", () => {
    const pkg = JSON.parse(read("package.json")) as { contributes: { views: { tachyon: Array<{ id: string }> } } };
    const viewIds = pkg.contributes.views.tachyon.map((v) => v.id);
    expect(viewIds).toEqual(["tachyonSidebarPrototype", "tachyonPluginSurfaces"]);
    expect(WEBVIEW_SURFACES.some((s) => s.viewId === "tachyonControlLauncher" || s.view === "control-launcher")).toBe(false);
    expect(existsSync(path.join(repoRoot, "src/webview/ControlLauncherProvider.ts"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "src/webview/control-launcher"))).toBe(false);
    for (const file of ["src/extension.ts", "esbuild.mjs", "scripts/webview-preview/routes.json"]) {
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
    const app = read("src/webview/sidebar/App.tsx");
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
