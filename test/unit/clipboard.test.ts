import { describe, it, expect } from "vitest";
import { resolveClipboardHelper } from "../../src/tmux/clipboard.js";

describe("resolveClipboardHelper (spec 219) — wire only when a tool is detected, else null (OSC 52)", () => {
  it("opted out (clipboard: off) → null, regardless of tool presence", () => {
    expect(resolveClipboardHelper({ clipboardOff: true, helperPath: "/h.sh", check: () => true })).toBeNull();
  });

  it("auto + a clipboard tool present (--check ok) → the helper path", () => {
    expect(resolveClipboardHelper({ clipboardOff: false, helperPath: "/h.sh", check: () => true })).toBe("/h.sh");
  });

  it("auto + no tool (--check fails) → null (TmuxService then restores OSC 52 — no silent failure)", () => {
    expect(resolveClipboardHelper({ clipboardOff: false, helperPath: "/h.sh", check: () => false })).toBeNull();
  });
});
