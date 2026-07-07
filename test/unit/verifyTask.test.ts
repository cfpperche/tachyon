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
  git(repo, ["add", ".gitignore", "src/feature.txt", "behavior.js"]);
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

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.blockers).toEqual([]);
    expect(result.record.baseSha).toBe(baseSha);
    expect(result.record.refSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.record.integrityHash).toMatch(/^[0-9a-f]{64}$/);
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

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("accept");
    expect(result.record.commands.map((c) => c.cwd)).toEqual([wt, wt]);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("tachyon/worker");
  });

  it("blocks when the task ref has no new commit", async () => {
    const { repo, baseSha } = fixture();
    record(repo, baseSha);

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

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

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("dirty_worktree");
  });

  it("blocks files outside declared owns paths", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "new\n");
    write(path.join(wt, "README.md"), "outside\n");
    git(wt, ["add", "src/feature.txt", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc implement behavior"]);
    record(repo, baseSha, ["src"]);

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toContainEqual({ code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md" });
  });

  it("blocks behavior tests that already passed at BASE_SHA", async () => {
    const { repo, wt, baseSha } = fixture("new");
    write(path.join(wt, "README.md"), "shape only\n");
    git(wt, ["add", "README.md"]);
    git(wt, ["commit", "-qm", "t-123abc shape only"]);
    record(repo, baseSha, ["README.md"]);

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    expect(result.verdict).toBe("blocked");
    expect(result.blockers.map((b) => b.code)).toContain("behavior_already_passed");
  });

  it("blocks behavior tests that do not pass at HEAD", async () => {
    const { repo, wt, baseSha } = fixture();
    write(path.join(wt, "src", "feature.txt"), "still-old\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc wrong behavior"]);
    record(repo, baseSha);

    const result = await verifyTask({ workspaceRoot: repo, agent: "worker" });

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

    const blocked = await verifyTask({ workspaceRoot: repo, agent: "worker" });
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.blockers.map((b) => b.code)).toContain("test_suppression");

    const waived = await verifyTask({
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
    const first = await verifyTask({ workspaceRoot: repo, agent: "worker" });

    write(path.join(wt, "src", "feature.txt"), "newer\n");
    git(wt, ["add", "src/feature.txt"]);
    git(wt, ["commit", "-qm", "t-123abc later commit"]);
    const current = git(repo, ["rev-parse", "tachyon/worker"]);

    expect(current).not.toBe(first.record.refSha);
    expect(fs.existsSync(path.join(repo, ".tachyon", "verifications", `${current}.json`))).toBe(false);
  });
});
