import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSidebarFleet, type SidebarFleetSource } from "@tachyon/engine/sidebar/sidebarFleetService.js";
import type { InternalChecklistRead } from "@tachyon/engine/runtime/internalChecklist.js";
import type { InternalChecklistTurnJudgment } from "@tachyon/engine/runtime/internalChecklistTurn.js";
import { readAgentInternalChecklist } from "@tachyon/engine/sidebar/readAgentInternalChecklist.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
    expect(fleet.agents.find((a) => a.name === "claude")?.checklist).toEqual({
      kind: "step", text: "write the line", position: 1, total: 1,
    });
    expect(fleet.agents.find((a) => a.name === "grok")?.checklist).toEqual({ kind: "absent" });
    expect(fleet.agents.find((a) => a.name === "pi")?.checklist).toBeUndefined();
    expect(JSON.stringify(fleet.agents)).not.toContain("no-channel");
  });

  it("carries a Codex TUI ledger row through the production reader into the sidebar projection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-sidebar-") );
    dirs.push(root);
    const ledger = path.join(root, ".tachyon", "activity", "codex-tool-hooks.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({
      agent: "coder",
      event: "PostToolUse",
      toolName: "update_plan",
      toolInput: { plan: [{ step: "show the Codex step", status: "inProgress" }] },
    })}\n`);

    const fleet = await buildSidebarFleet({
      ...source({ coder: { snapshot: { state: "mute" }, judgment: { state: "pending", reason: "turn-open" } } }),
      workspaceRoot: root,
      manager: {
        ...source({ coder: { snapshot: { state: "mute" }, judgment: { state: "pending", reason: "turn-open" } } }).manager,
        defOf: () => ({ cmd: "codex", kind: "agent" }),
      },
      internalChecklist: (agent: string) => ({
        snapshot: readAgentInternalChecklist({ runtime: "codex", workspaceRoot: root, agent }),
        judgment: { state: "pending", reason: "turn-open" },
      }),
    } as unknown as SidebarFleetSource);

    expect(fleet.agents.find((agent) => agent.name === "coder")?.checklist).toEqual({
      kind: "step",
      text: "show the Codex step",
      position: 1,
      total: 1,
    });
  });

  it("keeps a fully completed Codex ledger plan visible at n/n", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-sidebar-complete-"));
    dirs.push(root);
    const ledger = path.join(root, ".tachyon", "activity", "codex-tool-hooks.jsonl");
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({
      agent: "coder",
      event: "PostToolUse",
      toolName: "update_plan",
      toolInput: { plan: [
        { step: "implement", status: "completed" },
        { step: "verify", status: "completed" },
      ] },
    })}\n`);
    const base = source({ coder: { snapshot: { state: "mute" }, judgment: { state: "pending", reason: "turn-open" } } });
    const fleet = await buildSidebarFleet({
      ...base,
      workspaceRoot: root,
      manager: { ...base.manager, defOf: () => ({ cmd: "codex", kind: "agent" }) },
      internalChecklist: (agent: string) => ({
        snapshot: readAgentInternalChecklist({ runtime: "codex", workspaceRoot: root, agent }),
        judgment: { state: "pending", reason: "turn-open" },
      }),
    } as unknown as SidebarFleetSource);
    expect(fleet.agents.find((agent) => agent.name === "coder")?.checklist).toEqual({
      kind: "step", text: "verify", position: 2, total: 2,
    });
  });
});
