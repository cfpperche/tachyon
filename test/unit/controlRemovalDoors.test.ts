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

  it("the Board's create/edit door opens the task document, and CREATE is not the same call as edit", () => {
    // t-3c8f2a — this used to accept one call for both (`openEdit(ws.wsHash, id ?? mintTaskId())`).
    // That conflation is the defect: with no id the task does not exist yet, so Cancel had nothing to
    // fall back to and left a tab reading "never found on disk". The guard now requires the split.
    const block = blockFrom("const boardPanels", 1200);
    expect(block).toMatch(/if \(id\) taskDetailPanels\.openEdit\(ws\.wsHash, id\)/);
    expect(block).toMatch(/else taskDetailPanels\.openCreate\(ws\.wsHash, mintTaskId\(\)\)/);
    expect(block).not.toContain("openCockpit(");
  });

  it("the pin edit command opens the Pins document", () => {
    const block = blockFrom('registerCommand("tachyon.editPinItem"', 350);
    expect(block).toContain("pinDetailPanels.openEdit(ws.wsHash, item.pinId)");
  });

  it("the new-task command opens a pre-minted task document through the CREATE door", () => {
    const block = blockFrom('registerCommand("tachyon.taskStudio.new"', 400);
    expect(block).toContain("taskDetailPanels.openCreate(ws.wsHash, mintTaskId())");
  });

  it("a persisted Control panel is discarded and replaced by System", () => {
    const block = blockFrom('context, "tachyonCockpit"', 400);
    expect(block).toContain("panel.dispose()");
    expect(block).toContain("openSystemTab(");
  });

  it("tachyon.openControl resolves every section without falling through to Control", () => {
    const block = blockFrom('registerCommand("tachyon.openControl"', 3_800);
    for (const opener of [
      "openBoard", "tmuxPanels.open", "openPluginsTab", "runtimeOpsPanels.open",
      "openHumanInboxTab", "openWorktreesTab",
      "openRuntimeConfigTab", "openSettingsTab", "openSystemTab",
    ]) expect(block, `${opener} is not reachable from tachyon.openControl`).toContain(opener);
    expect(block).not.toContain("openCockpit(");
    // SDD 500 — `openEngineTab` and `openOverviewTab` left this list because their apps MERGED, and the
    // assertion is inverted rather than dropped for the same reason `openFleetTab`'s was: both ids
    // still decode, so an arm for either could come back by accident. Neither may have a door of its
    // own — `resolveSectionDestination` maps both to `system` BEFORE this switch reads them.
    expect(block).not.toContain("openEngineTab");
    expect(block).not.toContain("openOverviewTab");
    expect(block, "the alias must be applied before the switch, or the two ids fall through").toContain("resolveSectionDestination(resolveSection(section))");
    // t-5f2b5b — `openFleetTab` left this list because the app it opened is deleted, and the assertion
    // is INVERTED rather than dropped: `fleet` still decodes as a section id (it is the parent of the
    // agent-activity/agent-probes subroutes and of five studios), so a resolver arm for it could come
    // back by accident. It must fall through to the Overview default instead of opening anything.
    expect(block).not.toContain("openFleetTab");
  });

  it("tachyon.openControl with no section defaults to System", () => {
    const block = blockFrom('registerCommand("tachyon.openControl"', 3_800);
    expect(block).toMatch(/openSystemTab\(\);\n\s*return Promise\.resolve\(\);\n\s*}\),/);
  });

  it("the legacy tachyon.openCockpit alias defaults to System", () => {
    const block = blockFrom('registerCommand("tachyon.openCockpit"', 180);
    expect(block).toContain("openSystemTab()");
    expect(block).not.toContain("openCockpit(");
  });

  it("tachyon.inspectEngine keeps its command id and lands on System", () => {
    // SDD 500 — the command is contributed in package.json and reachable from the palette, so retiring
    // it would remove a door. The engine detail it opened is the lower half of System; only the
    // destination changed.
    const block = blockFrom('registerCommand("tachyon.inspectEngine"', 200);
    expect(block).toContain("openSystemTab()");
  });
});
