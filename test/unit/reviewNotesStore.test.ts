import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import {
  REVIEW_NOTES_REL,
  loadReviewNotes,
  persistReviewNote,
  readReviewNotes,
} from "@tachyon/engine/worktree/reviewNotesStore.js";

/**
 * t-77736f / SDD 511 fatia 1 — `.tachyon/review/` follows evidenceStore:
 * the record sits next to the note's files as `record.json`.
 *
 * k is a TEST value. The product default is measured by slice 0b (t-232111).
 */
const K = 2;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-review-notes-"));
  dirs.push(dir);
  return dir;
}

function note(body = "look here") {
  const content = ["alpha", "beta", "const target = 1;", "delta", "epsilon"].join("\n") + "\n";
  const created = createReviewNote({
    identity: {
      worktree: "notasgrok",
      baseRef: "abc1234",
      path: "src/a.ts",
      side: "modified",
      commentId: "c-1",
    },
    body,
    content,
    line: 3,
    k: K,
    headRef: "oldhead",
  });
  if (!created) throw new Error("expected a captured note");
  return { created, content };
}

describe("t-77736f — review notes store", () => {
  it("persists the record beside the note under .tachyon/review/<worktree>/<commentId>/", () => {
    const root = workspace();
    const { created } = note();
    persistReviewNote(root, created);
    const record = path.join(root, REVIEW_NOTES_REL, "notasgrok", "c-1", "record.json");
    expect(fs.existsSync(record)).toBe(true);
    const listed = loadReviewNotes(root, "notasgrok");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe("look here");
    expect(listed[0]?.identity).toEqual(created.identity);
    expect(listed[0]?.snapshot.headRef).toBe("oldhead");
  });

  it("reconciles on read — mechanical displacement is persisted, not left for a watcher", () => {
    const root = workspace();
    const { created, content } = note();
    persistReviewNote(root, created);
    const shifted = ["inserted", ...content.split("\n").filter((l) => l.length > 0)].join("\n") + "\n";
    const { notes, journal } = readReviewNotes(root, "notasgrok", new Map([["src/a.ts", shifted]]), K);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.status).toBe("active");
    expect(notes[0]?.lastLine).toBe(4);
    expect(journal[0]?.kind).toBe("migrated");
    const reread = loadReviewNotes(root, "notasgrok");
    expect(reread[0]?.lastLine).toBe(4);
  });

  it("skips a corrupt record instead of throwing, and never deletes a sibling by reconciling", () => {
    const root = workspace();
    const { created } = note();
    persistReviewNote(root, created);
    const badDir = path.join(root, REVIEW_NOTES_REL, "notasgrok", "c-bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "record.json"), "{not json", "utf8");
    const listed = loadReviewNotes(root, "notasgrok");
    expect(listed.map((n) => n.identity.commentId)).toEqual(["c-1"]);
  });
});
