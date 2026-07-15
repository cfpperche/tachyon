import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanonicalBehaviorOracle } from "../../src/bridge/behaviorStub.js";
import { behaviorTestError } from "../../src/config/behaviorVerification.js";

const roots: string[] = [];
const settings = {
  adapter: "vitest-name" as const,
  command: "npm test --",
  stubPath: "test/generated/{agent}.test.ts",
  executorPaths: ["seed.txt"],
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-behavior-oracle-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");
  fs.writeFileSync(path.join(root, "seed.txt"), "base\n", "utf8");
  git(root, ["add", ".gitignore", "seed.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

function commitOracle(root: string, relative = "test/generated/worker.test.ts", body = "it('keeps its oracle', () => {});\n"): string {
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body, "utf8");
  git(root, ["add", "--", relative]);
  git(root, ["commit", "-qm", "project-owned behavior oracle"]);
  return body;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("project-owned behavior oracle binding", () => {
  it.each(["line\nbreak", "escape\u001b[2J", "delete\u007fbyte", "csi\u009b2J", "separator\u2028line", "bidi\u2066spoof"])(
    "rejects control bytes in a behavior identifier before it can reach primer framing: %j",
    (value) => {
      expect(behaviorTestError(value)).toBe("must not contain control characters");
    },
  );

  it("refuses to invent an oracle from prose when the configured file is absent", async () => {
    const root = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings }))
      .rejects.toThrow(/commit a real failing project-owned test/);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });

  it("binds an existing tracked oracle by committed bytes without creating a setup commit", async () => {
    const root = repository();
    const body = commitOracle(root);
    const head = git(root, ["rev-parse", "HEAD"]);
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings })).resolves.toEqual({
      stubPath: "test/generated/worker.test.ts",
      oracleHash: crypto.createHash("sha256").update(body).digest("hex"),
      executorHashes: {
        "seed.txt": crypto.createHash("sha256").update("base\n").digest("hex"),
      },
      headRef: head,
    });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });

  it("refuses an untracked or ignored lookalike oracle", async () => {
    const root = repository();
    const leaf = path.join(root, "test", "generated", "worker.test.ts");
    fs.mkdirSync(path.dirname(leaf), { recursive: true });
    fs.writeFileSync(leaf, "it('untrusted', () => {});\n", "utf8");
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "test/\n", "utf8");
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings }))
      .rejects.toThrow(/must already be a tracked project file/);
  });

  it("refuses symlinked parents and leaves the external directory untouched", async () => {
    const root = repository();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-behavior-outside-"));
    roots.push(outside);
    fs.symlinkSync(outside, path.join(root, "test"), "dir");
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings }))
      .rejects.toThrow(/not a real directory path/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlinked oracle leaf", async () => {
    const root = repository();
    const parent = path.join(root, "test", "generated");
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(path.join(root, "seed.txt"), path.join(parent, "worker.test.ts"));
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings }))
      .rejects.toThrow(/not a real file/);
  });

  it("refuses to bind while unrelated tracked work is dirty", async () => {
    const root = repository();
    commitOracle(root);
    fs.writeFileSync(path.join(root, "seed.txt"), "dirty\n", "utf8");
    await expect(resolveCanonicalBehaviorOracle({ worktreePath: root, agent: "worker", settings }))
      .rejects.toThrow(/dirty worktree/);
  });

  it("supports a tracked Unicode oracle path without Git quotePath ambiguity", async () => {
    const root = repository();
    const relative = "test/ação/worker.test.ts";
    const body = commitOracle(root, relative);
    await expect(resolveCanonicalBehaviorOracle({
      worktreePath: root,
      agent: "worker",
      settings: { ...settings, stubPath: "test/ação/{agent}.test.ts" },
    })).resolves.toMatchObject({
      stubPath: relative,
      oracleHash: crypto.createHash("sha256").update(body).digest("hex"),
    });
  });

  it.each([":!{agent}.test.ts", ":(glob)**/{agent}.ts", ".{agent}.", ".{agent}::$DATA"])(
    "rejects unsafe cross-platform template %s before reading project files",
    async (stubPath) => {
      const root = repository();
      await expect(resolveCanonicalBehaviorOracle({
        worktreePath: root,
        agent: "worker",
        settings: { ...settings, stubPath },
      })).rejects.toThrow(/pathspec|ending in a dot|Windows-reserved/);
    },
  );
});
