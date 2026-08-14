import { describe, expect, it } from "vitest";
import {
  CODEX_MANAGED_HOOK_TRUST_BYPASS_FLAG,
  ManagedHookTrustError,
  applyManagedHookTrust,
  managedHookRuntimeOf,
} from "@tachyon/engine/agents/managedHookTrust.js";

describe("t-bc8d21 managedHookTrust", () => {
  it("no-op when proof.injected is false (any runtime)", () => {
    for (const runtime of ["codex", "claude", "grok", "hermes", "opencode", "generic"] as const) {
      expect(
        applyManagedHookTrust("codex -c model=o3", {
          injected: false,
          kind: "none",
          runtime,
        }),
      ).toBe("codex -c model=o3");
    }
  });

  it("codex: adds per-invocation hook-trust bypass only for session-config-flag injection", () => {
    const out = applyManagedHookTrust("codex -c 'hooks.SessionStart=[]'", {
      injected: true,
      kind: "session-config-flag",
      runtime: "codex",
    });
    expect(out).toContain(CODEX_MANAGED_HOOK_TRUST_BYPASS_FLAG);
    expect(out.startsWith(`codex ${CODEX_MANAGED_HOOK_TRUST_BYPASS_FLAG}`)).toBe(true);
    // Idempotent when flag already present
    expect(
      applyManagedHookTrust(out, {
        injected: true,
        kind: "session-config-flag",
        runtime: "codex",
      }),
    ).toBe(out);
  });

  it("codex: rejects wrong injection kind (authorship mismatch)", () => {
    expect(() =>
      applyManagedHookTrust("codex", {
        injected: true,
        kind: "session-settings",
        runtime: "codex",
      }),
    ).toThrow(ManagedHookTrustError);
  });

  it("claude: session-settings injection is a no-op for argv (no hook-hash gate)", () => {
    const cmd = "claude --settings '/ws/.tachyon/spawn-settings/a.json'";
    expect(
      applyManagedHookTrust(cmd, {
        injected: true,
        kind: "session-settings",
        runtime: "claude",
      }),
    ).toBe(cmd);
    expect(cmd).not.toContain("dangerously-skip-permissions");
  });

  it("claude: rejects wrong kind", () => {
    expect(() =>
      applyManagedHookTrust("claude", {
        injected: true,
        kind: "session-config-flag",
        runtime: "claude",
      }),
    ).toThrow(ManagedHookTrustError);
  });

  it("grok: private-home-hooks is argv no-op (folder-trust seed is separate)", () => {
    expect(
      applyManagedHookTrust("grok", {
        injected: true,
        kind: "private-home-hooks",
        runtime: "grok",
      }),
    ).toBe("grok");
  });

  it("hermes/opencode/generic: fail closed when injection is claimed without a lever", () => {
    for (const runtime of ["hermes", "opencode", "generic"] as const) {
      expect(() =>
        applyManagedHookTrust("tool", {
          injected: true,
          kind: "none",
          runtime,
        }),
      ).toThrow(ManagedHookTrustError);
    }
  });

  it("managedHookRuntimeOf maps known binaries", () => {
    expect(managedHookRuntimeOf("codex")).toBe("codex");
    expect(managedHookRuntimeOf("claude")).toBe("claude");
    expect(managedHookRuntimeOf("grok")).toBe("grok");
    expect(managedHookRuntimeOf("hermes")).toBe("hermes");
    expect(managedHookRuntimeOf("opencode")).toBe("opencode");
    expect(managedHookRuntimeOf("unknown-cli")).toBe("generic");
  });
});
