import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { openCockpit, type CockpitMissionBoard, type CockpitTaskDetail } from "../../src/webview/Cockpit.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-2f6cdd — human report: a task flagged `awaiting_human` shows an Attention card in the sidebar,
 * and its "Open" button opens a Control tab that renders NOTHING. Reproduced end-to-end in a real
 * headless Dev Host (real `flag_for_human` from an agent-authenticated caller, real click on the
 * card): `#root` held exactly `<div class="ds-empty"></div>`.
 *
 * That is cockpit/App.tsx's `if (!s) return <div class="ds-empty" />` — the Control SHELL with no
 * `strings`. `strings` has exactly one source: the `init` message, posted only by the cockpit's
 * `case READY:`, which also runs sendModel() and sendSectionModule(). But `handleTaskDetailAction`
 * runs FIRST in the dispatch chain and used to answer READY itself and `return true`, so a panel
 * whose FIRST route is task-detail — precisely what "Open" creates — consumed its one handshake
 * there and never reached the shell's. Nothing about the detail's own render states was involved:
 * the shell never mounted the route at all, which is why "Loading task…", "never found on disk" and
 * the tombstone banner were all absent (see cockpitTaskDetailRenderStates.test.ts for the proof that
 * those states DO always paint something).
 *
 * Both assertions below fail with `m.type === READY ||` restored to that branch, and both pass
 * without it — the fail-before/pass-after pair for the fix, exercised through the real cockpit host
 * rather than scanned for in source.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-shell-handshake-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace(opts: { hash?: string; name?: string } = {}) {
  const root = mkroot();
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
  } as unknown as Workspace;
}

function depsFor(...all: Workspace[]) {
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => all.map((w) => legacyMissionControlTarget(w)),
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => all.map((w) => legacyTaskDetailTarget(w)) };
  return makeFakeCockpitDeps(missionBoard, { taskDetail });
}

const postedTypes = (): string[] =>
  __createdPanels[0].webview.posted.map((m) => (m as { type?: string }).type ?? "");

describe("t-2f6cdd: a Control panel opened straight onto task-detail still completes the SHELL handshake", () => {
  it("answers the webview's READY with init (the strings the shell renders from)", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flagged for a human", author: "human" });

    // exactly what the Attention card's Open does: create the panel already on the detail route.
    await openCockpit(depsFor(ws), { route: { kind: "task-detail", wsHash: ws.wsHash, taskId: t.id } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const init = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "init") as
      | { strings?: Record<string, unknown> }
      | undefined;
    // Without init the client's `strings` stays undefined and the whole shell renders `ds-empty` —
    // the blank tab that was reported, with no route mounted inside it.
    expect(init, `no init posted; got ${JSON.stringify(postedTypes())}`).toBeDefined();
    expect(init?.strings).toBeTruthy();
  });

  it("still delivers the task itself on that same READY, via the shell's section dispatch", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "flagged for a human", author: "human" });

    await openCockpit(depsFor(ws), { route: { kind: "task-detail", wsHash: ws.wsHash, taskId: t.id } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    // Falling through to `case READY:` must not cost the detail its content: sendSectionModule()
    // already routes a task-detail route to sendTaskDetail(). Ordering matters too — the client only
    // accepts a TASK whose identity matches the active route (t-9993cc), which it learns from the
    // model, so the model must precede the task.
    const types = postedTypes();
    const task = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "task") as
      | { vm?: { id?: string; task?: { title?: string } } }
      | undefined;
    expect(task, `no task posted; got ${JSON.stringify(types)}`).toBeDefined();
    expect(task?.vm?.id).toBe(t.id);
    expect(task?.vm?.task?.title).toBe("flagged for a human");
    expect(types.indexOf("model")).toBeGreaterThan(-1);
    expect(types.indexOf("model")).toBeLessThan(types.indexOf("task"));
  });

  it("completes the handshake against the root the route names, not the first folder (multi-root)", async () => {
    // The Attention card's Open pins the wsHash of the folder that raised it, which in a multi-root
    // window is often not the first one. The shell handshake must complete there too, and the detail
    // that comes back must be the SECOND root's task — a first-folder fallback would render a
    // stranger's task under the card the human clicked.
    const alpha = fakeWorkspace({ hash: "ws-alpha", name: "Alpha" });
    const beta = fakeWorkspace({ hash: "ws-beta", name: "Beta" });
    await alpha.taskStore.create({ title: "alpha's own task", author: "human" });
    const target = await beta.taskStore.create({ title: "beta needs a human", author: "human" });

    await openCockpit(depsFor(alpha, beta), { route: { kind: "task-detail", wsHash: beta.wsHash, taskId: target.id } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const init = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "init");
    expect(init, `no init posted; got ${JSON.stringify(postedTypes())}`).toBeDefined();

    const task = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "task") as
      | { vm?: { wsHash?: string; id?: string; tombstone?: boolean; task?: { title?: string } } }
      | undefined;
    expect(task?.vm?.wsHash).toBe("ws-beta");
    expect(task?.vm?.id).toBe(target.id);
    expect(task?.vm?.task?.title).toBe("beta needs a human");
    expect(task?.vm?.tombstone).toBe(false);
  });
});
