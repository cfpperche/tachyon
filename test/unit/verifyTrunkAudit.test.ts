import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Plain ESM, like the recorder it extends — exercising the real module is the point.
// @ts-expect-error -- the verification scripts have no separate declaration surface.
import { auditTrunk, defaultAuditRange, formatTrunkAudit, recordVerification } from "../../scripts/verify-record.mjs";
// @ts-expect-error -- same.
import { trunkAuditNotice } from "../../scripts/verify-full.mjs";

/**
 * t-884b48 — a merge tree that nothing verified must be VISIBLE, not merely absent.
 *
 * The defect these cover is not "a check returned the wrong answer"; it is that nobody could ask the
 * question. `check` answers about one commit and every caller points it at the tip, so on 2026-08-05
 * 42 of 70 merges landed on `main` with no green for their resulting tree and nothing said so.
 *
 * The cases that carry the weight are the CLASSIFICATION ones: an audit that counted every unverified
 * commit alike would bury the merges nothing could have covered under branch commits nobody expected
 * to be covered, and a block a reader learns to skip reports nothing at all.
 */

function gitOk(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trunk-audit-test-"));
  dirs.push(dir);
  sh(["init", "-q", "-b", "main"], dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(["add", "a.txt"], dir);
  sh(["commit", "-qm", "init"], dir);
  // A local `origin/main` ref rather than a real remote: the audit only ever READS it, and writing
  // the ref directly keeps the fixture offline and deterministic.
  sh(["update-ref", "refs/remotes/origin/main", sh(["rev-parse", "HEAD"], dir)], dir);
  return dir;
}

/** Branch off `from` and do one commit there — an agent taking work at the trunk state it saw. */
function branch(cwd: string, name: string, file: string, body: string, from = "HEAD"): void {
  sh(["checkout", "-q", "-b", name, from], cwd);
  fs.writeFileSync(path.join(cwd, file), body);
  sh(["add", file], cwd);
  sh(["commit", "-qm", `work on ${name}`], cwd);
  sh(["checkout", "-q", "main"], cwd);
}

function merge(cwd: string, name: string): void {
  sh(["merge", "-q", "--no-ff", "-m", `merge(${name})`, name], cwd);
}

function commitOnMain(cwd: string, file: string, body: string): void {
  fs.writeFileSync(path.join(cwd, file), body);
  sh(["add", file], cwd);
  sh(["commit", "-qm", `direct: ${file}`], cwd);
}

describe.skipIf(!gitOk())("trunk audit (t-884b48)", () => {
  it("names the merge trees nothing verified, and counts new content separately", () => {
    const cwd = repo();
    // The measured shape: two agents branch off the trunk state they SAW, the trunk moves under
    // them, and each merge then produces content neither branch gate could have covered. Both
    // branches can be green alone and the merged tree is still something nobody ran.
    branch(cwd, "agent-a", "b.txt", "from a\n");
    branch(cwd, "agent-b", "c.txt", "from b\n");
    commitOnMain(cwd, "d.txt", "trunk moved\n");
    merge(cwd, "agent-a");
    merge(cwd, "agent-b");

    const audit = auditTrunk({ cwd });
    expect(audit.available).toBe(true);
    expect(audit.range).toBe("origin/main..HEAD");
    // First-parent: the direct commit and the two merges. Branch commits are not trunk states.
    expect(audit.commits).toHaveLength(3);
    expect(audit.unverified).toHaveLength(3);
    expect(audit.unprovenMerges).toHaveLength(2);
    expect(audit.unprovenMerges.map((c: { commit: string }) => c.commit))
      .toEqual([sh(["rev-parse", "HEAD"], cwd), sh(["rev-parse", "HEAD^"], cwd)]);

    const text: string = formatTrunkAudit(audit);
    expect(text).toContain("3 of 3 trunk state(s)");
    expect(text).toContain("2 of them merged content nothing has verified");
    expect(text).toContain("merge, new content");
    expect(text).toContain("direct commit");
    // It must say it did not block. A notice a reader takes for a refusal changes their behaviour.
    expect(text).toContain("advisory — nothing was blocked");
  });

  it("a green filed for the merged TREE clears that state, and only that one", () => {
    const cwd = repo();
    branch(cwd, "agent-a", "b.txt", "from a\n");
    branch(cwd, "agent-b", "c.txt", "from b\n");
    merge(cwd, "agent-a");
    expect(recordVerification({ cwd }).recorded).toBe(true); // the coordinator ran the gate here
    merge(cwd, "agent-b");                                   // …then merged again without running it

    const audit = auditTrunk({ cwd });
    expect(audit.commits).toHaveLength(2);
    expect(audit.unverified).toHaveLength(1);
    expect(audit.unverified[0].commit).toBe(sh(["rev-parse", "HEAD"], cwd));
    expect(formatTrunkAudit(audit)).toContain("1 of 2 trunk state(s)");
  });

  it("a merge that introduced no content is NOT counted as unproven merged content", () => {
    // Fast-forward-equivalent: the merge tree equals the branch's, so the branch's own green covers
    // it. Counting it with the rest is how a real finding gets diluted into noise.
    const cwd = repo();
    sh(["checkout", "-q", "-b", "solo"], cwd);
    fs.writeFileSync(path.join(cwd, "b.txt"), "solo\n");
    sh(["add", "b.txt"], cwd);
    sh(["commit", "-qm", "solo work"], cwd);
    sh(["checkout", "-q", "main"], cwd);
    sh(["merge", "-q", "--no-ff", "-m", "merge(solo)", "solo"], cwd);

    const audit = auditTrunk({ cwd });
    expect(audit.commits).toHaveLength(1);
    expect(audit.commits[0].merge).toBe(true);
    expect(audit.commits[0].newContent).toBe(false);
    expect(audit.unverified).toHaveLength(1);
    expect(audit.unprovenMerges).toHaveLength(0);
    const text: string = formatTrunkAudit(audit);
    expect(text).toContain("merge, parent's content");
    expect(text).not.toContain("merged content nothing has verified");
  });

  it("says so when every trunk state is green, instead of going quiet", () => {
    // Silence in the good case makes the warning indistinguishable from a broken warning.
    const cwd = repo();
    branch(cwd, "agent-a", "b.txt", "from a\n");
    merge(cwd, "agent-a");
    recordVerification({ cwd });
    expect(auditTrunk({ cwd }).unverified).toHaveLength(0);
    expect(formatTrunkAudit(auditTrunk({ cwd }))).toContain("all 1 trunk state(s)");

    // Nothing ahead of origin/main at all is a different sentence from "all clear".
    sh(["update-ref", "refs/remotes/origin/main", sh(["rev-parse", "HEAD"], cwd)], cwd);
    expect(formatTrunkAudit(auditTrunk({ cwd }))).toContain("this checkout adds no trunk state");
  });

  it("stays silent off `main` — a branch's commits are not trunk states", () => {
    // Asked from an agent's worktree, a first-parent walk would return that branch's own commits.
    // Reporting them as unproven trunk states is a false statement wearing a measurement's clothes,
    // and it would put the notice in front of every agent, which is how a warning gets tuned out.
    const cwd = repo();
    branch(cwd, "agent-a", "b.txt", "from a\n");
    sh(["checkout", "-q", "agent-a"], cwd);
    expect(defaultAuditRange(cwd)).toBeNull();
    expect(formatTrunkAudit(auditTrunk({ cwd }))).toBeNull();
    // …but an explicit range still answers from anywhere.
    expect(auditTrunk({ cwd, range: "origin/main..agent-a" })).toMatchObject({ available: true });
  });

  it("reports unavailable rather than guessing when there is no origin/main", () => {
    const cwd = repo();
    sh(["update-ref", "-d", "refs/remotes/origin/main"], cwd);
    expect(defaultAuditRange(cwd)).toBeNull();
    const audit = auditTrunk({ cwd });
    expect(audit.available).toBe(false);
    expect(audit.reason).toMatch(/no origin\/main/);
    // No text at all: silence is for "no answer", never for "the answer was bad".
    expect(formatTrunkAudit(audit)).toBeNull();
    // An unresolvable range is the same refusal, not an empty pass.
    expect(auditTrunk({ cwd, range: "no-such-ref..HEAD" })).toMatchObject({ available: false });
  });

  it("the CLI exits 1 on an unproven trunk state and 0 when all are green", () => {
    const cwd = repo();
    branch(cwd, "agent-a", "b.txt", "from a\n");
    merge(cwd, "agent-a");
    const cli = path.join(process.cwd(), "scripts/verify-record.mjs");
    const run = () => {
      try {
        const stdout = execFileSync(process.execPath, [cli, "audit"], { cwd, env: ENV, encoding: "utf8" });
        return { code: 0, stdout };
      } catch (error) {
        const e = error as { status: number; stdout: string };
        return { code: e.status, stdout: e.stdout };
      }
    };
    const red = run();
    expect(red.code).toBe(1);
    expect(red.stdout).toContain("NO green record");
    recordVerification({ cwd });
    expect(run()).toMatchObject({ code: 0 });
  });

  it("NEVER fails the gate it reports beside — an audit that throws is silence", () => {
    // The whole point of this being advisory is that it cannot turn a green run red. A verify:full
    // that fails because its own notice blew up would be a worse defect than the one it reports.
    expect(trunkAuditNotice({
      audit: () => { throw new Error("git exploded"); },
      format: () => "unreachable",
    })).toBeNull();
    expect(trunkAuditNotice({
      audit: () => ({ available: true }),
      format: () => { throw new Error("formatter exploded"); },
    })).toBeNull();
    // …and it passes the audit straight through when both behave.
    expect(trunkAuditNotice({ audit: () => ({ available: true }), format: () => "the notice" })).toBe("the notice");
  });
});
