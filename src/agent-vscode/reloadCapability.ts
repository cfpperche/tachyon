import { descriptorHash, hostActionName, type HostActionCapabilitySpec } from "../host-action/index.js";

export const VSCODE_RELOAD_WINDOW_CAPABILITY: HostActionCapabilitySpec = {
  id: "vscode.reloadWindow.v1",
  action: hostActionName("reloadWindow"),
  command: "workbench.action.reloadWindow",
  args: { schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  effects: ["host_lifecycle_disruptive", "destructive_interrupting"],
  risk_tier: "compound",
};

export function vscodeReloadWindowDescriptorHash(): string {
  return descriptorHash(VSCODE_RELOAD_WINDOW_CAPABILITY);
}

export const VSCODE_RELOAD_WINDOW_POLICY_JSON = `${JSON.stringify({
  version: "reload-window-v1",
  capabilities: [VSCODE_RELOAD_WINDOW_CAPABILITY],
  allowedAgents: ["claude"],
}, null, 2)}\n`;

export const VSCODE_RELOAD_WINDOW_POLICY_HASH = "7ef0e657a24b44af9f7081c5bcfc4afcc25413d8be428b1867b52ab7427ff663";
