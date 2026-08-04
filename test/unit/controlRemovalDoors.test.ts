import { describe, expect, it } from "vitest";
import fs from "node:fs";

const source = fs.readFileSync("src/extension.ts", "utf8");
const blockFrom = (needle: string, length: number): string => {
  const start = source.indexOf(needle);
  expect(start, `${needle} not found`).toBeGreaterThan(-1);
  return source.slice(start, start + length);
};

describe("SDD 485 E1 — every former Control door opens an app directly", () => {
  it("Task Detail's edit door stays in the same task document", () => {
    const block = blockFrom("const taskDetailPanels", 1_300);
    expect(block).toMatch(/openTaskStudio: \(ws, taskId\)[\s\S]*taskDetailPanels\.openEdit\(ws\.wsHash, taskId\)/);
    expect(block).not.toContain("openCockpit(");
  });

  it("the Board's create/edit door opens the task document", () => {
    const block = blockFrom("const boardPanels", 900);
    expect(block).toMatch(/openTaskStudio: \(ws, id\)[\s\S]*taskDetailPanels\.openEdit\(ws\.wsHash, id \?\? mintTaskId\(\)\)/);
    expect(block).not.toContain("openCockpit(");
  });

  it("the pin edit command opens the Pins document", () => {
    const block = blockFrom('registerCommand("tachyon.editPinItem"', 350);
    expect(block).toContain("pinDetailPanels.openEdit(ws.wsHash, item.pinId)");
  });

  it("the new-task command opens a pre-minted task document", () => {
    const block = blockFrom('registerCommand("tachyon.taskStudio.new"', 400);
    expect(block).toContain("taskDetailPanels.openEdit(ws.wsHash, mintTaskId())");
  });

  it("a persisted Control panel is discarded and replaced by Overview", () => {
    const block = blockFrom('context, "tachyonCockpit"', 400);
    expect(block).toContain("panel.dispose()");
    expect(block).toContain("openOverviewTab(");
  });

  it("tachyon.openControl resolves every section without falling through to Control", () => {
    const block = blockFrom('registerCommand("tachyon.openControl"', 3_800);
    for (const opener of [
      "openBoard", "tmuxPanels.open", "openPluginsTab", "runtimeOpsPanels.open",
      "openHumanInboxTab", "openEngineTab", "openWorktreesTab", "openFleetTab",
      "openRuntimeConfigTab", "openExecutionGraphTab", "openSettingsTab", "openOverviewTab",
    ]) expect(block, `${opener} is not reachable from tachyon.openControl`).toContain(opener);
    expect(block).not.toContain("openCockpit(");
  });

  it("tachyon.openControl with no section defaults to Overview", () => {
    const block = blockFrom('registerCommand("tachyon.openControl"', 3_800);
    expect(block).toMatch(/openOverviewTab\(\);\n\s*return Promise\.resolve\(\);\n\s*}\),/);
  });

  it("the legacy tachyon.openCockpit alias defaults to Overview", () => {
    const block = blockFrom('registerCommand("tachyon.openCockpit"', 180);
    expect(block).toContain("openOverviewTab()");
    expect(block).not.toContain("openCockpit(");
  });
});
