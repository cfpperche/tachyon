import { describe, it, expect } from "vitest";
import { validateCompleteNode, type NodeAuthState, type NodeAuthLookup } from "../../src/pipeline/completeNode.js";

function lookupOf(state: NodeAuthState | null): NodeAuthLookup {
  return (runId, nodeId) => (runId === "run-1" && nodeId === "implement" ? state : null);
}

const RUNNING: NodeAuthState = { nonce: "secret-abc", status: "running", alreadySignalled: false };

describe("validateCompleteNode (codex M1 auth)", () => {
  const input = { runId: "run-1", nodeId: "implement", nonce: "secret-abc" };

  it("accepts a running node with the correct nonce", () => {
    expect(validateCompleteNode(input, lookupOf(RUNNING))).toEqual({ ok: true });
  });

  it("rejects an unknown / closed run or node", () => {
    expect(validateCompleteNode(input, lookupOf(null))).toEqual({ ok: false, reason: "unknown or closed pipeline run/node" });
    expect(validateCompleteNode({ ...input, runId: "ghost" }, lookupOf(RUNNING))).toMatchObject({ ok: false });
    expect(validateCompleteNode({ ...input, nodeId: "ghost" }, lookupOf(RUNNING))).toMatchObject({ ok: false });
  });

  it("rejects a bad nonce (constant-time)", () => {
    expect(validateCompleteNode({ ...input, nonce: "wrong" }, lookupOf(RUNNING))).toEqual({ ok: false, reason: "invalid completion token" });
    expect(validateCompleteNode({ ...input, nonce: "" }, lookupOf(RUNNING))).toMatchObject({ ok: false, reason: "invalid completion token" });
  });

  it("does not reveal node status to a caller with a bad nonce (nonce checked before status)", () => {
    const done: NodeAuthState = { ...RUNNING, status: "done" };
    // bad nonce on a done node → token error, NOT a status error
    expect(validateCompleteNode({ ...input, nonce: "wrong" }, lookupOf(done))).toEqual({ ok: false, reason: "invalid completion token" });
  });

  it("rejects a node that is not running", () => {
    const pending: NodeAuthState = { ...RUNNING, status: "pending" };
    expect(validateCompleteNode(input, lookupOf(pending))).toEqual({ ok: false, reason: "node is 'pending', not awaiting completion" });
  });

  it("rejects a duplicate signal", () => {
    const dup: NodeAuthState = { ...RUNNING, alreadySignalled: true };
    expect(validateCompleteNode(input, lookupOf(dup))).toEqual({ ok: false, reason: "node already signalled completion" });
  });
});
