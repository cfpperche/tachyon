import type { EngineHost } from "./EngineHost.js";
import type { ApprovalResolutionChannel } from "../approvals/approvalRequest.js";

export interface WorkspaceBridgeServer {
  readonly url: string | undefined;
  readonly port: number | undefined;
  readonly listenerPort: number | undefined;
  start(preferredPort: number, options?: { host?: string }): Promise<number>;
  dispose(): Promise<void>;
  forceToolListRefresh(): void;
}

export interface WorkspaceBridgeIdentityTransport {
  readonly authEnabled: boolean;
  readonly token: string | undefined;
  readonly externalToken: string | undefined;
  readonly instanceId: string;
  readonly legacyCompatEnabled: boolean;
  readonly scope: unknown;
  readonly callerRegistry: unknown;
  readonly knownSecrets: string[];
  launchEnv(url: string | undefined): Record<string, string>;
  initializeIdentity(host: EngineHost): Promise<Buffer>;
  mintCaller(name: string): string | undefined;
  mintAgentEnv(name: string): Record<string, string>;
  revokeCaller(name: string): void;
  persistRegistry(): void;
}

export interface WorkspaceBridgeClientRebind {
  dispose(): void;
  getGeneration(): number;
  onListenerReady(): Promise<void>;
  onNewIncarnation(name: string): void;
  onAgentStopped(name: string): void;
  getClientState(name: string): "ok" | "suspect" | "rebinding" | "failed" | "cancelled" | undefined;
}

export interface WorkspaceBridgeClientRebindSettings {
  onHostGenerationBump: "auto" | "notify" | "off";
  graceMs: number;
  stopTimeoutMs: number;
  maxConcurrentRebinds: number;
  circuitFailCount: number;
}

export interface WorkspaceBridgeRequestCompleteInfo {
  durationMs: number;
  slow: boolean;
  requestKind: "mcp-tool" | "mcp-stream" | "mcp-session" | "mcp-protocol" | "other";
  tool?: string;
  claimedIdentity?: string;
  caller?: { kind: "agent" | "master" | "legacy" | "external" | "human"; name?: string };
}

export interface WorkspaceBridgeServerOptions {
  token?: string;
  externalToken?: string;
  companion?: {
    pairing: unknown;
    live: unknown;
    tab: unknown;
    mobileDistRoot: string | undefined;
    ops: {
      listActiveAgents: () => unknown;
      sendPrompt: (agent: string, text: string) => unknown;
      listApprovals: () => unknown;
      resolveApproval: (id: string, decision: "approved" | "denied") => unknown;
    };
  };
  getRegistry?: () => unknown;
  scope?: unknown;
  legacyCompatEnabled?: boolean;
  onLegacyCall?: (info: { tool: string; claimedIdentity?: string }) => void;
  healUnknownBearer?: (bearer: string) => { kind: "agent"; name: string } | undefined;
  onRequestComplete?: (info: WorkspaceBridgeRequestCompleteInfo) => void;
  slowRequestMs?: number;
}

// These callback names belong to the pre-existing MCP adapter bag. Naming their callable shape here
// preserves contextual typing without making that large adapter bag part of the narrow port itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdapterCallback = (...args: any[]) => any;
type ServerCallbackName =
  | "acknowledgeIdlePoke" | "attachEvidence" | "attentionOf" | "authoredNoticeMetadata"
  | "companionAllowedHosts" | "companionBrowserPaired" | "companionRefHints" | "companionTabAct"
  | "companionTabActivate" | "companionTabCheck" | "companionTabClose" | "companionTabConsole"
  | "companionTabDialog" | "companionTabDownload" | "companionTabDrag" | "companionTabEval"
  | "companionTabFind" | "companionTabGet" | "companionTabHover" | "companionTabListFrames"
  | "companionTabNavigate" | "companionTabNetwork" | "companionTabOpen" | "companionTabPressKey"
  | "companionTabScreenshot" | "companionTabScroll" | "companionTabSelectOption"
  | "companionTabSnapshot" | "companionTabTabsList" | "companionTabToolsEnabled" | "companionTabUpload"
  | "companionTabWaitFor" | "completeNode" | "composerDraftNow" | "composerOccupiedOf"
  | "continueTask" | "currentActivitySeq" | "deliverNotice" | "flagAwaitingHuman" | "hasStartedTurn"
  | "ideBrowserRequest" | "ideBrowserToolsEnabled" | "inspectSavedAgentProfile" | "knownSecrets"
  | "lastActivityAt" | "listEvidence" | "markCompletionHint" | "notify" | "onApprovalRequested"
  | "onContinuityChanged" | "onHandoffChanged" | "onHumanValidationPending" | "onPinsChanged"
  | "onSavedAgentProposed" | "onSavedAgentRemovalProposed" | "onScheduleProposed"
  | "onTaskNotificationEvent" | "onTasksChanged" | "onValidationsChanged" | "probeCwd"
  | "publishRuntimeStatus" | "requestContextCompaction" | "requestFreshContext" | "runHostAction"
  | "runtimeCondition" | "runtimeCredentialHygiene" | "savedAgentRosterReconciliation" | "touchedFiles"
  | "touchedFilesMergeBase" | "writeTachyonConfig";

export type WorkspaceBridgeServerDependencies = Partial<Record<ServerCallbackName, AdapterCallback>>
  & Record<string, unknown>;

type RebindCallbackName =
  | "getState" | "setState" | "getLedger" | "listRunning" | "listRunningStrict" | "kindOf"
  | "isRunning" | "canResume" | "stopGracefully" | "hardKillSession" | "resume"
  | "stampBridgeClient" | "markExpectedDeath" | "notify" | "deliverNotice" | "getSettings"
  | "getReloadInitiator" | "clearReloadInitiator";
export type WorkspaceBridgeClientRebindDependencies = Partial<Record<RebindCallbackName, AdapterCallback>>
  & Record<string, unknown>;

/**
 * SDD 507 — the transport composition supplied by the app shell. Five members preserve the
 * authentication/rebind mechanism extracted in slice 4; the six remaining members replace slice
 * 5's six direct bridge imports. The engine describes only the values and operations it consumes.
 */
export interface WorkspaceBridgePort {
  createWorkspaceTransport(options: {
    workspaceId: string;
    storagePath: string;
    authEnabled: boolean;
    legacyCompatEnabled: boolean;
    getState: <T>(key: string) => T | undefined;
    setState: (key: string, value: unknown) => void;
  }): WorkspaceBridgeIdentityTransport;
  // Existing adapter bags retain their concrete types on the transport side. This port deliberately
  // does NOT prove that this opaque callback bag matches BridgeClientRebindDeps: doing so here would
  // make the engine derive its contract from the transport again. The transport-side composition
  // therefore uses an unchecked assertion; typecheck covers each side independently, while the auth
  // handshake/rebind behavior test is what detects a runtime wiring divergence across this seam.
  createClientRebind(deps: WorkspaceBridgeClientRebindDependencies): WorkspaceBridgeClientRebind;
  parseClientRebindSettings(value: unknown): WorkspaceBridgeClientRebindSettings;
  isClientWired(record: unknown): boolean;
  reloadInitiatorStateKey(workspaceHash: string): string;
  // Likewise, the large pre-existing MCP adapter bag is opaque at this boundary and its conversion
  // to BridgeDeps is unchecked. Bridge/tool integration tests (plus the full daemon/workspace suites),
  // not TypeScript assignability at the composition line, detect divergence between the two shapes.
  createServer(deps: WorkspaceBridgeServerDependencies, options: WorkspaceBridgeServerOptions): WorkspaceBridgeServer;
  derivePort(workspaceHash: string): number;
  readonly companionApprovalChannel: ApprovalResolutionChannel;
  prepareAgentSummary(raw: string): string;
  composeAgentNotice(from: string, to: string, summary: string): string;
  healUnknownBearer(registry: unknown, bearer: string, scope: unknown):
    | { ok: false }
    | { ok: true; adopted: boolean; name: string };
}
