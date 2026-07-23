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
  clear,
  ensurePortableLaunchConfig,
  fixtureNew,
  materializeWorkspaceMirror,
  point,
  resolveF5HostRepoRoot,
  resolveFixturePath,
  status,
} = pointerMod as any;

/** clear()/status() default to the real systemctl/Bridge socket; tests that don't exercise
 * reconciliation itself must not depend on a live systemd --user session being available. */
const noopReconcile = {
  stopEngine: async () => ({ state: "absent" as const }),
  stopBridge: async () => ({ state: "absent" as const }),
};
const noopProbe = { probeEngine: async () => ({ state: "absent" as const }) };

function writePkg(dir: string, name = "tachyon") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }, null, 2));
}

describe("dev-host pointer", () => {
  let repo: string;
  let worktree: string;
  let fixture: string;

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

  it("resolveF5HostRepoRoot keeps a normal checkout as the F5 host", () => {
    // Real dir .git (or absent) ⇒ not a linked worktree
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = resolveF5HostRepoRoot(repo);
    expect(r.hostRepo).toBe(path.resolve(repo));
    expect(r.scriptRepo).toBe(path.resolve(repo));
    expect(r.redirected).toBe(false);
  });

  it("resolveF5HostRepoRoot redirects linked worktree to primary monorepo", () => {
    const primary = repo;
    const linked = worktree;
    // Linked worktree marker: .git is a file, not a directory
    fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(primary, ".git", "worktrees", "feature")}\n`);
    fs.mkdirSync(path.join(primary, ".git"), { recursive: true });
    const r = resolveF5HostRepoRoot(linked, {
      readGitCommonDir: () => path.join(primary, ".git"),
    });
    expect(r.redirected).toBe(true);
    expect(r.hostRepo).toBe(path.resolve(primary));
    expect(r.scriptRepo).toBe(path.resolve(linked));
  });

  it("point from linked-worktree script root still arms monorepo when host is redirected", () => {
    // Simulate agent cwd=worktree: F5 host must be monorepo (repo), extension → worktree
    const meta = point({
      repoRoot: repo, // after resolveF5HostRepoRoot
      worktree,
      workspace: fixture,
      spec: "control-monolith-embed",
      slug: "control-embed",
    });
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host", "extension"))).toBe(true);
    expect(fs.realpathSync(path.join(repo, ".tachyon", "dev-host", "extension"))).toBe(path.resolve(worktree));
    expect(meta.worktree).toBe(path.resolve(worktree));
    // Feature worktree must NOT be required to hold the F5 pointer
    expect(fs.existsSync(path.join(worktree, ".tachyon", "dev-host", "meta.json"))).toBe(false);
  });

  it("points extension symlink + workspace mirror and writes meta", async () => {
    const meta = point({
      repoRoot: repo,
      worktree,
      workspace: fixture,
      spec: "381",
      slug: "prompt-templates",
      owner: "test",
    });
    expect(meta.worktree).toBe(path.resolve(worktree));
    expect(meta.workspace).toBe(path.resolve(fixture));
    expect(meta.launchConfig).toBe("Tachyon: Dev Host");
    expect(meta.workspaceMirror).toBe(true);

    const ext = path.join(repo, ".tachyon", "dev-host", "extension");
    const runtime = path.join(repo, ".tachyon", "dev-host", "runtime");
    const ws = path.join(repo, ".tachyon", "dev-host", "workspace");
    expect(fs.lstatSync(ext).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(runtime).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(runtime)).toBe(fs.realpathSync(process.execPath));
    // workspace must be a real directory (not a symlink) for WSL F5 Explorer
    expect(fs.lstatSync(ws).isSymbolicLink()).toBe(false);
    expect(fs.statSync(ws).isDirectory()).toBe(true);
    expect(fs.realpathSync(ext)).toBe(path.resolve(worktree));

    // Authoritative config is a real disposable copy: the engine opens it no-follow and dogfood
    // mutations must not write back into a tracked fixture. Non-authoritative files stay linked.
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
    point({ repoRoot: repo, worktree, workspace: fixture, spec: "393" });
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
    point({ repoRoot: repo, worktree, workspace: fixture });
    const result = await clear(repo, noopReconcile);
    expect(result.cleared).toBe(true);
    expect(result.reconciled).toEqual({ engine: { state: "absent" }, bridge: { state: "absent" } });
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host"))).toBe(false);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(fixture)).toBe(true);
    expect((await status(repo, noopProbe)).armed).toBe(false);
  });

  it("links node_modules from primary when worktree lacks them", () => {
    const wtNm = path.join(worktree, "node_modules");
    expect(fs.existsSync(wtNm)).toBe(false);
    point({ repoRoot: repo, worktree, workspace: fixture });
    expect(fs.lstatSync(wtNm).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(wtNm)).toBe(path.resolve(repo, "node_modules"));
  });

  it("keeps portable ${workspaceFolder} paths in launch.json (never machine absolutes)", async () => {
    const vscode = path.join(repo, ".vscode");
    fs.mkdirSync(vscode, { recursive: true });
    fs.writeFileSync(
      path.join(vscode, "launch.json"),
      JSON.stringify({
        version: "0.2.0",
        configurations: [{
          name: "Tachyon: Dev Host",
          type: "extensionHost",
          request: "launch",
          // Simulate a dirty absolute-path rewrite from older point()
          args: ["/tmp/absolute/fixture", "--extensionDevelopmentPath=/tmp/absolute/wt"],
        }],
      }, null, 2),
    );
    point({ repoRoot: repo, worktree, workspace: fixture, spec: "381" });
    const launch = JSON.parse(fs.readFileSync(path.join(vscode, "launch.json"), "utf8"));
    const cfg = launch.configurations.find((c: { name: string }) => c.name === "Tachyon: Dev Host");
    expect(cfg.args[0]).toBe("${workspaceFolder}/.tachyon/dev-host/workspace");
    expect(cfg.args[1]).toBe("--extensionDevelopmentPath=${workspaceFolder}/.tachyon/dev-host/extension");
    expect(cfg.args.some((a: string) => a.includes("--extensions-dir"))).toBe(false);
    expect(cfg.args.some((a: string) => a.includes("--user-data-dir"))).toBe(false);
    expect(cfg.env.TMUX_TMPDIR).toContain("${workspaceFolder}");
    expect(cfg.env.TACHYON_DEV_HOST).toBe("1");
    expect(cfg.env.TACHYON_DEV_HOST_ENGINE_RUNTIME).toContain("${workspaceFolder}");
    expect(cfg.env.XDG_CACHE_HOME).toContain("${workspaceFolder}");
    expect(cfg.env.XDG_STATE_HOME).toContain("${workspaceFolder}");
    expect(cfg.env.XDG_DATA_HOME).toContain("${workspaceFolder}");
    expect(cfg.outFiles[0]).toContain("${workspaceFolder}");
    // No absolute machine paths leaked into the committed template
    expect(JSON.stringify(cfg)).not.toContain(path.resolve(fixture));
    expect(JSON.stringify(cfg)).not.toContain(path.resolve(worktree));

    const cleared = await clear(repo, noopReconcile);
    expect(cleared.cleared).toBe(true);
    const restored = JSON.parse(fs.readFileSync(path.join(vscode, "launch.json"), "utf8"));
    const cfg2 = restored.configurations.find((c: { name: string }) => c.name === "Tachyon: Dev Host");
    expect(cfg2.args[0]).toContain("${workspaceFolder}");
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

  it("ensurePortableLaunchConfig is a no-op without launch.json", () => {
    expect(ensurePortableLaunchConfig(repo)).toBeNull();
  });

  describe("t-e357dc: stale persistent-engine reconciliation", () => {
    // The Dev Host mirror workspace (<repo>/.tachyon/dev-host/workspace) is a fixed path across every
    // F5 session, so a persistent engine started under an earlier point() outlives point-clear unless
    // it is stopped first. These tests cover the acceptance criteria for t-e357dc directly.

    it("stops a stale foreign occupant before wiping storage", async () => {
      point({ repoRoot: repo, worktree, workspace: fixture });
      const devHostRoot = path.join(repo, ".tachyon", "dev-host");
      const expectedUnitName = fixtureEngineUnitName(devHostRoot);
      const calls: Array<{ fn: string; root: string; storagePresent: boolean }> = [];
      const stopEngine = async (root: string) => {
        calls.push({ fn: "engine", root, storagePresent: fs.existsSync(devHostRoot) });
        return { state: "stopped" as const, unitName: fixtureEngineUnitName(root) };
      };
      const stopBridge = async (root: string) => {
        calls.push({ fn: "bridge", root, storagePresent: fs.existsSync(devHostRoot) });
        return { state: "stopped" as const };
      };

      const result = await clear(repo, { stopEngine, stopBridge });

      expect(result.cleared).toBe(true);
      expect(result.reconciled).toEqual({
        engine: { state: "stopped", unitName: expectedUnitName },
        bridge: { state: "stopped" },
      });
      // Reconciliation must run against this pointer's own dev-host dir, and before storage is removed.
      expect(calls).toEqual([
        { fn: "engine", root: devHostRoot, storagePresent: true },
        { fn: "bridge", root: devHostRoot, storagePresent: true },
      ]);
      expect(fs.existsSync(devHostRoot)).toBe(false);
    });

    it("is a no-op when clear() has nothing to reconcile (already clear)", async () => {
      const calls: string[] = [];
      const stopEngine = async () => { calls.push("engine"); return { state: "absent" as const }; };
      const stopBridge = async () => { calls.push("bridge"); return { state: "absent" as const }; };

      const first = await clear(repo, { stopEngine, stopBridge });
      expect(first).toEqual({ cleared: false, reason: "already clear" });
      expect(calls).toEqual([]);

      point({ repoRoot: repo, worktree, workspace: fixture });
      const second = await clear(repo, { stopEngine, stopBridge });
      expect(second.cleared).toBe(true);
      expect(calls).toEqual(["engine", "bridge"]);

      // Re-pointing the same fixture afterward (a fresh session) does not itself invoke reconciliation —
      // only clear() does, since point() never touches the engine's storage roots.
      calls.length = 0;
      point({ repoRoot: repo, worktree, workspace: fixture });
      expect(calls).toEqual([]);
    });

    it("refuses to wipe storage when the stale occupant cannot be safely stopped (bounded cleanup failure)", async () => {
      point({ repoRoot: repo, worktree, workspace: fixture });
      const devHostRoot = path.join(repo, ".tachyon", "dev-host");
      const stopEngine = async () => {
        throw new Error("fixture EDH is still running; close it before cleanup");
      };
      const stopBridge = async () => { throw new Error("should not be reached"); };

      await expect(clear(repo, { stopEngine, stopBridge })).rejects.toThrow(/still running/);
      // Fail closed: storage must survive an unsafe/unproven stop attempt.
      expect(fs.existsSync(devHostRoot)).toBe(true);
      expect(fs.existsSync(path.join(devHostRoot, "workspace"))).toBe(true);
    });

    it("never targets a normal (non-Dev-Host) workspace's engine identity", () => {
      point({ repoRoot: repo, worktree, workspace: fixture });
      const devHostRoot = path.join(repo, ".tachyon", "dev-host");
      const normalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "normal-workspace-"));
      fs.mkdirSync(path.join(normalWorkspace, "workspace"), { recursive: true });

      try {
        // The unit name is a pure function of <fixtureRoot>/workspace's canonical path, so a Dev Host
        // reconciliation targeting devHostRoot structurally cannot compute a normal workspace's unit.
        expect(fixtureEngineUnitName(devHostRoot)).not.toBe(fixtureEngineUnitName(normalWorkspace));
      } finally {
        fs.rmSync(normalWorkspace, { recursive: true, force: true });
      }
    });

    it("point-status surfaces a precise, actionable warning when a stale engine is still active", async () => {
      point({ repoRoot: repo, worktree, workspace: fixture });
      const st = await status(repo, {
        probeEngine: async (root: string) => ({ state: "active" as const, unitName: fixtureEngineUnitName(root) }),
      });
      expect(st.engineOccupant?.state).toBe("active");
      expect(st.warnings?.some((w: string) => /persistent engine .* still active/i.test(w))).toBe(true);
      expect(st.warnings?.some((w: string) => /point-clear/.test(w))).toBe(true);
    });
  });
});
