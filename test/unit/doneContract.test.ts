import { describe, it, expect } from "vitest";
import { evaluateDone } from "@tachyon/engine/pipeline/doneContract.js";

describe("evaluateDone — exit", () => {
  it("pending until the process exits", () => {
    expect(evaluateDone("exit", {})).toEqual({ status: "pending", waitingFor: "process exit" });
  });
  it("done on exit 0", () => {
    expect(evaluateDone("exit", { exitCode: 0 })).toEqual({ status: "done" });
  });
  it("failed on non-zero exit", () => {
    expect(evaluateDone("exit", { exitCode: 2 })).toEqual({ status: "failed", reason: "exited with code 2" });
  });
});

describe("evaluateDone — signal", () => {
  it("pending until signalled", () => {
    expect(evaluateDone("signal", {})).toEqual({ status: "pending", waitingFor: "complete_node signal" });
  });
  it("done when signalled", () => {
    expect(evaluateDone("signal", { signalled: true })).toEqual({ status: "done" });
  });
  it("FAILS CLOSED when the session ends without signalling", () => {
    expect(evaluateDone("signal", { exited: true })).toEqual({
      status: "failed",
      reason: "session ended without signalling completion",
    });
  });
});

describe("evaluateDone — timeout overrides everything", () => {
  it("a timed-out node fails regardless of other signals", () => {
    expect(evaluateDone("signal", { timedOut: true, signalled: true })).toEqual({
      status: "failed",
      reason: "timed out",
    });
  });
});
