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
  it("declares exactly the nine reasons, no duplicates", () => {
    expect(ALL_TERMINATION_REASONS).toHaveLength(9);
    expect(new Set(ALL_TERMINATION_REASONS).size).toBe(9);
  });

  it("maps each reason to a deterministic terminal status — completed iff the model answered", () => {
    const completed = new Set<TerminationReason>(["ok", "model_error", "refused", "budget"]);
    for (const reason of ALL_TERMINATION_REASONS) {
      expect(statusForReason(reason)).toBe(completed.has(reason) ? "completed" : "failed");
    }
  });

  it("does NOT collapse the failure classes onto one another", () => {
    // budget != timeout != killed_signal != process_error != parse_error != empty_output — distinct
    // reasons round-trip through the result, each carrying its own status.
    const seen = ALL_TERMINATION_REASONS.map((r) => ({ reason: r, status: statusForReason(r) }));
    const failures = seen.filter((s) => s.status === "failed").map((s) => s.reason);
    expect(failures).toEqual(["timeout", "killed_signal", "process_error", "parse_error", "empty_output"]);
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
    const env = envelopeFor("run-1", resultFor("budget"));
    expect(env).toEqual({
      runId: "run-1",
      status: "completed",
      result: expect.objectContaining({ reason: "budget" }),
    });
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
