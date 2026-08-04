import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { FLEET_VIEW_TYPE, FleetPanelManager, type FleetDeps } from "../../src/webview/FleetPanel.js";
import { readyMessage } from "../../src/webview/fleet/messages.js";
import type { CockpitWorkspaceBundle } from "../../src/cockpit/model.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const panel of __createdPanels) if (!panel.disposed) panel.dispose(); });

function bundle(wsHash: string, agent: string): CockpitWorkspaceBundle {
  return {
    control: { folderName: wsHash, workspaceRoot: `/${wsHash}`, wsHash, bridgeUrl: "http://127.0.0.1:1", identity: null, notes: [] } as CockpitWorkspaceBundle["control"],
    agents: [{ name: agent, running: false, lifetime: "saved", wsHash }],
    worktrees: [], approvals: [],
  };
}

function harness() {
  const started: Array<{ name: string; project: string }> = [];
  const probed: Array<{ name: string; project: string }> = [];
  const edited: Array<{ name: string; project: string }> = [];
  const deps: FleetDeps = {
    collect: async () => [bundle("ws-a", "alpha"), bundle("ws-b", "beta")],
    openBoard: () => {},
    start: async (name, project) => { started.push({ name, project }); },
    stop: async () => {}, terminal: async () => {}, activity: async () => {},
    probes: async (name, project) => { probed.push({ name, project }); },
    edit: async (name, project) => { edited.push({ name, project }); }, continueTask: async () => {},
  };
  return { manager: new FleetPanelManager(Uri.file("/ext"), deps), started, probed, edited };
}

async function open(manager: FleetPanelManager, project: string) {
  manager.open(project);
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive(readyMessage());
  await flush(); await flush();
  return panel;
}

function names(panel: typeof __createdPanels[number]): string[] {
  const message = panel.webview.posted.filter((item) => (item as { type?: string }).type === "fleetModel").at(-1) as { model?: { fleet?: Array<{ name: string }> } } | undefined;
  return message?.model?.fleet?.map((row) => row.name) ?? [];
}

describe("SDD 485 D7 — standalone Fleet dashboard", () => {
  it("keys and filters panels by the project accepted by buildCockpitModel", async () => {
    const h = harness();
    const a = await open(h.manager, "ws-a");
    const b = await open(h.manager, "ws-b");
    expect(h.manager.openKeys).toEqual([`${FLEET_VIEW_TYPE}|ws-a`, `${FLEET_VIEW_TYPE}|ws-b`]);
    expect(names(a)).toEqual(["alpha"]);
    expect(names(b)).toEqual(["beta"]);
  });

  it("uses the immutable panel project for actions, not a client wsHash", async () => {
    const h = harness();
    const panel = await open(h.manager, "ws-a");
    panel.webview.__receive({ type: "fleetStart", name: "alpha", wsHash: "ws-b" });
    await flush(); await flush();
    expect(h.started).toEqual([{ name: "alpha", project: "ws-a" }]);
  });

  it("keeps Probes and Edit with the extracted surface and its immutable project", async () => {
    const h = harness();
    const panel = await open(h.manager, "ws-a");
    panel.webview.__receive({ type: "fleetProbes", name: "alpha", wsHash: "ws-b" });
    panel.webview.__receive({ type: "fleetAgentStudio", name: "alpha", wsHash: "ws-b" });
    await flush(); await flush();
    expect(h.probed).toEqual([{ name: "alpha", project: "ws-a" }]);
    expect(h.edited).toEqual([{ name: "alpha", project: "ws-a" }]);
  });
});
