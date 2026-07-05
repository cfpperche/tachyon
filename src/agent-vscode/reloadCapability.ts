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
