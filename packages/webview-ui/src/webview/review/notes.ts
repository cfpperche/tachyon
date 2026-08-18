/**
 * SDD 513 fatia 2 — which notes belong on the selected path, and where they sit.
 *
 * lastPath is the current path after a unique rename; identity.path is the birth
 * path. Same filter comments.ts already uses (notesForDocumentPath).
 */
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";

export function notesForPath(notes: readonly ReviewNote[], path: string): ReviewNote[] {
  return notes.filter((note) => note.lastPath === path || note.identity.path === path);
}

/** Notes whose lastLine is a visible post-image line of the selected file. */
export function notesOnLine(notes: readonly ReviewNote[], path: string, newLine: number): ReviewNote[] {
  return notesForPath(notes, path).filter((note) => note.lastLine === newLine);
}

/**
 * Outdated notes whose lastLine is no longer a post-image line in the rendered hunks.
 * They must stay visible — burying them is the same class of silent degrade the spec forbids.
 */
export function orphanedNotes(
  notes: readonly ReviewNote[],
  path: string,
  visibleNewLines: ReadonlySet<number>,
): ReviewNote[] {
  return notesForPath(notes, path).filter((note) => !visibleNewLines.has(note.lastLine));
}

export function noteMigrated(note: ReviewNote): boolean {
  return note.status === "active" && note.lastReconcile?.kind === "migrated";
}

export function visibleNewLinesFrom(hunks: ReadonlyArray<{ lines: ReadonlyArray<{ newLine: number | null }> }>): Set<number> {
  const out = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) out.add(line.newLine);
    }
  }
  return out;
}
