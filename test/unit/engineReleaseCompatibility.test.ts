import { describe, expect, it } from "vitest";
import {
  ENGINE_SHELL_PROTOCOL,
  negotiateEngineShellProtocol,
  type EngineProtocolRangeV1,
} from "@tachyon/engine/engine-service/protocol.js";

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

/**
 * `t-4cc561` — protocol 5, the last release before the `task.board` input renamed `liveAdhocAgents`
 * to `liveTemporaryAgents`. Literal for the same reason as its neighbours above: derived fixtures
 * pass forever and test nothing.
 */
const RELEASE_PRE_BOARD_RENAME_PROTOCOL: EngineProtocolRangeV1 = { min: 5, max: 5 };

/**
 * `t-aa06a8` — protocol 6, the last release before `WorkspaceStudioFormV1` dropped the seven
 * `harness*` fields with the Agent Studio authoring door. Literal, like its neighbours.
 */
const RELEASE_PRE_HARNESS_FORM_PROTOCOL: EngineProtocolRangeV1 = { min: 6, max: 6 };

const CURRENT: EngineProtocolRangeV1 = { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL };

describe("engine cross-release compatibility", () => {
  it("refuses the 0.56.109 wire contract after the required Probe row fields changed", () => {
    // t-aa06a8 removed an `expect(CURRENT).toEqual({ min: 6, max: 6 })` that sat here: this case is
    // about not overlapping the protocol-3 fixture, and re-pinning the current constant inside it
    // added nothing to that claim while breaking on a bump the case says nothing about. The constant
    // is still pinned where it belongs — beside the break that moved it, one fixture per release.
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

  /**
   * `t-4cc561` — the payload-shape break. A protocol-5 peer names the board input `liveAdhocAgents`
   * and a protocol-6 peer names it `liveTemporaryAgents`; the validator is `hasOnlyKeys`, so each
   * REFUSES the other's shape. That refusal must happen at the handshake rather than at the first
   * board query, which is what this pair pins.
   *
   * The rename shipped once without this bump. Nothing failed, because nothing could: both peers
   * still claimed 5 while disagreeing about a field name.
   */
  it("refuses BOTH directions across the board-input rename: 5 ↔ 6", () => {
    expect(negotiateEngineShellProtocol(RELEASE_PRE_BOARD_RENAME_PROTOCOL, CURRENT)).toBeUndefined();
    expect(negotiateEngineShellProtocol(CURRENT, RELEASE_PRE_BOARD_RENAME_PROTOCOL)).toBeUndefined();
  });

  /**
   * `t-aa06a8` — the second payload-shape break, and the same shape as the rename above: the seven
   * `harness*` fields left `WorkspaceStudioFormV1`, whose validator is `hasOnlyKeys`, so a protocol-6
   * peer's submit is refused here and this build's submit is refused there. The fields were only ever
   * meaningful for `kind: agent`, whose domain arm is already retired — but a protocol-6 CLIENT
   * canonicalizes them onto every terminal/command/runbook submit too, so the break is real.
   */
  it("refuses BOTH directions across the studio-form field removal: 6 ↔ 7", () => {
    expect(negotiateEngineShellProtocol(RELEASE_PRE_HARNESS_FORM_PROTOCOL, CURRENT)).toBeUndefined();
    expect(negotiateEngineShellProtocol(CURRENT, RELEASE_PRE_HARNESS_FORM_PROTOCOL)).toBeUndefined();
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
    expect(RELEASE_PRE_BOARD_RENAME_PROTOCOL).toEqual({ min: 5, max: 5 });
    expect(RELEASE_PRE_BOARD_RENAME_PROTOCOL.max).toBeLessThan(ENGINE_SHELL_PROTOCOL);
    expect(RELEASE_PRE_HARNESS_FORM_PROTOCOL).toEqual({ min: 6, max: 6 });
    expect(RELEASE_PRE_HARNESS_FORM_PROTOCOL.max).toBeLessThan(ENGINE_SHELL_PROTOCOL);
  });
});
