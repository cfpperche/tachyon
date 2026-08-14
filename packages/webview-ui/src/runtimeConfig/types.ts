export type RuntimeConfigScope = "global" | "workspace";
export type RuntimeConfigRuntime = "codex" | "claude" | "grok";

export interface RuntimeConfigKnownSetting {
  key: string;
  label: string;
  value?: string;
  editValue?: string | boolean | string[] | number;
  editable: boolean;
  inputKind?: "text" | "boolean" | "string-list" | "number";
  shadowedBy?: string;
  /**
   * Why Control shows this key but refuses to write it. Distinct from `shadowedBy`, which
   * is about a file that overrides the value; this is about a key Tachyon deliberately
   * declines to own (measured authority, or a scope the runtime ignores).
   */
  readOnlyReason?: string;
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
  kind: "settings" | "config" | "mcp" | "trust";
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
  /**
   * One measured sentence about who this document actually reaches. Runtimes differ:
   * a Grok agent launched by Tachyon gets a private `GROK_HOME` rewritten at spawn, so its
   * global document reaches only Grok started outside Tachyon. Omitted when the runtime's
   * documents all reach the agents listed for the runtime.
   */
  impact?: string;
  /** No change of any kind can be saved to this document. */
  readOnly?: boolean;
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
