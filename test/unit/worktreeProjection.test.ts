import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NEVER_PROJECT_PREFIXES,
  PROJECTED_TOOLING_RELS,
  describeToolingProjection,
  projectPluginTooling,
  resolveAuthorityRoot,
} from "../../src/plugins/worktreeProjection.js";
import { LOCKFILE_REL_PATH } from "../../src/plugins/lockfile.js";

/**
 * t-36182f — the measured defect: `agent-browser` is installed and healthy in the primary checkout
 * (doctor 16 pass / 0 fail) while a fresh worktree has neither `.tachyon/bin/_tachyon-tool` nor
 * `.claude/skills/agent-browser`, so doctor run from inside it reports BROWSER_RUNTIME_MISSING.
 *
 * The tests that matter most here are the NEGATIVE ones: projection must never copy a binary, never
 * reach a credential or a pin, and never clobber real content.
 */

let root: string;
let authority: string;
let worktree: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-projection-"));
  authority = path.join(root, "main");
  worktree = path.join(root, "wt");
  fs.mkdirSync(path.join(authority, ".tachyon", "bin"), { recursive: true });
  fs.mkdirSync(path.join(authority, ".claude", "skills", "agent-browser"), { recursive: true });
  fs.writeFileSync(path.join(authority, ".tachyon", "bin", "_tachyon-tool"), "#!/bin/sh\n", { mode: 0o700 });
  fs.writeFileSync(path.join(authority, ".claude", "skills", "agent-browser", "SKILL.md"), "# skill\n");
  fs.mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveAuthorityRoot", () => {
  it("derives the authority from the git common dir of a linked worktree", () => {
    expect(resolveAuthorityRoot(worktree, path.join(authority, ".git"))).toBe(authority);
  });

  it("returns undefined for the primary checkout — it has nothing to project from", () => {
    expect(resolveAuthorityRoot(authority, path.join(authority, ".git"))).toBeUndefined();
  });
});

describe("projectPluginTooling", () => {
  it("reaches the authority's tooling by symlink, and copies nothing", () => {
    const result = projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    expect(result.authorityRoot).toBe(authority);

    const bin = path.join(worktree, ".tachyon", "bin");
    const skills = path.join(worktree, ".claude", "skills");
    // A LINK, not a copy: the binary continues to exist exactly once on disk.
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(skills).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(bin)).toBe(fs.realpathSync(path.join(authority, ".tachyon", "bin")));

    // And it actually resolves through: this is what the failing doctor could not do.
    expect(fs.existsSync(path.join(worktree, ".tachyon", "bin", "_tachyon-tool"))).toBe(true);
    expect(fs.readFileSync(path.join(worktree, ".claude", "skills", "agent-browser", "SKILL.md"), "utf8"))
      .toContain("# skill");

    expect(result.entries.find((e) => e.rel === ".tachyon/bin")?.state).toBe("linked");
  });

  it("is idempotent — the second run relinks nothing", () => {
    projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    const again = projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    expect(again.entries.filter((e) => e.state === "linked")).toHaveLength(0);
    expect(again.entries.find((e) => e.rel === ".tachyon/bin")?.state).toBe("already");
  });

  it("repairs a link a human deleted (restart path)", () => {
    projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    fs.unlinkSync(path.join(worktree, ".tachyon", "bin"));
    const repaired = projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    expect(repaired.entries.find((e) => e.rel === ".tachyon/bin")?.state).toBe("linked");
    expect(fs.existsSync(path.join(worktree, ".tachyon", "bin", "_tachyon-tool"))).toBe(true);
  });

  it("replaces a STALE link but never clobbers real content", () => {
    // stale link → ours to fix
    const bin = path.join(worktree, ".tachyon", "bin");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync(path.join(root, "somewhere-else"), bin);
    // real directory → not ours to touch
    const skills = path.join(worktree, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, "local.md"), "hand-written");

    const result = projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    expect(result.entries.find((e) => e.rel === ".tachyon/bin")?.state).toBe("linked");
    expect(result.entries.find((e) => e.rel === ".claude/skills")?.state).toBe("occupied");
    expect(fs.readFileSync(path.join(skills, "local.md"), "utf8")).toBe("hand-written");
  });

  it("distinguishes a plugin that is NOT INSTALLED from one that is merely not projected", () => {
    // The authority has no codex skills dir at all.
    const result = projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    expect(result.entries.find((e) => e.rel === ".agents/skills")?.state).toBe("absent-in-authority");
    // Nothing is invented in the worktree for it.
    expect(fs.existsSync(path.join(worktree, ".agents", "skills"))).toBe(false);

    const described = describeToolingProjection(result);
    expect(described).toContain("projected from");
    expect(described).toContain("not installed in the workspace: .agents/skills");
  });

  it("a primary checkout projects nothing onto itself", () => {
    const result = projectPluginTooling({ worktreeRoot: authority, authorityRoot: authority });
    expect(result.authorityRoot).toBeUndefined();
    expect(result.entries.every((e) => e.state === "already")).toBe(true);
  });
});

describe("the projection allowlist is a security boundary", () => {
  it("never projects the lockfile, the plugin payloads, or credential state", () => {
    // The launcher resolves the AUTHORITY root physically, so it reads the authority's pins and the
    // human-owned confirmation config. A worktree-local copy of any of these would be a second,
    // drifting source of truth for exactly the things that gate execution.
    for (const denied of [LOCKFILE_REL_PATH, ".tachyon/plugins/agent-browser", ".tachyon/browser-state"]) {
      expect(PROJECTED_TOOLING_RELS.some((rel) => denied === rel || denied.startsWith(`${rel}/`))).toBe(false);
    }
    expect(NEVER_PROJECT_PREFIXES).toContain(LOCKFILE_REL_PATH);
  });

  it("refuses a denied path even when a caller asks for it explicitly", () => {
    expect(() =>
      projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority, rels: [LOCKFILE_REL_PATH] }),
    ).toThrow(/overlaps authority-only state/);
    expect(() =>
      projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority, rels: [".tachyon/plugins/x"] }),
    ).toThrow(/overlaps authority-only state/);
  });

  it("refuses an escaping or absolute path", () => {
    for (const bad of ["../outside", "/etc", ".tachyon/../../x"]) {
      expect(() => projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority, rels: [bad] }))
        .toThrow(/not a contained relative path/);
    }
  });

  it("removing the worktree removes the LINK, never the authority's tooling", () => {
    projectPluginTooling({ worktreeRoot: worktree, authorityRoot: authority });
    fs.rmSync(worktree, { recursive: true, force: true });
    // This is what `git worktree remove` does, and why symlinks are safe here.
    expect(fs.existsSync(path.join(authority, ".tachyon", "bin", "_tachyon-tool"))).toBe(true);
    expect(fs.existsSync(path.join(authority, ".claude", "skills", "agent-browser", "SKILL.md"))).toBe(true);
  });
});
