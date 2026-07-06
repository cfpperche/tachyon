import { describe, it, expect, beforeEach } from "vitest";
import { Uri, window, __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { HandoffPanelManager, HANDOFF_VIEW_TYPE } from "../../src/webview/HandoffPanel.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

beforeEach(() => __resetVscodeMock());

describe("HandoffPanelManager", () => {
  it("attaches deserialized state to the revived panel instead of creating a replacement", () => {
    const ws = {
      wsHash: "ws-1",
      folderName: "repo",
      lastActivityAt: () => null,
      handoffStore: {
        snapshot: () => ({
          exists: true,
          body: "## Current State\n",
          staleness: "fresh",
          pendingCount: 0,
          pending: [],
          revision: "rev-1",
          meta: { updated_at: "2026-07-06T00:00:00.000Z", updated_by: "tester" },
        }),
      },
      manager: { list: async () => [] },
    } as unknown as Workspace;
    const manager = new HandoffPanelManager(Uri.file("/ext") as never, () => [ws]);
    const revived = window.createWebviewPanel(HANDOFF_VIEW_TYPE, "stale", undefined as never);

    manager.deserialize(revived as never, { schemaVersion: 1, view: HANDOFF_VIEW_TYPE, wsHash: "ws-1" });

    expect(__createdPanels).toHaveLength(1);
    expect(revived.disposed).toBe(false);
    expect(revived.title).toBe("Handoff — repo");
    expect(revived.webview.html).toContain("handoff.js");
  });
});
