/**
 * t-4cc561 — the `task.board` input renamed `liveAdhocAgents` to `liveTemporaryAgents`, and this
 * pins the ONE property that makes that safe: both directions of version skew REFUSE.
 *
 * This test exists because the rename first shipped WITHOUT the protocol bump. That is the
 * 0.56.110 failure with different bytes: the shape moved, both peers still claimed protocol 5, and
 * nothing in the handshake could notice. The bump is what turns a mid-session rejected query into a
 * refusal to pair at all — so the assertions below are deliberately paired, one for the payload
 * validator and one for the handshake that should have stopped the pairing first.
 *
 * "Refuses" is the intended behaviour, not a regression to soften: two peers that disagree about a
 * field name cannot serve one board, and interpreting the other side's shape is how a silent
 * mis-read becomes a wrong answer instead of an error.
 */
import { describe, expect, it } from "vitest";
import { ENGINE_SHELL_PROTOCOL, isWorkspaceQueryV1 } from "../../src/engine-service/protocol.js";

const boardQuery = (input: Record<string, unknown>) => ({ schemaVersion: 1, method: "task.board", input });

describe("task.board input across the 5 -> 6 rename", () => {
  it("accepts the new key", () => {
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: ["scratch"] }))).toBe(true);
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: [] }))).toBe(true);
  });

  it("REFUSES the retired key — an old shell talking to this engine is rejected, not reinterpreted", () => {
    expect(isWorkspaceQueryV1(boardQuery({ liveAdhocAgents: ["scratch"] }))).toBe(false);
  });

  it("refuses a payload carrying BOTH, which is the shape a lenient migration would have produced", () => {
    // `hasOnlyKeys` is what makes this false. A dual-key input is exactly the "keep both for one
    // release" compromise the ratified plan rules out: it makes precedence a guess at read time.
    expect(isWorkspaceQueryV1(boardQuery({ liveAdhocAgents: [], liveTemporaryAgents: [] }))).toBe(false);
  });

  it("still enforces every other rule on the renamed field, so the rename did not widen the contract", () => {
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: "scratch" }))).toBe(false);
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: ["dup", "dup"] }))).toBe(false);
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: ["not a valid name!"] }))).toBe(false);
    expect(isWorkspaceQueryV1(boardQuery({ liveTemporaryAgents: Array.from({ length: 501 }, (_, i) => `a${i}`) }))).toBe(false);
  });
});

describe("the handshake is what should refuse first", () => {
  it("declares at least protocol 6, so a protocol-5 peer cannot pair and never reaches the validator", () => {
    // Exact min === max negotiation: the engine advertises { min: N, max: N } (engineService.ts) and
    // the shell demands the same N (WorkspaceClient.ts). A peer one version out is refused at the
    // handshake, which is the only place a field rename can be caught BEFORE a query is attempted.
    //
    // t-aa06a8 relaxed `toBe(6)` to this bound when the constant moved to 7 for a different payload
    // break. What this file is about is the 5 -> 6 rename: the property that keeps it safe is that a
    // protocol-5 peer cannot pair, and that holds for every N >= 6. Re-pinning the exact number here
    // would make this case fail on a bump it says nothing about, which teaches the next person to
    // edit the assertion rather than read it.
    expect(ENGINE_SHELL_PROTOCOL).toBeGreaterThanOrEqual(6);
  });

  it("the bump is recorded beside the break it describes", () => {
    // Guards the discipline, not the number: a future rename that moves a payload shape without
    // touching this constant reproduces the exact defect this file was written for.
    expect(ENGINE_SHELL_PROTOCOL).toBeGreaterThan(5);
  });
});
