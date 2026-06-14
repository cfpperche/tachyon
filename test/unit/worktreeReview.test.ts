import { describe, it, expect } from "vitest";
import { parseNameStatus, mergeChanges, emptySides, baseSidePath, diffTitle } from "../../src/worktree/review.js";

describe("worktree diff-review — pure helpers (spec 213)", () => {
  it("parseNameStatus handles A/M/D and rename/copy (old→new, keeps new as path)", () => {
    const out = "M\tsrc/a.ts\nA\tnew.ts\nD\told.ts\nR096\tsrc/old.ts\tsrc/new.ts\nC075\tlib/x.ts\tlib/copy.ts\n";
    expect(parseNameStatus(out)).toEqual([
      { status: "M", path: "src/a.ts" },
      { status: "A", path: "new.ts" },
      { status: "D", path: "old.ts" },
      { status: "R", from: "src/old.ts", path: "src/new.ts" },
      { status: "C", from: "lib/x.ts", path: "lib/copy.ts" },
    ]);
  });

  it("parseNameStatus skips blank/garbage lines", () => {
    expect(parseNameStatus("\n  \nX\tweird\nM\tok.ts\n")).toEqual([{ status: "M", path: "ok.ts" }]);
  });

  it("mergeChanges unions untracked as added, dedups (tracked wins), sorts", () => {
    const tracked = [
      { status: "M" as const, path: "b.ts" },
      { status: "A" as const, path: "a.ts" },
    ];
    const merged = mergeChanges(tracked, "z-untracked.ts\nb.ts\n\n  \nc-new.ts\n");
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
