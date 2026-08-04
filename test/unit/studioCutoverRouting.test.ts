import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/extension.ts", "utf8");

function commandBody(command: string): string {
  const start = source.indexOf(`registerCommand("${command}"`);
  expect(start, `${command} registration missing`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("vscode.commands.registerCommand", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("SDD 485 D13 studio document routing", () => {
  it("does not import or call the retired five-tab AgentForm opener", () => {
    expect(source).not.toContain("openAgentStudio");
    expect(source).not.toContain("./webview/AgentForm.js");
  });

  it("routes the legacy palette command to the Agent Studio document app", () => {
    expect(commandBody("tachyon.agentStudio")).toContain("studioPanels.agent.openNew(ws.wsHash)");
  });

  it("routes existing entries to their keyed studio document", () => {
    const agentEdit = commandBody("tachyon.editAgentStudioItem");
    expect(agentEdit).toContain("studioPanels.agent.openExisting(ws.wsHash, item.agentName)");
    expect(agentEdit).toContain("studioPanels.terminal.openExisting(ws.wsHash, item.agentName)");
    expect(agentEdit).toContain('dispatch[def.kind === "terminal" ? "terminal" : "agent"]()');

    expect(commandBody("tachyon.editCommandStudioItem")).toContain("studioPanels.command.openExisting(ws.wsHash, item.commandName)");
    expect(commandBody("tachyon.editRunbookStudioItem")).toContain("studioPanels.runbook.openExisting(ws.wsHash, item.runbookName)");
    expect(commandBody("tachyon.editScheduleStudioItem")).toContain("studioPanels.schedule.openExisting(ws.wsHash, item.scheduleName)");
  });
});
