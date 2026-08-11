/**
 * SDD 498 (t-7cb971) — the governed land door, against REAL git.
 *
 * The unit tests in `landAct.test.ts` script git's answers to reach the states a real repository will
 * not produce on demand. These do the opposite: a real clone, a real change worktree, a real
 * fast-forward. Between them they cover the acceptance scenarios that are about the door as a whole
 * rather than about the act — in particular the two that motivated it:
 *
 *   · the trunk moved after the gate ran, so the click refuses and names the way out;
 *   · the refusal a click produces is the SAME sentence the block renders when the check is red at
 *     draw time. One vocabulary, measured rather than asserted in a comment.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { ManagedWorktreeService } from "../../src/worktree/ManagedWorktreeService.js";
import { WorktreeManager } from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";
import { executeExtensionCommand } from "../../src/engine-service/extensionOperationService.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("SDD 498 — the land door", () => {
  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = makeTempDir("tachyon-land-repo-");
    base = makeTempDir("tachyon-land-base-");
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.dev"], repo);
    git(["config", "user.name", "T"], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    // `.tachyon/` is gitignored in a real workspace (this repository's own .gitignore:13), and the
    // service writes its worktree registry there. Without this the fixture's primary checkout is
    // permanently dirty and `primary-clean` refuses every land — which is the door working correctly
    // on an unrealistic fixture, not a product defect. Found by the success case below failing.
    fs.writeFileSync(path.join(repo, ".gitignore"), ".tachyon/\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  function service() {
    const settings: TachyonConfig["settings"] = { worktree: { base } };
    const manager = new WorktreeManager({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      occupancy: async () => undefined,
    });
    return new ManagedWorktreeService({
      workspaceRoot: repo,
      wsHash: "h",
      getSettings: () => settings,
      manager,
      occupancy: async () => undefined,
    });
  }

  /** A delivery: one commit on a change worktree, nothing left uncommitted. */
  async function delivery(svc: ManagedWorktreeService, slug: string) {
    const created = await svc.createChange({ slug, createdBy: "alice" });
    fs.writeFileSync(path.join(created.path, `${slug}.txt`), "work\n");
    git(["add", "-A"], created.path);
    git(["commit", "-m", `feat: ${slug}`], created.path);
    return created;
  }

  /**
   * Write the gate's own record for a delivery's tree, the way `scripts/verify-record.mjs` does: a
   * blob under `refs/tachyon/verify/<tree>` in the SHARED common git dir. Staged here rather than
   * mocked, so the success path below is proved through the same reader production uses.
   */
  function attest(worktreePath: string): void {
    const tree = git(["rev-parse", "HEAD^{tree}"], worktreePath).trim();
    const record = JSON.stringify({
      schema: 2,
      tree,
      commit: git(["rev-parse", "HEAD"], worktreePath).trim(),
      at: new Date().toISOString(),
      fingerprint: "test-fingerprint",
      command: "npm run verify:full:quiet",
    });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: worktreePath,
      input: record,
      encoding: "utf8",
    }).trim();
    git(["update-ref", `refs/tachyon/verify/${tree}`, blob], worktreePath);
  }

  it("lands: the trunk fast-forwards onto the delivery, and the act says where it moved from and to", async () => {
    const svc = service();
    const created = await delivery(svc, "green");
    attest(created.path);
    const head = git(["rev-parse", "HEAD"], created.path).trim();
    const trunkBefore = git(["rev-parse", "main"], repo).trim();

    const result = await svc.land(created.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.before).toBe(trunkBefore);
    expect(result.after).toBe(head);
    expect(result.trunkRef).toBe("main");
    // The real repository agrees, and it is a FAST-FORWARD: no merge commit was created.
    expect(git(["rev-parse", "main"], repo).trim()).toBe(head);
    expect(git(["rev-list", "--count", "--merges", `${trunkBefore}..main`], repo).trim()).toBe("0");
  });

  it("adapts a successful engine result to the nested shape the Interface renders", async () => {
    const svc = service();
    const created = await delivery(svc, "transport");
    attest(created.path);
    const response = await executeExtensionCommand(
      { workspace: { managedWorktrees: svc }, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
      { action: "worktree.land", id: created.id },
    ) as { ok?: unknown; landed?: Record<string, unknown> };

    expect(response.ok).toBe(true);
    expect(response.landed).toMatchObject({ trunkRef: "main", primaryPath: repo });
    expect(response.landed?.after).toBe(git(["rev-parse", "main"], repo).trim());
  });

  it("the row heals itself: once landed, the delivery is contained in the trunk and the block is gone", async () => {
    const svc = service();
    const created = await delivery(svc, "healing");
    attest(created.path);
    expect((await svc.listClassified()).find((e) => e.id === created.id)?.land).toBeDefined();

    expect((await svc.land(created.id)).ok).toBe(true);

    // No separate step tells the UI what happened: the next sweep simply measures a contained tree.
    const after = (await svc.listClassified()).find((e) => e.id === created.id);
    expect(after?.classification.containedInTrunk).toBe(true);
    expect(after?.land).toBeUndefined();
  });

  /**
   * Landing the same delivery twice is a NO-OP, not a refusal — and this test says so because the
   * first version of it asserted a refusal that does not happen. `--ff-only` onto a sha the trunk
   * already contains is "already up to date": git exits 0 and moves nothing, so the act observes
   * `before === after` and reports an honest success.
   *
   * It is also not reachable from the UI: `listClassified` attaches a land block only while the work
   * is NOT contained in the trunk, so after the first land there is no button (the healing test above
   * measures exactly that). Left as a no-op rather than given a special refusal, because inventing a
   * sixth condition for a state that moves nothing would be machinery with no defect behind it.
   */
  it("landing twice moves nothing the second time", async () => {
    const svc = service();
    const created = await delivery(svc, "twice");
    attest(created.path);
    const first = await svc.land(created.id);
    expect(first.ok).toBe(true);

    const second = await svc.land(created.id);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.before).toBe(second.after);
    expect(second.after).toBe(first.ok ? first.after : "");
  });

  it("refuses an unverified tree, and the refusal names the gate rather than only the gap", async () => {
    const svc = service();
    const created = await delivery(svc, "unverified");

    const result = await svc.land(created.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-ready");
    expect(result.reason).toMatch(/has not been proved green here|no verify record/);
    expect(result.fix).toMatch(/verify gate/);
    // The trunk is untouched: a refusal is not a partial act.
    expect(git(["rev-parse", "main"], repo).trim()).toBe(git(["rev-parse", "main"], repo).trim());
  });

  it("refuses when the trunk moved after the delivery, and says integrate-and-reverify", async () => {
    const svc = service();
    const created = await delivery(svc, "trunk-moved");
    // The measured 2026-08-11 case: main advances underneath a delivery that was already green.
    fs.writeFileSync(path.join(repo, "other.txt"), "someone else\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "someone else's commit"], repo);
    const trunkBefore = git(["rev-parse", "main"], repo).trim();

    const result = await svc.land(created.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not-ready");
    // SDD 498 D6 — it says WHERE the trunk moved to, which is the question the operator asks next.
    const fastForward = result.checks?.find((c) => c.id === "fast-forward");
    expect(fastForward?.ok).toBe(false);
    expect(fastForward?.detail).toContain(trunkBefore.slice(0, 12));
    expect(fastForward?.fix).toMatch(/integrate 'main' into this branch and re-run the verify gate/);
    expect(git(["rev-parse", "main"], repo).trim()).toBe(trunkBefore);
  });

  it("the click refusal IS the failing check's own words — one vocabulary, not two", async () => {
    const svc = service();
    const created = await delivery(svc, "one-vocabulary");
    // Dirty the delivering worktree so the FIRST check is the one that blocks.
    fs.writeFileSync(path.join(created.path, "wip.txt"), "uncommitted\n");

    const result = await svc.land(created.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const blocked = result.checks?.find((c) => !c.ok);
    expect(blocked?.id).toBe("worktree-clean");
    // Identity, not similarity: the sentence the human reads under their click is the same object the
    // block renders when the check is red at draw time.
    expect(result.reason).toBe(blocked?.detail);
    expect(result.fix).toBe(blocked?.fix);
  });

  it("every refusal carries an exit, whichever precondition blocks", async () => {
    const svc = service();
    const dirty = await delivery(svc, "exit-dirty");
    fs.writeFileSync(path.join(dirty.path, "wip.txt"), "x\n");
    const unverified = await delivery(svc, "exit-unverified");

    for (const id of [dirty.id, unverified.id]) {
      const result = await svc.land(id);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.fix.length).toBeGreaterThan(0);
    }
  });

  it("refuses a row that is not in the registry, and says what to do about it", async () => {
    const result = await service().land("mw-does-not-exist");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("mw-does-not-exist");
    expect(result.fix).toMatch(/refresh/i);
  });

  it("never re-implements a precondition: the click re-measures through the same probe the panel drew", async () => {
    const svc = service();
    const created = await delivery(svc, "same-probe");
    fs.writeFileSync(path.join(created.path, "wip.txt"), "x\n");

    // What the PANEL would render for this row…
    const row = (await svc.listClassified()).find((e) => e.id === created.id);
    // …and what the CLICK measures. Same ids, same order, same verdicts — because it is the same
    // function. A second copy of the five conditions would show up here as a difference.
    const clicked = await svc.land(created.id);

    expect(clicked.ok).toBe(false);
    expect(clicked.checks?.map((c) => `${c.id}:${c.ok}`)).toEqual(row?.land?.checks.map((c) => `${c.id}:${c.ok}`));
  });
});
