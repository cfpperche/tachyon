import { describe, it, expect } from "vitest";
import { isContainedRelPath, isSafePluginRoot, checkContainedRelPath } from "../../src/plugins/paths.js";

describe("isContainedRelPath", () => {
  it("accepts contained relative paths, including hyphenated kebab segments", () => {
    expect(isContainedRelPath(".tachyon/plugins/my-plugin/claude")).toBe(true);
    expect(isContainedRelPath("claude/")).toBe(true);
    expect(isContainedRelPath("a/b/c")).toBe(true);
    expect(isContainedRelPath("foo..bar")).toBe(true); // a literal name with dots is fine; only a '..' SEGMENT escapes
  });

  it("rejects escapes / absolutes / platform separators / control chars", () => {
    expect(isContainedRelPath("/abs")).toBe(false);
    expect(isContainedRelPath("../escape")).toBe(false);
    expect(isContainedRelPath("a/../b")).toBe(false);
    expect(isContainedRelPath("C:\\tmp")).toBe(false);
    expect(isContainedRelPath("a\\b")).toBe(false);
    expect(isContainedRelPath("a/\0/b")).toBe(false);
    expect(isContainedRelPath("")).toBe(false);
  });

  it("surfaces a reason on failure", () => {
    expect(checkContainedRelPath("/abs").reason).toMatch(/must be relative/);
  });
});

describe("isSafePluginRoot", () => {
  it("accepts a generated hyphenated plugin root (the CONTROL_RE hyphen bug regression)", () => {
    expect(isSafePluginRoot(".tachyon/plugins/my-plugin/claude")).toBe(true);
    expect(isSafePluginRoot(".tachyon/plugins/sdd/claude")).toBe(true);
  });

  it("rejects whitespace and shell metacharacters", () => {
    expect(isSafePluginRoot("has space")).toBe(false);
    expect(isSafePluginRoot("a$b")).toBe(false);
    expect(isSafePluginRoot("a;b")).toBe(false);
    expect(isSafePluginRoot("../escape")).toBe(false);
  });
});
