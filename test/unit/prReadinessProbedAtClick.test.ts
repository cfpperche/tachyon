/**
 * SDD 501 / plan.md § D3 — Propose reaches the land block WITHOUT `gh` reaching the refresh loop.
 *
 * spec 223 bought a property deliberately: readiness is probed when the human clicks, never once per
 * row per refresh. The Worktrees dashboard polls, and a row that pre-checked "can I open a PR?" would
 * spawn `gh --version` and `gh auth status` on every tick, for every row, forever — on a repository
 * that may never open a pull request at all. Putting the button next to Land is exactly the change
 * that makes someone want to grey it out ahead of time.
 *
 * So this is a guard about WHERE the probe may live, not about whether it works (spec 223's own tests
 * cover that). The runtime half — a refresh dispatches no command, and a click dispatches exactly one
 * `tachyon.createWorktreePrItem` — is in `cockpitWorktreeActions.test.ts`, where the panel harness is.
 *
 * PROVED RED BEFORE GREEN: adding `import { probePrReadiness } from "../worktree/pr.js"` to
 * `src/cockpit/model.ts` fails the render-path claim naming that file, and a `gh("gh", ["--version"])`
 * anywhere outside `src/worktree/pr.ts` fails the first one.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "../../src");

/** The two exports that spawn `gh`. `isWorktreeDirty`/`composePr*` are git-only or pure — not these. */
const GH_SPAWNERS = ["probePrReadiness", "createWorktreePr"] as const;
const PR_HOME = "worktree/pr.ts";
const CLICK_HOME = "extension.ts";

/**
 * Everything that runs to DRAW a worktree row, from the registry sweep to the rendered block. The list
 * is explicit rather than transitive on purpose: a transitive walk would need a resolver, and a guard
 * whose own machinery can be wrong about the graph is worth less than one naming the files a reader
 * can check by eye.
 */
const RENDER_PATH = [
  "sections/model.ts",
  "webview/WorktreesPanel.ts",
  "webview/worktrees/App.tsx",
  "webview/worktrees/messages.ts",
  "worktree/ManagedWorktreeService.ts",
  "worktree/classify.ts",
  "worktree/land.ts",
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join("/");
const read = (relative: string): string => fs.readFileSync(path.join(SRC, relative), "utf8");
const occurrences = (source: string, word: string): number =>
  source.match(new RegExp(`\\b${word}\\b`, "g"))?.length ?? 0;

describe("SDD 501 — `gh` is spawned at click, never at render", () => {
  it("names the gh binary in exactly one source file", () => {
    const callers = sourceFiles(SRC)
      .filter((file) => /["'`]gh["'`]\s*,/.test(fs.readFileSync(file, "utf8")))
      .map(rel);
    expect(callers).toEqual([PR_HOME]);
  });

  it("references the gh-spawning exports from exactly one file besides their own module", () => {
    const callers = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return GH_SPAWNERS.some((word) => occurrences(source, word) > 0);
      })
      .map(rel)
      .filter((file) => file !== PR_HOME);
    expect(callers).toEqual([CLICK_HOME]);
  });

  it("keeps every one of those references inside the click handler", () => {
    const source = read(CLICK_HOME);
    const start = source.indexOf('vscode.commands.registerCommand("tachyon.createWorktreePrItem"');
    expect(start, "the PR command registration moved").toBeGreaterThanOrEqual(0);
    const after = source.indexOf("vscode.commands.registerCommand(", start + 40);
    const handler = source.slice(start, after === -1 ? source.length : after);
    const importLine = source.split("\n").filter((line) => line.startsWith("import") && line.includes("worktree/pr.js")).join("\n");
    for (const word of GH_SPAWNERS) {
      expect(occurrences(`${handler}\n${importLine}`, word), `${word} escaped the click handler`)
        .toBe(occurrences(source, word));
    }
  });

  it("keeps the whole render path clear of the PR module", () => {
    const offenders = RENDER_PATH.filter((file) => {
      const source = read(file);
      return source.includes("worktree/pr.js") || GH_SPAWNERS.some((word) => occurrences(source, word) > 0);
    });
    expect(offenders).toEqual([]);
  });

  it("reports a probe that escaped, so the claims above are not vacuous", () => {
    expect(/["'`]gh["'`]\s*,/.test('await gh("gh", ["auth", "status"], cwd)')).toBe(true);
    expect(occurrences('import { probePrReadiness } from "../worktree/pr.js";', "probePrReadiness")).toBe(1);
    expect(RENDER_PATH.every((file) => fs.existsSync(path.join(SRC, file)))).toBe(true);
  });
});
