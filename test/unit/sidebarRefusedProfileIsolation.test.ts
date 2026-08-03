import { expect, it } from "vitest";
import { buildSidebarFleet, type SidebarFleetSource } from "../../src/sidebar/sidebarFleetService.js";

const REASON = "profile/schema: schemaVersion: Invalid literal value, expected 1";

function source(): SidebarFleetSource {
  return {
    workspaceRoot: "/workspace",
    wsHash: "ws",
    folderName: "workspace",
    bridge: { port: 4317, url: "http://127.0.0.1:4317" },
    manager: {
      list: async () => [
        { name: "healthy", running: true, dead: false, crashed: false, kind: "agent", lifetime: "saved", resumePolicy: "restartable" },
        { name: "broken", running: false, dead: false, crashed: false, kind: "agent", lifetime: "saved", resumePolicy: "restartable", refused: REASON },
      ],
      defOf: (name: string) => name === "healthy" ? { cmd: "codex", kind: "agent" } : undefined,
      resumeReadiness: async () => true,
      session: (name: string) => `tachyon-ws-${name}`,
    },
    ledger: { all: () => new Map(), get: () => undefined },
    tmux: { panePid: async () => { throw new Error("no pane in projection fixture"); } },
    worktrees: { currentBranch: async () => "main" },
    config: undefined,
    configFailure: undefined,
    commandRunner: { list: async () => [] },
    runbookRunner: { list: () => [] },
    handoffStore: { snapshot: () => ({ exists: false, staleness: "missing", pendingCount: 0 }) },
    pinStore: { list: () => [] },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    pipelines: { allRuns: () => [] },
    listPipelines: () => [],
    lastActivityAt: () => null,
    attentionOf: () => undefined,
    continuityBadge: () => undefined,
    persistenceHookHealth: () => undefined,
    verifyInfo: async () => undefined,
    evidenceHandoff: async () => undefined,
    readConfigLkg: () => null,
  } as unknown as SidebarFleetSource;
}

it("t-af6803 keeps the refused profile visible without contaminating healthy sidebar rows", async () => {
  const fleet = await buildSidebarFleet(source());

  expect(fleet.configError).toBeUndefined();
  expect(fleet.agents.find((agent) => agent.name === "healthy")?.configInvalid).toBeUndefined();
  const broken = fleet.agents.find((agent) => agent.name === "broken");
  expect(broken?.refused).toBe(REASON);
  expect(broken?.configInvalid).toBeUndefined();
});
