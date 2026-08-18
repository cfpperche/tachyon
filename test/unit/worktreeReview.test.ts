import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  parseNameStatus,
  mergeChanges,
  emptySides,
  baseSidePath,
  diffTitle,
  parseUnifiedDiff,
  unifiedDiffFromAddedFile,
} from "@tachyon/engine/worktree/review.js";

const DELETED_COMMIT = "55de2fc4";
const DELETED_PATH = "packages/engine/src/commands/CommandRunner.ts";
const LARGE_COMMIT = "2778ccc4";
const LARGE_PATH = "packages/engine/src/workspace/Workspace.ts";

function gitDiff(rev: string, path: string): string {
  return execFileSync("git", ["diff", `${rev}^`, rev, "--", path], { encoding: "utf8" });
}

function rawHunkLines(diff: string): { kind: "context" | "add" | "del"; text: string }[] {
  const lines: { kind: "context" | "add" | "del"; text: string }[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line.startsWith("\\") || line.length === 0) continue;
    if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) lines.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) lines.push({ kind: "context", text: line.slice(1) });
  }
  return lines;
}

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

describe("t-e968c1 — unified hunk parser (SDD 513 fatia 1)", () => {
  it("parses a modified hunk with context, add, and del, including an omitted old count", () => {
    const out = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+extra",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(out);
    expect(parsed).toEqual({
      path: "src/a.ts",
      status: "M",
      binary: false,
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        header: "",
        lines: [
          { kind: "del", text: "old", oldLine: 1, newLine: null },
          { kind: "add", text: "new", oldLine: null, newLine: 1 },
          { kind: "add", text: "extra", oldLine: null, newLine: 2 },
        ],
      }],
    });
  });

  it("marks a missing trailing newline on the preceding line and keeps the text intact", () => {
    const out = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(out);
    expect(parsed.hunks[0]?.lines).toEqual([
      { kind: "del", text: "old", oldLine: 1, newLine: null, noNewline: true },
      { kind: "add", text: "new", oldLine: null, newLine: 1, noNewline: true },
    ]);
  });

  it("reads a quoted path with a space and a rename header", () => {
    const out = [
      "diff --git \"a/old name.ts\" \"b/new name.ts\"",
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      "--- \"a/old name.ts\"",
      "+++ \"b/new name.ts\"",
      "@@ -1,1 +1,1 @@ fn",
      "-a",
      "+b",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(out);
    expect(parsed.status).toBe("R");
    expect(parsed.path).toBe("new name.ts");
    expect(parsed.from).toBe("old name.ts");
    expect(parsed.hunks[0]?.header).toBe("fn");
  });

  it("sets binary and drops patch bytes so a consumer never treats them as lines", () => {
    const out = [
      "diff --git a/foo.bin b/foo.bin",
      "index 1111111..2222222",
      "Binary files a/foo.bin and b/foo.bin differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(out)).toEqual({
      path: "foo.bin",
      status: "M",
      binary: true,
      hunks: [],
    });
  });

  it("returns an empty one-file result for empty stdout (mode-only / identical)", () => {
    expect(parseUnifiedDiff("")).toEqual({ path: "", status: "M", binary: false, hunks: [] });
  });

  it("refuses a second file instead of dropping it", () => {
    const out = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    expect(() => parseUnifiedDiff(out)).toThrow(/more than one file/);
  });

  it("feeds an untracked file through the same parser as an all-add hunk", () => {
    const parsed = parseUnifiedDiff(unifiedDiffFromAddedFile("src/new.ts", "alpha\nbeta\n"));
    expect(parsed.status).toBe("A");
    expect(parsed.path).toBe("src/new.ts");
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]?.lines).toEqual([
      { kind: "add", text: "alpha", oldLine: null, newLine: 1 },
      { kind: "add", text: "beta", oldLine: null, newLine: 2 },
    ]);
  });

  it("parses a real deleted file from this tree (55de2fc4 CommandRunner.ts) as D + del", () => {
    const diff = gitDiff(DELETED_COMMIT, DELETED_PATH);
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.status).toBe("D");
    expect(parsed.path).toBe(DELETED_PATH);
    expect(parsed.binary).toBe(false);
    expect(parsed.hunks.length).toBeGreaterThan(0);
    const lines = parsed.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.length).toBe(165);
    expect(lines.every((line) => line.kind === "del" && line.newLine === null)).toBe(true);
    expect(lines.map((line) => line.oldLine)).toEqual(Array.from({ length: 165 }, (_, i) => i + 1));
    expect(lines.map(({ kind, text }) => ({ kind, text }))).toEqual(rawHunkLines(diff));
    expect(lines.some((line) => line.text.includes("sweepSessions"))).toBe(true);
  });

  it("parses a real large file from this tree (2778ccc4 Workspace.ts) without truncating", () => {
    const diff = gitDiff(LARGE_COMMIT, LARGE_PATH);
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.status).toBe("M");
    expect(parsed.path).toBe(LARGE_PATH);
    expect(parsed.binary).toBe(false);
    expect(parsed.hunks).toHaveLength(6);
    const lines = parsed.hunks.flatMap((hunk) => hunk.lines);
    const raw = rawHunkLines(diff);
    expect(lines.length).toBe(raw.length);
    expect(lines.map(({ kind, text }) => ({ kind, text }))).toEqual(raw);
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.some((line) => line.kind === "add")).toBe(true);
    expect(lines.some((line) => line.kind === "del")).toBe(true);
    expect(lines.some((line) => line.kind === "context")).toBe(true);
    expect(diff.includes(lines[0]!.text)).toBe(true);
    expect(diff.includes(lines[lines.length - 1]!.text)).toBe(true);
  });
});
