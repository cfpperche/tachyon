import { describe, it, expect } from "vitest";
import { parseNameStatus, mergeChanges, emptySides, baseSidePath, diffTitle } from "@tachyon/engine/worktree/review.js";

describe("worktree diff-review — pure helpers (spec 213)", () => {
  it("parseNameStatus handles A/M/D/T and rename/copy from -z NUL output (incl. a path with a space)", () => {
    // `git diff --name-status -z`: status\0path\0 ; rename/copy: R###\0old\0new\0
    const out = "M\0src/a.ts\0A\0docs/my notes.md\0D\0old.ts\0T\0link.ts\0R096\0src/old.ts\0src/new.ts\0C075\0lib/x.ts\0lib/copy.ts\0";
    expect(parseNameStatus(out)).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "docs/my notes.md" }, // space survives (no quoting under -z)
      { status: "D", path: "old.ts" },
      { status: "T", path: "link.ts" },
      { status: "R", from: "src/old.ts", path: "src/new.ts" },
      { status: "C", from: "lib/x.ts", path: "lib/copy.ts" },
    ]);
  });

  it("parseNameStatus ignores an unexpected leading token without misaligning", () => {
    expect(parseNameStatus("\0M\0ok.ts\0")).toEqual([{ status: "M", path: "ok.ts" }]);
  });

  it("mergeChanges unions untracked (NUL list) as added, dedups (tracked wins), sorts", () => {
    const tracked = [
      { status: "M" as const, path: "b.ts" },
      { status: "A" as const, path: "a.ts" },
    ];
    const merged = mergeChanges(tracked, "z-untracked.ts\0b.ts\0c-new.ts\0");
    expect(merged).toEqual([
      { status: "A", path: "a.ts" },
      { status: "M", path: "b.ts" }, // tracked 'M' kept over untracked dup
      { status: "A", path: "c-new.ts" },
      { status: "A", path: "z-untracked.ts" },
    ]);
  });

  it("emptySides: added → empty base; deleted → empty current; modified → neither", () => {
    expect(emptySides("A")).toEqual({ baseEmpty: true, currentEmpty: false });
    expect(emptySides("D")).toEqual({ baseEmpty: false, currentEmpty: true });
    expect(emptySides("M")).toEqual({ baseEmpty: false, currentEmpty: false });
  });

  it("baseSidePath uses the pre-image for a rename, else the path", () => {
    expect(baseSidePath({ status: "R", from: "old.ts", path: "new.ts" })).toBe("old.ts");
    expect(baseSidePath({ status: "M", path: "a.ts" })).toBe("a.ts");
  });

  it("diffTitle shortens the ref and shows old→new for renames", () => {
    expect(diffTitle({ status: "M", path: "src/a.ts" }, "abc1234567")).toBe("src/a.ts (abc12345 ↔ worktree)");
    expect(diffTitle({ status: "R", from: "old.ts", path: "new.ts" }, "deadbeef")).toBe("old.ts → new.ts (deadbeef ↔ worktree)");
  });
});
