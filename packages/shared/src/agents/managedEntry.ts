import type { EntryKind } from "../config/entry.js";
import type { AgentInstanceLifetime, AgentInstancePolicy, AgentInstanceResumePolicy } from "../resume/agentInstance.js";

export interface ManagedEntryInfo {
  name: string;
  session: string;
  running: boolean;
  hasStartedTurn?: boolean;
  stopping?: boolean;
  stopFailed?: boolean;
  stopFailure?: { stage: "await-exit"; reason: string; nextAction: string };
  lifetime: AgentInstanceLifetime;
  resumePolicy: AgentInstanceResumePolicy;
  refused?: string;
  instance?: AgentInstancePolicy;
  dead: boolean;
  crashed: boolean;
  stopRequested?: boolean;
  exitCode?: number;
  cleanExited?: boolean;
  kind: EntryKind;
  parent?: string;
  delegator?: string;
  declaredOwner?: string;
}
