import { describe, expect, it } from "vitest";
import { projectCodexScalarNativeConfig } from "../../src/config/codexNativeConfigProjection.js";
import type { AgentProfileV1 } from "../../src/config/agentProfileSchema.js";

const POLICY = {
  treatment: "overlay",
  refresh: "every-launch",
  lifecycle: ["fresh", "restart", "resume"],
} as const;

function profile(source: "global" | "workspace"): Pick<AgentProfileV1, "nativeConfig"> {
  return {
    nativeConfig: {
      permissions: { ...POLICY, source, lifecycle: [...POLICY.lifecycle] },
      interface: { ...POLICY, source, lifecycle: [...POLICY.lifecycle] },
      featureFlags: { ...POLICY, source, lifecycle: [...POLICY.lifecycle] },
    },
  };
}

describe("Codex scalar native configuration projection", () => {
  it("projects only the ratified global keys and ignores unrelated global state", () => {
    const result = projectCodexScalarNativeConfig(profile("global"), {
      global: [
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'personality = "pragmatic"',
        'model_provider = "secret-redirect"',
        '[tui]',
        'status_line = ["model", "git-branch"]',
        'status_line_use_colors = true',
        '[features]',
        'terminal_resize_reflow = false',
        'memories = true',
        '[hooks.state]',
        'trusted_hash = "never-project"',
      ].join("\n"),
    }, { adapter: "codex", selectors: {} });

    expect(result.errors).toEqual([]);
    expect(result.projection).toEqual({
      adapter: "codex",
      selectors: {},
      permissions: { approvalPolicy: "never", sandboxMode: "danger-full-access" },
      interface: {
        personality: "pragmatic",
        statusLine: ["model", "git-branch"],
        statusLineUseColors: true,
      },
      featureFlags: { terminalResizeReflow: false },
    });
    expect(JSON.stringify(result.projection)).not.toContain("secret-redirect");
    expect(JSON.stringify(result.projection)).not.toContain("trusted_hash");
    expect(JSON.stringify(result.projection)).not.toContain("memories");
  });

  it("rejects any workspace key outside families explicitly sourced from workspace", () => {
    const result = projectCodexScalarNativeConfig({
      nativeConfig: {
        permissions: { ...POLICY, source: "workspace", lifecycle: [...POLICY.lifecycle] },
      },
    }, {
      workspace: 'approval_policy = "on-request"\nmodel = "ambient-model"\n',
    }, { adapter: "codex", selectors: {} });

    expect(result.errors).toEqual([
      "profile/native-config-key: source 'workspace' key 'model' is outside the selected family allowlist",
    ]);
  });

  it("names the family, source and key when an allowed value has the wrong type", () => {
    const result = projectCodexScalarNativeConfig(profile("global"), {
      global: "approval_policy = 42\n",
    }, { adapter: "codex", selectors: {} });

    expect(result.errors).toContain(
      "profile/native-config-key: family 'permissions' source 'global' key 'approval_policy' must be string",
    );
  });
});
