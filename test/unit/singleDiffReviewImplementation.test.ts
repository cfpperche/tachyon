/**
 * SDD 501 + SDD 513 — there is exactly ONE worktree-review opener: the Tachyon tab.
 *
 * 501 made the native diff reachable from the land block through one function. 513 retired that
 * surface: `reviewWorktreeDiff` still resolves identity + changed files, then opens ReviewPanel.
 * A second opener — another vscode.diff for this command, or a second panel host — is the defect
 * this guard exists for. `parseNameStatus` / `mergeChanges` stay the one changed-file list builder.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "../../src");
const EXTENSION_SRC = path.join(__dirname, "../../apps/vscode-extension/src");
const ENGINE_SRC = path.join(__dirname, "../../packages/engine/src");

/** The changed-file LIST builders — where any second list of changed files would have to begin. */
const LIST_BUILDERS = ["parseNameStatus", "mergeChanges"] as const;

const FLOW_HOME = "extension.ts";
const PANEL_HOME = "webview/ReviewPanel.ts";
const LIST_HOME = "worktree/WorktreeManager.ts";

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string): string => path.relative(file.startsWith(ENGINE_SRC) ? ENGINE_SRC : file.startsWith(EXTENSION_SRC) ? EXTENSION_SRC : SRC, file).split(path.sep).join("/");

/** Whole-word occurrences, so `diffTitle` never matches inside `myDiffTitleThing`. */
function occurrences(source: string, word: string): number {
  return source.match(new RegExp(`\\b${word}\\b`, "g"))?.length ?? 0;
}

/** Files (repo-relative, `/`-joined) naming any of `words`, with a per-file count. */
function filesNaming(words: readonly string[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of [...sourceFiles(SRC), ...sourceFiles(EXTENSION_SRC), ...sourceFiles(ENGINE_SRC)]) {
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

describe("SDD 501 + 513 — one Tachyon review tab, reached by several doors", () => {
  it("does not open the native vscode.diff for worktree review", () => {
    const callers = new Map<string, number>();
    for (const file of [...sourceFiles(SRC), ...sourceFiles(EXTENSION_SRC)]) {
      const count = (fs.readFileSync(file, "utf8").match(/executeCommand\(\s*["'`]vscode\.diff["'`]/g) ?? []).length;
      if (count > 0) callers.set(rel(file), count);
    }
    expect([...callers.entries()]).toEqual([]);
    const flow = topLevelRegion(
      fs.readFileSync(path.join(EXTENSION_SRC, FLOW_HOME), "utf8"),
      "async function reviewWorktreeDiff(",
    );
    expect(flow).toContain("reviewPanels.open");
    expect(flow).not.toMatch(/executeCommand\(\s*["'`]vscode\.diff["'`]/);
  });

  it("hosts the review screen in exactly one panel manager", () => {
    const hosts = [...sourceFiles(EXTENSION_SRC)].filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("export class ReviewPanelManager") || source.includes("new ReviewPanelManager(");
    }).map(rel);
    expect(hosts.sort()).toEqual(["extension.ts", PANEL_HOME].sort());
  });

  it("builds a changed-file list from exactly one place", () => {
    const callers = [...filesNaming(LIST_BUILDERS).keys()].filter((file) => file !== "worktree/review.ts");
    expect(callers).toEqual([LIST_HOME]);
  });

  it("reports a second implementation when one is present", () => {
    const secondDiff = `await vscode.commands.executeCommand("vscode.diff", left, right, "title");`;
    expect((secondDiff.match(/["'`]vscode\.diff["'`]/g) ?? []).length).toBe(1);

    const secondList = `const files = mergeChanges(parseNameStatus(out), others);`;
    expect(LIST_BUILDERS.every((word) => occurrences(secondList, word) > 0)).toBe(true);

    expect(occurrences("parseNameStatusLoosely(x);", "parseNameStatus")).toBe(0);
  });
});
