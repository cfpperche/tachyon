import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { RuntimeOpsViewProvider } from "../../src/webview/RuntimeOpsView.js";
import {
  RUNTIME_OPS_SNAPSHOT,
  runtimeOpsSetProviderObservationAction,
} from "../../src/webview/runtime-ops/messages.js";
import type { RuntimeOpsSnapshotV1 } from "../../src/runtimeOps/types.js";
import { RUNTIME_OPS_CONTAINER_COMMAND, RUNTIME_OPS_VIEW_FOCUS_COMMAND, openRuntimeOps } from "../../src/runtimeOps/openRuntimeOps.js";
import { registerWorkspaceMembershipRefresh } from "../../src/extension.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RuntimeOpsViewProvider (spec 367 Phase 1)", () => {
  it("uses the shared shell and publishes the empty typed snapshot on ready", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"));
    const view = fakeView(true);

    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.options).toMatchObject({ enableCommandUris: ["tachyon.refreshRuntimeOps"] });
    expect(view.webview.html).toContain("Content-Security-Policy");
    expect(view.webview.html).toContain("runtime-ops.js");
    expect(interval).not.toHaveBeenCalled();

    view.webview.receive({ type: "ready" });
    await tick();
    expect(view.webview.posted).toHaveLength(1);
    expect(view.webview.posted[0]).toMatchObject({
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: { schemaVersion: 2, summary: { runtimes: 0, managedAgents: 0 }, runtimes: [] },
    });
  });

  it("skips hidden refreshes, republishes on reveal, and stops after dispose", async () => {
    const buildSnapshot = vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-09T21:00:00.000Z",
      summary: { runtimes: 0, managedAgents: 0 },
      runtimes: [],
    }));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
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

  it("coalesces a visible refresh burst without polling", async () => {
    vi.useFakeTimers();
    const buildSnapshot = vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-09T21:00:00.000Z",
      summary: { runtimes: 0, managedAgents: 0 },
      runtimes: [],
    }));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 50);
    const view = fakeView(true);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    provider.refresh();
    provider.refresh();
    provider.refresh();
    expect(buildSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("publishes a fixed error state after a rejected builder and recovers on retry", async () => {
    const rawError = new Error("token=secret path=/private/source-payload.json");
    const buildSnapshot = vi.fn()
      .mockRejectedValueOnce(rawError)
      .mockReturnValueOnce({
        schemaVersion: 1 as const,
        generatedAt: "2026-07-09T21:00:00.000Z",
        summary: { runtimes: 1, managedAgents: 0 },
        runtimes: [],
      });
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const view = fakeView(true);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);

    view.webview.receive({ type: "ready" });
    await tick();
    expect(view.webview.posted).toEqual([{
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: expect.objectContaining({ error: { code: "snapshot-unavailable" } }),
    }]);
    expect(JSON.stringify(view.webview.posted)).not.toContain(rawError.message);

    provider.refresh();
    await tick();
    expect(view.webview.posted[1]).toMatchObject({
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: { summary: { runtimes: 1, managedAgents: 0 }, runtimes: [] },
    });
    expect((view.webview.posted[1] as { snapshot: { error?: unknown } }).snapshot.error).toBeUndefined();
  });

  it("absorbs rejected delivery and does not post after disposal", async () => {
    const buildSnapshot = vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-09T21:00:00.000Z",
      summary: { runtimes: 0, managedAgents: 0 },
      runtimes: [],
    }));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const view = fakeView(true);
    view.webview.rejectNextPost(new Error("webview disposed"));
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);

    view.webview.receive({ type: "ready" });
    await tick();
    expect(view.webview.posted).toHaveLength(0);

    provider.refresh();
    await tick();
    expect(view.webview.posted).toHaveLength(1);

    let resolveSnapshot!: (snapshot: ReturnType<typeof buildSnapshot>) => void;
    const deferredProvider = new RuntimeOpsViewProvider(
      vscode.Uri.file("/extension"),
      () => new Promise((resolve) => { resolveSnapshot = resolve; }),
      0,
    );
    const deferredView = fakeView(true);
    deferredProvider.resolveWebviewView(deferredView as unknown as vscode.WebviewView);
    deferredView.webview.receive({ type: "ready" });
    deferredView.dispose();
    resolveSnapshot(buildSnapshot());
    await tick();
    expect(deferredView.webview.posted).toHaveLength(0);
  });

  it("retains an undelivered fixed error state for the next resolved view", async () => {
    const buildSnapshot = vi.fn().mockRejectedValue(new Error("token=secret path=/private/source-payload.json"));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const firstView = fakeView(true);
    firstView.webview.rejectNextPost(new Error("webview disposed"));
    provider.resolveWebviewView(firstView as unknown as vscode.WebviewView);

    firstView.webview.receive({ type: "ready" });
    await tick();
    expect(firstView.webview.posted).toHaveLength(0);
    firstView.dispose();

    const nextView = fakeView(true);
    provider.resolveWebviewView(nextView as unknown as vscode.WebviewView);
    nextView.webview.receive({ type: "ready" });
    await tick();
    expect(nextView.webview.posted).toEqual([{
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: expect.objectContaining({ error: { code: "snapshot-unavailable" } }),
    }]);
    expect(buildSnapshot).toHaveBeenCalledOnce();
  });

  it("ignores an older failed build that settles after a newer success", async () => {
    const olderBuild = deferred<RuntimeOpsSnapshotV1>();
    const newerBuild = deferred<RuntimeOpsSnapshotV1>();
    const buildSnapshot = vi.fn()
      .mockReturnValueOnce(olderBuild.promise)
      .mockReturnValueOnce(newerBuild.promise)
      .mockReturnValueOnce(snapshot(2));
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const view = fakeView(true);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);

    view.webview.receive({ type: "ready" });
    provider.refresh();
    await tick();
    expect(buildSnapshot).toHaveBeenCalledTimes(2);

    newerBuild.resolve(snapshot(1));
    await tick();
    expect(view.webview.posted).toEqual([runtimeOpsMessage(1)]);

    olderBuild.reject(new Error("token=secret path=/private/source-payload.json"));
    await tick();
    expect(view.webview.posted).toEqual([runtimeOpsMessage(1)]);

    view.dispose();
    const nextView = fakeView(true);
    provider.resolveWebviewView(nextView as unknown as vscode.WebviewView);
    nextView.webview.receive({ type: "ready" });
    await tick();

    expect(buildSnapshot).toHaveBeenCalledTimes(3);
    expect(nextView.webview.posted).toEqual([runtimeOpsMessage(2)]);
  });

  it("retains a failed snapshot when postMessage resolves false", async () => {
    const failedBuild = deferred<RuntimeOpsSnapshotV1>();
    const falseDelivery = deferred<boolean>();
    const buildSnapshot = vi.fn(() => failedBuild.promise);
    const provider = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const firstView = fakeView(true);
    firstView.webview.resolveNextPost(falseDelivery.promise);
    provider.resolveWebviewView(firstView as unknown as vscode.WebviewView);

    firstView.webview.receive({ type: "ready" });
    failedBuild.reject(new Error("token=secret path=/private/source-payload.json"));
    await tick();
    expect(firstView.webview.posted).toHaveLength(0);

    falseDelivery.resolve(false);
    await tick();
    expect(firstView.webview.posted).toHaveLength(0);

    firstView.dispose();
    const nextView = fakeView(true);
    provider.resolveWebviewView(nextView as unknown as vscode.WebviewView);
    nextView.webview.receive({ type: "ready" });
    await tick();

    expect(buildSnapshot).toHaveBeenCalledOnce();
    expect(nextView.webview.posted).toEqual([{
      type: RUNTIME_OPS_SNAPSHOT,
      snapshot: expect.objectContaining({ error: { code: "snapshot-unavailable" } }),
    }]);
  });

  it("accepts only closed provider enable/disable actions and republishes committed state", async () => {
    const buildSnapshot = vi.fn(() => snapshot(0));
    const configureProvider = vi.fn(async () => undefined);
    const provider = new RuntimeOpsViewProvider(
      vscode.Uri.file("/extension"),
      buildSnapshot,
      0,
      configureProvider,
    );
    const view = fakeView(true);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);

    view.webview.receive(runtimeOpsSetProviderObservationAction("codex", true));
    await tick();
    view.webview.receive(runtimeOpsSetProviderObservationAction("codex", false));
    await tick();

    expect(configureProvider.mock.calls).toEqual([["codex", true], ["codex", false]]);
    expect(buildSnapshot).toHaveBeenCalledTimes(2);
    expect(view.webview.posted).toHaveLength(2);

    for (const invalid of [
      { type: "runtimeOpsSetProviderObservation", provider: "grok", enabled: true },
      { type: "runtimeOpsSetProviderObservation", provider: "codex", enabled: "yes" },
      { type: "runtimeOpsSetProviderObservation", provider: "codex", enabled: true, source: "oauth" },
      { type: "runtimeOpsSetProviderObservation", provider: "codex" },
    ]) view.webview.receive(invalid);
    await tick();
    expect(configureProvider).toHaveBeenCalledTimes(2);
  });

  it("keeps raw provider configuration failures outside webview messages", async () => {
    const raw = "token=RAW_PROVIDER_TOKEN path=/private/provider.json";
    const provider = new RuntimeOpsViewProvider(
      vscode.Uri.file("/extension"),
      () => snapshot(0),
      0,
      async () => { throw new Error(raw); },
    );
    const view = fakeView(true);
    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    view.webview.receive(runtimeOpsSetProviderObservationAction("claude", true));
    await tick();

    expect(view.webview.posted).toHaveLength(1);
    expect(JSON.stringify(view.webview.posted)).not.toContain(raw);
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
    expect(readFileSync("src/extension.ts", "utf8")).not.toContain("_showRuntimeUsageQuickPick");
  });

  it("keeps the Runtime Ops UI Tachyon-owned with no CodexBar UI, Swift, or asset imports", () => {
    const files = [
      "src/webview/RuntimeOpsView.ts",
      "src/webview/runtime-ops/App.tsx",
      "src/webview/runtime-ops/main.tsx",
      "src/webview/runtime-ops/messages.ts",
      "src/webview/runtime-ops/runtime-ops.css",
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/codexbar|\.swift\b|Sources\/CodexBar|CodexBar\.app/iu);
  });

  it("refreshes visible Runtime Ops after live workspace membership changes", async () => {
    const buildSnapshot = vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-09T21:00:00.000Z",
      summary: { runtimes: 1, managedAgents: 0 },
      runtimes: [],
    }));
    const runtimeOps = new RuntimeOpsViewProvider(vscode.Uri.file("/extension"), buildSnapshot, 0);
    const view = fakeView(true);
    runtimeOps.resolveWebviewView(view as unknown as vscode.WebviewView);

    const removedWorkspace = { close: vi.fn(async () => {}) };
    const registry = new Map<string, typeof removedWorkspace>([["/removed", removedWorkspace]]);
    const listeners: Array<(event: vscode.WorkspaceFoldersChangeEvent) => void> = [];
    const addWorkspace = vi.fn(async (folderPath: string) => {
      const workspace = { close: vi.fn(async () => {}) };
      registry.set(folderPath, workspace);
      return workspace;
    });
    const refreshAll = vi.fn(() => {
      expect([...registry.keys()]).toEqual(["/added"]);
      runtimeOps.refresh();
    });

    registerWorkspaceMembershipRefresh(
      (listener) => {
        listeners.push(listener);
        return { dispose: () => {} };
      },
      {
        registry,
        detachWorkspace: (workspace) => workspace.close(),
        hasConfig: (folderPath) => folderPath === "/added",
        currentWorktreesBase: () => "/worktrees",
        addWorkspace,
        refreshAll,
        reportError: vi.fn(),
      },
    );

    const listenerResult = listeners[0]({
      removed: [{ uri: vscode.Uri.file("/removed"), name: "removed", index: 0 }],
      added: [{ uri: vscode.Uri.file("/added"), name: "added", index: 0 }],
    } as vscode.WorkspaceFoldersChangeEvent);
    await tick();
    await tick();

    expect(listenerResult).toBeUndefined();
    expect(removedWorkspace.close).toHaveBeenCalledOnce();
    expect(addWorkspace).toHaveBeenCalledWith("/added", true, false);
    expect(refreshAll).toHaveBeenCalledOnce();
    expect(buildSnapshot).toHaveBeenCalledOnce();
    expect(view.webview.posted).toHaveLength(1);
  });

  it("reports a rejected dispose after removing the workspace and refreshes once", async () => {
    const error = new Error("dispose failed");
    const registry = new Map<string, { dispose(): Promise<void> }>();
    const order: string[] = [];
    registry.set("/removed", {
      dispose: vi.fn(async () => {
        order.push(`dispose:${registry.has("/removed")}`);
        throw error;
      }),
    });
    const listeners: Array<(event: vscode.WorkspaceFoldersChangeEvent) => void> = [];
    const refreshAll = vi.fn(() => order.push(`refresh:${[...registry.keys()].join(",")}`));
    const reportError = vi.fn((reported: unknown) => order.push(`error:${reported === error}`));

    registerWorkspaceMembershipRefresh(
      (listener) => {
        listeners.push(listener);
        return { dispose: () => {} };
      },
      {
        registry,
        detachWorkspace: (workspace) => workspace.dispose(),
        hasConfig: () => false,
        currentWorktreesBase: () => "/worktrees",
        addWorkspace: vi.fn(),
        refreshAll,
        reportError,
      },
    );

    const listenerResult = listeners[0]({
      removed: [{ uri: vscode.Uri.file("/removed"), name: "removed", index: 0 }],
      added: [],
    } as vscode.WorkspaceFoldersChangeEvent);
    await tick();

    expect(listenerResult).toBeUndefined();
    expect(order).toEqual(["dispose:false", "error:true", "refresh:"]);
    expect(reportError).toHaveBeenCalledWith(error);
    expect(refreshAll).toHaveBeenCalledOnce();
  });

  it("continues adding folders after a rejected removal and refreshes once", async () => {
    const disposeError = new Error("dispose failed");
    const registry = new Map<string, { dispose(): Promise<void> }>();
    const order: string[] = [];
    registry.set("/removed", {
      dispose: vi.fn(async () => {
        order.push(`dispose:${registry.has("/removed")}`);
        throw disposeError;
      }),
    });
    const listeners: Array<(event: vscode.WorkspaceFoldersChangeEvent) => void> = [];
    const refreshAll = vi.fn(() => order.push(`refresh:${[...registry.keys()].join(",")}`));
    const reportError = vi.fn((reported: unknown) => order.push(`error:${reported === disposeError}`));
    const addWorkspace = vi.fn(async (folderPath: string) => {
      registry.set(folderPath, { dispose: vi.fn(async () => {}) });
      order.push(`add:${[...registry.keys()].join(",")}`);
      return registry.get(folderPath)!;
    });

    registerWorkspaceMembershipRefresh(
      (listener) => {
        listeners.push(listener);
        return { dispose: () => {} };
      },
      {
        registry,
        detachWorkspace: (workspace) => workspace.dispose(),
        hasConfig: (folderPath) => folderPath === "/added",
        currentWorktreesBase: () => "/worktrees",
        addWorkspace,
        refreshAll,
        reportError,
      },
    );

    listeners[0]({
      removed: [{ uri: vscode.Uri.file("/removed"), name: "removed", index: 0 }],
      added: [{ uri: vscode.Uri.file("/added"), name: "added", index: 0 }],
    } as vscode.WorkspaceFoldersChangeEvent);
    await tick();

    expect(order).toEqual(["dispose:false", "error:true", "add:/added", "refresh:/added"]);
    expect(reportError).toHaveBeenCalledWith(disposeError);
    expect(addWorkspace).toHaveBeenCalledWith("/added", true, false);
    expect(refreshAll).toHaveBeenCalledOnce();
  });

  it("continues adding after a rejected add and refreshes once", async () => {
    const error = new Error("start failed");
    const registry = new Map<string, { dispose(): Promise<void> }>();
    const order: string[] = [];
    const listeners: Array<(event: vscode.WorkspaceFoldersChangeEvent) => void> = [];
    const refreshAll = vi.fn(() => order.push(`refresh:${[...registry.keys()].join(",")}`));
    const reportError = vi.fn((reported: unknown) => order.push(`error:${reported === error}`));
    const addWorkspace = vi.fn(async (folderPath: string) => {
      registry.set(folderPath, { dispose: vi.fn(async () => {}) });
      order.push(`add:${[...registry.keys()].join(",")}`);
      if (folderPath === "/failed") throw error;
      return registry.get(folderPath)!;
    });

    registerWorkspaceMembershipRefresh(
      (listener) => {
        listeners.push(listener);
        return { dispose: () => {} };
      },
      {
        registry,
        detachWorkspace: (workspace) => workspace.dispose(),
        hasConfig: (folderPath) => folderPath === "/failed" || folderPath === "/added",
        currentWorktreesBase: () => "/worktrees",
        addWorkspace,
        refreshAll,
        reportError,
      },
    );

    const listenerResult = listeners[0]({
      removed: [],
      added: [
        { uri: vscode.Uri.file("/failed"), name: "failed", index: 0 },
        { uri: vscode.Uri.file("/added"), name: "added", index: 1 },
      ],
    } as vscode.WorkspaceFoldersChangeEvent);
    await tick();

    expect(listenerResult).toBeUndefined();
    expect(addWorkspace).toHaveBeenNthCalledWith(1, "/failed", true, false);
    expect(addWorkspace).toHaveBeenNthCalledWith(2, "/added", true, false);
    expect(order).toEqual(["add:/failed", "error:true", "add:/failed,/added", "refresh:/failed,/added"]);
    expect(reportError).toHaveBeenCalledWith(error);
    expect(refreshAll).toHaveBeenCalledOnce();
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
    rejectPost: undefined as Error | undefined,
    postResults: [] as Array<boolean | Promise<boolean>>,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async (message: unknown) => {
      const error = webview.rejectPost;
      webview.rejectPost = undefined;
      if (error) throw error;
      const delivered = await (webview.postResults.shift() ?? true);
      if (delivered) webview.posted.push(message);
      return delivered;
    },
    onDidReceiveMessage: (handler: (message: unknown) => void) => disposable(messageHandlers, handler),
    receive: (message: unknown) => { for (const handler of [...messageHandlers]) handler(message); },
    rejectNextPost: (error: Error) => { webview.rejectPost = error; },
    resolveNextPost: (result: boolean | Promise<boolean>) => { webview.postResults.push(result); },
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

function snapshot(runtimes: number): RuntimeOpsSnapshotV1 {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-09T21:00:00.000Z",
    summary: { runtimes, managedAgents: 0 },
    runtimes: [],
  };
}

function runtimeOpsMessage(runtimes: number): { type: typeof RUNTIME_OPS_SNAPSHOT; snapshot: RuntimeOpsSnapshotV1 } {
  return { type: RUNTIME_OPS_SNAPSHOT, snapshot: snapshot(runtimes) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
