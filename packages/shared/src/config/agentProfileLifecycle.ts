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
  /** Pinned profile-local documents whose on-disk bytes are deliberately not projected. */
  withheldDocuments?: Array<{
    referenceId: string;
    name: string;
    kind: string;
    path: string;
    code: "profile/digest-mismatch";
    expectedSha256: string;
    consumedSha256: string;
    detail: string;
  }>;
  provenance: {
    canonical: { scope: "profile"; writable: true; sha256: string };
    authority: { scope: "host"; writable: false; revision: string; grants: number; capabilityReferenceIds?: string[] };
    projection: { scope: "runtime"; writable: false; active: boolean };
  };
}
