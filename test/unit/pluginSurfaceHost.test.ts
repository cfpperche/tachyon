import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { __createdPanels, __getExecutedCommands, __getQuickPickCalls, __resetVscodeMock, __setQuickPickResult } from "../mocks/vscode.js";
import { applyInstall, detectRuntimes, loadPlugin, previewInstall } from "../../apps/vscode-extension/src/plugins/engine.js";
import { LOCKFILE_REL_PATH } from "@tachyon/engine/plugins/lockfile.js";
import { legacyPluginSurfaceTarget, PluginSurfaceHost } from "../../apps/vscode-extension/src/plugins/ui/host.js";
import { PLUGIN_UI_ACTION } from "@tachyon/webview-ui/webview/plugin-host/relay.js";
import type { WorkspacePluginPresentationTarget } from "../../apps/vscode-extension/src/shell/WorkspacePresentation.js";

const ROOT = path.resolve(__dirname, "..", "..");
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("PluginSurfaceHost lifecycle (spec 349 hardening)", () => {
  it("revokes editor frame/session handles when an installed view target disappears", async () => {
    const wsRoot = await installFixture("spec349-mundinho");
    const workspace = fakeWorkspace(wsRoot, "ws-editor", [{
      name: "alpha", running: true, lifetime: "saved", attention: "needs-input",
    }]);
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [workspace]);

    host.openSurface({ pluginId: "spec349-mundinho", viewId: "mundinho", wsHash: "ws-editor" });
    await tick();
    expect(__createdPanels).toHaveLength(1);
    const panel = __createdPanels[0];
    expect(panel.disposed).toBe(false);
    expect(panel.webview.html).toContain('data-shell-surface="tachyonPluginSurface"');
    expect(panel.webview.html).toContain("/dist/webview/quick-picker.css");
    expect(panel.webview.posted.some((m) => isProjection(m))).toBe(true);

    const projection = panel.webview.posted.find(isProjection) as {
      projection: { generation: number; agents: Array<{ handle: string; status: string; attention?: string }> };
    };
    expect(projection.projection.agents[0]).toMatchObject({ status: "needs", attention: "needs-input" });
    panel.webview.__receive({
      type: PLUGIN_UI_ACTION,
      id: "before-revoke",
      action: "focusAgent",
      handle: projection.projection.agents[0].handle,
      generation: projection.projection.generation,
      userGesture: true,
    });
    await tick();
    expect(__getExecutedCommands()).toEqual([{ command: "tachyon.openAgentTerminalItem", args: ["alpha", "ws-editor"] }]);

    fs.rmSync(path.join(wsRoot, LOCKFILE_REL_PATH));
    host.refreshAll();
    await tick();
    expect(panel.disposed).toBe(true);

    panel.webview.__receive({
      type: PLUGIN_UI_ACTION,
      id: "after-revoke",
      action: "focusAgent",
      handle: projection.projection.agents[0].handle,
      generation: projection.projection.generation,
      userGesture: true,
    });
    await tick();
    expect(__getExecutedCommands()).toHaveLength(1);
  });

  it("re-registers a sidebar surface on lockfile scope changes and revokes the old session", async () => {
    const wsA = await installFixture("spec349-sidebar", "sidebar-a");
    const wsB = await installFixture("spec349-sidebar", "sidebar-b");
    const workspaces = [
      fakeWorkspace(wsA, "b-ws", [{ name: "old-agent", running: true, lifetime: "saved" }]),
      fakeWorkspace(wsB, "a-ws", [{ name: "new-agent", running: true, lifetime: "saved" }]),
    ];
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => workspaces);
    const view = fakeWebviewView();

    host.resolveWebviewView(view as unknown as vscode.WebviewView);
    await tick();
    expect(view.webview.html).toContain('data-shell-surface="tachyonPluginSurfaces"');
    const firstProjection = view.webview.posted.find(isProjection) as { projection: { agents: Array<{ handle: string }> } };
    expect(firstProjection.projection.agents[0]).toMatchObject({ label: "Agent 1", status: "running" });

    fs.rmSync(path.join(wsB, LOCKFILE_REL_PATH));
    host.refreshAll();
    await tick();
    const projections = view.webview.posted.filter(isProjection) as Array<{ projection: { agents: Array<{ handle: string }> } }>;
    expect(projections).toHaveLength(2);
    expect(projections[1].projection.agents[0]).toMatchObject({ label: "Agent 1", status: "running" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    view.webview.__receive({
      type: PLUGIN_UI_ACTION,
      id: "old-handle",
      action: "focusAgent",
      handle: firstProjection.projection.agents[0].handle,
      generation: 1,
      userGesture: true,
    });
    await tick();
    const rejected = view.webview.posted.find((m) => isActionResult(m) && m.id === "old-handle") as { result: { ok: boolean; code?: string } };
    expect(rejected.result).toMatchObject({ ok: false, code: "unknown_handle" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown_handle"));
    expect(__getExecutedCommands()).toEqual([]);
  });
});

describe("t-4aac93 — multi-surface launch (production host doors)", () => {
  it("openSurface() with N editor surfaces asks the picker and opens the pick, not surfaces[0]", async () => {
    const wsRoot = await installMultiViewFixture({
      name: "worlds",
      views: [
        { id: "alpha", title: "Alpha World", surface: "editor", entry: "ui/alpha.html" },
        { id: "zeta", title: "Zeta Map", surface: "editor", entry: "ui/zeta.html" },
      ],
    });
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [fakeWorkspace(wsRoot, "ws-n", [])]);
    __setQuickPickResult("Zeta Map");

    await host.openSurface();
    await tick();

    expect(__getQuickPickCalls()).toHaveLength(1);
    const labels = (__getQuickPickCalls()[0].items as Array<{ label: string }>).map((item) => item.label);
    expect(labels).toEqual(["Alpha World", "Zeta Map"]);
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].title).toBe("Zeta Map");
  });

  it("openSurface() with one editor surface still opens it directly — no picker", async () => {
    const wsRoot = await installFixture("spec349-mundinho");
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [fakeWorkspace(wsRoot, "ws-editor", [])]);

    await host.openSurface();
    await tick();

    expect(__getQuickPickCalls()).toEqual([]);
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].title).toBe("Mundinho Fixture");
  });

  it("sidebar host with N surfaces renders first-party tabs for every one, not only find()[0]", async () => {
    const wsRoot = await installMultiViewFixture({
      name: "widgets",
      views: [
        { id: "one", title: "Sidebar One", surface: "sidebar", entry: "ui/one.html" },
        { id: "two", title: "Sidebar Two", surface: "sidebar", entry: "ui/two.html" },
      ],
    });
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [fakeWorkspace(wsRoot, "ws-side", [])]);
    const view = fakeWebviewView();

    host.resolveWebviewView(view as unknown as vscode.WebviewView);
    await tick();

    expect(view.webview.html).toContain("Sidebar One");
    expect(view.webview.html).toContain("Sidebar Two");
    expect(view.webview.html).toContain('"siblings"');
  });

  it("sidebar host with one surface still has no tablist (the common case is unchanged)", async () => {
    const wsRoot = await installFixture("spec349-sidebar", "sidebar-a");
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [fakeWorkspace(wsRoot, "ws-one", [])]);
    const view = fakeWebviewView();

    host.resolveWebviewView(view as unknown as vscode.WebviewView);
    await tick();

    expect(view.webview.html).toContain('data-shell-surface="tachyonPluginSurfaces"');
    expect(view.webview.html).not.toContain('role="tablist"');
    expect(view.webview.html).toContain("sidebar-a");
  });

  it("a sidebar tab message remounts the selected sibling, not the first", async () => {
    const wsRoot = await installMultiViewFixture({
      name: "widgets",
      views: [
        { id: "one", title: "Sidebar One", surface: "sidebar", entry: "ui/one.html" },
        { id: "two", title: "Sidebar Two", surface: "sidebar", entry: "ui/two.html" },
      ],
    });
    const host = new PluginSurfaceHost(vscode.Uri.file(ROOT), () => [fakeWorkspace(wsRoot, "ws-side", [])]);
    const view = fakeWebviewView();
    host.resolveWebviewView(view as unknown as vscode.WebviewView);
    await tick();
    const firstKey = /"key":"([^"]+:one)"/.exec(view.webview.html)?.[1];
    const secondKey = /"key":"([^"]+:two)"/.exec(view.webview.html)?.[1];
    expect(firstKey && secondKey).toBeTruthy();

    view.webview.__receive({ type: "selectPluginSidebarSurface", key: secondKey });
    await tick();
    expect(view.webview.html).toContain(`"key":"${secondKey}"`);
    expect(view.webview.html).toContain("Sidebar Two");
    expect(view.webview.html).toContain('"siblings"');
  });
});

async function installFixture(name: string, overrideSurface?: "sidebar-a" | "sidebar-b"): Promise<string> {
  const ws = tmp("tachyon-plugin-surface-host-");
  const fixture = overrideSurface ? makeSidebarFixture(overrideSurface) : path.join(ROOT, "test", "fixtures", "plugins", name);
  const loaded = loadPlugin(fixture);
  expect(loaded.errors).toEqual([]);
  const plugin = loaded.plugin!;
  const preview = previewInstall(plugin, ws, detectRuntimes(ws));
  expect(preview.errors).toEqual([]);
  const actionConfirmed: Record<string, true> = {};
  for (const view of preview.viewTargets) for (const action of view.actions) actionConfirmed[`${view.id}:${action}`] = true;
  const applied = await applyInstall(plugin, preview, ws, detectRuntimes(ws), { viewConfirmed: true, fleetReadConfirmed: true, actionConfirmed });
  expect(applied.errors).toEqual([]);
  expect(applied.installed).toBe(true);
  return ws;
}

function makeSidebarFixture(name: "sidebar-a" | "sidebar-b"): string {
  return makeViewFixture({
    name,
    views: [{ id: "side", title: name, surface: "sidebar", entry: "ui/index.html" }],
  });
}

async function installMultiViewFixture(opts: {
  name: string;
  views: Array<{ id: string; title: string; surface: "editor" | "sidebar"; entry: string }>;
}): Promise<string> {
  const ws = tmp("tachyon-plugin-surface-host-");
  const fixture = makeViewFixture(opts);
  const loaded = loadPlugin(fixture);
  expect(loaded.errors).toEqual([]);
  const plugin = loaded.plugin!;
  const preview = previewInstall(plugin, ws, detectRuntimes(ws));
  expect(preview.errors).toEqual([]);
  const actionConfirmed: Record<string, true> = {};
  for (const view of preview.viewTargets) for (const action of view.actions) actionConfirmed[`${view.id}:${action}`] = true;
  const applied = await applyInstall(plugin, preview, ws, detectRuntimes(ws), { viewConfirmed: true, fleetReadConfirmed: true, actionConfirmed });
  expect(applied.errors).toEqual([]);
  expect(applied.installed).toBe(true);
  return ws;
}

function makeViewFixture(opts: {
  name: string;
  views: Array<{ id: string; title: string; surface: "editor" | "sidebar"; entry: string }>;
}): string {
  const dir = tmp(`tachyon-plugin-surface-fixture-${opts.name}-`);
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tachyon-plugin.json"),
    JSON.stringify({
      name: opts.name,
      version: "1.0.0",
      description: `${opts.name} fixture`,
      views: opts.views.map((view) => ({ ...view, fleet: "summary", actions: ["focusAgent"] })),
    }),
  );
  for (const view of opts.views) {
    fs.writeFileSync(path.join(dir, view.entry), `<!doctype html><script>window.__ok = ${JSON.stringify(view.id)};</script>`);
  }
  return dir;
}

function fakeWorkspace(
  workspaceRoot: string,
  wsHash: string,
  entries: Array<{
    name: string;
    running: boolean;
    lifetime: "saved" | "temporary";
    attention?: "working" | "idle" | "needs-input" | "throttled";
  }>,
): WorkspacePluginPresentationTarget {
  return legacyPluginSurfaceTarget({
    workspaceRoot,
    wsHash,
    folderName: wsHash,
    bridge: { port: 0, url: undefined },
    manager: { list: async () => entries.map((entry) => ({ ...entry, kind: "agent" as const })) },
    attentionOf: (agent) => {
      const state = entries.find((entry) => entry.name === agent)?.attention;
      return state ? { state } : undefined;
    },
  });
}

function fakeWebviewView(): { webview: ReturnType<typeof fakeWebview>; onDidDispose(cb: () => void): { dispose(): void }; show(preserveFocus?: boolean): void } {
  return {
    webview: fakeWebview(),
    onDidDispose: () => ({ dispose() {} }),
    show: () => {},
  };
}

function fakeWebview(): {
  html: string;
  options: unknown;
  posted: unknown[];
  asWebviewUri(uri: vscode.Uri): vscode.Uri;
  postMessage(msg: unknown): Promise<boolean>;
  onDidReceiveMessage(cb: (msg: unknown) => void): { dispose(): void };
  __receive(msg: unknown): void;
} {
  const handlers: Array<(msg: unknown) => void> = [];
  return {
    html: "",
    options: undefined,
    posted: [],
    asWebviewUri: (uri) => uri,
    postMessage: async function (this: { posted: unknown[] }, msg: unknown) {
      this.posted.push(msg);
      return true;
    },
    onDidReceiveMessage(cb) {
      handlers.push(cb);
      return {
        dispose() {
          const index = handlers.indexOf(cb);
          if (index >= 0) handlers.splice(index, 1);
        },
      };
    },
    __receive(msg) {
      for (const cb of [...handlers]) cb(msg);
    },
  };
}

function isProjection(value: unknown): value is { type: "pluginFleetProjection"; projection: unknown } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "pluginFleetProjection";
}

function isActionResult(value: unknown): value is { type: "pluginUiActionResult"; id?: unknown; result: unknown } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "pluginUiActionResult";
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
