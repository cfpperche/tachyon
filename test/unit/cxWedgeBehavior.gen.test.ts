import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("no synchronous child_process runs in the bridge/tmux/attention hot path and tmux ops time out with child cancellation", () => {
    expect.fail("delegation not implemented yet");
  });
});
