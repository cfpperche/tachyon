/**
 * Worktree diff-review (spec 213 / C2) — pure helpers. The side-effecting git reads
 * (`changedFiles`, `showFile`) live on WorktreeManager; the VS Code wiring (content
 * provider + quick-pick + vscode.diff) lives in the extension. This module just parses
 * git output and decides which side of a diff is empty — unit-tested with no git.
 */

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface ChangedFile {
  status: ChangeStatus;
  /** post-image path (the file as it exists now; for a rename/copy, the new name) */
  path: string;
  /** for a rename/copy, the pre-image path (the base side reads from here) */
  from?: string;
}

/**
 * Parse `git diff --name-status -z <baseRef>` (working-tree compare). `-z` makes git emit
 * NUL-delimited, UNquoted fields — `status\0path\0` per change, or `R###\0old\0new\0` for a
 * rename/copy. (Without `-z`, git C-quotes non-ASCII/space/tab paths, which then break the
 * base/current sides.) We keep the NEW path as `path` and the OLD as `from`.
 */
export function parseNameStatus(out: string): ChangedFile[] {
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i][0] as ChangeStatus;
    if (!"AMDRCT".includes(code)) {
      i += 1; // skip an unexpected token rather than misalign
      continue;
    }
    if (code === "R" || code === "C") {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from && to) files.push({ status: code, from, path: to });
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (p) files.push({ status: code, path: p });
      i += 2;
    }
  }
  return files;
}

/**
 * Union tracked changes (from parseNameStatus) with untracked files (NUL-delimited list from
 * `git ls-files -z --others --exclude-standard`), which count as added. Dedup by path
 * (tracked wins), sorted by path for a stable quick-pick.
 */
export function mergeChanges(tracked: ChangedFile[], untrackedZ: string): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const f of tracked) byPath.set(f.path, f);
  for (const p of untrackedZ.split("\0")) {
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
