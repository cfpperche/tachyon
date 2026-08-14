import type { AgentInstanceLifetime } from "../resume/SessionLedger.js";
export interface WorkspaceConfigFailureProjectionV1 {
  file: string;
  errors: string[];
  at: string;
}


export interface WorkspaceIdentityProjectionV1 {
  root: string;
  hash: string;
  folderName: string;
  configValid: boolean;
  configFailure: WorkspaceConfigFailureProjectionV1 | null;
}


export interface WorkspaceBridgeProjectionV1 {
  instanceId: string;
  port: number;
  url: string | null;
  direct: boolean;
}


export interface WorkspaceAgentProjectionV1 {
  name: string;
  session: string;
  kind: "agent" | "terminal";
  running: boolean;
  stopping: boolean;
  stopFailed: boolean;
  /**
   * t-04052d — replaces `declared`. The wire states the durability of the DEFINITION, not which store
   * happened to hold it. `declaredOwner` below is a DIFFERENT edge (Profile→Profile ownership from
   * `subagents`) and is deliberately untouched; the name similarity is a trap, not a relationship.
   */
  lifetime: AgentInstanceLifetime;
  dead: boolean;
  crashed: boolean;
  attention?: "working" | "idle" | "needs-input" | "throttled";
  /** t-a39c7d — finished turn not yet viewed. */
  unseen?: boolean;
  /** SDD 446 C — current session still uses the prior native runtime source. */
  configurationPending?: boolean;
  exitCode?: number;
  parent?: string;
  delegator?: string;
  declaredOwner?: string;
}


export interface BoundedProjectionListV1<T> {
  total: number;
  truncated: boolean;
  items: T[];
}


/** The first presentation-safe slice consumed without concrete Workspace access. */
export interface WorkspaceCoreProjectionsV1 {
  workspace: WorkspaceIdentityProjectionV1;
  bridge: WorkspaceBridgeProjectionV1;
  agents: BoundedProjectionListV1<WorkspaceAgentProjectionV1>;
}


export interface WorkspacePresentationSnapshotV1 extends WorkspaceCoreProjectionsV1 {
  engineInstanceId: string;
  seq: number;
}
