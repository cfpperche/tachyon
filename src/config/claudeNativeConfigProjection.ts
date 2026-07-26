import {
  carryNativeConfigSources,
  nativeConfigAuthorizations,
  CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION,
  type ResolvedAgentNativeConfigProjection,
} from "./agentNativeConfigPolicy.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

type ClaudeScalarFamily = "permissions" | "interface" | "featureFlags";
type ClaudeScalarSource = "global" | "workspace";

const CLAUDE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "manual",
  "dontAsk",
  "plan",
]);

const FAMILY_KEYS: Record<ClaudeScalarFamily, readonly string[]> = {
  permissions: ["permissions"],
  interface: [
    "theme",
    "prefersReducedMotion",
    "spinnerTipsEnabled",
    "showTurnDuration",
    "terminalProgressBarEnabled",
  ],
  featureFlags: ["alwaysThinkingEnabled"],
};

/** Agent Studio's own family labels, so a refusal names the control the person has to change. */
const FAMILY_LABELS: Record<ClaudeScalarFamily, string> = {
  permissions: "Permissions",
  interface: "Interface",
  featureFlags: "Feature flags",
};

function familyOf(key: string): ClaudeScalarFamily {
  for (const family of Object.keys(FAMILY_KEYS) as ClaudeScalarFamily[]) {
    if (FAMILY_KEYS[family].includes(key)) return family;
  }
  return "interface";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function describe(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  if (isRecord(value)) return "an object";
  return String(value);
}

const PERMISSION_FIELDS = ["allow", "ask", "deny", "defaultMode", "additionalDirectories"] as const;

/** Modes a profile is allowed to lift by authorizing them — everything else stays refused. */
const CLAUDE_AUTHORIZABLE_MODES = new Set<string>([CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION]);

/** The precise setting path that was refused, plus why — never a bare "unsupported value". */
interface ValueRejection {
  path: string;
  reason: string;
}

/**
 * Locate the exact offending subkey inside a permissions block. A bare "unsupported value" leaves
 * the person with no way to tell which of five subkeys is at fault (t-111190).
 */
function permissionsRejection(value: unknown, authorized: ReadonlySet<string>): ValueRejection | undefined {
  if (!isRecord(value)) return { path: "permissions", reason: `must be an object, got ${describe(value)}` };
  for (const [key, entry] of Object.entries(value)) {
    if (!(PERMISSION_FIELDS as readonly string[]).includes(key)) {
      return {
        path: `permissions.${key}`,
        reason: `is not a projectable permission field (supported: ${PERMISSION_FIELDS.join(", ")})`,
      };
    }
    if (key === "defaultMode") {
      // SDD 471 — a mode the profile explicitly authorized for THIS agent is projectable even
      // though it is refused by default. Reading the authorization (never the source file) is what
      // keeps a global value from being inherited by an agent that never consented to it.
      if (typeof entry === "string" && authorized.has(entry)) continue;
      if (typeof entry !== "string" || !CLAUDE_PERMISSION_MODES.has(entry)) {
        return {
          path: "permissions.defaultMode",
          reason: `value ${describe(entry)} is not projectable`
            + ` (supported: ${[...CLAUDE_PERMISSION_MODES].join(", ")})`,
        };
      }
      continue;
    }
    if (!validStringList(entry)) {
      return { path: `permissions.${key}`, reason: `must be a list of strings, got ${describe(entry)}` };
    }
  }
  return undefined;
}

/** Why `key` cannot be projected, or undefined when it can. */
function valueRejection(key: string, value: unknown, authorized: ReadonlySet<string>): ValueRejection | undefined {
  if (key === "permissions") return permissionsRejection(value, authorized);
  if (key === "theme") {
    return typeof value === "string" ? undefined : { path: key, reason: `must be a string, got ${describe(value)}` };
  }
  return typeof value === "boolean" ? undefined : { path: key, reason: `must be a boolean, got ${describe(value)}` };
}

export interface ClaudeNativeConfigProjectionResult {
  projection: ResolvedAgentNativeConfigProjection;
  errors: string[];
}

/** Project only the small Claude settings subset measured by the canonical adapter. */
export function projectClaudeNativeConfig(
  profile: Pick<AgentProfileV1, "runtime" | "nativeConfig">,
  sourceTexts: Partial<Record<ClaudeScalarSource, string>>,
  base: ResolvedAgentNativeConfigProjection,
): ClaudeNativeConfigProjectionResult {
  const errors: string[] = [];
  // Read from the PROFILE, never from the source file: the global config supplies a value, only
  // this agent's own authorization makes it projectable (SDD 471).
  const authorizedPermissions = nativeConfigAuthorizations(profile.nativeConfig, "permissions");
  const selectorsSelected = profile.nativeConfig?.selectors?.source === "agent";
  if (selectorsSelected) {
    if (profile.runtime.provider) {
      errors.push("profile/native-config-selector: Claude provider has no measured canonical materialization");
    }
    if (profile.runtime.serviceTier) {
      errors.push("profile/native-config-selector: Claude serviceTier has no measured canonical materialization");
    }
    if (profile.runtime.model !== undefined && profile.runtime.model.trim().length === 0) {
      errors.push("profile/native-config-selector: Claude model must be non-empty");
    }
    if (
      profile.runtime.reasoningEffort !== undefined
      && !CLAUDE_REASONING_EFFORTS.has(profile.runtime.reasoningEffort)
    ) {
      errors.push(
        `profile/native-config-selector: Claude reasoningEffort '${profile.runtime.reasoningEffort}' is unsupported; expected low, medium, high, xhigh or max`,
      );
    }
  }

  const settings: Record<string, unknown> = {};
  for (const source of ["global", "workspace"] as const) {
    const selected = (Object.keys(FAMILY_KEYS) as ClaudeScalarFamily[])
      .filter((family) => profile.nativeConfig?.[family]?.source === source);
    if (selected.length === 0) continue;
    let parsed: unknown = {};
    const sourceText = sourceTexts[source];
    try {
      parsed = sourceText?.trim() ? JSON.parse(sourceText) : {};
    } catch (error) {
      errors.push(
        `profile/native-config-source: Claude ${source} settings are invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!isRecord(parsed)) {
      errors.push(`profile/native-config-source: Claude ${source} settings must be a JSON object`);
      continue;
    }
    const selectedKeys = new Set(selected.flatMap((family) => FAMILY_KEYS[family]));
    // Workspace settings are project-owned, so an unselected key there is ambient tooling the
    // profile must refuse rather than silently drop. The global file is the person's own Claude
    // config and legitimately carries unrelated keys ($schema, statusLine, tui, ...); those stay
    // opaque and unauthored instead of blocking activation. Mirrors the Codex projector, which
    // enforces this allowlist for 'workspace' only.
    if (source === "workspace") {
      for (const key of Object.keys(parsed)) {
        if (!selectedKeys.has(key)) {
          errors.push(`profile/native-config-key: Claude ${source} key '${key}' is outside the selected family allowlist`);
        }
      }
    }
    for (const key of selectedKeys) {
      const value = parsed[key];
      if (value === undefined) continue;
      const rejection = valueRejection(key, value, authorizedPermissions);
      if (rejection) {
        // Name the offending subkey/value and the way out: the refusal is intentional
        // fail-closed, so the person needs to know which family to exclude (t-111190). For a
        // refusal an explicit authorization could lift, name that route too (SDD 471).
        const remedy = rejection.path === "permissions.defaultMode"
          && typeof (value as Record<string, unknown>).defaultMode === "string"
          && CLAUDE_AUTHORIZABLE_MODES.has((value as Record<string, unknown>).defaultMode as string)
          ? `; authorize it explicitly for this agent, set the ${FAMILY_LABELS[familyOf(key)]} family`
            + ` to Exclude, or change the ${source} value`
          : `; set the ${FAMILY_LABELS[familyOf(key)]} family to Exclude or change the ${source} value`;
        errors.push(
          `profile/native-config-value: Claude ${source} key '${rejection.path}' ${rejection.reason}${remedy}`,
        );
        continue;
      }
      settings[key] = structuredClone(value);
    }
  }
  return {
    // The spread drops the non-enumerable ownership metadata, so carry it across (t-59a11b).
    projection: Object.keys(settings).length > 0
      ? carryNativeConfigSources({ ...base, settings }, base)
      : base,
    errors,
  };
}
