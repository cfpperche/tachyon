/**
 * Worktree diff-review (spec 213 / C2) — pure helpers. The side-effecting git reads
 * (`changedFiles`, `showFile`) live on WorktreeManager; the VS Code wiring (content
 * provider + quick-pick + vscode.diff) lives in the extension. This module just parses
 * git output and decides which side of a diff is empty — unit-tested with no git.
 */

export type ChangeStatus = "A" | "M" | "D" | "R" | "C";

export interface ChangedFile {
  status: ChangeStatus;
  /** post-image path (the file as it exists now; for a rename/copy, the new name) */
  path: string;
  /** for a rename/copy, the pre-image path (the base side reads from here) */
  from?: string;
}

/**
 * Parse `git diff --name-status <baseRef>` (working-tree compare). Tab-separated:
 *   `M\tsrc/a.ts` · `A\tnew.ts` · `D\told.ts` · `R096\told\tnew` · `C075\tsrc\tcopy`
 * Rename/copy carry a similarity number on the status and an extra (old→new) path; we keep
 * the NEW path as `path` and the OLD as `from` (so the base side can read the old content).
 */
export function parseNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const cols = line.split("\t");
    const code = cols[0]?.[0] as ChangeStatus | undefined;
    if (!code || !"AMDRC".includes(code)) continue;
    if ((code === "R" || code === "C") && cols.length >= 3) {
      files.push({ status: code, from: cols[1], path: cols[2] });
    } else if (cols[1]) {
      files.push({ status: code, path: cols[1] });
    }
  }
  return files;
}

/**
 * Union tracked changes (from parseNameStatus) with untracked files (newline list from
 * `git ls-files --others --exclude-standard`), which count as added. Dedup by path
 * (tracked wins), sorted by path for a stable quick-pick.
 */
export function mergeChanges(tracked: ChangedFile[], untrackedOut: string): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of tracked) byPath.set(f.path, f);
  for (const raw of untrackedOut.split("\n")) {
    const p = raw.trim();
    if (p.length > 0 && !byPath.has(p)) byPath.set(p, { status: "A", path: p });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Which side of the base↔current diff is empty (no content to fetch) for a given status. */
export function emptySides(status: ChangeStatus): { baseEmpty: boolean; currentEmpty: boolean } {
  return {
    baseEmpty: status === "A", // added/untracked have no base version
    currentEmpty: status === "D", // deleted have no current version
  };
}

/** The path to read the BASE (baseRef) content from — the pre-image for a rename/copy. */
export function baseSidePath(f: ChangedFile): string {
  return f.from ?? f.path;
}

/** Human diff-editor title, e.g. `src/a.ts (abc123f ↔ worktree)`. */
export function diffTitle(file: ChangedFile, baseRef: string): string {
  const short = baseRef.length > 8 ? baseRef.slice(0, 8) : baseRef;
  const rename = file.from && file.from !== file.path ? `${file.from} → ${file.path}` : file.path;
  return `${rename} (${short} ↔ worktree)`;
}
