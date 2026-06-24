import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

function fakeWorkspace(): Workspace {
  return {
    wsHash: "agent0hash",
    folderName: "Agent0",
    bridge: { port: 42462, url: "http://127.0.0.1:42462/mcp" },
    manager: { list: async () => [], defOf: () => undefined },
    ledger: { all: () => [], get: () => undefined },
    verifyInfo: async () => undefined,
    attentionOf: () => undefined,
    continuityBadge: () => undefined,
    commandRunner: { list: async () => [] },
    config: {},
    runbookRunner: { list: () => [] },
    handoffStore: { snapshot: () => ({ exists: false, staleness: "missing", pendingCount: 0 }) },
    lastActivityAt: () => null,
    pinStore: { list: () => [] },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    listPipelines: () => [],
    pipelines: { allRuns: () => [] },
  } as unknown as Workspace;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeView(onHtmlSet?: (handlers: Array<(msg: unknown) => void>) => void): { view: vscode.WebviewView; posted: unknown[] } {
  const handlers: Array<(msg: unknown) => void> = [];
  const posted: unknown[] = [];
  let htmlText = "";
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async (msg: unknown) => { posted.push(msg); return true; },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      handlers.push(cb);
      return { dispose() {} };
    },
    get html() {
      return htmlText;
    },
    set html(value: string) {
      htmlText = value;
      onHtmlSet?.(handlers);
    },
  };
  const view = {
    webview,
    onDidDispose: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView;
  return { view, posted };
}

describe("SidebarPrototypeProvider", () => {
  it("does not miss the first fleet when the webview posts ready during html assignment", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()]);
    const { view, posted } = fakeView((handlers) => {
      for (const cb of handlers) cb({ type: "ready" });
    });

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet") as Array<{ fleets: Array<{ folder?: { name?: string } }> }>;
    expect(fleetMsgs.length).toBeGreaterThan(0);
    expect(fleetMsgs[0].fleets[0]?.folder?.name).toBe("Agent0");
  });

  it("pushes an initial fleet even if the webview ready message is lost", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ folder?: { hash?: string } }> } | undefined;
    expect(fleet?.fleets[0]?.folder?.hash).toBe("agent0hash");
  });
});
