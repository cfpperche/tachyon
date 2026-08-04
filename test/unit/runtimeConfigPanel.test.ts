import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { runtimeConfigFixtureSnapshot } from "../../scripts/webview-preview/fixtures/cockpit.js";
import {
  RUNTIME_CONFIG_VIEW_TYPE,
  RuntimeConfigPanelManager,
  type RuntimeConfigDeps,
} from "../../src/webview/RuntimeConfigPanel.js";
import { readyMessage } from "../../src/webview/runtime-config/messages.js";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const panel of __createdPanels) if (!panel.disposed) panel.dispose();
});

describe("SDD 485 D8 — standalone Runtime Config dashboard", () => {
  it("gives two projects distinct panels and reads each immutable project", async () => {
    const reads: string[] = [];
    const manager = new RuntimeConfigPanelManager(Uri.file("/ext"), deps({
      buildSnapshot: (project) => { reads.push(project); return runtimeConfigFixtureSnapshot; },
    }));
    manager.open("project-a");
    manager.open("project-b");
    expect(manager.openKeys).toEqual([
      `${RUNTIME_CONFIG_VIEW_TYPE}|project-a`,
      `${RUNTIME_CONFIG_VIEW_TYPE}|project-b`,
    ]);
    for (const panel of __createdPanels) panel.webview.__receive(readyMessage());
    await flush();
    expect(reads).toEqual(["project-a", "project-b"]);
  });

  it("panel A cannot save into project B when the client claims B", async () => {
    const saves: Array<{ wsHash: string }> = [];
    const manager = new RuntimeConfigPanelManager(Uri.file("/ext"), deps({
      saveChanges: async (input) => { saves.push(input); },
    }));
    manager.open("project-a");
    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();
    panel.webview.__receive({
      type: "saveRuntimeConfigChanges",
      wsHash: "project-b",
      runtime: "codex",
      documentId: "codex-global",
      expectedRevision: "rev",
      changes: [],
    });
    await flush();
    expect(saves.map((save) => save.wsHash)).toEqual(["project-a"]);
  });
});

function deps(overrides: Partial<RuntimeConfigDeps>): RuntimeConfigDeps {
  return {
    buildSnapshot: () => runtimeConfigFixtureSnapshot,
    openSource: async () => {},
    saveChanges: async () => {},
    ...overrides,
  };
}
