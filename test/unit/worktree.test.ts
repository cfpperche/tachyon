import fs from "node:fs";
import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import {
  resolveBase,
  pathFor,
  branchFor,
  actionForBranchState,
  validateReuse,
  gitArgs,
  resolveWorktreeCwd,
  temporaryBranchFor,
  WorktreeUnavailableError,
  WorktreeManager,
  type WorktreeRecord,
  type WorktreeResolveDeps,
} from "../../src/worktree/WorktreeManager.js";
import { AGENT_NAME_PATTERN } from "../../src/config/nameValidation.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

const settings = (s: Partial<TachyonConfig["settings"]> = {}): TachyonConfig["settings"] => s as TachyonConfig["settings"];

describe("WorktreeManager — pure resolvers (spec 210)", () => {
  it("shares one canonical path mutex between agent and direct-path callers", async () => {
    const manager = new WorktreeManager({ workspaceRoot: "/repo", wsHash: "abc123",
      getSettings: () => settings({ worktree: { base: "/base" } }) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const first = manager.withAgentPathLock("worker", async () => { await held; });
    const second = manager.withPathLock("/base/abc123/worker", async () => { entered = true; });
    await Promise.resolve();
    expect(entered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(entered).toBe(true);
  });

  it("allows nested same-path lock acquisition (prune holds path lock then remove re-enters)", async () => {
    // t-3fb6eb: DeliveryProjectionService.prune -> withWorktreeLock -> removeManagedWorktree -> remove
    // must not deadlock on the non-reentrant promise-chain mutex.
    const manager = new WorktreeManager({ workspaceRoot: "/repo", wsHash: "abc123",
      getSettings: () => settings({ worktree: { base: "/base" } }) });
    const path = "/base/abc123/recovprincfix";
    let nested = false;
    await manager.withPathLock(path, async () => {
      await manager.withPathLock(path, async () => { nested = true; });
    });
    expect(nested).toBe(true);
  });

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
          // ensure invokes runSetup under its lock when it created the checkout (mirrors the real one)
          ensure: async (o: { runSetup?: (r: WorktreeRecord) => Promise<void> }) => {
            if (created && o.runSetup) await o.runSetup(REC);
            return { record: REC, created };
          },
        } as unknown as WorktreeResolveDeps["manager"],
        settings: {},
        resolveParent: async () => ({ known: false }),
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
      expect(r).toEqual({ cwd: "/wt/h/rev", worktree: REC, created: true });
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

    it("sub-agent without worktree opt-in inherits the parent's cwd", async () => {
      const h = deps({ resolveParent: async (p: string) => (p === "boss" ? { cwd: "/wt/h/boss", known: true } : { known: false }) });
      const r = await resolveWorktreeCwd({ name: "helper", parent: "boss", isRestart: false }, h.d);
      expect(r).toEqual({ cwd: "/wt/h/boss" });
      expect(h.notices).toEqual([]);
    });

    /**
     * t-c9da28 — the two ways a parent can have no cwd are not the same failure, and both used to
     * end at the workspace root in silence.
     *
     * `spawn_agent` refuses an explicit `cwd` for a parented child precisely so the caller is never
     * misled about where it runs. One step earlier this substituted a directory nobody asked for —
     * the root, which is where an isolated child least belongs — and said nothing at all.
     */
    describe("a parent with no recorded cwd", () => {
      it("refuses when no such agent is known, instead of picking someone else's checkout", async () => {
        const h = deps({ resolveParent: async () => ({ known: false }) });

        await expect(resolveWorktreeCwd({ name: "helper", parent: "ghost", isRestart: false }, h.d))
          .rejects.toThrow(/parent 'ghost'/);
        // Refusal is the whole answer here: no notice, because nothing fell back.
        expect(h.notices).toEqual([]);
      });

      it("still spawns a child of a KNOWN parent, but says where it landed and why", async () => {
        // The case that must keep working: a coordinator whose ledger row was retired while it lives.
        const h = deps({ resolveParent: async () => ({ known: true }) });

        const r = await resolveWorktreeCwd({ name: "helper", parent: "boss", isRestart: false }, h.d);

        expect(r).toBeNull(); // null → the AgentManager uses the root
        expect(h.notices).toEqual([
          "'helper' falling back to the workspace root — parent 'boss' has no recorded working directory",
        ]);
      });

      it("prefers a recovered directory over falling back, when one can still be found", async () => {
        // "Known" is not the answer when an authoritative record survives — inherit, do not fall back.
        const h = deps({ resolveParent: async () => ({ cwd: "/wt/h/recovered", known: true }) });

        expect(await resolveWorktreeCwd({ name: "helper", parent: "boss", isRestart: false }, h.d))
          .toEqual({ cwd: "/wt/h/recovered" });
        expect(h.notices).toEqual([]);
      });
    });

    /**
     * t-da80ed — a `workspace.cwd` declared in the profile was computed and thrown away whenever the
     * agent had a worktree: this resolver's answer overrides it unconditionally, and the ctx did not
     * even carry the declaration, so nothing could report the loss. The human typed a path, saved
     * without error, and the runtime ran somewhere else in silence.
     *
     * The precedence is deliberate and stays (isolation IS the working directory, decided on the
     * task). What must not stay is the silence — the same shape this file already uses for every
     * other directory it substitutes.
     */
    describe("a profile that declares a cwd the resolver overrides", () => {
      it("says so when the worktree wins, and still launches", async () => {
        const h = deps();

        const r = await resolveWorktreeCwd(
          { name: "rev", worktree: true, isRestart: false, declaredCwd: "/repo/packages/api" },
          h.d,
        );

        expect(r).toEqual({ cwd: "/wt/h/rev", worktree: REC, created: true });
        expect(h.notices).toEqual([
          "'rev' declares workspace.cwd /repo/packages/api, but it runs in its own git worktree, which IS its working directory — running in /wt/h/rev instead",
        ]);
      });

      it("says so on RESTART too — restart resolves the cwd through this same override", async () => {
        const h = deps({ created: false });

        await resolveWorktreeCwd(
          { name: "rev", worktree: true, isRestart: true, declaredCwd: "/repo/packages/api" },
          h.d,
        );

        expect(h.notices).toHaveLength(1);
        expect(h.notices[0]).toContain("running in /wt/h/rev instead");
      });

      it("says so when a sub-agent inherits its parent's directory instead", async () => {
        const h = deps({ resolveParent: async () => ({ cwd: "/wt/h/boss", known: true }) });

        const r = await resolveWorktreeCwd(
          { name: "helper", parent: "boss", isRestart: false, declaredCwd: "/repo/packages/api" },
          h.d,
        );

        expect(r).toEqual({ cwd: "/wt/h/boss" });
        expect(h.notices).toEqual([
          "'helper' declares workspace.cwd /repo/packages/api, but a sub-agent runs where its parent 'boss' runs — running in /wt/h/boss instead",
        ]);
      });

      it("stays quiet when the declaration is what the agent actually got", async () => {
        // Nothing was discarded, so there is nothing to warn about: a notice here would train the
        // human to ignore the one that matters.
        const h = deps({ resolveParent: async () => ({ cwd: "/wt/h/boss", known: true }) });

        await resolveWorktreeCwd(
          { name: "helper", parent: "boss", isRestart: false, declaredCwd: "/wt/h/boss/" },
          h.d,
        );

        expect(h.notices).toEqual([]);
      });

      it("stays quiet when the worktree is unavailable — the declared cwd is honoured there", async () => {
        // The fallback returns null, and the AgentManager then keeps the cwd it already resolved from
        // the profile. Warning about a discard that did not happen would be a lie in the other
        // direction; the existing fallback notice is the whole story.
        const h = deps({
          manager: {
            pathForAgent: () => "/wt/h/rev",
            ensure: async () => {
              throw new WorktreeUnavailableError("not a git repository", "not-repo");
            },
          } as unknown as WorktreeResolveDeps["manager"],
        });

        expect(await resolveWorktreeCwd(
          { name: "rev", worktree: true, isRestart: false, declaredCwd: "/repo/packages/api" },
          h.d,
        )).toBeNull();
        expect(h.notices).toEqual([
          "'rev' falling back to the workspace root — not a git repository",
        ]);
      });

      it("stays quiet for the ordinary agent that declares nothing", async () => {
        const h = deps();

        await resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, h.d);

        expect(h.notices).toEqual([]);
      });
    });

    it("parented worktree:true opts into its own isolated worktree", async () => {
      const h = deps({ resolveParent: async (p: string) => (p === "boss" ? { cwd: "/wt/h/boss", known: true } : { known: false }) });
      const r = await resolveWorktreeCwd({ name: "helper", worktree: true, parent: "boss", isRestart: false }, h.d);
      expect(r).toEqual({ cwd: "/wt/h/rev", worktree: REC, created: true });
      expect(h.notices).toEqual([]);
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

    it("propagates a launch-quarantine collision instead of falling back to the workspace root", async () => {
      const h = deps({
        manager: {
          pathForAgent: () => "/wt/h/rev",
          ensure: async () => {
            throw new WorktreeUnavailableError("preparation lock is already held", "recovery-preserved");
          },
        } as unknown as WorktreeResolveDeps["manager"],
      });

      await expect(resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, h.d))
        .rejects.toMatchObject({ reason: "recovery-preserved" });
      expect(h.notices).toEqual([]);
    });

    it("preserves a prior checkout when repository probes fail instead of falling back to root", async () => {
      const manager = new WorktreeManager({
        workspaceRoot: "/repo",
        wsHash: "h",
        getSettings: () => settings({ worktree: { base: "/wt" } }),
        pathExists: (candidate) => candidate === REC.path,
        git: async () => ({ stdout: "", stderr: "injected repository probe failure", code: 1 }),
      });
      const notices: string[] = [];

      await expect(resolveWorktreeCwd(
        { name: "rev", worktree: true, branch: REC.branch, isRestart: true },
        {
          manager,
          settings: settings({ worktree: { base: "/wt" } }),
          resolveParent: async () => ({ known: false }),
          priorRecord: REC,
          runSetup: async () => {},
          notify: (message) => notices.push(message),
        },
      )).rejects.toMatchObject({ reason: "recovery-preserved" });
      expect(notices).toEqual([]);
    });

    it("refuses invalid branch-template drift with the persisted recovery path", async () => {
      let ensured = false;
      const h = deps({
        priorRecord: REC,
        settings: settings({ worktree: { branch: "shared-without-placeholder" } }),
        manager: {
          pathForAgent: () => "/new/config/path/rev",
          ensure: async () => { ensured = true; throw new Error("must not run"); },
        } as unknown as WorktreeResolveDeps["manager"],
      });

      await expect(resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: true }, h.d))
        .rejects.toMatchObject({
          reason: "recovery-preserved",
          message: expect.stringContaining(REC.path),
        });
      expect(ensured).toBe(false);
      expect(h.notices).toEqual([]);
    });

    it("fails closed with a recovery path on an unexpected Git rejection", async () => {
      const h = deps({
        manager: {
          pathForAgent: () => REC.path,
          ensure: async () => { throw new Error("injected later Git spawn failure"); },
        } as unknown as WorktreeResolveDeps["manager"],
      });

      await expect(resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, h.d))
        .rejects.toMatchObject({
          reason: "recovery-preserved",
          message: expect.stringContaining(REC.path),
        });
      expect(h.notices).toEqual([]);
    });

    /**
     * spec 484 — a Temporary child's branch is minted per SPAWN; a declared agent's stays derived
     * from its name.
     *
     * `actionForBranchState` maps `exists-free` → attach, which is correct for a declared agent (the
     * branch is its identity) and wrong for a Temporary (the name is reusable). Under the
     * name-derived template the second `codex-residuo` would attach to the first one's branch and
     * build on a stranger's commits while its briefing says it starts from main. These pin that the
     * adoption state is UNREACHABLE for a Temporary, not merely guarded.
     */
    describe("branch identity of a Temporary child", () => {
      /** capture the branch `ensure()` is actually asked for — the only thing that decides adoption */
      function branchProbe(over: Partial<WorktreeResolveDeps> = {}): { d: WorktreeResolveDeps; asked: string[] } {
        const asked: string[] = [];
        const d: WorktreeResolveDeps = {
          manager: {
            pathForAgent: () => "/wt/h/x",
            ensure: async (o: { branch: string }) => {
              asked.push(o.branch);
              return { record: { ...REC, branch: o.branch }, created: true };
            },
          } as unknown as WorktreeResolveDeps["manager"],
          settings: {},
          resolveParent: async () => ({ cwd: "/wt/h/boss", known: true }),
          runSetup: async () => {},
          notify: () => {},
          ...over,
        };
        return { d, asked };
      }

      it("never asks for the name-derived branch, so a leftover one cannot be adopted", async () => {
        const h = branchProbe();

        await resolveWorktreeCwd(
          { name: "codex-residuo", worktree: true, parent: "boss", temporary: true, isRestart: false },
          h.d,
        );

        // The whole defect in one assertion: this is the branch the FIRST child of this name owns.
        expect(h.asked).not.toContain("tachyon/codex-residuo");
        expect(h.asked[0]).toMatch(/^tachyon\/tmp\.codex-residuo\./u);
      });

      it("gives two spawns of the SAME name two different branches", async () => {
        const first = branchProbe();
        const second = branchProbe();
        const ctx = { name: "codex-residuo", worktree: true, parent: "boss", temporary: true, isRestart: false };

        await resolveWorktreeCwd({ ...ctx }, first.d);
        await resolveWorktreeCwd({ ...ctx }, second.d);

        expect(first.asked[0]).not.toBe(second.asked[0]);
      });

      it("leaves a DECLARED agent's branch exactly as it was — template and default alike", async () => {
        const plain = branchProbe();
        await resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, plain.d);
        expect(plain.asked).toEqual(["tachyon/rev"]);

        const templated = branchProbe({ settings: settings({ worktree: { branch: "wt/{agent}" } }) });
        await resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, templated.d);
        expect(templated.asked).toEqual(["wt/rev"]);
      });

      it("keeps its OWN prior record's branch — a relaunch is the same child, not a namesake", async () => {
        // Not the defect this fixes: a prior record is this agent's own persisted row. Minting a
        // fresh branch here would also strand the checkout `ensure()` reuses at `prior.path`.
        const h = branchProbe({ priorRecord: { ...REC, branch: "tachyon/tmp.codex-residuo.20260801-203145-9f3c" } });

        await resolveWorktreeCwd(
          { name: "codex-residuo", worktree: true, parent: "boss", temporary: true, isRestart: true },
          h.d,
        );

        expect(h.asked).toEqual(["tachyon/tmp.codex-residuo.20260801-203145-9f3c"]);
      });

      it("is wired: the Workspace hands the resolver the Temporary fact it already computes", () => {
        // Everything above resolves off `ctx.temporary`, so the product behaviour rests on one line
        // of plumbing. Drop it and every spawn looks declared to the resolver, the name-derived
        // branch comes straight back, and not one unit test above would notice.
        const workspace = fs.readFileSync(nodePath.join(process.cwd(), "src/workspace/Workspace.ts"), "utf8");
        expect(workspace.match(/temporary: ctx\.temporary/gu)?.length ?? 0).toBe(1);
      });

      it("still honours an explicitly named branch — that is an identity the caller owns", async () => {
        const h = branchProbe();

        await resolveWorktreeCwd(
          { name: "codex-residuo", worktree: true, parent: "boss", temporary: true, branch: "feature/x", isRestart: false },
          h.d,
        );

        expect(h.asked).toEqual(["feature/x"]);
      });
    });

    describe("temporaryBranchFor — the shape, and why it cannot collide", () => {
      const at = new Date("2026-08-01T20:31:45.123Z");

      it("reads as the agent it belonged to, with when it was born", () => {
        expect(temporaryBranchFor("codex-residuo", at, "9f3c")).toBe("tachyon/tmp.codex-residuo.20260801-203145-9f3c");
      });

      it("is disjoint from the declared namespace by CONSTRUCTION, not by convention", () => {
        // `tachyon/tmp.…` can only equal `tachyon/{agent}` if some valid agent name contains a dot.
        // AGENT_NAME_PATTERN forbids one, so the two namespaces can never meet — and staying flat
        // under `tachyon/` also avoids the ref directory/file clash a nested form would create with
        // an agent actually named `tmp`.
        const leaf = temporaryBranchFor("codex-residuo", at, "9f3c").slice("tachyon/".length);
        expect(leaf).toContain(".");
        expect(AGENT_NAME_PATTERN.test(leaf)).toBe(false);
      });

      it("mints a fresh value per call, even within the same second", () => {
        const seen = new Set(Array.from({ length: 32 }, () => temporaryBranchFor("codex-residuo", at)));
        expect(seen.size).toBe(32);
      });

      it("stays inside what git accepts for a branch name", () => {
        const branch = temporaryBranchFor("codex-residuo", at, "9f3c");
        expect(branch).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/u);
        expect(branch).not.toContain("..");
        expect(branch.endsWith(".lock")).toBe(false);
      });
    });

    /**
     * spec 484 — `null` here means "the AgentManager uses the workspace ROOT". Who asked decides
     * whether that is a home or the worst possible answer.
     */
    describe("isolation asked for and not delivered", () => {
      const unavailable = (over: Partial<WorktreeResolveDeps> = {}) => deps({
        manager: {
          pathForAgent: () => "/wt/h/rev",
          ensure: async () => { throw new WorktreeUnavailableError("not a git repository", "not-repo"); },
        } as unknown as WorktreeResolveDeps["manager"],
        resolveParent: async () => ({ cwd: "/wt/h/boss", known: true }),
        ...over,
      });

      it("refuses to put a PARENTED child in the human's checkout, and names the reason", async () => {
        const h = unavailable();

        await expect(resolveWorktreeCwd(
          { name: "helper", worktree: true, parent: "boss", isRestart: false },
          h.d,
        )).rejects.toMatchObject({
          reason: "not-repo",
          message: expect.stringContaining("asked for an isolated worktree under parent 'boss'"),
        });
        // A notice would be the tell that it degraded and carried on.
        expect(h.notices).toEqual([]);
      });

      it("still lets a TOP-LEVEL agent fall back to its own home, unchanged", async () => {
        // The asymmetry is the point: for a top-level agent the root IS its normal home, so refusing
        // would brick it over a git condition it can work without.
        const h = unavailable();

        expect(await resolveWorktreeCwd({ name: "rev", worktree: true, isRestart: false }, h.d)).toBeNull();
        expect(h.notices).toEqual([
          "'rev' falling back to the workspace root — not a git repository",
        ]);
      });
    });
  });

  it.each([2, 3])("isUsableRepo normalizes a rejection from Git probe %i", async (rejectAt) => {
    let calls = 0;
    const manager = new WorktreeManager({
      workspaceRoot: "/repo",
      wsHash: "h",
      getSettings: () => settings({}),
      git: async () => {
        calls += 1;
        if (calls === rejectAt) throw new Error(`probe ${rejectAt} unavailable`);
        return { stdout: calls === 1 ? ".git\n" : calls === 2 ? "false\n" : "abc\n", stderr: "", code: 0 };
      },
    });

    await expect(manager.isUsableRepo()).resolves.toMatchObject({
      ok: false,
      reason: "no-git",
      message: `probe ${rejectAt} unavailable`,
    });
  });

  it("gitArgs builds the exact argv each side agrees on", () => {
    expect(gitArgs.addNewBranch("/wt", "tachyon/rev", "HEAD")).toEqual(["worktree", "add", "-b", "tachyon/rev", "/wt", "HEAD"]);
    expect(gitArgs.addNewBranchLocked("/wt", "tachyon/rev", "HEAD")).toEqual(["worktree", "add", "--lock", "-b", "tachyon/rev", "/wt", "HEAD"]);
    expect(gitArgs.attachBranch("/wt", "feature/x")).toEqual(["worktree", "add", "/wt", "feature/x"]);
    expect(gitArgs.attachBranchLocked("/wt", "feature/x")).toEqual(["worktree", "add", "--lock", "/wt", "feature/x"]);
    expect(gitArgs.lock("/wt")).toEqual(["worktree", "lock", "/wt"]);
    expect(gitArgs.unlock("/wt")).toEqual(["worktree", "unlock", "/wt"]);
    expect(gitArgs.remove("/wt")).toEqual(["worktree", "remove", "--force", "/wt"]);
    expect(gitArgs.remove("/wt", false)).toEqual(["worktree", "remove", "/wt"]);
    expect(gitArgs.deleteBranch("tachyon/rev")).toEqual(["branch", "-D", "tachyon/rev"]);
    expect(gitArgs.checkRefFormat("a/b")).toEqual(["check-ref-format", "--branch", "a/b"]);
    expect(gitArgs.branchExists("b")).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/b"]);
  });
});
