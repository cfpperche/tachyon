/**
 * t-d29398 — the launch that fails after `git worktree add --lock`, and everything the human then hits.
 *
 * THE MEASURED SEQUENCE, lived by the owner on 2026-08-07 and reproduced here against real git:
 *
 *   1. the product creates the worktree quarantined (`ensure({ quarantineForLaunch: true })`);
 *   2. preparation fails afterwards — for him, a missing `~/.grok/auth.json` at HarnessManager;
 *   3. compensation runs (`rollbackCreated`), which used to preserve the checkout AND its lock;
 *   4. he fixes the real cause (logs in) and launches again;
 *   5. refused — "its Git preparation lock is still present; inspect it and unlock explicitly", an
 *      instruction the product shipped no way to carry out. He read it as grok being unsupported.
 *
 * Two halves are pinned below and they are deliberately separate. Step 3 must no longer leave debris
 * (the checkout this attempt created and never delivered is discarded), and when git refuses to
 * discard it, step 5 must name a door that EXISTS (`releaseLock`) and the door must work. The second
 * half is not made redundant by the first: preservation is still correct whenever there is anything
 * in the tree, and that is exactly when a human needs a way out.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { ManagedWorktreeService } from "@tachyon/engine/worktree/ManagedWorktreeService.js";
import { WorktreeManager, type WorktreeOccupancy } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(opts: { occupancy?: (p: string) => Promise<WorktreeOccupancy | undefined> } = {}) {
  const repo = makeTempDir("tachyon-stuck-repo-");
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.dev"], repo);
  git(["config", "user.name", "T"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(["add", "-A"], repo);
  git(["commit", "-m", "init"], repo);

  const base = makeTempDir("tachyon-stuck-base-");
  const settings: TachyonConfig["settings"] = { worktree: { base } };
  const occupancy = opts.occupancy ?? (async () => undefined);
  const manager = new WorktreeManager({ workspaceRoot: repo, wsHash: "h", getSettings: () => settings, occupancy });
  const svc = new ManagedWorktreeService({
    workspaceRoot: repo, wsHash: "h", getSettings: () => settings, manager, occupancy,
  });
  return { repo, base, manager, svc };
}

/** Step 1: the product's own quarantined create, exactly as `resolveWorktreeCwd` performs it. */
async function quarantinedLaunch(f: ReturnType<typeof fixture>, agent = "grok") {
  const ensured = await f.manager.ensure({ agent, branch: `tachyon/${agent}`, quarantineForLaunch: true });
  expect(ensured.created).toBe(true);
  expect(ensured.preparationLocked).toBe(true);
  expect(await f.manager.lockState(ensured.record.path)).toEqual({ locked: true, reason: "added with --lock" });
  return ensured;
}

describe("t-d29398 — a launch that fails after quarantining its fresh worktree", () => {
  it("discards the checkout it created this attempt, so the retry after the fix simply works", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);

    // Step 3 — the compensation the AgentManager runs when preparation throws.
    await expect(f.manager.rollbackCreated(first.record, first.initialHead, first.initialHead!)).resolves.toBeUndefined();

    // Nothing left behind: not on disk, not in git's ledger, not as a branch this attempt minted.
    expect(fs.existsSync(first.record.path)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], f.repo)).not.toContain(first.record.path);
    expect(git(["branch", "--list", "tachyon/grok"], f.repo).trim()).toBe("");

    // Steps 4-5 — the human fixed the real cause and launched again. This is the assertion the whole
    // task turns on: before the fix it threw `recovery-preserved`.
    const second = await f.manager.ensure({ agent: "grok", branch: "tachyon/grok", quarantineForLaunch: true });
    expect(second.created).toBe(true);
    expect(fs.existsSync(second.record.path)).toBe(true);
  });

  it("keeps an ATTACHED branch when it discards the checkout — the branch is not this attempt's to mint", async () => {
    const f = fixture();
    // A branch that existed before this launch: `ensure` attaches rather than creates it.
    git(["branch", "tachyon/grok"], f.repo);
    const attached = await f.manager.ensure({ agent: "grok", branch: "tachyon/grok", quarantineForLaunch: true });
    expect(attached.record.tachyonCreatedBranch).toBe(false);

    await f.manager.rollbackCreated(attached.record, attached.initialHead, attached.initialHead!);

    expect(fs.existsSync(attached.record.path)).toBe(false);
    // The checkout was this attempt's; the branch was already there and survives untouched.
    expect(git(["branch", "--list", "tachyon/grok"], f.repo)).toContain("tachyon/grok");
  });

  it("preserves — still locked — when git refuses, and says so", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    // Anything uncommitted is enough for git's own soft-remove refusal. That refusal IS the guard:
    // there is no probe-then-act window for a concurrent write to slip through.
    fs.writeFileSync(path.join(first.record.path, "somebody-was-here.txt"), "work\n");

    await expect(f.manager.rollbackCreated(first.record, first.initialHead, first.initialHead!))
      .rejects.toThrow(/preserved/);

    expect(fs.existsSync(path.join(first.record.path, "somebody-was-here.txt"))).toBe(true);
    // Re-armed, not left open: a checkout we could not discard must not be silently reusable.
    expect((await f.manager.lockState(first.record.path))?.locked).toBe(true);
  });

  it("never discards a checkout this attempt did not create", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    await f.manager.completePreparation(first.record);

    // The reuse path's compensation. It is the other half of the distinction: this checkout predates
    // the failing attempt, so it is preserved unconditionally, discard or no discard.
    await expect(f.manager.rollbackPreparation(first.record, first.initialHead!, first.initialHead!))
      .rejects.toThrow(/preserved/);
    expect(fs.existsSync(first.record.path)).toBe(true);
  });

  it("refuses to discard a checkout an agent is standing in", async () => {
    const occupied: WorktreeOccupancy = { state: "live", agent: "codex", cwd: "/anywhere" };
    const f = fixture({ occupancy: async () => occupied });
    const first = await quarantinedLaunch(f);

    await expect(f.manager.rollbackCreated(first.record, first.initialHead, first.initialHead!))
      .rejects.toThrow(/occupied by agent 'codex'/);
    expect(fs.existsSync(first.record.path)).toBe(true);
    expect((await f.manager.lockState(first.record.path))?.locked).toBe(true);
  });
});

describe("t-d29398 — the refusal a preserved lock produces, and the door it names", () => {
  it("names the door instead of ordering an unlock the product cannot perform", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    fs.writeFileSync(path.join(first.record.path, "work.txt"), "keep\n");
    await expect(f.manager.rollbackCreated(first.record, first.initialHead, first.initialHead!)).rejects.toThrow();

    const retry = await f.manager
      .ensure({ agent: "grok", branch: "tachyon/grok", quarantineForLaunch: true })
      .catch((err: unknown) => err as Error);
    expect(retry).toBeInstanceOf(Error);
    const message = (retry as Error).message;
    // The exact sentence the owner could not act on, gone.
    expect(message).not.toContain("inspect it and unlock explicitly");
    // Replaced by a gesture that exists, plus the fact his second message never mentioned: that an
    // EARLIER launch left this, so fixing the original cause was never going to clear it.
    expect(message).toContain("Release lock");
    expect(message).toContain("Control → Worktrees");
    expect(message).toMatch(/^Open Control → Worktrees/);
    expect(message).toMatch(/earlier launch was interrupted/);
    expect(message.indexOf("Control → Worktrees")).toBeLessThan(message.indexOf(first.record.path));
  });

  it("releases the lock without touching what is inside, and the next launch reuses the checkout", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    fs.writeFileSync(path.join(first.record.path, "work.txt"), "keep\n");
    await expect(f.manager.rollbackCreated(first.record, first.initialHead, first.initialHead!)).rejects.toThrow();
    f.svc.syncAgentRecord("grok", first.record);
    const entry = f.svc.list({ kind: "agent" })[0]!;

    const released = await f.svc.releaseLock(entry.id, { actor: { kind: "human" } });
    // No `lockReason` here, and that is the documented consequence of the re-arm above: a refused
    // discard re-locks with a plain `git worktree lock`, which carries no reason text. The FACT of the
    // quarantine is what every refusal and the classifier read.
    expect(released).toMatchObject({ released: true });

    // Non-destructive: releasing a quarantine is not a removal, and the file nobody classified is
    // still there for its owner to look at.
    expect(fs.readFileSync(path.join(first.record.path, "work.txt"), "utf8")).toBe("keep\n");
    expect((await f.manager.lockState(first.record.path))?.locked).toBe(false);

    const reused = await f.manager.ensure({ agent: "grok", branch: "tachyon/grok", quarantineForLaunch: true });
    expect(reused.created).toBe(false);
    expect(reused.record.path).toBe(first.record.path);
  });

  it("is idempotent — a second release is not an error to explain", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    f.svc.syncAgentRecord("grok", first.record);
    const entry = f.svc.list({ kind: "agent" })[0]!;
    // Never discarded here, so git's own `added with --lock` reason is still the one reported back.
    expect(await f.svc.releaseLock(entry.id, { actor: { kind: "human" } }))
      .toMatchObject({ released: true, lockReason: "added with --lock" });
    expect(await f.svc.releaseLock(entry.id, { actor: { kind: "human" } })).toMatchObject({ released: true });
  });

  it("refuses while a live agent occupies the checkout, and names who to stop", async () => {
    const occupied: WorktreeOccupancy = { state: "live", agent: "codex", cwd: "/anywhere" };
    const f = fixture({ occupancy: async () => occupied });
    const first = await quarantinedLaunch(f);
    f.svc.syncAgentRecord("grok", first.record);
    const entry = f.svc.list({ kind: "agent" })[0]!;

    const refusal = await f.svc.releaseLock(entry.id, { actor: { kind: "human" } });
    expect(refusal.released).toBe(false);
    expect(refusal.error).toContain("codex");
    expect((await f.manager.lockState(first.record.path))?.locked).toBe(true);
  });

  it("shows the lock in the classification, so the surface stops offering a Remove that git refuses", async () => {
    const f = fixture();
    const first = await quarantinedLaunch(f);
    f.svc.syncAgentRecord("grok", first.record);

    const [row] = await f.svc.listClassified();
    // Clean, unoccupied and contained — it would have read `ready-to-remove` before the lock was
    // measured, and `git worktree remove` refuses a locked checkout even with `--force` (measured).
    expect(row!.classification.dirty).toBe(false);
    expect(row!.classification.aheadOfBase).toBe(0);
    expect(row!.classification.lock).toEqual({ reason: "added with --lock" });
    expect(row!.classification.state).toBe("needs-review");
    expect(row!.classification.reasons[0]).toMatch(/Git worktree lock/);

    // And the removal door refuses with that reason rather than a raw git fatal.
    const refused = await f.svc.removeClassified(row!.id, { actor: { kind: "human" } });
    expect(refused.removed).toBe(false);
    expect(refused.error).toMatch(/Git worktree lock/);

    // Released, it classifies exactly as it did before — the lock is the only thing that was wrong.
    await f.svc.releaseLock(row!.id, { actor: { kind: "human" } });
    const [after] = await f.svc.listClassified();
    expect(after!.classification.lock).toBeUndefined();
    expect(after!.classification.state).toBe("ready-to-remove");
  });
});
