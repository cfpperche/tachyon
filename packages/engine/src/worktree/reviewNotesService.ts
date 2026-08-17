/**
 * SDD 511 fatia 2 / t-115091 — product doors for review notes.
 *
 * Read always goes through `readReviewNotes` (reconcile-on-read). Mutate
 * persists a captured note or a hint; it never treats a pushed range as
 * position. This file does not change reviewNotes.ts / reviewNotesStore.ts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createReviewNote,
  isSafeReviewSegment,
  requireReviewContextK,
  type ReviewNote,
} from "./reviewNotes.js";
import { loadReviewNotes, persistReviewNote, readReviewNotes } from "./reviewNotesStore.js";
import type { ChangedFile } from "./review.js";
import {
  parseReviewMutationInputV1,
  type ReviewMutationInputV1,
} from "../runtime-api/reviewCommands.js";
import {
  parseReviewNotesViewV1,
  type ReviewNotesViewV1,
} from "../runtime-api/reviewProjection.js";

export interface ReviewMutationResult {
  action: ReviewMutationInputV1["action"];
  id: string;
  changed: boolean;
}

export function applyReviewMutation(opts: {
  workspaceRoot: string;
  checkoutRoot: string;
  rawInput: unknown;
}): ReviewMutationResult {
  const input = parseReviewMutationInputV1(opts.rawInput);
  if (input.action === "note.hint") {
    const existing = findNote(opts.workspaceRoot, input.worktree, input.id);
    if (!existing) return { action: input.action, id: input.id, changed: false };
    persistReviewNote(opts.workspaceRoot, { ...existing, hintRange: { ...input.hintRange } });
    return { action: input.action, id: input.id, changed: true };
  }
  const content = readCheckoutText(opts.checkoutRoot, input.path);
  if (content === undefined) {
    throw new Error(`review note file '${input.path}' is not readable in the worktree checkout`);
  }
  const created = createReviewNote({
    identity: {
      worktree: input.worktree,
      baseRef: input.baseRef,
      path: input.path,
      side: "modified",
      commentId: input.id,
    },
    body: input.body,
    content,
    line: input.line,
    k: input.k,
    ...(input.headRef !== undefined ? { headRef: input.headRef } : {}),
    ...(input.hintRange !== undefined ? { hintRange: input.hintRange } : {}),
    ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
  });
  if (!created) throw new Error("review note snapshot could not be captured");
  persistReviewNote(opts.workspaceRoot, created);
  return { action: input.action, id: input.id, changed: true };
}

/**
 * The read door. Loads notes, reads current checkout files, and returns the
 * reconciled view — never the raw persisted range.
 */
export function projectReviewNotes(opts: {
  workspaceRoot: string;
  checkoutRoot: string;
  worktree: string;
  k: number;
  changedFiles?: readonly ChangedFile[];
}): ReviewNotesViewV1 {
  requireReviewContextK(opts.k);
  if (!isSafeReviewSegment(opts.worktree)) {
    throw new Error("review notes worktree must be a single safe path segment");
  }
  const loaded = loadReviewNotes(opts.workspaceRoot, opts.worktree);
  const files = new Map<string, string>();
  for (const note of loaded) {
    addCheckoutFile(files, opts.checkoutRoot, note.lastPath);
    addCheckoutFile(files, opts.checkoutRoot, note.identity.path);
  }
  const { notes } = readReviewNotes(opts.workspaceRoot, opts.worktree, files, opts.k, {
    ...(opts.changedFiles ? { changedFiles: opts.changedFiles } : {}),
  });
  return parseReviewNotesViewV1({
    schemaVersion: 1,
    worktree: opts.worktree,
    k: opts.k,
    notes,
  });
}

function findNote(workspaceRoot: string, worktree: string, commentId: string): ReviewNote | undefined {
  return loadReviewNotes(workspaceRoot, worktree).find((note) => note.identity.commentId === commentId);
}

function addCheckoutFile(files: Map<string, string>, checkoutRoot: string, relPath: string): void {
  if (files.has(relPath)) return;
  const content = readCheckoutText(checkoutRoot, relPath);
  if (content !== undefined) files.set(relPath, content);
}

function readCheckoutText(checkoutRoot: string, relPath: string): string | undefined {
  if (!relPath || relPath.includes("\0") || path.isAbsolute(relPath)) return undefined;
  const root = path.resolve(checkoutRoot);
  const resolved = path.resolve(root, relPath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) return undefined;
  try {
    if (!fs.statSync(resolved).isFile()) return undefined;
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}
