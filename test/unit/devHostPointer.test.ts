import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWorkspaceNotRepoRoot,
  clear,
  point,
  status,
} from "../../scripts/dev-host/pointer.mjs";

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
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("refuses monorepo root as workspace", () => {
    expect(() => assertWorkspaceNotRepoRoot(repo, repo)).toThrow(/refusing workspace=repo root/);
  });

  it("points extension + workspace symlinks and writes meta", () => {
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

    const ext = path.join(repo, ".tachyon", "dev-host", "extension");
    const ws = path.join(repo, ".tachyon", "dev-host", "workspace");
    expect(fs.lstatSync(ext).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(ws).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(ext)).toBe(path.resolve(worktree));
    expect(fs.realpathSync(ws)).toBe(path.resolve(fixture));

    const st = status(repo);
    expect(st.armed).toBe(true);
    expect(st.meta?.spec).toBe("381");
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

  it("writes absolute paths into launch.json Dev Host entry (WSL-safe)", () => {
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
          args: ["${workspaceFolder}/.tachyon/dev-host/workspace"],
        }],
      }, null, 2),
    );
    point({ repoRoot: repo, worktree, workspace: fixture, spec: "381" });
    const launch = JSON.parse(fs.readFileSync(path.join(vscode, "launch.json"), "utf8"));
    const cfg = launch.configurations.find((c: { name: string }) => c.name === "Tachyon: Dev Host");
    expect(cfg.args[0]).toBe(path.resolve(fixture));
    expect(cfg.args[1]).toContain(path.resolve(worktree));
    expect(cfg.args[1].startsWith("--extensionDevelopmentPath=")).toBe(true);
    const cleared = clear(repo);
    expect(cleared.cleared).toBe(true);
    const restored = JSON.parse(fs.readFileSync(path.join(vscode, "launch.json"), "utf8"));
    const cfg2 = restored.configurations.find((c: { name: string }) => c.name === "Tachyon: Dev Host");
    expect(cfg2.args[0]).toContain("${workspaceFolder}");
  });

});
