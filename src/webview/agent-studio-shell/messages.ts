import { envelope } from "../shared/studio/protocol";
import {
  type AgentStudioPatch,
} from "./domain";
import type { AgentProfileStudioSnapshotV1 } from "@tachyon/shared/config/agentProfileStudio";
import type { AgentOwnershipViewV1, AgentProfileStudioBundleCreatedResultV1, AgentProfileStudioBundleExportResultV1 } from "@tachyon/shared/config/agentProfileStudio";
import type { AgentForgetPlanResultV1 } from "@tachyon/shared/config/agentForgetPlan";

/** t-610705 (Phase D, D1b) — routeKey/mountNonce identify WHICH Control-hosted binding this ready is
 *  for (the retired studioHost.ts mount handshake, round-2 F3); undefined off the Control host.
 *
 *  t-337cdf — the Control host is DELETED. The standalone path (`mountSingleModeStudio`) still sends
 *  these, but with the constants `"standalone-studio"` / `"single-mode"`, so today they never
 *  discriminate anything. Left in place rather than removed here: this is a wire-protocol field with
 *  a reader on the other side, and dropping it belongs with dissolving the remaining Control-era
 *  model contract (t-5a0c1c), not with deleting the host. */
export const readyMessage = (mount?: { routeKey: string; mountNonce: string }) =>
  envelope({ type: "ready" as const, ...(mount ? { routeKey: mount.routeKey, mountNonce: mount.mountNonce } : {}) });
export const patchMessage = (patch: AgentStudioPatch, editRevision?: number) =>
  envelope({ type: "patch" as const, patch, ...(editRevision !== undefined ? { editRevision } : {}) });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const browseMessage = () => envelope({ type: "browse" as const });

/**
 * t-5498a6 — ask the host to authorize one workspace skill for this profile.
 *
 * t-4a2a6f — `reauthorize` has no default. It says "I know this content changed since I approved it
 * and I accept the new bytes", which is a different decision from "give this agent the skill", and a
 * defaulted parameter would let the second silently perform the first.
 */
export const authorizeSkillMessage = (agent: string, skillName: string, reauthorize: boolean) =>
  envelope({ type: "authorizeSkill" as const, agent, skillName, reauthorize });

/** t-5498a6 — authorize everything a plugin exposes for this runtime, or refuse it whole. */
export const authorizePluginMessage = (agent: string, pluginName: string, reauthorize: boolean) =>
  envelope({ type: "authorizePlugin" as const, agent, pluginName, reauthorize });

export const refreshAuthorizableCapabilitiesMessage = (agent: string) =>
  envelope({ type: "refreshAuthorizableCapabilities" as const, agent });

/** Host → webview: the two candidate lists, queried fresh rather than read off the snapshot. */
export const authorizableCapabilitiesMessage = (
  agent: string,
  capabilities: import("../../config/agentCapabilityCandidates.js").AuthorizableCapabilities,
) => envelope({ type: "authorizableCapabilities" as const, agent, capabilities });
export const refreshAgentProfileMessage = (agent: string) =>
  envelope({ type: "refreshAgentProfile" as const, agent });
export const setAgentProfileEnabledMessage = (agent: string, expectedRevision: string, enabled: boolean) =>
  envelope({ type: "setAgentProfileEnabled" as const, agent, expectedRevision, enabled });
export const renameAgentProfileMessage = (agent: string, expectedRevision: string, newName: string) =>
  envelope({ type: "renameAgentProfile" as const, agent, expectedRevision, newName });
/** t-e722ce — webview → host: compute the read-only forget plan for this profile revision. */
export const planAgentProfileForgetMessage = (agent: string, expectedRevision: string) =>
  envelope({ type: "planAgentProfileForget" as const, agent, expectedRevision });
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

export const agentProfileSnapshotMessage = (
  action: "refresh" | "set-enabled" | "rename" | "set-subagents" | "set-propose-saved-agent-grant",
  snapshot: AgentProfileStudioSnapshotV1,
) => envelope({ type: "agentProfileSnapshot" as const, action, snapshot });
export const agentProfileOwnershipMessage = (agent: string, ownership: AgentOwnershipViewV1) =>
  envelope({ type: "agentProfileOwnership" as const, agent, ownership });
/** t-e722ce — host → webview: the plan, or the refusal that stopped it from being computed. */
export const agentProfileForgetPlanMessage = (agent: string, result: AgentForgetPlanResultV1) =>
  envelope({ type: "agentProfileForgetPlan" as const, agent, result });
export const agentProfileForgottenMessage = (agent: string, agentId: string) =>
  envelope({ type: "agentProfileForgotten" as const, agent, agentId });
export const agentProfileErrorMessage = (agent: string, code: string, message: string, conflict: boolean) =>
  envelope({ type: "agentProfileError" as const, agent, code, message, conflict });
/** t-746f0f — host → webview: something true about an action that SUCCEEDED, not a failure. */
export const agentProfileNoticeMessage = (agent: string, code: string, message: string) =>
  envelope({ type: "agentProfileNotice" as const, agent, code, message });
export const agentProfileBundleExportMessage = (result: AgentProfileStudioBundleExportResultV1) => envelope({ type: "agentProfileBundleExport" as const, result });
export const agentProfileBundleCreatedMessage = (result: AgentProfileStudioBundleCreatedResultV1) => envelope({ type: "agentProfileBundleCreated" as const, result });
export const agentProfileBundleErrorMessage = (agent: string, code: string, message: string, conflict: boolean) => envelope({ type: "agentProfileBundleError" as const, agent, code, message, conflict });
