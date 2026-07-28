import { describe, expect, it } from "vitest";
import {
  ENGINE_SHELL_PROTOCOL,
  type EngineProtocolRangeV1,
} from "../../src/engine-service/protocol.js";

/**
 * Last released wire contract before 0.56.110. Keep this fixture immutable: it is the N-1 side of
 * the release gate, not another spelling of the current constant.
 */
const RELEASE_0_56_109_PROTOCOL: EngineProtocolRangeV1 = { min: 3, max: 3 };

describe("engine cross-release compatibility", () => {
  it("refuses the 0.56.109 wire contract after the required Probe row fields changed", () => {
    const current = { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL };
    expect(current).toEqual({ min: 4, max: 4 });
    const overlaps = RELEASE_0_56_109_PROTOCOL.min <= current.max
      && current.min <= RELEASE_0_56_109_PROTOCOL.max;
    expect(overlaps).toBe(false);
  });
});
