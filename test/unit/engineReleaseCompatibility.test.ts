import { describe, expect, it } from "vitest";
import {
  ENGINE_SHELL_PROTOCOL,
  negotiateEngineShellProtocol,
  type EngineProtocolRangeV1,
} from "../../src/engine-service/protocol.js";

/**
 * Last released wire contract before 0.56.110. Keep this fixture immutable: it is the N-1 side of
 * the release gate, not another spelling of the current constant.
 */
const RELEASE_0_56_109_PROTOCOL: EngineProtocolRangeV1 = { min: 3, max: 3 };

/**
 * The contract shipped before the Agent Instance cut (`t-fab832`). Also immutable, and deliberately
 * NOT written as `ENGINE_SHELL_PROTOCOL - 1`: a fixture derived from the current constant moves when
 * the constant moves, which is exactly the property a compatibility fixture must not have.
 */
const RELEASE_PRE_CUT_PROTOCOL: EngineProtocolRangeV1 = { min: 4, max: 4 };

const CURRENT: EngineProtocolRangeV1 = { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL };

describe("engine cross-release compatibility", () => {
  it("refuses the 0.56.109 wire contract after the required Probe row fields changed", () => {
    expect(CURRENT).toEqual({ min: 5, max: 5 });
    const overlaps = RELEASE_0_56_109_PROTOCOL.min <= CURRENT.max
      && CURRENT.min <= RELEASE_0_56_109_PROTOCOL.max;
    expect(overlaps).toBe(false);
  });

  /**
   * `t-fab832` — the cut's break is BEHAVIOURAL rather than a payload shape, which is precisely why
   * this pair has to be tested. A protocol-5 engine REFUSES to activate a workspace still holding
   * retired-species state; a protocol-4 peer activates it and reads that state under the old rules.
   * Two peers that disagree about whether a workspace is even activatable must not pair.
   *
   * Both directions, because a bump tested only forward is half-tested, and the two fail in different
   * places: one is a current shell meeting an old engine, the other an old shell meeting a new engine
   * — and only the second is the D2 downgrade shape.
   */
  it("refuses BOTH directions across the cut: current client ↔ pre-cut engine, and the reverse", () => {
    // current shell → pre-cut engine
    expect(negotiateEngineShellProtocol(RELEASE_PRE_CUT_PROTOCOL, CURRENT)).toBeUndefined();
    // pre-cut shell → current engine
    expect(negotiateEngineShellProtocol(CURRENT, RELEASE_PRE_CUT_PROTOCOL)).toBeUndefined();
  });

  it("still pairs a peer that agrees exactly, so the gate is a gate and not a wall", () => {
    expect(negotiateEngineShellProtocol(CURRENT, CURRENT)).toBe(ENGINE_SHELL_PROTOCOL);
  });

  /**
   * The fixtures must never be re-derived from the constant. If someone "fixes" a failing
   * compatibility test by rewriting a fixture as `ENGINE_SHELL_PROTOCOL - 1`, every future bump would
   * keep passing while testing nothing.
   */
  it("keeps its N-1 fixtures literal, not derived from the current constant", () => {
    expect(RELEASE_0_56_109_PROTOCOL).toEqual({ min: 3, max: 3 });
    expect(RELEASE_PRE_CUT_PROTOCOL).toEqual({ min: 4, max: 4 });
    expect(RELEASE_PRE_CUT_PROTOCOL.max).toBeLessThan(ENGINE_SHELL_PROTOCOL);
  });
});
