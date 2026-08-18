import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@tachyon/engine/worktree/review.js";
import {
  REVIEW_DIFF_QUERY_METHOD,
  isReviewDiffFileV1,
  isReviewDiffQueryInputV1,
  parseReviewDiffFileV1,
  parseReviewDiffQueryInputV1,
  parseReviewNotesViewV1,
  projectReviewDiffFileV1,
} from "@tachyon/engine/runtime-api/reviewProjection.js";

const DELETED_COMMIT = "55de2fc4";
const DELETED_PATH = "packages/engine/src/commands/CommandRunner.ts";
const LARGE_COMMIT = "2778ccc4";
const LARGE_PATH = "packages/engine/src/workspace/Workspace.ts";

function gitDiff(rev: string, path: string): string {
  return execFileSync("git", ["diff", `${rev}^`, rev, "--", path], { encoding: "utf8" });
}

function fileView(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    format: "unified",
    worktree: "hunkgrok",
    path: "src/a.ts",
    status: "M",
    baseRef: "abc1234",
    currentLabel: "worktree",
    binary: false,
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: "",
      lines: [{ kind: "context", text: "keep", oldLine: 1, newLine: 1 }],
    }],
    ...over,
  };
}

describe("t-e968c1 — ReviewDiffFileV1 wire (SDD 513 fatia 1)", () => {
  it("names the query door and requires a single path", () => {
    expect(REVIEW_DIFF_QUERY_METHOD).toBe("review.diff");
    expect(isReviewDiffQueryInputV1({
      worktree: "hunkgrok",
      path: "src/a.ts",
      baseRef: "abc1234",
    })).toBe(true);
    expect(isReviewDiffQueryInputV1({
      worktree: "hunkgrok",
      path: "src/a.ts",
      baseRef: "abc1234",
      headRef: "def5678",
    })).toBe(true);
    expect(isReviewDiffQueryInputV1({ worktree: "hunkgrok", baseRef: "abc1234" })).toBe(false);
    expect(isReviewDiffQueryInputV1({
      worktree: "hunkgrok",
      path: "src/a.ts",
      baseRef: "abc1234",
      extra: true,
    })).toBe(false);
    expect(parseReviewDiffQueryInputV1({
      worktree: "hunkgrok",
      path: DELETED_PATH,
      baseRef: DELETED_COMMIT,
    })).toEqual({
      worktree: "hunkgrok",
      path: DELETED_PATH,
      baseRef: DELETED_COMMIT,
    });
  });

  it("closes the file view: unified only, no sibling-files field, exact keys", () => {
    const parsed = parseReviewDiffFileV1(fileView());
    expect(parsed.format).toBe("unified");
    expect(parsed).not.toHaveProperty("files");
    expect(parsed).not.toHaveProperty("notes");
    expect(isReviewDiffFileV1({ ...fileView(), format: "split" })).toBe(false);
    expect(isReviewDiffFileV1({ ...fileView(), extra: true })).toBe(false);
    expect(isReviewDiffFileV1({ ...fileView(), files: [{ path: "other.ts" }] })).toBe(false);
    expect(() => parseReviewNotesViewV1({
      schemaVersion: 1,
      worktree: "hunkgrok",
      k: 2,
      notes: [],
      hunks: parsed.hunks,
    })).toThrow(/invalid review notes view/);
  });

  it("projects a real deletion (55de2fc4 CommandRunner.ts) as status D with every line kind del", () => {
    const parsed = parseUnifiedDiff(gitDiff(DELETED_COMMIT, DELETED_PATH));
    const view = projectReviewDiffFileV1({
      worktree: "hunkgrok",
      path: DELETED_PATH,
      baseRef: DELETED_COMMIT,
      parsed,
    });
    expect(view.status).toBe("D");
    expect(view.path).toBe(DELETED_PATH);
    expect(view.format).toBe("unified");
    expect(view.binary).toBe(false);
    const lines = view.hunks.flatMap((hunk) => hunk.lines);
    expect(lines).toHaveLength(165);
    expect(lines.every((line) => line.kind === "del" && line.newLine === null && line.oldLine !== null)).toBe(true);
    expect(isReviewDiffFileV1(view)).toBe(true);
  });

  it("projects a real large file (2778ccc4 Workspace.ts) without cutting text", () => {
    const raw = gitDiff(LARGE_COMMIT, LARGE_PATH);
    const parsed = parseUnifiedDiff(raw);
    const view = projectReviewDiffFileV1({
      worktree: "hunkgrok",
      path: LARGE_PATH,
      baseRef: LARGE_COMMIT,
      currentLabel: LARGE_COMMIT,
      headRef: LARGE_COMMIT,
      parsed,
    });
    expect(view.status).toBe("M");
    expect(view.hunks).toHaveLength(6);
    expect(view.headRef).toBe(LARGE_COMMIT);
    const payload = view.hunks.flatMap((hunk) => hunk.lines);
    expect(payload.length).toBeGreaterThan(100);
    expect(payload.every((line) => raw.includes(line.text) || line.text.length === 0)).toBe(true);
    expect(payload.some((line) => line.text.length > 80)).toBe(true);
    expect(isReviewDiffFileV1({ ...view, hunks: view.hunks.slice(0, 1) })).toBe(true);
  });

  it("keeps a deleted line's text when projecting — the engine does not hide content", () => {
    const view = projectReviewDiffFileV1({
      worktree: "hunkgrok",
      path: "gone.ts",
      baseRef: "abc1234",
      status: "D",
      parsed: {
        path: "gone.ts",
        status: "D",
        binary: false,
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          header: "",
          lines: [{ kind: "del", text: "x".repeat(500), oldLine: 1, newLine: null }],
        }],
      },
    });
    expect(view.hunks[0]?.lines[0]?.text).toHaveLength(500);
  });
});
