import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedPrivateHomeGitIdentity } from "@tachyon/engine/harness/HarnessManager.js";

/**
 * t-076a28 — SDD 456 co-binds `HOME` to the private `GROK_HOME` for canonical Grok so the runtime
 * cannot discover `$HOME/.claude/settings.json`. But `HOME` is the agent's `HOME` for everything it
 * shells out to, and the private home has no `.gitconfig`, so a canonical Grok agent could not
 * commit at all: git refused with "Author identity unknown".
 *
 * These tests drive REAL git against a real private home, because the thing under test is whether
 * git — not our code — finds the identity.
 */

const dirs: string[] = [];
function tmp(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in operator home carrying a real global git identity. */
function operatorHome(): string {
  const home = tmp("tachyon-operator-home-");
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Ada Operator\n\temail = ada@example.com\n");
  return home;
}

/** A repo with one staged change, ready to commit. */
function stagedRepo(): string {
  const repo = tmp("tachyon-git-id-repo-");
  execFileSync("git", ["init", "-q", "."], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "hello\n");
  execFileSync("git", ["add", "f.txt"], { cwd: repo });
  return repo;
}

function commit(repo: string, home: string): { ok: boolean; detail: string } {
  try {
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "t"], {
      cwd: repo,
      env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: undefined as unknown as string },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo, encoding: "utf8" }).trim() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

describe("t-076a28 — a private HOME keeps the operator's git identity", () => {
  it("reproduces the defect: a bare private home cannot commit", () => {
    const result = commit(stagedRepo(), tmp("tachyon-private-home-"));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Author identity unknown|Please tell me who you are/);
  });

  it("after seeding, the same private home commits as the operator", () => {
    const home = tmp("tachyon-private-home-");
    const written = seedPrivateHomeGitIdentity(home, operatorHome());
    expect(written).toBe(path.join(home, ".gitconfig"));

    const result = commit(stagedRepo(), home);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("Ada Operator <ada@example.com>");
  });

  it("includes rather than copies — an identity change is picked up live", () => {
    const operator = operatorHome();
    const home = tmp("tachyon-private-home-");
    seedPrivateHomeGitIdentity(home, operator);

    // The operator edits their real config; the private home must follow without re-seeding.
    fs.writeFileSync(path.join(operator, ".gitconfig"), "[user]\n\tname = Grace Renamed\n\temail = grace@example.com\n");
    expect(commit(stagedRepo(), home).detail).toBe("Grace Renamed <grace@example.com>");

    // And the seeded file holds a pointer, not a copy of the values.
    const seeded = fs.readFileSync(path.join(home, ".gitconfig"), "utf8");
    expect(seeded).toContain(path.join(operator, ".gitconfig"));
    expect(seeded).not.toContain("grace@example.com");
  });

  it("writes nothing when the operator has no global config — no dangling pointer", () => {
    const home = tmp("tachyon-private-home-");
    expect(seedPrivateHomeGitIdentity(home, tmp("tachyon-empty-operator-"))).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false);
  });

  it("refuses to seed a home that IS the operator's home — no self-include loop", () => {
    const operator = operatorHome();
    const before = fs.readFileSync(path.join(operator, ".gitconfig"), "utf8");
    expect(seedPrivateHomeGitIdentity(operator, operator)).toBeUndefined();
    // The operator's own config must never be rewritten to include itself.
    expect(fs.readFileSync(path.join(operator, ".gitconfig"), "utf8")).toBe(before);
  });

  it("re-seeding is idempotent", () => {
    const operator = operatorHome();
    const home = tmp("tachyon-private-home-");
    seedPrivateHomeGitIdentity(home, operator);
    const first = fs.readFileSync(path.join(home, ".gitconfig"), "utf8");
    seedPrivateHomeGitIdentity(home, operator);
    expect(fs.readFileSync(path.join(home, ".gitconfig"), "utf8")).toBe(first);
  });

  it("seeds ONLY git config — the rest of the real home stays out of reach", () => {
    const operator = operatorHome();
    fs.mkdirSync(path.join(operator, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(operator, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
    const home = tmp("tachyon-private-home-");
    seedPrivateHomeGitIdentity(home, operator);

    // The declared limitation, asserted: SSH material is neither copied nor linked in.
    expect(fs.existsSync(path.join(home, ".ssh"))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([".gitconfig"]);
  });
});
