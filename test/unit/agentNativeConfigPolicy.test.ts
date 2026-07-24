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
});
