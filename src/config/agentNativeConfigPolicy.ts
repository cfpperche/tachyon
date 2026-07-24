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

export interface ResolvedAgentNativeConfigProjection {
  adapter: "codex";
  /** Source ownership is retained so lifecycle freshness can identify affected agents. */
  sources?: Partial<Record<AgentNativeConfigFamily, "global" | "workspace" | "agent">>;
  selectors: {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
  permissions?: {
    approvalPolicy?: string;
    sandboxMode?: string;
  };
  interface?: {
    personality?: string;
    statusLine?: string[];
    statusLineUseColors?: boolean;
  };
  featureFlags?: {
    terminalResizeReflow?: boolean;
  };
}

export function projectAgentNativeConfig(
  profile: Pick<AgentProfileV1, "runtime" | "nativeConfig">,
): ResolvedAgentNativeConfigProjection | undefined {
  if (!profile.nativeConfig?.selectors || profile.runtime.adapter !== "codex") return undefined;
  const sources = Object.fromEntries(
      Object.entries(profile.nativeConfig ?? {})
        .filter((entry): entry is [AgentNativeConfigFamily, AgentNativeConfigPolicyV1] => Boolean(entry[1]))
        .map(([family, policy]) => [family, policy.source]),
    ) as Partial<Record<AgentNativeConfigFamily, "global" | "workspace" | "agent">>;
  const projection: ResolvedAgentNativeConfigProjection = {
    adapter: "codex",
    selectors: {
      ...(profile.runtime.model ? { model: profile.runtime.model } : {}),
      ...(profile.runtime.provider ? { provider: profile.runtime.provider } : {}),
      ...(profile.runtime.reasoningEffort ? { reasoningEffort: profile.runtime.reasoningEffort } : {}),
      ...(profile.runtime.serviceTier ? { serviceTier: profile.runtime.serviceTier } : {}),
    },
  };
  // Internal lifecycle metadata must not alter the established serialized projection contract.
  Object.defineProperty(projection, "sources", { value: sources, enumerable: false, configurable: false });
  return projection;
}

const CODEX_AGENT_SELECTOR_LIFECYCLE = new Set(["fresh", "restart", "resume"]);

function hasExactLifecycle(actual: AgentNativeConfigPolicyV1["lifecycle"], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && actual.every((phase) => expected.has(phase));
}

export const resolveAgentNativeConfigSupport: AgentNativeConfigSupportResolver = (
  adapter,
  family,
  policy,
) => {
  if (
    adapter === "codex"
    && family === "selectors"
    && policy.source === "agent"
    && policy.treatment === "overlay"
    && policy.refresh === "every-launch"
    && hasExactLifecycle(policy.lifecycle, CODEX_AGENT_SELECTOR_LIFECYCLE)
  ) {
    return {
      support: "supported",
      reason: "Codex declares typed agent selectors for fresh, restart and resume",
    };
  }
  if (
    adapter === "codex"
    && (family === "permissions" || family === "interface" || family === "featureFlags")
    && (policy.source === "global" || policy.source === "workspace")
    && policy.treatment === "overlay"
    && policy.refresh === "every-launch"
    && hasExactLifecycle(policy.lifecycle, CODEX_AGENT_SELECTOR_LIFECYCLE)
  ) {
    return {
      support: "supported",
      reason: `Codex declares filtered ${policy.source} ${family} projection for fresh, restart and resume`,
    };
  }
  return {
    support: "unsupported",
    reason: `runtime adapter '${adapter}' has not declared native configuration support for '${family}'`,
  };
};

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
