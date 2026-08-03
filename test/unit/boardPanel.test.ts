import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __getClipboardText, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { BOARD_VIEW_TYPE, BoardPanelManager, boardRefreshKind, type BoardPanelDeps } from "../../src/webview/BoardPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import type { SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import { legacyMissionControlTarget, type WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { readyMessage, requestSnapshotAction } from "../../src/webview/mission-control/messages.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * SDD 485 C5 — the Board as a standalone DASHBOARD app.
 *
 * Two claims are under test and they are different in kind. The first is the CARDINALITY, which is the whole
 * of what this migration decides: one panel per project, re-opening reveals, two projects are two panels. The
 * second is that every board action still behaves exactly as it did inside Control — this half is ported
 * verbatim from `cockpitMissionBoard.test.ts` (retired with the board's Control renderer), because a cutover
 * that quietly changed what a drag or a validation close does would be a migration and a regression at once.
 *
 * Every case drives the WIRE — the message a real client posts — rather than the manager's internals. That is
 * 0.56.159's lesson applied here: a test that calls the one door it knows about proves nothing about the ones
 * production uses, and `ready`/`requestSnapshot` reach this app through the gate rather than through
 * `onMessage`, which is precisely the sort of difference an internals-level test cannot see.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-panel-"));
  dirs.push(dir);
  return dir;
};

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}, opts: { hash?: string; name?: string } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    validationStore: new ValidationStore(root),
    config: { agents },
    manager: { list: async () => [] },
  } as unknown as Workspace;
}

const target = (workspace: Workspace): WorkspaceMissionControlTarget => legacyMissionControlTarget(workspace);

interface Harness {
  manager: BoardPanelManager;
  fanOuts: () => number;
  openedTasks: Array<[string, string]>;
  openedStudios: Array<[string, string | undefined]>;
}

function harness(targets: WorkspaceMissionControlTarget[], hooks: Partial<BoardPanelDeps> = {}): Harness {
  let fanOuts = 0;
  const openedTasks: Array<[string, string]> = [];
  const openedStudios: Array<[string, string | undefined]> = [];
  const manager = new BoardPanelManager(extensionUri, {
    getWorkspaces: () => targets,
    openTask: (ws, taskId) => { openedTasks.push([ws.wsHash, taskId]); },
    openTaskStudio: (ws, id) => { openedStudios.push([ws.wsHash, id]); },
    onTasksChanged: () => { fanOuts += 1; manager.refresh(); },
    ...hooks,
  });
  return { manager, fanOuts: () => fanOuts, openedTasks, openedStudios };
}

const posted = (panel: typeof __createdPanels[number], type: string): unknown[] =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type);

const snapshots = (panel: typeof __createdPanels[number]) =>
  posted(panel, "snapshot") as Array<{ vm: { folder: string; wsHash: string; agentLiveness?: { status: string }; snapshot: { views: Array<{ task: { title: string; status: string } }>; chips: Array<{ agent: string }> } } }>;

describe("SDD 485 C5 — the Board's cardinality is `dashboard`", () => {
  it("opens ONE panel per project and REVEALS it on a second open", () => {
    const ws = fakeWorkspace();
    const h = harness([target(ws)]);

    h.manager.open(ws.wsHash);
    h.manager.open(ws.wsHash);

    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    expect(h.manager.openKeys).toEqual(["tachyonBoard|ws-1"]);
  });

  it("gives two PROJECTS a panel each — one per section per project, not one for the window", () => {
    const a = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
    const b = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
    const h = harness([target(a), target(b)]);

    h.manager.open("ws-a");
    h.manager.open("ws-b");

    expect(__createdPanels).toHaveLength(2);
    expect(h.manager.openKeys).toEqual(["tachyonBoard|ws-a", "tachyonBoard|ws-b"]);
  });

  it("keeps each project's panel on its OWN workspace — the key is not a preference", async () => {
    // The failure this forbids is the one Control could not avoid: one panel answering for whichever scope
    // was chosen last. Two panels, two workspaces, two snapshots that never cross.
    const a = fakeWorkspace(mkroot(), {}, { hash: "ws-a", name: "Alpha" });
    const b = fakeWorkspace(mkroot(), {}, { hash: "ws-b", name: "Beta" });
    await a.taskStore.create({ title: "alpha task", author: "human" });
    await b.taskStore.create({ title: "beta task", author: "human" });
    const h = harness([target(a), target(b)]);
    h.manager.open("ws-a");
    h.manager.open("ws-b");

    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await flush();
    await flush();

    expect(snapshots(__createdPanels[0]).at(-1)?.vm).toMatchObject({ folder: "Alpha", wsHash: "ws-a" });
    expect(snapshots(__createdPanels[0]).at(-1)?.vm.snapshot.views.map((v) => v.task.title)).toEqual(["alpha task"]);
    expect(snapshots(__createdPanels[1]).at(-1)?.vm).toMatchObject({ folder: "Beta", wsHash: "ws-b" });
    expect(snapshots(__createdPanels[1]).at(-1)?.vm.snapshot.views.map((v) => v.task.title)).toEqual(["beta task"]);
  });

  it("says so when its project is no longer attached, instead of borrowing another one's tasks", async () => {
    const gone = fakeWorkspace(mkroot(), {}, { hash: "ws-gone" });
    const other = fakeWorkspace(mkroot(), {}, { hash: "ws-other" });
    let attached: WorkspaceMissionControlTarget[] = [target(gone), target(other)];
    const h = harness([], { getWorkspaces: () => attached });
    h.manager.open("ws-gone");
    attached = [target(other)]; // the folder was closed while its Board stayed open

    __createdPanels[0].webview.__receive(requestSnapshotAction());
    await flush();

    expect(snapshots(__createdPanels[0])).toEqual([]);
    expect((posted(__createdPanels[0], "taskError").at(-1) as { message: string }).message).toMatch(/ws-gone/);
  });
});

describe("SDD 485 C5 — the Board app is born gated (Phase B, through this app's own doors)", () => {
  it("gates the client's own poll HOST-side — answered while visible, ignored while hidden", async () => {
    // Both halves, in one case, on purpose. "hidden posts nothing" alone is satisfied by a door that does
    // nothing at all — the exact way a gate test rots into proving nothing. The visible half is what makes
    // the hidden half mean something.
    const ws = fakeWorkspace();
    const h = harness([target(ws)]);
    h.manager.open(ws.wsHash);
    const panel = __createdPanels[0];
    panel.webview.posted.length = 0;

    panel.webview.__receive(requestSnapshotAction());
    await flush();
    await flush();
    expect(snapshots(panel), "the poll is not served at all — this door is dead, not gated").toHaveLength(1);

    __setPanelVisible(panel, false);
    panel.webview.posted.length = 0;

    for (let i = 0; i < 20; i++) panel.webview.__receive(requestSnapshotAction()); // one minute of polling
    await flush();
    await flush();

    expect(panel.webview.posted).toEqual([]);
  });

  it("does work for the VISIBLE panel only on a fan-out, and catches the hidden one up on reveal", async () => {
    const a = fakeWorkspace(mkroot(), {}, { hash: "ws-a" });
    const b = fakeWorkspace(mkroot(), {}, { hash: "ws-b" });
    const h = harness([target(a), target(b)]);
    h.manager.open("ws-a");
    h.manager.open("ws-b");
    __setPanelVisible(__createdPanels[0], false);
    for (const panel of __createdPanels) panel.webview.posted.length = 0;

    for (let i = 0; i < 20; i++) h.manager.refresh();
    await flush();

    expect(__createdPanels[0].webview.posted, "a hidden panel did work").toEqual([]);
    expect(snapshots(__createdPanels[1]).length).toBe(20);

    __setPanelVisible(__createdPanels[0], true);
    await flush();
    await flush();

    // One catch-up, not twenty replays — and it is not empty, which is the property that matters.
    expect(snapshots(__createdPanels[0])).toHaveLength(1);
  });

  it("claims `ready` and `requestSnapshot` for the gate, and nothing else", () => {
    // The host's own decision, testable without a panel. A client that renamed its poll would stop being
    // served through the gate here rather than quietly becoming ungated work.
    expect(boardRefreshKind(readyMessage())).toBe("board");
    expect(boardRefreshKind(requestSnapshotAction())).toBe("board");
    expect(boardRefreshKind({ type: "updateTask", id: "t-1" })).toBeUndefined();
    expect(boardRefreshKind(undefined)).toBeUndefined();
  });
});

describe("SDD 485 C5 — every board action behaves as it did inside Control", () => {
  async function open(ws: Workspace, hooks: Partial<BoardPanelDeps> = {}): Promise<Harness & { panel: typeof __createdPanels[number] }> {
    const h = harness([target(ws)], hooks);
    h.manager.open(ws.wsHash);
    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();
    return { ...h, panel };
  }

  it("posts a board snapshot with liveness + chips on the first handshake", async () => {
    const ws = fakeWorkspace(undefined, { codex: {} });
    await ws.taskStore.create({ title: "seed", author: "human" });
    const { panel } = await open(ws);

    const [snap] = snapshots(panel);
    expect(snap.vm).toMatchObject({ folder: "Project", wsHash: "ws-1", agentLiveness: { status: "available" } });
    expect(snap.vm.snapshot.chips.map((c) => c.agent)).toEqual(["codex", "human"]);
  });

  it("applies a status-transition update, fans out once, and the fan-out re-posts a fresh snapshot", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flow", author: "human" });
    const { panel, fanOuts } = await open(ws);

    panel.webview.__receive({ type: "updateTask", id: t.id, patch: { status: "triaged" } });
    await flush();
    await flush();

    expect(ws.taskStore.get(t.id).status).toBe("triaged");
    expect(fanOuts()).toBe(1);
    const latest = snapshots(panel).at(-1);
    expect(latest?.vm.snapshot.views.some((v) => v.task.title === "flow" && v.task.status === "triaged")).toBe(true);
  });

  it("posts a taskError (no fan-out, no move) when the store rejects a transition", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "gate", author: "human" });
    const { panel, fanOuts } = await open(ws);

    // inbox -> done is not an allowed transition
    panel.webview.__receive({ type: "updateTask", id: t.id, patch: { status: "done" } });
    await flush();

    const err = posted(panel, "taskError").at(-1) as { taskId?: string; message: string };
    expect(err.taskId).toBe(t.id);
    expect(err.message).toMatch(/invalid status transition/);
    expect(ws.taskStore.get(t.id).status).toBe("inbox");
    expect(fanOuts()).toBe(0);
  });

  it("closes a validation from the board only with an auditable note, then fans out", async () => {
    const ws = fakeWorkspace();
    const validation = await ws.validationStore.create({ title: "Manual dogfood", author: "human", executor: "human" });
    const { panel, fanOuts } = await open(ws);

    panel.webview.__receive({ type: "closeValidation", id: validation.id, outcome: "passed", result_note: "Checked installed VSIX manually" });
    await flush();

    expect(ws.validationStore.get(validation.id)).toMatchObject({ status: "closed", rounds: [{ outcome: "passed", result_note: "Checked installed VSIX manually" }] });
    expect(fanOuts()).toBe(1);
  });

  it("opens a task through the injected detail surface, carrying the panel's OWN project", async () => {
    // The Board must not know where a task detail lives (Control subroute today, a `document` app after C4);
    // what it must never do is hand over a workspace other than its own.
    const ws = fakeWorkspace(mkroot(), {}, { hash: "ws-a" });
    const { panel, openedTasks } = await open(ws);

    panel.webview.__receive({ type: "openTask", id: "t-abc123" });
    await flush();

    expect(openedTasks).toEqual([["ws-a", "t-abc123"]]);
  });

  it("routes openTaskStudio to the injected callback, with and without an id", async () => {
    const ws = fakeWorkspace();
    const { panel, openedStudios } = await open(ws);

    panel.webview.__receive({ type: "openTaskStudio" });
    panel.webview.__receive({ type: "openTaskStudio", id: "t-abc123" });
    await flush();

    expect(openedStudios).toEqual([["ws-1", undefined], ["ws-1", "t-abc123"]]);
  });

  it("copies a task id through the host clipboard", async () => {
    const ws = fakeWorkspace();
    const { panel } = await open(ws);

    panel.webview.__receive({ type: "copyTaskId", id: "t-abc123" });
    await flush();

    expect(__getClipboardText()).toBe("t-abc123");
  });
});

describe("SDD 485 C5 — reload puts the Board back in its tab", () => {
  it("persists the project and revives onto the same key, reusing the panel VS Code hands back", async () => {
    const ws = fakeWorkspace();
    const h = harness([target(ws)]);
    h.manager.open(ws.wsHash);
    // Read the persisted state out of the RENDERED page rather than re-deriving it: this is what a real
    // reload would actually be handed.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    expect(persisted).toEqual({ schemaVersion: 1, view: BOARD_VIEW_TYPE, project: "ws-1" });

    __createdPanels[0].dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = harness([target(ws)]);
    registerTrustedPanelSerializer<SectionPanelState>(context, BOARD_VIEW_TYPE, (panel, state) => revived.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === BOARD_VIEW_TYPE);
    expect(registration, "no serializer registered for the Board's viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);

    expect(revived.manager.openKeys).toEqual(["tachyonBoard|ws-1"]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((p) => !p.disposed), "revival created a second panel").toHaveLength(0);
  });
});

/** a panel shaped like the one VS Code hands a serializer — created outside `createWebviewPanel`. */
function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
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
      onDidReceiveMessage: (_cb: (msg: unknown) => void) => ({ dispose() {} }),
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
