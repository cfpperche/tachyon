import {
  AGENT_NATIVE_CONFIG_FAMILIES,
  type AgentNativeConfigPolicyV1,
} from "./agentNativeConfigSchema.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

export type AgentNativeConfigFamily = (typeof AGENT_NATIVE_CONFIG_FAMILIES)[number];
export const CODEX_SCALAR_NATIVE_CONFIG_FAMILIES = [
  "permissions",
  "interface",
  "featureFlags",
] as const;
export type CodexScalarNativeConfigFamily = (typeof CODEX_SCALAR_NATIVE_CONFIG_FAMILIES)[number];
export type CodexScalarNativeConfigSource = "global" | "workspace";
export type CodexScalarNativeConfigChoice = CodexScalarNativeConfigSource | "exclude";
export type ClaudeScalarNativeConfigSource = "global" | "workspace";
export type ClaudeScalarNativeConfigChoice = ClaudeScalarNativeConfigSource | "exclude";

/**
 * SDD 471 — the only dangerous Claude value a profile may authorize today. `bypassPermissions`
 * disables Claude's permission prompts, so it stays refused unless THIS agent's profile names it.
 */
export const CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION = "bypassPermissions";
const CLAUDE_PERMISSION_AUTHORIZATIONS = new Set<string>([CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION]);

/** Authorizations a profile declared for one family — empty unless deliberately authored. */
export function nativeConfigAuthorizations(
  nativeConfig: AgentProfileV1["nativeConfig"],
  family: AgentNativeConfigFamily,
): ReadonlySet<string> {
  return new Set(nativeConfig?.[family]?.authorize ?? []);
}

const CODEX_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume"] as const;
const CLAUDE_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume", "fork"] as const;
export const CLAUDE_SCALAR_NATIVE_CONFIG_FAMILIES = [
  "permissions",
  "interface",
  "featureFlags",
] as const;

export function codexScalarNativeConfigPolicy(
  source: CodexScalarNativeConfigSource,
): AgentNativeConfigPolicyV1 {
  return {
    source,
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...CODEX_NATIVE_CONFIG_LIFECYCLE],
  };
}

export function defaultCodexScalarNativeConfigPolicy(): NonNullable<AgentProfileV1["nativeConfig"]> {
  return Object.fromEntries(
    CODEX_SCALAR_NATIVE_CONFIG_FAMILIES.map((family) => [
      family,
      codexScalarNativeConfigPolicy("global"),
    ]),
  );
}

export function claudeScalarNativeConfigPolicy(
  source: ClaudeScalarNativeConfigSource,
  authorize: readonly string[] = [],
): AgentNativeConfigPolicyV1 {
  return {
    source,
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...CLAUDE_NATIVE_CONFIG_LIFECYCLE],
    // Agent Studio rebuilds this policy on every save, so an authored authorization has to be
    // carried through explicitly or it would silently reset (SDD 471).
    ...(authorize.length > 0 ? { authorize: [...authorize] } : {}),
  };
}

export function claudeSelectorNativeConfigPolicy(): AgentNativeConfigPolicyV1 {
  return {
    source: "agent",
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...CLAUDE_NATIVE_CONFIG_LIFECYCLE],
  };
}

export function defaultClaudeScalarNativeConfigPolicy(): NonNullable<AgentProfileV1["nativeConfig"]> {
  return Object.fromEntries(
    CLAUDE_SCALAR_NATIVE_CONFIG_FAMILIES.map((family) => [
      family,
      claudeScalarNativeConfigPolicy("global"),
    ]),
  );
}

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
  adapter: "codex" | "claude";
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
  /** Closed Claude settings selected by family; never a raw settings file. */
  settings?: Record<string, unknown>;
}

/**
 * Re-attach the non-enumerable ownership metadata onto a copy of a projection.
 *
 * `sources` is deliberately non-enumerable so it never widens the serialized projection contract,
 * but that also means a spread or a `structuredClone` silently drops it — and it was being dropped
 * exactly when a family IS selected, i.e. whenever it actually matters (t-59a11b). Every site that
 * copies a projection must carry it across with this helper.
 */
export function carryNativeConfigSources<T extends object>(
  target: T,
  source: Pick<ResolvedAgentNativeConfigProjection, "sources">,
): T {
  const sources = source.sources;
  if (!sources || Object.prototype.hasOwnProperty.call(target, "sources")) return target;
  Object.defineProperty(target, "sources", { value: sources, enumerable: false, configurable: false });
  return target;
}

export function projectAgentNativeConfig(
  profile: Pick<AgentProfileV1, "runtime" | "nativeConfig">,
): ResolvedAgentNativeConfigProjection | undefined {
  if (!profile.nativeConfig || !["codex", "claude"].includes(profile.runtime.adapter)) return undefined;
  if (profile.runtime.adapter === "codex" && !profile.nativeConfig.selectors) return undefined;
  const sources = Object.fromEntries(
      Object.entries(profile.nativeConfig ?? {})
        .filter((entry): entry is [AgentNativeConfigFamily, AgentNativeConfigPolicyV1] => Boolean(entry[1]))
        .map(([family, policy]) => [family, policy.source]),
    ) as Partial<Record<AgentNativeConfigFamily, "global" | "workspace" | "agent">>;
  const projection: ResolvedAgentNativeConfigProjection = {
    adapter: profile.runtime.adapter as "codex" | "claude",
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

const CODEX_AGENT_SELECTOR_LIFECYCLE = new Set(CODEX_NATIVE_CONFIG_LIFECYCLE);
const CLAUDE_ALL_LIFECYCLE = new Set(CLAUDE_NATIVE_CONFIG_LIFECYCLE);

function hasExactLifecycle(actual: AgentNativeConfigPolicyV1["lifecycle"], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && actual.every((phase) => expected.has(phase));
}

export const resolveAgentNativeConfigSupport: AgentNativeConfigSupportResolver = (
  adapter,
  family,
  policy,
) => {
  // SDD 471 — an authorization is a Claude permissions concept. Refusing it anywhere else keeps a
  // Codex (or any future runtime's) profile from quietly carrying one that nothing would enforce.
  if (policy.authorize) {
    if (adapter !== "claude" || family !== "permissions") {
      return {
        support: "unsupported",
        reason: `'authorize' is only supported on the Claude permissions family, not '${adapter}' family '${family}'`,
      };
    }
    const unknown = policy.authorize.filter((entry) => !CLAUDE_PERMISSION_AUTHORIZATIONS.has(entry));
    if (unknown.length > 0) {
      return {
        support: "unsupported",
        reason: `Claude permissions authorization ${unknown.map((entry) => `'${entry}'`).join(", ")}`
          + ` is not a recognized authorization (supported: ${[...CLAUDE_PERMISSION_AUTHORIZATIONS].join(", ")})`,
      };
    }
  }
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
    adapter === "claude"
    && family === "selectors"
    && policy.source === "agent"
    && policy.treatment === "overlay"
    && policy.refresh === "every-launch"
    && hasExactLifecycle(policy.lifecycle, CLAUDE_ALL_LIFECYCLE)
  ) {
    return {
      support: "supported",
      reason: "Claude declares typed agent selectors for fresh, restart, resume and fork",
    };
  }
  if (
    adapter === "claude"
    && (family === "permissions" || family === "interface" || family === "featureFlags")
    && (policy.source === "global" || policy.source === "workspace")
    && policy.treatment === "overlay"
    && policy.refresh === "every-launch"
    && hasExactLifecycle(policy.lifecycle, CLAUDE_ALL_LIFECYCLE)
  ) {
    return {
      support: "supported",
      reason: `Claude declares filtered ${policy.source} ${family} projection for fresh, restart, resume and fork`,
    };
  }
  if (
    adapter === "claude"
    && (
      (family === "tooling" && policy.source === "workspace" && policy.treatment === "exclude" && policy.refresh === "every-launch")
      || (family === "authentication" && policy.source === "global" && policy.treatment === "external" && policy.refresh === "runtime-owned")
      || (family === "memory" && policy.source === "agent" && policy.treatment === "exclude" && policy.refresh === "every-launch")
    )
    && hasExactLifecycle(policy.lifecycle, CLAUDE_ALL_LIFECYCLE)
  ) {
    return {
      support: "supported",
      reason: `Claude explicitly keeps ${family} outside authored native configuration for fresh, restart, resume and fork`,
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
