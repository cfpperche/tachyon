import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { openCockpit, type CockpitMissionBoard, type CockpitTaskDetail } from "../../src/webview/Cockpit.js";
import { isCockpitSingletonClaimed } from "../../src/webview/cockpitSingleton.js";
import { legacyTaskDetailTarget } from "../../src/shell/TaskDetailTarget.js";
import { legacyMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * t-a632eb — is a live Control torn down by a SUPERSEDED panel's disposal?
 *
 * The shape comes from the restore path, not from a click: `extension.ts:1978-1983` registers a
 * serializer for the retired TaskDetail panel that calls `panel.dispose()` and then `openCockpit(…)`,
 * while `extension.ts:2067` revives Control itself with `revivedPanel`. VS Code does not order
 * multiple revivals, so one Control panel can be superseded by another and dispose afterwards.
 *
 * `Cockpit.ts`'s `onDidDispose` guards with `if (panel)` — truthiness, not identity — and `panel` is
 * module-scoped. The question this answers is whether that guard lets the OLD panel's disposal null
 * the LIVE panel's wiring, bump `navEpoch`, reset the route and release the singleton claim.
 *
 * The revived panel is a REAL mock panel, not a shallow copy: an earlier attempt copied the object
 * and its message handlers stayed bound to the original, so it never completed a handshake and the
 * test failed for harness reasons rather than for the defect.
 */

const roots: string[] = [];
function mkroot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-superseded-"));
  roots.push(root);
  return root;
}

function fakeWorkspace(): Workspace {
  const root = mkroot();
  return {
    wsHash: "ws-1",
    folderName: "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
  } as unknown as Workspace;
}

function depsFor(ws: Workspace) {
  const missionBoard: CockpitMissionBoard = {
    getWorkspaces: () => [legacyMissionControlTarget(ws)],
    openTaskStudio: () => {},
    onTasksChanged: () => {},
  };
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => [legacyTaskDetailTarget(ws)] };
  return makeFakeCockpitDeps(missionBoard, { taskDetail });
}

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 30));
const modelsOn = (p: (typeof __createdPanels)[number]): number =>
  p.webview.posted.filter((m) => (m as { type?: string })?.type === "model").length;

describe("Cockpit — a superseded panel's disposal (t-a632eb)", () => {
  it("does not let an OLD panel's disposal tear down the LIVE Control", async () => {
    const ws = fakeWorkspace();

    // 1. The Control the retired-panel shim opened during restore.
    await openCockpit(depsFor(ws), { section: "overview", wsHash: ws.wsHash });
    const first = __createdPanels.at(-1)!;
    first.webview.__receive({ type: "ready" });
    await settle();
    expect(modelsOn(first), "precondition: the first Control was working").toBeGreaterThan(0);

    // 2. Control's OWN serializer revives afterwards with a real, independently wired panel.
    const revived = vscode.window.createWebviewPanel("tachyon.cockpit", "Control", 1, {}) as never;
    await openCockpit(depsFor(ws), { revivedPanel: revived, section: "overview", wsHash: ws.wsHash });
    const live = __createdPanels.at(-1)!;
    expect(live, "the revived panel is the live one").not.toBe(first);
    live.webview.__receive({ type: "ready" });
    await settle();
    const beforeDispose = modelsOn(live);
    expect(beforeDispose, "precondition: the live Control received a model BEFORE the dispose").toBeGreaterThan(0);
    expect(isCockpitSingletonClaimed()).toBe(true);

    // 3. The superseded panel disposes late, as VS Code does it.
    first.dispose();
    await settle();

    // 4. The live Control must still be wired: a later navigation must still reach it. When the
    //    guard is truthiness-based this is where it dies — `panel` was nulled by a panel that is
    //    not the live one, so the model built for this navigation is dropped and every section of
    //    the shell falls to "No Tachyon workspace attached in this window."
    await openCockpit(depsFor(ws), { section: "engine", wsHash: ws.wsHash });
    await settle();
    expect(modelsOn(live), "live Control still receives models after an old panel's dispose")
      .toBeGreaterThan(beforeDispose);
    expect(isCockpitSingletonClaimed(), "the live Control still holds the singleton claim").toBe(true);
  });
});
