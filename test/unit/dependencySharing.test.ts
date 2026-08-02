import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  DEPENDENCY_DIR,
  auditSharedDependencies,
  dependencyDirState,
  describeDependencyState,
  fingerprintLockfiles,
  planDependencySharing,
  shareDependencies,
  type LockfileFingerprint,
} from "../../src/worktree/dependencySharing.js";

/**
 * t-3f93b4 — the delegated child that installs 478 MB by itself.
 *
 * The whole point of this suite is the RESSALVA, not the optimization: a shared `node_modules` is
 * only correct while the two checkouts' lockfiles are identical, so every test below that matters is
 * about the moment they stop being identical. `t-b4a799` catalogued this exact defect family — a
 * plausible value standing where "I don't know" belongs — and a symlink that survives a lockfile
 * change is a textbook member of it.
 *
 * The actor × trigger list this covers, named the way the code names it:
 *   create (fresh worktree)      → link when the lockfiles match, refuse when they do not
 *   relaunch (restart/resume)    → RE-decide; a link that went stale is removed and said out loud
 *   mid-session lockfile edit    → `auditSharedDependencies`, the door verify runs through
 *   an agent that installed      → a real `node_modules` is never replaced by a link
 */

const lock = (files: Record<string, string>) =>
  fingerprintLockfiles((name) => (name in files ? Buffer.from(files[name]!) : null));

const MATCHING = { "package-lock.json": '{"lockfileVersion":3,"packages":{}}' };
const CHANGED = { "package-lock.json": '{"lockfileVersion":3,"packages":{"node_modules/left-pad":{}}}' };

describe("fingerprintLockfiles", () => {
  it("is content-addressed, so identical bytes under identical names agree", () => {
    expect(lock(MATCHING).digest).toBe(lock(MATCHING).digest);
    expect(lock(MATCHING).files).toEqual(["package-lock.json"]);
  });

  it("a one-dependency edit changes the digest", () => {
    expect(lock(CHANGED).digest).not.toBe(lock(MATCHING).digest);
  });

  it("an ADDED lockfile is divergence: absence is not the same fact as emptiness", () => {
    // A child that switches the project to pnpm keeps package-lock.json byte-identical and still
    // needs different packages. Digesting only the content of the files the PRIMARY has would call
    // that a match.
    const added = lock({ ...MATCHING, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(added.digest).not.toBe(lock(MATCHING).digest);
    expect(added.files).toEqual(["package-lock.json", "pnpm-lock.yaml"]);
  });

  it("no lockfile at all still digests, and reports an empty file set", () => {
    expect(lock({}).files).toEqual([]);
    expect(lock({}).digest).toHaveLength(64);
  });

  it("cannot be fooled by concatenation: two files' bytes are length-prefixed", () => {
    const split = lock({ "package-lock.json": "ab", "yarn.lock": "c" });
    const joined = lock({ "package-lock.json": "abc" });
    expect(split.digest).not.toBe(joined.digest);
  });
});

describe("planDependencySharing", () => {
  const base = { primaryHasDependencies: true, worktreeDir: "absent" as const };

  it("links identical lockfiles — the case that pays for the whole mechanism", () => {
    const plan = planDependencySharing({ ...base, primary: lock(MATCHING), worktree: lock(MATCHING) });
    expect(plan.kind).toBe("link");
    expect(plan.reason).toContain("identical to the primary checkout");
  });

  it("REFUSES to link a diverged lockfile, and names which file diverged", () => {
    const plan = planDependencySharing({ ...base, primary: lock(MATCHING), worktree: lock(CHANGED) });
    expect(plan.kind).toBe("unshare");
    expect(plan.reason).toContain("package-lock.json");
    expect(plan.reason).toContain("needs its own dependencies");
  });

  it("names an added lockfile specifically, not just 'they differ'", () => {
    const plan = planDependencySharing({
      ...base,
      primary: lock(MATCHING),
      worktree: lock({ ...MATCHING, "pnpm-lock.yaml": "x" }),
    });
    expect(plan.kind).toBe("unshare");
    expect(plan.reason).toContain("adds pnpm-lock.yaml");
  });

  it("never replaces a real node_modules the checkout already owns", () => {
    const plan = planDependencySharing({ ...base, primary: lock(MATCHING), worktree: lock(MATCHING), worktreeDir: "foreign" });
    expect(plan.kind).toBe("leave");
  });

  it("matching lockfiles with nothing to point at is still a refusal, not a dangling link", () => {
    // A dangling symlink reads as "dependencies are present" to every tool that only checks
    // existence — the silent-wrong-answer shape this module exists to refuse.
    const plan = planDependencySharing({
      ...base,
      primary: lock(MATCHING),
      worktree: lock(MATCHING),
      primaryHasDependencies: false,
    });
    expect(plan.kind).toBe("unshare");
    expect(plan.reason).toContain(`no ${DEPENDENCY_DIR} to share`);
  });

  it("says nothing about a project that has no lockfile anywhere", () => {
    const empty: LockfileFingerprint = lock({});
    const plan = planDependencySharing({ ...base, primary: empty, worktree: empty, primaryHasDependencies: false });
    expect(plan.kind).toBe("leave");
    expect(plan.reason).toContain("no lockfile in either checkout");
  });
});

describe("describeDependencyState — what the agent is actually told", () => {
  it("states the sharing CONTRACT, not just the fact", () => {
    const line = describeDependencyState({ mode: "linked", lockDigest: "abc", reason: "lockfiles are identical", at: "t" });
    expect(line).toContain("symlink to the primary checkout");
    expect(line).toContain("Do not reinstall through it");
    expect(line).toContain("say so in your report");
  });

  it("when it must install, it says WHY and hands over the project's own command", () => {
    const line = describeDependencyState(
      { mode: "absent", lockDigest: "abc", reason: "this worktree adds pnpm-lock.yaml", at: "t" },
      "npm ci --ignore-scripts",
    );
    expect(line).toContain("this worktree adds pnpm-lock.yaml");
    expect(line).toContain("npm ci --ignore-scripts");
    expect(line).toContain("before running the configured checks");
  });

  it("does not tell an agent that already has dependencies to install them", () => {
    const line = describeDependencyState({ mode: "own", lockDigest: "abc", reason: "not created by Tachyon", at: "t" });
    expect(line).toContain("its own");
    expect(line).not.toContain("Install");
  });

  it("says nothing when nothing was measured", () => {
    expect(describeDependencyState(undefined)).toBeUndefined();
  });
});

// ─────────────────────────── against a real filesystem ───────────────────────────

function tmpPair(): { root: string; primary: string; worktree: string } {
  const root = makeTempDir("tachyon-deps-");
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(primary);
  fs.mkdirSync(worktree);
  return { root, primary, worktree };
}

const writeLock = (dir: string, body: string) => fs.writeFileSync(path.join(dir, "package-lock.json"), body);

describe("shareDependencies (real fs) — create, relaunch, and the divergence in between", () => {
  it("CREATE: an identical lockfile gets a link instead of a 478 MB install", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    fs.writeFileSync(path.join(primary, DEPENDENCY_DIR, "marker"), "from-primary");

    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(state?.mode).toBe("linked");
    expect(fs.lstatSync(path.join(worktree, DEPENDENCY_DIR)).isSymbolicLink()).toBe(true);
    // The link is USABLE — this is the whole claim: the child can resolve packages through it.
    expect(fs.readFileSync(path.join(worktree, DEPENDENCY_DIR, "marker"), "utf8")).toBe("from-primary");
  });

  it("CREATE: a diverged lockfile is never linked, and the reason survives into the state", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L2-this-branch-changed-a-dependency");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));

    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(state?.mode).toBe("absent");
    expect(state?.reason).toContain("needs its own dependencies");
    expect(fs.existsSync(path.join(worktree, DEPENDENCY_DIR))) .toBe(false);
  });

  it("RELAUNCH: a link that went stale is REMOVED and said out loud — never silently kept", () => {
    // The measured failure mode: the child rebases onto a base whose lockfile moved. Its next launch
    // must not hand it the primary's packages while its briefing says it is on its own branch.
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    expect(shareDependencies({ workspaceRoot: primary, worktreePath: worktree })?.mode).toBe("linked");

    writeLock(worktree, "L2-rebased-onto-a-base-that-bumped-a-dependency");
    const relaunch = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(relaunch?.mode).toBe("absent");
    expect(relaunch?.reason).toContain("package-lock.json");
    expect(relaunch?.reason).toContain("stale shared node_modules link was removed");
    expect(fs.existsSync(path.join(worktree, DEPENDENCY_DIR))).toBe(false);
  });

  it("RELAUNCH: an unchanged lockfile is idempotent — one link, not a churn of unlink/relink", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));

    const first = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });
    const second = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(second?.mode).toBe("linked");
    expect(second?.lockDigest).toBe(first?.lockDigest);
    expect(fs.readlinkSync(path.join(worktree, DEPENDENCY_DIR))).toBe(path.join(primary, DEPENDENCY_DIR));
  });

  it("RELAUNCH: rebasing BACK onto the matching lockfile re-links", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L2");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    expect(shareDependencies({ workspaceRoot: primary, worktreePath: worktree })?.mode).toBe("absent");

    writeLock(worktree, "L1");
    expect(shareDependencies({ workspaceRoot: primary, worktreePath: worktree })?.mode).toBe("linked");
  });

  it("an agent's OWN install is left alone and reported as its own — not overwritten by a link", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    fs.mkdirSync(path.join(worktree, DEPENDENCY_DIR));
    fs.writeFileSync(path.join(worktree, DEPENDENCY_DIR, "mine"), "installed-by-the-agent");

    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(state?.mode).toBe("own");
    expect(fs.readFileSync(path.join(worktree, DEPENDENCY_DIR, "mine"), "utf8")).toBe("installed-by-the-agent");
  });

  it("a symlink pointing somewhere ELSE is foreign — we do not retarget what we did not create", () => {
    const { root, primary, worktree } = tmpPair();
    const stranger = path.join(root, "stranger-modules");
    fs.mkdirSync(stranger);
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    fs.symlinkSync(stranger, path.join(worktree, DEPENDENCY_DIR), "dir");

    expect(shareDependencies({ workspaceRoot: primary, worktreePath: worktree })?.mode).toBe("own");
    expect(fs.readlinkSync(path.join(worktree, DEPENDENCY_DIR))).toBe(stranger);
    expect(dependencyDirState(worktree, path.join(primary, DEPENDENCY_DIR))).toBe("foreign");
  });

  it("a project with no lockfile gets no claim at all", () => {
    const { primary, worktree } = tmpPair();
    expect(shareDependencies({ workspaceRoot: primary, worktreePath: worktree })).toBeUndefined();
  });
});

describe("auditSharedDependencies — the mid-session door, which no relaunch passes through", () => {
  it("stays quiet while the recorded digest still holds", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    expect(auditSharedDependencies({ workspaceRoot: primary, worktreePath: worktree, state })).toBeUndefined();
  });

  it("DETECTS a lockfile the agent edited after the link was made, and says both digests", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    writeLock(worktree, "L2-the-agent-added-a-dependency-mid-session");
    const message = auditSharedDependencies({ workspaceRoot: primary, worktreePath: worktree, state });

    expect(message).toBeDefined();
    expect(message).toContain(state!.lockDigest.slice(0, 12));
    expect(message).toContain("no longer match this branch");
  });

  it("has nothing to say about a checkout that owns its dependencies", () => {
    const { primary, worktree } = tmpPair();
    const own = { mode: "own" as const, lockDigest: "x", reason: "r", at: "t" };
    expect(auditSharedDependencies({ workspaceRoot: primary, worktreePath: worktree, state: own })).toBeUndefined();
    expect(auditSharedDependencies({ workspaceRoot: primary, worktreePath: worktree, state: undefined })).toBeUndefined();
  });

  it("goes quiet once the link is gone — it only speaks for links it can still see", () => {
    const { primary, worktree } = tmpPair();
    writeLock(primary, "L1");
    writeLock(worktree, "L1");
    fs.mkdirSync(path.join(primary, DEPENDENCY_DIR));
    const state = shareDependencies({ workspaceRoot: primary, worktreePath: worktree });

    fs.unlinkSync(path.join(worktree, DEPENDENCY_DIR));
    writeLock(worktree, "L2");

    expect(auditSharedDependencies({ workspaceRoot: primary, worktreePath: worktree, state })).toBeUndefined();
  });
});
