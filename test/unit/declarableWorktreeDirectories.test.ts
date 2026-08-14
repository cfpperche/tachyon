import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPrimer, type PrimerInput } from "@tachyon/engine/agents/primer.js";
import { shareDependencies } from "@tachyon/engine/worktree/dependencySharing.js";

describe("t-5ac1df — worktree directories are declared by the project", () => {
  const roots: string[] = [];

  function pair(): { primary: string; worktree: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-shared-dirs-"));
    roots.push(root);
    const primary = path.join(root, "primary");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(primary);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: primary });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: primary });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: primary });
    fs.writeFileSync(path.join(primary, ".gitignore"), ".cache\n.env\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: primary });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: primary });
    fs.mkdirSync(worktree);
    return { primary, worktree };
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("shares nothing without a declaration, then symlinks a declared directory in a project with no Node lockfile", async () => {
    const { primary, worktree } = pair();
    fs.mkdirSync(path.join(primary, ".cache"));
    fs.writeFileSync(path.join(primary, ".cache", "marker"), "primary");

    await shareDependencies({ workspaceRoot: primary, worktreePath: worktree, sharedDirectories: [] });
    expect(fs.existsSync(path.join(worktree, ".cache"))).toBe(false);

    await shareDependencies({ workspaceRoot: primary, worktreePath: worktree, sharedDirectories: [".cache"] });
    expect(fs.lstatSync(path.join(worktree, ".cache")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(worktree, ".cache", "marker"), "utf8")).toBe("primary");
  });

  it("copies .worktreeinclude entries so each worktree owns its file", async () => {
    const { primary, worktree } = pair();
    fs.writeFileSync(path.join(primary, ".env"), "TOKEN=local\n");
    fs.writeFileSync(path.join(primary, ".worktreeinclude"), ".env\n");

    await shareDependencies({ workspaceRoot: primary, worktreePath: worktree, sharedDirectories: [] });

    expect(fs.lstatSync(path.join(worktree, ".env")).isSymbolicLink()).toBe(false);
    fs.writeFileSync(path.join(worktree, ".env"), "TOKEN=worktree\n");
    expect(fs.readFileSync(path.join(primary, ".env"), "utf8")).toBe("TOKEN=local\n");
  });

  it("warns and skips absent, tracked, glob, negation, and unsafe entries", async () => {
    const { primary, worktree } = pair();
    fs.mkdirSync(path.join(primary, ".cache"));
    fs.mkdirSync(path.join(primary, "tracked"));
    fs.writeFileSync(path.join(primary, "tracked", "config"), "tracked\n");
    execFileSync("git", ["add", "tracked/config"], { cwd: primary });
    execFileSync("git", ["commit", "-q", "-m", "tracked fixture"], { cwd: primary });
    fs.writeFileSync(path.join(primary, ".env"), "PRIVATE=1\n");
    fs.writeFileSync(path.join(primary, ".worktreeinclude"), [
      ".env",
      "missing.env",
      "tracked/config",
      "*.secret",
      "!private.env",
      "../escape",
      "",
    ].join("\n"));
    const warnings: string[] = [];

    await shareDependencies({
      workspaceRoot: primary,
      worktreePath: worktree,
      sharedDirectories: [".cache", "missing", "tracked", ".cache*", "!cache", "../escape"],
      warn: (message) => warnings.push(message),
    });

    expect(fs.lstatSync(path.join(worktree, ".cache")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(worktree, ".env")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(worktree, "tracked"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("missing") && warning.includes("absent"))).toBe(true);
    expect(warnings.some((warning) => /tracked (directories|paths) cannot/.test(warning))).toBe(true);
    expect(warnings.filter((warning) => warning.includes("unsupported pattern")).length).toBeGreaterThanOrEqual(4);
    expect(warnings.filter((warning) => warning.includes("unsafe path")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("t-9989cb — dependency state is absent from the primer", () => {
  it("does not accept or render a dependency sentence", () => {
    const { primer } = renderPrimer({
      agentName: "child",
      dependencies: "Dependencies: node_modules is shared. Do not reinstall through it.",
    } as unknown as PrimerInput);
    expect(primer).not.toContain("Dependencies:");
    expect(primer).not.toContain("Do not reinstall through it");
  });
});
