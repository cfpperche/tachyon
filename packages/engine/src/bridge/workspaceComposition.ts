import { Bridge, derivePort } from "./Bridge.js";
import { APPROVAL_CHANNEL_COMPANION_HTTP } from "./approvalChannels.js";
import { healUnknownBearerFromProc } from "./agentTokenHeal.js";
import type { CallerIdentityRegistry, CallerScope } from "./callerIdentity.js";
import type { BridgeDeps } from "./tools.js";
import { composeAgentNotice, prepareAgentSummary } from "./notifyAgent.js";
import type { BridgeClientRebindDeps } from "./clientRebind.js";
import type { WorkspaceBridgePort, WorkspaceBridgeServerOptions } from "../workspace/WorkspaceBridgePort.js";
import { Workspace, type WorkspaceDeps, type WorkspaceSeams } from "../workspace/Workspace.js";

type BridgeOptions = ConstructorParameters<typeof Bridge>[1];

/** App-side implementation of the engine-declared transport composition port. */
export const workspaceBridgePort: WorkspaceBridgePort = {
  createWorkspaceTransport: (options) => Bridge.createWorkspaceTransport(options),
  // Unchecked by design: WorkspaceBridgePort names the cross-seam risk and its executable coverage.
  createClientRebind: (deps) => Bridge.createClientRebind(deps as unknown as BridgeClientRebindDeps),
  parseClientRebindSettings: (value) => Bridge.parseClientRebindSettings(value),
  isClientWired: (record) => Bridge.isClientWired(record as Parameters<typeof Bridge.isClientWired>[0]),
  reloadInitiatorStateKey: (workspaceHash) => Bridge.reloadInitiatorStateKey(workspaceHash),
  createServer: (deps, options: WorkspaceBridgeServerOptions) => new Bridge(
    // Unchecked by design: the engine must not derive this opaque adapter bag from BridgeDeps.
    deps as unknown as BridgeDeps,
    options as BridgeOptions,
  ),
  derivePort,
  companionApprovalChannel: APPROVAL_CHANNEL_COMPANION_HTTP,
  prepareAgentSummary,
  composeAgentNotice,
  healUnknownBearer: (registry, bearer, scope) => healUnknownBearerFromProc(
    registry as CallerIdentityRegistry,
    bearer,
    scope as CallerScope,
  ),
};

/** Test composition root: behavior tests keep their assertions and inject the same real transport. */
export function createWorkspaceForTest(
  workspaceRoot: string,
  deps: Omit<WorkspaceDeps, "bridgeTransport">,
  seams: WorkspaceSeams,
): Promise<Workspace> {
  return Workspace.createForTest(workspaceRoot, { ...deps, bridgeTransport: workspaceBridgePort }, seams);
}
