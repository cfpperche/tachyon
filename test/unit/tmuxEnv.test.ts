import { describe, it, expect } from "vitest";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

describe("tmuxChildEnv (spec 218) — strip $TMUX so an unscoped tmux op can't hit production", () => {
  it("removes TMUX and TMUX_PANE, preserves everything else, and forces UTF-8 when base has none", () => {
    // Empty base → utf8LocaleEnv forces C.UTF-8 (linux) / en_US.UTF-8 (darwin); assert shape not platform.
    const out = tmuxChildEnv({ TMUX: "/tmp/tmux-1000/tachyon,123,1", TMUX_PANE: "%3", FOO: "1", HOME: "/h" });
    expect(out.FOO).toBe("1");
    expect(out.HOME).toBe("/h");
    expect(out.TMUX).toBeUndefined();
    expect(out.TMUX_PANE).toBeUndefined();
    expect(out.LANG).toMatch(/utf-?8/i);
    expect(out.LC_ALL).toMatch(/utf-?8/i);
  });

  it("is a no-op on TMUX when neither is set and base already has UTF-8", () => {
    expect(tmuxChildEnv({ FOO: "1", LANG: "C.UTF-8" })).toEqual({ FOO: "1", LANG: "C.UTF-8" });
  });

  it("does not mutate the input", () => {
    const base = { TMUX: "x", FOO: "1", LANG: "C.UTF-8" };
    tmuxChildEnv(base);
    expect(base).toEqual({ TMUX: "x", FOO: "1", LANG: "C.UTF-8" });
  });

  it("t-86f3e6: LC_ALL=C is overwritten so the child cannot keep 8-bit ctype", () => {
    const out = tmuxChildEnv({ LANG: "C", LC_ALL: "C", LC_CTYPE: "C", FOO: "1" });
    expect(out.FOO).toBe("1");
    expect(out.LC_ALL).toMatch(/utf-?8/i);
    expect(out.LANG).toMatch(/utf-?8/i);
    expect(out.LC_CTYPE).toMatch(/utf-?8/i);
  });
});
