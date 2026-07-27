import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { openCockpit, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { WorkspaceProbePresentationTarget } from "../../src/shell/WorkspacePresentation.js";
import type { WorkspaceStudioTarget } from "../../src/shell/WorkspacePresentation.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

/**
 * t-610705 (SDD 410 Phase D, D1c) — Fleet's own "Probes" and "Edit" buttons (previously only
 * reachable via the agent-less `tachyon.openProbes` command / the sidebar tree's context menu).
 * Same routing-coverage shape as cockpitActivity.test.ts's fleetActivity coverage.
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} };

function lastModel(): { activeRoute?: { kind?: string; studio?: string; wsHash?: string; agent?: string; entityId?: string } } | undefined {
  const models = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model") as Array<{ model: { activeRoute?: unknown } }>;
  return models.at(-1)?.model as never;
}

function probesWs(overrides: Partial<WorkspaceProbePresentationTarget> = {}): WorkspaceProbePresentationTarget {
  return { workspaceRoot: "/repo", wsHash: "ws-1", folderName: "repo", ...overrides } as WorkspaceProbePresentationTarget;
}

function studioWs(config: TachyonConfig, overrides: Partial<WorkspaceStudioTarget> = {}): WorkspaceStudioTarget {
  return {
    workspaceRoot: "/repo",
    wsHash: "ws-1",
    folderName: "repo",
    config,
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => [],
      commandNames: () => [],
      verifyCandidates: () => [],
      defaultCwd: "/repo",
      suggestKindForCommand: () => "agent",
      onSubmit: () => undefined,
    }),
    studioSubmit: () => undefined,
    ...overrides,
  } as unknown as WorkspaceStudioTarget;
}

describe("Fleet Probes button", () => {
  it("navigates to the agent-probes subroute for the resolved workspace", async () => {
    const deps = makeFakeCockpitDeps(missionBoard, { probes: { getWorkspaces: () => [probesWs()] } });
    await openCockpit(deps, { section: "fleet" });
    __createdPanels[0].webview.__receive({ type: "fleetProbes", name: "claude", wsHash: "ws-1" });
    await flush();
    expect(lastModel()?.activeRoute).toMatchObject({ kind: "agent-probes", wsHash: "ws-1", agent: "claude" });
  });
});

describe("Fleet Edit (Agent Studio) button", () => {
  it("navigates to studio-edit:agent for a declared agent-kind entry", async () => {
    const config = { agents: { claude: { cmd: "claude", kind: "agent", watch: [], autostart: false, restart: "never", attention: { enabled: true } } } } as unknown as TachyonConfig;
    const deps = makeFakeCockpitDeps(missionBoard, { studios: { getWorkspaces: () => [studioWs(config)], onChanged: () => {} } });
    await openCockpit(deps, { section: "fleet" });
    __createdPanels[0].webview.__receive({ type: "fleetAgentStudio", name: "claude", wsHash: "ws-1" });
    await flush();
    expect(lastModel()?.activeRoute).toMatchObject({ kind: "studio-edit", studio: "agent", wsHash: "ws-1", entityId: "claude" });
  });

  it("navigates to studio-edit:terminal for a declared terminal-kind entry", async () => {
    const config = { agents: { dev: { cmd: "npm run dev", kind: "terminal", watch: [], autostart: false, restart: "never", attention: { enabled: false } } } } as unknown as TachyonConfig;
    const deps = makeFakeCockpitDeps(missionBoard, { studios: { getWorkspaces: () => [studioWs(config)], onChanged: () => {} } });
    await openCockpit(deps, { section: "fleet" });
    __createdPanels[0].webview.__receive({ type: "fleetAgentStudio", name: "dev", wsHash: "ws-1" });
    await flush();
    expect(lastModel()?.activeRoute).toMatchObject({ kind: "studio-edit", studio: "terminal", wsHash: "ws-1", entityId: "dev" });
  });

  it("does not navigate for an undeclared (ad-hoc) agent — re-checked authoritatively, not just trusting the client's own gate", async () => {
    const config = { agents: {} } as unknown as TachyonConfig;
    const deps = makeFakeCockpitDeps(missionBoard, { studios: { getWorkspaces: () => [studioWs(config)], onChanged: () => {} } });
    await openCockpit(deps, { section: "fleet" });
    // t-610705 (Phase D, D1c) — checking `lastModel()?.activeRoute` alone would pass even if this
    // handler silently did nothing for an unrelated reason (no model ever gets an activeRoute on the
    // "fleet" section either way) — count model pushes before/after instead, so a REAL navigation
    // (which always triggers a fresh sendModel() via requestNavigate's commit) would be caught.
    const modelCountBefore = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").length;
    __createdPanels[0].webview.__receive({ type: "fleetAgentStudio", name: "ephemeral", wsHash: "ws-1" });
    await flush();
    const modelCountAfter = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").length;
    expect(modelCountAfter).toBe(modelCountBefore);
    expect(lastModel()?.activeRoute).toBeUndefined();
  });

  it("rejects an inherited Object.prototype property name instead of navigating to a bogus entity (code-review finding)", async () => {
    const config = { agents: {} } as unknown as TachyonConfig;
    const deps = makeFakeCockpitDeps(missionBoard, { studios: { getWorkspaces: () => [studioWs(config)], onChanged: () => {} } });
    await openCockpit(deps, { section: "fleet" });
    const modelCountBefore = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").length;
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      __createdPanels[0].webview.__receive({ type: "fleetAgentStudio", name, wsHash: "ws-1" });
    }
    await flush();
    const modelCountAfter = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").length;
    expect(modelCountAfter).toBe(modelCountBefore);
    expect(lastModel()?.activeRoute).toBeUndefined();
  });
});
