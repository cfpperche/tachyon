/**
 * SDD 511 fatia 2 / t-115091 — reconciled review-note read, the wire view.
 * SDD 513 fatia 1 / t-e968c1 — one-file unified hunks, a sibling view.
 *
 * Notes stay on `review.view` / `ReviewNotesViewV1`. Hunks travel on a different
 * door (`REVIEW_DIFF_QUERY_METHOD` / `ReviewDiffFileV1`) so a 131-file review
 * never materializes sibling hunks. The 20_000-character highlight cut is a
 * fatia 2 render decision — this module does not truncate text.
 */
import {
  isSafeReviewSegment,
  parseReviewNote,
  type ReviewNote,
} from "../worktree/reviewNotes.js";
import type {
  ChangeStatus,
  DiffHunk,
  DiffLine,
  ParsedUnifiedDiff,
} from "../worktree/review.js";
import {
  isReviewK,
  REVIEW_NOTE_LINE_MAX,
  REVIEW_NOTE_PATH_MAX_CHARS,
  REVIEW_NOTE_REF_MAX_CHARS,
} from "./reviewCommands.js";

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

/**
 * Named query door for one file of hunks. Fatia 2 adds this method to protocol.ts;
 * this slice names it so the screen does not invent a verb. `review.view` stays
 * notes-only and protocol.ts is not touched here (it needed no new field).
 */
export const REVIEW_DIFF_QUERY_METHOD = "review.diff" as const;

export const REVIEW_DIFF_HUNK_LIMIT = 10_000;
export const REVIEW_DIFF_LINE_LIMIT = 100_000;
export const REVIEW_DIFF_LINE_CHARS_MAX = 1_000_000;
export const REVIEW_DIFF_LABEL_MAX_CHARS = 256;

export type ReviewDiffFormatV1 = "unified";
export type ReviewDiffLineV1 = DiffLine;
export type ReviewDiffHunkV1 = DiffHunk;

/** Input of `review.diff`. `path` is required — omitting it would fetch every file. */
export interface ReviewDiffQueryInputV1 {
  worktree: string;
  /** Post-image path; for a deletion, the deleted path. */
  path: string;
  baseRef: string;
  /** Set for a committed range (`baseRef..headRef`). Omit for a worktree compare. */
  headRef?: string;
}

/**
 * One selected file on the wire. Unified is the only format (fatia 0). The file
 * list is `ChangedFile[]` from the existing worktree-review payload — already
 * includes deletions — and is not repeated here.
 */
export interface ReviewDiffFileV1 {
  schemaVersion: 1;
  format: ReviewDiffFormatV1;
  worktree: string;
  path: string;
  from?: string;
  status: ChangeStatus;
  baseRef: string;
  /** Named current side (SDD 501): `"worktree"` or an abbreviated head. */
  currentLabel: string;
  headRef?: string;
  binary: boolean;
  hunks: ReviewDiffHunkV1[];
}

export function isReviewDiffQueryInputV1(value: unknown): value is ReviewDiffQueryInputV1 {
  if (!isRecord(value)) return false;
  const keys = ["worktree", "path", "baseRef"];
  if (value.headRef !== undefined) keys.push("headRef");
  return exactKeys(value, keys)
    && typeof value.worktree === "string"
    && isSafeReviewSegment(value.worktree)
    && value.worktree.length <= 128
    && isReviewFilePath(value.path)
    && isReviewRef(value.baseRef)
    && (value.headRef === undefined || isReviewRef(value.headRef));
}

export function parseReviewDiffQueryInputV1(value: unknown): ReviewDiffQueryInputV1 {
  if (!isReviewDiffQueryInputV1(value)) throw new Error("invalid review diff query input");
  return {
    worktree: value.worktree,
    path: value.path,
    baseRef: value.baseRef,
    ...(value.headRef !== undefined ? { headRef: value.headRef } : {}),
  };
}

export function isReviewDiffFileV1(value: unknown): value is ReviewDiffFileV1 {
  try {
    parseReviewDiffFileV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseReviewDiffFileV1(value: unknown): ReviewDiffFileV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.format !== "unified") {
    throw new Error("invalid review diff file");
  }
  const keys = ["schemaVersion", "format", "worktree", "path", "status", "baseRef", "currentLabel", "binary", "hunks"];
  if (value.from !== undefined) keys.push("from");
  if (value.headRef !== undefined) keys.push("headRef");
  if (!exactKeys(value, keys)) throw new Error("invalid review diff file");
  if (typeof value.worktree !== "string" || !isSafeReviewSegment(value.worktree) || value.worktree.length > 128) {
    throw new Error("invalid review diff file worktree");
  }
  if (!isReviewFilePath(value.path)) throw new Error("invalid review diff file path");
  if (value.from !== undefined && !isReviewFilePath(value.from)) throw new Error("invalid review diff file from");
  if (!isChangeStatus(value.status)) throw new Error("invalid review diff file status");
  if (!isReviewRef(value.baseRef)) throw new Error("invalid review diff file baseRef");
  if (!isReviewLabel(value.currentLabel)) throw new Error("invalid review diff file currentLabel");
  if (value.headRef !== undefined && !isReviewRef(value.headRef)) throw new Error("invalid review diff file headRef");
  if (typeof value.binary !== "boolean") throw new Error("invalid review diff file binary");
  if (!Array.isArray(value.hunks) || value.hunks.length > REVIEW_DIFF_HUNK_LIMIT) {
    throw new Error("review diff file exceeds its hunk limit");
  }
  const hunks: ReviewDiffHunkV1[] = [];
  let totalLines = 0;
  for (const raw of value.hunks) {
    const hunk = parseReviewDiffHunkV1(raw);
    totalLines += hunk.lines.length;
    if (totalLines > REVIEW_DIFF_LINE_LIMIT) throw new Error("review diff file exceeds its line limit");
    hunks.push(hunk);
  }
  return {
    schemaVersion: 1,
    format: "unified",
    worktree: value.worktree,
    path: value.path,
    ...(value.from !== undefined ? { from: value.from } : {}),
    status: value.status,
    baseRef: value.baseRef,
    currentLabel: value.currentLabel,
    ...(value.headRef !== undefined ? { headRef: value.headRef } : {}),
    binary: value.binary,
    hunks,
  };
}

/**
 * Wrap parser output as the versioned one-file view. `status` from the changed-file
 * list wins when supplied (untracked is `A` even if git never emitted a header).
 */
export function projectReviewDiffFileV1(opts: {
  worktree: string;
  path: string;
  baseRef: string;
  parsed: ParsedUnifiedDiff;
  status?: ChangeStatus;
  from?: string;
  currentLabel?: string;
  headRef?: string;
}): ReviewDiffFileV1 {
  const path = opts.path || opts.parsed.path;
  const from = opts.from ?? opts.parsed.from;
  return parseReviewDiffFileV1({
    schemaVersion: 1,
    format: "unified",
    worktree: opts.worktree,
    path,
    ...(from && from !== path ? { from } : {}),
    status: opts.status ?? opts.parsed.status,
    baseRef: opts.baseRef,
    currentLabel: opts.currentLabel ?? "worktree",
    ...(opts.headRef !== undefined ? { headRef: opts.headRef } : {}),
    binary: opts.parsed.binary,
    hunks: opts.parsed.hunks,
  });
}

function parseReviewDiffHunkV1(value: unknown): ReviewDiffHunkV1 {
  if (!isRecord(value) || !exactKeys(value, ["oldStart", "oldLines", "newStart", "newLines", "header", "lines"])) {
    throw new Error("invalid review diff hunk");
  }
  if (!isHunkBound(value.oldStart) || !isHunkCount(value.oldLines)
    || !isHunkBound(value.newStart) || !isHunkCount(value.newLines)) {
    throw new Error("invalid review diff hunk bounds");
  }
  if (typeof value.header !== "string" || value.header.includes("\0") || value.header.length > REVIEW_DIFF_LINE_CHARS_MAX) {
    throw new Error("invalid review diff hunk header");
  }
  if (!Array.isArray(value.lines) || value.lines.length > REVIEW_DIFF_LINE_LIMIT) {
    throw new Error("invalid review diff hunk lines");
  }
  return {
    oldStart: value.oldStart,
    oldLines: value.oldLines,
    newStart: value.newStart,
    newLines: value.newLines,
    header: value.header,
    lines: value.lines.map(parseReviewDiffLineV1),
  };
}

function parseReviewDiffLineV1(value: unknown): ReviewDiffLineV1 {
  if (!isRecord(value)) throw new Error("invalid review diff line");
  const keys = ["kind", "text", "oldLine", "newLine"];
  if (value.noNewline !== undefined) keys.push("noNewline");
  if (!exactKeys(value, keys)) throw new Error("invalid review diff line");
  if (value.kind !== "context" && value.kind !== "add" && value.kind !== "del") {
    throw new Error("invalid review diff line kind");
  }
  if (typeof value.text !== "string" || value.text.includes("\0") || value.text.length > REVIEW_DIFF_LINE_CHARS_MAX) {
    throw new Error("invalid review diff line text");
  }
  if (value.noNewline !== undefined && value.noNewline !== true) {
    throw new Error("invalid review diff line noNewline");
  }
  if (value.kind === "add") {
    if (value.oldLine !== null || !isContentLine(value.newLine)) throw new Error("invalid review diff add line");
  } else if (value.kind === "del") {
    if (!isContentLine(value.oldLine) || value.newLine !== null) throw new Error("invalid review diff del line");
  } else if (!isContentLine(value.oldLine) || !isContentLine(value.newLine)) {
    throw new Error("invalid review diff context line");
  }
  return {
    kind: value.kind,
    text: value.text,
    oldLine: value.oldLine,
    newLine: value.newLine,
    ...(value.noNewline === true ? { noNewline: true as const } : {}),
  };
}

function isChangeStatus(value: unknown): value is ChangeStatus {
  return value === "A" || value === "M" || value === "D" || value === "R" || value === "C" || value === "T";
}

function isHunkBound(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= REVIEW_NOTE_LINE_MAX;
}

function isHunkCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= REVIEW_DIFF_LINE_LIMIT;
}

function isContentLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= REVIEW_NOTE_LINE_MAX;
}

function isReviewLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= REVIEW_DIFF_LABEL_MAX_CHARS
    && !value.includes("\0");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
