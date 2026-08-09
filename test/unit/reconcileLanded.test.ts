import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { reconcileLanded, type LandedGit } from "../../src/tasks/reconcileLanded.js";
import { makeTempDir } from "../helpers/tempDir.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function gitWithReachableLog(records: Array<{ sha: string; body: string }>): LandedGit {
  return {
    async run(args) {
      if (args[0] === "log") {
        return { code: 0, stdout: records.map((record) => `${record.sha}\t${record.body}\0`).join(""), stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: records.some((record) => record.sha === args[2]) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "show") {
        const record = records.find((candidate) => candidate.sha === args.at(-1));
        return { code: record ? 0 : 1, stdout: record?.body ?? "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        const candidate = args[2].replace(/\^\{commit\}$/, "");
        const record = records.find((entry) => entry.sha.startsWith(candidate));
        return { code: record ? 0 : 1, stdout: record ? `${record.sha}\n` : "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
    },
  };
}

async function landedTask(tasks: TaskStore, id: string): Promise<void> {
  await tasks.create({ id, title: id, author: "test", now: "2026-08-09T00:00:00.000Z" });
  await tasks.update(id, { status: "triaged", actor: "test" });
  await tasks.reconcile(id, { status: "landed", evidence: "external delivery", actor: "test" });
}

describe("reconcileLanded", () => {
  it("does not move a landed task without a commit proved reachable from main", async () => {
    const root = makeTempDir("reconcile-landed-unproved-");
    const tasks = new TaskStore(root);
    await landedTask(tasks, "t-111111");

    const report = await reconcileLanded(tasks, root, { dryRun: false, git: gitWithReachableLog([]) });

    expect(tasks.get("t-111111").status).toBe("landed");
    expect(report.rows).toEqual([{
      id: "t-111111",
      outcome: "refused",
      reason: "no commit evidence reachable from main",
    }]);
  });

  it("journals the individual proved SHA for each task it reconciles", async () => {
    const root = makeTempDir("reconcile-landed-evidence-");
    const tasks = new TaskStore(root);
    await landedTask(tasks, "t-222222");
    const git = gitWithReachableLog([{ sha: SHA_A, body: "ship t-222222" }]);

    const report = await reconcileLanded(tasks, root, { dryRun: false, actor: "sweeper", git });

    expect(tasks.get("t-222222").status).toBe("done");
    expect(report.rows[0]).toMatchObject({ id: "t-222222", outcome: "reconciled", evidence: SHA_A });
    expect(tasks.journal.read("t-222222").map((entry) => entry.text)).toContain(`reconciled landed -> done: ${SHA_A}`);
  });
});
