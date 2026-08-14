import {
  AGENT_NATIVE_CONFIG_FAMILIES,
  type AgentNativeConfigPolicyV1,
} from "@tachyon/shared/config/agentNativeConfigSchema.js";
import type { AgentProfileV1 } from "./agentProfile.js";

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
 * t-26f508 — Grok has ONE projectable source. Measured on 0.2.112 with `grok inspect --json`: a
 * project `.grok/config.toml` loads as a `project` layer that contributes only `[mcp_servers]`,
 * `[plugins]` and `[permission]`, and its `[permission]` block did not even register in the
 * effective rule set; every family this projector owns is read from `~/.grok/config.toml` alone.
 * Offering `workspace` here would author a policy the runtime does not honor.
 */
export type GrokScalarNativeConfigSource = "global";
export type GrokScalarNativeConfigChoice = GrokScalarNativeConfigSource | "exclude";

/**
 * SDD 471 — the only dangerous Claude value a profile may authorize today. `bypassPermissions`
 * disables Claude's permission prompts, so it stays refused unless THIS agent's profile names it.
 */
export const CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION = "bypassPermissions";

/**
 * SDD 472 — the dangerous Codex values, each named for the capability it grants rather than for the
 * key it lives under. Naming the key would authorize any FUTURE dangerous value of that key, which
 * is the silent widening this mechanism exists to prevent.
 */
export const CODEX_NEVER_APPROVAL_AUTHORIZATION = "neverAskForApproval";
export const CODEX_FULL_ACCESS_AUTHORIZATION = "dangerFullAccess";

/**
 * t-26f508 — Grok's single dangerous permission capability. `[ui] permission_mode` spells it two
 * ways (`always-approve` is the product name, `bypassPermissions` the Claude-compatible alias) and
 * the legacy `[ui] yolo = true` switch is a third spelling of the same thing. One authorization
 * covers all three because they grant the SAME capability: tool calls stop asking.
 */
export const GROK_ALWAYS_APPROVE_AUTHORIZATION = "alwaysApprove";

/**
 * Which authorization members each runtime may declare, on which family. An authorization is only
 * meaningful where a projector enforces it, so a profile cannot carry another runtime's.
 */
const PERMISSION_AUTHORIZATIONS: Record<string, ReadonlySet<string>> = {
  claude: new Set([CLAUDE_BYPASS_PERMISSIONS_AUTHORIZATION]),
  codex: new Set([CODEX_NEVER_APPROVAL_AUTHORIZATION, CODEX_FULL_ACCESS_AUTHORIZATION]),
  grok: new Set([GROK_ALWAYS_APPROVE_AUTHORIZATION]),
};

/** Authorizations a profile declared for one family — empty unless deliberately authored. */
export function nativeConfigAuthorizations(
  nativeConfig: AgentProfileV1["nativeConfig"],
  family: AgentNativeConfigFamily,
): ReadonlySet<string> {
  return new Set(nativeConfig?.[family]?.authorize ?? []);
}

const CODEX_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume"] as const;
const CLAUDE_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume", "fork"] as const;
/**
 * t-ee5c05 — `fork` was absent under t-26f508 and is now claimed, because the thing it claims is now
 * true: `commitFork` materializes the canonical Grok private home, seeds the source session directory
 * into it, and co-binds `HOME` under exact trust.
 */
const GROK_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume", "fork"] as const;

/**
 * The lifecycle a canonical Grok profile authored under t-26f508 carries, still admitted.
 *
 * Adding `fork` to the current tuple would otherwise refuse every profile written in between — and a
 * refused profile is not a refused agent: `loadProfileAwareConfig` returns errors for the WHOLE
 * config, so it would stop the entire roster from loading, with no in-product repair. That is the
 * exact upgrade hazard the inspector supersession lane was added for, and it applies here for the
 * same reason. Accepting it is safe in the direction that matters: a three-phase policy CLAIMS LESS
 * than the runtime now does, so an agent authored under it gets a projection on fork that its profile
 * never promised, never the reverse. Agent Studio writes the four-phase tuple, so the legacy shape
 * disappears as profiles are re-saved rather than being migrated by a special pass.
 */
const GROK_LEGACY_NATIVE_CONFIG_LIFECYCLE = ["fresh", "restart", "resume"] as const;
export const CLAUDE_SCALAR_NATIVE_CONFIG_FAMILIES = [
  "permissions",
  "interface",
  "featureFlags",
] as const;

export function codexScalarNativeConfigPolicy(
  source: CodexScalarNativeConfigSource,
  authorize: readonly string[] = [],
): AgentNativeConfigPolicyV1 {
  return {
    source,
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...CODEX_NATIVE_CONFIG_LIFECYCLE],
    // Agent Studio rebuilds this policy on every save, so an authored authorization has to be
    // carried through explicitly or it would silently reset (SDD 472).
    ...(authorize.length > 0 ? { authorize: [...authorize] } : {}),
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

export function codexSelectorNativeConfigPolicy(): AgentNativeConfigPolicyV1 {
  return {
    source: "agent",
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...CODEX_NATIVE_CONFIG_LIFECYCLE],
  };
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

export const GROK_SCALAR_NATIVE_CONFIG_FAMILIES = [
  "permissions",
  "interface",
  "featureFlags",
] as const;
export type GrokScalarNativeConfigFamily = (typeof GROK_SCALAR_NATIVE_CONFIG_FAMILIES)[number];

export function grokScalarNativeConfigPolicy(
  source: GrokScalarNativeConfigSource,
  authorize: readonly string[] = [],
): AgentNativeConfigPolicyV1 {
  return {
    source,
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...GROK_NATIVE_CONFIG_LIFECYCLE],
    // Agent Studio rebuilds this policy on every save, so an authored authorization has to be
    // carried through explicitly or it would silently reset (t-26f508, same rule as SDD 471/472).
    ...(authorize.length > 0 ? { authorize: [...authorize] } : {}),
  };
}

export function grokSelectorNativeConfigPolicy(): AgentNativeConfigPolicyV1 {
  return {
    source: "agent",
    treatment: "overlay",
    refresh: "every-launch",
    lifecycle: [...GROK_NATIVE_CONFIG_LIFECYCLE],
  };
}

/**
 * What a new canonical Grok profile selects before anyone edits it: the person's own global
 * preferences for the three scalar families, plus the three exclusions that make the private home a
 * closed namespace. The exclusions are authored rather than implied so the profile states what it
 * refuses to inherit — ambient project tooling, native memory — instead of leaving a reader to infer
 * it from the materializer.
 */
export function defaultGrokNativeConfigPolicy(): NonNullable<AgentProfileV1["nativeConfig"]> {
  return {
    ...Object.fromEntries(
      GROK_SCALAR_NATIVE_CONFIG_FAMILIES.map((family) => [family, grokScalarNativeConfigPolicy("global")]),
    ),
    tooling: grokExcludedNativeConfigPolicy("tooling"),
    memory: grokExcludedNativeConfigPolicy("memory"),
    authentication: grokExcludedNativeConfigPolicy("authentication"),
  };
}

/**
 * The three families a canonical Grok profile can only refuse or delegate, each in the exact shape
 * `resolveAgentNativeConfigSupport` admits. They are policy records with a real projection behind
 * them: `tooling` writes the `[compat.*]` cells that switch off foreign-harness discovery, `memory`
 * writes `[memory] enabled = false` next to the measured `GROK_MEMORY=0` env pin, and
 * `authentication` documents that `auth.json` stays a reconciled symlink the profile never authors.
 */
export function grokExcludedNativeConfigPolicy(
  family: "tooling" | "memory" | "authentication",
): AgentNativeConfigPolicyV1 {
  if (family === "authentication") {
    return {
      source: "global",
      treatment: "external",
      refresh: "runtime-owned",
      lifecycle: [...GROK_NATIVE_CONFIG_LIFECYCLE],
    };
  }
  return {
    source: family === "tooling" ? "workspace" : "agent",
    treatment: "exclude",
    refresh: "every-launch",
    lifecycle: [...GROK_NATIVE_CONFIG_LIFECYCLE],
  };
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
  adapter: "codex" | "claude" | "grok";
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
  /**
   * Closed Grok `config.toml` values selected by family, keyed by their dotted TOML path
   * (`ui.permission_mode`, `features.telemetry`, …). Never a raw config file: only paths this
   * projector measured reach it, and the materializer renders it back into tables in a fixed order
   * so two launches of the same profile produce byte-identical output.
   */
  toml?: Record<string, unknown>;
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
  if (!profile.nativeConfig || !["codex", "claude", "grok"].includes(profile.runtime.adapter)) return undefined;
  if (profile.runtime.adapter === "codex" && !profile.nativeConfig.selectors) return undefined;
  const sources = Object.fromEntries(
      Object.entries(profile.nativeConfig ?? {})
        .filter((entry): entry is [AgentNativeConfigFamily, AgentNativeConfigPolicyV1] => Boolean(entry[1]))
        .map(([family, policy]) => [family, policy.source]),
    ) as Partial<Record<AgentNativeConfigFamily, "global" | "workspace" | "agent">>;
  const projection: ResolvedAgentNativeConfigProjection = {
    adapter: profile.runtime.adapter as "codex" | "claude" | "grok",
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
const GROK_ALL_LIFECYCLE = new Set(GROK_NATIVE_CONFIG_LIFECYCLE);
const GROK_LEGACY_LIFECYCLE = new Set(GROK_LEGACY_NATIVE_CONFIG_LIFECYCLE);

/** Either the current Grok lifecycle tuple or the still-admitted t-26f508 one. */
function hasGrokLifecycle(actual: AgentNativeConfigPolicyV1["lifecycle"]): boolean {
  return hasExactLifecycle(actual, GROK_ALL_LIFECYCLE) || hasExactLifecycle(actual, GROK_LEGACY_LIFECYCLE);
}

function hasExactLifecycle(actual: AgentNativeConfigPolicyV1["lifecycle"], expected: ReadonlySet<string>): boolean {
  return actual.length === expected.size && actual.every((phase) => expected.has(phase));
}

export const resolveAgentNativeConfigSupport: AgentNativeConfigSupportResolver = (
  adapter,
  family,
  policy,
) => {
  // SDD 471/472 — an authorization only means something where a projector enforces it, so it is
  // legal on the permissions family of a runtime that declares members, and nowhere else. That
  // keeps a profile from quietly carrying another runtime's authorization, which nothing would act
  // on but a reader would believe.
  if (policy.authorize) {
    const supported = PERMISSION_AUTHORIZATIONS[adapter];
    if (!supported || family !== "permissions") {
      return {
        support: "unsupported",
        reason: `'authorize' is only supported on the permissions family of a runtime that declares`
          + ` authorizations, not '${adapter}' family '${family}'`,
      };
    }
    const unknown = policy.authorize.filter((entry) => !supported.has(entry));
    if (unknown.length > 0) {
      return {
        support: "unsupported",
        reason: `${adapter} permissions authorization ${unknown.map((entry) => `'${entry}'`).join(", ")}`
          + ` is not a recognized authorization (supported: ${[...supported].join(", ")})`,
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
  if (adapter === "grok" && hasGrokLifecycle(policy.lifecycle)) {
    if (
      family === "selectors"
      && policy.source === "agent"
      && policy.treatment === "overlay"
      && policy.refresh === "every-launch"
    ) {
      return {
        support: "supported",
        reason: "Grok declares typed agent selectors for fresh, restart, resume and fork",
      };
    }
    if (
      (family === "permissions" || family === "interface" || family === "featureFlags")
      && policy.source === "global"
      && policy.treatment === "overlay"
      && policy.refresh === "every-launch"
    ) {
      return {
        support: "supported",
        reason: `Grok declares filtered global ${family} projection for fresh, restart, resume and fork`,
      };
    }
    if (
      (family === "tooling" && policy.source === "workspace" && policy.treatment === "exclude" && policy.refresh === "every-launch")
      || (family === "memory" && policy.source === "agent" && policy.treatment === "exclude" && policy.refresh === "every-launch")
      || (family === "authentication" && policy.source === "global" && policy.treatment === "external" && policy.refresh === "runtime-owned")
    ) {
      return {
        support: "supported",
        reason: `Grok explicitly keeps ${family} outside authored native configuration for fresh, restart, resume and fork`,
      };
    }
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
