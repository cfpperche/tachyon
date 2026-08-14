import { describe, expect, it } from "vitest";
import {
  enforceModelProof,
  modelIdentifierSatisfies,
  resolveModelProof,
} from "@tachyon/engine/probe/modelProof.js";
import { statusForReason, type ProbeResult } from "@tachyon/engine/probe/taxonomy.js";

/**
 * SDD 473 / t-37fb51 — the recorded incidents this exists to prevent:
 *  - probe-66c1e789 and probe-42744006 asked for `claude-opus-5`; `modelUsage` proved
 *    `claude-haiku-4-5-20251001` actually ran.
 *  - probe-77505e6b asked for `claude-opus-5`, completed at $0.2126, and recorded no model at all.
 * A probe is read as evidence, so neither may present as a clean success.
 */

function okResult(): ProbeResult {
  return { reason: "ok", lastMessage: "answer", exitCode: 0, timedOut: false, native: { runtime: "claude" } };
}

describe("probe model proof — matching", () => {
  it("accepts an exact identifier and a dated release of the same family", () => {
    expect(modelIdentifierSatisfies("claude-opus-5", "claude-opus-5")).toBe(true);
    expect(modelIdentifierSatisfies("claude-opus-5", "claude-opus-5-20260101")).toBe(true);
    // case/whitespace are incidental, not evidence of a different model
    expect(modelIdentifierSatisfies(" Claude-Opus-5 ", "claude-opus-5")).toBe(true);
  });

  it("refuses a truncated alias and any different family", () => {
    // the dangerous one: plain prefix matching would call this proven.
    expect(modelIdentifierSatisfies("claude-opus", "claude-opus-5")).toBe(false);
    expect(modelIdentifierSatisfies("claude-opus-5", "claude-haiku-4-5-20251001")).toBe(false);
    expect(modelIdentifierSatisfies("claude-opus-5", "claude-opus-4")).toBe(false);
    expect(modelIdentifierSatisfies("claude-opus-5", "")).toBe(false);
  });
});

describe("probe model proof — verdict", () => {
  it("is not-requested when the caller named no model", () => {
    expect(resolveModelProof({ effective: ["claude-haiku-4-5-20251001"] }).verdict).toBe("not-requested");
  });

  it("is proven when every reported model satisfies the request", () => {
    const proof = resolveModelProof({
      requested: "claude-opus-5",
      effective: ["claude-opus-5-20260101"],
      effectiveCanonical: ["claude-opus-5"],
    });
    expect(proof.verdict).toBe("proven");
    expect(proof.effective).toEqual(["claude-opus-5-20260101"]);
    expect(proof.effectiveCanonical).toEqual(["claude-opus-5"]);
  });

  it("is mismatch for the recorded opus-requested/haiku-ran incident", () => {
    const proof = resolveModelProof({
      requested: "claude-opus-5",
      effective: ["claude-haiku-4-5-20251001"],
      effectiveCanonical: ["claude-haiku-4-5"],
    });
    expect(proof.verdict).toBe("mismatch");
  });

  it("is mismatch when the requested model ran alongside another one", () => {
    // a run that also used a different model is not clean proof the requested one answered.
    expect(resolveModelProof({
      requested: "claude-opus-5",
      effective: ["claude-opus-5-20260101", "claude-haiku-4-5-20251001"],
    }).verdict).toBe("mismatch");
  });

  it("is unproven when a model was requested and nothing was reported", () => {
    const proof = resolveModelProof({ requested: "claude-opus-5" });
    expect(proof.verdict).toBe("unproven");
    expect(proof.effective).toBeUndefined();
  });

  it("never treats empty or blank reports as proof", () => {
    expect(resolveModelProof({ requested: "claude-opus-5", effective: ["  "] }).verdict).toBe("unproven");
    expect(resolveModelProof({ requested: "claude-opus-5", effective: [] }).verdict).toBe("unproven");
  });
});

describe("probe model proof — enforcement", () => {
  it("fails a mismatch on any runtime and names both models", () => {
    const proof = resolveModelProof({
      requested: "claude-opus-5",
      effective: ["claude-haiku-4-5-20251001"],
    });
    const enforced = enforceModelProof(okResult(), proof, true);
    expect(enforced.reason).toBe("model_mismatch");
    expect(statusForReason(enforced.reason)).toBe("failed");
    expect(enforced.lastMessage).toContain("claude-opus-5");
    expect(enforced.lastMessage).toContain("claude-haiku-4-5-20251001");
    expect(enforced.modelProof?.verdict).toBe("mismatch");

    // a runtime that cannot report still fails a mismatch — the evidence is unambiguous.
    expect(enforceModelProof(okResult(), proof, false).reason).toBe("model_mismatch");
  });

  it("fails an unprovable explicit model on a runtime that CAN report", () => {
    const enforced = enforceModelProof(okResult(), resolveModelProof({ requested: "claude-opus-5" }), true);
    expect(enforced.reason).toBe("model_unproven");
    expect(statusForReason(enforced.reason)).toBe("failed");
    expect(enforced.modelProof?.verdict).toBe("unproven");
  });

  it("preserves the result on a runtime that cannot report, but marks it unproven", () => {
    // Codex/Grok surface no model usage; failing here would break working probes for no gain, but
    // the verdict must still make the result unusable as proof.
    const enforced = enforceModelProof(okResult(), resolveModelProof({ requested: "gpt-5.6" }), false);
    expect(enforced.reason).toBe("ok");
    expect(enforced.modelProof?.verdict).toBe("unproven");
  });

  it("keeps an already-failed reason instead of overwriting it", () => {
    const timedOut: ProbeResult = {
      reason: "timeout", lastMessage: "killed", exitCode: null, timedOut: true, native: { runtime: "claude" },
    };
    const enforced = enforceModelProof(timedOut, resolveModelProof({ requested: "claude-opus-5" }), true);
    expect(enforced.reason).toBe("timeout");
    expect(enforced.modelProof?.verdict).toBe("unproven");
  });

  it("leaves a run with no requested model completely alone", () => {
    const enforced = enforceModelProof(okResult(), resolveModelProof({}), true);
    expect(enforced.reason).toBe("ok");
    expect(enforced.modelProof?.verdict).toBe("not-requested");
  });

  it("completes a proven run normally", () => {
    const enforced = enforceModelProof(
      okResult(),
      resolveModelProof({ requested: "claude-opus-5", effective: ["claude-opus-5-20260101"] }),
      true,
    );
    expect(enforced.reason).toBe("ok");
    expect(statusForReason(enforced.reason)).toBe("completed");
    expect(enforced.modelProof?.verdict).toBe("proven");
  });
});
