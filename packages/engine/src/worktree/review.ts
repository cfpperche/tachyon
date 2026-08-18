/**
 * Worktree diff-review (spec 213 / C2, SDD 513 fatia 1) — pure helpers. The
 * side-effecting git reads (`changedFiles`, `showFile`) live on WorktreeManager;
 * the VS Code wiring (content provider + quick-pick + vscode.diff) lives in the
 * extension. This module parses git output — name-status and unified hunks —
 * and decides which side of a diff is empty. Unit-tested with no git spawn.
 *
 * SDD 513: `parseUnifiedDiff` is the hunk door. The versioned wire that carries
 * one file of those hunks is `ReviewDiffFileV1` in runtime-api/reviewProjection.ts.
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

/**
 * Human diff-editor title, e.g. `src/a.ts (abc123f ↔ worktree)`.
 *
 * SDD 501 — the current side is NAMED rather than assumed to be the worktree. The land door compares
 * committed history (`trunkRef..head`), and a title that said "worktree" over a diff read out of a
 * commit would be the one lie this surface cannot afford: a review at the land door is read as
 * evidence about what lands.
 */
export function diffTitle(file: ChangedFile, baseRef: string, currentLabel = "worktree"): string {
  const abbreviate = (ref: string): string => (ref.length > 8 ? ref.slice(0, 8) : ref);
  const rename = file.from && file.from !== file.path ? `${file.from} → ${file.path}` : file.path;
  return `${rename} (${abbreviate(baseRef)} ↔ ${abbreviate(currentLabel)})`;
}

export type DiffLineKind = "context" | "add" | "del";

/** One unified-diff line. `text` is the payload without the +/-/space prefix and without the newline. */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based pre-image line; null on an added line. */
  oldLine: number | null;
  /** 1-based post-image line; null on a deleted line. Notes (SDD 511) attach here. */
  newLine: number | null;
  /** Present when git emitted `\ No newline at end of file` after this line. */
  noNewline?: true;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@`, trimmed; empty when git sent none. */
  header: string;
  lines: DiffLine[];
}

/** One file of unified diff. The wire view wraps this as `ReviewDiffFileV1` (one path, never a list). */
export interface ParsedUnifiedDiff {
  path: string;
  from?: string;
  status: ChangeStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse `git diff [<baseRef> [<headRef>]] -- <path>` (or `git show` of a one-file commit).
 *
 * One file only: a second `diff --git` is an error, not a silent drop — the contract fetches
 * one path, and hiding a sibling would be the 131-file mistake. Empty stdout is a valid
 * mode-only / identical result (`hunks: []`). Binary files set `binary: true` and carry no hunks.
 * Deletion is status `D` with `kind: "del"` lines (`newLine` null). Content is never truncated.
 */
export function parseUnifiedDiff(out: string): ParsedUnifiedDiff {
  const empty: ParsedUnifiedDiff = { path: "", status: "M", binary: false, hunks: [] };
  if (out.length === 0) return empty;

  let path = "";
  let from: string | undefined;
  let status: ChangeStatus = "M";
  let binary = false;
  let seenFile = false;
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const finishHunk = (): void => {
    hunk = undefined;
  };

  for (const raw of splitDiffText(out)) {
    if (raw.startsWith("diff --git ")) {
      if (seenFile) throw new Error("unified diff contains more than one file");
      seenFile = true;
      finishHunk();
      const pair = parseDiffGitPaths(raw.slice("diff --git ".length));
      if (pair) {
        const [oldPath, newPath] = pair;
        path = newPath;
        if (oldPath !== newPath) from = oldPath;
      }
      continue;
    }
    if (raw.startsWith("rename from ")) {
      from = unquoteGitPath(raw.slice("rename from ".length));
      status = "R";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      path = unquoteGitPath(raw.slice("rename to ".length));
      status = "R";
      continue;
    }
    if (raw.startsWith("copy from ")) {
      from = unquoteGitPath(raw.slice("copy from ".length));
      status = "C";
      continue;
    }
    if (raw.startsWith("copy to ")) {
      path = unquoteGitPath(raw.slice("copy to ".length));
      status = "C";
      continue;
    }
    if (raw.startsWith("deleted file mode ") || raw.startsWith("deleted file mode")) {
      status = "D";
      continue;
    }
    if (raw.startsWith("new file mode ")) {
      status = "A";
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      binary = true;
      finishHunk();
      continue;
    }
    if (raw.startsWith("--- ")) {
      const side = fileHeaderPath(raw.slice(4));
      if (side === null) {
        if (status === "M") status = "A";
      } else if (!from && side !== path) {
        from = side;
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const side = fileHeaderPath(raw.slice(4));
      if (side === null) {
        if (status === "M") status = "D";
      } else {
        path = side;
      }
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      finishHunk();
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newLine,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: hunkMatch[5].trim(),
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;
    if (raw.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const prefix = raw.charAt(0);
    const text = prefix === "+" || prefix === "-" || prefix === " " ? raw.slice(1) : raw;
    if (prefix === "+") {
      hunk.lines.push({ kind: "add", text, oldLine: null, newLine: newLine === 0 ? 1 : newLine });
      if (newLine > 0) newLine += 1;
      else newLine = 2;
      continue;
    }
    if (prefix === "-") {
      hunk.lines.push({ kind: "del", text, oldLine: oldLine === 0 ? 1 : oldLine, newLine: null });
      if (oldLine > 0) oldLine += 1;
      else oldLine = 2;
      continue;
    }
    // Context: a leading space, or (rarely) a blank line that lost its prefix.
    const ctxOld = oldLine === 0 ? 1 : oldLine;
    const ctxNew = newLine === 0 ? 1 : newLine;
    hunk.lines.push({ kind: "context", text, oldLine: ctxOld, newLine: ctxNew });
    if (oldLine > 0) oldLine += 1;
    else oldLine = 2;
    if (newLine > 0) newLine += 1;
    else newLine = 2;
  }

  return {
    path,
    ...(from && from !== path ? { from } : {}),
    status,
    binary,
    hunks: binary ? [] : hunks,
  };
}

/**
 * Synthesize a one-file unified diff for an untracked / added path so the same parser
 * (and the same wire type) carries it. Git's `diff <base> -- <path>` does not emit
 * untracked files; the engine feeds this stdout-shaped text instead of inventing a
 * second line format.
 */
export function unifiedDiffFromAddedFile(path: string, content: string): string {
  const { lines, noNewline } = splitFileContent(content);
  const parts = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
  ];
  if (lines.length === 0) return `${parts.join("\n")}\n`;
  parts.push(`@@ -0,0 +1,${lines.length} @@`);
  for (const line of lines) parts.push(`+${line}`);
  if (noNewline) parts.push("\\ No newline at end of file");
  return `${parts.join("\n")}\n`;
}

function splitDiffText(out: string): string[] {
  const body = out.endsWith("\n") ? out.slice(0, -1) : out;
  if (body.length === 0) return [];
  return body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function splitFileContent(content: string): { lines: string[]; noNewline: boolean } {
  if (content.length === 0) return { lines: [], noNewline: false };
  const noNewline = !content.endsWith("\n");
  const raw = noNewline ? content : content.slice(0, -1);
  return { lines: raw.split("\n"), noNewline };
}

function fileHeaderPath(raw: string): string | null {
  const token = raw.split("\t", 1)[0] ?? "";
  const path = unquoteGitPath(token);
  if (path === "/dev/null") return null;
  return stripDiffPrefix(path);
}

function parseDiffGitPaths(rest: string): [string, string] | undefined {
  const tokens = tokenizeGitDiffPaths(rest);
  if (tokens.length < 2) return undefined;
  return [stripDiffPrefix(tokens[0]!), stripDiffPrefix(tokens[1]!)];
}

function tokenizeGitDiffPaths(rest: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    if (rest[i] === "\"") {
      const { value, next } = readQuoted(rest, i);
      tokens.push(value);
      i = next;
      continue;
    }
    const start = i;
    while (i < rest.length && rest[i] !== " ") i += 1;
    tokens.push(rest.slice(start, i));
  }
  return tokens;
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("\"")) return trimmed;
  return readQuoted(trimmed, 0).value;
}

function readQuoted(source: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\"") return { value, next: i + 1 };
    if (ch !== "\\") {
      value += ch;
      i += 1;
      continue;
    }
    const next = source[i + 1];
    if (next === undefined) break;
    if (next === "n") { value += "\n"; i += 2; continue; }
    if (next === "t") { value += "\t"; i += 2; continue; }
    if (next === "r") { value += "\r"; i += 2; continue; }
    if (next === "\"" || next === "\\") { value += next; i += 2; continue; }
    if (next >= "0" && next <= "7") {
      const oct = source.slice(i + 1, i + 4);
      const match = /^[0-7]{1,3}/.exec(oct);
      value += String.fromCharCode(parseInt(match?.[0] ?? "0", 8));
      i += 1 + (match?.[0].length ?? 1);
      continue;
    }
    value += next;
    i += 2;
  }
  return { value, next: source.length };
}

/** Git's `a/` / `b/` (or mnemonic `i/` / `w/`) prefix on --- / +++ / diff --git paths. */
function stripDiffPrefix(path: string): string {
  return /^[a-z]\//.test(path) ? path.slice(2) : path;
}
