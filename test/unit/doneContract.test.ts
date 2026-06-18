import { describe, it, expect } from "vitest";
import { evaluateDone } from "../../src/pipeline/doneContract.js";

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

describe("evaluateDone — signal_then_verify (the agent default)", () => {
  it("waits for the signal first", () => {
    expect(evaluateDone("signal_then_verify", {})).toMatchObject({ status: "pending", waitingFor: "complete_node signal" });
  });
  it("after signal, waits for the verify gate", () => {
    expect(evaluateDone("signal_then_verify", { signalled: true })).toEqual({ status: "pending", waitingFor: "verify gate" });
  });
  it("done only when verify passed and not stale", () => {
    expect(evaluateDone("signal_then_verify", { signalled: true, verify: { passed: true, stale: false } })).toEqual({ status: "done" });
  });
  it("failed when verify is red", () => {
    expect(evaluateDone("signal_then_verify", { signalled: true, verify: { passed: false, stale: false } })).toEqual({
      status: "failed",
      reason: "verify gate red",
    });
  });
  it("failed when verify is stale (no-op diff)", () => {
    expect(evaluateDone("signal_then_verify", { signalled: true, verify: { passed: true, stale: true } })).toEqual({
      status: "failed",
      reason: "verify stale (no-op diff)",
    });
  });
  it("fails closed if the session ends before signalling, even pre-verify", () => {
    expect(evaluateDone("signal_then_verify", { exited: true })).toMatchObject({ status: "failed" });
  });
});

describe("evaluateDone — exit_then_verify", () => {
  it("non-zero exit short-circuits to failed (no verify)", () => {
    expect(evaluateDone("exit_then_verify", { exitCode: 1 })).toEqual({ status: "failed", reason: "exited with code 1" });
  });
  it("exit 0 then waits for verify, then done", () => {
    expect(evaluateDone("exit_then_verify", { exitCode: 0 })).toEqual({ status: "pending", waitingFor: "verify gate" });
    expect(evaluateDone("exit_then_verify", { exitCode: 0, verify: { passed: true, stale: false } })).toEqual({ status: "done" });
  });
});

describe("evaluateDone — timeout overrides everything", () => {
  it("a timed-out node fails regardless of other signals", () => {
    expect(evaluateDone("signal_then_verify", { timedOut: true, signalled: true, verify: { passed: true, stale: false } })).toEqual({
      status: "failed",
      reason: "timed out",
    });
  });
});
