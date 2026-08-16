import { describe, expect, it } from "vitest";
import { buildSidebarFleet, type SidebarFleetSource } from "@tachyon/engine/sidebar/sidebarFleetService.js";
import type { InternalChecklistRead } from "@tachyon/engine/runtime/internalChecklist.js";
import type { InternalChecklistTurnJudgment } from "@tachyon/engine/runtime/internalChecklistTurn.js";

function source(
  plans: Record<string, { snapshot: InternalChecklistRead; judgment: InternalChecklistTurnJudgment }>,
): SidebarFleetSource {
  return {
    workspaceRoot: "/workspace",
    wsHash: "ws",
    folderName: "workspace",
    bridge: { port: 4317, url: "http://127.0.0.1:4317" },
    manager: {
      listAgents: async () => Object.keys(plans).map((name) => ({
        name, running: true, dead: false, crashed: false, kind: "agent", lifetime: "saved", resumePolicy: "restartable",
      })),
      listTerminals: async () => [],
      defOf: () => ({ cmd: "claude", kind: "agent" }),
      resumeReadiness: async () => true,
      session: (name: string) => `tachyon-ws-${name}`,
    },
    ledger: { all: () => new Map(), get: () => undefined },
    tmux: { panePid: async () => { throw new Error("no pane"); } },
    worktrees: { currentBranch: async () => "main" },
    config: undefined,
    configFailure: undefined,
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
    evidenceHandoff: async () => undefined,
    readConfigLkg: () => null,
    internalChecklist: (agent: string) => plans[agent] ?? { snapshot: { state: "mute" }, judgment: { state: "pending", reason: "turn-open" } },
  } as unknown as SidebarFleetSource;
}

describe("t-281339 — fleet projection of the plan line", () => {
  it("projects the current step and a absent mark, and never a no-channel field", async () => {
    const fleet = await buildSidebarFleet(source({
      claude: {
        snapshot: { state: "snapshot", items: [{ text: "write the line", status: "in-progress" }] },
        judgment: { state: "verdict", verdict: "present" },
      },
      grok: {
        snapshot: { state: "mute" },
        judgment: { state: "verdict", verdict: "absent" },
      },
      pi: {
        snapshot: { state: "snapshot", items: [{ text: "should not appear", status: "pending" }] },
        judgment: { state: "verdict", verdict: "no-channel" },
      },
    }));
    expect(fleet.agents.find((a) => a.name === "claude")?.checklist).toEqual({ kind: "step", text: "write the line" });
    expect(fleet.agents.find((a) => a.name === "grok")?.checklist).toEqual({ kind: "absent" });
    expect(fleet.agents.find((a) => a.name === "pi")?.checklist).toBeUndefined();
    expect(JSON.stringify(fleet.agents)).not.toContain("no-channel");
  });
});
