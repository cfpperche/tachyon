/**
 * SDD 511 / t-77736f — diff-review line notes, the engine half.
 *
 * Snapshot is truth; a platform range is a hint. Identity never mentions a URI
 * (worktree + baseRef + path + side + commentId). headRef lives on the snapshot
 * so a note against an old HEAD reconciles instead of vanishing. Ambiguity is
 * refused, never resolved. Reconciliation is pure and runs on read.
 *
 * k is an explicit parameter of capture and reconcile. The product default is
 * measured by slice 0b (t-232111); this module does not invent one.
 */
import type { ChangedFile } from "./review.js";

export const REVIEW_NOTE_SCHEMA_VERSION = 1 as const;
export const REVIEW_NOTES_REL = ".tachyon/review";

/** Skip the costly scan above this size and degrade explicitly (markdownEngine.ts:13 mould). */
export const REVIEW_NOTE_RECONCILE_MAX_CHARS = 200_000;

export type ReviewNoteSide = "modified";
export type ReviewNoteStatus = "active" | "outdated";
export type ReviewOutdatedReason = "deleted" | "ambiguous" | "snapshot-mismatch";
export type ReviewReconcileKind = "migrated" | "outdated" | "unchanged" | "degraded";

export interface ReviewNoteIdentity {
  worktree: string;
  baseRef: string;
  path: string;
  side: ReviewNoteSide;
  commentId: string;
}

export interface ReviewLineRange {
  startLine: number;
  endLine: number;
}

export interface ReviewNoteSnapshot {
  /** HEAD at capture — NOT part of identity. */
  headRef?: string;
  /** 1-based line of the anchored line at capture */
  line: number;
  lineText: string;
  /** k lines immediately before, in file order (shorter than k at file start). */
  before: string[];
  /** k lines immediately after, in file order (shorter than k at file end). */
  after: string[];
  k: number;
}

export interface ReviewNoteDegraded {
  reason: "oversized";
  limit: number;
  bytes: number;
}

export interface ReviewHintDisagreement {
  hint: ReviewLineRange;
  derived: ReviewLineRange;
}

export interface ReviewReconcileJournal {
  kind: ReviewReconcileKind;
  fromLine: number;
  toLine: number;
  fromPath: string;
  toPath: string;
  reason?: ReviewOutdatedReason;
  hintDisagreed?: ReviewHintDisagreement;
  degraded?: ReviewNoteDegraded;
}

export interface ReviewNote {
  schemaVersion: typeof REVIEW_NOTE_SCHEMA_VERSION;
  identity: ReviewNoteIdentity;
  snapshot: ReviewNoteSnapshot;
  body: string;
  status: ReviewNoteStatus;
  range: ReviewLineRange;
  /** Current path after a unique rename. identity.path stays the birth path. */
  lastPath: string;
  lastLine: number;
  outdatedReason?: ReviewOutdatedReason;
  degraded?: ReviewNoteDegraded;
  /** Platform range — a hint, never truth. */
  hintRange?: ReviewLineRange;
  lastReconcile?: ReviewReconcileJournal;
}

export interface CreateReviewNoteInput {
  identity: ReviewNoteIdentity;
  body: string;
  content: string;
  line: number;
  k: number;
  headRef?: string;
  hintRange?: ReviewLineRange;
  endLine?: number;
}

export interface ReconcileNoteOpts {
  changedFiles?: readonly ChangedFile[];
  maxChars?: number;
  knownPaths?: ReadonlySet<string>;
}

const K_ERROR =
  "review note k is a required non-negative integer parameter; the product default is measured by slice 0b (t-232111) and is not invented here";

export function reviewNoteRelDir(worktree: string, commentId: string): string {
  return `${REVIEW_NOTES_REL}/${worktree}/${commentId}`;
}

export function isSafeReviewSegment(value: string): boolean {
  return Boolean(value) && !value.includes("\0") && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

export function requireReviewContextK(k: unknown): asserts k is number {
  if (typeof k !== "number" || !Number.isInteger(k) || k < 0) throw new Error(K_ERROR);
}

export function noteIdentityKey(id: ReviewNoteIdentity): string {
  return [id.worktree, id.baseRef, id.path, id.side, id.commentId].join("\0");
}

export function splitReviewLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function captureSnapshot(
  content: string,
  line: number,
  k: number,
  headRef?: string,
): ReviewNoteSnapshot | undefined {
  requireReviewContextK(k);
  if (!Number.isInteger(line) || line < 1) return undefined;
  const lines = splitReviewLines(content);
  const index = line - 1;
  if (index >= lines.length) return undefined;
  return {
    ...(headRef !== undefined ? { headRef } : {}),
    line,
    lineText: lines[index],
    before: lines.slice(Math.max(0, index - k), index),
    after: lines.slice(index + 1, index + 1 + k),
    k,
  };
}

export function createReviewNote(input: CreateReviewNoteInput): ReviewNote | undefined {
  const snapshot = captureSnapshot(input.content, input.line, input.k, input.headRef);
  if (!snapshot) return undefined;
  const endLine = input.endLine ?? input.line;
  const range: ReviewLineRange = {
    startLine: input.line,
    endLine: endLine >= input.line ? endLine : input.line,
  };
  return {
    schemaVersion: REVIEW_NOTE_SCHEMA_VERSION,
    identity: {
      worktree: input.identity.worktree,
      baseRef: input.identity.baseRef,
      path: input.identity.path,
      side: "modified",
      commentId: input.identity.commentId,
    },
    snapshot,
    body: input.body,
    status: "active",
    range,
    lastPath: input.identity.path,
    lastLine: input.line,
    ...(input.hintRange ? { hintRange: { ...input.hintRange } } : {}),
  };
}

export function reconcileNote(
  note: ReviewNote,
  content: string | undefined,
  k: number,
  opts: ReconcileNoteOpts = {},
): { note: ReviewNote; journal: ReviewReconcileJournal } {
  requireReviewContextK(k);
  const maxChars = opts.maxChars ?? REVIEW_NOTE_RECONCILE_MAX_CHARS;
  const resolved = resolveNotePath(note, opts.changedFiles ?? [], opts.knownPaths);
  const fromLine = note.lastLine;
  const fromPath = note.lastPath;

  if (!resolved.unique) {
    return finish(note, {
      kind: "outdated",
      fromLine,
      toLine: fromLine,
      fromPath,
      toPath: fromPath,
      reason: "ambiguous",
    }, { status: "outdated", outdatedReason: "ambiguous" });
  }

  const toPath = resolved.path;

  if (content === undefined) {
    return finish(note, {
      kind: "outdated",
      fromLine,
      toLine: fromLine,
      fromPath,
      toPath,
      reason: "deleted",
    }, { status: "outdated", lastPath: toPath, outdatedReason: "deleted" });
  }

  if (content.length > maxChars) {
    const degraded: ReviewNoteDegraded = { reason: "oversized", limit: maxChars, bytes: content.length };
    return finish(note, {
      kind: "degraded",
      fromLine,
      toLine: fromLine,
      fromPath,
      toPath,
      degraded,
    }, { lastPath: toPath, degraded });
  }

  const lines = splitReviewLines(content);
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matchesSnapshotAt(lines, i, note.snapshot, k)) matches.push(i);
  }

  if (matches.length === 1) {
    const toLine = matches[0] + 1;
    const lineDelta = toLine - note.lastLine;
    const range: ReviewLineRange = {
      startLine: note.range.startLine + lineDelta,
      endLine: note.range.endLine + lineDelta,
    };
    const kind: ReviewReconcileKind = toLine === fromLine && toPath === fromPath ? "unchanged" : "migrated";
    return finish(note, {
      kind,
      fromLine,
      toLine,
      fromPath,
      toPath,
      ...hintDisagreement(note, range),
    }, {
      status: "active",
      lastLine: toLine,
      lastPath: toPath,
      range,
    });
  }

  if (matches.length > 1) {
    return finish(note, {
      kind: "outdated",
      fromLine,
      toLine: fromLine,
      fromPath,
      toPath,
      reason: "ambiguous",
    }, { status: "outdated", lastPath: toPath, outdatedReason: "ambiguous" });
  }

  const reason: ReviewOutdatedReason = snapshotLinePresent(lines, note.snapshot.lineText)
    ? "snapshot-mismatch"
    : "deleted";
  return finish(note, {
    kind: "outdated",
    fromLine,
    toLine: fromLine,
    fromPath,
    toPath,
    reason,
  }, { status: "outdated", lastPath: toPath, outdatedReason: reason });
}

export function reconcileNotes(
  notes: readonly ReviewNote[],
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  k: number,
  opts: Omit<ReconcileNoteOpts, "knownPaths"> = {},
): { notes: ReviewNote[]; journal: ReviewReconcileJournal[] } {
  requireReviewContextK(k);
  const knownPaths = filePaths(files);
  const out: ReviewNote[] = [];
  const journal: ReviewReconcileJournal[] = [];
  for (const note of notes) {
    const resolved = resolveNotePath(note, opts.changedFiles ?? [], knownPaths);
    const content = resolved.unique ? fileContent(files, resolved.path) : undefined;
    const next = reconcileNote(note, content, k, { ...opts, knownPaths });
    out.push(next.note);
    journal.push(next.journal);
  }
  return { notes: out, journal };
}

export function parseReviewNote(value: unknown): ReviewNote | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const identity = parseIdentity(o.identity);
  const snapshot = parseSnapshot(o.snapshot);
  const range = parseRange(o.range);
  if (!identity || !snapshot || !range) return undefined;
  if (typeof o.body !== "string") return undefined;
  if (o.status !== "active" && o.status !== "outdated") return undefined;
  const lastPath = typeof o.lastPath === "string" ? o.lastPath : identity.path;
  const lastLine = Number.isInteger(o.lastLine) ? (o.lastLine as number) : range.startLine;
  if (!Number.isInteger(lastLine) || lastLine < 1) return undefined;
  const hintRange = parseRange(o.hintRange);
  const degraded = parseDegraded(o.degraded);
  const lastReconcile = parseJournal(o.lastReconcile);
  const outdatedReason = parseOutdatedReason(o.outdatedReason);
  return {
    schemaVersion: REVIEW_NOTE_SCHEMA_VERSION,
    identity,
    snapshot,
    body: o.body,
    status: o.status,
    range,
    lastPath,
    lastLine,
    ...(outdatedReason ? { outdatedReason } : {}),
    ...(degraded ? { degraded } : {}),
    ...(hintRange ? { hintRange } : {}),
    ...(lastReconcile ? { lastReconcile } : {}),
  };
}

function resolveNotePath(
  note: ReviewNote,
  changedFiles: readonly ChangedFile[],
  knownPaths?: ReadonlySet<string>,
): { path: string; unique: boolean } {
  if (knownPaths?.has(note.lastPath)) return { path: note.lastPath, unique: true };
  const fromLast = followRename(note.lastPath, changedFiles);
  if (!fromLast.unique) return fromLast;
  if (fromLast.path !== note.lastPath) return fromLast;
  if (note.identity.path !== note.lastPath) {
    if (knownPaths?.has(note.identity.path)) return { path: note.identity.path, unique: true };
    return followRename(note.identity.path, changedFiles);
  }
  return fromLast;
}

function followRename(filePath: string, changedFiles: readonly ChangedFile[]): { path: string; unique: boolean } {
  const hits = changedFiles.filter((f) => f.status === "R" && f.from === filePath);
  if (hits.length === 1) return { path: hits[0].path, unique: true };
  if (hits.length > 1) return { path: filePath, unique: false };
  return { path: filePath, unique: true };
}

function matchesSnapshotAt(lines: string[], index: number, snapshot: ReviewNoteSnapshot, k: number): boolean {
  if (lines[index] !== snapshot.lineText) return false;
  const beforeN = Math.min(k, snapshot.before.length);
  const afterN = Math.min(k, snapshot.after.length);
  const before = snapshot.before.slice(snapshot.before.length - beforeN);
  const after = snapshot.after.slice(0, afterN);
  if (index < before.length) return false;
  if (index + 1 + after.length > lines.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (lines[index - before.length + i] !== before[i]) return false;
  }
  for (let i = 0; i < after.length; i++) {
    if (lines[index + 1 + i] !== after[i]) return false;
  }
  return true;
}

function snapshotLinePresent(lines: readonly string[], lineText: string): boolean {
  return lines.includes(lineText);
}

function hintDisagreement(
  note: ReviewNote,
  derived: ReviewLineRange,
): { hintDisagreed?: ReviewHintDisagreement } {
  const hint = note.hintRange;
  if (!hint) return {};
  if (hint.startLine === derived.startLine && hint.endLine === derived.endLine) return {};
  return { hintDisagreed: { hint: { ...hint }, derived: { ...derived } } };
}

function finish(
  note: ReviewNote,
  journal: ReviewReconcileJournal,
  patch: Partial<Pick<ReviewNote, "status" | "lastLine" | "lastPath" | "range" | "outdatedReason" | "degraded">>,
): { note: ReviewNote; journal: ReviewReconcileJournal } {
  const next: ReviewNote = {
    ...note,
    ...patch,
    lastReconcile: journal,
  };
  if (patch.status === "active") {
    delete next.outdatedReason;
    delete next.degraded;
  } else if (patch.outdatedReason) {
    delete next.degraded;
  }
  return { note: next, journal };
}

function parseIdentity(value: unknown): ReviewNoteIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.worktree !== "string" || typeof o.baseRef !== "string") return undefined;
  if (typeof o.path !== "string" || typeof o.commentId !== "string") return undefined;
  if (o.side !== "modified") return undefined;
  return {
    worktree: o.worktree,
    baseRef: o.baseRef,
    path: o.path,
    side: "modified",
    commentId: o.commentId,
  };
}

function parseSnapshot(value: unknown): ReviewNoteSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (!Number.isInteger(o.line) || (o.line as number) < 1) return undefined;
  if (typeof o.lineText !== "string") return undefined;
  if (!Array.isArray(o.before) || !o.before.every((l) => typeof l === "string")) return undefined;
  if (!Array.isArray(o.after) || !o.after.every((l) => typeof l === "string")) return undefined;
  if (typeof o.k !== "number" || !Number.isInteger(o.k) || o.k < 0) return undefined;
  return {
    ...(typeof o.headRef === "string" ? { headRef: o.headRef } : {}),
    line: o.line as number,
    lineText: o.lineText,
    before: o.before as string[],
    after: o.after as string[],
    k: o.k,
  };
}

function parseRange(value: unknown): ReviewLineRange | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (!Number.isInteger(o.startLine) || !Number.isInteger(o.endLine)) return undefined;
  if ((o.startLine as number) < 1 || (o.endLine as number) < 1) return undefined;
  return { startLine: o.startLine as number, endLine: o.endLine as number };
}

function parseDegraded(value: unknown): ReviewNoteDegraded | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (o.reason !== "oversized") return undefined;
  if (!Number.isInteger(o.limit) || !Number.isInteger(o.bytes)) return undefined;
  return { reason: "oversized", limit: o.limit as number, bytes: o.bytes as number };
}

function parseOutdatedReason(value: unknown): ReviewOutdatedReason | undefined {
  if (value === "deleted" || value === "ambiguous" || value === "snapshot-mismatch") return value;
  return undefined;
}

function parseJournal(value: unknown): ReviewReconcileJournal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = value as Record<string, unknown>;
  if (o.kind !== "migrated" && o.kind !== "outdated" && o.kind !== "unchanged" && o.kind !== "degraded") return undefined;
  if (!Number.isInteger(o.fromLine) || !Number.isInteger(o.toLine)) return undefined;
  if (typeof o.fromPath !== "string" || typeof o.toPath !== "string") return undefined;
  const reason = parseOutdatedReason(o.reason);
  const hint = o.hintDisagreed;
  let hintDisagreed: ReviewHintDisagreement | undefined;
  if (typeof hint === "object" && hint !== null) {
    const h = hint as Record<string, unknown>;
    const hintRange = parseRange(h.hint);
    const derived = parseRange(h.derived);
    if (hintRange && derived) hintDisagreed = { hint: hintRange, derived };
  }
  const degraded = parseDegraded(o.degraded);
  return {
    kind: o.kind,
    fromLine: o.fromLine as number,
    toLine: o.toLine as number,
    fromPath: o.fromPath,
    toPath: o.toPath,
    ...(reason ? { reason } : {}),
    ...(hintDisagreed ? { hintDisagreed } : {}),
    ...(degraded ? { degraded } : {}),
  };
}

function filePaths(files: ReadonlyMap<string, string> | Readonly<Record<string, string>>): Set<string> {
  return files instanceof Map ? new Set(files.keys()) : new Set(Object.keys(files));
}

function fileContent(
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  filePath: string,
): string | undefined {
  return files instanceof Map ? files.get(filePath) : files[filePath];
}
