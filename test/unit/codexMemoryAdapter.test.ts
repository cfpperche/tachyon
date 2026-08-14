import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_FORK_NOTE,
  CODEX_MEMORIES_FEATURE,
  CODEX_MEMORY_MEASURED_VERSION,
  codexFeaturesListArgv,
  codexMemoryCapability,
  codexMemoryEffectiveState,
  codexMemoryStorePath,
  codexMemoryVerificationPlan,
  memoryEnablingKeys,
  parseCodexFeatures,
} from "../../src/runtime/adapters/codexMemory.js";
import { nativeMemoryCapability, resolveMemoryPolicy } from "@tachyon/engine/runtime/nativeMemory.js";
import { CODEX_EDITABLE_SETTING_KEYS, projectCodexScalarNativeConfig } from "@tachyon/engine/config/codexNativeConfigProjection.js";
import type { AgentProfileV1 } from "@tachyon/engine/config/agentProfileSchema.js";

/**
 * t-c46aad — what Codex CLI's memory can be held to without billing anyone.
 *
 * The fixtures are VERBATIM output from Codex CLI 0.145.0 run against a sandboxed CODEX_HOME on
 * 2026-07-28. No model call was made and no real ~/.codex was read.
 */

/** Exactly what `codex features list` printed by default, memory rows plus neighbours for column shape. */
const REAL_FEATURES_DEFAULT = `apply_patch_freeform                 removed            false
apps                                 stable             true
chronicle                            under development  false
external_agent_memory_import         under development  false
memories                             stable             false
`;

/** And after `codex --enable memories` — the same row, flipped. */
const REAL_FEATURES_ENABLED = `memories                             stable             true
`;

describe("the state Codex reports about itself, as measured", () => {
  it("reads the measured default: memories is stable and OFF at 0.145.0", () => {
    // The fact the whole canonical policy rests on, now carrying a version instead of a README.
    expect(codexMemoryEffectiveState(REAL_FEATURES_DEFAULT)).toBe("disabled");
    const row = parseCodexFeatures(REAL_FEATURES_DEFAULT).find((r) => r.name === CODEX_MEMORIES_FEATURE);
    expect(row).toEqual({ name: "memories", stage: "stable", enabled: false });
  });

  it("sees the control actually move it", () => {
    expect(codexMemoryEffectiveState(REAL_FEATURES_ENABLED)).toBe("enabled");
  });

  it("does not tear a stage that contains a space", () => {
    // `under development` is one column. A naive single-space split would read the stage as `under`
    // and the enabled column as `development`, quietly turning every such row into nonsense.
    const row = parseCodexFeatures(REAL_FEATURES_DEFAULT).find((r) => r.name === "chronicle");
    expect(row).toEqual({ name: "chronicle", stage: "under development", enabled: false });
  });

  it("treats a missing row as unknown rather than as disabled", () => {
    // Fail-closed: a build that stopped naming the feature has not thereby turned it off.
    expect(codexMemoryEffectiveState("apps  stable  true\n")).toBe("unknown");
  });

  it("names the non-billable readout verbatim, so a human can run it themselves", () => {
    expect(codexFeaturesListArgv()).toEqual(["features", "list"]);
  });

  it("locates the store under the private home, enumerable without reading an entry", () => {
    expect(codexMemoryStorePath("/tmp/sandbox/codex")).toBe(path.join("/tmp/sandbox/codex", "memories"));
  });
});

describe("the drift guard the parity research asked for", () => {
  // The canonical Codex config is a closed allowlist that HAPPENS not to contain a memory key, and
  // "happens not to" is exactly what erodes when someone widens the list for an unrelated reason.
  it("keeps every memory key out of the editable settings allowlist", () => {
    expect(memoryEnablingKeys(CODEX_EDITABLE_SETTING_KEYS)).toEqual([]);
  });

  it("refuses to project a memory key from the WORKSPACE source", () => {
    // agentProfileConfigLoader.test.ts already covers the `global` source. This is the other door:
    // workspace-sourced keys run through the `selectedWorkspaceKeys` branch, which reports rather than
    // silently ignores, and nothing asserted that memories lands there.
    const policy: NonNullable<AgentProfileV1["nativeConfig"]>["featureFlags"] = {
      source: "workspace",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "restart", "resume"],
    };
    const { projection, errors } = projectCodexScalarNativeConfig(
      { nativeConfig: { featureFlags: policy } },
      { workspace: "[features]\nmemories = true\nterminal_resize_reflow = true\n" },
      { adapter: "codex" as const, selectors: {} },
    );
    expect(memoryEnablingKeys(Object.keys(projection.featureFlags ?? {}))).toEqual([]);
    expect(JSON.stringify(projection)).not.toMatch(/memor/i);
    // …and it is not silently dropped: the key is named, so the refusal is visible rather than quiet.
    expect(errors).toEqual([
      "profile/native-config-key: source 'workspace' key 'features.memories' is outside the selected family allowlist",
    ]);
    // The guard discriminates rather than rejecting the whole table: the legitimate sibling key in the
    // same `[features]` block still projects, so a passing test means exclusion, not breakage.
    expect(projection.featureFlags).toEqual({ terminalResizeReflow: true });
  });

  it("catches the spellings a future config could use", () => {
    // Substring matching on purpose — enumerating today's spellings would miss tomorrow's.
    expect(memoryEnablingKeys(["features.memories", "memories.enabled", "memories", "approval_policy"]))
      .toEqual(["features.memories", "memories.enabled", "memories"]);
  });
});

describe("what the measurement does and does NOT promote", () => {
  const capability = codexMemoryCapability(nativeMemoryCapability("codex")!);

  it("promotes inventory, because the store is listable without being read", () => {
    expect(capability.evidence.inventory).toBe("verified");
  });

  it("promotes detection to runtime-status — the one place Codex beats Claude", () => {
    // Claude needed a billable turn to say anything about memory state; Codex answers for free. That is
    // a control capability, recorded where it belongs rather than laundered into an evidence axis.
    expect(capability.control.detect).toBe("runtime-status");
  });

  it("leaves every axis about what reaches the model DECLARED", () => {
    // `codex debug prompt-input` rendered BYTE-IDENTICAL output with memories off and on, while
    // `features list` proved the flag had flipped. Its silence is a fact about the tool, not the
    // feature — so it can neither confirm injection nor rule it out.
    expect(capability.evidence.disable).toBe("verified");
    for (const axis of ["enable", "injection", "mutation"] as const) {
      expect(capability.evidence[axis], `${axis} needs a live session`).toBe("declared");
    }
  });

  it("leaves isolation declared, by the same rule that held for Claude", () => {
    expect(capability.evidence.isolation).toBe("declared");
  });

  it("pins the exact version the evidence describes", () => {
    expect(capability.runtimeVersion).toBe(CODEX_MEMORY_MEASURED_VERSION);
    expect(CODEX_MEMORY_MEASURED_VERSION).toBe("0.146.0");
  });
});

describe("the policy consequence, which is the task's stated default", () => {
  const capability = codexMemoryCapability(nativeMemoryCapability("codex")!);

  it("still BLOCKS runtime-managed — the task's bar is not met", () => {
    // "Admit runtime-managed only with bounded startup injection, isolated write and purge evidence."
    const outcome = resolveMemoryPolicy({
      adapter: "codex",
      requested: "runtime-managed",
      observedVersion: CODEX_MEMORY_MEASURED_VERSION,
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("injection=declared");
  });

  it("refuses to answer for a different build", () => {
    // Version drift is the live risk here: the measured default is off, and only a measurement can say
    // it still is on the next release.
    const outcome = resolveMemoryPolicy({
      adapter: "codex",
      requested: "disabled",
      observedVersion: "0.147.0",
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons[0]).toContain("measured on 0.146.0");
  });
});

describe("fork, which the subcommand list would get wrong", () => {
  const plan = codexMemoryVerificationPlan();

  it("keeps fork unavailable as a memory boundary and says why", () => {
    // `codex fork` exists at 0.145.0, so anyone re-deriving this from `--help` would flip the field.
    expect(nativeMemoryCapability("codex")!.lifecycle.fork).toBe("unavailable");
    expect(CODEX_FORK_NOTE).toContain("CODEX_HOME-global");
    expect(plan.lifecycle.find((entry) => entry.operation === "fork")?.method).toContain("not a memory boundary");
  });

  it("separates what is free from what must be authorized", () => {
    expect(plan.withoutModelCall.length).toBeGreaterThan(0);
    expect(plan.needsAuthorization.map((entry) => entry.axis)).toEqual([
      "disable",
      "enable",
      "injection",
      "mutation",
    ]);
    for (const entry of plan.needsAuthorization) expect(entry.proves.length).toBeGreaterThan(20);
  });
});
