import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("persistent workspace presentation boundary", () => {
  it("freezes every remaining concrete Workspace import in the shell and presentation", () => {
    const inventoryPath = path.join(
      root,
      "docs/specs/382-persistent-engine-shell-boundary/presentation-workspace-inventory.txt",
    );
    const expected = fs.readFileSync(inventoryPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .sort();
    const candidates = [
      path.join(root, "src/extension.ts"),
      ...walkTypeScript(path.join(root, "src/webview")),
      ...walkTypeScript(path.join(root, "src/plugins", "ui")),
      ...walkTypeScript(path.join(root, "src/runtimeOps")),
      ...walkTypeScript(path.join(root, "src/presentation")),
    ];
    const actual = candidates
      .filter((file) => /workspace\/Workspace\.js/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
    expect(actual).toEqual(expected);
  });

  it("keeps migrated presentation surfaces off the concrete Workspace class", () => {
    const migrated = [
      "src/webview/ApprovalPanel.ts",
      "src/webview/PluginsPanel.ts",
      "src/webview/AgentStudioAdapter.ts",
      "src/webview/AgentStudioPanel.ts",
      "src/webview/CommandStudioAdapter.ts",
      "src/webview/CommandStudioPanel.ts",
      "src/webview/RunbookStudioAdapter.ts",
      "src/webview/RunbookStudioPanel.ts",
      "src/webview/ScheduleStudioAdapter.ts",
      "src/webview/ScheduleStudioPanel.ts",
      "src/webview/TerminalStudioAdapter.ts",
      "src/webview/TerminalStudioPanel.ts",
      "src/webview/ProbeResultPanel.ts",
      "src/webview/MissionControlPanel.ts",
      "src/webview/TaskDetailPanel.ts",
      "src/webview/TaskStudioAdapter.ts",
      "src/webview/TaskStudioPanel.ts",
      "src/presentation/items.ts",
      "src/plugins/ui/host.ts",
    ];
    for (const relative of migrated) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/workspace\/Workspace(?:\.js)?/);
      expect(source, relative).toMatch(/Workspace(?:Presentation|GitPresentation|ProbePresentation|PluginPresentation|MissionControl|TaskDetail|TaskStudio|Studio)Target/);
    }
  });

  it("keeps the runtime projection and deterministic client fake editor-free", () => {
    for (const relative of [
      "src/runtime-api/workspaceProjection.ts",
      "src/runtime-api/missionControlCommands.ts",
      "src/runtime-api/missionControlProjection.ts",
      "src/runtime-api/taskDetailCommands.ts",
      "src/runtime-api/taskDetailProjection.ts",
      "src/runtime-api/stagedPayload.ts",
      "src/runtime-api/taskStudioCommands.ts",
      "src/runtime-api/taskStudioProjection.ts",
      "src/shell/FakeWorkspaceClient.ts",
      "src/shell/MissionControlTarget.ts",
      "src/shell/TaskDetailTarget.ts",
      "src/shell/TaskStudioTarget.ts",
      "src/shell/WorkspacePresentation.ts",
    ]) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/from\s+["']vscode["']/);
    }
  });
});

function walkTypeScript(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(target);
  }
  return out;
}
