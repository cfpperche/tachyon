import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { __createdPanels, __getClipboardText, __getExecutedCommands, __getWarningMessageCalls, __resetVscodeMock, __setWarningMessageResult } from "../mocks/vscode.js";
import { pinDocPreview, SidebarPrototypeProvider } from "../../apps/vscode-extension/src/webview/SidebarPrototype.js";
import { initializeVsCodeNotifications } from "../../apps/vscode-extension/src/workspace/notify.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { Pin } from "@tachyon/engine/pins/PinStore.js";
import type { PinDetailRead } from "@tachyon/engine/pins/PinStore.js";
import type { AgentInfo } from "@tachyon/engine/agents/AgentManager.js";
import { legacySidebarTarget, type LegacySidebarSource, type WorkspaceSidebarTarget } from "../../apps/vscode-extension/src/shell/SidebarTarget.js";
import type { ObservedModelInput } from "@tachyon/engine/sidebar/agentModel.js";
import { SAMPLE, type FleetVM, type NoticeVM } from "@tachyon/shared/sidebar/types.js";
import type { SidebarFleetV1 } from "@tachyon/engine/runtime-api/sidebarProjection.js";
import type { ScheduleProposal } from "@tachyon/engine/schedule/ProposalStore.js";

const temporaryRoots: string[] = [];

function fakeWorkspace(pins: Pin[] = [], opts: {
  hash?: string;
  name?: string;
  root?: string;
  readDetail?: (id: string) => PinDetailRead;
  calls?: string[];
  agents?: AgentInfo[];
  attentionOf?: (agent: string) => { state: string } | undefined;
  continuityBadge?: (agent: string) => "fresh" | "stale" | "missing" | undefined;
  observedModel?: (agent: string) => ObservedModelInput | undefined;
  proposals?: ScheduleProposal[];
  notices?: NoticeVM[];
} = {}): Workspace & WorkspaceSidebarTarget {
  const source = {
    wsHash: opts.hash ?? "demohash",
    folderName: opts.name ?? "Demo",
    workspaceRoot: opts.root ?? "/workspace/Demo",
    bridge: { port: 42462, url: "http://127.0.0.1:42462/mcp" },
    manager: {
      list: async () => opts.agents ?? [],
      listAgents: async () => (opts.agents ?? []).filter((entry) => entry.kind === "agent"),
      listTerminals: async () => (opts.agents ?? []).filter((entry) => entry.kind === "terminal"),
      defOf: () => undefined,
      resumeReadiness: async () => true,
      session: (agent: string) => `tachyon-${opts.hash ?? "demohash"}-${agent}`,
    },
    ledger: { all: () => [], get: () => undefined },
    tmux: { panePid: async () => { throw new Error("no fake pane"); } },
    evidenceHandoff: async () => undefined,
    attentionOf: opts.attentionOf ?? (() => undefined),
    continuityBadge: opts.continuityBadge ?? (() => undefined),
    persistenceHookHealth: () => undefined,
    commandRunner: { list: async () => [] },
    config: {},
    runbookRunner: { list: () => [] },
    handoffStore: { snapshot: () => ({ exists: false, staleness: "fresh", pendingCount: 0 }) },
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
    proposals: { list: () => opts.proposals ?? [] },
    listNoticeInbox: () => opts.notices ?? [],
    scheduler: { list: () => [] },
    toggleSchedulePause: (name: string) => { opts.calls?.push(`pause:${name}`); },
    deleteScheduleEntry: (name: string) => { opts.calls?.push(`delete-schedule:${name}`); },
    approveProposal: (id: string) => { opts.calls?.push(`approve:${id}`); return true; },
    rejectProposal: (id: string) => { opts.calls?.push(`reject:${id}`); },
    listPipelines: () => [],
    pipelines: { allRuns: () => [] },
    configFailure: undefined,
    readConfigLkg: () => null,
    probeService: { active: () => 0 }, // spec 257 — transient running-probe count
  } as unknown as Workspace;
  return Object.assign(
    source,
    legacySidebarTarget(source as unknown as LegacySidebarSource, opts.observedModel),
  );
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function fakeMemento(seed: Record<string, unknown> = {}): vscode.Memento {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { data.set(key, value); },
    keys: () => [...data.keys()],
  } as vscode.Memento;
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
  beforeEach(() => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("does not miss the first fleet when the webview posts ready during html assignment", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()]);
    const { view, posted } = fakeView((handlers) => {
      for (const cb of handlers) cb({ type: "ready" });
    });

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet") as Array<{ fleets: Array<{ folder?: { name?: string } }> }>;
    expect(fleetMsgs.length).toBeGreaterThan(0);
    expect(fleetMsgs[0].fleets[0]?.folder?.name).toBe("Demo");
  });

  it("never puts a badge on the Activity Bar icon, however many attentions are open", async () => {
    const notices: NoticeVM[] = Array.from({ length: 7 }, (_, index) => ({
      id: `notice-${index}`,
      message: `Attention ${index}`,
      level: "info",
      at: new Date(2026, 6, 19, 20, index).toISOString(),
      collapsedCount: 1,
      actions: [],
      read: false,
      actionsLive: false,
    }));
    const target = {
      wsHash: "demohash",
      loadSidebar: async () => ({ ...SAMPLE, folder: { hash: "demohash", name: "Demo" }, notices }),
    } as unknown as WorkspaceSidebarTarget;
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [target]);
    const { view } = fakeView();
    provider.resolveWebviewView(view);
    await flushPromises();
    // Seven unread attentions, and the workbench icon stays clean. Removed by the maintainer's
    // decision on 2026-08-05: a count on the Activity Bar is a permanent interruption for something
    // that is not urgent. The number itself is not lost — the sidebar's Attentions tab still shows
    // it, on a surface the human opens on purpose.
    expect(view.badge).toBeUndefined();
  });

  it("pushes an initial fleet even if the webview ready message is lost", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ folder?: { hash?: string } }> } | undefined;
    expect(fleet?.fleets[0]?.folder?.hash).toBe("demohash");
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
    expect(fleetMsgs.every((m) => m.fleets[0]?.folder?.hash === "demohash")).toBe(true);
  });

  it("does not let an older asynchronous projection overwrite a newer Sidebar view", async () => {
    const ws = fakeWorkspace();
    const base = await ws.loadSidebar();
    const older = deferred<SidebarFleetV1>();
    const newer = deferred<SidebarFleetV1>();
    let reads = 0;
    ws.loadSidebar = () => (++reads === 1 ? older.promise : newer.promise);
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    receive({ type: "ready" });
    newer.resolve({ ...base, folder: { ...base.folder!, name: "newer" } });
    await flushPromises();
    older.resolve({ ...base, folder: { ...base.folder!, name: "older" } });
    await flushPromises();

    const fleetMsgs = posted.filter((message) => (message as { type?: string }).type === "fleet") as Array<{ fleets: FleetVM[] }>;
    expect(fleetMsgs).toHaveLength(1);
    expect(fleetMsgs[0]?.fleets[0]?.folder?.name).toBe("newer");
  });

  it("persists sidebar collapse keys through the host memento", async () => {
    const memento = fakeMemento({ "tachyon.sidebar.collapsed": ["demohash:a:parent"] });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [fakeWorkspace()], memento);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const initial = posted.find((m) => (m as { type?: string }).type === "fleet") as { collapsedKeys?: string[] } | undefined;
    expect(initial?.collapsedKeys).toEqual(["demohash:a:parent"]);

    receive({ type: "setCollapsed", keys: ["demohash:a:parent", "otherhash:folder", 42, "demohash:a:parent"] });
    await flushPromises();

    const latest = posted.filter((m) => (m as { type?: string }).type === "fleet").at(-1) as { collapsedKeys?: string[] } | undefined;
    expect(latest?.collapsedKeys).toEqual(["demohash:a:parent", "otherhash:folder"]);
    expect(memento.get<string[]>("tachyon.sidebar.collapsed")).toEqual(["demohash:a:parent", "otherhash:folder"]);
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

  it("copies only a pin ID from the sidebar metadata affordance", async () => {
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [
      fakeWorkspace([{ id: "p-123abc", text: "Pin Studio rich pins", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" }]),
    ]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    receive({ type: "section", op: "pin:copyId", id: "p-123abc" });
    await flushPromises();

    expect(__getClipboardText()).toBe("p-123abc");
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
      { id: "p-de1e7e", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
      { id: "p-0ee001", text: "Keep me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:delete", id: "p-de1e7e", hash: "demohash" });
    await flushPromises();
    await flushPromises();

    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet") as Array<{ fleets: Array<{ pins: Array<{ id: string; text: string }> }> }>;
    expect(fleetMsgs.at(-1)?.fleets[0]?.pins.map((p) => p.id)).toEqual(["p-0ee001"]);
  });

  it("does not route sidebar domain mutations through VS Code commands", async () => {
    const calls: string[] = [];
    const ws = fakeWorkspace([
      { id: "p-700001", text: "Toggle me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
      { id: "p-de1e7e", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ], { calls });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:toggle", id: "p-700001", done: true, hash: "demohash" });
    receive({ type: "section", op: "pin:delete", id: "p-de1e7e", hash: "demohash" });
    receive({ type: "section", op: "schedule:pause", id: "nightly", hash: "demohash" });
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "demohash" });
    receive({ type: "section", op: "proposal:approve", id: "abcdef123456", hash: "demohash" });
    receive({ type: "section", op: "proposal:reject", id: "abcdef123457", hash: "demohash" });
    await flushPromises();

    expect(__getExecutedCommands().map((c) => c.command)).toEqual([]);
    expect(ws.pinStore.list().map((p) => [p.id, p.done])).toEqual([["p-700001", true]]);
    expect(calls).toEqual(["pause:nightly", "approve:abcdef123456"]);
  });

  it("keeps destructive sidebar domain actions behind modal confirmation", async () => {
    const calls: string[] = [];
    const ws = fakeWorkspace([], {
      calls,
      proposals: [{
        id: "abcdef123457",
        name: "actual-nightly",
        by: "codex",
        createdAt: "2026-07-14T00:00:00.000Z",
        expiresAt: "2026-07-15T00:00:00.000Z",
        schedule: { every: "1h", run: "test" },
      }],
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "demohash" });
    receive({ type: "section", op: "proposal:reject", id: "abcdef123457", label: "Nightly", hash: "demohash" });
    await flushPromises();
    expect(calls).toEqual([]);
    expect(__getWarningMessageCalls()).toEqual([
      { message: "Tachyon: Delete schedule 'nightly' from tachyon.yml?", options: { modal: true }, actions: ["Delete"] },
      { message: "Tachyon: Reject the proposed schedule 'abcdef123457'?", options: { modal: true }, actions: ["Reject"] },
    ]);

    __setWarningMessageResult("Delete");
    receive({ type: "section", op: "schedule:delete", id: "nightly", hash: "demohash" });
    await flushPromises();
    __setWarningMessageResult("Reject");
    receive({ type: "section", op: "proposal:reject", id: "abcdef123457", label: "Nightly", hash: "demohash" });
    await flushPromises();

    expect(calls).toEqual(["delete-schedule:nightly", "reject:abcdef123457"]);
  });

  it("ignores stale workspace hashes for sidebar domain mutations", async () => {
    const ws = fakeWorkspace([
      { id: "p-de1e7e", text: "Delete me", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" },
    ]);
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "section", op: "pin:delete", id: "p-de1e7e", hash: "stalehash" });
    await flushPromises();

    expect(ws.pinStore.list().map((p) => p.id)).toEqual(["p-de1e7e"]);
    expect(__getExecutedCommands().map((c) => c.command)).toEqual([]);
    const fleetMsgs = posted.filter((m) => (m as { type?: string }).type === "fleet");
    expect(fleetMsgs).toHaveLength(1);
  });

  it("spec 378: gathers the observed model via the injected accessor and surfaces provenance on the row", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "worker", session: "tachyon-demohash-worker", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" }],
      observedModel: () => ({
        id: "gpt-5.6-sol", observedAt: "2026-07-13T00:00:00Z", stale: false,
      }),
    });
    (ws.manager as { defOf: (name: string) => { cmd: string } | undefined }).defOf = () => ({ cmd: "codex" });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ agents: Array<{ name: string; model?: string; modelSource?: string; modelDivergence?: boolean }> }> };
    const agent = fleet.fleets[0].agents.find((a) => a.name === "worker");
    expect(agent).toMatchObject({ model: "GPT-5.6 Sol", modelSource: "observed", modelDivergence: true });
  });

  it("spec 378: with no observation yet, the row shows the declared/profile label (never a fake observed)", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "worker", session: "tachyon-demohash-worker", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" }],
    });
    (ws.manager as { defOf: (name: string) => { cmd: string } | undefined }).defOf = () => ({ cmd: "codex" });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ agents: Array<{ name: string; model?: string; modelSource?: string }> }> };
    const agent = fleet.fleets[0].agents.find((a) => a.name === "worker");
    expect(agent).toMatchObject({ model: "Codex default", modelSource: "profile" });
  });

  it("routes sidebar graceful stop actions through the stop command with the target workspace", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "claude", session: "tachyon-demohash-claude", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" }],
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "action", id: "stop", agent: "claude", hash: "demohash" });
    await flushPromises();

    const cmd = __getExecutedCommands().at(-1);
    expect(cmd?.command).toBe("tachyon.stopAgentItem");
    expect(cmd?.args[0]).toMatchObject({ ws, agentName: "claude", contextValue: "agent-running-ai" });
  });

  it("routes the unified Remove action through the destructive agent-removal command", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "scratch", session: "tachyon-demohash-scratch", running: true, lifetime: "temporary", resumePolicy: "collected", dead: false, crashed: false, kind: "agent" }],
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "action", id: "remove", agent: "scratch", hash: "demohash" });
    await flushPromises();

    const cmd = __getExecutedCommands().at(-1);
    expect(cmd?.command).toBe("tachyon.deleteAgentItem");
    expect(cmd?.args[0]).toMatchObject({ ws, agentName: "scratch", contextValue: "agent-running-ai-temporary" });
  });

  it("does not show continuity badges for Temporary agents without Tachyon lifecycle hooks", async () => {
    const ws = fakeWorkspace([], {
      agents: [
        // A RUNNING agent always has a ledger row, so the fixture carries the policy the row would:
        // `continuity` asks the recorded CAPABILITY, which is the whole point of the separate field.
        { name: "declared", session: "tachyon-demohash-declared", running: true, lifetime: "saved", resumePolicy: "restartable", instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true }, dead: false, crashed: false, kind: "agent" },
        { name: "reviewer", session: "tachyon-demohash-reviewer", running: true, lifetime: "temporary", resumePolicy: "collected", instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false }, dead: false, crashed: false, kind: "agent", parent: "declared" },
      ],
      continuityBadge: () => "missing",
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ agents: Array<{ name: string; continuity?: string }> }> } | undefined;
    const agents = fleet?.fleets[0]?.agents ?? [];
    expect(agents.find((a) => a.name === "declared")?.continuity).toBe("missing");
    expect(agents.find((a) => a.name === "reviewer")?.continuity).toBeUndefined();
  });

  it("does not attach stale attention to stopped agent rows", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "finished", session: "tachyon-demohash-finished", running: false, lifetime: "temporary", resumePolicy: "collected", dead: false, crashed: false, cleanExited: true, kind: "agent" }],
      attentionOf: () => ({ state: "working" }),
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, posted } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();

    const fleet = posted.find((m) => (m as { type?: string }).type === "fleet") as { fleets: Array<{ agents: Array<{ name: string; status: string; attention?: string; sub?: string }> }> } | undefined;
    expect(fleet?.fleets[0]?.agents.find((a) => a.name === "finished")).toMatchObject({ status: "stopped", sub: "exited (0)" });
    expect(fleet?.fleets[0]?.agents.find((a) => a.name === "finished")?.attention).toBeUndefined();
  });

  it("routes sidebar forced kill actions through the kill command with the target workspace", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "claude", session: "tachyon-demohash-claude", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" }],
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "action", id: "kill", agent: "claude", hash: "demohash" });
    await flushPromises();

    const cmd = __getExecutedCommands().at(-1);
    expect(cmd?.command).toBe("tachyon.killAgentItem");
    expect(cmd?.args[0]).toMatchObject({ ws, agentName: "claude", contextValue: "agent-running-ai" });
  });

  it("does not route agent actions from stale workspace hashes", async () => {
    const ws = fakeWorkspace([], {
      agents: [{ name: "claude", session: "tachyon-demohash-claude", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" }],
    });
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [ws]);
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    await flushPromises();
    receive({ type: "action", id: "kill", agent: "claude", hash: "stalehash" });
    await flushPromises();

    expect(__getExecutedCommands().map((c) => c.command)).toEqual([]);
  });

  it("keeps the sidebar list opening the unified Pin document app for the targeted workspace", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tachyon-sidebar-preview-"));
    temporaryRoots.push(fixtureRoot);
    const wrongRoot = join(fixtureRoot, "Wrong");
    const rightRoot = join(fixtureRoot, "Right");
    const blobRoot = join(rightRoot, ".tachyon", "pins", "blobs");
    mkdirSync(wrongRoot, { recursive: true });
    mkdirSync(blobRoot, { recursive: true });
    writeFileSync(join(blobRoot, "a".repeat(64)), "image");
    writeFileSync(join(blobRoot, "b".repeat(64)), JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }));
    writeFileSync(join(blobRoot, "c".repeat(64)), "preview");
    const targetPin = { id: "p-123abc", text: "Preview me", done: false, by: "human", tags: ["ui"], createdAt: "2026-06-24T00:00:00.000Z", detail: true, attachmentCount: 1 };
    const opened: Array<[string, string]> = [];
    const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [
      fakeWorkspace([{ id: "p-000001", text: "Wrong", done: false, by: "human", createdAt: "2026-06-24T00:00:00.000Z" }], { hash: "wronghash", name: "Wrong", root: wrongRoot }),
      fakeWorkspace([targetPin], {
        hash: "righthash",
        name: "Right",
        root: rightRoot,
        readDetail: () => ({
          summary: targetPin,
          detail: true,
          doc: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Readonly body" }] },
              { type: "image", attrs: { attachmentId: "att-000001", blobRef: "a".repeat(64) } },
            ],
          },
          attachments: [
            {
              id: "att-000001",
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
            },
            {
              id: "att-000002",
              kind: "excalidraw",
              name: "sketch.excalidraw",
              sceneBlobRef: "b".repeat(64),
              previewBlobRef: "c".repeat(64),
              sceneMediaType: "application/vnd.tachyon.excalidraw+json",
              previewMediaType: "image/png",
              sceneSize: 100,
              previewSize: 100,
              elementCount: 3,
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z",
              source: "blank",
              visibility: "local",
              scenePath: ".tachyon/pins/blobs/" + "b".repeat(64),
              sceneAvailable: true,
              previewPath: ".tachyon/pins/blobs/" + "c".repeat(64),
              previewAvailable: true,
            },
          ],
        }),
      }),
    ], undefined, undefined, (wsHash, pinId) => { opened.push([wsHash, pinId]); });
    const { view, receive } = fakeView();

    provider.resolveWebviewView(view);
    receive({ type: "section", op: "pin:preview", id: "p-123abc", hash: "righthash" });
    expect(opened).toEqual([["righthash", "p-123abc"]]);
    expect(__createdPanels).toHaveLength(0);
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

describe("the pin row keeps one control, and Edit is not among its items (t-456ce0)", () => {
  const app = readFileSync("packages/webview-ui/src/webview/sidebar/App.tsx", "utf8");
  const row = app.slice(app.indexOf('{p.id && <div class="actions">'), app.indexOf('{p.id && <div class="actions">') + 900);

  it("offers Preview, Copy and Delete from the overflow menu", () => {
    for (const label of ["Preview", "Copy", "Delete"]) {
      expect(row, `${label} left the pin row entirely`).toContain(`label: "${label}"`);
    }
  });

  it("puts nothing beside the menu — no inline action survives", () => {
    // With Edit gone, two icons plus a menu holding one item would read as three levels of
    // importance where there is one. The assertion is the SHAPE, not a count of buttons.
    expect(row, "an inline <Act> is back on the pin row").not.toContain("<Act ");
  });

  it("removes Edit from the row and from the bridge, without touching the command", () => {
    expect(row).not.toContain('label: "Edit"');
    const bridge = readFileSync("apps/vscode-extension/src/webview/SidebarPrototype.ts", "utf8");
    expect(bridge, "the bridge still routes a pin:edit nobody sends").not.toContain('case "pin:edit"');
    // The capability survives as a contributed command with its own menu entry — retiring a door is
    // not retiring the ability, and conflating the two is how a "cleanup" removes a feature.
    expect(readFileSync("apps/vscode-extension/package.json", "utf8")).toContain("tachyon.editPinItem");
  });
});
