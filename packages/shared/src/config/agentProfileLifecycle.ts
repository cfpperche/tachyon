import type { AgentProfileV1 } from "./agentProfile.js";

export interface AgentProfileLifecycleSnapshot {
  schemaVersion: 1;
  canonicalizationVersion: 1;
  agentName: string;
  agentId: string;
  revision: string;
  profile: AgentProfileV1;
  workspaceCommands?: { setup?: string[] };
  persistentInstructions?: string;
  provenance: {
    canonical: { scope: "profile"; writable: true; sha256: string };
    authority: { scope: "host"; writable: false; revision: string; grants: number; capabilityReferenceIds?: string[] };
    projection: { scope: "runtime"; writable: false; active: boolean };
  };
}
