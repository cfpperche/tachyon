/**
 * t-a0d820 / SDD 511 fatia 3 — extension comments wiring.
 *
 * These tests attack the UI half: URI comparison by purpose, one locator for
 * both modified-side forms, restore-from-registry before thread create, and
 * the one-prompt batch. They do not re-prove CommentController-on-custom-scheme
 * (t-1c7627) or engine reconciliation (t-77736f / t-115091).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import {
  REVIEW_DIFF_SCHEME,
  REVIEW_NOTE_CAPTURE_K,
  commentIdFromContextValue,
  composeReviewNotesPrompt,
  locateReviewModifiedDocument,
  mintCommentId,
  noteRangeToVscode,
  notesForDocumentPath,
  parseReviewUriQuery,
  planThreadRestore,
  promptNotesFromView,
  reviewNotesEvidenceRecord,
  reviewThreadContextValue,
  reviewUrisEqual,
  sendReviewNotesBatch,
  vscodeRangeToHint,
  type ReviewCommentsHost,
  type ReviewDocumentLocation,
  type ReviewUriFields,
  type ReviewWorktreeRow,
} from "../../apps/vscode-extension/src/review/comments.js";

const WORKTREE: ReviewWorktreeRow = {
  agent: "ancoragrok",
  path: "/cache/wt/ancoragrok",
  baseRef: "main",
  workspaceHash: "ws-a",
};

function virtual(file: string, ref: string, cwd = WORKTREE.path): ReviewUriFields {
  return {
    scheme: REVIEW_DIFF_SCHEME,
    path: `/${file}`,
    query: `cwd=${encodeURIComponent(cwd)}&ref=${encodeURIComponent(ref)}`,
  };
}

function fileUri(rel: string): ReviewUriFields {
  return {
    scheme: "file",
    path: `${WORKTREE.path}/${rel}`,
    query: "",
    fsPath: `${WORKTREE.path}/${rel}`,
  };
}

function note(over: Partial<ReviewNote> & { commentId?: string; path?: string; lastLine?: number } = {}): ReviewNote {
  const commentId = over.commentId ?? over.identity?.commentId ?? "c-1";
  const filePath = over.path ?? over.identity?.path ?? "src/a.ts";
  return {
    schemaVersion: 1,
    identity: {
      worktree: "ancoragrok",
      baseRef: "main",
      path: filePath,
      side: "modified",
      commentId,
    },
    snapshot: { line: 3, lineText: "const target = 1;", before: [], after: [], k: 3 },
    body: over.body ?? "check the caller",
    status: over.status ?? "active",
    range: over.range ?? { startLine: over.lastLine ?? 3, endLine: over.lastLine ?? 3 },
    lastPath: over.lastPath ?? filePath,
    lastLine: over.lastLine ?? 3,
    ...("outdatedReason" in over ? { outdatedReason: over.outdatedReason } : {}),
  };
}

describe("t-a0d820 — review URI comparison is by purpose, not toString", () => {
  it("treats the same path at two refs as different documents", () => {
    const a = virtual("src/a.ts", "abc1111");
    const b = virtual("src/a.ts", "abc2222");
    expect(a.path).toBe(b.path);
    expect(reviewUrisEqual(a, b)).toBe(false);
    expect(a.toString === b.toString).toBe(true);
  });

  it("matches two virtual URIs only when path, cwd, and ref agree", () => {
    const a = virtual("src/a.ts", "deadbeef");
    expect(reviewUrisEqual(a, virtual("src/a.ts", "deadbeef"))).toBe(true);
    expect(reviewUrisEqual(a, virtual("src/b.ts", "deadbeef"))).toBe(false);
    expect(reviewUrisEqual(a, virtual("src/a.ts", "deadbeef", "/other/cwd"))).toBe(false);
  });

  it("matches file URIs by fsPath, not by query-less string coincidence", () => {
    const a = fileUri("src/a.ts");
    const b = { ...fileUri("src/a.ts"), query: "ignored=1" };
    expect(reviewUrisEqual(a, b)).toBe(true);
    expect(reviewUrisEqual(a, fileUri("src/b.ts"))).toBe(false);
  });

  it("parses the production query string without treating encoding as identity", () => {
    const parsed = parseReviewUriQuery(`cwd=${encodeURIComponent("/cache/wt/foo")}&ref=${encodeURIComponent("feat/x")}`);
    expect(parsed).toEqual({ cwd: "/cache/wt/foo", ref: "feat/x", empty: false });
  });
});

describe("t-a0d820 — one locator serves both modified-side doors", () => {
  const tabsFor = (modified: ReviewUriFields, baseRef = "main") => [
    { original: virtual("src/a.ts", baseRef), modified },
  ];

  it("locates a file: modified side (no headRef) from the same function as the virtual door", () => {
    const modified = fileUri("src/a.ts");
    const location = locateReviewModifiedDocument(modified, [WORKTREE], tabsFor(modified));
    expect(location).toEqual({
      worktree: "ancoragrok",
      cwd: WORKTREE.path,
      path: "src/a.ts",
      baseRef: "main",
      workspaceHash: "ws-a",
    });
    expect(location?.headRef).toBeUndefined();
  });

  it("locates a virtual modified side (with headRef) without a second code path", () => {
    const modified = virtual("src/a.ts", "cafebabe");
    const location = locateReviewModifiedDocument(modified, [WORKTREE], tabsFor(modified));
    expect(location).toEqual({
      worktree: "ancoragrok",
      cwd: WORKTREE.path,
      path: "src/a.ts",
      baseRef: "main",
      workspaceHash: "ws-a",
      headRef: "cafebabe",
    });
  });

  it("refuses the base side of the same virtual scheme", () => {
    const base = virtual("src/a.ts", "main");
    const modified = virtual("src/a.ts", "cafebabe");
    expect(locateReviewModifiedDocument(base, [WORKTREE], [
      { original: base, modified },
    ])).toBeUndefined();
  });

  it("refuses the empty URI", () => {
    const empty: ReviewUriFields = {
      scheme: REVIEW_DIFF_SCHEME,
      path: "/empty",
      query: "empty=1",
    };
    expect(locateReviewModifiedDocument(empty, [WORKTREE], [
      { original: empty, modified: empty },
    ])).toBeUndefined();
  });

  it("does not use URI as the note identity — notes match by path", () => {
    const notes = [note({ path: "src/a.ts" }), note({ commentId: "c-2", path: "src/b.ts" })];
    expect(notesForDocumentPath(notes, "src/a.ts").map((row) => row.identity.commentId)).toEqual(["c-1"]);
    expect(notes[0]?.identity).not.toHaveProperty("uri");
  });
});

describe("t-a0d820 — restore from the registry before creating a thread", () => {
  it("restores an existing thread in place and only creates notes that have none", () => {
    const notes = [note({ commentId: "c-keep" }), note({ commentId: "c-new" })];
    const plan = planThreadRestore(notes, [{ commentId: "c-keep" }, { commentId: "c-stale" }]);
    expect(plan.restore.map((row) => row.commentId)).toEqual(["c-keep"]);
    expect(plan.create.map((row) => row.identity.commentId)).toEqual(["c-new"]);
    expect(plan.dispose).toEqual(["c-stale"]);
    expect(plan.restore[0]?.note.body).toBe("check the caller");
  });

  it("creates nothing when the registry is empty — no optimistic thread", () => {
    expect(planThreadRestore([], [{ commentId: "ghost" }])).toEqual({
      restore: [],
      create: [],
      dispose: ["ghost"],
    });
  });
});

describe("t-a0d820 — one prompt, path:line, priority, evidence is the same batch", () => {
  it("composes one prompt citing path:line and priority per note", () => {
    const prompt = composeReviewNotesPrompt({
      baseRef: "main",
      notes: [
        { path: "src/a.ts", line: 28, body: "missing describe", priority: "high" },
        { path: "src/b.ts", line: 1055, body: "error has no next step", priority: "normal", status: "outdated" },
      ],
    });
    expect(prompt).toContain("REVIEW DO DIFF, 2 nota(s), base main.");
    expect(prompt).toContain("[high] src/a.ts:28");
    expect(prompt).toContain("  missing describe");
    expect(prompt).toContain("[normal, outdated] src/b.ts:1055");
    expect(prompt.indexOf("src/a.ts:28")).toBeLessThan(prompt.indexOf("src/b.ts:1055"));
  });

  it("records the same prompt on the evidence detail", () => {
    const notes = promptNotesFromView([note({ lastLine: 28, path: "src/a.ts", body: "missing describe" })]);
    const prompt = composeReviewNotesPrompt({ baseRef: "main", notes });
    const record = reviewNotesEvidenceRecord({
      targetAgent: "ancoragrok",
      atCommit: "abc1234",
      producedAt: "2026-08-17T18:00:00.000Z",
      id: "ev-1",
      baseRef: "main",
      worktree: "ancoragrok",
      prompt,
      notes,
    });
    expect(record.detail).toBe(prompt);
    expect(record.detail).toContain("[normal] src/a.ts:28");
    expect(record.targetAgent).toBe("ancoragrok");
    expect(record.kind).toBe("review-notes");
    expect(record.data).toMatchObject({ worktree: "ancoragrok", baseRef: "main" });
  });

  it("sends one prompt and attaches the same batch", async () => {
    const sent: string[] = [];
    const evidence: unknown[] = [];
    const location: ReviewDocumentLocation = {
      worktree: "ancoragrok",
      cwd: WORKTREE.path,
      path: "src/a.ts",
      baseRef: "main",
      workspaceHash: "ws-a",
    };
    const host: ReviewCommentsHost = {
      listWorktrees: async () => [WORKTREE],
      viewNotes: async () => [
        note({ commentId: "c-1", path: "src/a.ts", lastLine: 28, body: "first" }),
        note({ commentId: "c-2", path: "src/b.ts", lastLine: 10, body: "second" }),
      ],
      upsert: async () => undefined,
      hint: async () => undefined,
      listAgentsForWorktree: async () => [{ name: "ancoragrok", detail: "owner" }, { name: "revisorcodex" }],
      sendPrompt: async (agent, text) => {
        sent.push(`${agent}\n${text}`);
      },
      attachEvidence: async (_hash, record) => {
        evidence.push(record);
      },
      resolveHead: async () => "abc1234deadbeef",
      notify: () => undefined,
    };
    const result = await sendReviewNotesBatch({
      host,
      location,
      pickAgent: async (agents) => agents[0]?.name,
      now: () => new Date("2026-08-17T18:00:00.000Z"),
    });
    expect(result.sent).toBe(true);
    if (!result.sent) throw new Error("expected send");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("ancoragrok");
    expect(sent[0]).toContain("[normal] src/a.ts:28");
    expect(sent[0]).toContain("[normal] src/b.ts:10");
    expect(evidence).toHaveLength(1);
    expect((evidence[0] as { detail: string }).detail).toBe(result.prompt);
    expect(result.evidence).toBe("ok");
  });

  it("does not invent a second prompt when evidence attach fails", async () => {
    const sent: string[] = [];
    const host: ReviewCommentsHost = {
      listWorktrees: async () => [WORKTREE],
      viewNotes: async () => [note()],
      upsert: async () => undefined,
      hint: async () => undefined,
      listAgentsForWorktree: async () => [{ name: "ancoragrok" }],
      sendPrompt: async (_agent, text) => {
        sent.push(text);
      },
      attachEvidence: async () => {
        throw new Error("disk full");
      },
      resolveHead: async () => "abc",
      notify: () => undefined,
    };
    const result = await sendReviewNotesBatch({
      host,
      location: {
        worktree: "ancoragrok",
        cwd: WORKTREE.path,
        path: "src/a.ts",
        baseRef: "main",
        workspaceHash: "ws-a",
      },
      pickAgent: async () => "ancoragrok",
    });
    expect(result).toMatchObject({ sent: true, evidence: "failed" });
    expect(sent).toHaveLength(1);
  });
});

describe("t-a0d820 — range conversion and thread identity", () => {
  it("converts 1-based engine ranges to 0-based vscode ranges and back", () => {
    expect(noteRangeToVscode({ startLine: 28, endLine: 30 })).toEqual({ startLine: 27, endLine: 29 });
    expect(vscodeRangeToHint({ startLine: 27, endLine: 29 })).toEqual({ startLine: 28, endLine: 30 });
  });

  it("keys a live thread by commentId, never by URI", () => {
    expect(reviewThreadContextValue("c1")).toBe("tachyon-review:c1");
    expect(commentIdFromContextValue("tachyon-review:c1")).toBe("c1");
    expect(mintCommentId(1, () => 0.5).includes("/")).toBe(false);
    expect(mintCommentId(1, () => 0.5).includes("\\")).toBe(false);
  });

  it("uses the measured capture k, not a uniqueness default", () => {
    expect(REVIEW_NOTE_CAPTURE_K).toBe(3);
  });
});

describe("t-a0d820 — source and contribution guards", () => {
  const commentsSrc = fs.readFileSync(
    path.join(__dirname, "../../apps/vscode-extension/src/review/comments.ts"),
    "utf8",
  );
  const extensionSrc = fs.readFileSync(
    path.join(__dirname, "../../apps/vscode-extension/src/extension.ts"),
    "utf8",
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../apps/vscode-extension/package.json"), "utf8")) as {
    contributes: {
      commands: Array<{ command: string }>;
      menus: { commandPalette: Array<{ command: string; when?: string }>; [key: string]: unknown };
    };
  };
  const nlsEn = JSON.parse(fs.readFileSync(path.join(__dirname, "../../apps/vscode-extension/package.nls.json"), "utf8")) as Record<string, string>;
  const nlsPt = JSON.parse(fs.readFileSync(path.join(__dirname, "../../apps/vscode-extension/package.nls.pt-br.json"), "utf8")) as Record<string, string>;

  it("does not use URI as a note key and keeps one locator for both doors", () => {
    expect(commentsSrc).toContain("export function locateReviewModifiedDocument(");
    const locator = commentsSrc.slice(
      commentsSrc.indexOf("export function locateReviewModifiedDocument("),
      commentsSrc.indexOf("export function notesForDocumentPath("),
    );
    expect(locator).toContain('uri.scheme === "file"');
    expect(locator).toContain("REVIEW_DIFF_SCHEME");
    expect(commentsSrc).not.toMatch(/new Map<\s*string.*uri/i);
    expect(commentsSrc).not.toMatch(/notesByUri|threadsByUri|uriToNote/);
    expect(commentsSrc).not.toMatch(/\bWT_DIFF_SCHEME\b/);
    expect(commentsSrc).not.toMatch(/executeCommand\(\s*["'`]vscode\.diff["'`]/);
  });

  it("restores from review.view before createCommentThread in the restore path", () => {
    const restore = commentsSrc.slice(
      commentsSrc.indexOf("const restoreVisible"),
      commentsSrc.indexOf("const createNote"),
    );
    expect(restore.indexOf("viewNotes")).toBeGreaterThanOrEqual(0);
    expect(restore.indexOf("planThreadRestore")).toBeGreaterThan(restore.indexOf("viewNotes"));
    expect(restore.indexOf("createThreadFromNote")).toBeGreaterThan(restore.indexOf("planThreadRestore"));
  });

  it("opens the Tachyon review tab instead of the native vscode.diff", () => {
    expect((extensionSrc.match(/executeCommand\(\s*["'`]vscode\.diff["'`]/g) ?? []).length).toBe(0);
    expect(extensionSrc).toContain("async function reviewWorktreeDiff(");
    expect(extensionSrc).toContain("reviewPanels.open");
    expect(extensionSrc).toContain("new ReviewPanelManager");
  });

  it("declares the send command, unhides Review Changes, and localizes both nls files", () => {
    const commands = pkg.contributes.commands.map((row) => row.command);
    expect(commands).toContain("tachyon.reviewSendNotes");
    expect(commands).toContain("tachyon.reviewWorktreeItem");
    const hidden = pkg.contributes.menus.commandPalette
      .filter((row) => row.when === "false")
      .map((row) => row.command);
    expect(hidden).not.toContain("tachyon.reviewWorktreeItem");
    expect(hidden).not.toContain("tachyon.reviewSendNotes");
    expect(nlsEn["command.reviewSendNotes"]).toBeTruthy();
    expect(nlsPt["command.reviewSendNotes"]).toBeTruthy();
    expect(nlsEn["command.reviewWorktreeItem"]).toBe("Review Changes");
  });

  it("registers the send command next to reviewWorktreeItem", () => {
    const review = extensionSrc.indexOf('registerCommand("tachyon.reviewWorktreeItem"');
    const send = extensionSrc.indexOf('registerCommand("tachyon.reviewSendNotes"');
    expect(review).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(review);
    expect(send - review).toBeLessThan(4000);
  });
});
