import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/extension.ts", "utf8");

function commandBody(command: string): string {
  const start = source.indexOf(`registerCommand("${command}"`);
  expect(start, `${command} registration missing`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("vscode.commands.registerCommand", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("Saved Agent Edit YAML routing", () => {
  const body = commandBody("tachyon.editAgentItem");

  it("opens the selected Saved Agent's canonical agent.yml", () => {
    expect(body).toContain('path.join(ws.workspaceRoot, ".tachyon", "agents", item.agentName, "agent.yml")');
    expect(body).not.toContain("configPathOf(ws)");
    expect(body).not.toContain("agentEntryLine");
  });

  it("warns by name and refuses to open when that agent.yml is absent", () => {
    expect(body).toMatch(/if \(!fs\.existsSync\(file\)\) \{[\s\S]*notify\(vscode\.l10n\.t\("Saved Agent '\{0\}' has no agent\.yml"/);
    expect(body.indexOf("fs.existsSync(file)")).toBeLessThan(body.indexOf("vscode.workspace.openTextDocument(file)"));
  });
});
