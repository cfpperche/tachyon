/**
 * t-77736f / SDD 511 — review-note records live next to their files.
 *
 * Same mould as evidenceStore.ts (t-1d198e): `.tachyon/review/<worktree>/<commentId>/record.json`
 * so the record and any later siblings die together. Reconciliation runs on read — there is
 * no watcher, event, or trigger.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  isSafeReviewSegment,
  parseReviewNote,
  reconcileNotes,
  reviewNoteRelDir,
  REVIEW_NOTES_REL,
  type ReconcileNoteOpts,
  type ReviewNote,
  type ReviewReconcileJournal,
} from "./reviewNotes.js";

export { REVIEW_NOTES_REL, reviewNoteRelDir };

const RECORD_NAME = "record.json";

function recordPath(workspaceRoot: string, worktree: string, commentId: string): string {
  return path.join(workspaceRoot, reviewNoteRelDir(worktree, commentId), RECORD_NAME);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* rename failure is the real error */ }
    throw error;
  }
}

export function persistReviewNote(workspaceRoot: string, record: ReviewNote): void {
  if (!isSafeReviewSegment(record.identity.worktree) || !isSafeReviewSegment(record.identity.commentId)) {
    throw new Error("review note worktree and commentId must be single safe path segments");
  }
  writeAtomic(recordPath(workspaceRoot, record.identity.worktree, record.identity.commentId), `${JSON.stringify(record, null, 2)}\n`);
}

export function loadReviewNotes(workspaceRoot: string, worktree: string): ReviewNote[] {
  if (!isSafeReviewSegment(worktree)) return [];
  const dir = path.join(workspaceRoot, REVIEW_NOTES_REL, worktree);
  if (!fs.existsSync(dir)) return [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const notes: ReviewNote[] = [];
  for (const entry of entries) {
    if (!isSafeReviewSegment(entry)) continue;
    const file = path.join(dir, entry, RECORD_NAME);
    try {
      const parsed = parseReviewNote(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed && parsed.identity.worktree === worktree) notes.push(parsed);
    } catch {
      /* missing or corrupt record.json is not a note we can show */
    }
  }
  return notes;
}

/**
 * The product door. Loads, reconciles against the current file contents, and
 * persists any note whose position or state changed. Callers pass k explicitly.
 */
export function readReviewNotes(
  workspaceRoot: string,
  worktree: string,
  files: ReadonlyMap<string, string>,
  k: number,
  opts: Omit<ReconcileNoteOpts, "knownPaths"> = {},
): { notes: ReviewNote[]; journal: ReviewReconcileJournal[] } {
  const loaded = loadReviewNotes(workspaceRoot, worktree);
  const { notes, journal } = reconcileNotes(loaded, files, k, opts);
  for (let i = 0; i < notes.length; i++) {
    const before = loaded[i];
    const after = notes[i];
    if (!before || !after) continue;
    if (noteChanged(before, after)) {
      try {
        persistReviewNote(workspaceRoot, after);
      } catch {
        /* listing still returns the reconciled view; a later write can retry */
      }
    }
  }
  return { notes, journal };
}

function noteChanged(before: ReviewNote, after: ReviewNote): boolean {
  return (
    before.status !== after.status ||
    before.lastLine !== after.lastLine ||
    before.lastPath !== after.lastPath ||
    before.range.startLine !== after.range.startLine ||
    before.range.endLine !== after.range.endLine ||
    before.outdatedReason !== after.outdatedReason ||
    JSON.stringify(before.degraded) !== JSON.stringify(after.degraded) ||
    JSON.stringify(before.lastReconcile) !== JSON.stringify(after.lastReconcile)
  );
}
