import {
  AGENT_NATIVE_CONFIG_FAMILIES,
  type AgentNativeConfigPolicyV1,
} from "./agentNativeConfigSchema.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

export type AgentNativeConfigFamily = (typeof AGENT_NATIVE_CONFIG_FAMILIES)[number];

export interface AgentNativeConfigSupportDecision {
  support: "supported" | "unsupported";
  reason: string;
}

export type AgentNativeConfigSupportResolver = (
  adapter: string,
  family: AgentNativeConfigFamily,
  policy: AgentNativeConfigPolicyV1,
) => AgentNativeConfigSupportDecision;

export interface AgentNativeConfigPolicyPreview {
  family: AgentNativeConfigFamily;
  policy: AgentNativeConfigPolicyV1;
  support: AgentNativeConfigSupportDecision["support"];
  reason: string;
}

/**
 * The foundation intentionally declares no adapter combinations. Each adapter
 * slice extends this decision with measured exact tuples instead of changing
 * validation or inheriting a permissive default.
 */
export const resolveAgentNativeConfigSupport: AgentNativeConfigSupportResolver = (
  adapter,
  family,
) => ({
  support: "unsupported",
  reason: `runtime adapter '${adapter}' has not declared native configuration support for '${family}'`,
});

export function previewAgentNativeConfigPolicy(
  adapter: string,
  nativeConfig: AgentProfileV1["nativeConfig"],
  resolveSupport: AgentNativeConfigSupportResolver = resolveAgentNativeConfigSupport,
): AgentNativeConfigPolicyPreview[] {
  return AGENT_NATIVE_CONFIG_FAMILIES.flatMap((family) => {
    const policy = nativeConfig?.[family];
    if (!policy) return [];
    const decision = resolveSupport(adapter, family, policy);
    return [{
      family,
      policy: structuredClone(policy),
      support: decision.support,
      reason: decision.reason,
    }];
  });
}

export function validateAgentNativeConfigPolicy(
  adapter: string,
  nativeConfig: AgentProfileV1["nativeConfig"],
  resolveSupport: AgentNativeConfigSupportResolver = resolveAgentNativeConfigSupport,
): string[] {
  return previewAgentNativeConfigPolicy(adapter, nativeConfig, resolveSupport)
    .filter((entry) => entry.support === "unsupported")
    .map((entry) => `profile/native-config-unsupported: ${entry.reason}`);
}
