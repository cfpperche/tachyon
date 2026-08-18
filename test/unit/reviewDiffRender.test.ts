import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { parseUnifiedDiff, unifiedDiffFromAddedFile, type ChangedFile } from "@tachyon/engine/worktree/review.js";
import { projectReviewDiffFileV1, type ReviewDiffFileV1 } from "@tachyon/engine/runtime-api/reviewProjection.js";
import { createReviewNote, type ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import { loadWebviewModule, renderStaticWithElements } from "../helpers/staticPreact.js";
import {
  HIGHLIGHT_CHAR_LIMIT,
  HIGHLIGHT_DISABLED_BANNER,
  highlightableCharCount,
  renderReviewDiff,
  shouldHighlight,
} from "@tachyon/webview-ui/webview/review/render.js";
import { notesForPath, noteMigrated, orphanedNotes, visibleNewLinesFrom } from "@tachyon/webview-ui/webview/review/notes.js";
import type { ReviewVM } from "@tachyon/webview-ui/webview/review/messages.js";

const DELETED_COMMIT = "55de2fc4";
const DELETED_PATH = "packages/engine/src/commands/CommandRunner.ts";
const LARGE_COMMIT = "2778ccc4";
const LARGE_PATH = "packages/engine/src/workspace/Workspace.ts";

function gitDiff(rev: string, file: string): string {
  return execFileSync("git", ["diff", `${rev}^`, rev, "--", file], { encoding: "utf8" });
}

function gitShow(rev: string, file: string): string {
  return execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" });
}

function fileView(parsed: ReturnType<typeof parseUnifiedDiff>, over: Partial<ReviewDiffFileV1> = {}): ReviewDiffFileV1 {
  return projectReviewDiffFileV1({
    worktree: "reviewgrok",
    path: parsed.path || (over.path ?? "src/a.ts"),
    baseRef: "abc1234",
    parsed,
    status: over.status ?? parsed.status,
    currentLabel: "worktree",
    ...("from" in over ? { from: over.from } : {}),
  });
}

function note(over: Partial<ReviewNote> & { path?: string; line?: number; body?: string; commentId?: string }): ReviewNote {
  const pathName = over.path ?? "src/a.ts";
  const line = over.line ?? 1;
  const created = createReviewNote({
    identity: {
      worktree: "reviewgrok",
      baseRef: "abc1234",
      path: pathName,
      side: "modified",
      commentId: over.commentId ?? "c-note",
    },
    body: over.body ?? "check this",
    content: `${"pad\n".repeat(Math.max(0, line - 1))}target line\n`,
    line,
    k: 3,
    headRef: "oldhead",
  });
  if (!created) throw new Error("expected a captured note");
  return { ...created, ...over };
}

describe("t-832633 — review diff render (SDD 513 fatia 2)", () => {
  it("renders a real deleted file from this tree as del lines with no modified-side ruler", () => {
    const parsed = parseUnifiedDiff(gitDiff(DELETED_COMMIT, DELETED_PATH));
    const view = fileView(parsed, { path: DELETED_PATH, status: "D" });
    expect(view.binary).toBe(false);
    expect(view.status).toBe("D");
    const rendered = renderReviewDiff(view);
    const lines = rendered.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.kind === "del")).toBe(true);
    expect(lines.every((line) => line.newLine === null)).toBe(true);
    expect(lines.every((line) => line.oldLine !== null)).toBe(true);
    expect(lines.every((line) => line.annotatable === false)).toBe(true);
    expect(lines.every((line) => line.text.length > 0 || line.html === "&nbsp;")).toBe(true);
  });

  it("renders a real file above 20k escaped, with the visible highlight-off banner", () => {
    const source = gitShow(LARGE_COMMIT, LARGE_PATH);
    expect(source.length).toBeGreaterThan(HIGHLIGHT_CHAR_LIMIT);
    const parsed = parseUnifiedDiff(unifiedDiffFromAddedFile(LARGE_PATH, source));
    const view = fileView(parsed, { path: LARGE_PATH, status: "A" });
    expect(highlightableCharCount(view)).toBeGreaterThan(HIGHLIGHT_CHAR_LIMIT);
    expect(shouldHighlight(view)).toBe(false);
    const rendered = renderReviewDiff(view);
    expect(rendered.highlight).toBe(false);
    expect(rendered.highlightBanner).toBe(HIGHLIGHT_DISABLED_BANNER);
    const first = rendered.hunks[0]?.lines[0];
    expect(first).toBeTruthy();
    expect(first!.html).not.toContain("hljs-");
    expect(first!.html).toBe(first!.text.length ? first!.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "&nbsp;");
    expect(first!.annotatable).toBe(true);
  });

  it("renders a binary file with no hunks and does not invent bytes", () => {
    const view = projectReviewDiffFileV1({
      worktree: "reviewgrok",
      path: "media/icon.png",
      baseRef: "abc1234",
      parsed: { path: "media/icon.png", status: "A", binary: true, hunks: [] },
      status: "A",
      currentLabel: "worktree",
    });
    expect(view.binary).toBe(true);
    expect(view.hunks).toEqual([]);
    const rendered = renderReviewDiff(view);
    expect(rendered.binary).toBe(true);
    expect(rendered.hunks).toEqual([]);
    expect(rendered.highlight).toBe(false);
    expect(rendered.highlightBanner).toBeUndefined();
  });

  it("highlights a small file and never offers a side-by-side format", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      " const keep = 1;",
      "+const added = 2;",
      "",
    ].join("\n"));
    const view = fileView(parsed, { path: "src/a.ts", status: "M" });
    expect(view.format).toBe("unified");
    expect(shouldHighlight(view)).toBe(true);
    const rendered = renderReviewDiff(view);
    expect(rendered.highlight).toBe(true);
    expect(rendered.highlightBanner).toBeUndefined();
    expect(rendered.hunks[0]!.lines.some((line) => line.html.includes("hljs-"))).toBe(true);
    expect(rendered.hunks[0]!.lines.find((line) => line.kind === "add")?.annotatable).toBe(true);
  });
});

describe("t-832633 — notes attach on newLine only", () => {
  it("keeps a migrated note on lastLine and an outdated note visible when its line died", () => {
    const hunks = [{ lines: [{ newLine: 12 as number | null }, { newLine: null }] }];
    const pathName = "src/a.ts";
    const migrated = note({
      commentId: "c-mig",
      path: pathName,
      line: 8,
      lastLine: 12,
      status: "active",
      lastReconcile: { kind: "migrated", fromLine: 8, toLine: 12, fromPath: pathName, toPath: pathName },
      body: "this moved with the file",
    });
    const outdated = note({
      commentId: "c-old",
      path: pathName,
      line: 3,
      lastLine: 3,
      status: "outdated",
      outdatedReason: "deleted",
      lastReconcile: { kind: "outdated", fromLine: 3, toLine: 3, fromPath: pathName, toPath: pathName, reason: "deleted" },
      body: "this line died",
    });
    expect(noteMigrated(migrated)).toBe(true);
    expect(notesForPath([migrated, outdated], pathName)).toHaveLength(2);
    const visible = visibleNewLinesFrom(hunks);
    expect(orphanedNotes([migrated, outdated], pathName, visible).map((n) => n.identity.commentId)).toEqual(["c-old"]);
  });
});

describe("t-832633 — review screen render", () => {
  let App: (props: { vm?: ReviewVM; dispatch: { selectFile: (path: string) => void; upsertNote: (path: string, line: number, body: string) => void; sendBatch: (agent: string) => void } }) => unknown;

  beforeAll(async () => {
    const mod = await loadWebviewModule(
      path.join(__dirname, "../../packages/webview-ui/src/webview/review/App.tsx"),
      { packageResolution: true },
    );
    App = mod.App as typeof App;
  });

  function paint(vm: ReviewVM) {
    const posted: unknown[] = [];
    const { html, elements } = renderStaticWithElements(
      App({
        vm,
        dispatch: {
          selectFile: (filePath) => posted.push({ type: "review.diff", path: filePath }),
          upsertNote: (filePath, line, body) => posted.push({ type: "review.upsertNote", path: filePath, line, body }),
          sendBatch: (agent) => posted.push({ type: "review.sendBatch", agent }),
        },
      }),
    );
    return { html, elements, posted };
  }

  function vmOver(over: Partial<ReviewVM> & { diff: ReviewDiffFileV1; files: ChangedFile[] }): ReviewVM {
    return {
      worktree: "reviewgrok",
      baseRef: "abc1234",
      currentLabel: "worktree",
      k: 3,
      selectedPath: over.diff.path,
      notes: [],
      agents: [{ name: "claude" }],
      ...over,
    };
  }

  it("paints a deleted file, a binary file, and a large file with the highlight banner", () => {
    const deletedParsed = parseUnifiedDiff(gitDiff(DELETED_COMMIT, DELETED_PATH));
    const deleted = fileView(deletedParsed, { path: DELETED_PATH, status: "D" });
    const deletedHtml = paint(vmOver({
      files: [{ status: "D", path: DELETED_PATH }],
      diff: deleted,
    })).html;
    expect(deletedHtml).toContain(DELETED_PATH);
    expect(deletedHtml).toContain("data-status=\"D\"");
    expect(deletedHtml).not.toContain("review-ruler-");
    expect(deletedHtml).toContain("unified");

    const binary = paint(vmOver({
      files: [{ status: "A", path: "media/icon.png" }],
      diff: projectReviewDiffFileV1({
        worktree: "reviewgrok",
        path: "media/icon.png",
        baseRef: "abc1234",
        parsed: { path: "media/icon.png", status: "A", binary: true, hunks: [] },
        status: "A",
        currentLabel: "worktree",
      }),
    })).html;
    expect(binary).toContain("review-binary");
    expect(binary).toContain("Binary file");

    const source = gitShow(LARGE_COMMIT, LARGE_PATH);
    const large = fileView(parseUnifiedDiff(unifiedDiffFromAddedFile(LARGE_PATH, source)), { path: LARGE_PATH, status: "A" });
    const largePaint = paint(vmOver({
      files: [
        { status: "A", path: LARGE_PATH },
        { status: "D", path: DELETED_PATH },
        { status: "A", path: "media/icon.png" },
      ],
      diff: large,
      notes: [
        note({
          commentId: "c-mig",
          path: LARGE_PATH,
          line: 1,
          lastLine: 1,
          status: "active",
          lastReconcile: { kind: "migrated", fromLine: 8, toLine: 1, fromPath: LARGE_PATH, toPath: LARGE_PATH },
          body: "migrated with the file",
        }),
        note({
          commentId: "c-old",
          path: LARGE_PATH,
          line: 3,
          lastLine: 9_999_999,
          status: "outdated",
          outdatedReason: "deleted",
          lastReconcile: { kind: "outdated", fromLine: 3, toLine: 3, fromPath: LARGE_PATH, toPath: LARGE_PATH, reason: "deleted" },
          body: "this line died",
        }),
      ],
    }));
    expect(largePaint.html).toContain(HIGHLIGHT_DISABLED_BANNER);
    expect(largePaint.html).toContain("data-highlight=\"off\"");
    expect(largePaint.html).toContain("review-note-c-mig");
    expect(largePaint.html).toContain("migrated");
    expect(largePaint.html).toContain("review-note-c-old");
    expect(largePaint.html).toContain("outdated");
    expect(largePaint.html).toContain("review-orphans");
  });

  it("posts review.diff for the selected path and sendBatch for the lote — never a files array", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
      "",
    ].join("\n"));
    const { elements, posted } = paint(vmOver({
      files: [{ status: "M", path: "src/a.ts" }, { status: "D", path: "gone.ts" }],
      diff: fileView(parsed, { path: "src/a.ts", status: "M" }),
      notes: [note({ path: "src/a.ts", line: 1, lastLine: 1, body: "one" })],
    }));
    const other = elements.find((el) => el.props["data-testid"] === "review-file-gone.ts");
    expect(other).toBeTruthy();
    (other!.props.onClick as () => void)();
    expect(posted).toEqual([{ type: "review.diff", path: "gone.ts" }]);
    const send = elements.find((el) => el.props["data-testid"] === "review-send-batch");
    (send!.props.onClick as () => void)();
    expect(posted).toContainEqual({ type: "review.sendBatch", agent: "claude" });
    expect(JSON.stringify(posted)).not.toContain("\"files\"");
  });

  it("t-bd1e5a — added-line ruler is a comment mark, not a second + (title/aria stay)", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
      "",
    ].join("\n"));
    const { html, elements } = paint(vmOver({
      files: [{ status: "M", path: "src/a.ts" }],
      diff: fileView(parsed, { path: "src/a.ts", status: "M" }),
    }));
    const ruler = elements.find((el) => el.props["data-testid"] === "review-ruler-2");
    expect(ruler).toBeTruthy();
    expect(ruler!.props.title).toBe("Comment on line 2");
    expect(ruler!.props["aria-label"]).toBe("Comment on line 2");
    expect(typeof ruler!.props.onClick).toBe("function");
    expect(ruler!.html).toContain("codicon-comment");
    expect(ruler!.html).not.toMatch(/>\s*\+\s*</);
    expect(html).toMatch(/class="review-sign">\+/);
  });
});
