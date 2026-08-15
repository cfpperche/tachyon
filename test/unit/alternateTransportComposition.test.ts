import type {
  WorkspaceBridgeClientRebind,
  WorkspaceBridgeIdentityTransport,
  WorkspaceBridgePort,
  WorkspaceBridgeServer,
} from "@tachyon/engine/workspace/WorkspaceBridgePort.js";
import { runEngineDaemon } from "@tachyon/engine/engine-service/daemonMain.js";
import { describe, expect, it } from "vitest";

const unsupported = (): never => { throw new Error("not used by the alternate transport proof"); };

const identityTransport: WorkspaceBridgeIdentityTransport = {
  authEnabled: false,
  token: undefined,
  externalToken: undefined,
  instanceId: "alternate",
  legacyCompatEnabled: false,
  scope: undefined,
  callerRegistry: undefined,
  knownSecrets: [],
  launchEnv: () => ({}),
  initializeIdentity: async () => Buffer.alloc(0),
  mintCaller: () => undefined,
  mintAgentEnv: () => ({}),
  revokeCaller: () => undefined,
  persistRegistry: () => undefined,
};

const server: WorkspaceBridgeServer = {
  url: "alternate://transport",
  port: 1,
  listenerPort: 1,
  start: async () => 1,
  dispose: async () => undefined,
  forceToolListRefresh: () => undefined,
};

const clientRebind: WorkspaceBridgeClientRebind = {
  dispose: () => undefined,
  getGeneration: () => 1,
  onListenerReady: async () => undefined,
  onNewIncarnation: () => undefined,
  onAgentStopped: () => undefined,
  getClientState: () => "ok",
};

/** A second transport, authored and composed entirely outside packages/engine. */
const alternateTransport = {
  createWorkspaceTransport: () => identityTransport,
  createClientRebind: () => clientRebind,
  parseClientRebindSettings: unsupported,
  isClientWired: () => false,
  reloadInitiatorStateKey: (workspaceHash: string) => `alternate.${workspaceHash}`,
  createServer: () => server,
  derivePort: () => 1,
  companionApprovalChannel: "unattributed:companion-http" as const,
  prepareAgentSummary: (raw: string) => raw,
  composeAgentNotice: (from: string, to: string, summary: string) => `${from}:${to}:${summary}`,
  healUnknownBearer: () => ({ ok: false as const }),
} satisfies WorkspaceBridgePort;

function composeAlternateTransport(port: WorkspaceBridgePort) {
  return {
    runDaemon: (encodedOptions: string) => runEngineDaemon(encodedOptions, port),
    server: port.createServer({}, {}),
    notice: port.composeAgentNotice("new-transport", "engine", "connected"),
  };
}

describe("alternate transport composition", () => {
  it("implements and composes the engine port without importing the production bridge", async () => {
    const composed = composeAlternateTransport(alternateTransport);

    expect(composed.server.url).toBe("alternate://transport");
    expect(composed.notice).toBe("new-transport:engine:connected");
    await expect(composed.runDaemon("not-an-options-envelope")).rejects.toThrow();
  });
});
