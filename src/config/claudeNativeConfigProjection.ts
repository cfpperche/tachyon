import type { ResolvedAgentNativeConfigProjection } from "./agentNativeConfigPolicy.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validatePermissions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(["allow", "ask", "deny", "defaultMode", "additionalDirectories"]);
  return Object.entries(value).every(([key, entry]) => {
    if (!allowed.has(key)) return false;
    if (key === "defaultMode") return typeof entry === "string" && CLAUDE_PERMISSION_MODES.has(entry);
    return validStringList(entry);
  });
}

function validValue(key: string, value: unknown): boolean {
  if (key === "permissions") return validatePermissions(value);
  if (key === "theme") return typeof value === "string";
  return typeof value === "boolean";
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
      if (!validValue(key, value)) {
        errors.push(`profile/native-config-value: Claude ${source} key '${key}' has an unsupported value`);
        continue;
      }
      settings[key] = structuredClone(value);
    }
  }
  return {
    projection: Object.keys(settings).length > 0 ? { ...base, settings } : base,
    errors,
  };
}
