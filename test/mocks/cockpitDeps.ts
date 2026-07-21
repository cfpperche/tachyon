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
    approvals: { getWorkspaces: () => [], resolve: async () => {} },
    validations: { getWorkspaces: () => [], onValidationsChanged: () => {} },
    runtimeOps: { buildSnapshot: () => ({ generatedAt: "", providers: [] }) as unknown as RuntimeOpsSnapshot },
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
    fleetTerminal: async () => {},
    fleetActivity: () => {},
    revealPath: () => {},
    openConfigFile: async () => {},
    clearEngineLog: async () => {},
    openEngineJournal: () => {},
    ...overrides,
  };
}
