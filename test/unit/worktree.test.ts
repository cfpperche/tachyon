import { describe, it, expect } from "vitest";
import {
  resolveBase,
  pathFor,
  branchFor,
  actionForBranchState,
  validateReuse,
  gitArgs,
  resolveWorktreeCwd,
  WorktreeUnavailableError,
  type WorktreeRecord,
  type WorktreeResolveDeps,
} from "../../src/worktree/WorktreeManager.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

const settings = (s: Partial<TachyonConfig["settings"]> = {}): TachyonConfig["settings"] => s as TachyonConfig["settings"];

describe("WorktreeManager — pure resolvers (spec 210)", () => {
  describe("resolveBase", () => {
    it("uses the configured base, expanding a leading ~", () => {
      expect(resolveBase(settings({ worktree: { base: "~/wt" } }), {}, "/home/me")).toBe("/home/me/wt");
      expect(resolveBase(settings({ worktree: { base: "/abs/wt" } }), {}, "/home/me")).toBe("/abs/wt");
    });
    it("defaults to XDG_CACHE_HOME/tachyon/worktrees, falling back to ~/.cache", () => {
      expect(resolveBase(settings(), { XDG_CACHE_HOME: "/xdg" }, "/home/me")).toBe("/xdg/tachyon/worktrees");
      expect(resolveBase(settings(), {}, "/home/me")).toBe("/home/me/.cache/tachyon/worktrees");
    });
  });

  it("pathFor is <base>/<wsHash>/<agent>", () => {
    expect(pathFor("/base", "abc123", "reviewer")).toBe("/base/abc123/reviewer");
  });

  describe("branchFor — per-agent > global template > default", () => {
    it("per-agent literal branch wins", () => {
      expect(branchFor("rev", settings({ worktree: { branch: "wt/{agent}" } }), { branch: "feature/x" })).toBe("feature/x");
    });
    it("global template substitutes {agent}", () => {
      expect(branchFor("rev", settings({ worktree: { branch: "wt/{agent}-dev" } }), {})).toBe("wt/rev-dev");
    });
    it("defaults to tachyon/<agent>", () => {
      expect(branchFor("rev", settings(), {})).toBe("tachyon/rev");
    });
    it("throws on a template missing {agent} (defensive — config already rejects it)", () => {
      expect(() => branchFor("rev", settings({ worktree: { branch: "fixed" } }), {})).toThrow("{agent}");
    });
  });

  describe("actionForBranchState — the create/attach/fail matrix", () => {
    it("absent → create a Tachyon-owned branch", () => {
      expect(actionForBranchState("b", "absent")).toEqual({ kind: "create", tachyonCreatedBranch: true });
    });
    it("exists-free → attach, NOT owned (so cleanup never force-deletes a human branch)", () => {
      expect(actionForBranchState("b", "exists-free")).toEqual({ kind: "attach", tachyonCreatedBranch: false });
    });
    it("checked-out-elsewhere → fail (never clobber)", () => {
      const a = actionForBranchState("b", "checked-out-elsewhere");
      expect(a.kind).toBe("fail");
      if (a.kind === "fail") expect(a.reason).toContain("already checked out");
    });
  });

  describe("validateReuse — no silent stale reuse", () => {
    const repo = "/repo/.git";
    it("ok when same repo + expected branch", () => {
      expect(validateReuse({ repoCommonDir: repo, worktreeCommonDir: repo, currentBranch: "tachyon/rev", expectedBranch: "tachyon/rev" })).toEqual({ ok: true });
    });
    it("rejects a non-worktree path", () => {
      const r = validateReuse({ repoCommonDir: repo, worktreeCommonDir: null, currentBranch: null, expectedBranch: "b" });
      expect(r.ok).toBe(false);
    });
    it("rejects a different repo (common-dir mismatch)", () => {
      const r = validateReuse({ repoCommonDir: repo, worktreeCommonDir: "/other/.git", currentBranch: "b", expectedBranch: "b" });
      expect(r).toMatchObject({ ok: false });
    });
    it("rejects branch drift (detached or wrong branch)", () => {
      expect(validateReuse({ repoCommonDir: repo, worktreeCommonDir: repo, currentBranch: null, expectedBranch: "b" }).ok).toBe(false);
      const r = validateReuse({ repoCommonDir: repo, worktreeCommonDir: repo, currentBranch: "other", expectedBranch: "b" });
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) expect(r.reason).toContain("expected 'b'");
    });
  });

  describe("resolveWorktreeCwd — spawn-cwd resolution (git mocked)", () => {
    const REC: WorktreeRecord = { path: "/wt/h/rev", branch: "tachyon/rev", tachyonCreatedBranch: true, baseRef: "abc", createdAt: "t" };
    function deps(over: Partial<WorktreeResolveDeps> & { created?: boolean } = {}): { d: WorktreeResolveDeps; notices: string[]; setupRuns: WorktreeRecord[] } {
      const notices: string[] = [];
      const setupRuns: WorktreeRecord[] = [];
      const created = over.created ?? true;
      const { created: _drop, ...overDeps } = over;
      const d: WorktreeResolveDeps = {
        manager: {
          pathForAgent: () => "/wt/h/rev",
          ensure: async () => ({ record: REC, created }),
        } as unknown as WorktreeResolveDeps["manager"],
        settings: {},
        parentCwd: () => undefined,
        runSetup: async (rec) => {
          setupRuns.push(rec);
        },
        notify: (m) => notices.push(m),
        ...overDeps,
      };
      return { d, notices, setupRuns };
    }

    it("non-worktree agent → null (use the default cwd)", async () => {
      const { d } = deps();
      expect(await resolveWorktreeCwd({ name: "a", isRestart: false }, d)).toBeNull();
    });

    it("top-level worktree:true → ensure + run setup once on create", async () => {
      const h = deps();
      const r = await resolveWorktreeCwd({ name: "rev", worktree: true, worktreeSetup: ["pnpm i"], isRestart: false }, h.d);
      expect(r).toEqual({ cwd: "/wt/h/rev", worktree: REC });
      expect(h.setupRuns).toEqual([REC]); // setup ran
    });

    it("does NOT run setup on restart or on a reused checkout (created:false)", async () => {
      const restart = deps();
      await resolveWorktreeCwd({ name: "rev", worktree: true, worktreeSetup: ["pnpm i"], isRestart: true }, restart.d);
      expect(restart.setupRuns).toEqual([]);
      const reuse = deps({ created: false });
      await resolveWorktreeCwd({ name: "rev", worktree: true, worktreeSetup: ["pnpm i"], isRestart: false }, reuse.d);
      expect(reuse.setupRuns).toEqual([]);
    });

    it("sub-agent inherits the parent's cwd and ignores its own worktree flag (with a warning)", async () => {
      const h = deps({ parentCwd: (p) => (p === "boss" ? "/wt/h/boss" : undefined) });
      const r = await resolveWorktreeCwd({ name: "helper", worktree: true, parent: "boss", isRestart: false }, h.d);
      expect(r).toEqual({ cwd: "/wt/h/boss" });
      expect(h.notices.some((n) => n.includes("shares its parent's worktree"))).toBe(true);
    });

    it("git-unusable (ensure throws) → notice + null fallback to root, never blocks", async () => {
      const h = deps({
        manager: {
          pathForAgent: () => "/wt/h/rev",
          ensure: async () => {
            throw new WorktreeUnavailableError("not a git repository", "not-repo");
          },
        } as unknown as WorktreeResolveDeps["manager"],
      });
      const r = await resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, h.d);
      expect(r).toBeNull();
      expect(h.notices.some((n) => n.includes("falling back to the workspace root"))).toBe(true);
    });
  });

  it("gitArgs builds the exact argv each side agrees on", () => {
    expect(gitArgs.addNewBranch("/wt", "tachyon/rev", "HEAD")).toEqual(["worktree", "add", "-b", "tachyon/rev", "/wt", "HEAD"]);
    expect(gitArgs.attachBranch("/wt", "feature/x")).toEqual(["worktree", "add", "/wt", "feature/x"]);
    expect(gitArgs.remove("/wt")).toEqual(["worktree", "remove", "--force", "/wt"]);
    expect(gitArgs.deleteBranch("tachyon/rev")).toEqual(["branch", "-D", "tachyon/rev"]);
    expect(gitArgs.checkRefFormat("a/b")).toEqual(["check-ref-format", "--branch", "a/b"]);
    expect(gitArgs.branchExists("b")).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/b"]);
  });
});
