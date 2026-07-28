/**
 * t-5d0e9d — reusing the attestation for an EXACT tree, and refusing to in every other case.
 *
 * The flow this exists to fix runs `verify:full` three times over one unchanged tree: the agent
 * verifies, the coordinator fast-forwards and verifies the identical content, then the pre-push gate
 * verifies it a third time. Each run takes minutes and they contend on one host-wide lock.
 *
 * The safety property is the whole point, so most of these tests are about REFUSING to reuse. A cache
 * that is wrong once is worse than no cache at all, because the thing it waves through is a landing.
 * Every branch that is not an exact, fresh, same-environment match on the same tree must re-run.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_MAX_RECORD_AGE_MS,
  readRecord,
  recordVerification,
  recordDir,
  reuseDecision,
  verifierFingerprint,
} from "../../scripts/verify-record.mjs";

/** A throwaway git repo with one commit, so tree ids are real rather than invented. */
function repo(): { dir: string; tree: string; commit: (msg: string, file: string, body: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-reuse-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  const commit = (msg: string, file: string, body: string) => {
    fs.writeFileSync(path.join(dir, file), body);
    git("add", "--", file);
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD^{tree}");
  };
  const tree = commit("first", "a.txt", "one\n");
  return { dir, tree, commit };
}

const FP = verifierFingerprint({ command: "verify:full", gates: ["typecheck"] }).fingerprint;

describe("t-5d0e9d — an exact-tree green is reusable", () => {
  it("reuses a fresh record for the same tree, same verifier", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "500 files, 6000 passed" });
      const decision = reuseDecision({ tree, fingerprint: FP, cwd: dir });
      expect(decision.reuse, decision.reason).toBe(true);
      expect(decision.record.summary).toBe("500 files, 6000 passed");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("reuses across a fast-forward, because a fast-forward does not change the tree", () => {
    // The coordinator's post-fast-forward run is the second of the three. `git merge --ff-only` moves
    // a ref and leaves content identical, so the record for that content still applies — which is why
    // the record is keyed by tree and not by commit.
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
      git("checkout", "-q", "-b", "feature");
      git("commit", "-q", "--allow-empty", "-m", "empty: same tree, new commit");
      const movedTree = git("rev-parse", "HEAD^{tree}");
      expect(movedTree).toBe(tree); // an empty commit is a different sha over identical content
      expect(git("rev-parse", "HEAD")).not.toBe(git("rev-parse", "main"));

      expect(reuseDecision({ tree: movedTree, fingerprint: FP, cwd: dir }).reuse).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("t-5d0e9d — everything else re-runs", () => {
  it("refuses a different tree, which is what a merge or cherry-pick produces", () => {
    const { dir, tree, commit } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const merged = commit("second", "b.txt", "two\n");
      expect(merged).not.toBe(tree);
      // The merged tree is a THIRD tree, neither parent — the case the landing rule exists for.
      const decision = reuseDecision({ tree: merged, fingerprint: FP, cwd: dir });
      expect(decision.reuse).toBe(false);
      expect(decision.reason).toMatch(/no record/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses when the verifier or environment changed", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const other = verifierFingerprint({ command: "verify:full", gates: ["typecheck"], env: { version: "v99.0.0", platform: "sunos", arch: "sparc" } }).fingerprint;
      expect(other).not.toBe(FP);
      const decision = reuseDecision({ tree, fingerprint: other, cwd: dir });
      expect(decision.reuse).toBe(false);
      expect(decision.reason).toMatch(/verifier or environment changed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a corrupted record — a proof that cannot be read is not a proof", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      fs.writeFileSync(path.join(recordDir(dir), `${tree}.json`), "{ not json");
      expect(readRecord(tree, dir)).toBeUndefined();
      expect(reuseDecision({ tree, fingerprint: FP, cwd: dir }).reuse).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a record that disagrees with the tree it is filed under", () => {
    // Tampering, or a bad copy between clones. Either way the file is not evidence about this tree.
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const file = path.join(recordDir(dir), `${tree}.json`);
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...rec, tree: "0".repeat(40) }));
      expect(reuseDecision({ tree, fingerprint: FP, cwd: dir }).reuse).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a stale record, and a record dated in the future", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const then = Date.now();
      const stale = reuseDecision({ tree, fingerprint: FP, cwd: dir, now: () => then + DEFAULT_MAX_RECORD_AGE_MS + 1000 });
      expect(stale.reuse).toBe(false);
      expect(stale.reason).toMatch(/stale/);
      // A clock that moved backwards must not produce a record that outranks every honest one.
      const future = reuseDecision({ tree, fingerprint: FP, cwd: dir, now: () => then - 86_400_000 });
      expect(future.reuse).toBe(false);
      expect(future.reason).toMatch(/future/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a pre-fingerprint (schema 1) record instead of assuming it matches", () => {
    // Reusing one would be assuming the answer to the exact question fingerprinting was added to ask.
    const { dir, tree } = repo();
    try {
      const dirPath = recordDir(dir);
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, `${tree}.json`), JSON.stringify({ schema: 1, tree, at: new Date().toISOString() }));
      const decision = reuseDecision({ tree, fingerprint: FP, cwd: dir });
      expect(decision.reuse).toBe(false);
      expect(decision.reason).toMatch(/predates verifier fingerprinting/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a dirty working tree, and never records one", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      fs.writeFileSync(path.join(dir, "a.txt"), "dirtied\n");
      // What ran under a dirty tree is not any committed tree, so no commit may claim it.
      expect(recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP }).recorded).toBe(false);
      expect(reuseDecision({ tree: null, fingerprint: FP, cwd: dir }).reuse).toBe(false);
      // The clean tree's own record is untouched by the dirt beside it.
      expect(reuseDecision({ tree, fingerprint: FP, cwd: dir }).reuse).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("honours an explicit force-reverify, and says so rather than bypassing silently", () => {
    const { dir, tree } = repo();
    try {
      recordVerification({ cwd: dir, command: "verify:full", fingerprint: FP, summary: "green" });
      const decision = reuseDecision({ tree, fingerprint: FP, cwd: dir, force: true });
      expect(decision.reuse).toBe(false);
      expect(decision.reason).toMatch(/force-reverify/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("t-5d0e9d — the fingerprint covers what the tree cannot", () => {
  it("changes with the node major, the platform and the command", () => {
    const base = { command: "verify:full", gates: ["typecheck"], env: { version: "v22.1.0", platform: "linux", arch: "x64" } };
    const fp = (o: Record<string, unknown>) => verifierFingerprint({ ...base, ...o }).fingerprint;
    expect(fp({})).toBe(fp({ env: { version: "v22.9.9", platform: "linux", arch: "x64" } })); // patch: same
    expect(fp({})).not.toBe(fp({ env: { version: "v24.0.0", platform: "linux", arch: "x64" } }));
    expect(fp({})).not.toBe(fp({ env: { version: "v22.1.0", platform: "darwin", arch: "x64" } }));
    expect(fp({})).not.toBe(fp({ command: "verify" }));
    expect(fp({})).not.toBe(fp({ gates: ["typecheck", "check:engine-boundary"] }));
  });

  it("is stable across key order, so an identical environment always hits", () => {
    // A fingerprint that depended on property order would miss constantly and silently give up the
    // entire benefit while still looking correct.
    const a = verifierFingerprint({ command: "verify:full", gates: ["a", "b"], extra: { x: "1", y: "2" } }).fingerprint;
    const b = verifierFingerprint({ command: "verify:full", gates: ["a", "b"], extra: { y: "2", x: "1" } }).fingerprint;
    expect(a).toBe(b);
  });
});
