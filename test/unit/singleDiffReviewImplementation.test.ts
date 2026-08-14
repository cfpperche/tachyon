/**
 * SDD 501 — there is exactly ONE way to pick a changed file and exactly ONE way to open a diff.
 *
 * This is the guard the spec was written around. Both features already existed when 501 started; the
 * whole slice was making them REACHABLE from the land block. The single largest risk named in
 * plan.md § Risks is an agent writing a second diff flow because the existing one is in a file it did
 * not read — the `scripts/host-resources.mjs` mistake this project deleted on the same day, a hand-kept
 * copy synchronised by memory.
 *
 * WHAT IT ACTUALLY CHECKS, and why each claim is the narrow one it can defend:
 *
 *  · `vscode.diff` is executed from ONE place. That is the whole "opening a diff" question — VS Code's
 *    native diff editor is the product's only diff viewer, and a second caller is a second flow.
 *  · The changed-file primitives (`packages/engine/src/worktree/review.ts`) are consumed from ONE place, and inside
 *    `src/extension.ts` every use of them sits inside `reviewWorktreeDiff`. This is the "picking a
 *    changed file" question: a new picker cannot be built without them, and building one WITHOUT them
 *    would mean a second parser too — which claim 3 catches.
 *  · `parseNameStatus` / `mergeChanges` are called from ONE place. A second changed-file list, however
 *    it were rendered, has to start here.
 *
 * The three thin resolvers in front of `reviewWorktreeDiff` — agent (spec 213), pipeline run (spec 230)
 * and the land-door worktree row (this spec) — are deliberately NOT what this guard is about. They
 * resolve an identity and hand off; the flow they hand off to is the single one below. Adding a fourth
 * identity is fine. Adding a second `vscode.diff` is not.
 *
 * PROVED RED BEFORE GREEN: the self-check at the bottom runs the same detectors over synthetic sources
 * carrying a second `vscode.diff` call, a second quick-pick built from `emptySides`, and a second
 * `parseNameStatus` caller — and each is reported. That check exists because a static guard blind to
 * the thing it forbids passes forever (2026-08-03: a line-text comparison matched a `switch`'s own
 * `case` and excused every violation).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "../../src");
const ENGINE_SRC = path.join(__dirname, "../../packages/engine/src");

/** The pure changed-file/diff primitives. A picker or a diff pair is built out of these. */
const REVIEW_PRIMITIVES = ["emptySides", "baseSidePath", "diffTitle", "WT_DIFF_SCHEME"] as const;
/** The changed-file LIST builders — where any second list of changed files would have to begin. */
const LIST_BUILDERS = ["parseNameStatus", "mergeChanges"] as const;

const PRIMITIVE_HOME = "worktree/review.ts";
const FLOW_HOME = "extension.ts";
const LIST_HOME = "worktree/WorktreeManager.ts";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string): string => path.relative(file.startsWith(ENGINE_SRC) ? ENGINE_SRC : SRC, file).split(path.sep).join("/");

/** Whole-word occurrences, so `diffTitle` never matches inside `myDiffTitleThing`. */
function occurrences(source: string, word: string): number {
  return source.match(new RegExp(`\\b${word}\\b`, "g"))?.length ?? 0;
}

/** Files (repo-relative, `/`-joined) naming any of `words`, with a per-file count. */
function filesNaming(words: readonly string[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of [...sourceFiles(SRC), ...sourceFiles(ENGINE_SRC)]) {
    const source = fs.readFileSync(file, "utf8");
    const count = words.reduce((sum, word) => sum + occurrences(source, word), 0);
    if (count > 0) hits.set(rel(file), count);
  }
  return hits;
}

/**
 * The body of a top-level declaration, taken by LINES rather than by counting braces: a brace counter
 * has to understand strings, template literals and regex to be right, and one that does not is the
 * kind of blind detector this file exists to avoid. The region runs from the header to the next line
 * that begins a top-level declaration in column 0.
 */
function topLevelRegion(source: string, header: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  expect(start, `region header not found: ${header}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^(export )?(async )?(function|const|class|interface|type) /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** An indented region delimited by the NEXT occurrence of the same opener (command registrations). */
function registrationRegion(source: string, opener: string, nextOpener: string): string {
  const start = source.indexOf(opener);
  expect(start, `registration not found: ${opener}`).toBeGreaterThanOrEqual(0);
  const after = source.indexOf(nextOpener, start + opener.length);
  return source.slice(start, after === -1 ? source.length : after);
}

describe("SDD 501 — one diff-review implementation, reached by several doors", () => {
  it("executes vscode.diff from exactly one place", () => {
    const callers = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const count = (fs.readFileSync(file, "utf8").match(/executeCommand\(\s*["'`]vscode\.diff["'`]/g) ?? []).length;
      if (count > 0) callers.set(rel(file), count);
    }
    expect([...callers.entries()]).toEqual([[FLOW_HOME, 1]]);
  });

  /**
   * Counting EXECUTIONS above would miss a second opener that reached the command through a variable,
   * so the literal is counted too. Two mentions is the whole product: the execution, and the engine's
   * declaration that the UI capability `vscode.diff` exists. A third is a question to answer, which is
   * why this asserts a number rather than excusing a pattern.
   */
  it("mentions the vscode.diff command in exactly one file, exactly twice", () => {
    const mentions = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const count = (fs.readFileSync(file, "utf8").match(/["'`]vscode\.diff["'`]/g) ?? []).length;
      if (count > 0) mentions.set(rel(file), count);
    }
    expect([...mentions.entries()]).toEqual([[FLOW_HOME, 2]]);
  });

  it("consumes the changed-file primitives from exactly one file besides their own module", () => {
    const consumers = [...filesNaming(REVIEW_PRIMITIVES).keys()].filter((file) => file !== PRIMITIVE_HOME);
    expect(consumers).toEqual([FLOW_HOME]);
  });

  it("keeps every primitive use inside the one flow (plus its import and its content provider)", () => {
    const source = fs.readFileSync(path.join(SRC, FLOW_HOME), "utf8");
    const flow = topLevelRegion(source, "async function reviewWorktreeDiff(");
    const provider = registrationRegion(
      source,
      "vscode.workspace.registerTextDocumentContentProvider(WT_DIFF_SCHEME",
      "context.subscriptions.push(",
    );
    const importLine = source.split("\n").filter((line) => line.startsWith("import") && line.includes("worktree/review.js")).join("\n");
    const declaration = source.split("\n").filter((line) => line.startsWith("const WT_DIFF_SCHEME")).join("\n");
    const accountedFor = [flow, provider, importLine, declaration].join("\n");
    for (const word of REVIEW_PRIMITIVES) {
      expect(occurrences(accountedFor, word), `${word} is used outside reviewWorktreeDiff`)
        .toBe(occurrences(source, word));
    }
  });

  it("builds a changed-file list from exactly one place", () => {
    const callers = [...filesNaming(LIST_BUILDERS).keys()].filter((file) => file !== PRIMITIVE_HOME);
    expect(callers).toEqual([LIST_HOME]);
  });

  /**
   * The detectors, run against sources that DO carry a second implementation. Without this the three
   * claims above could be silently vacuous — matching nothing and passing forever.
   */
  it("reports a second implementation when one is present", () => {
    const secondDiff = `await vscode.commands.executeCommand("vscode.diff", left, right, "title");`;
    expect((secondDiff.match(/["'`]vscode\.diff["'`]/g) ?? []).length).toBe(1);

    const secondPicker = `const { baseEmpty } = emptySides(f.status); await vscode.window.showQuickPick(files);`;
    expect(REVIEW_PRIMITIVES.some((word) => occurrences(secondPicker, word) > 0)).toBe(true);

    const secondList = `const files = mergeChanges(parseNameStatus(out), others);`;
    expect(LIST_BUILDERS.every((word) => occurrences(secondList, word) > 0)).toBe(true);

    // And it reads whole words: a name that merely CONTAINS one is not a violation.
    expect(occurrences("const myDiffTitleHelper = 1; parseNameStatusLoosely(x);", "diffTitle")).toBe(0);
    expect(occurrences("parseNameStatusLoosely(x);", "parseNameStatus")).toBe(0);
  });
});
