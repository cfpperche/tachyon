import { Uri } from "vscode";
import type { CockpitDeps, CockpitMissionBoard } from "../../src/webview/Cockpit.js";

/**
 * Fake CockpitDeps for host-side Control tests, mirroring extension.ts's wiring shape.
 *
 * SDD 485 C4/C5 — the task detail's and the Board's own routing/behaviour tests moved OUT of here with the
 * surfaces: they drive `TaskDetailPanelManager` / `BoardPanelManager` directly (`taskDetailApp.test.ts`,
 * `boardPanel.test.ts`). `missionBoard` survives because Control still needs it for Validations' workspace
 * list and the studio hand-off.
 */
export function makeFakeCockpitDeps(missionBoard: CockpitMissionBoard, overrides: Partial<CockpitDeps> = {}): CockpitDeps {
  return {
    extensionUri: Uri.file("/ext"),
    collect: async () => [],
    missionBoard,
    // SDD 485 C4 — Control asks for a task's own editor tab and renders none itself; a test that cares
    // which (wsHash, taskId) it asked for overrides this.
    taskDetail: { getWorkspaces: () => [], openDocument: () => {} },
    activity: { getWorkspaces: () => [] },
    probes: { getWorkspaces: () => [] },
    handoff: { getWorkspaces: () => [] },
    studios: { getWorkspaces: () => [], onChanged: () => {} },
    approvals: { getWorkspaces: () => [], resolve: async () => {} },
    validations: { getWorkspaces: () => [], onValidationsChanged: () => {} },
    // SDD 485 C5 — Control opens the Board app instead of rendering it; a test that cares which project it
    // was handed overrides this.
    openBoard: () => {},
    openFleet: () => {},
    openRuntimeConfig: () => {},
    openExecutionGraph: () => {},
    // SDD 485 D1 — Control opens the tmux app instead of rendering it; a test that cares that it was asked
    // (rather than that Control navigated) overrides this.
    openTmux: () => {},
    // SDD 485 D2 — Control opens the Plugins app instead of rendering it; a test that cares which project
    // it was handed overrides this.
    openPlugins: () => {},
    // SDD 485 D3 — Control opens the Runtime Ops app instead of rendering it. No argument to override:
    // `window` cardinality means one panel for the window and nothing to key it on.
    openRuntimeOps: () => {},
    // SDD 485 D4 — Control opens the Human Inbox app instead of rendering it. Two doors rather than one,
    // because the item detail stayed a subroute INSIDE that app: a test that cares which project the
    // queue was opened for, or which item the deep link landed on, overrides these.
    openHumanInbox: () => {},
    openHumanInboxItem: () => {},
    openSettings: () => {},
    openOverview: () => {},
    openDoctor: () => {},
    revealPath: () => {},
    openConfigFile: async () => {},
    setCompanionTabTools: async () => {},
    setIdleAfterMinutes: async () => {},
    setCompanionAllowedHosts: async () => {},
    unpairCompanionDevice: async () => {},
    issueCompanionPairCode: async () => ({ ok: false as const, reason: "bridge_down" }),
    ...overrides,
  };
}
