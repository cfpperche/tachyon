import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __createdPanels, __getClipboardText, __getExecutedCommands, __resetVscodeMock, __setWarningMessageResult } from "../mocks/vscode.js";
import { pinDocPreview, SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { Pin } from "../../src/pins/PinStore.js";
import type { PinDetailRead } from "../../src/pins/PinStore.js";

function fakeWorkspace(pins: Pin[] = [], opts: { hash?: string; name?: string; root?: string; readDetail?: (id: string) => PinDetailRead; calls?: string[] } = {}): Workspace {
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
      setDone: (id: string, done: boolean) => {
        const pin = pins.find((p) => p.id === id);
        if (!pin) throw new Error(`unknown pin '${id}'`);
        pin.done = done;
        return pin;
      },
      remove: (id: string) => {
        const idx = pins.findIndex((p) => p.id === id);
        if (idx >= 0) pins.splice(idx, 1);
      },
      readDetail: (id: string) => opts.readDetail?.(id) ?? {
        summary: pins.find((p) => p.id === id) ?? pins[0]!,
        detail: false,
        doc: null,
        attachments: [],
      },
    },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    toggleSchedulePause: (name: string) => { opts.calls?.push(`pause:${name}`); },
    deleteScheduleEntry: (name: string) => { opts.calls?.push(`delete-schedule:${name}`); },
    approveProposal: (id: string) => { opts.calls?.push(`approve:${id}`); return true; },
    rejectProposal: (id: string) => { opts.calls?.push(`reject:${id}`); },
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

  it("removes a deleted pin from the sidebar fleet immediately", async () => {
    const ws = fakeWorkspace([
      { id: "p-delete", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
      { id: "p-keep", text: "Keep me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:delete", id: "p-delete", hash: "agent0hash" });
    await flushPromises();
    await flushPromises();

    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet") as Array<{ fleets: Array<{ pins: Array<{ id: string; text: string }> }> }>;
    expect(fleetMsgs.at(-1)?.fleets[0]?.pins.map((p) => p.id)).toEqual(["p-keep"]);
  });

  it("does not route sidebar domain mutations through VS Code commands", async () => {
    const calls: string[] = [];
    const ws = fakeWorkspace([
      { id: "p-toggle", text: "Toggle me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
      { id: "p-delete", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ], { calls });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:toggle", id: "p-toggle", done: true, hash: "agent0hash" });
    receive({ type: "section", op: "pin:delete", id: "p-delete", hash: "agent0hash" });
    receive({ type: "section", op: "schedule:pause", id: "nightly", hash: "agent0hash" });
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "agent0hash" });
    receive({ type: "section", op: "proposal:approve", id: "proposal-1", hash: "agent0hash" });
    receive({ type: "section", op: "proposal:reject", id: "proposal-2", hash: "agent0hash" });
    await flushPromises();

    expect(__getExecutedCommands().map((c) => c.command)).toEqual([]);
    expect(ws.pinStore.list().map((p) => [p.id, p.done])).toEqual([["p-toggle", true]]);
    expect(calls).toEqual(["pause:nightly", "approve:proposal-1"]);
  });

  it("keeps destructive sidebar domain actions behind modal confirmation", async () => {
    const calls: string[] = [];
    const ws = fakeWorkspace([], { calls });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "agent0hash" });
    receive({ type: "section", op: "proposal:reject", id: "proposal-2", label: "Nightly", hash: "agent0hash" });
    await flushPromises();
    expect(calls).toEqual([]);

    __setWarningMessageResult("Delete");
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "agent0hash" });
    await flushPromises();
    __setWarningMessageResult("Reject");
    receive({ type: "section", op: "proposal:reject", id: "proposal-2", label: "Nightly", hash: "agent0hash" });
    await flushPromises();

    expect(calls).toEqual(["delete-schedule:nightly", "reject:proposal-2"]);
  });

  it("ignores stale workspace hashes for sidebar domain mutations", async () => {
    const ws = fakeWorkspace([
      { id: "p-delete", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:delete", id: "p-delete", hash: "stalehash" });
    await flushPromises();

    expect(ws.pinStore.list().map((p) => p.id)).toEqual(["p-delete"]);
    expect(__getExecutedCommands().map((c) => c.command)).toEqual([]);
    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet");
    expect(fleetMsgs).toHaveLength(1);
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
    // spec 279 — converted to a preact bundle: scripts ON (renders user text safely via preact escaping), and
    // the pin content travels as a posted VM on the webview's ready handshake, not baked into the shell HTML.
    expect(panel?.webview.options).toMatchObject({ enableScripts: true });
    const webview = panel!.webview as unknown as { __receive: (m: unknown) => void; posted: unknown[] };
    webview.__receive({ type: "ready" });
    const msg = webview.posted.find((m) => (m as { type?: string }).type === "pinPreview") as { vm: { body: string; attachments: Array<{ name: string; uri?: string }> } } | undefined;
    expect(msg?.vm.body).toContain("Readonly body");
    const img = msg?.vm.attachments.find((a) => a.name === "screen.png");
    expect(img?.uri).toContain("/workspace/Right/.tachyon/pins/blobs/");
    expect(JSON.stringify(msg?.vm)).not.toContain("/workspace/Wrong/.tachyon/pins/blobs/");
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
