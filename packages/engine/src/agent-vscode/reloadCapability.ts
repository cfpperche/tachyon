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

// Agent grant: "*" = any Bridge-resolved agent principal (claude/codex/grok/… + Temporary
// with identity). Spec 359 non-goal deferred per-agent scoping; the Claude-only pin was a
// mistake that blocked capability parity. Human authorization is the pinned policy itself
// (out-of-workspace, hash-checked, fail-closed) — not a hardcoded runtime name.
export const VSCODE_RELOAD_WINDOW_POLICY_JSON = `${JSON.stringify({
  version: "reload-window-v2",
  capabilities: [VSCODE_RELOAD_WINDOW_CAPABILITY],
  allowedAgents: ["*"],
}, null, 2)}\n`;

export const VSCODE_RELOAD_WINDOW_POLICY_HASH = "3db70bf4c8e01f52ae5b81ebe71a838dd699ce23a5207b7b03207de96684f6e4";
