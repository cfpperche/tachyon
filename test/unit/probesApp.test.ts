import { beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { PROBES_VIEW_TYPE, ProbeResultPanelManager } from "../../apps/vscode-extension/src/webview/ProbeResultPanel.js";
import type { WorkspaceProbePresentationTarget } from "../../apps/vscode-extension/src/shell/WorkspacePresentation.js";

beforeEach(() => __resetVscodeMock());
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(calls: Array<string | undefined>) {
  const workspace: WorkspaceProbePresentationTarget = {
    wsHash: "ws-a",
    workspaceRoot: "/project-a",
    folderName: "Project A",
    probeView: async (caller) => {
      calls.push(caller);
      return { caller, empty: true, total: 0, completed: 0, failed: 0, running: 0, rows: [] } as never;
    },
  };
  return new ProbeResultPanelManager(Uri.file("/ext"), () => [workspace]);
}

describe("SDD 485 D18 — standalone Probes documents", () => {
  it("keys workspace-wide and agent-scoped variants as distinct document identities", () => {
    const manager = harness([]);
    manager.open("ws-a");
    manager.open("ws-a", "workspace");
    manager.open("ws-a", "claude");
    expect(manager.openKeys).toEqual([
      `${PROBES_VIEW_TYPE}|ws-a|workspace`,
      `${PROBES_VIEW_TYPE}|ws-a|agent:workspace`,
      `${PROBES_VIEW_TYPE}|ws-a|agent:claude`,
    ]);
    manager.open("ws-a");
    expect(__createdPanels).toHaveLength(3);
    expect(__createdPanels[0].revealCount).toBe(1);
  });

  it("the two ready doors call the same VM builder with and without caller", async () => {
    const calls: Array<string | undefined> = [];
    const manager = harness(calls);
    manager.open("ws-a", "claude");
    manager.open("ws-a");
    __createdPanels[0].webview.__receive({ type: "ready" });
    __createdPanels[1].webview.__receive({ type: "ready" });
    await flush();
    expect(calls).toEqual(["claude", undefined]);
    expect(__createdPanels[0].webview.posted.at(-1)).toMatchObject({ type: "probes", vm: { view: { caller: "claude" } } });
    expect(__createdPanels[1].webview.posted.at(-1)).toMatchObject({ type: "probes", vm: { view: { caller: undefined } } });
  });

  it("drops an older async response when a same-document refresh finishes first", async () => {
    let resolveOld!: (view: unknown) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    let calls = 0;
    const workspace = {
      wsHash: "ws-a", workspaceRoot: "/project-a", folderName: "Project A",
      probeView: async () => ++calls === 1 ? old as never : ({ caller: "claude", empty: true, total: 2, completed: 2, failed: 0, running: 0, rows: [] } as never),
    } satisfies WorkspaceProbePresentationTarget;
    const manager = new ProbeResultPanelManager(Uri.file("/ext"), () => [workspace]);
    manager.open("ws-a", "claude");
    __createdPanels[0].webview.__receive({ type: "ready" });
    manager.refresh();
    await flush();
    resolveOld({ caller: "claude", empty: true, total: 1, completed: 1, failed: 0, running: 0, rows: [] });
    await flush();
    expect(__createdPanels[0].webview.posted.filter((message) => (message as { type?: string }).type === "probes"))
      .toHaveLength(1);
    expect(__createdPanels[0].webview.posted.at(-1)).toMatchObject({ vm: { view: { total: 2 } } });
  });
});
