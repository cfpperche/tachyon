import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { TaskDetailStore, hashBody } from "../../src/tasks/TaskDetailStore.js";
import { TaskAttachmentStore } from "../../src/tasks/TaskAttachmentStore.js";
import { TaskDetailPanelManager } from "../../src/webview/TaskDetailPanel.js";
import { TaskPrototypeStore } from "../../src/tasks/TaskPrototypeStore.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-detail-panel-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeWorkspace(root = mkroot()) {
  return { wsHash: "ws-1", folderName: "Project", workspaceRoot: root, taskStore: new TaskStore(root) } as unknown as Workspace;
}

function lastVm(): { vm: { tombstone: boolean; task?: { title: string; body?: string }; journal: Array<{ author: string; text: string }>; deps: unknown[] } } {
  const msgs = __createdPanels[__createdPanels.length - 1].webview.posted.filter((m) => (m as { type?: string }).type === "task");
  return msgs[msgs.length - 1] as { vm: { tombstone: boolean; task?: { title: string; body?: string }; journal: Array<{ author: string; text: string }>; deps: unknown[] } };
}

describe("TaskDetailPanelManager", () => {
  it("opens one tab per task id and reveals on re-open", async () => {
    const ws = fakeWorkspace();
    const a = await ws.taskStore.create({ title: "a", author: "human" });
    const b = await ws.taskStore.create({ title: "b", author: "human" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});

    manager.open(ws, a.id);
    manager.open(ws, b.id);
    manager.open(ws, a.id);

    expect(__createdPanels).toHaveLength(2);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("resolves deps to linked task title/status, and marks dangling deps as missing", async () => {
    const ws = fakeWorkspace();
    const dep = await ws.taskStore.create({ title: "dependency", author: "human" });
    const t = await ws.taskStore.create({ title: "root", author: "human", deps: [dep.id, "t-ffffff"] });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});

    manager.open(ws, t.id);

    const vm = lastVm().vm;
    expect(vm.deps).toContainEqual({ id: dep.id, title: "dependency", status: "inbox", missing: false });
    expect(vm.deps).toContainEqual({ id: "t-ffffff", missing: true });
  });

  it("applies a quick-control update through the CAS expect and refreshes the board", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "edit me", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged" });
    let boardRefreshed = 0;
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => { boardRefreshed += 1; });
    manager.open(ws, t.id);

    const startUpdatedAt = ws.taskStore.get(t.id).updatedAt;
    __createdPanels[0].webview.__receive({ type: "updateTask", patch: { assignee: "codex", expect: { updatedAt: startUpdatedAt } } });
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.taskStore.get(t.id).assignee).toBe("codex");
    expect(boardRefreshed).toBe(1);
  });

  it("surfaces a CAS failure as a taskError without corrupting the task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "stale edit", author: "human" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, t.id);

    __createdPanels[0].webview.__receive({ type: "updateTask", patch: { title: "late", expect: { updatedAt: "2000-01-01T00:00:00.000Z" } } });
    await new Promise((r) => setTimeout(r, 0));

    const errMsg = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "taskError") as { message: string };
    expect(errMsg.message).toMatch(/precondition-failed/);
    expect(ws.taskStore.get(t.id).title).toBe("stale edit");
  });

  it("never disposes the panel when the task file disappears — renders a tombstone from the last known state", async () => {
    const root = mkroot();
    const ws = fakeWorkspace(root);
    const t = await ws.taskStore.create({ title: "vanishing", author: "human" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, t.id);
    expect(lastVm().vm.tombstone).toBe(false);

    fs.rmSync(ws.taskStore.pathFor(t.id));
    manager.refreshAll();

    expect(__createdPanels[0].disposed).toBe(false);
    const vm = lastVm().vm;
    expect(vm.tombstone).toBe(true);
    expect(vm.task?.title).toBe("vanishing"); // last known state, not blank
  });

  it("keeps a Done task's tab open and live (independent of any board filter)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "finished", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged", assignee: "codex" });
    await ws.taskStore.update(t.id, { status: "active" });
    await ws.taskStore.update(t.id, { status: "done" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});

    manager.open(ws, t.id);
    manager.refreshAll();

    expect(__createdPanels[0].disposed).toBe(false);
    expect(lastVm().vm.task?.title).toBe("finished");
  });

  // spec 339 — the detail tab's "Open in Studio" button.
  it("routes openTaskStudio to the injected callback for THIS panel's own task", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "x", author: "human" });
    let opened: [Workspace, string] | undefined;
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), (w, id) => { opened = [w, id]; }, () => {});
    manager.open(ws, t.id);

    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    expect(opened?.[0].wsHash).toBe(ws.wsHash);
    expect(opened?.[1]).toBe(t.id);
  });

  // dogfood round 1 (#4, spec 339) — Studio takes over; the originating detail tab must close, unlike the
  // tombstone/Done cases above which deliberately keep the tab alive.
  it("disposes its own panel after routing openTaskStudio (Studio takes over)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "x", author: "human" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, t.id);

    __createdPanels[0].webview.__receive({ type: "openTaskStudio" });
    expect(__createdPanels[0].disposed).toBe(true);
  });

  // dogfood round 1 (#5, spec 339) — a screenshot attached in Studio used to render as a broken image here,
  // because the body's logical `attachment:<id>` ref was sent to the webview verbatim (only Studio resolved
  // it). Read-only: resolves against the sidecar's own attachment list.
  it("resolves an attachment: ref in the body to a webview-displayable URI, from the sidecar (read-only)", async () => {
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

    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, t.id);

    const resolvedBody = lastVm().vm.task?.body ?? "";
    expect(resolvedBody).not.toContain(`attachment:${att.id}`);
    expect(resolvedBody).toContain(attStore.blobPath(att.blobRef));
  });

  it("leaves the body untouched when the sidecar has no matching attachment (unresolvable ref stays as-is)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "orphan ref", author: "human", body: "![x](attachment:missing)" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});

    manager.open(ws, t.id);

    expect(lastVm().vm.task?.body).toBe("![x](attachment:missing)");
  });

  it("materializes the append-only journal into the detail VM", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "with notes", author: "human" });
    ws.taskStore.journal.append(t.id, { author: "codex", text: "<script>alert(1)</script>\n[bad](javascript:alert(1))" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});

    manager.open(ws, t.id);

    expect(lastVm().vm.journal).toEqual([
      expect.objectContaining({ author: "codex", text: "<script>alert(1)</script>\n[bad](javascript:alert(1))" }),
    ]);
  });

  it("approves through first-party chrome and clears only an exact matching prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const snapshot = store.createDraft({ html: "<button>Proposal</button>", title: "Proposal", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const draft = snapshot.prototypes[0]!;
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review", kind: "decision", since: "2026-01-01T00:00:02.000Z", subject: { type: "task-prototype", prototypeId: draft.id } }, now: "2026-01-01T00:00:02.000Z" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, task.id);

    __createdPanels[0].webview.__receive({ type: "approvePrototype", prototypeId: draft.id, expectUpdatedAt: snapshot.updatedAt, review: "Ship this layout" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.read().approved).toMatchObject({ id: draft.id, state: "approved", approvedBy: "human" });
    expect(ws.taskStore.get(task.id).awaitingHuman).toBeUndefined();
  });

  it("does not clear a mismatched awaitingHuman prototype subject", async () => {
    const ws = fakeWorkspace();
    const task = await ws.taskStore.create({ title: "decision", author: "human", now: "2026-01-01T00:00:00.000Z" });
    const store = new TaskPrototypeStore(ws.workspaceRoot, task.id);
    const first = store.createDraft({ html: "<p>One</p>", title: "One", author: "agent", now: "2026-01-01T00:00:01.000Z" });
    const second = store.createDraft({ html: "<p>Two</p>", title: "Two", author: "agent", now: "2026-01-01T00:00:02.000Z" });
    await ws.taskStore.update(task.id, { awaitingHuman: { reason: "Review one", kind: "decision", since: "2026-01-01T00:00:03.000Z", subject: { type: "task-prototype", prototypeId: first.prototypes[0]!.id } }, now: "2026-01-01T00:00:03.000Z" });
    const manager = new TaskDetailPanelManager(Uri.file("/ext"), () => {}, () => {});
    manager.open(ws, task.id);

    __createdPanels[0].webview.__receive({ type: "approvePrototype", prototypeId: second.prototypes.at(-1)!.id, expectUpdatedAt: second.updatedAt });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.taskStore.get(task.id).awaitingHuman?.subject?.prototypeId).toBe(first.prototypes[0]!.id);
  });
});
