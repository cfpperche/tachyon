import { describe, it, expect } from "vitest";
import {
  NO_QUOTA_CHANNEL,
  projectRuntimeCondition,
  type RuntimeConditionInputV1,
} from "@tachyon/engine/runtimeOps/runtimeCondition.js";
import { SUPPORTED_AGENT_RUNTIMES } from "@tachyon/shared/agents/agentRuntimeAdmission.js";
import { RUNTIME_NATIVE_MEMORY_REGISTRY } from "@tachyon/engine/runtime/nativeMemory.js";
import type { CollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/types.js";
import type { ProviderQuotaChannelDescriptorV1 } from "@tachyon/engine/runtimeObservability/service.js";

const AT = "2026-08-02T18:00:00.000Z";

const CODEX_CHANNEL: ProviderQuotaChannelDescriptorV1 = {
  provider: "codex",
  source: "cli",
  channel: { acquisition: "control-plane", mechanism: "app-server account/rateLimits/read" },
};

const CLAUDE_CHANNEL: ProviderQuotaChannelDescriptorV1 = {
  provider: "claude",
  source: "cli",
  channel: { acquisition: "rendered-surface", mechanism: "status-line capture" },
};

function granted(provider: "codex" | "claude") {
  return {
    scope: { kind: "provider-account" as const, provider, key: `ps_${provider === "codex" ? "0" : "f"}0123456789abcde` },
    sources: ["cli" as const],
  };
}

function quotaEnvelope(
  provider: "codex" | "claude",
  windows: Array<{ name: "session" | "weekly"; usedPercent: number; windowMinutes?: number; resetsAt?: string }>,
  freshness: { state: "fresh" } | { state: "stale"; lastGoodAt: string } = { state: "fresh" },
): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: "fixture", version: "1.0.0" },
    generatedAt: AT,
    facts: [{
      kind: "provider-quota",
      scope: granted(provider).scope,
      source: "cli",
      confidence: "exact",
      observedAt: AT,
      freshness,
      windows,
    }],
    diagnostics: [],
  };
}

function unavailableEnvelope(provider: "codex" | "claude"): CollectorEnvelopeV1 {
  return {
    schemaVersion: 1,
    collector: { id: "fixture", version: "1.0.0" },
    generatedAt: AT,
    facts: [{
      kind: "provider-unavailable",
      scope: granted(provider).scope,
      source: "cli",
      observedAt: AT,
      reason: "unauthenticated",
    }],
    diagnostics: [{ code: "SOURCE_UNAVAILABLE", provider, factIndex: 0 }],
  };
}

function report(overrides: Partial<RuntimeConditionInputV1> = {}) {
  return projectRuntimeCondition({
    generatedAt: AT,
    channels: [CODEX_CHANNEL, CLAUDE_CHANNEL],
    preferences: { codex: granted("codex"), claude: granted("claude") },
    observations: {},
    ...overrides,
  });
}

function runtime(input: ReturnType<typeof report>, name: string) {
  const found = input.runtimes.find((entry) => entry.runtime === name);
  if (!found) throw new Error(`no runtime '${name}' in the report`);
  return found;
}

describe("projectRuntimeCondition", () => {
  it("keeps the two axes separate: grok is manageable and measured, and has no quota channel", () => {
    const grok = runtime(report(), "grok");

    expect(grok.configuration.manageable.state).toBe("manageable");
    expect(grok.configuration.measured.state).toBe("measured");
    // The axis that made Grok look covered when it was not.
    expect(grok.capacity.channel).toMatchObject({ state: "absent", says: NO_QUOTA_CHANNEL });
    expect(grok.capacity.quota).toMatchObject({ state: "no-quota-channel", says: NO_QUOTA_CHANNEL });
  });

  it("never fills a missing channel with a zero", () => {
    const grok = runtime(report(), "grok");
    const serialized = JSON.stringify(grok.capacity);

    expect(serialized).not.toContain("usedPercent");
    expect(serialized).not.toContain("windows");
    // And the absence is stated, not implied by an empty object.
    expect(grok.capacity.quota.state).toBe("no-quota-channel");
  });

  it("distinguishes 'this runtime has no channel' from 'nobody is looking on this host'", () => {
    const unwired = projectRuntimeCondition({ generatedAt: AT });
    const grok = runtime(unwired, "grok");
    const claude = runtime(unwired, "claude");

    expect(grok.capacity.channel.state).toBe("unknown");
    expect(claude.capacity.channel.state).toBe("unknown");
    // Same answer for both, because the fact being reported is about the host.
    expect(claude.capacity.quota.state).toBe("no-quota-channel");
    expect(claude.capacity.quota.note).toContain("no provider-observation service");
  });

  it("labels a quota read off a rendered surface best-effort, and a control-plane one firm", () => {
    const built = report({
      observations: {
        claude: quotaEnvelope("claude", [{ name: "session", usedPercent: 42, windowMinutes: 300 }]),
        codex: quotaEnvelope("codex", [{ name: "session", usedPercent: 7, windowMinutes: 300 }]),
      },
    });

    expect(runtime(built, "claude").capacity.channel).toMatchObject({
      state: "present",
      acquisition: "rendered-surface",
      integrity: "best-effort",
    });
    expect(runtime(built, "claude").capacity.quota).toMatchObject({ state: "observed", integrity: "best-effort" });
    expect(runtime(built, "codex").capacity.channel).toMatchObject({
      state: "present",
      acquisition: "control-plane",
      integrity: "firm",
    });
    expect(runtime(built, "codex").capacity.quota).toMatchObject({ state: "observed", integrity: "firm" });
  });

  it("reports a reset time only where the channel gave one, and null — never a guess — where it did not", () => {
    const built = report({
      observations: {
        codex: quotaEnvelope("codex", [
          { name: "session", usedPercent: 91, windowMinutes: 300, resetsAt: "2026-08-02T22:00:00.000Z" },
          { name: "weekly", usedPercent: 30 },
        ]),
      },
    });
    const quota = runtime(built, "codex").capacity.quota;
    if (quota.state !== "observed") throw new Error("expected an observed quota");

    expect(quota.windows[0]).toMatchObject({ name: "session", resetsAt: "2026-08-02T22:00:00.000Z", windowMinutes: 300 });
    expect(quota.windows[1]).toMatchObject({ name: "weekly", resetsAt: null, windowMinutes: null });
  });

  it("a channel that did not answer is unavailable, not a reading of zero", () => {
    const built = report({ observations: { codex: unavailableEnvelope("codex") } });
    const quota = runtime(built, "codex").capacity.quota;

    expect(quota).toMatchObject({ state: "unavailable", reason: "unauthenticated" });
    expect(JSON.stringify(quota)).not.toContain("usedPercent");
    // The channel itself is still present — the runtime HAS one, it just did not answer.
    expect(runtime(built, "codex").capacity.channel.state).toBe("present");
  });

  it("an ungranted channel says so instead of reporting an empty quota", () => {
    const built = report({ preferences: {} });
    const codex = runtime(built, "codex");

    expect(codex.capacity.channel.state).toBe("present");
    expect(codex.capacity.quota.state).toBe("not-configured");
  });

  it("separates verified from declared on the measured axis", () => {
    const claude = runtime(report(), "claude").configuration.measured;
    if (claude.state !== "measured") throw new Error("expected claude to be measured");

    expect(claude.measuredAtVersion).toBe(RUNTIME_NATIVE_MEMORY_REGISTRY.claude?.runtimeVersion);
    expect(claude.verified).toContain("disable");
    expect(claude.declared).toContain("inventory");
    expect(claude.verified).not.toContain("inventory");
  });

  it("lists exactly the runtimes the existing registries know — it authors no list of its own", () => {
    const expected = [...new Set([
      ...Object.keys(SUPPORTED_AGENT_RUNTIMES),
      ...Object.keys(RUNTIME_NATIVE_MEMORY_REGISTRY),
      "codex",
      "claude",
    ])].sort();

    expect(report().runtimes.map((entry) => entry.runtime)).toEqual(expected);
  });

  it("carries the owning registry on every configuration field", () => {
    const pi = runtime(report(), "pi").configuration;

    expect(pi.manageable.origin).toEqual({
      registry: "SUPPORTED_AGENT_RUNTIMES",
      module: "packages/shared/src/agents/agentRuntimeAdmission.ts",
    });
    expect(pi.measured.origin).toEqual({
      registry: "RUNTIME_NATIVE_MEMORY_REGISTRY",
      module: "packages/engine/src/runtime/nativeMemory.ts",
    });
  });

  it("a runtime in only one registry still appears, with the other axis saying so", () => {
    // `gemini` is admissible as an Agent Instance and has no parity-matrix entry.
    const gemini = runtime(report(), "gemini").configuration;

    expect(gemini.manageable.state).toBe("manageable");
    expect(gemini.manageable.gap).toContain("no Bridge wiring");
    expect(gemini.measured.state).toBe("not-measured");
    expect(gemini.measured.axes).toBeUndefined();
  });
});
