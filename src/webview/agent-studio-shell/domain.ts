import type { FormState, QuickAddChip } from "../formLogic.js";

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
  "openSoul",
  "refreshSoul",
  "previewSoul",
  "adoptSoulProfile",
  "enableSoul",
  "disableSoul",
  "deleteSoulProfile",
] as const;

export const AGENT_STUDIO_HOST_MESSAGE_NAMES = [
  "cwd",
  "soulProfileStatus",
  "soulProfileError",
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
  | { type: "adoptSoulProfile"; agent: string; expectedDigest: string };

export type AgentStudioInboundDomainMessage = { type: "browse" } | AgentStudioSoulActionMessage;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).filter((key) => key !== "studioProtocolVersion").sort();
  return keys.join("\0") === [...expected].sort().join("\0");
}

/** Runtime validation after the shared envelope/name decoder, before any host filesystem action. */
export function validateAgentStudioInboundMessage(raw: unknown): AgentStudioInboundDomainMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === "browse") return exactKeys(value, ["type"]) ? { type: "browse" } : undefined;
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
  if (!exactKeys(value, ["type", "agent"])) return undefined;
  return { type: value.type as Exclude<AgentStudioSoulActionMessage["type"], "adoptSoulProfile" | "importSoul">, agent: value.agent };
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
  action?: "create" | "import" | "open" | "refresh" | "preview" | "adopt" | "enable" | "disable" | "delete";
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
  if (value.action !== undefined && !["create", "import", "open", "refresh", "preview", "adopt", "enable", "disable", "delete"].includes(value.action)) return false;
  return value.selfSelected === undefined || typeof value.selfSelected === "boolean";
}

/** Runtime validation for the three host-only domain responses consumed by the browser shell. */
export function validateAgentStudioHostDomainMessage(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Record<string, unknown>;
  if (value.type === "cwd") return exactKeys(value, ["type", "value"]) && typeof value.value === "string";
  if (value.type === "soulProfileStatus") return exactKeys(value, ["type", "status"]) && isSoulProfileStatusMessage(value.status);
  if (value.type === "soulProfileError") {
    return exactKeys(value, ["type", "agent", "code", "message"])
      && typeof value.agent === "string" && AGENT_NAME_RE.test(value.agent)
      && typeof value.code === "string" && /^soul\/[a-z0-9-]+$/.test(value.code)
      && typeof value.message === "string" && value.message.length <= 2_000;
  }
  return false;
}

/** The load-time snapshot: the agent's current FormState (kind fixed "agent") plus the reference data the
 *  form needs to render (quick-add chips, flag suggestions, default cwd, verify-gate suggestions). Mirrors
 *  TaskDetailEntity's convention of carrying read-only reference data alongside the editable snapshot. */
export interface AgentStudioEntity {
  /** undefined in "new" mode. */
  name?: string;
  fields: FormState;
  chips: QuickAddChip[];
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  verifyCandidates: string[];
}

export type AgentStudioFields = FormState;
export type AgentStudioPatch = FormState;

/** A blank agent-kind FormState.
 *  (attention on by default, no harness/worktree). */
export function blankAgentFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "agent",
    instructions: "",
    soul: false,
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

export function computeAgentDirty(entity: AgentStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankAgentFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeAgentPatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardAgentFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankAgentFields());
}

export function agentStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: AgentStudioEntity | undefined): string {
  if (mode === "new") return "New Agent";
  return `Agent Studio — ${entity?.name ?? entityId ?? ""}`;
}
