import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { FLEET_VIEW_TYPE, FleetPanelManager, type FleetDeps } from "../../src/webview/FleetPanel.js";
import { readyMessage } from "../../src/webview/fleet/messages.js";
import type { FleetVM } from "../../src/sidebar/types.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const panel of __createdPanels) if (!panel.disposed) panel.dispose(); });

function fleetVm(wsHash: string, agent: string): FleetVM {
  return {
    folder: { hash: wsHash, name: wsHash },
    bridge: { port: "1", connected: true },
    agents: [{ name: agent, status: "stopped", kind: "agent" }],
    terminals: [],
    pipelines: [],
    schedules: [],
    commands: [],
    runbooks: [],
    pins: [],
  };
}

function harness() {
  const actions: Array<{ id: string; name: string; project: string }> = [];
  const deps: FleetDeps = {
    loadFleet: async (project) => fleetVm(project, project === "ws-a" ? "alpha" : "beta"),
    openBoard: () => {},
    runAction: async (id, name, project) => { actions.push({ id, name, project }); },
    continueTask: async () => {},
  };
  return { manager: new FleetPanelManager(Uri.file("/ext"), deps), actions };
}

async function open(manager: FleetPanelManager, project: string) {
  manager.open(project);
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive(readyMessage());
  await flush(); await flush();
  return panel;
}

function agentNames(panel: typeof __createdPanels[number]): string[] {
  const message = panel.webview.posted.filter((item) => (item as { type?: string }).type === "fleetModel").at(-1) as {
    fleet?: { agents?: Array<{ name: string; status?: string }> };
  } | undefined;
  return message?.fleet?.agents?.map((row) => row.name) ?? [];
}

function agentStatuses(panel: typeof __createdPanels[number]): string[] {
  const message = panel.webview.posted.filter((item) => (item as { type?: string }).type === "fleetModel").at(-1) as {
    fleet?: { agents?: Array<{ status?: string }> };
  } | undefined;
  return message?.fleet?.agents?.map((row) => row.status ?? "") ?? [];
}

describe("SDD 485 D7 / t-41117e — standalone Fleet dashboard", () => {
  it("keys and filters panels by project and pushes FleetVM agents", async () => {
    const h = harness();
    const a = await open(h.manager, "ws-a");
    const b = await open(h.manager, "ws-b");
    expect(h.manager.openKeys).toEqual([`${FLEET_VIEW_TYPE}|ws-a`, `${FLEET_VIEW_TYPE}|ws-b`]);
    expect(agentNames(a)).toEqual(["alpha"]);
    expect(agentNames(b)).toEqual(["beta"]);
    expect(agentStatuses(a)).toEqual(["stopped"]);
  });

  it("uses the immutable panel project for actions, not a client wsHash", async () => {
    const h = harness();
    const panel = await open(h.manager, "ws-a");
    panel.webview.__receive({ type: "action", id: "spawn", agent: "alpha" });
    await flush(); await flush();
    expect(h.actions).toEqual([{ id: "spawn", name: "alpha", project: "ws-a" }]);
  });

  it("keeps Probes and Edit with the extracted surface and its immutable project", async () => {
    const h = harness();
    const panel = await open(h.manager, "ws-a");
    panel.webview.__receive({ type: "action", id: "probes", agent: "alpha" });
    panel.webview.__receive({ type: "action", id: "edit", agent: "alpha" });
    await flush(); await flush();
    expect(h.actions).toEqual([
      { id: "probes", name: "alpha", project: "ws-a" },
      { id: "edit", name: "alpha", project: "ws-a" },
    ]);
  });

  it("the Fleet action keeps entering Activity through its action id", async () => {
    const h = harness();
    const panel = await open(h.manager, "ws-a");
    panel.webview.__receive({ type: "action", id: "activity", agent: "alpha" });
    await flush(); await flush();
    expect(h.actions).toEqual([{ id: "activity", name: "alpha", project: "ws-a" }]);
  });
});
