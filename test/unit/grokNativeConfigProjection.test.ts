import { describe, expect, it } from "vitest";
import { parse } from "@iarna/toml";
import {
  defaultGrokNativeConfigPolicy,
  grokExcludedNativeConfigPolicy,
  grokScalarNativeConfigPolicy,
  grokSelectorNativeConfigPolicy,
  resolveAgentNativeConfigSupport,
  validateAgentNativeConfigPolicy,
  GROK_ALWAYS_APPROVE_AUTHORIZATION,
  type ResolvedAgentNativeConfigProjection,
} from "../../src/config/agentNativeConfigPolicy.js";
import {
  projectGrokNativeConfig,
  GROK_NATIVE_CONFIG_FAMILY_KEYS,
  GROK_PROJECTED_KEY_ORDER,
  GROK_WITHDRAWN_NATIVE_CONFIG_KEYS,
} from "../../src/config/grokNativeConfigProjection.js";
import { renderGrokCanonicalConfig } from "../../src/harness/HarnessManager.js";
import type { AgentProfileV1 } from "../../src/config/agentProfileSchema.js";

const base: ResolvedAgentNativeConfigProjection = { adapter: "grok", selectors: {} };

function profile(
  nativeConfig: AgentProfileV1["nativeConfig"],
  runtime: Partial<AgentProfileV1["runtime"]> = {},
): Pick<AgentProfileV1, "runtime" | "nativeConfig"> {
  return {
    runtime: { adapter: "grok", executable: "grok", ...runtime },
    nativeConfig,
  };
}

/** A realistic `~/.grok/config.toml`: selected keys next to keys this projector must ignore. */
const GLOBAL_CONFIG = `
[cli]
installer = "internal"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[ui]
max_thoughts_width = 120
compact_mode = false
permission_mode = "ask"

[models]
default = "grok-4.5"

[features]
telemetry = false

[permission]
deny = ["Bash(rm -rf *)"]
`;

describe("Grok native configuration admission", () => {
  it("declares global-only sources for the scalar families", () => {
    for (const family of ["permissions", "interface", "featureFlags"] as const) {
      expect(resolveAgentNativeConfigSupport("grok", family, grokScalarNativeConfigPolicy("global")).support)
        .toBe("supported");
      // Grok's project `.grok/config.toml` contributes none of these keys, so a workspace policy
      // would be a claim the runtime never honors.
      expect(resolveAgentNativeConfigSupport("grok", family, {
        ...grokScalarNativeConfigPolicy("global"),
        source: "workspace",
      }).support).toBe("unsupported");
    }
  });

  it("t-ee5c05: declares fork, and still admits the t-26f508 three-phase tuple", () => {
    expect(grokSelectorNativeConfigPolicy().lifecycle).toEqual(["fresh", "restart", "resume", "fork"]);
    expect(resolveAgentNativeConfigSupport("grok", "selectors", grokSelectorNativeConfigPolicy()).support)
      .toBe("supported");

    // A profile authored before fork was covered must keep loading. It is not merely that agent at
    // stake: an unsupported family fails the WHOLE config, so refusing the legacy tuple would stop the
    // entire roster. Safe because the older tuple CLAIMS LESS than the runtime now does.
    for (const family of ["selectors", "permissions", "interface", "featureFlags", "tooling", "memory", "authentication"] as const) {
      const current = family === "selectors"
        ? grokSelectorNativeConfigPolicy()
        : family === "permissions" || family === "interface" || family === "featureFlags"
          ? grokScalarNativeConfigPolicy("global")
          : grokExcludedNativeConfigPolicy(family);
      expect(resolveAgentNativeConfigSupport("grok", family, current).support).toBe("supported");
      expect(resolveAgentNativeConfigSupport("grok", family, {
        ...current,
        lifecycle: ["fresh", "restart", "resume"],
      }).support, `legacy ${family} tuple`).toBe("supported");
      // A tuple that is neither shape is still refused — this is compatibility, not "any lifecycle".
      expect(resolveAgentNativeConfigSupport("grok", family, {
        ...current,
        lifecycle: ["fresh", "fork"],
      }).support).toBe("unsupported");
    }
  });

  it("admits the default profile policy whole, including the three refusals", () => {
    const nativeConfig = defaultGrokNativeConfigPolicy();
    expect(validateAgentNativeConfigPolicy("grok", nativeConfig)).toEqual([]);
    expect(Object.keys(nativeConfig).sort())
      .toEqual(["authentication", "featureFlags", "interface", "memory", "permissions", "tooling"]);
  });

  it("keeps another runtime's authorization off a Grok profile", () => {
    const nativeConfig = {
      ...defaultGrokNativeConfigPolicy(),
      permissions: grokScalarNativeConfigPolicy("global", ["dangerFullAccess"]),
    };
    expect(validateAgentNativeConfigPolicy("grok", nativeConfig).join("\n"))
      .toContain("is not a recognized authorization");
  });
});

describe("Grok native configuration projection", () => {
  it("projects only the selected families and leaves unrelated global keys opaque", () => {
    const result = projectGrokNativeConfig(
      profile({
        interface: grokScalarNativeConfigPolicy("global"),
        featureFlags: grokScalarNativeConfigPolicy("global"),
      }),
      { global: GLOBAL_CONFIG },
      base,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.projection.toml).toEqual({
      "ui.max_thoughts_width": 120,
      "ui.compact_mode": false,
      "features.telemetry": false,
    });
  });

  it("omits an unauthorized always-approve instead of refusing the agent", () => {
    const result = projectGrokNativeConfig(
      profile({ permissions: grokScalarNativeConfigPolicy("global") }),
      { global: '[ui]\npermission_mode = "always-approve"\nyolo = true\n' },
      base,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toContain("does not explicitly authorize it");
    expect(result.projection.toml).toBeUndefined();
  });

  it("projects always-approve only when this agent authorizes it", () => {
    const result = projectGrokNativeConfig(
      profile({
        permissions: grokScalarNativeConfigPolicy("global", [GROK_ALWAYS_APPROVE_AUTHORIZATION]),
      }),
      { global: '[ui]\npermission_mode = "always-approve"\nyolo = true\n' },
      base,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.projection.toml).toEqual({ "ui.permission_mode": "always-approve", "ui.yolo": true });
  });

  it("names the offending key and the way out when a value is unmeasured", () => {
    const result = projectGrokNativeConfig(
      profile({ interface: grokScalarNativeConfigPolicy("global") }),
      { global: '[ui]\nscreen_mode = "kiosk"\n' },
      base,
    );
    expect(result.errors).toEqual([
      "profile/native-config-value: Grok global key 'ui.screen_mode' value 'kiosk' is not projectable"
      + " (supported: fullscreen, minimal); set the Interface family to Exclude or change the global value",
    ]);
  });

  it("writes agent-owned selectors from the profile and refuses unmeasured ones", () => {
    const ok = projectGrokNativeConfig(
      profile({ selectors: grokSelectorNativeConfigPolicy() }, { model: "grok-4.5", reasoningEffort: "high" }),
      {},
      base,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.projection.toml).toEqual({ "models.default": "grok-4.5", "models.default_reasoning_effort": "high" });

    const bad = projectGrokNativeConfig(
      profile({ selectors: grokSelectorNativeConfigPolicy() }, { reasoningEffort: "deep", provider: "acme" }),
      {},
      base,
    );
    expect(bad.errors).toHaveLength(2);
    expect(bad.errors.join("\n")).toContain("Grok provider has no measured canonical materialization");
    expect(bad.errors.join("\n")).toContain("reasoningEffort 'deep' is unsupported");
  });

  it("refuses an unreadable global source rather than projecting a partial one", () => {
    const result = projectGrokNativeConfig(
      profile({ interface: grokScalarNativeConfigPolicy("global") }),
      { global: "[ui" },
      base,
    );
    expect(result.errors.join("\n")).toContain("Grok global config is invalid TOML");
    expect(result.projection.toml).toBeUndefined();
  });
});

describe("Grok canonical private config rendering", () => {
  const projected = projectGrokNativeConfig(
    profile(
      {
        selectors: grokSelectorNativeConfigPolicy(),
        permissions: grokScalarNativeConfigPolicy("global"),
        interface: grokScalarNativeConfigPolicy("global"),
        featureFlags: grokScalarNativeConfigPolicy("global"),
      },
      { model: "grok-4.5", reasoningEffort: "high" },
    ),
    { global: GLOBAL_CONFIG },
    base,
  ).projection;

  it("renders valid TOML with each dotted key back under its own table", () => {
    const rendered = renderGrokCanonicalConfig("grok-agent", projected);
    const parsed = parse(rendered) as Record<string, Record<string, unknown>>;
    expect(parsed.models).toEqual({ default: "grok-4.5", default_reasoning_effort: "high" });
    expect(parsed.ui).toEqual({ permission_mode: "ask", max_thoughts_width: 120, compact_mode: false });
    expect(parsed.permission).toEqual({ deny: ["Bash(rm -rf *)"] });
    expect(parsed.features).toEqual({ telemetry: false });
  });

  it("always pins memory off and every foreign-harness compat cell off", () => {
    // Measured on grok 0.2.112: without these cells a project `.claude/skills/*` is discovered and
    // active; with them it reports compatibilityStatus "disabled".
    const parsed = parse(renderGrokCanonicalConfig("grok-agent", projected)) as Record<string, Record<string, unknown>>;
    expect(parsed.memory).toEqual({ enabled: false });
    expect(parsed.compat).toEqual({
      cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false, sessions: false },
      claude: { skills: false, rules: false, agents: false, mcps: false, hooks: false, sessions: false },
      codex: { sessions: false },
    });
  });

  it("keeps the isolation block even when no family is selected", () => {
    const parsed = parse(renderGrokCanonicalConfig("grok-agent", base)) as Record<string, Record<string, unknown>>;
    expect(parsed.memory).toEqual({ enabled: false });
    expect(parsed.compat.claude).toMatchObject({ skills: false });
  });

  it("is byte-identical across launches, which is what 'regenerated equivalently' means", () => {
    expect(renderGrokCanonicalConfig("grok-agent", projected))
      .toBe(renderGrokCanonicalConfig("grok-agent", projected));
  });

  it("refuses another runtime's projection", () => {
    expect(() => renderGrokCanonicalConfig("grok-agent", { adapter: "claude", selectors: {} }))
      .toThrow(/targets 'claude', not 'grok'/);
  });
});

/**
 * t-52964c. `features.lsp_tools` used to sit in the Feature flags family, so Tachyon projected it
 * into the private home while the profile inspector refused the only file that could make it mean
 * anything (`.grok/lsp.json`, ambient Grok input). The flag was inert by construction. It was
 * withdrawn rather than made useful, and withdrawing it silently would have rebuilt the same class
 * of defect one layer down — so a person whose own global config still sets it is told.
 */
describe("Grok withdrawn projection keys", () => {
  const WITH_LSP = "[features]\ntelemetry = false\nlsp_tools = true\n";

  it("does not project features.lsp_tools even when the Feature flags family is selected", () => {
    const result = projectGrokNativeConfig(
      profile({ featureFlags: grokScalarNativeConfigPolicy("global") }),
      { global: WITH_LSP },
      base,
    );
    expect(result.errors).toEqual([]);
    expect(result.projection.toml).toEqual({ "features.telemetry": false });
  });

  it("announces the withdrawn key instead of dropping it in silence", () => {
    const result = projectGrokNativeConfig(
      profile({ featureFlags: grokScalarNativeConfigPolicy("global") }),
      { global: WITH_LSP },
      base,
    );
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    // The key, the fact it stopped being projected, and why it could never have worked.
    expect(warning).toContain("features.lsp_tools");
    expect(warning).toContain("no longer projected");
    expect(warning).toContain(".grok/lsp.json");
    // A warning must never make the agent unlaunchable.
    expect(result.errors).toEqual([]);
  });

  it("stays quiet for the people it does not affect", () => {
    // Family selected, key absent from their config: nothing changed for them.
    const absent = projectGrokNativeConfig(
      profile({ featureFlags: grokScalarNativeConfigPolicy("global") }),
      { global: "[features]\ntelemetry = false\n" },
      base,
    );
    expect(absent.warnings).toEqual([]);

    // Key present but the family excluded: it was never projected in the first place.
    const unselected = projectGrokNativeConfig(
      profile({ interface: grokScalarNativeConfigPolicy("global") }),
      { global: WITH_LSP },
      base,
    );
    expect(unselected.warnings).toEqual([]);
  });

  it("keeps the withdrawn key out of every projectable surface at once", () => {
    // One place to add a key, so one place to remove it. If a future edit puts a withdrawn key back
    // into a family, this fails rather than letting the render order and the family list disagree.
    for (const [key, withdrawn] of Object.entries(GROK_WITHDRAWN_NATIVE_CONFIG_KEYS)) {
      expect(GROK_PROJECTED_KEY_ORDER).not.toContain(key);
      for (const family of Object.values(GROK_NATIVE_CONFIG_FAMILY_KEYS)) {
        expect(family).not.toContain(key);
      }
      expect(GROK_NATIVE_CONFIG_FAMILY_KEYS[withdrawn.family]).toBeDefined();
    }
    expect(Object.keys(GROK_WITHDRAWN_NATIVE_CONFIG_KEYS)).toContain("features.lsp_tools");
  });
});
