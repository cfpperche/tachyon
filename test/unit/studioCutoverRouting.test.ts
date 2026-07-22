import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/extension.ts", "utf8");

function commandBody(command: string): string {
  const start = source.indexOf(`registerCommand("${command}"`);
  expect(start, `${command} registration missing`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("vscode.commands.registerCommand", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("spec 350 Phase 4 cutover studio routing", () => {
  it("does not import or call the retired five-tab AgentForm opener", () => {
    expect(source).not.toContain("openAgentStudio");
    expect(source).not.toContain("./webview/AgentForm.js");
  });

  it("routes the legacy palette command to the per-entity Agent Studio shell", () => {
    expect(commandBody("tachyon.agentStudio")).toContain("agentStudioPanels.openNew(ws)");
  });

  it("routes existing entries to the studio manager for their persisted kind", () => {
    const agentEdit = commandBody("tachyon.editAgentStudioItem");
    expect(agentEdit).toContain("agent: () => agentStudioPanels.openExisting(ws, item.agentName)");
    // t-610705 (Phase D, D1a) — the "terminal" branch is a Control route now (Agent Studio's "agent"
    // branch stays on the legacy panel manager until D1b).
    expect(agentEdit).toContain('cockpitRoutes.studioEdit("terminal", ws.wsHash, item.agentName)');
    expect(agentEdit).toContain('dispatch[def.kind === "terminal" ? "terminal" : "agent"]()');

    // t-610705 (Phase D, D0/D1a) — Command/Terminal/Runbook/Schedule Studio are Control routes now
    // (studios-routes-design.md): no more per-panel manager, routes via openCockpit + the
    // studio-new/studio-edit route builders instead.
    expect(commandBody("tachyon.editCommandStudioItem")).toContain('cockpitRoutes.studioEdit("command", ws.wsHash, item.commandName)');
    expect(commandBody("tachyon.editRunbookStudioItem")).toContain('cockpitRoutes.studioEdit("runbook", ws.wsHash, item.runbookName)');
    expect(commandBody("tachyon.editScheduleStudioItem")).toContain('cockpitRoutes.studioEdit("schedule", ws.wsHash, item.scheduleName)');
  });
});
