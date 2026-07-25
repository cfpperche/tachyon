import type { FormState, QuickAddChip } from "../formLogic.js";
import type {
  EvolutionStudioCandidateDetail,
  EvolutionStudioCandidateSummary,
  EvolutionStudioSummary,
} from "../../evolution/studioProjection.js";
import type {
  AgentProfileStudioMutationV1,
  AgentProfileStudioSnapshotV1,
} from "../../config/agentProfileStudio.js";
import { isAgentProfileStudioSnapshotV1 } from "../../config/agentProfileStudio.js";
import { agentProfileStudioBundleCreatedResultSchemaV1, agentProfileStudioBundleExportResultSchemaV1 } from "../../config/agentProfileStudio.js";
import {
  codexScalarNativeConfigPolicy,
  defaultCodexScalarNativeConfigPolicy,
  type CodexScalarNativeConfigChoice,
  type CodexScalarNativeConfigFamily,
} from "../../config/agentNativeConfigPolicy.js";

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
  "refreshCanonicalProfile",
  "setCanonicalProfileEnabled",
  "renameCanonicalProfile",
  "forgetCanonicalProfile",
  "exportCanonicalProfileBundle",
  "cloneCanonicalProfileBundle",
  "importCanonicalProfileBundle",
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
  "canonicalProfileSnapshot",
  "canonicalProfileForgotten",
  "canonicalProfileError",
  "canonicalProfileBundleExport",
  "canonicalProfileBundleCreated",
  "canonicalProfileBundleError",
] as const;

/** Complete surface vocabulary for collision checks only; boundary decoders use the directional lists. */
export const AGENT_STUDIO_DOMAIN_MESSAGE_NAMES = [
  ...AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
  ...AGENT_STUDIO_HOST_MESSAGE_NAMES,
] as const;

export type AgentStudioDomainMessageName = (typeof AGENT_STUDIO_DOMAIN_MESSAGE_NAMES)[number];

const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
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
  | { type: "refreshCanonicalProfile"; agent: string }
  | { type: "setCanonicalProfileEnabled"; agent: string; expectedRevision: string; enabled: boolean }
  | { type: "renameCanonicalProfile"; agent: string; expectedRevision: string; newName: string }
  | { type: "forgetCanonicalProfile"; agent: string; expectedRevision: string; confirmation: string };

export type AgentStudioBundleActionMessage =
  | { type: "exportCanonicalProfileBundle"; agent: string; expectedRevision: string }
  | { type: "cloneCanonicalProfileBundle"; agent: string; expectedRevision: string; destinationAgentName: string }
  | { type: "importCanonicalProfileBundle"; agent: string; destinationAgentName: string; contentBase64: string };

export type AgentStudioInboundDomainMessage =
  | { type: "browse" }
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
  if (value.type === "refreshCanonicalProfile") {
    return exactKeys(value, ["type", "agent"]) && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      ? { type: "refreshCanonicalProfile", agent: value.agent }
      : undefined;
  }
  if (value.type === "exportCanonicalProfileBundle") {
    return exactKeys(value, ["type", "agent", "expectedRevision"]) && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "exportCanonicalProfileBundle", agent: value.agent, expectedRevision: value.expectedRevision } : undefined;
  }
  if (value.type === "cloneCanonicalProfileBundle") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "destinationAgentName"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && typeof value.destinationAgentName === "string" && AGENT_NAME_RE.test(value.destinationAgentName)
      ? { type: "cloneCanonicalProfileBundle", agent: value.agent, expectedRevision: value.expectedRevision, destinationAgentName: value.destinationAgentName } : undefined;
  }
  if (value.type === "importCanonicalProfileBundle") {
    return exactKeys(value, ["type", "agent", "destinationAgentName", "contentBase64"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.destinationAgentName === "string" && AGENT_NAME_RE.test(value.destinationAgentName)
      && typeof value.contentBase64 === "string" && value.contentBase64.length > 0 && value.contentBase64.length <= 350_000 && BASE64_RE.test(value.contentBase64)
      ? { type: "importCanonicalProfileBundle", agent: value.agent, destinationAgentName: value.destinationAgentName, contentBase64: value.contentBase64 } : undefined;
  }
  if (value.type === "setCanonicalProfileEnabled") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "enabled"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      && typeof value.enabled === "boolean"
      ? { type: "setCanonicalProfileEnabled", agent: value.agent, expectedRevision: value.expectedRevision, enabled: value.enabled }
      : undefined;
  }
  if (value.type === "renameCanonicalProfile") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "newName"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.newName === "string" && AGENT_NAME_RE.test(value.newName)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "renameCanonicalProfile", agent: value.agent, expectedRevision: value.expectedRevision, newName: value.newName }
      : undefined;
  }
  if (value.type === "forgetCanonicalProfile") {
    return exactKeys(value, ["type", "agent", "expectedRevision", "confirmation"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.confirmation === "string" && AGENT_NAME_RE.test(value.confirmation)
      && typeof value.expectedRevision === "string" && SHA256_RE.test(value.expectedRevision)
      ? { type: "forgetCanonicalProfile", agent: value.agent, expectedRevision: value.expectedRevision, confirmation: value.confirmation }
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
  if (value.type === "canonicalProfileSnapshot") {
    return exactKeys(value, ["type", "action", "snapshot"])
      && ["refresh", "set-enabled", "rename"].includes(String(value.action))
      && isAgentProfileStudioSnapshotV1(value.snapshot);
  }
  if (value.type === "canonicalProfileBundleExport") return exactKeys(value, ["type", "result"]) && agentProfileStudioBundleExportResultSchemaV1.safeParse(value.result).success;
  if (value.type === "canonicalProfileBundleCreated") return exactKeys(value, ["type", "result"]) && agentProfileStudioBundleCreatedResultSchemaV1.safeParse(value.result).success;
  if (value.type === "canonicalProfileBundleError") {
    return exactKeys(value, ["type", "agent", "code", "message", "conflict"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^agent-profile\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000 && typeof value.conflict === "boolean";
  }
  if (value.type === "canonicalProfileForgotten") {
    return exactKeys(value, ["type", "agent", "agentId"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.agentId === "string" && PROFILE_ID_RE.test(value.agentId);
  }
  if (value.type === "canonicalProfileError") {
    return exactKeys(value, ["type", "agent", "code", "message", "conflict"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^agent-profile\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000
      && typeof value.conflict === "boolean";
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
 *  form needs to render (quick-add chips, flag suggestions, default cwd, verify-gate suggestions). Mirrors
 *  TaskDetailEntity's convention of carrying read-only reference data alongside the editable snapshot. */
export interface AgentStudioEntity {
  /** undefined in "new" mode. */
  name?: string;
  fields: AgentStudioFields;
  storage?: "legacy" | "canonical";
  /** Present only for canonical storage; redacted and never accepted as a save payload. */
  profile?: AgentProfileStudioSnapshotV1;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  verifyCandidates: string[];
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
  runtimeLimitationStopActiveDraftUnverified: string;
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
    runtimeLimitationStopActiveDraftUnverified: t("Stopping an active turn or drafted composer still needs live verification."),
    runtimeLimitationOauthConcurrencySingleLive: t("OAuth admission permits one live Pi agent at a time."),
    enabled: t("Enabled"), disabled: t("Disabled"), closed: t("Closed"), degraded: t("Degraded"), conflict: t("Conflict"),
    enableAgent: t("Enable agent"), disableAgent: t("Disable agent"), refresh: t("Refresh"), retryRefresh: t("Refresh and retry"),
    rename: t("Rename…"), forget: t("Forget…"), export: t("Export"), clone: t("Clone…"), import: t("Import…"),
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
    canonicalTrustHelp: t("Enabling or starting this canonical agent authorizes native folder trust only for the current workspace and effective working directory. General approvals, sandbox policy, and arbitrary hook trust stay unchanged."),
    supported: t("Supported"),
    unsupported: t("Unsupported"),
  };
}

export type AgentEvolutionSummaryMessage = EvolutionStudioSummary;
export type AgentEvolutionCandidateSummaryMessage = EvolutionStudioCandidateSummary;
export type AgentEvolutionCandidateDetailMessage = EvolutionStudioCandidateDetail;

export interface AgentStudioCanonicalContext {
  kind: "canonical";
  expectedRevision?: string;
  displayName: string;
  runtime: AgentProfileStudioSnapshotV1["editable"]["runtime"];
  nativeConfig: NonNullable<AgentProfileStudioSnapshotV1["editable"]["nativeConfig"]>;
  capabilities: NonNullable<AgentProfileStudioSnapshotV1["editable"]["capabilities"]>;
}

export type AgentStudioFields = FormState & { canonical?: AgentStudioCanonicalContext };
export type AgentStudioPatch = FormState | (AgentProfileStudioMutationV1 & Partial<Omit<FormState, "kind">>);

/** A blank agent-kind FormState.
 *  (attention on by default, no harness/worktree). */
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
    verify: "",
    harness: false,
    harnessInherit: "workspace",
    harnessMcp: "",
    harnessRules: "",
    harnessInstructions: "",
    harnessSkills: "",
    harnessHooks: "",
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
  fields.selfEvolution = snapshot?.bindings.prompt.evolution ?? false;
  fields.cwd = snapshot?.editable.cwd ?? "";
  fields.autostart = snapshot?.editable.lifecycle.autostart ?? false;
  fields.restartOnCrash = snapshot?.editable.lifecycle.restart === "on-crash";
  fields.attention = snapshot?.editable.lifecycle.attention ?? true;
  fields.watch = snapshot?.editable.lifecycle.watch.join("\n") ?? "";
  fields.worktree = snapshot?.editable.worktree.enabled ?? false;
  fields.branch = snapshot?.editable.worktree.branch ?? "";
  fields.isolate = snapshot?.editable.isolation === "transcript";
  fields.canonical = {
    kind: "canonical",
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

export function codexNativeConfigChoice(
  fields: AgentStudioFields,
  family: CodexScalarNativeConfigFamily,
): CodexScalarNativeConfigChoice {
  const source = fields.canonical?.nativeConfig[family]?.source;
  return source === "global" || source === "workspace" ? source : "exclude";
}

export function setCodexNativeConfigChoice(
  fields: AgentStudioFields,
  family: CodexScalarNativeConfigFamily,
  choice: CodexScalarNativeConfigChoice,
): AgentStudioFields {
  if (!fields.canonical) return fields;
  const nativeConfig = structuredClone(fields.canonical.nativeConfig);
  if (choice === "exclude") delete nativeConfig[family];
  else nativeConfig[family] = codexScalarNativeConfigPolicy(choice);
  return {
    ...fields,
    canonical: {
      ...fields.canonical,
      nativeConfig,
    },
  };
}

export function computeAgentDirty(entity: AgentStudioEntity | undefined, fields: AgentStudioFields): boolean {
  const base = entity?.fields ?? blankAgentFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeAgentPatch(fields: AgentStudioFields, dirty: boolean): AgentStudioPatch | undefined {
  if (!dirty) return undefined;
  if (!fields.canonical) return fields;
  const executable = fields.cmd.trim();
  const adapter = fields.canonical.expectedRevision
    ? fields.canonical.runtime.adapter
    : executable.split(/[\\/]/).pop() ?? executable;
  // Keep unmeasured Quick Add runtimes on the legacy writer instead of minting partial authority.
  // usable through Agent Studio's existing legacy writer instead of minting an authority the resolver
  // cannot attest.
  if (!fields.canonical.expectedRevision && !["codex", "pi", "claude", "grok"].includes(adapter)) {
    const { canonical: _canonical, ...legacy } = fields;
    return legacy;
  }
  return {
    schemaVersion: 1,
    kind: "canonical",
    agentName: fields.name,
    ...(fields.canonical.expectedRevision ? { expectedRevision: fields.canonical.expectedRevision } : {}),
    editable: {
      displayName: fields.canonical.displayName,
      runtime: { ...fields.canonical.runtime, adapter, executable },
      role: fields.role as AgentProfileStudioMutationV1["editable"]["role"],
      cwd: fields.cwd.trim(),
      lifecycle: {
        autostart: fields.autostart,
        restart: fields.restartOnCrash ? "on-crash" : "never",
        attention: fields.attention,
        watch: fields.watch.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      },
      worktree: {
        enabled: fields.worktree,
        branch: fields.branch.trim(),
      },
      isolation: fields.isolate ? "transcript" : "",
      nativeConfig: adapter === "codex" ? structuredClone(fields.canonical.nativeConfig) : {},
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
