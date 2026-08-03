import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { __createdPanels, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import { TaskDetailPanelManager, TASK_DETAIL_VIEW_TYPE } from "../../src/webview/TaskDetailPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import { legacyTaskDetailTarget, type WorkspaceTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { readyMessage } from "../../src/webview/shared/ready.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import { ControlWorkspaceScope } from "../../src/webview/shared/ControlWorkspaceScope.js";

/**
 * SDD 485 C4 — the Task Detail as a standalone `document` app.
 *
 * Two kinds of claim live here, and they are deliberately in one file because C4's risk is that one of
 * them is bought at the other's expense:
 *
 *  1. THE NEW CAPABILITY — two identities are two panels, the same identity twice reveals, and a document's
 *     project is fixed at open. That last one is a correctness rule, not a UX preference (`spec.md`): if the
 *     project selector could retarget an open document, two task details side by side would silently become
 *     different documents the moment a human touched a dropdown, and the delivery would fail the case that
 *     justifies it.
 *  2. THE OLD CONTRACT, UNBROKEN — the behaviour ported here from `cockpitTaskDetail.test.ts` (itself ported
 *     from the pre-410 standalone panel's tests): the projection, the CAS `expect`, the shared fan-out, the
 *     tombstone fallback (dueto F8, spec 335), attachment-ref resolution, the journal, prototype review, and
 *     the attachments resource grant. A migration that moved the screen and quietly dropped one of these
 *     would pass a "does it open" test and lose a year of hard-won behaviour.
 *
 * Everything is driven through the doors PRODUCTION uses: `open()` (what the command, the Board card and the
 * redirect all call), the real `webview.__receive` wire messages a client actually posts, and a real
 * `registerTrustedPanelSerializer` for revive.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-app-"));
  dirs.push(dir);
  return dir;
};

const extensionUri = vscode.Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkspace(root = mkroot(), opts: { hash?: string; name?: string } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
  } as unknown as Workspace;
}

interface Harness {
  manager: TaskDetailPanelManager;
  fanOuts: () => number;
  studioOpens: () => Array<[string, string]>;
  /** the workspaces the host can see — mutable, so a test can model a project appearing or leaving. */
  targets: WorkspaceTaskDetailTarget[];
}

function harnessWithScope(scope: ControlWorkspaceScope | undefined, ...workspaces: Workspace[]): Harness {
  let fanOuts = 0;
  const studioOpens: Array<[string, string]> = [];
  const targets = workspaces.map((ws) => legacyTaskDetailTarget(ws));
  const manager = new TaskDetailPanelManager(extensionUri, () => targets, {
    onTasksChanged: () => { fanOuts += 1; },
    openTaskStudio: (ws, taskId) => { studioOpens.push([ws.wsHash, taskId]); },
  }, undefined, scope);
  return { manager, fanOuts: () => fanOuts, studioOpens: () => studioOpens, targets };
}
function harness(...workspaces: Workspace[]): Harness { return harnessWithScope(undefined, ...workspaces); }

const panelAt = (i: number) => __createdPanels[i]!;
const lastPanel = () => __createdPanels.at(-1)!;

/** Every task VM this panel has been posted, newest last. */
function taskVms(panel = lastPanel()): Array<{ id: string; tombstone: boolean; wsHash: string; task?: { title: string; body?: string }; journal: unknown[]; deps: unknown[] }> {
  return panel.webview.posted
    .filter((m) => (m as { type?: string }).type === "task")
    .map((m) => (m as { vm: never }).vm);
}

/** Open a task and let its READY-driven first push settle — the sequence a real client produces. */
async function openTask(h: Harness, wsHash: string, taskId: string): Promise<void> {
  h.manager.open(wsHash, taskId);
  lastPanel().webview.__receive(readyMessage());
  await flush();
}

// ---------------------------------------------------------------------------------------------
// 1. The capability this phase exists to buy.
// ---------------------------------------------------------------------------------------------

describe("SDD 485 C4 — two task details, side by side", () => {
  it("opens TWO panels for two identities, each showing its own task", async () => {
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "task A", author: "human" });
    const b = await ws.taskStore.create({ title: "task B", author: "human" });
    const h = harness(ws);

    await openTask(h, ws.wsHash, a.id);
    await openTask(h, ws.wsHash, b.id);

    expect(__createdPanels).toHaveLength(2);
    expect(h.manager.openKeys).toEqual([
      `${TASK_DETAIL_VIEW_TYPE}|${ws.wsHash}|${a.id}`,
      `${TASK_DETAIL_VIEW_TYPE}|${ws.wsHash}|${b.id}`,
    ]);
    expect(taskVms(panelAt(0)).at(-1)?.task?.title).toBe("task A");
    expect(taskVms(panelAt(1)).at(-1)?.task?.title).toBe("task B");
    expect(__createdPanels.every((p) => !p.disposed)).toBe(true);
  });

  it("opens two panels for the SAME task id in two different projects", async () => {
    // The motivating case named in `spec.md` is two projects, not two tasks: ids are per-workspace, so
    // "the same id" is a genuinely different document in another project and must not collide.
    const alpha = fakeWorkspace(mkroot(), { hash: "ws-alpha" });
    const beta = fakeWorkspace(mkroot(), { hash: "ws-beta" });
    const a = await alpha.taskStore.create({ title: "alpha's task", author: "human" });
    // Give beta a task with an id of its own; the key must separate them by PROJECT regardless.
    const b = await beta.taskStore.create({ title: "beta's task", author: "human" });
    const h = harness(alpha, beta);

    await openTask(h, "ws-alpha", a.id);
    await openTask(h, "ws-beta", b.id);

    expect(__createdPanels).toHaveLength(2);
    expect(taskVms(panelAt(0)).at(-1)).toMatchObject({ wsHash: "ws-alpha", task: { title: "alpha's task" } });
    expect(taskVms(panelAt(1)).at(-1)).toMatchObject({ wsHash: "ws-beta", task: { title: "beta's task" } });
  });

  it("REVEALS rather than duplicates when the same identity is opened twice", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "one tab", author: "human" });
    const h = harness(ws);

    await openTask(h, ws.wsHash, t.id);
    h.manager.open(ws.wsHash, t.id);

    expect(__createdPanels).toHaveLength(1);
    expect(panelAt(0).revealCount).toBe(1);
    expect(panelAt(0).disposed).toBe(false);
  });

  it("fans out to EVERY open document, each re-reading its own task", async () => {
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "A", author: "human" });
    const b = await ws.taskStore.create({ title: "B", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, a.id);
    await openTask(h, ws.wsHash, b.id);
    await ws.taskStore.update(a.id, { title: "A renamed" });
    await ws.taskStore.update(b.id, { title: "B renamed" });

    expect(h.manager.refresh()).toBe(2);
    await flush();

    expect(taskVms(panelAt(0)).at(-1)?.task?.title).toBe("A renamed");
    expect(taskVms(panelAt(1)).at(-1)?.task?.title).toBe("B renamed");
  });

  it("a HIDDEN document does no work, and is rebuilt rather than left stale on reveal", async () => {
    // SDD 485 Phase B's bargain, inherited by construction from SectionPanelManager — asserted here
    // because C4 is the first SHIPPED surface that depends on it being true.
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "watched", author: "human" });
    const b = await ws.taskStore.create({ title: "hidden", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, a.id);
    await openTask(h, ws.wsHash, b.id);
    __setPanelVisible(panelAt(1), false);
    const hiddenBefore = taskVms(panelAt(1)).length;
    await ws.taskStore.update(b.id, { title: "changed while hidden" });

    expect(h.manager.refresh()).toBe(1); // only the visible one did work
    await flush();
    expect(taskVms(panelAt(1))).toHaveLength(hiddenBefore);

    __setPanelVisible(panelAt(1), true);
    await flush();
    expect(taskVms(panelAt(1)).at(-1)?.task?.title).toBe("changed while hidden");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Identity is fixed at open — the correctness rule, not a preference.
// ---------------------------------------------------------------------------------------------

describe("SDD 485 C4 — an open document is never retargeted", () => {
  it("keeps A open after selecting B, while the next document opens against B", async () => {
    const alpha = fakeWorkspace(mkroot(), { hash: "ws-alpha" });
    const beta = fakeWorkspace(mkroot(), { hash: "ws-beta" });
    const a = await alpha.taskStore.create({ title: "alpha stays", author: "human" });
    const b = await beta.taskStore.create({ title: "beta opens next", author: "human" });
    const scope = new ControlWorkspaceScope();
    scope.set("ws-alpha");
    const h = harnessWithScope(scope, alpha, beta);

    expect(h.manager.openInCurrentScope(a.id)).toBe(true);
    lastPanel().webview.__receive(readyMessage());
    await flush();
    scope.set("ws-beta");
    expect(h.manager.openInCurrentScope(b.id)).toBe(true);
    lastPanel().webview.__receive(readyMessage());
    await flush();

    expect(taskVms(panelAt(0)).at(-1)).toMatchObject({ wsHash: "ws-alpha", task: { title: "alpha stays" } });
    expect(taskVms(panelAt(1)).at(-1)).toMatchObject({ wsHash: "ws-beta", task: { title: "beta opens next" } });
    scope.dispose();
  });

  it("keeps its own project when the set of workspaces (and their order) changes under it", async () => {
    // The project selector's authority is the HOST, and what it changes is which workspace the NEXT thing
    // opens against. This models the strongest version of a scope change reaching an open panel: the
    // workspace list is reordered and a different project put first. A panel that resolved "its" workspace
    // from anything ambient — first entry, a current-scope variable — would swap tasks here.
    const alpha = fakeWorkspace(mkroot(), { hash: "ws-alpha" });
    const beta = fakeWorkspace(mkroot(), { hash: "ws-beta" });
    const a = await alpha.taskStore.create({ title: "alpha's task", author: "human" });
    await beta.taskStore.create({ title: "beta's task", author: "human" });
    const h = harness(alpha, beta);
    await openTask(h, "ws-alpha", a.id);
    expect(taskVms().at(-1)).toMatchObject({ wsHash: "ws-alpha", task: { title: "alpha's task" } });

    h.targets.reverse(); // "the human switched the project selector to beta"
    lastPanel().webview.__receive({ type: "requestSnapshot" });
    await flush();

    expect(taskVms().at(-1)).toMatchObject({ wsHash: "ws-alpha", task: { title: "alpha's task" } });
    expect(h.manager.openKeys).toEqual([`${TASK_DETAIL_VIEW_TYPE}|ws-alpha|${a.id}`]);
  });

  it("opens a dependency link as ANOTHER document instead of rewriting this one", async () => {
    // Control navigated in place because it had one panel to navigate. Retargeting an open document is
    // exactly what the `document` cardinality exists to forbid, so the dep chip opens a second tab.
    const ws = fakeWorkspace();
    const dep = await ws.taskStore.create({ title: "the dependency", author: "human" });
    const root = await ws.taskStore.create({ title: "the root task", author: "human", deps: [dep.id] });
    const h = harness(ws);
    await openTask(h, ws.wsHash, root.id);

    panelAt(0).webview.__receive({ type: "openTask", id: dep.id });
    lastPanel().webview.__receive(readyMessage());
    await flush();

    expect(__createdPanels).toHaveLength(2);
    expect(taskVms(panelAt(0)).at(-1)?.task?.title).toBe("the root task"); // unchanged
    expect(taskVms(panelAt(1)).at(-1)?.task?.title).toBe("the dependency");
  });

  it("keeps its identity when its workspace is not attached in this window, instead of showing another one's task", async () => {
    // A revived panel whose folder has since been closed. The honest answer is this document, empty —
    // never a different project's task under this tab's name.
    const ws = fakeWorkspace(mkroot(), { hash: "ws-present" });
    await ws.taskStore.create({ title: "somebody else's task", author: "human" });
    const h = harness(ws);

    await openTask(h, "ws-gone", "t-abc123");

    const vm = taskVms().at(-1);
    expect(vm).toMatchObject({ wsHash: "ws-gone", id: "t-abc123", tombstone: true });
    expect(vm?.task, "an unattached workspace resolved SOME other task").toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Restore — the machinery spec 361 established, exercised by a surface that ships.
// ---------------------------------------------------------------------------------------------

describe("SDD 485 C4 — restore across a window reload", () => {
  /**
   * The panel VS Code hands back after a reload: a FRESH object it owns, not the one that was disposed.
   * Modelled the way `sectionPanelManager.test.ts` models it, plus a `__receive` so the revived panel can
   * be driven with the same wire messages a real client posts.
   */
  function makeRevivablePanel() {
    const disposeHandlers: Array<() => void> = [];
    let receive: (msg: unknown) => void = () => {};
    const panel = {
      title: "",
      iconPath: undefined,
      disposed: false,
      visible: true,
      active: true,
      revealCount: 0,
      onDidChangeViewState: () => ({ dispose() {} }),
      webview: {
        html: "",
        options: {} as { localResourceRoots?: unknown[] },
        cspSource: "vscode-webview:",
        posted: [] as unknown[],
        asWebviewUri: (uri: unknown) => uri,
        postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
        onDidReceiveMessage: (cb: (msg: unknown) => void) => { receive = cb; return { dispose() {} }; },
        __receive: (msg: unknown) => receive(msg),
      },
      reveal: () => { panel.revealCount += 1; },
      dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
      onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
    };
    return panel;
  }

  /** Register the app's real trusted serializer and hand back the registration VS Code would call. */
  function serializerFor(h: Harness) {
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer(context, TASK_DETAIL_VIEW_TYPE, (panel, state) => h.manager.deserialize(panel, state as never));
    const registered = (vscode as unknown as { __registeredWebviewPanelSerializers: Array<{ viewType: string; serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> } }> })
      .__registeredWebviewPanelSerializers;
    return registered.at(-1)!.serializer;
  }

  it("revives onto the same key from the state the RENDERED page carries, and paints the task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "restored", author: "human" });
    const before = harness(ws);
    await openTask(before, ws.wsHash, t.id);
    // Read the state back out of the page the shell rendered rather than re-deriving it: that is what a
    // real reload is actually handed, and a re-derived copy would prove nothing about what shipped.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(lastPanel().webview.html)![1]!) as unknown;
    expect(persisted).toEqual({ schemaVersion: 1, view: TASK_DETAIL_VIEW_TYPE, project: ws.wsHash, identity: t.id });
    lastPanel().dispose(); // the window reloaded

    const after = harness(ws);
    const panel = makeRevivablePanel();
    await serializerFor(after).deserializeWebviewPanel(panel, persisted);
    panel.webview.__receive(readyMessage());
    await flush();

    expect(panel.disposed).toBe(false);
    expect(after.manager.openKeys).toEqual([`${TASK_DETAIL_VIEW_TYPE}|${ws.wsHash}|${t.id}`]);
    expect((panel.webview.posted.at(-1) as { vm?: { task?: { title?: string } } })?.vm?.task?.title).toBe("restored");
  });

  it("revives a PRE-410 standalone panel's state by migrating wsHash/taskId — no dead redirect left", async () => {
    // The compatibility shim `spec.md` allows: two field names, no UI. Before C4 this viewType's
    // serializer disposed the panel and redirected INTO Control; the panel it is handed now becomes the app.
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "from an old window", author: "human" });
    const h = harness(ws);
    const panel = makeRevivablePanel();

    await serializerFor(h).deserializeWebviewPanel(panel, {
      schemaVersion: 1, view: TASK_DETAIL_VIEW_TYPE, wsHash: ws.wsHash, taskId: t.id,
    });
    panel.webview.__receive(readyMessage());
    await flush();

    expect(panel.disposed).toBe(false);
    expect(h.manager.openKeys).toEqual([`${TASK_DETAIL_VIEW_TYPE}|${ws.wsHash}|${t.id}`]);
    expect((panel.webview.posted.at(-1) as { vm?: { task?: { title?: string } } })?.vm?.task?.title).toBe("from an old window");
  });

  it("drops a state with no usable identity rather than opening an identity-less document", async () => {
    const ws = fakeWorkspace();
    const h = harness(ws);
    const panel = makeRevivablePanel();

    await serializerFor(h).deserializeWebviewPanel(panel, { schemaVersion: 1, view: TASK_DETAIL_VIEW_TYPE, wsHash: ws.wsHash });

    expect(panel.disposed).toBe(true);
    expect(h.manager.openKeys).toEqual([]);
  });

  it("refuses a state that names a DIFFERENT view — the serializer's own boundary, exercised", async () => {
    const ws = fakeWorkspace();
    const h = harness(ws);
    const panel = makeRevivablePanel();

    await serializerFor(h).deserializeWebviewPanel(panel, { schemaVersion: 1, view: "tachyonCockpit", project: ws.wsHash, identity: "t-1" });

    expect(panel.disposed).toBe(true);
    expect(h.manager.openKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The behaviour contract, carried over unbroken.
// ---------------------------------------------------------------------------------------------

describe("SDD 485 C4 — the pre-existing Task Detail contract still holds", () => {
  it("answers the client's READY with the task VM, resolving deps to linked title/status", async () => {
    // The handshake IS the first refresh (`refreshKindFor`), so a freshly opened tab paints without any
    // separate "load" path for a catch-up to diverge from — and the blank-panel class t-2f6cdd found in
    // Control (a handler swallowing READY) cannot recur: the manager routes it, no handler sees it.
    const ws = fakeWorkspace();
    const dep = await ws.taskStore.create({ title: "dependency", author: "human" });
    const t = await ws.taskStore.create({ title: "root", author: "human", deps: [dep.id, "t-ffffff"] });
    const h = harness(ws);

    await openTask(h, ws.wsHash, t.id);

    const vm = taskVms().at(-1);
    expect(vm?.tombstone).toBe(false);
    expect(vm?.deps).toContainEqual({ id: dep.id, title: "dependency", status: "inbox", missing: false });
    expect(vm?.deps).toContainEqual({ id: "t-ffffff", missing: true });
  });

  it("applies a quick-control update through the CAS expect and fans out", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "edit me", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, t.id);
    const startUpdatedAt = ws.taskStore.get(t.id).updatedAt;

    lastPanel().webview.__receive({ type: "updateTask", patch: { assignee: "codex", expect: { updatedAt: startUpdatedAt } } });
    await flush();

    expect(ws.taskStore.get(t.id).assignee).toBe("codex");
    expect(h.fanOuts()).toBe(1);
  });

  it("surfaces a CAS failure as taskError without corrupting the task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "stale edit", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, t.id);

    lastPanel().webview.__receive({ type: "updateTask", patch: { priority: 1, expect: { updatedAt: "2000-01-01T00:00:00.000Z" } } });
    await flush();

    const err = lastPanel().webview.posted.find((m) => (m as { type?: string }).type === "taskError") as { message: string };
    expect(err.message).toMatch(/precondition-failed/);
    expect(ws.taskStore.get(t.id).title).toBe("stale edit");
    expect(ws.taskStore.get(t.id).priority).toBeUndefined();
  });

  it("renders a tombstone from the LAST KNOWN state when the task file disappears (dueto F8)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "vanishing", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, t.id);
    expect(taskVms().at(-1)?.tombstone).toBe(false);

    fs.rmSync(ws.taskStore.pathFor(t.id));
    lastPanel().webview.__receive({ type: "requestSnapshot" });
    await flush();

    expect(lastPanel().disposed).toBe(false); // the document never redirects away from itself
    expect(taskVms().at(-1)).toMatchObject({ tombstone: true, task: { title: "vanishing" } });
  });

  it("keeps ONE tombstone cache PER PANEL, not one for the whole host", async () => {
    // Control could keep a single slot because it was a singleton ("at most one task-detail route is ever
    // open" — its own comment). With N tabs, a shared slot would render task A's last-known state under
    // task B's tab the moment B's file went missing.
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "task A", author: "human" });
    const b = await ws.taskStore.create({ title: "task B", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, a.id);
    await openTask(h, ws.wsHash, b.id);

    fs.rmSync(ws.taskStore.pathFor(b.id));
    h.manager.refresh();
    await flush();

    expect(taskVms(panelAt(1)).at(-1)).toMatchObject({ tombstone: true, task: { title: "task B" } });
    expect(taskVms(panelAt(0)).at(-1)).toMatchObject({ tombstone: false, task: { title: "task A" } });
  });

  it("grants THIS document's own workspace attachments root, and not every workspace's", async () => {
    // t-4d59d3 — the grant must exist before `asWebviewUri` can resolve an `attachment:<id>` ref. Control
    // had to grant every attached workspace's parent because one panel served them all; a per-identity
    // panel needs exactly one, which is the narrower grant this cardinality makes possible.
    const alpha = fakeWorkspace(mkroot(), { hash: "ws-alpha" });
    const beta = fakeWorkspace(mkroot(), { hash: "ws-beta" });
    const t = await alpha.taskStore.create({ title: "with attachments", author: "human" });
    const h = harness(alpha, beta);

    await openTask(h, "ws-alpha", t.id);

    const roots = (lastPanel().webview.options as { localResourceRoots?: Array<{ fsPath?: string; path?: string }> }).localResourceRoots ?? [];
    const paths = roots.map((r) => String(r.fsPath ?? r.path ?? r));
    expect(paths.some((p) => p.startsWith(alpha.workspaceRoot) && p.includes(path.join(".tachyon", "tasks", "attachments")))).toBe(true);
    expect(paths.some((p) => p.startsWith(beta.workspaceRoot))).toBe(false);
  });

  it("resolves an attachment: ref in the body to a webview-displayable URI", async () => {
    const root = mkroot();
    const ws = fakeWorkspace(root);
    const t = await ws.taskStore.create({ title: "with screenshot", author: "human" });
    const attStore = new TaskAttachmentStore(root, t.id);
    const att = attStore.putImage({ data: Buffer.from("png bytes"), mediaType: "image/png", name: "shot.png", source: "paste" });
    const body = `see ![shot](attachment:${att.id})`;
    new TaskDetailStore(root).write({
      schemaVersion: 1,
      taskId: t.id,
      doc: { type: "doc", content: [] },
      attachments: [att],
      bodyHash: hashBody(body),
      taskUpdatedAt: t.updatedAt,
    });
    await ws.taskStore.update(t.id, { body });
    const h = harness(ws);

    await openTask(h, ws.wsHash, t.id);

    const resolved = taskVms().at(-1)?.task?.body ?? "";
    expect(resolved).not.toContain(`attachment:${att.id}`);
    expect(resolved).toContain(attStore.blobPath(att.blobRef));
  });

  it("materializes the append-only journal into the detail VM", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "with notes", author: "human" });
    ws.taskStore.journal.append(t.id, { author: "codex", text: "note" });
    const h = harness(ws);

    await openTask(h, ws.wsHash, t.id);

    expect(taskVms().at(-1)?.journal).toEqual([expect.objectContaining({ author: "codex", text: "note" })]);
  });

  it("routes openTaskStudio to the injected callback for THIS document's task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "x", author: "human" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, t.id);

    lastPanel().webview.__receive({ type: "openTaskStudio" });
    await flush();

    expect(h.studioOpens()).toEqual([[ws.wsHash, t.id]]);
  });

  it("approves through first-party chrome and clears only an exact matching prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const snapshot = store.createDraft({ html: "<button>Proposal</button>", title: "Proposal", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const draft = snapshot.prototypes[0]!;
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review", kind: "decision", since: "2026-01-01T00:00:02.000Z", subject: { type: "task-prototype", prototypeId: draft.id } }, now: "2026-01-01T00:00:02.000Z" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, task.id);

    lastPanel().webview.__receive({ type: "approvePrototype", prototypeId: draft.id, expectUpdatedAt: snapshot.updatedAt, review: "Ship this layout" });
    await flush();

    expect(store.read().approved).toMatchObject({ id: draft.id, state: "approved", approvedBy: "human" });
    expect(ws.taskStore.get(task.id).awaitingHuman).toBeUndefined();
    expect(h.fanOuts()).toBe(1);
  });

  it("does not clear a mismatched awaitingHuman prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const first = store.createDraft({ html: "<p>One</p>", title: "One", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const second = store.createDraft({ html: "<p>Two</p>", title: "Two", author: "agent", now: "2026-01-01T00:00:02.000Z" });
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review one", kind: "decision", since: "2026-01-01T00:00:03.000Z", subject: { type: "task-prototype", prototypeId: first.prototypes[0]!.id } }, now: "2026-01-01T00:00:03.000Z" });
    const h = harness(ws);
    await openTask(h, ws.wsHash, task.id);

    lastPanel().webview.__receive({ type: "approvePrototype", prototypeId: second.prototypes.at(-1)!.id, expectUpdatedAt: second.updatedAt });
    await flush();

    expect(ws.taskStore.get(task.id).awaitingHuman?.subject?.prototypeId).toBe(first.prototypes[0]!.id);
  });
});
