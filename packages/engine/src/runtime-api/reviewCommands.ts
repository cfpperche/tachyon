/**
 * SDD 511 fatia 2 / t-115091 — review-note mutation wire shape.
 *
 * Same mould as sidebar.mutate: a closed `action` union, every arm carries `id`,
 * and the success result is `{ action, id, changed }`. File content is NOT on
 * the wire — the control request cap is 64 KiB; the engine reads the checkout.
 * A pushed range is a hint, never truth.
 */
import { isSafeReviewSegment } from "../worktree/reviewNotes.js";

export const REVIEW_NOTE_BODY_MAX_CHARS = 16_384;
export const REVIEW_NOTE_PATH_MAX_CHARS = 1_024;
export const REVIEW_NOTE_REF_MAX_CHARS = 256;
export const REVIEW_NOTE_K_MAX = 32;
export const REVIEW_NOTE_LINE_MAX = 2_000_000;

export type ReviewLineRangeV1 = {
  startLine: number;
  endLine: number;
};

export type ReviewMutationInputV1 =
  | {
      action: "note.upsert";
      id: string;
      worktree: string;
      baseRef: string;
      path: string;
      body: string;
      line: number;
      k: number;
      headRef?: string;
      hintRange?: ReviewLineRangeV1;
      endLine?: number;
    }
  | {
      action: "note.hint";
      id: string;
      worktree: string;
      hintRange: ReviewLineRangeV1;
    };

export function isReviewMutationInputV1(value: unknown): value is ReviewMutationInputV1 {
  if (!isRecord(value) || typeof value.action !== "string") return false;
  if (value.action === "note.hint") {
    return exactKeys(value, ["action", "id", "worktree", "hintRange"])
      && typeof value.id === "string"
      && isSafeReviewSegment(value.id)
      && isCommentId(value.id)
      && typeof value.worktree === "string"
      && isSafeReviewSegment(value.worktree)
      && isReviewWorktree(value.worktree)
      && isReviewLineRangeV1(value.hintRange);
  }
  if (value.action !== "note.upsert") return false;
  const keys = ["action", "id", "worktree", "baseRef", "path", "body", "line", "k"];
  if (value.headRef !== undefined) keys.push("headRef");
  if (value.hintRange !== undefined) keys.push("hintRange");
  if (value.endLine !== undefined) keys.push("endLine");
  return exactKeys(value, keys)
    && typeof value.id === "string"
    && isSafeReviewSegment(value.id)
    && isCommentId(value.id)
    && typeof value.worktree === "string"
    && isSafeReviewSegment(value.worktree)
    && isReviewWorktree(value.worktree)
    && isReviewRef(value.baseRef)
    && isReviewFilePath(value.path)
    && typeof value.body === "string"
    && value.body.length <= REVIEW_NOTE_BODY_MAX_CHARS
    && !value.body.includes("\0")
    && isReviewLine(value.line)
    && isReviewK(value.k)
    && (value.headRef === undefined || isReviewRef(value.headRef))
    && (value.hintRange === undefined || isReviewLineRangeV1(value.hintRange))
    && (value.endLine === undefined || isReviewLine(value.endLine));
}

export function parseReviewMutationInputV1(value: unknown): ReviewMutationInputV1 {
  if (!isReviewMutationInputV1(value)) throw new Error("invalid review mutation input");
  if (value.action === "note.hint") {
    return {
      action: "note.hint",
      id: value.id,
      worktree: value.worktree,
      hintRange: { startLine: value.hintRange.startLine, endLine: value.hintRange.endLine },
    };
  }
  return {
    action: "note.upsert",
    id: value.id,
    worktree: value.worktree,
    baseRef: value.baseRef,
    path: value.path,
    body: value.body,
    line: value.line,
    k: value.k,
    ...(value.headRef !== undefined ? { headRef: value.headRef } : {}),
    ...(value.hintRange !== undefined
      ? { hintRange: { startLine: value.hintRange.startLine, endLine: value.hintRange.endLine } }
      : {}),
    ...(value.endLine !== undefined ? { endLine: value.endLine } : {}),
  };
}

export function isReviewMutationResultIdentityV1(
  action: unknown,
  id: unknown,
): action is ReviewMutationInputV1["action"] {
  if (typeof action !== "string" || typeof id !== "string") return false;
  if (action !== "note.upsert" && action !== "note.hint") return false;
  return isSafeReviewSegment(id) && isCommentId(id);
}

export function isReviewNotesQueryInputV1(
  value: unknown,
): value is { worktree: string; k: number } {
  if (!isRecord(value)) return false;
  return exactKeys(value, ["worktree", "k"])
    && typeof value.worktree === "string"
    && isSafeReviewSegment(value.worktree)
    && isReviewWorktree(value.worktree)
    && isReviewK(value.k);
}

export function isReviewLineRangeV1(value: unknown): value is ReviewLineRangeV1 {
  if (!isRecord(value) || !exactKeys(value, ["startLine", "endLine"])) return false;
  return isReviewLine(value.startLine) && isReviewLine(value.endLine);
}

function isCommentId(value: string): boolean {
  return value.length <= 128;
}

function isReviewWorktree(value: string): boolean {
  return value.length <= 128;
}

function isReviewRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > REVIEW_NOTE_REF_MAX_CHARS) {
    return false;
  }
  if (value.includes("\0") || value.startsWith("/") || value.startsWith("-")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isReviewFilePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > REVIEW_NOTE_PATH_MAX_CHARS) {
    return false;
  }
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isReviewLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= REVIEW_NOTE_LINE_MAX;
}

export function isReviewK(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= REVIEW_NOTE_K_MAX;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
