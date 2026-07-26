import { describe, it, expect } from "vitest";
import {
  ALL_TERMINATION_REASONS,
  envelopeFor,
  isError,
  isOk,
  runningEnvelope,
  statusForReason,
  type ProbeResult,
  type TerminationReason,
} from "../../src/probe/taxonomy.js";

/** A minimal valid result for a given reason — every other field plausible-but-fixed. */
function resultFor(reason: TerminationReason): ProbeResult {
  return {
    reason,
    lastMessage: `message for ${reason}`,
    exitCode: reason === "timeout" || reason === "killed_signal" ? null : 0,
    timedOut: reason === "timeout",
    native: { runtime: "claude" },
  };
}

describe("probe taxonomy — reasons are distinct, none collapse", () => {
  it("declares exactly the eleven reasons, no duplicates", () => {
    // SDD 473 added model_mismatch/model_unproven — a probe used as evidence must be able to fail
    // for "the wrong model answered" and "no model could be proven".
    expect(ALL_TERMINATION_REASONS).toHaveLength(11);
    expect(new Set(ALL_TERMINATION_REASONS).size).toBe(11);
  });

  it("maps ONLY a clean answer to completed; every non-ok reason is failed (codex review #23)", () => {
    for (const reason of ALL_TERMINATION_REASONS) {
      expect(statusForReason(reason)).toBe(reason === "ok" ? "completed" : "failed");
    }
  });

  it("does NOT collapse the failure classes onto one another — each non-ok reason stays distinct", () => {
    const seen = ALL_TERMINATION_REASONS.map((r) => ({ reason: r, status: statusForReason(r) }));
    const failures = seen.filter((s) => s.status === "failed").map((s) => s.reason);
    expect(failures).toEqual([
      "model_error", "refused", "budget", "timeout", "killed_signal", "process_error", "parse_error",
      "empty_output", "model_mismatch", "model_unproven",
    ]);
  });
});

describe("probe taxonomy — classifiers", () => {
  it("isOk is true only for ok; isError is its complement", () => {
    for (const reason of ALL_TERMINATION_REASONS) {
      const r = resultFor(reason);
      expect(isOk(r)).toBe(reason === "ok");
      expect(isError(r)).toBe(reason !== "ok");
    }
  });
});

describe("probe taxonomy — stable envelope (D3)", () => {
  it("envelopeFor derives status from the reason and carries the result", () => {
    const okEnv = envelopeFor("run-1", resultFor("ok"));
    expect(okEnv).toEqual({ runId: "run-1", status: "completed", result: expect.objectContaining({ reason: "ok" }) });
    // a budget result is a terminal answer but NOT a clean success → failed (the caller checks reason)
    const budgetEnv = envelopeFor("run-1b", resultFor("budget"));
    expect(budgetEnv.status).toBe("failed");
    expect(budgetEnv.result?.reason).toBe("budget");
  });

  it("a failed reason yields status failed with the result still attached", () => {
    const env = envelopeFor("run-2", resultFor("timeout"));
    expect(env.status).toBe("failed");
    expect(env.result?.reason).toBe("timeout");
    expect(env.result?.timedOut).toBe(true);
    expect(env.result?.exitCode).toBeNull();
  });

  it("a running envelope has the same shape with no result", () => {
    const env = runningEnvelope("run-3");
    expect(env).toEqual({ runId: "run-3", status: "running" });
    expect(env.result).toBeUndefined();
  });
});
