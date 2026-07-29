import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __createdPanels, __resetVscodeMock, __getShownDocuments } from "../mocks/vscode.js";
import { openCockpit, type CockpitMissionBoard, type CockpitHandoff } from "../../src/webview/Cockpit.js";
import type { WorkspaceHandoffTarget } from "../../src/shell/HandoffTarget.js";
import type { HandoffProjectionV1 } from "../../src/runtime-api/handoffProjection.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { routes as cockpitRoutes } from "../../src/cockpit/route.js";

/**
 * t-610705 (SDD 410 Phase C.3) — Handoff ROUTING coverage for Control → Handoff section. Unlike
 * Fleet's subroutes (C.2), Handoff folds directly into a section (workspace-scoped like Approvals/
 * Validations, resolveHandoffWs's fallback chain), so there's no binding-generation lifecycle to
 * cover here — just the section-gated push + the openFile/distill actions ported from the retired
 * HandoffPanelManager.
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeSnapshot(overrides: Partial<HandoffProjectionV1> = {}): HandoffProjectionV1 {
  return {
    canonicalRelativePath: ".tachyon/HANDOFF.md",
    exists: true,
    body: "## Current State\n",
    staleness: "fresh",
    pendingCount: 0,
    updatedAt: "2026-07-21T00:00:00.000Z",
    updatedBy: "human",
    revision: "0123456789abcdef",
    notes: [],
    distillTargets: [{ name: "codex", description: "running · declared", state: "running", lifetime: "saved", resumePolicy: "restartable" }],
    ...overrides,
  };
}

function handoffTarget(overrides: Partial<WorkspaceHandoffTarget> = {}): WorkspaceHandoffTarget {
  return {
    workspaceRoot: "/repo",
    wsHash: "ws-1",
    folderName: "repo",
    loadHandoff: async () => fakeSnapshot(),
    ensureHandoffFile: async () => "/repo/.tachyon/HANDOFF.md",
    startHandoffDistill: async (input) => ({
      mode: input.mode,
      agent: input.mode === "existing" ? input.agent : "handoff-codex-test",
    }),
    ...overrides,
  } as WorkspaceHandoffTarget;
}

function depsFor(handoff: CockpitHandoff, hooks: Partial<CockpitMissionBoard> = {}) {
  const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {}, ...hooks };
  return makeFakeCockpitDeps(missionBoard, { handoff });
}

const handoffMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "handoff") as Array<{ vm: { folder: string; exists: boolean; body: string } }>;

async function openHandoff(deps: ReturnType<typeof depsFor>): Promise<void> {
  // t-ace77f — the sidebar's entry point opens the document as a detail route, not a tab.
  await openCockpit(deps, { route: cockpitRoutes.projectHandoff("ws-1") });
  __createdPanels[0].webview.__receive({ type: "ready" });
  await flush();
}

describe("Control → Project Handoff route (t-ace77f)", () => {
  it("opening the handoff section posts the loaded snapshot", async () => {
    const ws = handoffTarget({ loadHandoff: async () => fakeSnapshot({ body: "## Hello\n", pendingCount: 2 }) });
    const deps = depsFor({ getWorkspaces: () => [ws] });
    await openHandoff(deps);

    const msg = handoffMessages().at(-1);
    expect(msg?.vm.folder).toBe("repo");
    expect(msg?.vm.exists).toBe(true);
    expect(msg?.vm.body).toBe("## Hello\n");
  });

  it("no attached workspace leaves the section open but empty (no throw, no post)", async () => {
    const deps = depsFor({ getWorkspaces: () => [] });
    await expect(openCockpit(deps, { route: cockpitRoutes.projectHandoff("ws-1") })).resolves.not.toThrow();
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(handoffMessages()).toHaveLength(0);
  });

  it("a load failure notifies instead of posting an error VM", async () => {
    const ws = handoffTarget({ loadHandoff: async () => { throw new Error("disk gone"); } });
    const deps = depsFor({ getWorkspaces: () => [ws] });
    await openHandoff(deps);
    expect(handoffMessages()).toHaveLength(0);
  });

  it("openFile ensures the file exists, opens it beside, and re-posts the snapshot", async () => {
    const ws = handoffTarget();
    const deps = depsFor({ getWorkspaces: () => [ws] });
    await openHandoff(deps);
    const before = handoffMessages().length;

    __createdPanels[0].webview.__receive({ type: "openFile" });
    await flush();

    expect(__getShownDocuments()).toHaveLength(1);
    expect(__getShownDocuments()[0]?.uri.fsPath ?? __getShownDocuments()[0]?.uri).toContain("HANDOFF.md");
    expect(handoffMessages().length).toBe(before + 1);
  });

  it("distill dispatches to startHandoffDistill with a normalized existing-agent request", async () => {
    let captured: unknown;
    const ws = handoffTarget({
      startHandoffDistill: async (input) => {
        captured = input;
        return { mode: input.mode, agent: input.mode === "existing" ? input.agent : "x" };
      },
    });
    const deps = depsFor({ getWorkspaces: () => [ws] });
    await openHandoff(deps);

    __createdPanels[0].webview.__receive({ type: "distill", mode: "existing", agent: " codex ", instructions: "  concise  " });
    await flush();

    expect(captured).toEqual({ mode: "existing", agent: "codex", instructions: "concise" });
  });

  it("Overview's Handoff entry navigates to the document route (t-ace77f)", async () => {
    const ws = handoffTarget({ loadHandoff: async () => fakeSnapshot({ body: "# doc\n" }) });
    const deps = depsFor({ getWorkspaces: () => [ws] });
    // Control opens on a plain section — no Handoff tab exists to click any more.
    await openCockpit(deps, { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(handoffMessages()).toHaveLength(0);

    __createdPanels[0].webview.__receive({ type: "openProjectHandoff" });
    await flush();

    expect(handoffMessages().at(-1)?.vm.body).toBe("# doc\n");
  });

  it("keeps the document on the workspace its route names, not Control's current scope (t-ace77f)", async () => {
    const scoped = handoffTarget({ wsHash: "ws-1", folderName: "scoped" });
    const routed = handoffTarget({ wsHash: "ws-2", folderName: "routed" });
    const deps = depsFor({ getWorkspaces: () => [scoped, routed] });

    await openCockpit(deps, { route: cockpitRoutes.projectHandoff("ws-2") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    // `scoped` is what a bare fallback resolve would pick (first attached); the route's own locator wins.
    expect(handoffMessages().at(-1)?.vm.folder).toBe("routed");
  });

  it("leaving the section — a refresh no longer posts", async () => {
    const ws = handoffTarget();
    const deps = depsFor({ getWorkspaces: () => [ws] });
    await openHandoff(deps);

    await openCockpit(deps, { section: "mission" });
    await flush();
    const before = handoffMessages().length;

    __createdPanels[0].webview.__receive({ type: "refresh" });
    await flush();

    expect(handoffMessages().length).toBe(before);
  });
});
