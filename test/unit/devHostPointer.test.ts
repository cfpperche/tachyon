import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Owned ESM CLI; Vitest loads it directly while the repo typecheck target is CommonJS.
// @ts-expect-error -- static ESM import is intentional for this executable module test (same as resolve-code.mjs).
import * as pointerMod from "../../scripts/dev-host/pointer.mjs";
// @ts-expect-error -- static ESM import is intentional for this executable module test.
import { fixtureEngineUnitName } from "../../scripts/dev-host/stop-bridge.mjs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ESM CLI has no CJS .d.ts in the typecheck graph
const {
  assertWorkspaceNotRepoRoot,
  assertPointerSessionIdle,
  clear,
  fixtureNew,
  materializeWorkspaceMirror,
  pathsOf,
  point,
  resolvePrimaryRepoRoot,
  resolveFixturePath,
  status,
} = pointerMod as any;

/** clear()/status() default to the real systemctl/Bridge socket; tests that don't exercise
 * reconciliation itself must not depend on a live systemd --user session being available.
 * env: {} isolates slot resolution from the real agent process (TACHYON_AGENT_NAME etc.). */
const noopReconcile = {
  stopEngine: async () => ({ state: "absent" as const }),
  stopBridge: async () => ({ state: "absent" as const }),
  env: {} as Record<string, string>,
};
const noopProbe = {
  probeEngine: async () => ({ state: "absent" as const }),
  env: {} as Record<string, string>,
};

function writePkg(dir: string, name = "tachyon") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }, null, 2));
}

describe("dev-host pointer", () => {
  let repo: string;
  let worktree: string;
  let fixture: string;

  /** Arm without inheriting the real agent process env (slot isolation). */
  function arm(extra: Record<string, unknown> = {}) {
    return point({
      repoRoot: repo,
      worktree,
      workspace: fixture,
      env: {},
      ...extra,
    });
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "dev-host-repo-"));
    worktree = path.join(repo, "wt-feature");
    fixture = path.join(worktree, "test", "fixtures", "feature-dogfood");
    writePkg(repo);
    writePkg(worktree);
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(path.join(fixture, "tachyon.yml"), "agents:\n  a:\n    cmd: x\n");
    fs.writeFileSync(path.join(fixture, "README.md"), "# fixture\n");
    fs.writeFileSync(path.join(fixture, ".tachyon-dev-host.json"), JSON.stringify({ spoofed: true }));
    fs.mkdirSync(path.join(fixture, ".tachyon", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(fixture, ".tachyon", "prompts", "hi.md"), "hello\n");
    // CLI-only dirs should not be mirrored into the F5 workspace
    fs.mkdirSync(path.join(fixture, ".edh-user-data"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("refuses monorepo root as workspace", () => {
    expect(() => assertWorkspaceNotRepoRoot(repo, repo)).toThrow(/refusing workspace=repo root/);
  });

  it("resolvePrimaryRepoRoot keeps a normal checkout as its own primary", () => {
    // Real dir .git (or absent) ⇒ not a linked worktree
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = resolvePrimaryRepoRoot(repo);
    expect(r.primaryRepo).toBe(path.resolve(repo));
    expect(r.checkout).toBe(path.resolve(repo));
    expect(r.redirected).toBe(false);
  });

  it("resolvePrimaryRepoRoot finds the primary from a linked worktree — for dependencies only", () => {
    const primary = repo;
    const linked = worktree;
    // Linked worktree marker: .git is a file, not a directory
    fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(primary, ".git", "worktrees", "feature")}\n`);
    fs.mkdirSync(path.join(primary, ".git"), { recursive: true });
    const r = resolvePrimaryRepoRoot(linked, {
      readGitCommonDir: () => path.join(primary, ".git"),
    });
    expect(r.redirected).toBe(true);
    expect(r.primaryRepo).toBe(path.resolve(primary));
    expect(r.checkout).toBe(path.resolve(linked));
    // spec 448 — the caller borrows node_modules/.tachyon/bin from primaryRepo. It must NOT be used
    // as a dev-host root; the inversion test below pins that.
  });

  it("spec 448: point arms the checkout it runs in, NOT the primary monorepo", () => {
    // This is the inversion. It previously asserted the opposite ("still arms monorepo when host is
    // redirected"): a linked worktree used to be redirected so one shared dev-host served everyone.
    const meta = point({
      repoRoot: worktree, // the checkout being armed
      primaryRepo: repo, // only where dependencies are borrowed from
      worktree,
      workspace: fixture,
      spec: "448",
      slug: "devhost-owned-by-worktree",
    });

    const p = pathsOf(worktree);
    expect(fs.existsSync(p.meta)).toBe(true);
    expect(fs.realpathSync(p.extension)).toBe(path.resolve(worktree));
    expect(meta.checkout).toBe(path.resolve(worktree));

    // The primary must be left completely alone — this is what kept it permanently dirty before.
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host"))).toBe(false);

    // No slot layout, no active symlink.
    expect(fs.existsSync(path.join(worktree, ".tachyon", "dev-host", "slots"))).toBe(false);
    expect(fs.existsSync(path.join(worktree, ".tachyon", "dev-host", "active"))).toBe(false);
  });

  it("spec 448 scenario 1: two checkouts arm independently, with no slot identifier", () => {
    const other = path.join(repo, "wt-other");
    const otherFixture = path.join(other, "test", "fixtures", "other-dogfood");
    writePkg(other);
    fs.mkdirSync(otherFixture, { recursive: true });
    fs.writeFileSync(path.join(otherFixture, "tachyon.yml"), "agents:\n  b:\n    cmd: y\n");

    point({ repoRoot: worktree, primaryRepo: repo, worktree, workspace: fixture });
    point({ repoRoot: other, primaryRepo: repo, worktree: other, workspace: otherFixture });

    // Each dev-host points at its own checkout — neither clobbered the other, and neither had to be
    // told who it belongs to. Isolation is structural, not a naming convention.
    expect(fs.realpathSync(pathsOf(worktree).extension)).toBe(path.resolve(worktree));
    expect(fs.realpathSync(pathsOf(other).extension)).toBe(path.resolve(other));
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host"))).toBe(false);
  });

  it("points extension symlink + workspace mirror and writes meta", async () => {
    const meta = arm({
      spec: "381",
      slug: "prompt-templates",
    });
    expect(meta.worktree).toBe(path.resolve(worktree));
    expect(meta.workspace).toBe(path.resolve(fixture));
    expect(meta.launchConfig).toBe("Tachyon: Dev Host");
    expect(meta.workspaceMirror).toBe(true);

    const p = pathsOf(repo);
    expect(fs.lstatSync(p.extension).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(p.runtime).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(p.runtime)).toBe(fs.realpathSync(process.execPath));
    // workspace must be a real directory (not a symlink) for WSL F5 Explorer
    expect(fs.lstatSync(p.workspace).isSymbolicLink()).toBe(false);
    expect(fs.statSync(p.workspace).isDirectory()).toBe(true);
    expect(fs.realpathSync(p.extension)).toBe(path.resolve(worktree));
    // spec 448 — inverted: flat IS the layout now. This assertion used to demand the opposite,
    // because the dev-host lived under slots/<id>/ with an `active` symlink selecting one.
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host", "extension"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host", "active"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host", "slots"))).toBe(false);

    // Authoritative config is a real disposable copy: the engine opens it no-follow and dogfood
    // mutations must not write back into a tracked fixture. Non-authoritative files stay linked.
    const ws = p.workspace;
    expect(fs.lstatSync(path.join(ws, "tachyon.yml")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(ws, "tachyon.yml")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(ws, "README.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(ws, "tachyon.yml"), "utf8")).toContain("agents:");
    expect(fs.existsSync(path.join(ws, ".tachyon", "prompts", "hi.md"))).toBe(true);
    // Spec 393 / 390: mirror `.tachyon` must be a REAL directory (not a symlink) for Soul launch.
    expect(fs.lstatSync(path.join(ws, ".tachyon")).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(ws, ".tachyon")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(ws, ".tachyon", "prompts", "hi.md"), "utf8")).toContain("hello");
    expect(fs.existsSync(path.join(ws, ".edh-user-data"))).toBe(false);
    expect(fs.readFileSync(path.join(ws, ".dev-host-source"), "utf8").trim()).toBe(path.resolve(fixture));
    expect(fs.lstatSync(path.join(ws, ".tachyon-dev-host.json")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(ws, ".tachyon-dev-host.json")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(ws, ".tachyon-dev-host.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "tachyon-dev-host",
    });

    const st = await status(repo, noopProbe);
    expect(st.armed).toBe(true);
    expect(st.broken).toBe(false);
    expect(st.meta?.spec).toBe("381");
    expect(st.workspaceIsMirror).toBe(true);
    expect(st.workspaceResolves).toBe(path.resolve(fixture));
    expect(st.tachyonMirrorIsRealDir).toBe(true);
    expect(st.worktreeExists).toBe(true);
    expect(st.engineOccupant).toEqual({ state: "absent" });
  });

  it("status is broken when worktree path is gone", async () => {
    arm({ spec: "393" });
    fs.rmSync(worktree, { recursive: true, force: true });
    const st = await status(repo, noopProbe);
    expect(st.armed).toBe(false);
    expect(st.broken).toBe(true);
    expect(st.worktreeExists).toBe(false);
    expect(st.warnings?.some((w: string) => /worktree missing/i.test(w))).toBe(true);
  });

  it("resolveFixturePath finds slug and slug-dogfood under worktree", () => {
    const found = resolveFixturePath({ worktree, repoRoot: repo, fixture: "feature" });
    expect(found).toBe(path.resolve(fixture));
    const found2 = resolveFixturePath({ worktree, repoRoot: repo, fixture: "feature-dogfood" });
    expect(found2).toBe(path.resolve(fixture));
  });

  it("fixtureNew scaffolds focus intent with .tachyon seeds", () => {
    const r = fixtureNew({ repoRoot: repo, worktree, slug: "demo", spec: "393", intent: "focus" });
    expect(r.root).toContain("demo-dogfood");
    expect(fs.existsSync(path.join(r.root, "tachyon.yml"))).toBe(true);
    expect(fs.existsSync(path.join(r.root, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(r.root, ".tachyon", "tasks", "t-fixture1.json"))).toBe(true);
    expect(fs.readFileSync(path.join(r.root, "README.md"), "utf8")).toMatch(/intent: focus/);
    expect(fs.readFileSync(path.join(r.root, "README.md"), "utf8")).toMatch(/metrics/);
  });

  it("clear removes only the pointer dir", async () => {
    arm();
    const result = await clear(repo, noopReconcile);
    expect(result.cleared).toBe(true);
    expect(result.reconciled).toEqual({ engine: { state: "absent" }, bridge: { state: "absent" } });
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host"))).toBe(false);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(fixture)).toBe(true);
    expect((await status(repo, noopProbe)).armed).toBe(false);
  });

  it("refuses point and clear while a live interactive session owns the pointer", async () => {
    arm();
    const pointerRoot = pathsOf(repo).root;
    fs.writeFileSync(path.join(pointerRoot, "session.json"), JSON.stringify({ edhPid: process.pid }));

    expect(() => assertPointerSessionIdle(pointerRoot)).toThrow(/interactive headless session owns this pointer/);
    expect(() => arm()).toThrow(/interactive headless session owns this pointer/);
    await expect(clear(repo, noopReconcile)).rejects.toThrow(/interactive headless session owns this pointer/);
  });

  it("keeps the reservation when the VS Code launcher exited but Xvfb is still live", () => {
    arm();
    const pointerRoot = pathsOf(repo).root;
    fs.writeFileSync(path.join(pointerRoot, "session.json"), JSON.stringify({
      edhPid: 2_147_483_647,
      xvfbPid: process.pid,
    }));

    expect(() => assertPointerSessionIdle(pointerRoot)).toThrow(/xvfbPid=.*interactive|interactive.*xvfbPid=/);
  });

  it("reclaims a stale interactive session marker", () => {
    arm();
    const pointerRoot = pathsOf(repo).root;
    const sessionFile = path.join(pointerRoot, "session.json");
    fs.writeFileSync(sessionFile, JSON.stringify({ edhPid: 2_147_483_647 }));
    expect(() => assertPointerSessionIdle(pointerRoot)).not.toThrow();
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("links node_modules from primary when worktree lacks them", () => {
    const wtNm = path.join(worktree, "node_modules");
    expect(fs.existsSync(wtNm)).toBe(false);
    arm();
    expect(fs.lstatSync(wtNm).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(wtNm)).toBe(path.resolve(repo, "node_modules"));
  });


  it("materializeWorkspaceMirror replaces a prior symlink workspace", () => {
    const mirror = path.join(repo, ".tachyon", "dev-host", "workspace");
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.symlinkSync(fixture, mirror);
    expect(fs.lstatSync(mirror).isSymbolicLink()).toBe(true);
    materializeWorkspaceMirror(mirror, fixture);
    expect(fs.lstatSync(mirror).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(mirror, "README.md"))).toBe(true);
  });

  it("copies mutable native runtime configuration into the disposable mirror", () => {
    const mirror = path.join(repo, ".tachyon", "dev-host", "workspace");
    fs.mkdirSync(path.join(fixture, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(fixture, ".claude", "settings.json"), "{\"theme\":\"dark\"}\n");
    fs.writeFileSync(path.join(fixture, ".mcp.json"), "{\"mcpServers\":{}}\n");

    materializeWorkspaceMirror(mirror, fixture);

    expect(fs.lstatSync(path.join(mirror, ".claude")).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(mirror, ".mcp.json")).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(mirror, ".claude", "settings.json"), "{\"theme\":\"light\"}\n");
    expect(fs.readFileSync(path.join(fixture, ".claude", "settings.json"), "utf8")).toContain("dark");
  });


  describe("t-e357dc: stale persistent-engine reconciliation", () => {
    // Per-slot mirror workspace is fixed across F5 sessions for that slot, so a persistent engine
    // outlives point-clear unless stopped first.

    it("stops a stale foreign occupant before wiping storage", async () => {
      arm();
      const slotRoot = pathsOf(repo).root;
      const base = path.join(repo, ".tachyon", "dev-host");
      const expectedUnitName = fixtureEngineUnitName(slotRoot);
      const calls: Array<{ fn: string; root: string; storagePresent: boolean }> = [];
      const stopEngine = async (root: string) => {
        calls.push({ fn: "engine", root, storagePresent: fs.existsSync(slotRoot) });
        return { state: "stopped" as const, unitName: fixtureEngineUnitName(root) };
      };
      const stopBridge = async (root: string) => {
        calls.push({ fn: "bridge", root, storagePresent: fs.existsSync(slotRoot) });
        return { state: "stopped" as const };
      };

      const result = await clear(repo, { stopEngine, stopBridge, env: {} });

      expect(result.cleared).toBe(true);
      expect(result.reconciled).toEqual({
        engine: { state: "stopped", unitName: expectedUnitName },
        bridge: { state: "stopped" },
      });
      expect(calls).toEqual([
        { fn: "engine", root: slotRoot, storagePresent: true },
        { fn: "bridge", root: slotRoot, storagePresent: true },
      ]);
      expect(fs.existsSync(base)).toBe(false);
    });

    it("is a no-op when clear() has nothing to reconcile (already clear)", async () => {
      const calls: string[] = [];
      const stopEngine = async () => { calls.push("engine"); return { state: "absent" as const }; };
      const stopBridge = async () => { calls.push("bridge"); return { state: "absent" as const }; };

      const first = await clear(repo, { stopEngine, stopBridge, env: {} });
      expect(first.cleared).toBe(false);
      expect(first.reason).toBe("already clear");
      expect(calls).toEqual([]);

      arm();
      const second = await clear(repo, { stopEngine, stopBridge, env: {} });
      expect(second.cleared).toBe(true);
      expect(calls).toEqual(["engine", "bridge"]);

      calls.length = 0;
      arm();
      expect(calls).toEqual([]);
    });

    it("refuses to wipe storage when the stale occupant cannot be safely stopped (bounded cleanup failure)", async () => {
      arm();
      const slotRoot = pathsOf(repo).root;
      const stopEngine = async () => {
        throw new Error("fixture EDH is still running; close it before cleanup");
      };
      const stopBridge = async () => { throw new Error("should not be reached"); };

      await expect(clear(repo, { stopEngine, stopBridge, env: {} })).rejects.toThrow(/still running/);
      expect(fs.existsSync(slotRoot)).toBe(true);
      expect(fs.existsSync(path.join(slotRoot, "workspace"))).toBe(true);
    });

    it("never targets a normal (non-Dev-Host) workspace's engine identity", () => {
      arm();
      const slotRoot = pathsOf(repo).root;
      const normalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "normal-workspace-"));
      fs.mkdirSync(path.join(normalWorkspace, "workspace"), { recursive: true });

      try {
        expect(fixtureEngineUnitName(slotRoot)).not.toBe(fixtureEngineUnitName(normalWorkspace));
      } finally {
        fs.rmSync(normalWorkspace, { recursive: true, force: true });
      }
    });

    it("point-status surfaces a precise, actionable warning when a stale engine is still active", async () => {
      arm();
      const st = await status(repo, {
        ...noopProbe,
        probeEngine: async (root: string) => ({ state: "active" as const, unitName: fixtureEngineUnitName(root) }),
      });
      expect(st.engineOccupant?.state).toBe("active");
      expect(st.warnings?.some((w: string) => /persistent engine .* still active/i.test(w))).toBe(true);
      expect(st.warnings?.some((w: string) => /point-clear/.test(w))).toBe(true);
    });
  });
});
