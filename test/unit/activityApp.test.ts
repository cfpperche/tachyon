import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import {
  __createdPanels,
  __registeredWebviewPanelSerializers,
  __resetVscodeMock,
} from "../mocks/vscode.js";
import {
  ACTIVITY_VIEW_TYPE,
  ActivityPanelManager,
  type ActivityPanelState,
} from "../../src/webview/ActivityPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import type { SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import type { WorkspaceActivityTarget } from "../../src/shell/ActivityTarget.js";

const roots: string[] = [];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const panel of __createdPanels) if (!panel.disposed) panel.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function target(wsHash: string): WorkspaceActivityTarget {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "activity-app-"));
  roots.push(workspaceRoot);
  return {
    wsHash,
    workspaceRoot,
    folderName: wsHash,
    activityAttention: () => undefined,
    activityContext: async () => ({ sharedCwd: false, targets: { items: [] } }) as never,
    sendAgentInput: async () => {},
  };
}

function harness() {
  const workspaces = [target("ws-a"), target("ws-b")];
  return new ActivityPanelManager(Uri.file("/ext"), () => workspaces);
}

describe("SDD 485 D17 — standalone Agent Activity document", () => {
  it("keys panels by the measured (workspace, agent) pair and reveals only the same pair", () => {
    const manager = harness();
    manager.open("ws-a", "claude");
    manager.open("ws-a", "codex");
    manager.open("ws-b", "claude");
    expect(manager.openKeys).toEqual([
      `${ACTIVITY_VIEW_TYPE}|ws-a|claude`,
      `${ACTIVITY_VIEW_TYPE}|ws-a|codex`,
      `${ACTIVITY_VIEW_TYPE}|ws-b|claude`,
    ]);
    manager.open("ws-a", "claude");
    expect(__createdPanels).toHaveLength(3);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("the legacy serializer revives through the standalone manager on the same pair", async () => {
    const manager = harness();
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerTrustedPanelSerializer<ActivityPanelState | SectionPanelState>(
      context as never,
      ACTIVITY_VIEW_TYPE,
      (panel, state) => manager.deserialize(panel, state),
    );
    const panel = __createdPanels[0] ?? makeRestoredPanel();
    const registration = __registeredWebviewPanelSerializers.find((entry) => entry.viewType === ACTIVITY_VIEW_TYPE)!;
    await registration.serializer.deserializeWebviewPanel(panel as never, {
      schemaVersion: 1,
      view: ACTIVITY_VIEW_TYPE,
      wsHash: "ws-a",
      agent: "claude",
    });
    await flush();
    expect(panel.disposed).toBe(false);
    expect(manager.openKeys).toEqual([`${ACTIVITY_VIEW_TYPE}|ws-a|claude`]);
    expect(panel.webview.html).toContain("activity.js");
  });
});

function makeRestoredPanel(): typeof __createdPanels[number] {
  const manager = harness();
  manager.open("ws-a", "temporary");
  const panel = __createdPanels.pop()!;
  panel.dispose = (() => { panel.disposed = true; }) as never;
  panel.disposed = false;
  return panel;
}
