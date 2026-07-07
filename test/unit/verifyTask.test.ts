import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyTask } from "../../src/bridge/verifyTask.js";
import { delegationRecordFromSpawn, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "tachyon-test",
  GIT_AUTHOR_EMAIL: "tachyon@example.test",
  GIT_COMMITTER_NAME: "tachyon-test",
  GIT_COMMITTER_EMAIL: "tachyon@example.test",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function makeRepo(initial = "old"): { repo: string; wt: string; baseSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-repo-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-vtask-wt-"));
  fs.rmSync(wt, { recursive: true, force: true });
  git(repo, ["init", "-q"]);
  write(path.join(repo, ".gitignore"), "node_modules/\n");
  write(path.join(repo, "src", "feature.txt"), `${initial}\n`);
  write(
    path.join(repo, "behavior.js"),
    "const fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
  );
  write(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node npm-behavior.js" } }, null, 2));
  write(
    path.join(repo, "npm-behavior.js"),
    "const fs = require('fs'); const args = process.argv.slice(2); const pattern = args.at(-1); if (pattern !== 'quote \"x\" (case)') process.exit(2); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
  );
  git(repo, ["add", ".gitignore", "src/feature.txt", "behavior.js", "package.json", "npm-behavior.js"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "tachyon/worker", wt, "HEAD"]);
  return { repo, wt, baseSha };
}

function record(repo: string, baseSha: string, owns: string[] = ["src"], behaviorTest = "cmd:node behavior.js"): void {
  writeDelegationRecord(
    repo,
    delegationRecordFromSpawn({
      agent: "worker",
      baseSha,
      taskRef: "tachyon/worker",
      gate: { behaviorTest, owns },
      contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
      createdAt: new Date().toISOString(),
    }),
  );
}

async function testRunner(cwd: string, argv: string[], _opts?: { timeout?: number }) {
  if (argv[0] === "npx" && argv[1] === "vitest" && argv[2] === "related") {
    return { command: argv.join(" "), argv, exitCode: 0, stdout: "related ok\n", stderr: "" };
  }
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: ENV });
    return { command: argv.join(" "), argv, exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as Error & { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      command: argv.join(" "),
      argv,
      exitCode: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message,
    };
  }
}

function runVerify(input: Parameters<typeof verifyTask>[0]) {
  return verifyTask({ runner: testRunner, ...input });
}

describe("verifyTask", () => {
  const roots: string[] = [];

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(initial?: string) {
    const f = makeRepo(initial);
    roots.push(f.repo, f.wt);
    return f;
  }

  it("accepts a clean scoped task commit whose behavior fails at base and passes at head", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
    expect(result.record.baseSha).toBe(baseSha);
    expect(result.record.refSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.record.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[1]).toMatchObject({ argv: ["node", "behavior.js"] });
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications", `${result.record.refSha}.json`))).toBe(true);
  });

  it("runs behavior checks in the agent worktree so ignored node_modules tools are available", async () => {
    const { repo, wt, baseSha } = fixture();
    write(
      path.join(wt, "node_modules", ".bin", "behavior-runner"),
      "#!/usr/bin/env node\nconst fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
    );
    fs.chmodSync(path.join(wt, "node_modules", ".bin", "behavior-runner"), 0o755);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], "cmd:node_modules/.bin/behavior-runner");

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.cwd)).toEqual([wt, wt, wt]);
    expect(result.record.commands[1]).toMatchObject({ argv: ["node_modules/.bin/behavior-runner"] });
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("passes plain behavior tests to npm as an argv array without shell interpolation", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"], 'quote "x" (case)');

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands[1]).toMatchObject({ argv: ["npm", "test", "--", "--run", "-t", 'quote "x" (case)'] });
    expect(result.record.commands[1].command).not.toContain("sh -lc");
  });

  it("runs configured typecheck and affected tests on every verification but skips full by default", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(repo, "tachyon.yml"), "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    typecheck: node typecheck.js\n    full: node full.js\n");
    write(path.join(wt, "typecheck.js"), "process.exit(0);\n");
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "typecheck.js", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "typecheck.js", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["typecheck", "affected_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[0].argv).toEqual(["node", "typecheck.js"]);
    expect(result.record.commands[1].argv).toEqual(["npx", "vitest", "related", "--run", "full.js", "src/feature.txt", "typecheck.js"]);
  });

  it("filters affected-test files to paths that still exist at refSha", async () => {
    const { repo, wt } = fixture();
    write(path.join(wt, "src", "removed.txt"), "delete me\n");
    git(wt, ["add", "src/removed.txt"]);
    git(wt, ["commit", "-qm", "t-123abc add removable fixture"]);
    const taskBase = git(wt, ["rev-parse", "HEAD"]);
    write(path.join(wt, "src", "feature.txt"), "new\n");
    fs.rmSync(path.join(wt, "src", "removed.txt"));
    git(wt, ["add", "src/feature.txt", "src/removed.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior and delete file"]);
    record(repo, taskBase, ["src"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands[0].argv).toEqual(["npx", "vitest", "related", "--run", "src/feature.txt"]);
  });

  it("runs the configured full command only when full:true is requested", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(repo, "tachyon.yml"), "agents:\n  worker:\n    cmd: codex\nsettings:\n  verify:\n    full: node full.js\n");
    write(path.join(wt, "full.js"), "process.exit(0);\n");
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt", "full.js"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src", "full.js"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", full: true });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests", "full_tests", "behavior_head_expect_pass", "behavior_base_expect_fail"]);
    expect(result.record.commands[1].argv).toEqual(["node", "full.js"]);
  });

  it("blocks when a tiered verification command fails", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await verifyTask({
      workspaceRoot: repo,
      agent: "worker",
      runner: async (cwd, argv, opts) => {
        if (argv[0] === "npx") return { command: argv.join(" "), argv, exitCode: 1, stdout: "", stderr: "related failed\n" };
        return testRunner(cwd, argv, opts);
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("affected_tests_failed");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_not_run");
    expect(result.record.commands.map((c) => c.name)).toEqual(["affected_tests"]);
  });

  it("blocks when the task ref has no new commit", async () => {
    const { repo, baseSha } = fixture();
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("no_commit");
  });

  it("blocks dirty agent worktrees", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    write(path.join(wt, "scratch.txt"), "uncommitted\n");
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("dirty_worktree");
  });

  it("blocks behavior verification while the agent is still running", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker", isAgentRunning: async () => true });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("agent_still_running");
    expect(result.record.commands).toEqual([]);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("runs behavior verification inside the supplied worktree lock", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const calls: string[] = [];

    const result = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      isAgentRunning: async () => false,
      withWorktreeLock: async (agent, fn) => {
        calls.push(`lock:${agent}`);
        const out = await fn();
        calls.push(`unlock:${agent}`);
        return out;
      },
    });

    expect(result.verdict).toBe("accept");
    expect(calls).toEqual(["lock:worker", "unlock:worker"]);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("blocks files outside declared owns paths", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({ code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md" });
  });

  it("skips scope checking when owns is absent", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside but owns is optional\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, []);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers.map((b) => b.code)).not.toContain("scope_breach");
  });

  it("blocks behavior tests that already passed at BASE_SHA", async () => {
    const { repo, wt, baseSha } = fixture("new");
    write(path.join(wt, "README.md"), "shape only\n");
    git(wt, ["add", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc shape only"]);
    record(repo, baseSha, ["README.md"]);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_already_passed");
  });

  it("blocks behavior tests that do not pass at HEAD", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "still-old\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc wrong behavior"]);
    record(repo, baseSha);

    const result = await runVerify({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_failed");
  });

  it("blocks suppression tripwires unless coordinator waivers match the finding", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "test", "feature.test.ts"), "it.skip('old behavior', () => {});\n");
    git(wt, ["add", "src/feature.txt", "test/feature.test.ts"]);
    git(wt, ["commit", "-qm", "t-123abc behavior with suppression"]);
    record(repo, baseSha, ["src", "test"]);

    const blocked = await runVerify({ workspaceRoot: repo, agent: "worker" });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.blockers.map((b) => b.code)).toContain("test_suppression");

    const waived = await runVerify({
      workspaceRoot: repo,
      agent: "worker",
      waivers: [{ finding: "test_suppression", reason: "coordinator inspected changed behavior test", cites: "src/feature.txt" }],
    });
    expect(waived.verdict).toBe("accept");
    expect(waived.record.waivers).toHaveLength(1);
  });

  it("binds verification records to the exact ref SHA so later commits have no matching record", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha);
    const first = await runVerify({ workspaceRoot: repo, agent: "worker" });

    write(path.join(wt, "src", "feature.txt"), "newer\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc later commit"]);
    const current = git(repo, ["rev-parse", "tachyon/worker"]);

    expect(current).not.toBe(first.record.refSha);
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications", `${current}.json`))).toBe(false);
  });
});
