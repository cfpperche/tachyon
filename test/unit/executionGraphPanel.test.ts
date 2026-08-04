import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { EXECUTION_GRAPH_VIEW_TYPE, ExecutionGraphPanelManager } from "../../src/webview/ExecutionGraphPanel.js";
import { readyMessage } from "../../src/webview/execution-graph/messages.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const panel of __createdPanels) if (!panel.disposed) panel.dispose(); });

describe("SDD 485 D9 — standalone Execution dashboard", () => {
  it("opens one independently-scoped panel per project", async () => {
    const reads: Array<string | undefined> = [];
    const manager = new ExecutionGraphPanelManager(Uri.file("/ext"), {
      read: (project) => { reads.push(project); return { events: [], available: true }; },
    });
    manager.open("project-a");
    manager.open("project-b");
    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await flush(); await flush();
    expect(manager.openKeys).toEqual([
      `${EXECUTION_GRAPH_VIEW_TYPE}|project-a`,
      `${EXECUTION_GRAPH_VIEW_TYPE}|project-b`,
    ]);
    expect(reads).toEqual(["project-a", "project-b"]);
  });

  it("owns selection, filters and derived detail inside each app root, never Control", () => {
    const root = readFileSync("src/webview/execution-graph/main.tsx", "utf8");
    expect(root).toContain("const [selected, setSelected] = useState<string>()");
    expect(root).toContain("const [filters, setFilters] = useState");
    expect(root).toContain("const detail = selected ? vm?.details[selected] : undefined");
    expect(() => readFileSync("src/webview/cockpit/App.tsx", "utf8")).toThrow();
  });
});
