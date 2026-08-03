import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { setNotificationProvider, type NotificationRequest } from "../../src/workspace/NotificationService.js";
import { TMUX_VIEW_TYPE, TmuxPanelManager, tmuxRefreshKind } from "../../src/webview/TmuxPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import { sectionPanelKey, type SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import { readyMessage, refreshAction } from "../../src/webview/inspector/messages.js";
import type { InspectorDeps } from "../../src/webview/ServerInspector.js";
import type { PaneSnapshot } from "../../src/tmux/TmuxService.js";

/**
 * SDD 485 D1 — the tmux Server Inspector as a standalone `window` app.
 *
 * Two claims, different in kind. The first is the CARDINALITY, which is the decision this migration exists
 * to take: ONE panel for the whole window, no project in the key, and — the case a `dashboard` would have
 * got wrong — still one panel with two projects attached. The second is that every inspector action still
 * behaves as it did inside Control, because a cutover that quietly changed what Kill or Reap does would be
 * a migration and a regression at once.
 *
 * Every case drives the WIRE — the message a real client posts — rather than the manager's internals
 * (0.56.159's lesson): `ready` and `refresh` reach this app through the GATE rather than through
 * `onMessage`, which is exactly the difference an internals-level test cannot see.
 */

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** the confirm the Kill flow asks for, captured rather than shown. `answer` is what the human picks. */
let confirms: NotificationRequest[] = [];
let answer: string | undefined;

beforeEach(() => {
  __resetVscodeMock();
  confirms = [];
  answer = undefined;
  setNotificationProvider({
    notify: (request) => {
      confirms.push(request);
      return Promise.resolve(answer);
    },
  });
});
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
});

function pane(session: string, over: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return { session, pid: 100, dead: false, currentCommand: "bash", startCommand: "bash", createdAt: 1_750_000_000, ...over } as PaneSnapshot;
}

interface Harness {
  manager: TmuxPanelManager;
  calls: string[];
  rows: PaneSnapshot[];
  setRows: (next: PaneSnapshot[]) => void;
  killed: string[];
  opened: string[];
  captureText: (text: string) => void;
}

function harness(over: Partial<InspectorDeps> = {}, folders: Array<[string, string]> = [["a1b2c3d4", "tachyon"]]): Harness {
  const calls: string[] = [];
  const killed: string[] = [];
  const opened: string[] = [];
  let rows: PaneSnapshot[] = [pane("tachyon-a1b2c3d4-build"), pane("tachyon-ff009911-old", { dead: true, exitCode: 1 })];
  let captureText = "captured output";
  const deps: InspectorDeps = {
    snapshot: async () => { calls.push("snapshot"); return rows; },
    folderByHash: () => new Map(folders),
    cpuBusy: () => new Map(),
    serverHealth: async () => { calls.push("serverHealth"); return { state: "healthy", socketName: "tachyon", pids: [4770] } as never; },
    capture: async (s) => { calls.push(`capture:${s}`); return captureText; },
    open: (s) => { opened.push(s); },
    kill: async (s) => { killed.push(s); },
    reapDead: async () => { calls.push("reapDead"); return 1; },
    reapOrphans: async () => { calls.push("reapOrphans"); return 2; },
    ...over,
  };
  return {
    manager: new TmuxPanelManager(extensionUri, deps),
    calls,
    get rows() { return rows; },
    setRows: (next) => { rows = next; },
    killed,
    opened,
    captureText: (text) => { captureText = text; },
  };
}

const posted = (panel: typeof __createdPanels[number], type: string): unknown[] =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type);

const models = (panel: typeof __createdPanels[number]) =>
  posted(panel, "model") as Array<{ model: { totalSessions: number; groups: Array<{ workspace: string; foreign: boolean; sessions: Array<{ session: string }> }> } }>;

async function open(h: Harness): Promise<typeof __createdPanels[number]> {
  h.manager.open();
  const panel = __createdPanels[0];
  panel.webview.__receive(readyMessage());
  await flush();
  await flush();
  return panel;
}

describe("SDD 485 D1 — the tmux app's cardinality is `window`", () => {
  it("opens ONE panel and REVEALS it on a second open — keyed on the viewId alone", () => {
    const h = harness();

    h.manager.open();
    h.manager.open();

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    // No project and no identity in the key. That IS the decision: this surface reads ONE socket that
    // every workspace in the window shares.
    expect(h.manager.openKeys).toEqual([TMUX_VIEW_TYPE]);
  });

  it("stays ONE panel with two projects attached — the case a `dashboard` would have got wrong", async () => {
    // The concrete failure the third cardinality exists to prevent. Under `dashboard` the key is
    // `viewId|project`, so a window with two attached folders would open two editor tabs rendering
    // byte-identical content read from the same tmux server. There is no door here that can even ask for
    // a second: `open()` takes no argument.
    const h = harness({}, [["a1b2c3d4", "tachyon"], ["d4e5f6a7", "tachyon-docs"]]);

    h.manager.open();
    h.manager.open();
    h.manager.open();

    expect(__createdPanels).toHaveLength(1);
    expect(h.manager.openKeys).toEqual([TMUX_VIEW_TYPE]);

    // and the ONE panel answers for BOTH workspaces at once — which is why one is the right number.
    h.setRows([pane("tachyon-a1b2c3d4-build"), pane("tachyon-d4e5f6a7-writer")]);
    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();
    const groups = models(panel).at(-1)!.model.groups;
    expect(groups.map((g) => g.workspace).sort()).toEqual(["tachyon", "tachyon-docs"]);
  });

  it("shows sessions owned by workspaces this window never opened — the universe no project key could name", async () => {
    // The reason "dashboard with a constant project" is not merely untidy: the model's own rows include
    // `foreign` groups for closed folders and other windows. A project key would claim those belong to a
    // project, and the Reap-orphans action exists precisely because they belong to none.
    const h = harness();
    h.setRows([pane("tachyon-a1b2c3d4-build"), pane("tachyon-ff009911-stray")]);

    const panel = await open(h);

    const foreign = models(panel).at(-1)!.model.groups.filter((g) => g.foreign);
    expect(foreign).toHaveLength(1);
    expect(foreign[0].sessions.map((s) => s.session)).toEqual(["tachyon-ff009911-stray"]);
  });

  it("refuses a project or an identity, in the key rule itself", () => {
    // The rigor C1 applied to `identity` for a document, applied to `project` for a window. A key that
    // silently accepted a field it does not use is a key that lies: two callers passing different projects
    // would believe they addressed different panels and get one.
    expect(sectionPanelKey("tachyonServerInspector", "window", {})).toBe("tachyonServerInspector");
    expect(() => sectionPanelKey("tachyonServerInspector", "window", { project: "ws-a" })).toThrow(/has no project/);
    expect(() => sectionPanelKey("tachyonServerInspector", "window", { identity: "s-1" })).toThrow(/has no identity/);
    // and the other two still refuse a MISSING project, which optional-ness made possible to get wrong.
    expect(() => sectionPanelKey("tachyonBoard", "dashboard", {})).toThrow(/opens against a project/);
    expect(() => sectionPanelKey("tachyonTask", "document", { identity: "t-1" })).toThrow(/opens against a project/);
  });
});

describe("SDD 485 D1 — the tmux app is born gated (Phase B, through this app's own doors)", () => {
  it("gates the client's auto-refresh HOST-side — answered while visible, ignored while hidden", async () => {
    // Both halves in one case, deliberately: "hidden posts nothing" alone is satisfied by a door that does
    // nothing at all, which is how a gate test rots into proving nothing.
    const h = harness();
    h.manager.open();
    const panel = __createdPanels[0];
    panel.webview.posted.length = 0;

    panel.webview.__receive(refreshAction());
    await flush();
    await flush();
    expect(models(panel), "the poll is not served at all — this door is dead, not gated").toHaveLength(1);

    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;
    h.calls.length = 0;

    for (let i = 0; i < 20; i++) panel.webview.__receive(refreshAction()); // one minute of auto-refresh
    await flush();
    await flush();

    expect(panel.webview.posted).toEqual([]);
    expect(h.calls, "a hidden panel still queried the socket").toEqual([]);
  });

  it("catches a hidden panel up ONCE on reveal, and the catch-up is not empty", async () => {
    const h = harness();
    const panel = await open(h);
    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;

    for (let i = 0; i < 20; i++) h.manager.refresh();
    await flush();
    expect(panel.webview.posted, "a hidden panel did work").toEqual([]);

    __setPanelVisible(panel, true);
    await flush();
    await flush();

    expect(models(panel)).toHaveLength(1);
    expect(models(panel)[0].model.totalSessions).toBe(2);
  });

  it("claims `ready` and `refresh` for the gate, and nothing else", () => {
    // The host's own decision, testable without a panel. A client that renamed its poll would stop being
    // served through the gate here rather than quietly becoming ungated work.
    expect(tmuxRefreshKind(readyMessage())).toBe("tmux");
    expect(tmuxRefreshKind(refreshAction())).toBe("tmux");
    expect(tmuxRefreshKind({ type: "kill", session: "s" })).toBeUndefined();
    expect(tmuxRefreshKind({ type: "capture", session: "s" })).toBeUndefined();
    expect(tmuxRefreshKind(undefined)).toBeUndefined();
  });
});

describe("SDD 485 D1 — every inspector action behaves as it did inside Control", () => {
  it("posts strings AND a model on the handshake — so a revived tab is never string-less", async () => {
    // Control sent `init` once per panel and the model per route entry. The app rides both on every push
    // because the model push IS the catch-up path: a panel revived across a reload sends no second
    // handshake the host could answer with strings, and a string-less inspector renders nothing at all
    // (`App.tsx`: `if (!s) return <EmptyState …/>`).
    const h = harness();
    const panel = await open(h);

    expect((posted(panel, "init").at(-1) as { strings: { title: string } }).strings.title).toBe("tmux Server Inspector");
    expect(models(panel).at(-1)!.model.totalSessions).toBe(2);

    panel.webview.posted.length = 0;
    h.manager.refresh();
    await flush();
    await flush();
    expect(posted(panel, "init")).toHaveLength(1);
  });

  it("renders an EMPTY server when the socket cannot be read, rather than an error screen", async () => {
    const h = harness({ snapshot: async () => { throw new Error("no server"); } });
    const panel = await open(h);

    expect(models(panel).at(-1)!.model).toMatchObject({ totalSessions: 0, liveSessions: 0, groups: [] });
  });

  it("opens a session through the injected terminal door", async () => {
    const h = harness();
    const panel = await open(h);

    panel.webview.__receive({ type: "open", session: "tachyon-a1b2c3d4-build" });
    await flush();

    expect(h.opened).toEqual(["tachyon-a1b2c3d4-build"]);
  });

  it("KILLS only after a modal confirm, and re-reads afterwards", async () => {
    const h = harness();
    const panel = await open(h);
    answer = "Kill";
    h.calls.length = 0;

    panel.webview.__receive({ type: "kill", session: "tachyon-a1b2c3d4-build" });
    await flush();
    await flush();

    const confirm = confirms.at(-1)!;
    expect(confirm.message).toMatch(/Kill session tachyon-a1b2c3d4-build/);
    expect(confirm.modal).toBe(true);
    expect(confirm.actions?.map((a) => a.label)).toEqual(["Kill"]);
    expect(h.killed).toEqual(["tachyon-a1b2c3d4-build"]);
    expect(h.calls).toContain("snapshot");
  });

  it("kills NOTHING when the confirm is declined — and does not re-read either", async () => {
    const h = harness();
    const panel = await open(h);
    answer = undefined; // the human dismissed the modal
    h.calls.length = 0;

    panel.webview.__receive({ type: "kill", session: "tachyon-a1b2c3d4-build" });
    await flush();
    await flush();

    expect(h.killed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("reaps dead and orphaned sessions, each followed by a fresh read", async () => {
    const h = harness();
    const panel = await open(h);
    h.calls.length = 0;

    panel.webview.__receive({ type: "reapDead" });
    await flush();
    await flush();
    panel.webview.__receive({ type: "reapOrphans" });
    await flush();
    await flush();

    expect(h.calls.filter((c) => c === "reapDead" || c === "reapOrphans")).toEqual(["reapDead", "reapOrphans"]);
    expect(h.calls.filter((c) => c === "snapshot")).toHaveLength(2);
  });

  it("posts an EMPTY capture when the capture fails, rather than leaving the pane on stale text", async () => {
    const h = harness({ capture: async () => { throw new Error("pane gone"); } });
    const panel = await open(h);

    panel.webview.__receive({ type: "capture", session: "tachyon-a1b2c3d4-build" });
    await flush();
    await flush();

    expect(posted(panel, "capture").at(-1)).toEqual({ type: "capture", session: "tachyon-a1b2c3d4-build", text: "" });
  });

  it("posts a capture's text back under the session it was asked for", async () => {
    const h = harness();
    const panel = await open(h);
    h.captureText("hello from the pane");

    panel.webview.__receive({ type: "capture", session: "tachyon-a1b2c3d4-build" });
    await flush();
    await flush();

    expect(posted(panel, "capture").at(-1)).toEqual({ type: "capture", session: "tachyon-a1b2c3d4-build", text: "hello from the pane" });
  });
});

describe("SDD 485 D1 — reload puts tmux back in its tab, with no migration step", () => {
  it("persists a state IDENTICAL to the retired panel's, and revives the panel VS Code hands back", async () => {
    const h = harness();
    h.manager.open();
    // Read the persisted state out of the RENDERED page rather than re-deriving it: this is what a real
    // reload is actually handed.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    // No `project` key at all — which is exactly the shape SDD 410's tombstone
    // (`ServerInspectorPanelState = {schemaVersion, view}`) wrote. That equality is why this migration
    // needs no `migrateLegacy` the way C4's did: a pre-410 record is already a valid state for this app.
    expect(persisted).toEqual({ schemaVersion: 1, view: TMUX_VIEW_TYPE });

    __createdPanels[0].dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = harness();
    registerTrustedPanelSerializer<SectionPanelState>(context, TMUX_VIEW_TYPE, (panel, state) => revived.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === TMUX_VIEW_TYPE);
    expect(registration, "no serializer registered for the tmux viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);

    expect(revived.manager.openKeys).toEqual([TMUX_VIEW_TYPE]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((p) => !p.disposed), "revival created a second panel").toHaveLength(0);
  });

  it("revives a PRE-410 standalone panel's state unchanged — the tombstone shape IS this app's shape", async () => {
    const h = harness();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, TMUX_VIEW_TYPE, (panel, state) => h.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === TMUX_VIEW_TYPE)!;

    const panel = makeRevivablePanel();
    // Verbatim `ServerInspectorPanelState` from a window closed before SDD 410 retired the panel.
    await registration.serializer.deserializeWebviewPanel(panel as never, { schemaVersion: 1, view: TMUX_VIEW_TYPE });
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();

    expect(panel.disposed).toBe(false);
    expect(h.manager.openKeys).toEqual([TMUX_VIEW_TYPE]);
    expect((panel.webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { totalSessions: number } }).model.totalSessions).toBe(2);
  });

  it("drops a state carrying a project — a window app has none, so that record is stale, not fatal", async () => {
    const h = harness();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, TMUX_VIEW_TYPE, (panel, state) => h.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === TMUX_VIEW_TYPE)!;

    const panel = makeRevivablePanel();
    await registration.serializer.deserializeWebviewPanel(panel as never, { schemaVersion: 1, view: TMUX_VIEW_TYPE, project: "ws-a" });

    expect(panel.disposed).toBe(true);
    expect(h.manager.openKeys).toEqual([]);
  });
});

/** a panel shaped like the one VS Code hands a serializer — created outside `createWebviewPanel`. */
function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
  const receivers: Array<(msg: unknown) => void> = [];
  const panel = {
    title: "",
    iconPath: undefined,
    disposed: false,
    visible: true,
    active: true,
    revealCount: 0,
    onDidChangeViewState: (_cb: () => void) => ({ dispose() {} }),
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      posted: [] as unknown[],
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => { receivers.push(cb); return { dispose() {} }; },
      __receive: (msg: unknown) => { for (const cb of receivers) cb(msg); },
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
