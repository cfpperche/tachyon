import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { reconcileLanded, type LandedGit } from "../../src/tasks/reconcileLanded.js";
import { makeTempDir } from "../helpers/tempDir.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECONCILE_LANDED_MERGE = "371ec736ecc6437ffbef09ca221f4a09b82a3de0";

function gitWithReachableLog(records: Array<{ sha: string; subject?: string; body: string }>): LandedGit {
  return {
    async run(args) {
      if (args[0] === "log") {
        const subjectOnly = args.some((arg) => arg.includes("%s"));
        return {
          code: 0,
          stdout: records.map((record) => `${record.sha}\t${subjectOnly ? record.subject ?? record.body : [record.subject, record.body].filter(Boolean).join("\n\n")}\0`).join(""),
          stderr: "",
        };
      }
      if (args[0] === "merge-base") {
        return { code: records.some((record) => record.sha === args[2]) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "show") {
        const record = records.find((candidate) => candidate.sha === args.at(-1));
        const subjectOnly = args.some((arg) => arg.includes("%s"));
        return {
          code: record ? 0 : 1,
          stdout: record ? subjectOnly ? record.subject ?? record.body : [record.subject, record.body].filter(Boolean).join("\n\n") : "",
          stderr: "",
        };
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

async function landedTask(tasks: TaskStore, id: string, evidence = "external delivery"): Promise<void> {
  await tasks.create({ id, title: id, author: "test", now: "2026-08-09T00:00:00.000Z" });
  await tasks.update(id, { status: "triaged", actor: "test" });
  await tasks.reconcile(id, { status: "landed", evidence, actor: "test" });
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

  it("does not treat the real reconcile_landed merge body's explanation as delivery", async () => {
    const root = makeTempDir("reconcile-landed-mentioned-untouched-");
    const tasks = new TaskStore(root);
    await landedTask(tasks, "t-b1c579");
    const git = gitWithReachableLog([{
      sha: RECONCILE_LANDED_MERGE,
      subject: "merge(t-77c95c): `reconcile_landed`, e o board deixa de ser o único domínio sem varredura",
      body: "t-b1c579 não se explica e fica para olhar uma a uma",
    }]);

    const report = await reconcileLanded(tasks, root, { git });

    expect(report.rows).toEqual([{
      id: "t-b1c579",
      outcome: "refused",
      reason: "no commit evidence reachable from main",
    }]);
  });

  it("keeps reachable journal SHA proof when an id appears only in another commit's body", async () => {
    const root = makeTempDir("reconcile-landed-journal-fallback-");
    const tasks = new TaskStore(root);
    const delivered = "d2a5dd986b542147b830c17e5f00b28c1236ca52";
    await landedTask(tasks, "t-fc9fc2", delivered.slice(0, 7));
    const git = gitWithReachableLog([
      {
        sha: RECONCILE_LANDED_MERGE,
        subject: "merge(t-77c95c): `reconcile_landed`, e o board deixa de ser o único domínio sem varredura",
        body: "A diferença é a t-fc9fc2, cujo journal traz o sha d2a5dd9",
      },
      { sha: delivered, subject: "fix: delivered work", body: "" },
    ]);

    const report = await reconcileLanded(tasks, root, { git });

    expect(report.rows).toEqual([{ id: "t-fc9fc2", outcome: "would-reconcile", evidence: delivered }]);
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
