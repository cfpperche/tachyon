import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { RuntimeOpsViewProvider } from "../../src/webview/RuntimeOpsView.js";
import { RUNTIME_OPS_SNAPSHOT } from "../../src/webview/runtime-ops/messages.js";
import { RUNTIME_OPS_CONTAINER_COMMAND, RUNTIME_OPS_VIEW_FOCUS_COMMAND, openRuntimeOps } from "../../src/runtimeOps/openRuntimeOps.js";

afterEach(() => vi.restoreAllMocks());

describe("RuntimeOpsViewProvider (spec 367 Phase 1)", () => {
  it("uses the shared shell and publishes the empty typed snapshot on ready", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"));
    const view = fakeView(true);

    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.html).toContain("Content-Security-Policy");
    expect(view.webview.html).toContain("runtime-ops.js");
    expect(interval).not.toHaveBeenCalled();

    view.webview.receive({ type: "ready" });
    await tick();
    expect(view.webview.posted).toHaveLength(1);
    expect(view.webview.posted[0]).toMatchObject({
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: { schemaVersion: 1, summary: { runtimes: 0, managedAgents: 0 }, runtimes: [] },
    });
  });

  it("skips hidden refreshes, republishes on reveal, and stops after dispose", async () => {
    const buildSnapshot = vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-09T21:00:00.000Z",
      summary: { runtimes: 0, managedAgents: 0 },
      runtimes: [],
    }));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot);
    const view = fakeView(false);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);

    view.webview.receive({ type: "ready" });
    provider.refresh();
    await tick();
    expect(buildSnapshot).not.toHaveBeenCalled();

    view.setVisible(true);
    await tick();
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(view.webview.posted).toHaveLength(1);

    provider.refresh();
    await tick();
    expect(buildSnapshot).toHaveBeenCalledTimes(2);

    view.setVisible(false);
    provider.refresh();
    view.dispose();
    view.setVisible(true);
    await tick();
    expect(buildSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("Runtime Ops contribution and focus", () => {
  it("contributes one bottom-panel webview and its refresh action", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: {
        viewsContainers: { panel: Array<{ id: string }> };
        views: Record<string, Array<{ id: string; type: string }>>;
        menus: { "view/title": Array<{ command: string; when: string }> };
      };
    };
    expect(pkg.contributes.viewsContainers.panel).toContainEqual(expect.objectContaining({ id: "tachyonRuntimeOps" }));
    expect(pkg.contributes.views.tachyonRuntimeOps).toEqual([
      expect.objectContaining({ id: "tachyonRuntimeOpsView", type: "webview" }),
    ]);
    expect(pkg.contributes.menus["view/title"]).toContainEqual(expect.objectContaining({
      command: "tachyon.refreshRuntimeOps",
      when: "view == tachyonRuntimeOpsView",
    }));
  });

  it("opens the generated container command and falls back to the view focus command", async () => {
    const primary = vi.fn(async () => undefined);
    await openRuntimeOps(primary);
    expect(primary).toHaveBeenCalledWith(RUNTIME_OPS_CONTAINER_COMMAND);

    const fallback = vi.fn(async (command: string) => {
      if (command === RUNTIME_OPS_CONTAINER_COMMAND) throw new Error("command not found");
    });
    await openRuntimeOps(fallback);
    expect(fallback.mock.calls.map(([command]) => command)).toEqual([
      RUNTIME_OPS_CONTAINER_COMMAND,
      RUNTIME_OPS_VIEW_FOCUS_COMMAND,
    ]);
  });
});

function fakeView(initialVisible: boolean) {
  const visibilityHandlers: Array<() => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const messageHandlers: Array<(message: unknown) => void> = [];
  const webview = {
    cspSource: "vscode-webview:",
    html: "",
    options: undefined as unknown,
    posted: [] as unknown[],
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async (message: unknown) => { webview.posted.push(message); return true; },
    onDidReceiveMessage: (handler: (message: unknown) => void) => disposable(messageHandlers, handler),
    receive: (message: unknown) => { for (const handler of [...messageHandlers]) handler(message); },
  };
  return {
    visible: initialVisible,
    webview,
    onDidChangeVisibility: (handler: () => void) => disposable(visibilityHandlers, handler),
    onDidDispose: (handler: () => void) => disposable(disposeHandlers, handler),
    setVisible(visible: boolean) {
      this.visible = visible;
      for (const handler of [...visibilityHandlers]) handler();
    },
    dispose() { for (const handler of [...disposeHandlers]) handler(); },
  };
}

function disposable<T>(handlers: T[], handler: T): { dispose(): void } {
  handlers.push(handler);
  return { dispose: () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); } };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
