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
      "src/webview/PluginsPanel.ts",
      "src/webview/AgentStudioAdapter.ts",
      "src/webview/CommandStudioAdapter.ts",
      "src/webview/RunbookStudioAdapter.ts",
      "src/webview/ScheduleStudioAdapter.ts",
      "src/webview/TerminalStudioAdapter.ts",
      // BoardPanel.ts left this list on t-610705 Phase B #6: the panel host was retired and the
      // file is types-only now (no Workspace, no Target) — the board is hosted by Cockpit.ts, which was
      // born on WorkspaceBoardTarget.
      // TaskDetailPanel.ts left this list on t-610705 Phase C.1 for the same reason: the panel host was
      // retired and the file is types-only now (VIEW_TYPE + PanelState only) — Task Detail is hosted by
      // Cockpit.ts, which was born on WorkspaceTaskDetailTarget.
      // ActivityPanel.ts and ProbeResultPanel.ts left this list on t-610705 Phase C.2 for the same
      // reason: both hosts were retired and are types-only now — Activity/Probes are hosted by
      // Cockpit.ts, which was born on WorkspaceActivityTarget/WorkspaceProbePresentationTarget.
      // HandoffPanel.ts left this list on t-610705 Phase C.3 for the same reason: the panel host was
      // retired and the file is types-only now (VIEW_TYPE + PanelState only) — Handoff is hosted by
      // Cockpit.ts, which was born on WorkspaceHandoffTarget.
      // CommandStudioPanel.ts left this list on t-610705 Phase D D0 for the same reason: the panel
      // host was retired (it's the pilot Control route now — studios-routes-design.md) and the file
      // is types-only (VIEW_TYPE + PanelState only) — Command Studio is hosted by
      // CommandStudioPanelManager (SingleModeStudioPanelManager; Control-route studioHost.ts retired
      // in t-337cdf), which resolves WorkspaceStudioTarget through STUDIO_REGISTRY, not this file.
      // TerminalStudioPanel.ts/RunbookStudioPanel.ts/ScheduleStudioPanel.ts left this list on
      // t-610705 Phase D D1a for the same reason as CommandStudioPanel.ts above.
      // AgentStudioPanel.ts left this list on t-610705 Phase D D1b for the same reason — the panel
      // host was retired and the file is types-only now; Agent Studio is hosted by
      // AgentStudioPanelManager / agentStudioDomain.ts. AgentStudioAdapter.ts stays in this list
      // (unchanged — still legitimately typed against WorkspaceAgentStudioTarget).
      // TaskStudioPanel.ts left this list on t-610705 Phase D D2 for the same reason as
      // CommandStudioPanel.ts above — the panel host was retired and the file is types-only now
      // (VIEW_TYPE + PanelState only); Task Studio domain lives in taskStudioDomain.ts /
      // STUDIO_REGISTRY (Control-route host studioHost.ts retired in t-337cdf). TaskStudioAdapter.ts
      // stays in this list (unchanged — still legitimately typed against WorkspaceTaskStudioTarget).
      // PinStudioPanel.ts left this list on t-610705 Phase D D3 for the same reason as
      // CommandStudioPanel.ts above — the panel host was retired and the file is types-only now
      // (VIEW_TYPE + PanelState only); Pin Studio domain lives in pinStudioDomain.ts /
      // STUDIO_REGISTRY. PinStudioAdapter.ts stays in this list (unchanged — still legitimately
      // typed against WorkspacePinStudioTarget).
      "src/webview/TaskStudioAdapter.ts",
      "src/webview/PinStudioAdapter.ts",
      "src/webview/SidebarPrototype.ts",
      "src/presentation/items.ts",
      "src/plugins/ui/host.ts",
    ];
    for (const relative of migrated) {
      const source = fs.readFileSync(path.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/workspace\/Workspace(?:\.js)?/);
      expect(source, relative).toMatch(/Workspace(?:Presentation|GitPresentation|ProbePresentation|PluginPresentation|Activity|Handoff|Board|PinStudio|Sidebar|TaskDetail|TaskStudio|AgentStudio|Studio)Target/);
    }
  });

  it("keeps production activation on shell attach/detach only", () => {
    const source = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
    expect(source).not.toMatch(/workspace\/Workspace(?:\.js)?/);
    expect(source).not.toMatch(/\bWorkspace\.(?:create|start|dispose)\b/);
    expect(source).not.toMatch(/\b(?:ws|workspace)\.(?:start|dispose)\s*\(/);
    expect(source).toContain("connectPackagedWorkspaceClient");
    expect(source).toContain("clientRegistry.detach");
    expect(source).toContain("clientRegistry.close");
  });

  it("keeps the runtime projection and deterministic client fake editor-free", () => {
    for (const relative of [
      "src/activity/attributionGap.ts",
      "src/agents/agentInputService.ts",
      "src/handoff/distill.ts",
      "src/handoff/handoffDistillService.ts",
      "src/handoff/handoffFileService.ts",
      "src/handoff/handoffPath.ts",
      "src/runtime-api/workspaceProjection.ts",
      "src/runtime-api/activityProjection.ts",
      "src/runtime-api/agentInputCommands.ts",
      "src/runtime-api/handoffCommands.ts",
      "src/runtime-api/handoffProjection.ts",
      "src/runtime-api/boardCommands.ts",
      "src/runtime-api/boardProjection.ts",
      "src/runtime-api/sidebarCommands.ts",
      "src/runtime-api/sidebarProjection.ts",
      "src/runtime-api/pinStudioCommands.ts",
      "src/runtime-api/pinStudioProjection.ts",
      "src/runtime-api/richDocWire.ts",
      "src/runtime-api/taskDetailCommands.ts",
      "src/runtime-api/taskDetailProjection.ts",
      "src/runtime-api/stagedPayload.ts",
      "src/runtime-api/taskStudioCommands.ts",
      "src/runtime-api/taskStudioProjection.ts",
      "src/shell/FakeWorkspaceClient.ts",
      "src/shell/ActivityTarget.ts",
      "src/shell/HandoffTarget.ts",
      "src/shell/BoardTarget.ts",
      "src/shell/SidebarTarget.ts",
      "src/shell/PinStudioTarget.ts",
      "src/shell/TaskDetailTarget.ts",
      "src/shell/TaskStudioTarget.ts",
      "src/shell/WorkspacePresentation.ts",
      "src/sidebar/sidebarFleetService.ts",
      "src/sidebar/sidebarMutationService.ts",
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
