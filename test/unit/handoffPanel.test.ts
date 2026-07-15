import { describe, it, expect, beforeEach, vi } from "vitest";
import { Uri, window, __createdPanels, __getShownDocuments, __resetVscodeMock } from "../mocks/vscode.js";
import { HandoffPanelManager, HANDOFF_VIEW_TYPE } from "../../src/webview/HandoffPanel.js";
import type { WorkspaceHandoffTarget } from "../../src/shell/HandoffTarget.js";
import type { HandoffProjectionV1 } from "../../src/runtime-api/handoffProjection.js";

beforeEach(() => __resetVscodeMock());

describe("HandoffPanelManager", () => {
  it("attaches deserialized state to the revived panel instead of creating a replacement", () => {
    const ws = target();
    const manager = new HandoffPanelManager(Uri.file("/ext") as never, () => [ws]);
    const revived = window.createWebviewPanel(HANDOFF_VIEW_TYPE, "stale", undefined as never);

    manager.deserialize(revived as never, { schemaVersion: 1, view: HANDOFF_VIEW_TYPE, wsHash: "ws-1" });

    expect(__createdPanels).toHaveLength(1);
    expect(revived.disposed).toBe(false);
    expect(revived.title).toBe("Handoff — repo");
    expect(revived.webview.html).toContain("handoff.js");
  });

  it("renders target data and routes open/distill actions without concrete engine access", async () => {
    const ws = target();
    const manager = new HandoffPanelManager(Uri.file("/ext") as never, () => [ws]);

    manager.open("ws-1");
    await settle();
    const panel = __createdPanels[0]!;
    expect(panel.webview.posted).toEqual([expect.objectContaining({
      type: "handoff",
      vm: expect.objectContaining({ folder: "repo", body: "## Current State\n", pendingCount: 0 }),
    })]);

    panel.webview.__receive({ type: "openFile" });
    await settle();
    expect(ws.ensureHandoffFile).toHaveBeenCalledTimes(1);
    expect(__getShownDocuments()[0]?.uri.fsPath).toBe("/repo/.tachyon/HANDOFF.md");

    panel.webview.__receive({ type: "distill", mode: "existing", agent: " codex ", instructions: "  concise  " });
    await settle();
    expect(ws.startHandoffDistill).toHaveBeenCalledWith({
      mode: "existing",
      agent: "codex",
      instructions: "concise",
    });
  });
});

function target(): WorkspaceHandoffTarget {
  return {
    workspaceRoot: "/repo",
    wsHash: "ws-1",
    folderName: "repo",
    loadHandoff: vi.fn(async (): Promise<HandoffProjectionV1> => ({
      canonicalRelativePath: ".tachyon/HANDOFF.md",
      exists: true,
      body: "## Current State\n",
      staleness: "fresh",
      pendingCount: 0,
      updatedAt: "2026-07-06T00:00:00.000Z",
      updatedBy: "human",
      revision: "0123456789abcdef",
      notes: [],
      distillTargets: [{ name: "codex", description: "running · declared", state: "running", declared: true }],
    })),
    ensureHandoffFile: vi.fn(async () => "/repo/.tachyon/HANDOFF.md"),
    startHandoffDistill: vi.fn(async (input) => ({
      mode: input.mode,
      agent: input.mode === "existing" ? input.agent : "handoff-codex-test",
    })),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
