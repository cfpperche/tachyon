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
        // Safe measured values: this test is about which KEYS are ratified, not about the
        // dangerous-value gate, which has its own coverage below (SDD 472).
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
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
      permissions: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
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

  describe("SDD 472 — dangerous values need an explicit per-agent authorization", () => {
    function authorizedProfile(...authorize: string[]): Pick<AgentProfileV1, "nativeConfig"> {
      const base = profile("global");
      base.nativeConfig!.permissions = { ...base.nativeConfig!.permissions!, authorize };
      return base;
    }

    it.each([
      ["approval_policy", "never", "the agent never asks before running a command"],
      ["sandbox_mode", "danger-full-access", "the agent runs without a sandbox"],
    ])("omits an unauthorized %s = %s without invalidating the profile", (key, value, consequence) => {
      const result = projectCodexScalarNativeConfig(profile("global"), {
        global: `${key} = "${value}"\n`,
      }, { adapter: "codex", selectors: {} });

      expect(result.errors).toEqual([]);
      expect(result.warnings.join("\n")).toContain(
        `Codex global key '${key}' value '${value}' means ${consequence}`,
      );
      expect(result.warnings.join("\n")).toContain("authorize it for this agent");
      expect(result.projection.permissions).toEqual({});
    });

    it("projects each dangerous value once this agent authorizes it", () => {
      const result = projectCodexScalarNativeConfig(
        authorizedProfile("neverAskForApproval", "dangerFullAccess"),
        { global: 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' },
        { adapter: "codex", selectors: {} },
      );

      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.projection.permissions).toEqual({
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      });
    });

    it("authorizes only the capability it names", () => {
      // Authorizing the sandbox must not also authorize skipping approvals.
      const result = projectCodexScalarNativeConfig(
        authorizedProfile("dangerFullAccess"),
        { global: 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n' },
        { adapter: "codex", selectors: {} },
      );

      expect(result.errors).toEqual([]);
      expect(result.warnings.join("\n")).toContain("key 'approval_policy' value 'never'");
      expect(result.projection.permissions).toEqual({ sandboxMode: "danger-full-access" });
    });

    it.each([
      ["approval_policy", "untrusted"],
      ["approval_policy", "on-failure"],
      ["approval_policy", "on-request"],
      ["sandbox_mode", "read-only"],
      ["sandbox_mode", "workspace-write"],
    ])("still projects the measured safe value %s = %s with no authorization", (key, value) => {
      const result = projectCodexScalarNativeConfig(profile("global"), {
        global: `${key} = "${value}"\n`,
      }, { adapter: "codex", selectors: {} });

      expect(result.errors).toEqual([]);
      expect(result.projection.permissions).toEqual({
        [key === "approval_policy" ? "approvalPolicy" : "sandboxMode"]: value,
      });
    });

    it("refuses a value outside the measured enum instead of projecting it blindly", () => {
      const result = projectCodexScalarNativeConfig(profile("global"), {
        // `granular` is a real parser variant but a TOML table, never a scalar — as a string it is
        // simply unmeasured, and an unmeasured value must not reach the private home.
        global: 'approval_policy = "granular"\n',
      }, { adapter: "codex", selectors: {} });

      expect(result.errors.join("\n")).toContain(
        "key 'approval_policy' value 'granular' is not projectable",
      );
      expect(result.errors.join("\n")).toContain("measured against codex-cli 0.145.0");
      expect(result.projection.permissions).toEqual({});
    });
  });
});
