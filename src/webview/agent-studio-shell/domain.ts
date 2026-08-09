import type { FormState, QuickAddChip } from "../formLogic.js";
import type {
  EvolutionStudioCandidateDetail,
  EvolutionStudioCandidateSummary,
  EvolutionStudioSummary,
} from "../../evolution/studioProjection.js";
import type {
  AgentOwnershipViewV1,
  AgentProfileStudioMutationV1,
  AgentProfileStudioSnapshotV1,
} from "../../config/agentProfileStudio.js";
import { AGENT_OWNERSHIP_MAX_SUBAGENTS, DEFAULT_NEW_AGENT_WORKTREE_ENABLED, isAgentProfileStudioSnapshotV1 } from "../../config/agentProfileStudio.js";
import { agentOwnershipViewSchemaV1, agentProfileStudioBundleCreatedResultSchemaV1, agentProfileStudioBundleExportResultSchemaV1 } from "../../config/agentProfileStudio.js";
import { agentForgetPlanResultSchemaV1 } from "../../config/agentForgetPlan.js";
import {
  claudeScalarNativeConfigPolicy,
  claudeSelectorNativeConfigPolicy,
  codexScalarNativeConfigPolicy,
  defaultCodexScalarNativeConfigPolicy,
  defaultGrokNativeConfigPolicy,
  grokScalarNativeConfigPolicy,
  grokSelectorNativeConfigPolicy,
  CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION,
  CODEX_NEVER_APPROVAL_AUTHORIZATION,
  CODEX_FULL_ACCESS_AUTHORIZATION,
  GROK_ALWAYS_APPROVE_AUTHORIZATION,
  type CodexScalarNativeConfigChoice,
  type CodexScalarNativeConfigFamily,
} from "../../config/agentNativeConfigPolicy.js";
// Node-free by construction (a frozen list + a predicate) — safe for this browser bundle.
import { ATTESTED_RUNTIMES, isAttestedRuntime } from "../../runtime/attestedRuntimes.js";

/**
 * spec 350 Phase 3 T1 — the Agent-kind studio's vscode-free AND node-free domain: pure entity/fields/patch
 * shapes + the adapter's declared dirty/title hooks, mirroring pipeline-studio/domain.ts's and task-studio/
 * domain.ts's convention — both AgentStudioAdapter.ts (host) and agent-studio-shell/App.tsx (webview) import
 * THIS module directly.
 *
 * Only `type`-imports from formLogic.ts here (erased at build — zero runtime dependency): formLogic.ts's
 * RUNTIME exports (`validateForm`, `fromDef`, ...) transitively pull in `../config/loadConfig.js`, which
 * imports `node:fs` — fine for AgentStudioAdapter.ts (a Node/vscode host file) but fatal for this surface's
 * browser bundle (confirmed empirically: esbuild's browser target can't resolve `node:fs`). So the actual
 * formLogic WRAP (validate/build) lives in AgentStudioAdapter.ts, host-side only; this module only carries
 * the FormState *type* + the shell's own pure dirty/title bookkeeping.
 *
 * Validation is NOT client-side/live here — same precedent as TaskStudioAdapter.validate() (spec 350 T1):
 * `AgentStudioAdapter.validate()` returns `NO_VALIDATION_ERRORS` and `save()`'s
 * `Workspace.studioSubmit` call (formLogic's `validateForm` + `YamlConfigEditor.upsertAgent`) is the single
 * authoritative check, same as before this migration.
 *
 * This studio only ever creates/edits `kind: "agent"` entries — `FormState.kind` is always `"agent"`, so the schedule/runbook
 * fields formLogic's shared FormState type carries along are always left at their blank defaults.
 */

/**
 * spec 377 T15A — typed common-path profile protocol names (plus legacy browse/cwd).
 * Final Identity UI layout is T16; these names are the explicit host/webview contract.
 */
export const AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES = [
  "browse",
  // t-5498a6 — authorize a workspace skill so this profile MAY select it. Selecting stays the
  // separate gesture on the Runtime tooling checkboxes.
  "authorizeSkill",
  "authorizePlugin",
  "refreshAuthorizableCapabilities",
  "createSoul",
  "importSoul",
  "replaceSoul",
  "openSoul",
  "refreshSoul",
  "previewSoul",
  "adoptSoulProfile",
  "enableSoul",
  "disableSoul",
  "deleteSoulProfile",
  "refreshEvolution",
  "loadEvolutionCandidate",
  "approveEvolutionCandidate",
  "rejectEvolutionCandidate",
  "refreshAgentProfile",
  "setAgentProfileEnabled",
  "renameAgentProfile",
  "planAgentProfileForget",
  "forgetAgentProfile",
  "setAgentProfileSubagents",
  "setAgentProfileProposeGrant",
  "exportSavedAgentProfileBundle",
  "cloneSavedAgentProfileBundle",
  "importSavedAgentProfileBundle",
] as const;

export const AGENT_STUDIO_HOST_MESSAGE_NAMES = [
  "cwd",
  "soulProfileStatus",
  "soulProfileError",
  "evolutionSummary",
  "evolutionCandidates",
  "evolutionCandidateDetail",
  "evolutionActionResult",
  "evolutionError",
  "agentProfileSnapshot",
  "agentProfileForgetPlan",
  "agentProfileForgotten",
  "agentProfileOwnership",
  "agentProfileError",
  "agentProfileNotice",
  "authorizableCapabilities",
  "agentProfileBundleExport",
  "agentProfileBundleCreated",
  "agentProfileBundleError",
] as const;

/** Complete surface vocabulary for collision checks only; boundary decoders use the directional lists. */
export const AGENT_STUDIO_DOMAIN_MESSAGE_NAMES = [
  ...AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
  ...AGENT_STUDIO_HOST_MESSAGE_NAMES,
] as const;

export type AgentStudioDomainMessageName = (typeof AGENT_STUDIO_DOMAIN_MESSAGE_NAMES)[number];

const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** t-5498a6 — same shape the profile schema enforces for a reference id. */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Browser-side guard; the host repeats the authoritative SOUL_MAX_BYTES validation. */
export const SOUL_IMPORT_MAX_BYTES = 64 * 1024;
export const SOUL_IMPORT_MAX_BASE64_CHARS = 4 * Math.ceil(SOUL_IMPORT_MAX_BYTES / 3);

export function isAllowedSoulImportFileName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !/[\\/\0]/.test(value)
    && /\.(?:md|markdown|txt)$/i.test(value);
}

/** Strict canonical base64 so the host receives bounded, unambiguous bytes rather than a local path. */
export function isCanonicalSoulImportBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SOUL_IMPORT_MAX_BASE64_CHARS
    || value.length % 4 !== 0 || !BASE64_RE.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > SOUL_IMPORT_MAX_BYTES) return false;
  if (padding === 2 && (BASE64_ALPHABET.indexOf(value[value.length - 3]!) & 0x0f) !== 0) return false;
  if (padding === 1 && (BASE64_ALPHABET.indexOf(value[value.length - 2]!) & 0x03) !== 0) return false;
  return true;
}

export type AgentStudioSoulActionMessage =
  | { type: "createSoul" | "openSoul" | "refreshSoul" | "previewSoul" | "enableSoul" | "disableSoul" | "deleteSoulProfile"; agent: string }
  | { type: "importSoul"; agent: string; contentBase64: string }
  | { type: "replaceSoul"; agent: string; contentBase64: string; expectedDigest: string }
  | { type: "adoptSoulProfile"; agent: string; expectedDigest: string };

export type AgentStudioEvolutionActionMessage =
  | { type: "refreshEvolution"; agent: string }
  | { type: "loadEvolutionCandidate"; agent: string; candidateId: string }
  | {
      type: "approveEvolutionCandidate" | "rejectEvolutionCandidate";
      agent: string;
      candidateId: string;
      expectedActiveVersion: number;
      expectedTargetDigest?: string;
    };

export type AgentStudioLifecycleActionMessage =
  | { type: "refreshAgentProfile"; agent: string }
  | { type: "setAgentProfileEnabled"; agent: string; expectedRevision: string; enabled: boolean }
  | { type: "renameAgentProfile"; agent: string; expectedRevision: string; newName: string }
  /**
   * t-e722ce — ask what the forget WOULD do. Read-only, and deliberately a separate message from
   * the forget itself: the plan is what the human approves, so it cannot be a side effect of the
   * action it authorises.
   */
  | { type: "planAgentProfileForget"; agent: string; expectedRevision: string }
  | { type: "forgetAgentProfile"; agent: string; expectedRevision: string; confirmation: string }
  /** t-4c113c — the owner's full declared-subagents list; an empty list clears the declaration. */
  | { type: "setAgentProfileSubagents"; agent: string; expectedRevision: string; subagents: string[] }
  /** t-3bde32 — grant or revoke this agent's authority to PROPOSE Saved Agents for human review. */
  | { type: "setAgentProfileProposeGrant"; agent: string; expectedRevision: string; granted: boolean };

export type AgentStudioBundleActionMessage =
  | { type: "exportSavedAgentProfileBundle"; agent: string; expectedRevision: string }
  | { type: "cloneSavedAgentProfileBundle"; agent: string; expectedRevision: string; destinationAgentName: string }
  | { type: "importSavedAgentProfileBundle"; agent: string; destinationAgentName: string; contentBase64: string };

/** t-5498a6 — authorize one workspace skill for a profile; selecting it stays a separate gesture. */
export type AgentStudioAuthorizeSkillMessage = { type: "authorizeSkill"; agent: string; skillName: string; reauthorize: boolean };
export type AgentStudioAuthorizePluginMessage = { type: "authorizePlugin"; agent: string; pluginName: string; reauthorize: boolean };
export type AgentStudioRefreshCandidatesMessage = { type: "refreshAuthorizableCapabilities"; agent: string };

export type AgentStudioInboundDomainMessage =
  | { type: "browse" }
  | AgentStudioAuthorizeSkillMessage
  | AgentStudioAuthorizePluginMessage
  | AgentStudioRefreshCandidatesMessage
  | AgentStudioSoulActionMessage
  | AgentStudioEvolutionActionMessage
  | AgentStudioLifecycleActionMessage
  | AgentStudioBundleActionMessage;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
    .filter((key) => key !== "studioProtocolVersion" && key !== "routeKey" && key !== "mountNonce")
    .sort();
  return keys.join("\0") === [...expected].sort().join("\0");
}

/** Runtime validation after the shared envelope/name decoder, before any host filesystem action. */
export function validateAgentStudioInboundMessage(raw: unknown): AgentStudioInboundDomainMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === "browse") return exactKeys(value, ["type"]) ? { type: "browse" } : undefined;
  if (value.type === "refreshAgentProfile") {
    return exactKeys(value, ["type", "agent"]) && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      ? { type: "refreshAgentProfile", agent: value.agent }
      : undefined;
  }
  if (value.type === "exportSavedAgentProfileBundle") {
    return exactKeys(value, ["type", "agent", "expectedRevision"]) && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "exportSavedAgentProfileBundle", agent: value.agent, expectedRevision: value.expectedRevision } : undefined;
  }
  if (value.type === "cloneSavedAgentProfileBundle") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "destinationAgentName"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && typeof value.destinationAgentName === "string" && AGENT_NAME_RE.test(value.destinationAgentName)
      ? { type: "cloneSavedAgentProfileBundle", agent: value.agent, expectedRevision: value.expectedRevision, destinationAgentName: value.destinationAgentName } : undefined;
  }
  if (value.type === "importSavedAgentProfileBundle") {
    return exactKeys(value, ["type", "agent", "destinationAgentName", "contentBase64"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.destinationAgentName === "string" && AGENT_NAME_RE.test(value.destinationAgentName)
      && typeof value.contentBase64 === "string" && value.contentBase64.length > 0 && value.contentBase64.length <= 350_000 && BASE64_RE.test(value.contentBase64)
      ? { type: "importSavedAgentProfileBundle", agent: value.agent, destinationAgentName: value.destinationAgentName, contentBase64: value.contentBase64 } : undefined;
  }
  if (value.type === "setAgentProfileEnabled") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "enabled"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && typeof value.enabled === "boolean"
      ? { type: "setAgentProfileEnabled", agent: value.agent, expectedRevision: value.expectedRevision, enabled: value.enabled }
      : undefined;
  }
  if (value.type === "renameAgentProfile") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "newName"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.newName === "string" && AGENT_NAME_RE.test(value.newName)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "renameAgentProfile", agent: value.agent, expectedRevision: value.expectedRevision, newName: value.newName }
      : undefined;
  }
  if (value.type === "planAgentProfileForget") {
    return exactKeys(value, ["type", "agent", "expectedRevision"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "planAgentProfileForget", agent: value.agent, expectedRevision: value.expectedRevision }
      : undefined;
  }
  if (value.type === "forgetAgentProfile") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "confirmation"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.confirmation === "string" && AGENT_NAME_RE.test(value.confirmation)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "forgetAgentProfile", agent: value.agent, expectedRevision: value.expectedRevision, confirmation: value.confirmation }
      : undefined;
  }
  if (value.type === "setAgentProfileSubagents") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "subagents"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && Array.isArray(value.subagents) && value.subagents.length <= AGENT_OWNERSHIP_MAX_SUBAGENTS
      && value.subagents.every((child) => typeof child === "string" && AGENT_NAME_RE.test(child))
      ? { type: "setAgentProfileSubagents", agent: value.agent, expectedRevision: value.expectedRevision, subagents: [...value.subagents as string[]] }
      : undefined;
  }
  if (value.type === "setAgentProfileProposeGrant") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "granted"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && typeof value.granted === "boolean"
      ? { type: "setAgentProfileProposeGrant", agent: value.agent, expectedRevision: value.expectedRevision, granted: value.granted }
      : undefined;
  }
  if (value.type === "refreshEvolution") {
    return exactKeys(value, ["type", "agent"]) && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      ? { type: "refreshEvolution", agent: value.agent }
      : undefined;
  }
  if (value.type === "loadEvolutionCandidate") {
    return exactKeys(value, ["type", "agent", "candidateId"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.candidateId === "string" && /^candidate-[A-Za-z0-9_-]+$/.test(value.candidateId)
      ? { type: "loadEvolutionCandidate", agent: value.agent, candidateId: value.candidateId }
      : undefined;
  }
  if (value.type === "approveEvolutionCandidate" || value.type === "rejectEvolutionCandidate") {
    const hasDigest = value.expectedTargetDigest !== undefined;
    if (!exactKeys(value, ["type", "agent", "candidateId", "expectedActiveVersion", ...(hasDigest ? ["expectedTargetDigest"] : [])])
      || typeof value.agent !== "string" || !AGENT_NAME_RE.test(value.agent)
      || typeof value.candidateId !== "string" || !/^candidate-[A-Za-z0-9_-]+$/.test(value.candidateId)
      || !Number.isSafeInteger(value.expectedActiveVersion) || (value.expectedActiveVersion as number) < 0
      || (hasDigest && (typeof value.expectedTargetDigest !== "string" || !SHA256_RE.test(value.expectedTargetDigest)))) return undefined;
    return {
      type: value.type,
      agent: value.agent,
      candidateId: value.candidateId,
      expectedActiveVersion: value.expectedActiveVersion as number,
      ...(hasDigest ? { expectedTargetDigest: value.expectedTargetDigest as string } : {}),
    };
  }
  if (typeof value.type !== "string" || !AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES.includes(value.type as never)
    || value.type === "browse" || typeof value.agent !== "string" || !AGENT_NAME_RE.test(value.agent)) return undefined;
  if (value.type === "authorizePlugin") {
    // t-4a2a6f — `reauthorize` is REQUIRED on the wire, never defaulted. Accepting content that
    // changed after a human approved it is the one decision that must not be reachable by omission,
    // and an optional flag is reachable by omission the moment any caller forgets it.
    if (!exactKeys(value, ["type", "agent", "pluginName", "reauthorize"]) || typeof value.pluginName !== "string"
      || !SKILL_NAME_RE.test(value.pluginName) || typeof value.reauthorize !== "boolean") return undefined;
    return { type: "authorizePlugin", agent: value.agent, pluginName: value.pluginName, reauthorize: value.reauthorize };
  }
  if (value.type === "refreshAuthorizableCapabilities") {
    if (!exactKeys(value, ["type", "agent"])) return undefined;
    return { type: "refreshAuthorizableCapabilities", agent: value.agent };
  }
  if (value.type === "authorizeSkill") {
    // Bounded and shaped like the reference id it becomes; a name that cannot be a reference id can
    // never authorize anything, so refusing here beats failing deeper with a schema message.
    if (!exactKeys(value, ["type", "agent", "skillName", "reauthorize"]) || typeof value.skillName !== "string"
      || !SKILL_NAME_RE.test(value.skillName) || typeof value.reauthorize !== "boolean") return undefined;
    return { type: "authorizeSkill", agent: value.agent, skillName: value.skillName, reauthorize: value.reauthorize };
  }
  if (value.type === "adoptSoulProfile") {
    if (!exactKeys(value, ["type", "agent", "expectedDigest"]) || typeof value.expectedDigest !== "string" || !SHA256_RE.test(value.expectedDigest)) return undefined;
    return { type: "adoptSoulProfile", agent: value.agent, expectedDigest: value.expectedDigest };
  }
  if (value.type === "importSoul") {
    if (!exactKeys(value, ["type", "agent", "contentBase64"])
      || !isCanonicalSoulImportBase64(value.contentBase64)) return undefined;
    return { type: "importSoul", agent: value.agent, contentBase64: value.contentBase64 };
  }
  if (value.type === "replaceSoul") {
    if (!exactKeys(value, ["type", "agent", "contentBase64", "expectedDigest"])
      || !isCanonicalSoulImportBase64(value.contentBase64)
      || typeof value.expectedDigest !== "string" || !SHA256_RE.test(value.expectedDigest)) return undefined;
    return { type: "replaceSoul", agent: value.agent, contentBase64: value.contentBase64, expectedDigest: value.expectedDigest };
  }
  if (!exactKeys(value, ["type", "agent"])) return undefined;
  return { type: value.type as Exclude<AgentStudioSoulActionMessage["type"], "adoptSoulProfile" | "importSoul" | "replaceSoul">, agent: value.agent };
}

/** Host-facing profile status snapshot (no import source path). */
export interface SoulProfileStatusMessage {
  agent: string;
  relativePath: string;
  lifecycle: "missing" | "active" | "retained" | "unowned" | "invalid";
  profileId?: string;
  sha256?: string;
  chars?: number;
  bytes?: number;
  soulEnabled: boolean;
  resolvable: boolean;
  transactionDegraded: boolean;
  preview?: string;
  /** Which action produced this status, when applicable. */
  action?: "create" | "import" | "replace" | "open" | "refresh" | "preview" | "adopt" | "enable" | "disable" | "delete";
  selfSelected?: boolean;
}

export function projectSoulProfileStatus(
  value: SoulProfileStatusMessage,
  extras?: Pick<SoulProfileStatusMessage, "action" | "selfSelected">,
): SoulProfileStatusMessage {
  return {
    agent: value.agent,
    relativePath: value.relativePath,
    lifecycle: value.lifecycle,
    ...(value.profileId !== undefined ? { profileId: value.profileId } : {}),
    ...(value.sha256 !== undefined ? { sha256: value.sha256 } : {}),
    ...(value.chars !== undefined ? { chars: value.chars } : {}),
    ...(value.bytes !== undefined ? { bytes: value.bytes } : {}),
    soulEnabled: value.soulEnabled,
    resolvable: value.resolvable,
    transactionDegraded: value.transactionDegraded,
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
    ...(extras?.action !== undefined ? { action: extras.action } : value.action !== undefined ? { action: value.action } : {}),
    ...(extras?.selfSelected !== undefined ? { selfSelected: extras.selfSelected } : value.selfSelected !== undefined ? { selfSelected: value.selfSelected } : {}),
  };
}

export function isSoulProfileStatusMessage(raw: unknown): raw is SoulProfileStatusMessage {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Partial<SoulProfileStatusMessage>;
  if (typeof value.agent !== "string" || !AGENT_NAME_RE.test(value.agent)
    || value.relativePath !== `.tachyon/agents/${value.agent}/SOUL.md`
    || !["missing", "active", "retained", "unowned", "invalid"].includes(value.lifecycle ?? "")
    || typeof value.soulEnabled !== "boolean" || typeof value.resolvable !== "boolean" || typeof value.transactionDegraded !== "boolean") return false;
  if (value.profileId !== undefined && !PROFILE_ID_RE.test(value.profileId)) return false;
  if (value.sha256 !== undefined && !SHA256_RE.test(value.sha256)) return false;
  if (value.chars !== undefined && (!Number.isSafeInteger(value.chars) || value.chars < 0)) return false;
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0)) return false;
  if (value.preview !== undefined && (typeof value.preview !== "string" || value.preview.length > 2_002)) return false;
  if (value.action !== undefined && !["create", "import", "replace", "open", "refresh", "preview", "adopt", "enable", "disable", "delete"].includes(value.action)) return false;
  return value.selfSelected === undefined || typeof value.selfSelected === "boolean";
}

function isEvolutionCandidateSummary(raw: unknown): raw is AgentEvolutionCandidateSummaryMessage {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Partial<AgentEvolutionCandidateSummaryMessage>;
  return typeof value.id === "string" && /^candidate-[A-Za-z0-9_-]+$/.test(value.id)
    && typeof value.reviewId === "string" && /^review-[A-Za-z0-9_-]+$/.test(value.reviewId)
    && typeof value.taskId === "string" && value.taskId.length > 0
    && (value.taskTitle === undefined || typeof value.taskTitle === "string")
    && typeof value.createdAt === "string"
    && ["pending", "approved", "rejected"].includes(value.status ?? "")
    && ["learning", "skill"].includes(value.kind ?? "")
    && typeof value.reason === "string"
    && (value.operation === undefined || ["create", "update"].includes(value.operation))
    && (value.skillName === undefined || typeof value.skillName === "string");
}

function isEvolutionSummary(raw: unknown): raw is AgentEvolutionSummaryMessage {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Partial<AgentEvolutionSummaryMessage>;
  if (typeof value.agent !== "string" || !AGENT_NAME_RE.test(value.agent)
    || typeof value.enabled !== "boolean" || typeof value.profilePresent !== "boolean"
    || !Number.isSafeInteger(value.activeVersion) || (value.activeVersion ?? -1) < 0
    || !Number.isSafeInteger(value.pendingCount) || (value.pendingCount ?? -1) < 0
    || !Array.isArray(value.activeLearnings) || !Array.isArray(value.activeSkillNames)) return false;
  if (!value.activeLearnings.every((entry) => entry && typeof entry.id === "string" && typeof entry.content === "string")
    || !value.activeSkillNames.every((name) => typeof name === "string")) return false;
  if (value.lastReview === undefined) return true;
  return typeof value.lastReview.id === "string" && /^review-[A-Za-z0-9_-]+$/.test(value.lastReview.id)
    && typeof value.lastReview.taskId === "string" && typeof value.lastReview.taskTitle === "string"
    && typeof value.lastReview.createdAt === "string"
    && ["pending", "submitted", "no-proposal", "failed"].includes(value.lastReview.status)
    && (value.lastReview.failure === undefined || typeof value.lastReview.failure === "string");
}

function isEvolutionCandidateDetail(raw: unknown): raw is AgentEvolutionCandidateDetailMessage {
  if (!isEvolutionCandidateSummary(raw)) return false;
  const value = raw as AgentEvolutionCandidateDetailMessage;
  if (!Number.isSafeInteger(value.expectedActiveVersion) || value.expectedActiveVersion < 0
    || (value.expectedTargetDigest !== undefined && !SHA256_RE.test(value.expectedTargetDigest))) return false;
  if (value.kind === "learning") return typeof value.learningContent === "string" && value.files === undefined;
  const validFiles = (files: unknown): boolean => Array.isArray(files) && files.every((file) => {
    if (!file || typeof file !== "object") return false;
    const candidate = file as Record<string, unknown>;
    return typeof candidate.path === "string" && typeof candidate.content === "string"
      && (candidate.executable === undefined || typeof candidate.executable === "boolean");
  });
  return value.learningContent === undefined && validFiles(value.files)
    && (value.currentFiles === undefined || validFiles(value.currentFiles));
}

/** Runtime validation for host-only domain responses consumed by the browser shell. */
export function validateAgentStudioHostDomainMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  if (value.type === "agentProfileSnapshot") {
    return exactKeys(value, ["type", "action", "snapshot"])
      && ["refresh", "set-enabled", "rename", "set-subagents", "set-propose-saved-agent-grant"].includes(String(value.action))
      && isAgentProfileStudioSnapshotV1(value.snapshot);
  }
  if (value.type === "agentProfileBundleExport") return exactKeys(value, ["type", "result"]) && agentProfileStudioBundleExportResultSchemaV1.safeParse(value.result).success;
  if (value.type === "agentProfileBundleCreated") return exactKeys(value, ["type", "result"]) && agentProfileStudioBundleCreatedResultSchemaV1.safeParse(value.result).success;
  if (value.type === "agentProfileBundleError") {
    return exactKeys(value, ["type", "agent", "code", "message", "conflict"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^agent-profile\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000 && typeof value.conflict === "boolean";
  }
  if (value.type === "agentProfileOwnership") {
    return exactKeys(value, ["type", "agent", "ownership"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && agentOwnershipViewSchemaV1.safeParse(value.ownership).success;
  }
  if (value.type === "agentProfileForgetPlan") {
    return exactKeys(value, ["type", "agent", "result"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && agentForgetPlanResultSchemaV1.safeParse(value.result).success;
  }
  if (value.type === "agentProfileForgotten") {
    return exactKeys(value, ["type", "agent", "agentId"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.agentId === "string" && PROFILE_ID_RE.test(value.agentId);
  }
  if (value.type === "authorizableCapabilities") {
    // t-5498a6 — validated here or it never reaches the App: an unlisted host message is reported as
    // "malformed Agent Studio host response", which is what a missing branch looks like from the UI —
    // a protocol error at the top of the page and two selectors stuck on Loading forever.
    if (!exactKeys(value, ["type", "agent", "capabilities"])
      || typeof value.agent !== "string" || !AGENT_NAME_RE.test(value.agent)) return false;
    const capabilities = value.capabilities as { workspaceSkills?: unknown; plugins?: unknown } | null;
    if (!capabilities || typeof capabilities !== "object") return false;
    if (!Array.isArray(capabilities.workspaceSkills) || !Array.isArray(capabilities.plugins)) return false;
    const checkoutOnly = (capabilities as { checkoutOnlyPlugins?: unknown }).checkoutOnlyPlugins;
    if (checkoutOnly !== undefined
      && (!Array.isArray(checkoutOnly) || checkoutOnly.length > 256
        || !checkoutOnly.every((name) => typeof name === "string" && SKILL_NAME_RE.test(name)))) return false;
    if (capabilities.workspaceSkills.length > 256 || capabilities.plugins.length > 256) return false;
    // t-4a2a6f — the annotation drives which control is offered, so a malformed one must be refused
    // rather than coerced: an `authorized` that failed to parse would render as "never authorized"
    // and put the plain Authorize button back on a stale entry, which is the bug this fixes.
    const okAuthorized = (entry: unknown): boolean => {
      if (entry === undefined) return true;
      const state = entry as Record<string, unknown>;
      if (typeof state !== "object" || state === null || typeof state.stale !== "boolean") return false;
      return state.version === undefined || (typeof state.version === "string" && state.version.length <= 256);
    };
    const okSkill = (entry: unknown): boolean => {
      const skill = entry as { name?: unknown; path?: unknown; authorized?: unknown };
      return typeof skill?.name === "string" && SKILL_NAME_RE.test(skill.name)
        && typeof skill.path === "string" && skill.path.length <= 1_024
        && okAuthorized(skill.authorized);
    };
    const okPlugin = (entry: unknown): boolean => {
      const plugin = entry as Record<string, unknown>;
      return typeof plugin?.name === "string" && SKILL_NAME_RE.test(plugin.name)
        && typeof plugin.version === "string" && plugin.version.length <= 256
        && Array.isArray(plugin.runtimes) && Array.isArray(plugin.skills) && Array.isArray(plugin.ungrantableKinds)
        && typeof plugin.authorizable === "boolean"
        && (plugin.reason === undefined || (typeof plugin.reason === "string" && plugin.reason.length <= 2_000))
        && okAuthorized(plugin.authorized);
    };
    return capabilities.workspaceSkills.every(okSkill) && capabilities.plugins.every(okPlugin);
  }
  if (value.type === "agentProfileError") {
    return exactKeys(value, ["type", "agent", "code", "message", "conflict"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^agent-profile\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000
      && typeof value.conflict === "boolean";
  }
  /** t-746f0f — same shape as the error, minus `conflict`: a notice has no recovery for the shell to run. */
  if (value.type === "agentProfileNotice") {
    return exactKeys(value, ["type", "agent", "code", "message"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^agent-profile\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000;
  }
  if (value.type === "cwd") return exactKeys(value, ["type", "value"]) && typeof value.value === "string";
  if (value.type === "soulProfileStatus") return exactKeys(value, ["type", "status"]) && isSoulProfileStatusMessage(value.status);
  if (value.type === "soulProfileError") {
    return exactKeys(value, ["type", "agent", "code", "message"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^soul\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000;
  }
  if (value.type === "evolutionSummary") {
    return exactKeys(value, ["type", "summary"]) && isEvolutionSummary(value.summary);
  }
  if (value.type === "evolutionCandidates") {
    return exactKeys(value, ["type", "agent", "candidates"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && Array.isArray(value.candidates) && value.candidates.every(isEvolutionCandidateSummary);
  }
  if (value.type === "evolutionCandidateDetail") {
    return exactKeys(value, ["type", "agent", "detail"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && isEvolutionCandidateDetail(value.detail);
  }
  if (value.type === "evolutionActionResult") {
    return exactKeys(value, ["type", "agent", "candidateId", "status", "activeVersion"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.candidateId === "string" && /^candidate-[A-Za-z0-9_-]+$/.test(value.candidateId)
      && ["approved", "rejected"].includes(String(value.status))
      && Number.isSafeInteger(value.activeVersion) && (value.activeVersion as number) >= 0;
  }
  if (value.type === "evolutionError") {
    return exactKeys(value, ["type", "agent", "code", "message", "conflict"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^evolution\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000
      && typeof value.conflict === "boolean";
  }
  return false;
}

/** The load-time snapshot: the agent's current FormState (kind fixed "agent") plus the reference data the
 *  form needs to render (quick-add chips, flag suggestions, default cwd). Mirrors
 *  TaskDetailEntity's convention of carrying read-only reference data alongside the editable snapshot. */
export interface AgentStudioEntity {
  /** undefined in "new" mode. */
  name?: string;
  fields: AgentStudioFields;
  storage?: "legacy" | "canonical";
  /** Present only for canonical storage; redacted and never accepted as a save payload. */
  profile?: AgentProfileStudioSnapshotV1;
  /** t-4c113c — declared ownership for this agent, host-composed alongside the canonical snapshot. */
  ownership?: AgentOwnershipViewV1;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  persistentInstructionsHelp: string;
  evolutionLabels: AgentEvolutionLabels;
  profileLabels?: AgentProfileLabels;
}

/** Host-localized copy for the canonical profile-only region. */
export interface AgentProfileLabels {
  lifecycleTitle: string;
  lifecycleHelp: string;
  runtimeReadinessTitle: string;
  runtimeReady: string;
  runtimeLimited: string;
  runtimeReadinessHelp: string;
  runtimeLimitationBaselineUnverified: string;
  runtimeLimitationForkUnavailable: string;
  runtimeLimitationPermissionPolicyPartial: string;
  runtimeLimitationAttentionComposerUnverified: string;
  runtimeLimitationStopActiveTurnUnverified: string;
  runtimeLimitationOauthConcurrencySingleLive: string;
  enabled: string;
  disabled: string;
  closed: string;
  degraded: string;
  conflict: string;
  enableAgent: string;
  disableAgent: string;
  refresh: string;
  retryRefresh: string;
  rename: string;
  forget: string;
  ownershipTitle: string;
  ownershipHelp: string;
  ownershipNone: string;
  ownershipOwnedBy: string;
  ownershipNoCandidates: string;
  ownershipApply: string;
  proposeGrantTitle: string;
  proposeGrantHelp: string;
  proposeGrantRisk: string;
  proposeGrantLabel: string;
  proposeGrantOn: string;
  proposeGrantOff: string;
  export: string;
  clone: string;
  import: string;
  saveFirst: string;
  newAgentSetupHelp: string;
  provenanceTitle: string;
  provenanceHelp: string;
  authoredProfile: string;
  hostAuthority: string;
  learnedState: string;
  runtimeProjection: string;
  writable: string;
  readOnly: string;
  scope: string;
  profileScope: string;
  hostScope: string;
  runtimeScope: string;
  present: string;
  absent: string;
  active: string;
  inactive: string;
  grants: string;
  bindingsTitle: string;
  environmentValues: string;
  secrets: string;
  externalReferences: string;
  capabilities: string;
  promptInputs: string;
  profileIdentity: string;
  nativeConfigTitle: string;
  nativeConfigHelp: string;
  nativeConfigEmpty: string;
  nativeConfigPermissions: string;
  nativeConfigInterface: string;
  nativeConfigFeatureFlags: string;
  nativeConfigExclude: string;
  nativeConfigGlobal: string;
  nativeConfigWorkspace: string;
  nativeConfigBypassLabel: string;
  nativeConfigBypassRisk: string;
  nativeConfigNeverApprovalLabel: string;
  nativeConfigNeverApprovalRisk: string;
  nativeConfigFullAccessLabel: string;
  nativeConfigFullAccessRisk: string;
  runtimeSelectorsTitle: string;
  runtimeSelectorsHelp: string;
  runtimeModel: string;
  runtimeProvider: string;
  runtimeReasoningEffort: string;
  runtimeServiceTier: string;
  runtimeDefault: string;
  canonicalTrustHelp: string;
  supported: string;
  unsupported: string;
}

/** Human-visible copy is translated by the extension host and projected in the load entity. */
export interface AgentEvolutionLabels {
  title: string;
  description: string;
  enable: string;
  enableHelp: string;
  enabled: string;
  disabled: string;
  saveFirst: string;
  loading: string;
  refresh: string;
  activeVersion: string;
  pendingProposals: string;
  lastReview: string;
  noReview: string;
  reviewPending: string;
  reviewSubmitted: string;
  reviewNoProposal: string;
  reviewFailed: string;
  activeLearnings: string;
  activeSkills: string;
  none: string;
  proposals: string;
  noProposals: string;
  learning: string;
  skill: string;
  create: string;
  update: string;
  sourceTask: string;
  reason: string;
  inspect: string;
  before: string;
  proposed: string;
  approve: string;
  reject: string;
  approved: string;
  rejected: string;
  nextSession: string;
  profilePending: string;
}

export type AgentStudioTranslate = (message: string, ...args: (string | number | boolean)[]) => string;

/** Called by the host with vscode.l10n.t; the browser only receives the resulting strings. */
export function createAgentEvolutionLabels(t: AgentStudioTranslate = (message) => message): AgentEvolutionLabels {
  return {
    title: t("Agent Evolution"),
    description: t("Tachyon reviews completed tasks and proposes reusable learnings or Agent Skills."),
    enable: t("Enable self-evolution for this agent"),
    enableHelp: t("Every proposal stays inactive until you approve or reject it here."),
    enabled: t("Enabled"),
    disabled: t("Disabled"),
    saveFirst: t("Save agent first"),
    loading: t("Loading evolution state…"),
    refresh: t("Refresh"),
    activeVersion: t("Active version"),
    pendingProposals: t("Pending proposals"),
    lastReview: t("Last task review"),
    noReview: t("No completed-task review yet"),
    reviewPending: t("Review pending"),
    reviewSubmitted: t("Proposals submitted"),
    reviewNoProposal: t("Reviewed — no useful proposal"),
    reviewFailed: t("Review failed"),
    activeLearnings: t("Active learnings"),
    activeSkills: t("Active Agent Skills"),
    none: t("None"),
    proposals: t("Proposals"),
    noProposals: t("No proposals yet"),
    learning: t("Learning"),
    skill: t("Agent Skill"),
    create: t("Create"),
    update: t("Update"),
    sourceTask: t("Source Task"),
    reason: t("Reason"),
    inspect: t("Inspect proposal"),
    before: t("Current"),
    proposed: t("Proposed"),
    approve: t("Approve"),
    reject: t("Reject"),
    approved: t("Approved"),
    rejected: t("Rejected"),
    nextSession: t("Approved changes are available only in the next fresh session. The current session does not change."),
    profilePending: t("The Evolution Profile will be created after the first completed-task review."),
  };
}

export function createAgentProfileLabels(t: AgentStudioTranslate = (message) => message): AgentProfileLabels {
  return {
    lifecycleTitle: t("Agent lifecycle"),
    lifecycleHelp: t("Operational actions use the loaded profile revision and stay separate from form save."),
    runtimeReadinessTitle: t("Canonical runtime readiness"),
    runtimeReady: t("Ready"), runtimeLimited: t("Limited"),
    runtimeReadinessHelp: t("This is the effective canonical baseline for this runtime. Limitations remain in effect when you enable or start the agent."),
    runtimeLimitationBaselineUnverified: t("This runtime has no verified canonical baseline yet."),
    runtimeLimitationForkUnavailable: t("Native session fork is unavailable for this runtime."),
    runtimeLimitationPermissionPolicyPartial: t("Native permission-policy projection is not fully verified."),
    runtimeLimitationAttentionComposerUnverified: t("Attention and drafted-composer behavior still need live verification."),
    runtimeLimitationStopActiveTurnUnverified: t("Stopping an active turn still needs live verification."),
    runtimeLimitationOauthConcurrencySingleLive: t("OAuth admission permits one live Pi agent at a time."),
    enabled: t("Enabled"), disabled: t("Disabled"), closed: t("Closed"), degraded: t("Degraded"), conflict: t("Conflict"),
    enableAgent: t("Enable agent"), disableAgent: t("Disable agent"), refresh: t("Refresh"), retryRefresh: t("Refresh and retry"),
    rename: t("Rename…"), forget: t("Forget…"), export: t("Export"), clone: t("Clone…"), import: t("Import…"),
    ownershipTitle: t("Declared subagents"),
    ownershipHelp: t("Declared ownership groups these agents under this one in the sidebar. It does not change who actually spawns them, and it does not start anything."),
    ownershipNone: t("This agent declares no subagents."),
    ownershipOwnedBy: t("This agent is already declared as a subagent of {0}, so it cannot own others."),
    ownershipNoCandidates: t("No other agent is available to declare. A candidate must be an agent that no one else owns and that declares no subagents of its own."),
    ownershipApply: t("Save declared subagents"),
    proposeGrantTitle: t("Saved Agent proposals"),
    proposeGrantHelp: t(
      "Lets this agent ASK you to create a new Saved Agent. It never creates one: every proposal waits"
      + " in the Human Inbox for your review. Approving creates the agent enabled; starting it stays a"
      + " separate action.",
    ),
    proposeGrantRisk: t(
      "Grant this only to an agent you trust to spend your attention. It can propose repeatedly, and each"
      + " proposal is a decision you have to make. A proposed agent can never receive this same"
      + " capability, so approving one cannot hand out the right to propose.",
    ),
    proposeGrantLabel: t("May propose Saved Agents for your review"),
    proposeGrantOn: t("Granted — this agent may send you proposals."),
    proposeGrantOff: t("Not granted — proposals from this agent are refused."),
    saveFirst: t("Save or discard form changes before a lifecycle action."),
    newAgentSetupHelp: t("Save this agent to create its canonical profile. Then choose pre-authorized MCP servers, skills, and hooks in Runtime tooling."),
    provenanceTitle: t("Profile sources and authority"),
    provenanceHelp: t("Only authored profile values are editable. Authority, learned state, and runtime projection are read-only."),
    authoredProfile: t("Authored profile"), hostAuthority: t("Host authority"), learnedState: t("Learned state"), runtimeProjection: t("Runtime projection"),
    writable: t("Writable"), readOnly: t("Read-only"), scope: t("Scope"), profileScope: t("Agent profile"), hostScope: t("Host"), runtimeScope: t("Runtime"),
    present: t("Present"), absent: t("Absent"), active: t("Active"), inactive: t("Inactive"), grants: t("Grants"),
    bindingsTitle: t("Bound profile data"), environmentValues: t("Environment values"), secrets: t("Secret references"),
    externalReferences: t("External references"), capabilities: t("Capabilities"), promptInputs: t("Prompt inputs"), profileIdentity: t("Profile identity"),
    nativeConfigTitle: t("Native configuration"),
    nativeConfigHelp: t("Supported choices are projected into the agent's private runtime home. Raw runtime files and credentials are never shown here."),
    nativeConfigEmpty: t("No native configuration policy is authored for this agent."),
    nativeConfigPermissions: t("Permissions"),
    nativeConfigInterface: t("Interface"),
    nativeConfigFeatureFlags: t("Feature flags"),
    nativeConfigExclude: t("Exclude"),
    nativeConfigGlobal: t("Use global defaults"),
    nativeConfigWorkspace: t("Use workspace defaults"),
    nativeConfigBypassLabel: t("Authorize bypassing permission prompts"),
    nativeConfigBypassRisk: t(
      "This agent will run tools without asking for permission, including file writes and shell commands."
      + " Only the agents you authorize here are affected — the setting is never inherited on its own.",
    ),
    nativeConfigNeverApprovalLabel: t("Authorize never asking for approval"),
    nativeConfigNeverApprovalRisk: t(
      "This agent will run commands without asking for approval. Only the agents you authorize here are"
      + " affected — the setting is never inherited on its own.",
    ),
    nativeConfigFullAccessLabel: t("Authorize running without a sandbox"),
    nativeConfigFullAccessRisk: t(
      "This agent will run commands with full disk and network access instead of inside the sandbox."
      + " Only the agents you authorize here are affected — the setting is never inherited on its own.",
    ),
    runtimeSelectorsTitle: t("Runtime selectors"),
    runtimeSelectorsHelp: t("Selectors are projected through measured native runtime arguments. Unsupported fields are not authored."),
    runtimeModel: t("Model"),
    runtimeProvider: t("Provider"),
    runtimeReasoningEffort: t("Reasoning effort"),
    runtimeServiceTier: t("Service tier"),
    runtimeDefault: t("Runtime default"),
    canonicalTrustHelp: t("Enabling or starting this canonical agent authorizes native folder trust only for the current workspace and effective working directory. General approvals, sandbox policy, and arbitrary hook trust stay unchanged."),
    supported: t("Supported"),
    unsupported: t("Unsupported"),
  };
}

export type AgentEvolutionSummaryMessage = EvolutionStudioSummary;
export type AgentEvolutionCandidateSummaryMessage = EvolutionStudioCandidateSummary;
export type AgentEvolutionCandidateDetailMessage = EvolutionStudioCandidateDetail;

export interface AgentStudioCanonicalContext {
  kind: "agent-instance";
  expectedRevision?: string;
  displayName: string;
  runtime: AgentProfileStudioSnapshotV1["editable"]["runtime"];
  nativeConfig: NonNullable<AgentProfileStudioSnapshotV1["editable"]["nativeConfig"]>;
  capabilities: NonNullable<AgentProfileStudioSnapshotV1["editable"]["capabilities"]>;
}

export type AgentStudioFields = FormState & { canonical?: AgentStudioCanonicalContext };
export type AgentStudioPatch = FormState | (AgentProfileStudioMutationV1 & Partial<Omit<FormState, "kind">>);

/** A blank agent-kind FormState.
 *  (attention on by default, no worktree). */
export function blankAgentFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "agent",
    instructions: "",
    soul: false,
    selfEvolution: false,
    role: "",
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: true,
    worktree: false,
    branch: "",
    worktreeSetup: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}

export function canonicalAgentFields(snapshot?: AgentProfileStudioSnapshotV1): AgentStudioFields {
  const fields = blankAgentFields() as AgentStudioFields;
  fields.name = snapshot?.agentName ?? "";
  fields.cmd = snapshot?.editable.runtime.executable ?? "";
  fields.role = snapshot?.editable.role ?? "";
  fields.soul = snapshot?.bindings.prompt.soul ?? false;
  // t-f96b2f — read from the EDITABLE view, not from `bindings.prompt.evolution`. Both report the
  // same fact today (the projection computes them from one expression), and reading the one the form
  // saves back is what keeps them from becoming a display that disagrees with its own payload.
  fields.selfEvolution = snapshot?.editable.selfEvolution ?? false;
  fields.cwd = snapshot?.editable.cwd ?? "";
  fields.autostart = snapshot?.editable.lifecycle.autostart ?? false;
  fields.restartOnCrash = snapshot?.editable.lifecycle.restart === "on-crash";
  fields.attention = snapshot?.editable.lifecycle.attention ?? true;
  // t-bd14d8 — `fields.watch` stays at its blank default and is never read back from a snapshot: an
  // Agent has no watch. The field survives on `FormState` because that type is shared with the
  // Terminal form, where a watch is the whole point.
  // t-4071e4 — `enabled` is a required boolean on a snapshot, so the fallback fires only for a NEW
  // agent, where it must match every other creation door. Editing an existing agent still shows that
  // agent's real posture.
  fields.worktree = snapshot?.editable.worktree.enabled ?? DEFAULT_NEW_AGENT_WORKTREE_ENABLED;
  fields.branch = snapshot?.editable.worktree.branch ?? "";
  // t-afc86e — read the workspace commands BACK into the form. This line is the whole reason the
  // snapshot carries the artifact bytes: without it the field renders blank for an agent that has a
  // gate, and the next save writes that blank over the real one.
  fields.worktreeSetup = (snapshot?.editable.worktree.setup ?? []).join("\n");
  fields.isolate = snapshot?.editable.isolation === "transcript";
  fields.canonical = {
    kind: "agent-instance",
    ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
    displayName: snapshot?.editable.displayName ?? "",
    runtime: snapshot ? { ...snapshot.editable.runtime } : { adapter: "codex", executable: "" },
    nativeConfig: structuredClone(
      snapshot ? snapshot.editable.nativeConfig ?? {} : defaultCodexScalarNativeConfigPolicy(),
    ),
    capabilities: structuredClone(snapshot?.editable.capabilities ?? { skills: [], mcp: [], hooks: [] }),
  };
  return fields;
}

function canonicalAdapter(fields: AgentStudioFields): string {
  if (fields.canonical?.expectedRevision) return fields.canonical.runtime.adapter;
  const executable = fields.cmd.trim().split(/[\\/]/).pop() ?? fields.cmd.trim();
  return executable;
}

export function nativeConfigChoice(
  fields: AgentStudioFields,
  family: CodexScalarNativeConfigFamily,
): CodexScalarNativeConfigChoice {
  const source = fields.canonical?.nativeConfig[family]?.source;
  return source === "global" || source === "workspace" ? source : "exclude";
}

/**
 * The sources this agent's runtime actually honors, in render order. Grok offers only `global`:
 * t-26f508 measured that a project `.grok/config.toml` contributes nothing this projector reads, so
 * offering `workspace` would let someone author a policy the runtime ignores.
 */
export function nativeConfigSourceChoices(fields: AgentStudioFields): readonly ("global" | "workspace")[] {
  return canonicalAdapter(fields) === "grok" ? ["global"] : ["global", "workspace"];
}

export function setNativeConfigChoice(
  fields: AgentStudioFields,
  family: CodexScalarNativeConfigFamily,
  choice: CodexScalarNativeConfigChoice,
): AgentStudioFields {
  if (!fields.canonical) return fields;
  const adapter = canonicalAdapter(fields);
  const nativeConfig = structuredClone(fields.canonical.nativeConfig);
  if (choice === "exclude") delete nativeConfig[family];
  else if (adapter === "grok") nativeConfig[family] = grokScalarNativeConfigPolicy("global");
  else nativeConfig[family] = adapter === "claude"
    ? claudeScalarNativeConfigPolicy(choice)
    : codexScalarNativeConfigPolicy(choice);
  return {
    ...fields,
    canonical: {
      ...fields.canonical,
      nativeConfig,
    },
  };
}

/** Compatibility names for host/tests while the UI uses the runtime-neutral helpers. */
export const codexNativeConfigChoice = nativeConfigChoice;
export const setCodexNativeConfigChoice = setNativeConfigChoice;

/**
 * SDD 471/472 — the dangerous authorizations each runtime offers, in render order. Empty for a
 * runtime with none, which is what hides the control.
 */
export const PERMISSION_AUTHORIZATION_CHOICES: Record<string, readonly string[]> = {
  claude: [CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION],
  codex: [CODEX_NEVER_APPROVAL_AUTHORIZATION, CODEX_FULL_ACCESS_AUTHORIZATION],
  // t-26f508 — Grok's `always-approve` grants exactly what Claude's `bypassPermissions` grants, so
  // `permissionAuthorizationCopy` reuses that copy rather than translating a second wording for the
  // same consequence.
  grok: [GROK_ALWAYS_APPROVE_AUTHORIZATION],
};

/** The authorizations offered for this agent — none unless its runtime declares some and the
 *  permissions family is actually being projected. */
export function permissionAuthorizationChoices(fields: AgentStudioFields): readonly string[] {
  if (nativeConfigChoice(fields, "permissions") === "exclude") return [];
  return PERMISSION_AUTHORIZATION_CHOICES[canonicalAdapter(fields)] ?? [];
}

/** Label + consequence copy for one authorization member, from the translated label set. */
export function permissionAuthorizationCopy(
  labels: AgentProfileLabels,
  member: string,
): { label: string; risk: string } {
  if (member === CODEX_NEVER_APPROVAL_AUTHORIZATION) {
    return { label: labels.nativeConfigNeverApprovalLabel, risk: labels.nativeConfigNeverApprovalRisk };
  }
  if (member === CODEX_FULL_ACCESS_AUTHORIZATION) {
    return { label: labels.nativeConfigFullAccessLabel, risk: labels.nativeConfigFullAccessRisk };
  }
  return { label: labels.nativeConfigBypassLabel, risk: labels.nativeConfigBypassRisk };
}

/** Whether this agent explicitly authorized `member`. Off unless the profile names it. */
export function nativeConfigAuthorized(fields: AgentStudioFields, member: string): boolean {
  return (fields.canonical?.nativeConfig.permissions?.authorize ?? []).includes(member);
}

export function setNativeConfigAuthorized(
  fields: AgentStudioFields,
  member: string,
  authorized: boolean,
): AgentStudioFields {
  if (!fields.canonical) return fields;
  const nativeConfig = structuredClone(fields.canonical.nativeConfig);
  const permissions = nativeConfig.permissions;
  if (!permissions) return fields;
  const authorize = (permissions.authorize ?? []).filter((entry) => entry !== member);
  if (authorized) authorize.push(member);
  nativeConfig.permissions = { ...permissions };
  if (authorize.length > 0) nativeConfig.permissions.authorize = authorize;
  else delete nativeConfig.permissions.authorize;
  return { ...fields, canonical: { ...fields.canonical, nativeConfig } };
}

function normalizedRuntime(
  fields: AgentStudioFields,
  adapter: string,
  executable: string,
): AgentProfileStudioMutationV1["editable"]["runtime"] {
  const authored = fields.canonical!.runtime;
  return {
    adapter,
    executable,
    ...(authored.model?.trim() ? { model: authored.model.trim() } : {}),
    ...(adapter === "codex" && authored.provider?.trim() ? { provider: authored.provider.trim() } : {}),
    ...(authored.reasoningEffort?.trim() ? { reasoningEffort: authored.reasoningEffort.trim() } : {}),
    ...(adapter === "codex" && authored.serviceTier?.trim() ? { serviceTier: authored.serviceTier.trim() } : {}),
  };
}

function normalizedNativeConfig(
  fields: AgentStudioFields,
  adapter: string,
  runtime: AgentProfileStudioMutationV1["editable"]["runtime"],
): NonNullable<AgentProfileStudioMutationV1["editable"]["nativeConfig"]> {
  if (adapter === "grok") {
    // t-26f508 — a canonical Grok profile always records the three refusals (ambient project tooling,
    // native memory, externally-owned auth) so they are visible in the profile, not only in the
    // materializer. The scalar rows are then applied over that base.
    const grok = defaultGrokNativeConfigPolicy();
    for (const family of ["permissions", "interface", "featureFlags"] as const) {
      if (nativeConfigChoice(fields, family) === "exclude") {
        delete grok[family];
        continue;
      }
      const authorize = family === "permissions"
        ? (PERMISSION_AUTHORIZATION_CHOICES.grok ?? []).filter((member) => nativeConfigAuthorized(fields, member))
        : [];
      grok[family] = grokScalarNativeConfigPolicy("global", authorize);
    }
    if (runtime.model || runtime.reasoningEffort) grok.selectors = grokSelectorNativeConfigPolicy();
    return grok;
  }
  if (adapter !== "codex" && adapter !== "claude") return {};
  const current = fields.canonical!.nativeConfig;
  const result = Object.fromEntries(
    Object.entries(current)
      .filter(([family]) => !["selectors", "permissions", "interface", "featureFlags"].includes(family))
      .map(([family, policy]) => [family, structuredClone(policy)]),
  ) as NonNullable<AgentProfileStudioMutationV1["editable"]["nativeConfig"]>;
  for (const family of ["permissions", "interface", "featureFlags"] as const) {
    const choice = nativeConfigChoice(fields, family);
    if (choice === "exclude") continue;
    // This rebuilds the policy from the dropdown on every save, so an authored authorization has
    // to be read back out of the current fields or it would silently reset (SDD 471/472). Excluding
    // the family drops it too, which is the correct reading of "stop projecting permissions".
    const authorize = family === "permissions"
      ? (PERMISSION_AUTHORIZATION_CHOICES[adapter] ?? []).filter((member) => nativeConfigAuthorized(fields, member))
      : [];
    result[family] = adapter === "claude"
      ? claudeScalarNativeConfigPolicy(choice, authorize)
      : codexScalarNativeConfigPolicy(choice, authorize);
  }
  if (runtime.model || runtime.provider || runtime.reasoningEffort || runtime.serviceTier) {
    result.selectors = adapter === "claude"
      ? claudeSelectorNativeConfigPolicy()
      : {
          source: "agent",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        };
  }
  return result;
}

export function computeAgentDirty(entity: AgentStudioEntity | undefined, fields: AgentStudioFields): boolean {
  const base = entity?.fields ?? blankAgentFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

/** The runtime a NEW canonical agent would be minted for — the executable's last path segment. */
function newAgentAdapter(fields: AgentStudioFields): string {
  const executable = fields.cmd.trim();
  return executable.split(/[\\/]/).pop() ?? executable;
}

/**
 * t-d68b8b — why this form may not create the agent the human just described, or `undefined` when it
 * may. Blocking, and evaluated live so the answer arrives while they are still typing the command.
 *
 * The refusal it replaces was worse than a missing one. `serializeAgentPatch` used to hand a
 * non-attested NEW agent to the legacy writer, which `Workspace.studioSubmit` had already retired:
 * the human filled the form, saved, and was told to "create or edit the canonical agent in Agent
 * Studio" — the form they were looking at. Measured over the six Quick Add runtimes that reached it
 * (opencode, copilot, agy, hermes, verboo, gemini), all six.
 *
 * The wording is load-bearing. The owner's decision on 2026-08-07 was to block creation for
 * non-attested runtimes *for now* — a deliberate, reversible narrowing of the creation path, not a
 * judgement that those runtimes are unfit. A message that read "unsupported runtime" would record
 * the wrong reason and outlive the decision, so it names the path and says the block lifts on
 * attestation. The list comes from `ATTESTED_RUNTIMES`, so it cannot drift from the door that
 * enforces it (`createProfileFromStudioMutation`, then `agentProfileProjection`).
 *
 * Silent about an EXISTING profile (`expectedRevision`) and about a legacy entry (no `canonical`):
 * neither is a creation, and refusing to save an agent that already exists would strand it.
 */
export function newAgentRuntimeRefusal(fields: AgentStudioFields): string | undefined {
  if (!fields.canonical || fields.canonical.expectedRevision) return undefined;
  const adapter = newAgentAdapter(fields);
  // An empty command is "you have not chosen yet", which the save path already reports as its own
  // missing-field error; answering it here would put a runtime refusal on a blank form.
  if (adapter.length === 0 || isAttestedRuntime(adapter)) return undefined;
  return (
    `Tachyon cannot create an agent for '${adapter}' yet: canonical agent creation covers only the `
    + `runtimes it attests (${ATTESTED_RUNTIMES.join(", ")}). This is a limit of the creation path, `
    + "not a verdict on the runtime — the block lifts as soon as the runtime is attested."
  );
}

export function serializeAgentPatch(fields: AgentStudioFields, dirty: boolean): AgentStudioPatch | undefined {
  if (!dirty) return undefined;
  if (!fields.canonical) return fields;
  const executable = fields.cmd.trim();
  const adapter = fields.canonical.expectedRevision
    ? fields.canonical.runtime.adapter
    : newAgentAdapter(fields);
  // t-d68b8b — a non-attested NEW agent used to be diverted here to the legacy writer, which
  // `Workspace.studioSubmit` refuses outright; the form's blocking `newAgentRuntimeRefusal` now stops
  // it before this point, and what is left is the one honest serialization. Serializing anyway rather
  // than returning `undefined` is deliberate: `undefined` means "nothing to save", which would turn a
  // bypassed gate into a Save button that does nothing instead of a refusal that says why.
  const runtime = normalizedRuntime(fields, adapter, executable);
  const nativeConfig = normalizedNativeConfig(fields, adapter, runtime);
  return {
    schemaVersion: 1,
    kind: "agent-instance",
    agentName: fields.name,
    ...(fields.canonical.expectedRevision ? { expectedRevision: fields.canonical.expectedRevision } : {}),
    editable: {
      displayName: fields.canonical.displayName,
      runtime,
      role: fields.role as AgentProfileStudioMutationV1["editable"]["role"],
      cwd: fields.cwd.trim(),
      // t-bd14d8 — no `watch`: the editable schema no longer carries one for an Agent, so sending it
      // would be rejected outright rather than ignored. That is the intended shape — a key the
      // product refuses to author should fail loudly at the door, not be dropped in silence.
      lifecycle: {
        autostart: fields.autostart,
        restart: fields.restartOnCrash ? "on-crash" : "never",
        attention: fields.attention,
      },
      // t-afc86e — setup commands as text. The webview never learns that the
      // profile stores them as pinned references; the host turns the text into bytes, a digest and a
      // reference entry. Blank and empty are meaningful values here, not omissions — they are how a
      worktree: {
        enabled: fields.worktree,
        branch: fields.branch.trim(),
        setup: fields.worktreeSetup.split("\n").map((line) => line.trim()).filter(Boolean),
      },
      // t-f96b2f — Evolution travels as the toggle's own state, on every save. Sending it only when
      // it changed would make "off" and "don't touch" the same payload, and off has to be able to
      // remove a binding that exists — the host turns it into the selector bytes, the pinned
      // reference and `prompt.evolution`, or removes all three.
      selfEvolution: fields.selfEvolution,
      isolation: fields.isolate ? "transcript" : "",
      nativeConfig,
      capabilities: structuredClone(fields.canonical.capabilities),
    },
  };
}

export function canDiscardAgentFields(fields: AgentStudioFields): boolean {
  if (fields.canonical) return fields.name.length === 0 && fields.cmd.length === 0 && fields.role.length === 0;
  return JSON.stringify(fields) === JSON.stringify(blankAgentFields());
}

export function agentStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: AgentStudioEntity | undefined): string {
  if (mode === "new") return "New Agent";
  return `Agent Studio — ${entity?.name ?? entityId ?? ""}`;
}
