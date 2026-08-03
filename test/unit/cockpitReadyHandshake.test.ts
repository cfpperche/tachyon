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
import { COCKPIT_SECTION_ORDER } from "../../src/cockpit/model.js";
import { STUDIO_IDS } from "../../src/cockpit/studioIds.js";
import type { CockpitRoute } from "../../src/cockpit/route.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

/**
 * `t-6ced6f` — a bare `ready` must come back as `init` on EVERY route the Control can open.
 *
 * `ready` (spec 278) is the SHELL's handshake, and the `init` it earns is the only source of
 * `strings`. Without it cockpit/App.tsx renders `if (!s) return <div class="ds-empty" />` — a Control
 * tab that is entirely blank, with no route mounted inside it to report anything.
 *
 * That handshake used to be answered at the BOTTOM of the message listener, behind nine per-route
 * handlers that each may `return true` and end dispatch. Three of them swallowed it, through three
 * different doors, and each was fixed alone:
 *
 *   - t-3990c3 — `handleValidationsAction` returned true for EVERY message when no workspace had
 *     validations (`if (!ws) return true`), so Control never initialized;
 *   - `handleHandoffAction` — still carries a comment warning that it must not handle it;
 *   - t-2f6cdd — `handleTaskDetailAction` answered it deliberately, so a panel opened straight onto
 *     task-detail (what the Attention card's "Open" creates) never initialized.
 *
 * Nothing stopped a fourth. This is the test for the CLASS rather than for a fourth instance: the
 * table below is DERIVED from the shipped inventories (`COCKPIT_SECTION_ORDER`, `STUDIO_IDS`) plus
 * the non-section route kinds, so a new section or studio is covered the day it is added instead of
 * the day someone remembers to add a case here.
 *
 * `cockpitTaskDetailShellHandshake.test.ts` (t-2f6cdd) stays as the deep single-route proof: it also
 * checks the task payload, its ordering after `model`, and the multi-root wsHash. This file is the
 * breadth counterpart and asserts only the handshake itself.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-ready-handshake-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeWorkspace() {
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
  // SDD 485 C4 — a task-detail route no longer commits in Control: `navigate()` asks for the task's own
  // editor tab and lands Control on the Board. It is still in the table below, because the handshake must
  // survive being opened ON it — that redirect is exactly the kind of extra hop a shell handshake gets
  // lost in.
  const taskDetail: CockpitTaskDetail = { getWorkspaces: () => [legacyTaskDetailTarget(ws)], openDocument: () => {} };
  return makeFakeCockpitDeps(missionBoard, { taskDetail });
}

/**
 * Every route kind the Control can be opened ON, derived rather than transcribed.
 *
 * Sections and studios expand from their own inventories; the detail routes are listed because each
 * needs a different set of identifying fields, and there is no runtime list of "route kinds with
 * their required arguments" to derive those from. The exhaustiveness check below is what keeps that
 * hand-written half honest.
 */
function routeTable(ws: Workspace, taskId: string): { label: string; route: CockpitRoute }[] {
  const wsHash = ws.wsHash;
  return [
    ...COCKPIT_SECTION_ORDER.map((section) => ({
      label: `section:${section}`,
      route: { kind: "section", section } as CockpitRoute,
    })),
    { label: "task-detail", route: { kind: "task-detail", wsHash, taskId } as CockpitRoute },
    { label: "project-handoff", route: { kind: "project-handoff", wsHash } as CockpitRoute },
    { label: "agent-activity", route: { kind: "agent-activity", wsHash, agent: "reviewer" } as CockpitRoute },
    { label: "agent-probes", route: { kind: "agent-probes", wsHash, agent: "reviewer" } as CockpitRoute },
    { label: "workspace-probes", route: { kind: "workspace-probes", wsHash } as CockpitRoute },
    // t-e76acc's Human Inbox item. It was NOT in this table when the file was written, and the
    // exhaustiveness check above is what found it — which is the argument for deriving the check
    // instead of trusting the list that a task description happened to enumerate.
    ...(["approval", "validation"] as const).map((itemKind) => ({
      label: `inbox-item:${itemKind}`,
      route: { kind: "inbox-item", wsHash, itemKind, itemId: "i-1" } as CockpitRoute,
    })),
    ...STUDIO_IDS.map((studio) => ({
      label: `studio-new:${studio}`,
      route: { kind: "studio-new", studio, wsHash } as CockpitRoute,
    })),
    ...STUDIO_IDS.map((studio) => ({
      label: `studio-edit:${studio}`,
      route: { kind: "studio-edit", studio, wsHash, entityId: studio === "task" ? taskId : "e-1" } as CockpitRoute,
    })),
  ];
}

describe("t-6ced6f — a bare `ready` returns `init` on every Control route kind", () => {
  it("covers every route kind in the union, so a new kind cannot slip past this table", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "t", author: "human" });
    const covered = new Set(routeTable(ws, t.id).map(({ route }) => route.kind));

    // The union's own members. If a kind is added to CockpitRoute and not to the table, this fails
    // — which is the difference between a table that stays current and one that quietly rots.
    const declared = fs
      .readFileSync(path.join(process.cwd(), "src", "cockpit", "route.ts"), "utf8")
      .matchAll(/readonly kind: "([a-z-]+)"/g);
    const kinds = [...declared].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(5);
    expect([...new Set(kinds)].sort()).toEqual([...covered].sort());
  });

  it("every section, detail route and studio answers a bare `ready` with init+strings", async () => {
    const ws = fakeWorkspace();
    const t = await ws.taskStore.create({ title: "a task to open", author: "human" });
    const failures: string[] = [];

    for (const { label, route } of routeTable(ws, t.id)) {
      __resetVscodeMock();
      await openCockpit(depsFor(ws), { route });
      const panel = __createdPanels[0];
      if (!panel) {
        failures.push(`${label}: no panel was created`);
        continue;
      }
      // The bare handshake, exactly as the client sends it on load — no route-specific fields.
      panel.webview.__receive({ type: "ready" });
      await flush();

      const init = panel.webview.posted.find((m) => (m as { type?: string }).type === "init") as
        | { strings?: Record<string, unknown> }
        | undefined;
      const seen = panel.webview.posted.map((m) => (m as { type?: string }).type ?? "").join(",");
      if (!init) failures.push(`${label}: no init posted (saw: ${seen || "nothing"})`);
      else if (!init.strings) failures.push(`${label}: init posted without strings`);
      if (!panel.disposed) panel.dispose();
    }

    // One assertion listing every broken route beats failing on the first: the point is to see the
    // whole shape of a regression, since these break in groups when a shared handler swallows.
    expect(failures, "these routes opened a Control tab that would render ds-empty").toEqual([]);
  });

  it("claims only the BARE ready — an enveloped one belongs to the studio", async () => {
    /**
     * The other half of the boundary, and the one that bites back. The studio protocol reuses the
     * same wire string for its per-mount handshake, `envelope({ type: "ready", routeKey, mountNonce })`.
     * Hoisting on `type` alone therefore swallowed the studios' handshake — the identical defect this
     * task closes, aimed the other way. Writing it down here as behavior keeps the guard above from
     * being "simplified" back into a bare type check.
     */
    const ws = fakeWorkspace();
    await openCockpit(depsFor(ws), { route: { kind: "studio-new", studio: "command", wsHash: ws.wsHash } as CockpitRoute });
    const panel = __createdPanels[0];
    panel.webview.__receive({ type: "ready" }); // the shell's own — earns init
    await flush();
    const before = panel.webview.posted.length;

    // A studio-scoped ready must NOT be answered with another shell init; it is the studio's to bind.
    panel.webview.__receive({ type: "ready", studioProtocolVersion: 1, routeKey: "studio-new:command:ws-1", mountNonce: "n" });
    await flush();
    const inits = panel.webview.posted.filter((m) => (m as { type?: string }).type === "init");
    expect(inits, "the shell answered a studio-scoped ready as if it were its own").toHaveLength(1);
    expect(panel.webview.posted.length).toBeGreaterThanOrEqual(before);
  });

  it("answers `ready` before any per-route handler can consume it", async () => {
    // The structural property, not just its effect. A handler that returns true ends dispatch, so if
    // READY were still answered after the chain, one swallowing handler would be enough — this is
    // what the three prior bugs had in common. Asserting the ORDER keeps the fix from being undone
    // by a later "just move it back down with a guard".
    const source = fs.readFileSync(path.join(process.cwd(), "src", "webview", "Cockpit.ts"), "utf8");
    const listener = source.indexOf("live.webview.onDidReceiveMessage");
    // Anchored on the condition, not the whole line: the studio carve-out below already changed this
    // line once, and a guard that breaks when the fix is refined teaches people to delete the guard.
    const readyAnswer = source.indexOf("type === READY", listener);
    // SDD 485 C4 — `handleTaskDetailAction` was the first link in this chain and left with the task
    // detail. `handleMissionAction` is the first link now; the property under test is the ORDER, not
    // which handler happens to be first.
    const firstRouteHandler = source.indexOf("if (await handleMissionAction(", listener);

    expect(listener, "the message listener moved; this guard needs updating").toBeGreaterThan(-1);
    expect(readyAnswer, "READY is no longer answered directly in the listener").toBeGreaterThan(-1);
    expect(firstRouteHandler).toBeGreaterThan(-1);
    expect(readyAnswer, "READY must be answered BEFORE the per-route dispatch chain").toBeLessThan(firstRouteHandler);
  });
});
