import { describe, expect, it } from "vitest";
import {
  previewAgentNativeConfigPolicy,
  validateAgentNativeConfigPolicy,
  type AgentNativeConfigSupportResolver,
} from "../../src/config/agentNativeConfigPolicy.js";
import type { AgentNativeConfigPolicyV1, AgentProfileV1 } from "../../src/config/agentProfileSchema.js";

const permissions: AgentNativeConfigPolicyV1 = {
  source: "workspace",
  treatment: "overlay",
  refresh: "every-launch",
  lifecycle: ["fresh", "resume"],
};

const selectors: AgentNativeConfigPolicyV1 = {
  source: "agent",
  treatment: "snapshot",
  refresh: "create-once",
  lifecycle: ["fresh"],
};

const exactTupleSupport: AgentNativeConfigSupportResolver = (_adapter, family, policy) => (
  family === "permissions"
    && policy.source === "workspace"
    && policy.treatment === "overlay"
    && policy.refresh === "every-launch"
    && policy.lifecycle.join(",") === "fresh,resume"
)
  ? { support: "supported", reason: "measured test declaration" }
  : { support: "unsupported", reason: `undeclared test tuple for '${family}'` };

describe("agent native configuration support admission", () => {
  it("treats omitted and empty policy as the same no-policy state", () => {
    expect(previewAgentNativeConfigPolicy("codex", undefined)).toEqual([]);
    expect(previewAgentNativeConfigPolicy("codex", {})).toEqual([]);
    expect(validateAgentNativeConfigPolicy("codex", undefined)).toEqual([]);
    expect(validateAgentNativeConfigPolicy("codex", {})).toEqual([]);
  });

  it("accepts only an exact tuple declared by an adapter support resolver", () => {
    const nativeConfig: AgentProfileV1["nativeConfig"] = { permissions };
    expect(previewAgentNativeConfigPolicy("codex", nativeConfig, exactTupleSupport)).toEqual([{
      family: "permissions",
      policy: permissions,
      support: "supported",
      reason: "measured test declaration",
    }]);
    expect(validateAgentNativeConfigPolicy("codex", nativeConfig, exactTupleSupport)).toEqual([]);
  });

  it("rejects the whole admission set when any authored tuple is unsupported", () => {
    const nativeConfig: AgentProfileV1["nativeConfig"] = { selectors, permissions };
    expect(validateAgentNativeConfigPolicy("codex", nativeConfig, exactTupleSupport)).toEqual([
      "profile/native-config-unsupported: undeclared test tuple for 'selectors'",
    ]);
  });

  it("declares only the measured Codex agent-selector tuple, independent of lifecycle order", () => {
    const policy: AgentNativeConfigPolicyV1 = {
      source: "agent",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["resume", "fresh", "restart"],
    };
    expect(validateAgentNativeConfigPolicy("codex", { selectors: policy })).toEqual([]);
    expect(validateAgentNativeConfigPolicy("codex", {
      selectors: { ...policy, lifecycle: [...policy.lifecycle, "fork"] },
    })).toEqual([
      "profile/native-config-unsupported: runtime adapter 'codex' has not declared native configuration support for 'selectors'",
    ]);
  });

  it("accepts only the measured Codex scalar tuples from global or workspace sources", () => {
    const policy: AgentNativeConfigPolicyV1 = {
      source: "global",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["resume", "fresh", "restart"],
    };
    expect(validateAgentNativeConfigPolicy("codex", {
      permissions: policy,
      interface: { ...policy, source: "workspace" },
      featureFlags: policy,
    })).toEqual([]);

    expect(validateAgentNativeConfigPolicy("codex", {
      permissions: { ...policy, source: "agent" },
      interface: { ...policy, lifecycle: [...policy.lifecycle, "fork"] },
    })).toEqual([
      "profile/native-config-unsupported: runtime adapter 'codex' has not declared native configuration support for 'permissions'",
      "profile/native-config-unsupported: runtime adapter 'codex' has not declared native configuration support for 'interface'",
    ]);
  });

  it("declares Claude selectors, global/workspace scalars and external/excluded planes across all lifecycle paths", () => {
    const lifecycle: AgentNativeConfigPolicyV1["lifecycle"] = ["fork", "resume", "fresh", "restart"];
    expect(validateAgentNativeConfigPolicy("claude", {
      selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle },
      permissions: { source: "workspace", treatment: "overlay", refresh: "every-launch", lifecycle },
      interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      featureFlags: { source: "workspace", treatment: "overlay", refresh: "every-launch", lifecycle },
      tooling: { source: "workspace", treatment: "exclude", refresh: "every-launch", lifecycle },
      authentication: { source: "global", treatment: "external", refresh: "runtime-owned", lifecycle },
      memory: { source: "agent", treatment: "exclude", refresh: "every-launch", lifecycle },
    })).toEqual([]);

    expect(validateAgentNativeConfigPolicy("claude", {
      selectors: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      permissions: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle },
      tooling: { source: "workspace", treatment: "overlay", refresh: "every-launch", lifecycle },
      interface: { source: "workspace", treatment: "overlay", refresh: "every-launch", lifecycle: ["fresh", "restart", "resume"] },
    })).toHaveLength(4);
  });

  it("SDD 471: accepts a Claude permissions authorization and refuses it anywhere else", () => {
    const lifecycle: AgentNativeConfigPolicyV1["lifecycle"] = ["fresh", "restart", "resume", "fork"];
    const permissions = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle } as const;

    expect(validateAgentNativeConfigPolicy("claude", {
      permissions: { ...permissions, authorize: ["bypassPermissions"] },
    })).toEqual([]);

    // Not on another family — nothing would enforce it there.
    expect(validateAgentNativeConfigPolicy("claude", {
      interface: { ...permissions, authorize: ["bypassPermissions"] },
    })).toEqual([
      "profile/native-config-unsupported: 'authorize' is only supported on the permissions family of a"
      + " runtime that declares authorizations, not 'claude' family 'interface'",
    ]);

    // Not on another runtime — a Codex profile must not carry a Claude authorization.
    expect(validateAgentNativeConfigPolicy("codex", {
      permissions: {
        source: "global", treatment: "overlay", refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume"], authorize: ["bypassPermissions"],
      },
    })).toEqual([
      "profile/native-config-unsupported: codex permissions authorization 'bypassPermissions' is not a"
      + " recognized authorization (supported: neverAskForApproval, dangerFullAccess)",
    ]);

    // Unknown members fail closed rather than being ignored.
    expect(validateAgentNativeConfigPolicy("claude", {
      permissions: { ...permissions, authorize: ["disableSandbox"] },
    })).toEqual([
      "profile/native-config-unsupported: claude permissions authorization 'disableSandbox' is not a"
      + " recognized authorization (supported: bypassPermissions)",
    ]);
  });

  it("SDD 472: accepts the Codex permissions authorizations and refuses them elsewhere", () => {
    const codexLifecycle: AgentNativeConfigPolicyV1["lifecycle"] = ["fresh", "restart", "resume"];
    const codexPermissions = {
      source: "global" as const, treatment: "overlay" as const, refresh: "every-launch" as const,
      lifecycle: codexLifecycle,
    };

    expect(validateAgentNativeConfigPolicy("codex", {
      permissions: { ...codexPermissions, authorize: ["neverAskForApproval", "dangerFullAccess"] },
    })).toEqual([]);

    // The refusal runs both ways — a Claude profile must not carry a Codex authorization either.
    expect(validateAgentNativeConfigPolicy("claude", {
      permissions: {
        source: "global", treatment: "overlay", refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"], authorize: ["dangerFullAccess"],
      },
    })).toEqual([
      "profile/native-config-unsupported: claude permissions authorization 'dangerFullAccess' is not a"
      + " recognized authorization (supported: bypassPermissions)",
    ]);

    // A runtime that declares no authorizations at all cannot carry one.
    expect(validateAgentNativeConfigPolicy("grok", {
      permissions: { ...codexPermissions, authorize: ["neverAskForApproval"] },
    })).toEqual([
      "profile/native-config-unsupported: 'authorize' is only supported on the permissions family of a"
      + " runtime that declares authorizations, not 'grok' family 'permissions'",
    ]);
  });
});
