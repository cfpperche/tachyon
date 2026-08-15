import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * t-6d8f65 — F5 with the Dev Host unarmed must put cause + arm command in front of
 * the human. VS Code's preLaunchTask dialog is hardcoded
 * (`debugTaskRunner.ts` `runTaskAndCheckErrors`):
 *   errorCount === 0 + numeric exit → "terminated with exit code N"
 *   Show Errors → Problems view, never the terminal
 * So the unarmed echo has to be a Problem, and F5 must not pick a fixture.
 */

const repoRoot = process.cwd();
const TASKS = path.join(repoRoot, ".vscode", "tasks.json");
const BUILD_DEV_HOST = "tachyon: build-dev-host";

function readTasksJson(): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(TASKS, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw) as { tasks: Array<Record<string, unknown>> };
}

function buildDevHostTask(): Record<string, unknown> {
  const task = readTasksJson().tasks.find((t) => t.label === BUILD_DEV_HOST);
  if (!task) throw new Error(`${BUILD_DEV_HOST} missing from .vscode/tasks.json`);
  return task;
}

function matcherRegexp(task: Record<string, unknown>): RegExp {
  const matcher = task.problemMatcher;
  if (!matcher || Array.isArray(matcher) || typeof matcher !== "object") {
    throw new Error(`${BUILD_DEV_HOST} must declare a custom problemMatcher object (not [] or a built-in name)`);
  }
  const pattern = (matcher as { pattern?: { regexp?: unknown } }).pattern;
  if (typeof pattern?.regexp !== "string" || pattern.regexp.length === 0) {
    throw new Error(`${BUILD_DEV_HOST} problemMatcher.pattern.regexp is missing`);
  }
  return new RegExp(pattern.regexp);
}

describe("dev-host unarmed preLaunchTask (t-6d8f65)", () => {
  it("does not auto-arm: point refuses to choose a fixture", () => {
    // Arming copies a fixture into .tachyon/dev-host/workspace. The wrong fixture
    // opens a silent empty/wrong EDH (runbook). launch.json is static (spec 448).
    // F5 therefore fails closed; it must not invent --fixture.
    const result = spawnSync("bash", [path.join(repoRoot, "scripts/dev-host/cli.sh"), "point"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/requires --workspace PATH or --fixture SLUG/);
  });

  it("declares a problemMatcher that Show Errors can land on, and reveals Problems on a hit", () => {
    const task = buildDevHostTask();
    const presentation = (task.presentation ?? {}) as Record<string, unknown>;
    expect(presentation.revealProblems, "onProblem is what puts the marker in front without scrolling the terminal").toBe(
      "onProblem",
    );
    const re = matcherRegexp(task);
    const sample =
      "docs/runbooks/dev-host.md:1:1: error: Tachyon Dev Host is not armed under this checkout. Arm: cd /tmp/wt && scripts/dev-host/cli.sh point --worktree /tmp/wt --fixture <slug>";
    expect(re.test(sample), `matcher ${re} must accept the gcc-style unarmed line`).toBe(true);
    expect(re.test("build-dev-host: WF=/tmp PTR=/tmp EXT=/tmp"), "success chatter must not become a Problem").toBe(
      false,
    );
  });

  it("prints a matcher-hitting line with cause and arm command when the checkout is unarmed", () => {
    const task = buildDevHostTask();
    const command = task.command;
    expect(typeof command).toBe("string");
    const re = matcherRegexp(task);

    const wf = fs.mkdtempSync(path.join(os.tmpdir(), "dev-host-unarmed-f5-"));
    try {
      // No .git file → the task must not fall through to the primary checkout's pointer.
      const script = String(command).replaceAll("${workspaceFolder}", wf);
      const result = spawnSync("bash", ["-c", script], {
        cwd: wf,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(1);
      const output = `${result.stderr}\n${result.stdout}`;
      const hits = output.split(/\r?\n/).filter((line) => re.test(line));
      expect(hits, `unarmed stderr must contain a problemMatcher hit:\n${output}`).not.toEqual([]);
      expect(hits[0]).toMatch(/not armed/i);
      expect(hits[0]).toMatch(/scripts\/dev-host\/cli\.sh point/);
      expect(hits[0]).toContain(wf);
      expect(
        fs.existsSync(path.join(wf, ".tachyon", "dev-host", "meta.json")),
        "unarmed F5 must not invent a pointer",
      ).toBe(false);
    } finally {
      fs.rmSync(wf, { recursive: true, force: true });
    }
  });
});
