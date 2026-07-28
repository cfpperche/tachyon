import { Uri } from "vscode";
import type { CockpitDeps, CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { PluginsPanelManager } from "../../src/webview/PluginsPanel.js";
import type { RuntimeOpsSnapshot } from "../../src/runtimeOps/types.js";

/**
 * t-610705 Phase B #6 — fake CockpitDeps for host-side Control tests. The standalone Board panel
 * manager is retired, so board routing/behavior tests drive openCockpit (section "mission") with
 * these deps, mirroring extension.ts's wiring shape.
 */
export function makeFakeCockpitDeps(missionBoard: CockpitMissionBoard, overrides: Partial<CockpitDeps> = {}): CockpitDeps {
  return {
    extensionUri: Uri.file("/ext"),
    collect: async () => [],
    missionBoard,
    taskDetail: { getWorkspaces: () => [] },
    activity: { getWorkspaces: () => [] },
    probes: { getWorkspaces: () => [] },
    handoff: { getWorkspaces: () => [] },
    studios: { getWorkspaces: () => [], onChanged: () => {} },
    approvals: { getWorkspaces: () => [], resolve: async () => {} },
    validations: { getWorkspaces: () => [], onValidationsChanged: () => {} },
    runtimeOps: { buildSnapshot: () => ({ generatedAt: "", providers: [] }) as unknown as RuntimeOpsSnapshot },
    runtimeConfig: { buildSnapshot: () => undefined, openSource: async () => {}, saveChanges: async () => {} },
    inspector: {
      snapshot: async () => [],
      folderByHash: () => new Map(),
      cpuBusy: () => new Map(),
      serverHealth: async () => ({ state: "unknown" }) as never,
      capture: async () => "",
      open: () => {},
      kill: async () => {},
      reapDead: async () => 0,
      reapOrphans: async () => 0,
    },
    plugins: new PluginsPanelManager(Uri.file("/ext"), () => []),
    openSettings: () => {},
    openDoctor: () => {},
    fleetStart: async () => {},
    fleetStop: async () => {},
    fleetContinueTask: async (_from, _to) => {},
    fleetTerminal: async () => {},
    revealPath: () => {},
    worktreeRemove: async () => undefined,
    worktreeForgetRecord: async () => undefined,
    openConfigFile: async () => {},
    clearEngineLog: async () => {},
    openEngineJournal: () => {},
    setCompanionTabTools: async () => {},
    setIdleAfterMinutes: async () => {},
    setCompanionAllowedHosts: async () => {},
    unpairCompanionDevice: async () => {},
    issueCompanionPairCode: async () => ({ ok: false as const, reason: "bridge_down" }),
    ...overrides,
  };
}
