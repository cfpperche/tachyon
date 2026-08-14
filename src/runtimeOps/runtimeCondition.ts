/**
 * t-458497 — "what condition is each runtime in?", answered for an AGENT, as a DERIVED projection.
 *
 * The case that produced this: a coordinator spent hours not delegating to Claude because of a 5h
 * limit, the limit reset, and it only found out because the human said so. The product already had
 * the number — `src/runtimeObservability/` collects it and persists the last good value — and no
 * Bridge tool could see it. Nothing here collects anything new; this module makes what is already
 * collected legible, and every field it returns names where it came from.
 *
 * ## Two axes, never merged
 *
 * Runtime condition is TWO independent questions, and a shape that answers them as one lies about
 * Grok:
 *
 *  - CONFIGURATION/CAPABILITY — can Tachyon operate this runtime, and how much of that has actually
 *    been measured? All the supported runtimes are observable here.
 *  - QUOTA/SLACK — how much room is left right now? Codex has a firm channel, Claude has a fragile
 *    one, and Grok has none at all.
 *
 * Collapsing them produces the exact misreading this task was filed over: Grok looks covered because
 * it is covered on the first axis, and it is not covered on the second.
 *
 * ## Three states, kept apart
 *
 *  - MANAGEABLE — Tachyon knows how to spawn and operate it (`SUPPORTED_AGENT_RUNTIMES`).
 *  - MEASURED — it has an entry in the parity matrix, and each axis of that entry says whether the
 *    claim was `verified` (behaviourally observed) or only `declared` (documented, never observed).
 *  - OBSERVABLE NOW — a live quota source exists on this host and has produced a reading.
 *
 * A runtime can be any combination of the three. Grok is manageable, measured, and NOT observable.
 *
 * ## Why this is not a sixth runtime list
 *
 * Five runtime registries already disagree with each other. This module authors none: the set of
 * runtimes it reports is the UNION of the keys of the registries it reads plus the providers the
 * observation service actually has a source for, and each returned field carries the registry it was
 * read from. Adding a runtime to any of those registries makes it appear here; nothing in this file
 * has to be edited, and there is no name in this file to fall out of step.
 */

import { SUPPORTED_AGENT_RUNTIMES } from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import {
  MEMORY_EVIDENCE_AXES,
  RUNTIME_NATIVE_MEMORY_REGISTRY,
  type MemoryEvidence,
  type MemoryEvidenceAxis,
} from "../runtime/nativeMemory.js";
import type { ProviderObservationPreferenceV1 } from "../runtimeObservability/preferences.js";
import type { ProviderQuotaChannelDescriptorV1 } from "../runtimeObservability/service.js";
import type {
  CollectorEnvelopeV1,
  ProviderQuotaFactV1,
  ProviderSourceKindV1,
  ProviderUnavailableFactV1,
  RuntimeObservabilityProviderV1,
} from "../runtimeObservability/types.js";

export const RUNTIME_CONDITION_SCHEMA_VERSION = 1 as const;

/** Where one field came from. A projection with no provenance is a sixth registry wearing a disguise. */
export interface RuntimeConditionOriginV1 {
  /** the exported registry, by its code name */
  registry: string;
  /** the module that owns it, so the claim can be checked instead of trusted */
  module: string;
}

const MANAGEABLE_ORIGIN: RuntimeConditionOriginV1 = {
  registry: "SUPPORTED_AGENT_RUNTIMES",
  module: "packages/shared/src/agents/agentRuntimeAdmission.ts",
};

const MEASURED_ORIGIN: RuntimeConditionOriginV1 = {
  registry: "RUNTIME_NATIVE_MEMORY_REGISTRY",
  module: "src/runtime/nativeMemory.ts",
};

const CHANNEL_ORIGIN: RuntimeConditionOriginV1 = {
  registry: "ProviderObservationService.describeChannels()",
  module: "src/runtimeObservability/service.ts",
};

/** The words the tool uses for an absence, so an agent can match on them instead of parsing prose. */
export const NO_QUOTA_CHANNEL = "no quota channel" as const;

export interface RuntimeManageableV1 {
  state: "manageable" | "not-manageable";
  origin: RuntimeConditionOriginV1;
  /** what makes this a runtime Tachyon operates rather than a process it starts */
  evidence?: string;
  /** a declared shortfall against the delegation contract, quoted from the registry */
  gap?: string;
  /** true when this runtime may also back a Saved Profile */
  savedAgentProfile?: boolean;
}

export interface RuntimeMeasuredV1 {
  state: "measured" | "not-measured";
  origin: RuntimeConditionOriginV1;
  /** the EXACT runtime version the entry was measured against; a different version is different facts */
  measuredAtVersion?: string;
  /** per-axis strength, verbatim from the parity matrix */
  axes?: Record<MemoryEvidenceAxis, MemoryEvidence>;
  /** the axes an observation actually supported — the only ones that mean "checked" */
  verified?: MemoryEvidenceAxis[];
  /** documented by the runtime and never observed */
  declared?: MemoryEvidenceAxis[];
  /** measured and CONTRADICTED, which is not the same as unchecked */
  refuted?: MemoryEvidenceAxis[];
}

export type RuntimeQuotaIntegrityV1 = "firm" | "best-effort";

export type RuntimeQuotaChannelV1 =
  | {
      state: "absent";
      /** the literal absence, by name — never a zero and never silence */
      says: typeof NO_QUOTA_CHANNEL;
      origin: RuntimeConditionOriginV1;
      note: string;
    }
  | {
      state: "present";
      origin: RuntimeConditionOriginV1;
      sourceKind: ProviderSourceKindV1;
      acquisition: "control-plane" | "rendered-surface";
      mechanism: string;
      integrity: RuntimeQuotaIntegrityV1;
    }
  | {
      state: "unknown";
      /** no observation service on this host, which is not the same as "this runtime has no channel" */
      note: string;
    };

export interface RuntimeQuotaWindowV1 {
  name: "session" | "weekly" | "tertiary";
  usedPercent: number;
  /** null when the channel did not name a window length. Null is the absence; it is not zero. */
  windowMinutes: number | null;
  /** null when the channel named no reset time. Tachyon does not invent the edge. */
  resetsAt: string | null;
}

export type RuntimeQuotaV1 =
  | { state: "no-quota-channel"; says: typeof NO_QUOTA_CHANNEL; note: string }
  | { state: "not-configured"; note: string }
  | {
      state: "unavailable";
      reason: string;
      observedAt?: string;
      /** when a last good value exists but is too old to stand for the present */
      lastGoodAt?: string;
      source?: ProviderSourceKindV1;
      note: string;
    }
  | {
      state: "observed";
      integrity: RuntimeQuotaIntegrityV1;
      source: ProviderSourceKindV1;
      observedAt: string;
      freshness: { state: "fresh" } | { state: "stale"; lastGoodAt: string };
      windows: RuntimeQuotaWindowV1[];
      note: string;
    };

export interface RuntimeConditionV1 {
  runtime: string;
  configuration: {
    manageable: RuntimeManageableV1;
    measured: RuntimeMeasuredV1;
  };
  capacity: {
    channel: RuntimeQuotaChannelV1;
    quota: RuntimeQuotaV1;
  };
}

export interface RuntimeConditionReportV1 {
  schemaVersion: typeof RUNTIME_CONDITION_SCHEMA_VERSION;
  generatedAt: string;
  axes: {
    configuration: string;
    capacity: string;
  };
  runtimes: RuntimeConditionV1[];
}

export interface RuntimeConditionInputV1 {
  generatedAt: string;
  /**
   * The channels this host has. `undefined` means no provider-observation service is wired at all —
   * reported as `unknown`, because "nobody is looking" and "this runtime has no channel" are
   * different answers and only one of them is about the runtime.
   */
  channels?: readonly ProviderQuotaChannelDescriptorV1[];
  preferences?: Partial<Record<RuntimeObservabilityProviderV1, ProviderObservationPreferenceV1>>;
  observations?: Partial<Record<RuntimeObservabilityProviderV1, CollectorEnvelopeV1>>;
}

const AXIS_NOTES = {
  configuration:
    "can Tachyon operate this runtime, and how much of that was measured rather than documented "
    + "(manageable + measured). Independent of quota: a runtime can be fully manageable and have no "
    + "quota channel at all.",
  capacity:
    "how much room is left right now. Only runtimes with a live quota source can answer; the rest say "
    + `'${NO_QUOTA_CHANNEL}' by name. A missing channel is never reported as zero usage.`,
} as const;

/**
 * Build the report. Pure: every input is handed in, and the only sources of truth are the registries
 * imported above plus the live observation state the caller passes through.
 */
export function projectRuntimeCondition(input: RuntimeConditionInputV1): RuntimeConditionReportV1 {
  const channels = input.channels;
  const byProvider = new Map<string, ProviderQuotaChannelDescriptorV1>();
  for (const descriptor of channels ?? []) {
    // First registration wins, matching the service's own duplicate refusal at construction.
    if (!byProvider.has(descriptor.provider)) byProvider.set(descriptor.provider, descriptor);
  }

  const runtimes = [...new Set([
    ...Object.keys(SUPPORTED_AGENT_RUNTIMES),
    ...Object.keys(RUNTIME_NATIVE_MEMORY_REGISTRY),
    ...byProvider.keys(),
  ])].sort();

  return {
    schemaVersion: RUNTIME_CONDITION_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    axes: { configuration: AXIS_NOTES.configuration, capacity: AXIS_NOTES.capacity },
    runtimes: runtimes.map((runtime) => {
      const descriptor = byProvider.get(runtime);
      return {
        runtime,
        configuration: {
          manageable: projectManageable(runtime),
          measured: projectMeasured(runtime),
        },
        capacity: {
          channel: projectChannel(runtime, descriptor, channels !== undefined),
          quota: projectQuota(runtime, descriptor, channels !== undefined, input),
        },
      };
    }),
  };
}

function projectManageable(runtime: string): RuntimeManageableV1 {
  const support = Object.hasOwn(SUPPORTED_AGENT_RUNTIMES, runtime)
    ? SUPPORTED_AGENT_RUNTIMES[runtime as keyof typeof SUPPORTED_AGENT_RUNTIMES]
    : undefined;
  if (!support) return { state: "not-manageable", origin: MANAGEABLE_ORIGIN };
  return {
    state: "manageable",
    origin: MANAGEABLE_ORIGIN,
    evidence: support.evidence,
    savedAgentProfile: support.savedAgentProfile,
    ...(support.gap ? { gap: support.gap } : {}),
  };
}

function projectMeasured(runtime: string): RuntimeMeasuredV1 {
  const capability = RUNTIME_NATIVE_MEMORY_REGISTRY[runtime];
  if (!capability) return { state: "not-measured", origin: MEASURED_ORIGIN };
  const axes = {} as Record<MemoryEvidenceAxis, MemoryEvidence>;
  const verified: MemoryEvidenceAxis[] = [];
  const declared: MemoryEvidenceAxis[] = [];
  const refuted: MemoryEvidenceAxis[] = [];
  for (const axis of MEMORY_EVIDENCE_AXES) {
    const evidence = capability.evidence[axis];
    axes[axis] = evidence;
    if (evidence === "verified") verified.push(axis);
    else if (evidence === "declared") declared.push(axis);
    else if (evidence === "refuted") refuted.push(axis);
  }
  return {
    state: "measured",
    origin: MEASURED_ORIGIN,
    measuredAtVersion: capability.runtimeVersion,
    axes,
    verified,
    declared,
    ...(refuted.length > 0 ? { refuted } : {}),
  };
}

function projectChannel(
  runtime: string,
  descriptor: ProviderQuotaChannelDescriptorV1 | undefined,
  inventoried: boolean,
): RuntimeQuotaChannelV1 {
  if (!inventoried) {
    return {
      state: "unknown",
      note:
        "no provider-observation service is wired on this host, so Tachyon cannot say whether this "
        + "runtime has a quota channel. This is a statement about the host, not about the runtime.",
    };
  }
  if (!descriptor) {
    return {
      state: "absent",
      says: NO_QUOTA_CHANNEL,
      origin: CHANNEL_ORIGIN,
      note:
        `${runtime} has no source registered on the observation service, so there is nothing that `
        + "reports how much room is left. Treat its remaining quota as unknown, never as full and "
        + "never as zero.",
    };
  }
  return {
    state: "present",
    origin: CHANNEL_ORIGIN,
    sourceKind: descriptor.source,
    acquisition: descriptor.channel.acquisition,
    mechanism: descriptor.channel.mechanism,
    integrity: integrityOf(descriptor),
  };
}

/**
 * The best-effort label, DERIVED from how the source says it acquires the number.
 *
 * A number parsed out of a surface drawn for a human survives only as long as that layout does, so it
 * is reported as best-effort wherever it appears. Nothing here keys on a runtime name.
 */
export function integrityOf(descriptor: ProviderQuotaChannelDescriptorV1): RuntimeQuotaIntegrityV1 {
  return descriptor.channel.acquisition === "control-plane" ? "firm" : "best-effort";
}

function projectQuota(
  runtime: string,
  descriptor: ProviderQuotaChannelDescriptorV1 | undefined,
  inventoried: boolean,
  input: RuntimeConditionInputV1,
): RuntimeQuotaV1 {
  if (!inventoried || !descriptor) {
    return {
      state: "no-quota-channel",
      says: NO_QUOTA_CHANNEL,
      note: inventoried
        ? `nothing on this host reports remaining quota for ${runtime}`
        : `no provider-observation service is wired, so no quota can be reported for ${runtime}`,
    };
  }

  const provider = descriptor.provider;
  const preference = input.preferences?.[provider];
  if (!preference) {
    return {
      state: "not-configured",
      note:
        `${runtime} has a quota channel, but it is switched off: reading it needs an explicit machine-local `
        + "grant, and none is recorded. Nothing is being collected, so nothing can be reported.",
    };
  }

  const envelope = input.observations?.[provider];
  const facts = Array.isArray(envelope?.facts) ? envelope.facts : [];
  const quota = facts.find((fact): fact is ProviderQuotaFactV1 => fact.kind === "provider-quota");
  const unavailable = facts.find(
    (fact): fact is ProviderUnavailableFactV1 => fact.kind === "provider-unavailable",
  );

  if (quota) {
    const integrity = integrityOf(descriptor);
    return {
      state: "observed",
      integrity,
      source: quota.source,
      observedAt: quota.observedAt,
      freshness: quota.freshness.state === "fresh"
        ? { state: "fresh" }
        : { state: "stale", lastGoodAt: quota.freshness.lastGoodAt },
      windows: quota.windows.map((window) => ({
        name: window.name,
        usedPercent: window.usedPercent,
        windowMinutes: window.windowMinutes ?? null,
        resetsAt: window.resetsAt ?? null,
      })),
      note: integrity === "best-effort"
        ? `read off a surface ${runtime} renders for a human — treat it as best-effort, not as a contract`
        : `answered by ${runtime} itself over a machine protocol`,
    };
  }

  return {
    state: "unavailable",
    reason: unavailable?.reason ?? "not-observed",
    ...(unavailable?.observedAt ? { observedAt: unavailable.observedAt } : {}),
    ...(unavailable?.lastGoodAt ? { lastGoodAt: unavailable.lastGoodAt } : {}),
    ...(unavailable?.source ? { source: unavailable.source } : {}),
    note:
      `${runtime} has a quota channel and it did not answer. Remaining quota is unknown — this is not `
      + "a reading of zero usage and not a reading of full capacity.",
  };
}
