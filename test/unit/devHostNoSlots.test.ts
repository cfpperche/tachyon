import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nonEmpty, workspaceRoot } from "../helpers/repositorySourceScan.js";

/**
 * spec 448 structural guard — the dev-host belongs to the checkout that owns it.
 *
 * Slots and the `active` symlink existed only to partition ONE shared dev-host living in the primary
 * monorepo. That sharing is gone, so the vocabulary must go with it: a reintroduced `slots/` layout or
 * `active` pointer would silently restore the coupling this spec removed (a tracked `launch.json`
 * rewritten per agent, and slots outliving the worktrees they served).
 *
 * This bans the layout, not the English words — `--owner` in `lane.mjs` is a *lease* owner, an
 * unrelated concept that must keep working, so the patterns below are path-shaped on purpose.
 */

const repoRoot = process.cwd();

/** Path-shaped so prose and unrelated uses of the word "active"/"slot" do not trip the guard. */
const BANNED = [
  { pattern: /\.tachyon\/dev-host\/active/, why: "the `active` symlink was removed — the checkout IS the target" },
  { pattern: /dev-host["'\s,)\]]*[,\s]*["']active["']/, why: "path.join(... 'dev-host', 'active') rebuilds the removed symlink" },
  { pattern: /dev-host\/slots/, why: "the slots/ layout was removed — one dev-host per checkout" },
  { pattern: /dev-host["'\s,)\]]*[,\s]*["']slots["']/, why: "path.join(... 'dev-host', 'slots') rebuilds the removed layout" },
];

/** Files that legitimately narrate the removal (the spec itself, and this guard). */
const ALLOWED = [
  path.join("test", "unit", "devHostNoSlots.test.ts"),
  path.join("docs", "specs", "448-devhost-owned-by-worktree"),
];

function sourceFiles(): string[] {
  const roots = [
    path.join(repoRoot, "scripts"),
    path.join(repoRoot, "src"),
    path.join(repoRoot, "test"),
    path.join(repoRoot, "docs", "runbooks"),
    path.join(workspaceRoot("@tachyon/engine"), "src"),
    path.join(workspaceRoot("@tachyon/shared"), "src"),
    path.join(workspaceRoot("@tachyon/webview-ui"), "src"),
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "fixtures") continue;
        walk(full);
        continue;
      }
      if (/\.(mjs|mts|js|ts|tsx|sh|md|json)$/.test(entry.name)) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return nonEmpty(out, "dev-host retired-slot source scan");
}

describe("dev-host has no slots and no active pointer (spec 448)", () => {
  it("no source, script, test or runbook rebuilds the slot/active layout", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(repoRoot, file);
      if (ALLOWED.some((a) => rel.startsWith(a))) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // Naming the removed layout to assert it is ABSENT is the opposite of rebuilding it —
        // those assertions are how the removal stays proven, so they are not violations.
        if (/\.toBe\(false\)|not\.toContain|\.toEqual\(\[\]\)/.test(line)) continue;
        for (const { pattern, why } of BANNED) {
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}  — ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the committed launch.json has one Dev Host entry per WORKSPACE SHAPE, and no others", () => {
    // Spec 448 removed per-slot/per-owner launch entries: `launch.json` is tracked and must never be
    // multiplied per agent. t-f0efc5 added a second entry that does NOT reintroduce that — it is per
    // workspace SHAPE (folder vs `.code-workspace`), which VS Code distinguishes by the extension of
    // the path it is given, so one static argument genuinely cannot serve both. The list stays closed
    // and exact: a third entry, or anything named after a slot/owner/agent, still fails here.
    const raw = fs.readFileSync(path.join(repoRoot, ".vscode", "launch.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const names = (JSON.parse(raw).configurations as Array<{ name: string }>).map((c) => c.name);
    expect(names.filter((n) => n.startsWith("Tachyon: Dev Host")))
      .toEqual(["Tachyon: Dev Host", "Tachyon: Dev Host (multi-root)"]);
  });
});
