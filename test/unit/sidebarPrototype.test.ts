import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __createdPanels, __getClipboardText, __resetVscodeMock } from "../mocks/vscode.js";
import { pinDocPreview, SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { Pin } from "../../src/pins/PinStore.js";
import type { PinDetailRead } from "../../src/pins/PinStore.js";

function fakeWorkspace(pins: Pin[] = [], opts: { hash?: string; name?: string; root?: string; readDetail?: (id: string) => PinDetailRead } = {}): Workspace {
  return {
    wsHash: opts.hash ?? "agent0hash",
    folderName: opts.name ?? "Agent0",
    workspaceRoot: opts.root ?? "/workspace/Agent0",
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
    pinStore: {
      list: () => pins,
      setDone: () => {},
      readDetail: (id: string) => opts.readDetail?.(id) ?? {
        summary: pins.find((p) => p.id === id) ?? pins[0]!,
        detail: false,
        doc: null,
        attachments: [],
      },
    },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    listPipelines: () => [],
    pipelines: { allRuns: () => [] },
    probeService: { active: () => 0 }, // spec 257 — transient running-probe count
  } as unknown as Workspace;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeView(onHtmlSet?: (handlers: Array<(msg: unknown) => void>) => void): { view: vscode.WebviewView; posted: unknown[]; receive: (msg: unknown) => void } {
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
  return { view, posted, receive: (msg: unknown) => { for (const cb of handlers) cb(msg); } };
}

describe("SidebarPrototypeProvider", () => {
  beforeEach(() => __resetVscodeMock());

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

  it("repushes the live fleet whenever the webview asks ready again", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "ready" });
    await flushPromises();
    receive({ type: "ready" });
    await flushPromises();

    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet") as Array<{ fleets: Array<{ folder?: { hash?: string } }> }>;
    expect(fleetMsgs).toHaveLength(3);
    expect(fleetMsgs.every((m) => m.fleets[0]?.folder?.hash === "agent0hash")).toBe(true);
  });

  it("copies a pin's ID and title through the host clipboard", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [
      fakeWorkspace([{ id: "p-123abc", text: "Pin Studio rich pins", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" }]),
    ]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    receive({ type: "section", op: "pin:copy", id: "p-123abc", label: "stale title from webview" });
    await flushPromises();

    expect(__getClipboardText()).toBe("ID: p-123abc\nTitle: Pin Studio rich pins");
  });

  it("projects pin tags into the sidebar fleet view-model", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [
      fakeWorkspace([{ id: "p-123abc", text: "Tagged pin", done: false, by: "human", tags: ["docs", "ui"], createdAt: "2026-06-24T00:00:00.000Z" }]),
    ]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ pins: Array<{ tags: string[] }> }> } | undefined;
    expect(fleet?.fleets[0]?.pins[0]?.tags).toEqual(["docs", "ui"]);
  });

  it("opens a readonly editor webview preview from the targeted workspace", async () => {
    const targetPin = { id: "p-123abc", text: "Preview me", done: false, by: "human", tags: ["ui"], createdAt: "2026-06-24T00:00:00.000Z", detail: true, attachmentCount: 1 };
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [
      fakeWorkspace([{ id: "p-wrong1", text: "Wrong", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" }], { hash: "wronghash", name: "Wrong", root: "/workspace/Wrong" }),
      fakeWorkspace([targetPin], {
        hash: "righthash",
        name: "Right",
        root: "/workspace/Right",
        readDetail: () => ({
          summary: targetPin,
          detail: true,
          doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Readonly body" }] }] },
          attachments: [{
            id: "att-1",
            kind: "image",
            blobRef: "a".repeat(64),
            mediaType: "image/png",
            name: "screen.png",
            size: 2048,
            createdAt: "2026-06-24T00:00:00.000Z",
            source: "paste",
            visibility: "local",
            path: ".tachyon/pins/blobs/" + "a".repeat(64),
            available: true,
          }],
        }),
      }),
    ]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    receive({ type: "section", op: "pin:preview", id: "p-123abc", hash: "righthash" });
    await flushPromises();

    const panel = __createdPanels[0];
    expect(panel?.title).toBe("Pin Preview — p-123abc");
    expect(panel?.webview.options).toMatchObject({ enableScripts: false });
    expect(panel?.webview.html).toContain("Readonly body");
    expect(panel?.webview.html).toContain("screen.png");
    expect(panel?.webview.html).toContain("/workspace/Right/.tachyon/pins/blobs/");
    expect(panel?.webview.html).not.toContain("/workspace/Wrong/.tachyon/pins/blobs/");
  });

  it("extracts a readable preview from rich pin documents", () => {
    expect(pinDocPreview({
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }] }] },
      ],
    })).toBe("Title\n\nBody\n\n- Item");
  });
});
