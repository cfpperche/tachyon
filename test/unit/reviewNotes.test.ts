import { describe, expect, it } from "vitest";
import type { ChangedFile } from "@tachyon/engine/worktree/review.js";
import {
  REVIEW_NOTE_RECONCILE_MAX_CHARS,
  captureSnapshot,
  createReviewNote,
  noteIdentityKey,
  reconcileNote,
  reconcileNotes,
  type ReviewNote,
  type ReviewNoteIdentity,
} from "@tachyon/engine/worktree/reviewNotes.js";

/**
 * t-77736f / SDD 511 fatia 1 — pure reconciliation.
 *
 * k is a TEST value. The product default is measured by slice 0b (t-232111) and is
 * not invented here.
 */
const K = 2;

const identity = (over: Partial<ReviewNoteIdentity> = {}): ReviewNoteIdentity => ({
  worktree: "notasgrok",
  baseRef: "abc1234",
  path: "src/a.ts",
  side: "modified",
  commentId: "c-1",
  ...over,
});

function fileWithAnchor(over: { prefix?: string[]; suffix?: string[]; line?: string } = {}): string {
  const prefix = over.prefix ?? ["alpha", "beta"];
  const suffix = over.suffix ?? ["delta", "epsilon"];
  const line = over.line ?? "const target = 1;";
  return [...prefix, line, ...suffix].join("\n") + "\n";
}

function noteOn(content: string, over: Partial<ReviewNoteIdentity> = {}, line = 3): ReviewNote {
  const created = createReviewNote({
    identity: identity(over),
    body: "check the caller",
    content,
    line,
    k: K,
    headRef: "oldhead",
  });
  if (!created) throw new Error("expected a captured note");
  return created;
}

describe("t-77736f — review note identity (SDD 511)", () => {
  it("is worktree + baseRef + path + side + commentId, with no URI and no headRef", () => {
    const key = noteIdentityKey(identity({ commentId: "c-9" }));
    expect(key).toBe(["notasgrok", "abc1234", "src/a.ts", "modified", "c-9"].join("\0"));
    expect(key).not.toMatch(/uri/i);
    expect(key).not.toContain("oldhead");
    expect(Object.keys(identity()).sort()).toEqual(["baseRef", "commentId", "path", "side", "worktree"]);
  });

  it("keeps headRef on the snapshot, not the identity", () => {
    const note = noteOn(fileWithAnchor());
    expect(note.snapshot.headRef).toBe("oldhead");
    expect(note.identity).not.toHaveProperty("headRef");
    expect(noteIdentityKey(note.identity)).not.toContain("oldhead");
  });
});

describe("t-77736f — capture snapshot (k is a parameter)", () => {
  it("captures k lines of context around the 1-based line and refuses a missing k", () => {
    const content = fileWithAnchor();
    const snap = captureSnapshot(content, 3, K, "deadbeef");
    expect(snap).toEqual({
      headRef: "deadbeef",
      line: 3,
      lineText: "const target = 1;",
      before: ["alpha", "beta"],
      after: ["delta", "epsilon"],
      k: K,
    });
    expect(() => captureSnapshot(content, 3, undefined as unknown as number)).toThrow(/0b|t-232111|parameter/i);
  });
});

describe("t-77736f — reconcile on read", () => {
  it("migrates on mechanical displacement", () => {
    const original = fileWithAnchor();
    const note = noteOn(original);
    const shifted = fileWithAnchor({ prefix: ["inserted", "alpha", "beta"] });
    const { note: next, journal } = reconcileNote(note, shifted, K);
    expect(next.status).toBe("active");
    expect(next.lastLine).toBe(4);
    expect(next.range).toEqual({ startLine: 4, endLine: 4 });
    expect(next.body).toBe("check the caller");
    expect(journal.kind).toBe("migrated");
    expect(journal.fromLine).toBe(3);
    expect(journal.toLine).toBe(4);
  });

  it("marks outdated when the line is deleted and never relocates it", () => {
    const note = noteOn(fileWithAnchor());
    const deleted = ["alpha", "beta", "delta", "epsilon"].join("\n") + "\n";
    const { note: next, journal } = reconcileNote(note, deleted, K);
    expect(next.status).toBe("outdated");
    expect(next.outdatedReason).toBe("deleted");
    expect(next.lastLine).toBe(3);
    expect(next.range).toEqual({ startLine: 3, endLine: 3 });
    expect(next.body).toBe("check the caller");
    expect(journal.kind).toBe("outdated");
    expect(next.lastLine).toBe(note.lastLine);
  });

  it("marks outdated on ambiguous match, never picking the nearest", () => {
    const note = noteOn(fileWithAnchor());
    const ambiguous = [
      "alpha",
      "beta",
      "const target = 1;",
      "delta",
      "epsilon",
      "alpha",
      "beta",
      "const target = 1;",
      "delta",
      "epsilon",
    ].join("\n") + "\n";
    const { note: next, journal } = reconcileNote(note, ambiguous, K);
    expect(next.status).toBe("outdated");
    expect(next.outdatedReason).toBe("ambiguous");
    expect(next.lastLine).toBe(3);
    expect(next.body).toBe("check the caller");
    expect(journal.kind).toBe("outdated");
    expect(journal.toLine).toBe(3);
  });

  it("marks outdated when the snapshot does not match", () => {
    const note = noteOn(fileWithAnchor());
    // Same line text still exists, but the captured context is gone — not a deletion.
    const rewritten = ["omega", "gamma", "const target = 1;", "zeta", "theta"].join("\n") + "\n";
    const { note: next, journal } = reconcileNote(note, rewritten, K);
    expect(next.status).toBe("outdated");
    expect(next.outdatedReason).toBe("snapshot-mismatch");
    expect(next.lastLine).toBe(3);
    expect(next.body).toBe("check the caller");
    expect(journal.kind).toBe("outdated");
  });

  it("follows a unique rename via ChangedFile.from and never points at the old path", () => {
    const original = fileWithAnchor();
    const note = noteOn(original, { path: "src/old.ts" });
    expect(note.identity.path).toBe("src/old.ts");
    expect(note.lastPath).toBe("src/old.ts");
    const changedFiles: ChangedFile[] = [{ status: "R", from: "src/old.ts", path: "src/new.ts" }];
    const { note: next, journal } = reconcileNote(note, original, K, { changedFiles });
    expect(next.status).toBe("active");
    expect(next.lastPath).toBe("src/new.ts");
    expect(next.identity.path).toBe("src/old.ts");
    expect(journal.toPath).toBe("src/new.ts");
    expect(journal.fromPath).toBe("src/old.ts");
  });

  it("lets the snapshot win when the platform hint disagrees, and records the divergence", () => {
    const original = fileWithAnchor();
    const created = createReviewNote({
      identity: identity(),
      body: "check the caller",
      content: original,
      line: 3,
      k: K,
      hintRange: { startLine: 40, endLine: 40 },
    });
    if (!created) throw new Error("expected a captured note");
    const shifted = fileWithAnchor({ prefix: ["inserted", "alpha", "beta"] });
    const hinted: ReviewNote = { ...created, hintRange: { startLine: 40, endLine: 40 } };
    const { note: next, journal } = reconcileNote(hinted, shifted, K);
    expect(next.status).toBe("active");
    expect(next.lastLine).toBe(4);
    expect(next.range.startLine).toBe(4);
    expect(next.range.startLine).not.toBe(40);
    expect(journal.hintDisagreed).toEqual({
      hint: { startLine: 40, endLine: 40 },
      derived: { startLine: 4, endLine: 4 },
    });
  });

  it("degrades explicitly when the file exceeds the size guard and does not silently keep a position as truth", () => {
    const note = noteOn(fileWithAnchor());
    const huge = `${"x".repeat(REVIEW_NOTE_RECONCILE_MAX_CHARS + 1)}\n${fileWithAnchor()}`;
    const { note: next, journal } = reconcileNote(note, huge, K);
    expect(journal.kind).toBe("degraded");
    expect(next.degraded).toEqual({
      reason: "oversized",
      limit: REVIEW_NOTE_RECONCILE_MAX_CHARS,
      bytes: huge.length,
    });
    expect(next.body).toBe("check the caller");
    expect(next.lastLine).toBe(3);
    expect(next.status).not.toBeUndefined();
  });

  it("never drops a note from the set — outdated is a state, not a removal", () => {
    const a = noteOn(fileWithAnchor(), { commentId: "keep-1" });
    const b = noteOn(fileWithAnchor(), { commentId: "keep-2", path: "src/b.ts" });
    const files = new Map<string, string>([
      ["src/a.ts", fileWithAnchor({ line: "gone" })],
      ["src/b.ts", fileWithAnchor()],
    ]);
    const { notes, journal } = reconcileNotes([a, b], files, K);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.identity.commentId).sort()).toEqual(["keep-1", "keep-2"]);
    expect(notes.find((n) => n.identity.commentId === "keep-1")?.status).toBe("outdated");
    expect(notes.find((n) => n.identity.commentId === "keep-2")?.status).toBe("active");
    expect(journal).toHaveLength(2);
  });
});
