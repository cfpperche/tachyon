import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Owned ESM CLI; Vitest loads it directly while the repo typecheck target is CommonJS.
// @ts-expect-error -- static ESM import is intentional for this executable module test (same as resolve-code.mjs).
import { assertWorkspaceNotRepoRoot, clear, ensurePortableLaunchConfig, fixtureNew, materializeWorkspaceMirror, point, resolveFixturePath, status } from "../../scripts/dev-host/pointer.mjs";

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

  it("points extension symlink + workspace mirror and writes meta", () => {
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
    const ws = path.join(repo, ".tachyon", "dev-host", "workspace");
    expect(fs.lstatSync(ext).isSymbolicLink()).toBe(true);
    // workspace must be a real directory (not a symlink) for WSL F5 Explorer
    expect(fs.lstatSync(ws).isSymbolicLink()).toBe(false);
    expect(fs.statSync(ws).isDirectory()).toBe(true);
    expect(fs.realpathSync(ext)).toBe(path.resolve(worktree));

    // Child entries are symlinks into the fixture (live content)
    expect(fs.lstatSync(path.join(ws, "tachyon.yml")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(ws, "tachyon.yml"), "utf8")).toContain("agents:");
    expect(fs.existsSync(path.join(ws, ".tachyon", "prompts", "hi.md"))).toBe(true);
    // Spec 393 / 390: mirror `.tachyon` must be a REAL directory (not a symlink) for Soul launch.
    expect(fs.lstatSync(path.join(ws, ".tachyon")).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(ws, ".tachyon")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(ws, ".tachyon", "prompts", "hi.md"), "utf8")).toContain("hello");
    expect(fs.existsSync(path.join(ws, ".edh-user-data"))).toBe(false);
    expect(fs.readFileSync(path.join(ws, ".dev-host-source"), "utf8").trim()).toBe(path.resolve(fixture));

    const st = status(repo);
    expect(st.armed).toBe(true);
    expect(st.broken).toBe(false);
    expect(st.meta?.spec).toBe("381");
    expect(st.workspaceIsMirror).toBe(true);
    expect(st.workspaceResolves).toBe(path.resolve(fixture));
    expect(st.tachyonMirrorIsRealDir).toBe(true);
    expect(st.worktreeExists).toBe(true);
  });

  it("status is broken when worktree path is gone", () => {
    point({ repoRoot: repo, worktree, workspace: fixture, spec: "393" });
    fs.rmSync(worktree, { recursive: true, force: true });
    const st = status(repo);
    expect(st.armed).toBe(false);
    expect(st.broken).toBe(true);
    expect(st.worktreeExists).toBe(false);
    expect(st.warnings?.some((w) => /worktree missing/i.test(w))).toBe(true);
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

  it("clear removes only the pointer dir", () => {
    point({ repoRoot: repo, worktree, workspace: fixture });
    expect(clear(repo).cleared).toBe(true);
    expect(fs.existsSync(path.join(repo, ".tachyon", "dev-host"))).toBe(false);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(fs.existsSync(fixture)).toBe(true);
    expect(status(repo).armed).toBe(false);
  });

  it("links node_modules from primary when worktree lacks them", () => {
    const wtNm = path.join(worktree, "node_modules");
    expect(fs.existsSync(wtNm)).toBe(false);
    point({ repoRoot: repo, worktree, workspace: fixture });
    expect(fs.lstatSync(wtNm).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(wtNm)).toBe(path.resolve(repo, "node_modules"));
  });

  it("keeps portable ${workspaceFolder} paths in launch.json (never machine absolutes)", () => {
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
    expect(cfg.outFiles[0]).toContain("${workspaceFolder}");
    // No absolute machine paths leaked into the committed template
    expect(JSON.stringify(cfg)).not.toContain(path.resolve(fixture));
    expect(JSON.stringify(cfg)).not.toContain(path.resolve(worktree));

    const cleared = clear(repo);
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
});
