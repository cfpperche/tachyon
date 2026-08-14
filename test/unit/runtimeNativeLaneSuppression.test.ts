import { describe, expect, it } from "vitest";
import {
  RUNTIME_NATIVE_LANE_SUPPRESSION_REGISTRY,
  assertLaneSuppressionEvidenceIsExplained,
  isBehavioralLaneSuppressionEvidence,
  isNativeSuppressionConfirmed,
  nativeLaneSuppressionCapability,
} from "../../src/runtime/nativeLaneSuppression.js";
import { nativeMemoryCapability } from "@tachyon/engine/runtime/nativeMemory.js";

/**
 * SDD 490 Fatia C — combined native lane suppression registry.
 *
 * Guards the rule that made this module exist: overall `verified` only when instructions and
 * memory (when native) are both behaviorally verified, and every `verified` cites a behavioral-test
 * source. Hand-editing a surface to `verified` without evidence must fail the structural assert.
 */
describe("native lane suppression registry", () => {
  it("covers claude, codex and grok at exact measured versions", () => {
    for (const adapter of ["claude", "codex", "grok"] as const) {
      const capability = nativeLaneSuppressionCapability(adapter);
      expect(capability, adapter).toBeDefined();
      expect(capability!.adapter).toBe(adapter);
      expect(capability!.schemaVersion).toBe(1);
      expect(capability!.runtimeVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(capability!.sources.length).toBeGreaterThan(0);
    }
    expect(nativeLaneSuppressionCapability("claude")!.runtimeVersion).toBe("2.1.222");
    expect(nativeLaneSuppressionCapability("codex")!.runtimeVersion).toBe("0.146.0");
    expect(nativeLaneSuppressionCapability("grok")!.runtimeVersion).toBe("0.2.118");
  });

  it("records measured instruction controls, not documentation wishful thinking", () => {
    const claude = nativeLaneSuppressionCapability("claude")!;
    expect(claude.surfaces.instructions.evidence).toBe("verified");
    expect(claude.surfaces.instructions.control).toBe("argv");
    expect(claude.surfaces.instructions.controlSpec).toContain("--setting-sources user");

    const codex = nativeLaneSuppressionCapability("codex")!;
    expect(codex.surfaces.instructions.evidence).toBe("verified");
    expect(codex.surfaces.instructions.control).toBe("config");
    expect(codex.surfaces.instructions.controlSpec).toContain("project_doc_max_bytes=0");

    const grok = nativeLaneSuppressionCapability("grok")!;
    expect(grok.surfaces.instructions.evidence).toBe("declared");
    expect(grok.surfaces.instructions.control).toBe("none");
  });

  it("lets no verified claim ship without a behavioral-test source", () => {
    assertLaneSuppressionEvidenceIsExplained();
    for (const [adapter, capability] of Object.entries(RUNTIME_NATIVE_LANE_SUPPRESSION_REGISTRY)) {
      const surfaces = [capability.surfaces.instructions, capability.surfaces.memory];
      const anyVerified =
        capability.evidence === "verified" ||
        surfaces.some((s) => isBehavioralLaneSuppressionEvidence(s.evidence) && s.evidence === "verified");
      if (!anyVerified) continue;
      expect(
        capability.sources.some((s) => s.kind === "behavioral-test"),
        `${adapter} verified without behavioral-test`,
      ).toBe(true);
    }
  });

  it("confirms codex after both required surfaces were behaviorally verified", () => {
    const codex = nativeLaneSuppressionCapability("codex")!;
    expect(codex.surfaces.instructions.evidence).toBe("verified");
    expect(nativeMemoryCapability("codex")?.evidence.disable).toBe("verified");
    expect(codex.surfaces.memory.controlSpec).toBe("--disable memories");
    expect(codex.evidence).toBe("verified");
    expect(isNativeSuppressionConfirmed("codex")).toBe(true);
  });

  it("refuses overall verified when instructions have no disable control", () => {
    const grok = nativeLaneSuppressionCapability("grok")!;
    expect(grok.surfaces.instructions.evidence).toBe("declared");
    expect(grok.evidence).toBe("declared");
    expect(isNativeSuppressionConfirmed("grok")).toBe(false);
  });

  it("confirms claude only when the combined gate is verified", () => {
    const claude = nativeLaneSuppressionCapability("claude")!;
    expect(claude.surfaces.instructions.evidence).toBe("verified");
    expect(claude.surfaces.memory.evidence).toBe("verified");
    expect(claude.evidence).toBe("verified");
    expect(isNativeSuppressionConfirmed("claude")).toBe(true);
  });

  it("fails closed for unknown adapters", () => {
    expect(isNativeSuppressionConfirmed("nope")).toBe(false);
    expect(nativeLaneSuppressionCapability("nope")).toBeUndefined();
  });

  it("rejects a forged overall verified with no behavioral source", () => {
    expect(() =>
      assertLaneSuppressionEvidenceIsExplained({
        forged: {
          schemaVersion: 1,
          adapter: "forged",
          runtimeVersion: "0.0.0",
          evidence: "verified",
          surfaces: {
            instructions: {
              evidence: "verified",
              control: "argv",
              controlSpec: "--fake",
              note: "forged",
            },
            memory: {
              evidence: "unsupported",
              control: "none",
              controlSpec: "",
              note: "none",
            },
          },
          sources: [{ kind: "runtime-doc", ref: "https://example.invalid" }],
        },
      }),
    ).toThrow(/behavioral-test/);
  });
});
