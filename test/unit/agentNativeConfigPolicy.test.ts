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
});
