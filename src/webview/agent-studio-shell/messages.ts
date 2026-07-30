import { envelope } from "../shared/studio/protocol";
import {
  projectSoulProfileStatus,
  type AgentEvolutionCandidateDetailMessage,
  type AgentEvolutionCandidateSummaryMessage,
  type AgentEvolutionSummaryMessage,
  type AgentStudioPatch,
  type SoulProfileStatusMessage,
} from "./domain";
import type { AgentProfileStudioSnapshotV1 } from "../../config/agentProfileStudio";
import type { AgentOwnershipViewV1, AgentProfileStudioBundleCreatedResultV1, AgentProfileStudioBundleExportResultV1 } from "../../config/agentProfileStudio";

/** t-610705 (Phase D, D1b) — routeKey/mountNonce identify WHICH Control-hosted binding this ready is
 *  for (studioHost.ts's mount handshake, round-2 F3); undefined off the Control host. */
export const readyMessage = (mount?: { routeKey: string; mountNonce: string }) =>
  envelope({ type: "ready" as const, ...(mount ? { routeKey: mount.routeKey, mountNonce: mount.mountNonce } : {}) });
export const patchMessage = (patch: AgentStudioPatch, editRevision?: number) =>
  envelope({ type: "patch" as const, patch, ...(editRevision !== undefined ? { editRevision } : {}) });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const browseMessage = () => envelope({ type: "browse" as const });

/** Webview → host: create minimal canonical SOUL.md under a journaled transaction. */
export const createSoulMessage = (agent: string) => envelope({ type: "createSoul" as const, agent });
/** Webview → host: import exact bytes selected by the in-Studio picker; no local path crosses the boundary. */
export const importSoulMessage = (agent: string, contentBase64: string) =>
  envelope({ type: "importSoul" as const, agent, contentBase64 });
/** Webview → host: explicitly confirmed replacement guarded by the digest shown to the user. */
export const replaceSoulMessage = (agent: string, contentBase64: string, expectedDigest: string) =>
  envelope({ type: "replaceSoul" as const, agent, contentBase64, expectedDigest });
/** Webview → host: open the canonical managed copy in the editor. */
export const openSoulMessage = (agent: string) => envelope({ type: "openSoul" as const, agent });
/** Webview → host: re-read profile status. */
export const refreshSoulMessage = (agent: string) => envelope({ type: "refreshSoul" as const, agent });
/** Webview → host: bounded preview + status. */
export const previewSoulMessage = (agent: string) => envelope({ type: "previewSoul" as const, agent });
/** Webview → host: digest-backed adopt of retained data. */
export const adoptSoulProfileMessage = (agent: string, expectedDigest: string) =>
  envelope({ type: "adoptSoulProfile" as const, agent, expectedDigest });
/** Webview → host: enable soul when an active resolvable profile exists. */
export const enableSoulMessage = (agent: string) => envelope({ type: "enableSoul" as const, agent });
/** Webview → host: disable soul, retain bytes, mark retained. */
export const disableSoulMessage = (agent: string) => envelope({ type: "disableSoul" as const, agent });
/** Webview → host: permanently delete only the confirmed Soul-owned canonical files. */
export const deleteSoulProfileMessage = (agent: string) => envelope({ type: "deleteSoulProfile" as const, agent });

/** Webview → host: reload the bounded active-profile summary and proposal list. */
export const refreshEvolutionMessage = (agent: string) => envelope({ type: "refreshEvolution" as const, agent });
/** Webview → host: load exact text/files for one selected proposal. */
export const loadEvolutionCandidateMessage = (agent: string, candidateId: string) =>
  envelope({ type: "loadEvolutionCandidate" as const, agent, candidateId });
export const approveEvolutionCandidateMessage = (
  agent: string,
  candidateId: string,
  expectedActiveVersion: number,
  expectedTargetDigest?: string,
) => envelope({
  type: "approveEvolutionCandidate" as const,
  agent,
  candidateId,
  expectedActiveVersion,
  ...(expectedTargetDigest !== undefined ? { expectedTargetDigest } : {}),
});
export const rejectEvolutionCandidateMessage = (
  agent: string,
  candidateId: string,
  expectedActiveVersion: number,
  expectedTargetDigest?: string,
) => envelope({
  type: "rejectEvolutionCandidate" as const,
  agent,
  candidateId,
  expectedActiveVersion,
  ...(expectedTargetDigest !== undefined ? { expectedTargetDigest } : {}),
});

export const refreshAgentProfileMessage = (agent: string) =>
  envelope({ type: "refreshAgentProfile" as const, agent });
export const setAgentProfileEnabledMessage = (agent: string, expectedRevision: string, enabled: boolean) =>
  envelope({ type: "setAgentProfileEnabled" as const, agent, expectedRevision, enabled });
export const renameAgentProfileMessage = (agent: string, expectedRevision: string, newName: string) =>
  envelope({ type: "renameAgentProfile" as const, agent, expectedRevision, newName });
export const forgetAgentProfileMessage = (agent: string, expectedRevision: string, confirmation: string) =>
  envelope({ type: "forgetAgentProfile" as const, agent, expectedRevision, confirmation });
/** t-4c113c — webview → host: replace the owner's whole declared-subagents list under its CAS revision. */
export const setAgentProfileSubagentsMessage = (agent: string, expectedRevision: string, subagents: string[]) =>
  envelope({ type: "setAgentProfileSubagents" as const, agent, expectedRevision, subagents });
/** t-3bde32 — webview → host: grant or revoke this agent's Saved Agent PROPOSAL authority. */
export const setAgentProfileProposeGrantMessage = (agent: string, expectedRevision: string, granted: boolean) =>
  envelope({ type: "setAgentProfileProposeGrant" as const, agent, expectedRevision, granted });
export const exportSavedAgentProfileBundleMessage = (agent: string, expectedRevision: string) => envelope({ type: "exportSavedAgentProfileBundle" as const, agent, expectedRevision });
export const cloneSavedAgentProfileBundleMessage = (agent: string, expectedRevision: string, destinationAgentName: string) => envelope({ type: "cloneSavedAgentProfileBundle" as const, agent, expectedRevision, destinationAgentName });
export const importSavedAgentProfileBundleMessage = (agent: string, destinationAgentName: string, contentBase64: string) => envelope({ type: "importSavedAgentProfileBundle" as const, agent, destinationAgentName, contentBase64 });

/** Host → webview: profile status / preview reply. */
export const soulProfileStatusMessage = (status: SoulProfileStatusMessage) =>
  envelope({ type: "soulProfileStatus" as const, status: projectSoulProfileStatus(status) });

/** Host → webview: profile action failure (typed; no source path). */
export const soulProfileErrorMessage = (agent: string, code: string, message: string) =>
  envelope({ type: "soulProfileError" as const, agent, code, message });

export const evolutionSummaryMessage = (summary: AgentEvolutionSummaryMessage) =>
  envelope({ type: "evolutionSummary" as const, summary });
export const evolutionCandidatesMessage = (agent: string, candidates: AgentEvolutionCandidateSummaryMessage[]) =>
  envelope({ type: "evolutionCandidates" as const, agent, candidates });
export const evolutionCandidateDetailMessage = (agent: string, detail: AgentEvolutionCandidateDetailMessage) =>
  envelope({ type: "evolutionCandidateDetail" as const, agent, detail });
export const evolutionActionResultMessage = (
  agent: string,
  candidateId: string,
  status: "approved" | "rejected",
  activeVersion: number,
) => envelope({ type: "evolutionActionResult" as const, agent, candidateId, status, activeVersion });
export const evolutionErrorMessage = (agent: string, code: string, message: string, conflict: boolean) =>
  envelope({ type: "evolutionError" as const, agent, code, message, conflict });

export const agentProfileSnapshotMessage = (
  action: "refresh" | "set-enabled" | "rename" | "set-subagents" | "set-propose-saved-agent-grant",
  snapshot: AgentProfileStudioSnapshotV1,
) => envelope({ type: "agentProfileSnapshot" as const, action, snapshot });
export const agentProfileOwnershipMessage = (agent: string, ownership: AgentOwnershipViewV1) =>
  envelope({ type: "agentProfileOwnership" as const, agent, ownership });
export const agentProfileForgottenMessage = (agent: string, agentId: string) =>
  envelope({ type: "agentProfileForgotten" as const, agent, agentId });
export const agentProfileErrorMessage = (agent: string, code: string, message: string, conflict: boolean) =>
  envelope({ type: "agentProfileError" as const, agent, code, message, conflict });
export const agentProfileBundleExportMessage = (result: AgentProfileStudioBundleExportResultV1) => envelope({ type: "agentProfileBundleExport" as const, result });
export const agentProfileBundleCreatedMessage = (result: AgentProfileStudioBundleCreatedResultV1) => envelope({ type: "agentProfileBundleCreated" as const, result });
export const agentProfileBundleErrorMessage = (agent: string, code: string, message: string, conflict: boolean) => envelope({ type: "agentProfileBundleError" as const, agent, code, message, conflict });
