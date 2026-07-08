import { describe, expect, it } from "vitest";
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

function makeRepo(): { repo: string; wt: string; baseSha: string; cleanup: () => void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cx-waiver-repo-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cx-waiver-wt-"));
  fs.rmSync(wt, { recursive: true, force: true });
  git(repo, ["init", "-q"]);
  write(path.join(repo, "src", "feature.txt"), "old\n");
  write(
    path.join(repo, "behavior.js"),
    "const fs = require('fs'); process.exit(fs.readFileSync('src/feature.txt', 'utf8').trim() === 'new' ? 0 : 1);\n",
  );
  git(repo, ["add", "src/feature.txt", "behavior.js"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "tachyon/worker", wt, "HEAD"]);
  return {
    repo,
    wt,
    baseSha,
    cleanup: () => {
      fs.rmSync(wt, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function writeRecord(repo: string, baseSha: string): void {
  writeDelegationRecord(
    repo,
    delegationRecordFromSpawn({
      agent: "worker",
      baseSha,
      taskRef: "tachyon/worker",
      gate: { behaviorTest: "cmd:node behavior.js", owns: ["src"] },
      contract: { task: "ship behavior", context: "fixture", constraints: "none", doneWhen: "behavior passes" },
      createdAt: new Date().toISOString(),
    }),
  );
}

async function testRunner(cwd: string, argv: string[]) {
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

describe("container-generated delegation behavior", () => {
  it("verify_task accepts a coordinator waiver for a scope_breach finding and persists it in the verification record", async () => {
    const first = makeRepo();
    try {
      write(path.join(first.wt, "src", "feature.txt"), "new\n");
      write(path.join(first.wt, "README.md"), "outside declared scope\n");
      git(first.wt, ["add", "src/feature.txt", "README.md"]);
      git(first.wt, ["commit", "-qm", "t-7acc58 implement behavior"]);
      writeRecord(first.repo, first.baseSha);

      const blocked = await verifyTask({ workspaceRoot: first.repo, agent: "worker", runner: testRunner });
      expect(blocked.verdict).toBe("blocked");
      expect(blocked.blockers).toContainEqual({ code: "scope_breach", detail: "changed file is outside declared owns paths", file: "README.md" });

      const waiver = { finding: "README.md", reason: "coordinator confirms README change is required by task scope" };
      const waived = await verifyTask({ workspaceRoot: first.repo, agent: "worker", waivers: [waiver], runner: testRunner });
      expect(waived.verdict).toBe("accept");
      expect(waived.blockers.map((b) => b.code)).not.toContain("scope_breach");
      expect(waived.record.waivers).toEqual([waiver]);
      expect(waived.record.findings).toContainEqual({
        code: "scope_breach",
        detail: "changed file is outside declared owns paths",
        file: "README.md",
        blocking: false,
        waiver,
      });
      expect(JSON.parse(fs.readFileSync(waived.recordPath, "utf8")).waivers).toEqual([waiver]);
    } finally {
      first.cleanup();
    }

    const second = makeRepo();
    try {
      write(path.join(second.wt, "src", "feature.txt"), "new\n");
      write(path.join(second.wt, "README.md"), "outside declared scope\n");
      write(path.join(second.wt, "OTHER.md"), "also outside declared scope\n");
      git(second.wt, ["add", "src/feature.txt", "README.md", "OTHER.md"]);
      git(second.wt, ["commit", "-qm", "t-7acc58 implement behavior"]);
      writeRecord(second.repo, second.baseSha);

      const unrelated = await verifyTask({
        workspaceRoot: second.repo,
        agent: "worker",
        waivers: [{ finding: "README.md", reason: "coordinator confirms README change is required by task scope" }],
        runner: testRunner,
      });

      expect(unrelated.verdict).toBe("blocked");
      expect(unrelated.blockers).toContainEqual({ code: "scope_breach", detail: "changed file is outside declared owns paths", file: "OTHER.md" });
      expect(unrelated.blockers).not.toContainEqual(expect.objectContaining({ code: "scope_breach", file: "README.md" }));
    } finally {
      second.cleanup();
    }
  });

  it("rejects a waiver keyed on the bare code 'scope_breach' instead of a file or exact detail", async () => {
    const fixture = makeRepo();
    try {
      write(path.join(fixture.wt, "src", "feature.txt"), "new\n");
      write(path.join(fixture.wt, "README.md"), "outside declared scope\n");
      git(fixture.wt, ["add", "src/feature.txt", "README.md"]);
      git(fixture.wt, ["commit", "-qm", "t-7acc58 implement behavior"]);
      writeRecord(fixture.repo, fixture.baseSha);

      await expect(
        verifyTask({
          workspaceRoot: fixture.repo,
          agent: "worker",
          waivers: [{ finding: "scope_breach", reason: "blanket-waive every scope breach" }],
          runner: testRunner,
        }),
      ).rejects.toThrow(/bare code 'scope_breach'/);
    } finally {
      fixture.cleanup();
    }
  });

  it("records the resolved verifierCaller on an accepted, file-waived verification and hashes it into integrity", async () => {
    const fixture = makeRepo();
    try {
      write(path.join(fixture.wt, "src", "feature.txt"), "new\n");
      write(path.join(fixture.wt, "README.md"), "outside declared scope\n");
      git(fixture.wt, ["add", "src/feature.txt", "README.md"]);
      git(fixture.wt, ["commit", "-qm", "t-7acc58 implement behavior"]);
      writeRecord(fixture.repo, fixture.baseSha);

      const waiver = { finding: "README.md", reason: "coordinator confirms README change is required by task scope" };

      const legacy = await verifyTask({ workspaceRoot: fixture.repo, agent: "worker", waivers: [waiver], runner: testRunner });
      expect(legacy.verdict).toBe("accept");
      expect(legacy.waivedFindings).toContainEqual(
        expect.objectContaining({ code: "scope_breach", file: "README.md", blocking: false, waiver }),
      );
      expect(legacy.record.verifierCaller).toEqual({ kind: "legacy" });

      const coordinated = await verifyTask({
        workspaceRoot: fixture.repo,
        agent: "worker",
        waivers: [waiver],
        runner: testRunner,
        verifierCaller: { kind: "agent", name: "coordinator" },
      });
      expect(coordinated.verdict).toBe("accept");
      expect(coordinated.record.verifierCaller).toEqual({ kind: "agent", name: "coordinator" });
      // same findings/waivers, different attribution -> different integrity hash (tamper-evident).
      expect(coordinated.record.integrityHash).not.toBe(legacy.record.integrityHash);
    } finally {
      fixture.cleanup();
    }
  });
});
