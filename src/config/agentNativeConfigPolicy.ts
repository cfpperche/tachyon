import {
  AGENT_NATIVE_CONFIG_FAMILIES,
  type AgentNativeConfigPolicyV1,
} from "./agentNativeConfigSchema.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

export type AgentNativeConfigFamily = (typeof AGENT_NATIVE_CONFIG_FAMILIES)[number];

export interface AgentNativeConfigPolicyPreview {
  family: AgentNativeConfigFamily;
  policy: AgentNativeConfigPolicyV1;
  support: "unsupported";
  reason: string;
}

/**
 * The foundation intentionally declares no adapter combinations. Each adapter
 * slice must add measured support instead of inheriting a permissive default.
 */
export function previewAgentNativeConfigPolicy(
  adapter: string,
  nativeConfig: AgentProfileV1["nativeConfig"],
): AgentNativeConfigPolicyPreview[] {
  return AGENT_NATIVE_CONFIG_FAMILIES.flatMap((family) => {
    const policy = nativeConfig?.[family];
    return policy ? [{
      family,
      policy: structuredClone(policy),
      support: "unsupported" as const,
      reason: `runtime adapter '${adapter}' has not declared native configuration support for '${family}'`,
    }] : [];
  });
}

export function validateAgentNativeConfigPolicy(
  adapter: string,
  nativeConfig: AgentProfileV1["nativeConfig"],
): string[] {
  return previewAgentNativeConfigPolicy(adapter, nativeConfig)
    .map((entry) => `profile/native-config-unsupported: ${entry.reason}`);
}
