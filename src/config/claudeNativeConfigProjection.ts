import type { ResolvedAgentNativeConfigProjection } from "./agentNativeConfigPolicy.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

type ClaudeScalarFamily = "permissions" | "interface" | "featureFlags";

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
    if (key === "defaultMode") return typeof entry === "string";
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
  profile: Pick<AgentProfileV1, "nativeConfig">,
  sourceText: string | undefined,
  base: ResolvedAgentNativeConfigProjection,
): ClaudeNativeConfigProjectionResult {
  const selected = (Object.keys(FAMILY_KEYS) as ClaudeScalarFamily[])
    .filter((family) => profile.nativeConfig?.[family]?.source === "workspace");
  if (selected.length === 0) return { projection: base, errors: [] };

  let parsed: unknown = {};
  try {
    parsed = sourceText?.trim() ? JSON.parse(sourceText) : {};
  } catch (error) {
    return {
      projection: base,
      errors: [`profile/native-config-source: Claude workspace settings are invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(parsed)) {
    return { projection: base, errors: ["profile/native-config-source: Claude workspace settings must be a JSON object"] };
  }

  const selectedKeys = new Set(selected.flatMap((family) => FAMILY_KEYS[family]));
  const errors: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!selectedKeys.has(key)) {
      errors.push(`profile/native-config-key: Claude workspace key '${key}' is outside the selected family allowlist`);
    }
  }
  const settings: Record<string, unknown> = {};
  for (const key of selectedKeys) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (!validValue(key, value)) {
      errors.push(`profile/native-config-value: Claude workspace key '${key}' has an unsupported value`);
      continue;
    }
    settings[key] = structuredClone(value);
  }
  return {
    projection: { ...base, settings },
    errors,
  };
}
