import { parse } from "@iarna/toml";
import type { ResolvedAgentNativeConfigProjection } from "./agentNativeConfigPolicy.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

type ScalarFamily = "permissions" | "interface" | "featureFlags";
type SourceName = "global" | "workspace";

export interface CodexNativeConfigSourceTexts {
  global?: string;
  workspace?: string;
}

export interface CodexNativeConfigProjectionResult {
  projection: ResolvedAgentNativeConfigProjection;
  errors: string[];
}

const FAMILY_KEYS: Record<ScalarFamily, readonly string[]> = {
  permissions: ["approval_policy", "sandbox_mode"],
  interface: ["personality", "tui.status_line", "tui.status_line_use_colors"],
  featureFlags: ["features.terminal_resize_reflow"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    return isRecord(child) ? leafPaths(child, field) : [field];
  });
}

function valueAt(source: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, source);
}

function parseSource(family: ScalarFamily, source: SourceName, text: string | undefined): Record<string, unknown> | string {
  if (!text?.trim()) return {};
  try {
    const parsed = parse(text);
    return isRecord(parsed)
      ? parsed
      : `profile/native-config-source: family '${family}' source '${source}' must be a TOML table`;
  } catch (error) {
    return `profile/native-config-source: family '${family}' source '${source}' is invalid TOML: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function typedValue<T extends "string" | "boolean" | "string[]">(
  family: ScalarFamily,
  source: SourceName,
  parsed: Record<string, unknown>,
  field: string,
  expected: T,
  errors: string[],
): string | boolean | string[] | undefined {
  const value = valueAt(parsed, field);
  if (value === undefined) return undefined;
  const valid = expected === "string"
    ? typeof value === "string"
    : expected === "boolean"
      ? typeof value === "boolean"
      : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!valid) {
    errors.push(`profile/native-config-key: family '${family}' source '${source}' key '${field}' must be ${expected}`);
    return undefined;
  }
  return value as string | boolean | string[];
}

export function projectCodexScalarNativeConfig(
  profile: Pick<AgentProfileV1, "nativeConfig">,
  texts: CodexNativeConfigSourceTexts,
  base: ResolvedAgentNativeConfigProjection,
): CodexNativeConfigProjectionResult {
  const projection = structuredClone(base);
  const errors: string[] = [];
  const parsedBySource = new Map<SourceName, Record<string, unknown> | string>();
  const selectedWorkspaceKeys = new Set<string>();

  for (const family of ["permissions", "interface", "featureFlags"] as const) {
    const policy = profile.nativeConfig?.[family];
    if (!policy || (policy.source !== "global" && policy.source !== "workspace")) continue;
    if (policy.source === "workspace") for (const key of FAMILY_KEYS[family]) selectedWorkspaceKeys.add(key);
    let parsed = parsedBySource.get(policy.source);
    if (!parsed) {
      parsed = parseSource(family, policy.source, texts[policy.source]);
      parsedBySource.set(policy.source, parsed);
    }
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    if (family === "permissions") {
      const approvalPolicy = typedValue(family, policy.source, parsed, "approval_policy", "string", errors);
      const sandboxMode = typedValue(family, policy.source, parsed, "sandbox_mode", "string", errors);
      projection.permissions = {
        ...(approvalPolicy !== undefined ? { approvalPolicy: approvalPolicy as string } : {}),
        ...(sandboxMode !== undefined ? { sandboxMode: sandboxMode as string } : {}),
      };
    } else if (family === "interface") {
      const personality = typedValue(family, policy.source, parsed, "personality", "string", errors);
      const statusLine = typedValue(family, policy.source, parsed, "tui.status_line", "string[]", errors);
      const statusLineUseColors = typedValue(family, policy.source, parsed, "tui.status_line_use_colors", "boolean", errors);
      projection.interface = {
        ...(personality !== undefined ? { personality: personality as string } : {}),
        ...(statusLine !== undefined ? { statusLine: statusLine as string[] } : {}),
        ...(statusLineUseColors !== undefined ? { statusLineUseColors: statusLineUseColors as boolean } : {}),
      };
    } else {
      const terminalResizeReflow = typedValue(family, policy.source, parsed, "features.terminal_resize_reflow", "boolean", errors);
      projection.featureFlags = {
        ...(terminalResizeReflow !== undefined ? { terminalResizeReflow: terminalResizeReflow as boolean } : {}),
      };
    }
  }

  const workspace = parsedBySource.get("workspace");
  if (workspace && typeof workspace !== "string") {
    for (const key of leafPaths(workspace)) {
      if (!selectedWorkspaceKeys.has(key)) {
        errors.push(`profile/native-config-key: source 'workspace' key '${key}' is outside the selected family allowlist`);
      }
    }
  }
  return { projection, errors };
}
