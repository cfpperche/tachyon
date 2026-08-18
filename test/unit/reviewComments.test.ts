/**
 * t-a0d820 / t-1a76c5 — send-batch helpers after CommentController left.
 *
 * The one-prompt lote and evidence stay. Threads, URIs, and the Comments panel do not.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import {
  REVIEW_NOTE_CAPTURE_K,
  composeReviewNotesPrompt,
  mintCommentId,
  promptNotesFromView,
  reviewNotesEvidenceRecord,
  sendReviewNotesBatch,
  type ReviewCommentsHost,
  type ReviewDocumentLocation,
  type ReviewWorktreeRow,
} from "../../apps/vscode-extension/src/review/batch.js";

const WORKTREE: ReviewWorktreeRow = {
  agent: "ancoragrok",
  path: "/cache/wt/ancoragrok",
  baseRef: "main",
  workspaceHash: "ws-a",
};

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

describe("t-1a76c5 — CommentController and comments.ts are gone", () => {
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

  it("uses the measured capture k and a commentId without path separators", () => {
    expect(REVIEW_NOTE_CAPTURE_K).toBe(3);
    expect(mintCommentId(1, () => 0.5).includes("/")).toBe(false);
    expect(mintCommentId(1, () => 0.5).includes("\\")).toBe(false);
  });

  it("does not keep comments.ts or a CommentController in the product", () => {
    expect(fs.existsSync(path.join(__dirname, "../../apps/vscode-extension/src/review/comments.ts"))).toBe(false);
    expect(extensionSrc).not.toMatch(/createCommentController/);
    expect(extensionSrc).not.toMatch(/registerReviewComments/);
    expect(extensionSrc).not.toMatch(/\bCommentController\b/);
    expect(extensionSrc).not.toContain("review/comments.js");
  });

  it("drops the Comments-panel commands and keeps Review Changes + send", () => {
    const commands = pkg.contributes.commands.map((row) => row.command);
    expect(commands).toContain("tachyon.reviewSendNotes");
    expect(commands).toContain("tachyon.reviewWorktreeItem");
    expect(commands).not.toContain("tachyon.review.createNote");
    expect(commands).not.toContain("tachyon.review.replyNote");
    expect(pkg.contributes.menus.comments).toBeUndefined();
    const hidden = pkg.contributes.menus.commandPalette
      .filter((row) => row.when === "false")
      .map((row) => row.command);
    expect(hidden).not.toContain("tachyon.reviewWorktreeItem");
    expect(hidden).not.toContain("tachyon.reviewSendNotes");
  });

  it("registers the send command next to reviewWorktreeItem", () => {
    const review = extensionSrc.indexOf('registerCommand("tachyon.reviewWorktreeItem"');
    const send = extensionSrc.indexOf('registerCommand("tachyon.reviewSendNotes"');
    expect(review).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(review);
    expect(send - review).toBeLessThan(4000);
  });
});
