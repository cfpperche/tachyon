/**
 * SDD 511 fatia 2 / t-115091 — reconciled review-note read, the wire view.
 *
 * The view is the notes AFTER reconciliation. A caller that wants the raw
 * persisted range is asking for the thing this door exists to refuse.
 */
import {
  isSafeReviewSegment,
  parseReviewNote,
  type ReviewNote,
} from "../worktree/reviewNotes.js";
import { isReviewK } from "./reviewCommands.js";

export const REVIEW_NOTES_VIEW_NOTE_LIMIT = 1_000;

export interface ReviewNotesViewV1 {
  schemaVersion: 1;
  worktree: string;
  k: number;
  notes: ReviewNote[];
}

export function isReviewNotesViewV1(value: unknown): value is ReviewNotesViewV1 {
  try {
    parseReviewNotesViewV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseReviewNotesViewV1(value: unknown): ReviewNotesViewV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("invalid review notes view");
  }
  if (!exactKeys(value, ["schemaVersion", "worktree", "k", "notes"])) {
    throw new Error("invalid review notes view");
  }
  if (typeof value.worktree !== "string" || !isSafeReviewSegment(value.worktree) || value.worktree.length > 128) {
    throw new Error("invalid review notes view worktree");
  }
  if (!isReviewK(value.k)) throw new Error("invalid review notes view k");
  if (!Array.isArray(value.notes) || value.notes.length > REVIEW_NOTES_VIEW_NOTE_LIMIT) {
    throw new Error("review notes view exceeds its note limit");
  }
  const notes: ReviewNote[] = [];
  const seen = new Set<string>();
  for (const raw of value.notes) {
    const parsed = parseReviewNote(raw);
    if (!parsed) throw new Error("invalid review note in view");
    if (parsed.identity.worktree !== value.worktree) {
      throw new Error("review note worktree does not match the view");
    }
    if (seen.has(parsed.identity.commentId)) {
      throw new Error("review notes view repeats a commentId");
    }
    seen.add(parsed.identity.commentId);
    notes.push(parsed);
  }
  return {
    schemaVersion: 1,
    worktree: value.worktree,
    k: value.k,
    notes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
