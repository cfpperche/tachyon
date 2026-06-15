import { describe, it, expect } from "vitest";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

describe("tmuxChildEnv (spec 218) — strip $TMUX so an unscoped tmux op can't hit production", () => {
  it("removes TMUX and TMUX_PANE, preserves everything else", () => {
    expect(tmuxChildEnv({ TMUX: "/tmp/tmux-1000/tachyon,123,1", TMUX_PANE: "%3", FOO: "1", HOME: "/h" })).toEqual({
      FOO: "1",
      HOME: "/h",
    });
  });

  it("is a no-op shape when neither is set", () => {
    expect(tmuxChildEnv({ FOO: "1" })).toEqual({ FOO: "1" });
  });

  it("does not mutate the input", () => {
    const base = { TMUX: "x", FOO: "1" };
    tmuxChildEnv(base);
    expect(base).toEqual({ TMUX: "x", FOO: "1" });
  });
});
