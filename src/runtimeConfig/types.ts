export type RuntimeConfigScope = "global" | "workspace";
export type RuntimeConfigRuntime = "codex" | "claude";

export interface RuntimeConfigKnownSetting {
  key: string;
  label: string;
  value?: string;
  editValue?: string | boolean | string[];
  editable: boolean;
  inputKind?: "text" | "boolean" | "string-list";
  shadowedBy?: string;
}

export interface RuntimeConfigMcpServer {
  name: string;
  enabled: boolean;
  editable?: boolean;
}

export interface RuntimeConfigDocumentInventory {
  id: string;
  label: string;
  scope: RuntimeConfigScope;
  kind: "settings" | "config" | "mcp";
  path: string;
  exists: boolean;
  revision?: string;
  modifiedAt?: string;
  knownSettings: RuntimeConfigKnownSetting[];
  mcpServers: RuntimeConfigMcpServer[];
  unknownKeys: string[];
  internalStateCount: number;
  opaqueKeys?: string[];
  parseError?: string;
}

export interface RuntimeConfigRuntimeInventory {
  runtime: RuntimeConfigRuntime;
  label: string;
  documents: RuntimeConfigDocumentInventory[];
  potentialAgents: string[];
  pendingAgents?: string[];
}

export interface RuntimeConfigControlSnapshot {
  runtimes: RuntimeConfigRuntimeInventory[];
}

export type RuntimeConfigChange =
  | { kind: "setting"; key: string; value: unknown }
  | { kind: "set-mcp-enabled"; name: string; enabled: boolean };
