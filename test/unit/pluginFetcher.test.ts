import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetchSource, defaultGitRun, defaultCacheRoot, type GitRun } from "../../src/plugins/fetcher.js";
import type { GitSource } from "../../src/plugins/source.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const SHA40 = (c: string) => c.repeat(40).slice(0, 40);

describe("fetchSource — pure logic via an injected GitRun (no network)", () => {
  const base: GitSource = { kind: "git", spec: "github:o/r@v1", remote: "https://github.com/o/r.git", ref: "v1", refKind: "named" };

  it("surfaces AUTH_REQUIRED (never hangs) when ls-remote fails on auth", async () => {
    const git: GitRun = async () => ({ stdout: "", stderr: "fatal: Authentication failed for 'https://github.com/o/r.git'", code: 128 });
    const r = await fetchSource(base, git, { cacheRoot: tmp("cache-") });
    expect(r.dir).toBeUndefined();
    expect(r.errors[0]).toBe("AUTH_REQUIRED: github.com");
  });

  it("reports a clear error when the ref does not resolve", async () => {
    const git: GitRun = async (args) => (args[0] === "ls-remote" ? { stdout: "", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 });
    const r = await fetchSource(base, git, { cacheRoot: tmp("cache-") });
    expect(r.errors.some((e) => /did not resolve to a commit/.test(e))).toBe(true);
  });

  /** A fake GitRun for the happy clone path: clone seeds the payload dir; rev-parse returns `headSha`. */
  function fakeGit(headSha: string, extra: (args: string[]) => GitRunResultLike | undefined = () => undefined): GitRun {
    return async (args) => {
      const e = extra(args);
      if (e) return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 0 };
      if (args[0] === "clone") {
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, ".git"), { recursive: true });
        fs.writeFileSync(path.join(dest, "tachyon-plugin.json"), "{}");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args.includes("rev-parse")) return { stdout: `${headSha}\n`, stderr: "", code: 0 };
      if (args.includes("ls-files")) return { stdout: "", stderr: "", code: 0 }; // no submodules
      return { stdout: "", stderr: "", code: 0 }; // fetch / checkout
    };
  }

  it("uses a 40-hex sha ref verbatim (no ls-remote) and verifies HEAD == sha", async () => {
    const calls: string[][] = [];
    const git = fakeGit(SHA40("a"), (args) => { calls.push(args); return undefined; });
    const src: GitSource = { ...base, ref: SHA40("a"), refKind: "sha" };
    const r = await fetchSource(src, git, { cacheRoot: tmp("cache-") });
    expect(r.errors).toEqual([]);
    expect(r.resolvedCommit).toBe(SHA40("a"));
    expect(r.payloadHash).toBeTruthy();
    expect(calls.some((c) => c[0] === "ls-remote")).toBe(false);
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true); // the integrity verify ran
  });

  it("fail-closes when the checked-out HEAD does not equal the resolved SHA (supply-chain)", async () => {
    // ls-remote says the tag is SHA-a, but the checkout resolves to SHA-b → integrity failure.
    const git = fakeGit(SHA40("b"), (args) => (args[0] === "ls-remote" ? { stdout: `${SHA40("a")}\trefs/tags/v1\n`, code: 0 } : undefined));
    const r = await fetchSource(base, git, { cacheRoot: tmp("cache-") });
    expect(r.dir).toBeUndefined();
    expect(r.errors.some((e) => /integrity check failed/.test(e))).toBe(true);
  });

  it("peels an annotated tag to its commit (prefers the ^{} line)", async () => {
    const commit = SHA40("c");
    const git = fakeGit(commit, (args) => (args[0] === "ls-remote"
      ? { stdout: `${SHA40("d")}\trefs/tags/v1\n${commit}\trefs/tags/v1^{}\n`, code: 0 } // tag-object then peeled commit
      : undefined));
    const r = await fetchSource(base, git, { cacheRoot: tmp("cache-") });
    expect(r.errors).toEqual([]);
    expect(r.resolvedCommit).toBe(commit); // the peeled commit, not the tag object
  });

  it("rejects a source that uses submodules (fail-closed)", async () => {
    const git = fakeGit(SHA40("b"), (args) => {
      if (args[0] === "ls-remote") return { stdout: `${SHA40("b")}\trefs/tags/v1\n`, code: 0 };
      if (args.includes("ls-files")) return { stdout: `160000 ${SHA40("c")} 0\tvendored\n`, code: 0 };
      return undefined;
    });
    const r = await fetchSource(base, git, { cacheRoot: tmp("cache-") });
    expect(r.errors.some((e) => /submodules/.test(e))).toBe(true);
  });
});

interface GitRunResultLike { stdout?: string; stderr?: string; code?: number }

describe("defaultCacheRoot", () => {
  it("is under the user home, not the workspace", () => {
    expect(defaultCacheRoot().startsWith(os.homedir())).toBe(true);
    expect(defaultCacheRoot()).toContain(path.join(".tachyon", "plugin-cache", "git"));
  });
});

// ── real-git smoke: clone a local bare-ish repo (git accepts a path as a remote), end-to-end ──
function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

describe.skipIf(!gitAvailable())("fetchSource — real git smoke (a local repo as the remote)", () => {
  /** Build a real git repo with a plugin at the root + one in a subdir; return its path + the HEAD sha. */
  function makeRepo(): { repo: string; sha: string } {
    const repo = tmp("src-repo-");
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    run(["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "tachyon-plugin.json"), JSON.stringify({ name: "root-plugin", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    fs.mkdirSync(path.join(repo, "plugins", "sub"), { recursive: true });
    fs.writeFileSync(path.join(repo, "plugins", "sub", "tachyon-plugin.json"), JSON.stringify({ name: "sub-plugin", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);
    const sha = run(["rev-parse", "HEAD"]).trim();
    run(["tag", "v1"]); // lightweight
    run(["tag", "-a", "vann", "-m", "annotated release"]); // annotated — its ref points at a tag OBJECT, not the commit
    return { repo, sha };
  }

  it("clones a tag, resolves the SHA, and returns the root plugin dir", async () => {
    const { repo, sha } = makeRepo();
    const src: GitSource = { kind: "git", spec: `x@v1`, remote: repo, ref: "v1", refKind: "named" };
    const r = await fetchSource(src, defaultGitRun, { cacheRoot: tmp("cache-") });
    expect(r.errors).toEqual([]);
    expect(r.resolvedCommit).toBe(sha);
    expect(fs.existsSync(path.join(r.dir!, "tachyon-plugin.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir!, "tachyon-plugin.json"), "utf8")).name).toBe("root-plugin");
  });

  it("resolves an ANNOTATED tag to its commit, not the tag object (real ls-remote peel)", async () => {
    // Regression: a filtered `ls-remote <remote> vann` returns only the tag-OBJECT sha; without also
    // querying `vann^{}` the resolver pins the tag object and the HEAD==sha integrity check fails.
    const { repo, sha } = makeRepo();
    const src: GitSource = { kind: "git", spec: `x@vann`, remote: repo, ref: "vann", refKind: "named" };
    const r = await fetchSource(src, defaultGitRun, { cacheRoot: tmp("cache-") });
    expect(r.errors).toEqual([]);
    expect(r.resolvedCommit).toBe(sha); // the peeled commit, never the annotated-tag object
    expect(fs.existsSync(path.join(r.dir!, "tachyon-plugin.json"))).toBe(true);
  });

  it("honors #path= to return a subdir plugin", async () => {
    const { repo } = makeRepo();
    const src: GitSource = { kind: "git", spec: `x@v1#path=plugins/sub`, remote: repo, ref: "v1", refKind: "named", subdir: "plugins/sub" };
    const r = await fetchSource(src, defaultGitRun, { cacheRoot: tmp("cache-") });
    expect(r.errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir!, "tachyon-plugin.json"), "utf8")).name).toBe("sub-plugin");
  });

  it("is a cache hit on the second fetch (offline-capable; same dir)", async () => {
    const { repo, sha } = makeRepo();
    const cacheRoot = tmp("cache-");
    const src: GitSource = { kind: "git", spec: `x@${sha}`, remote: repo, ref: sha, refKind: "sha" };
    const a = await fetchSource(src, defaultGitRun, { cacheRoot });
    const b = await fetchSource(src, defaultGitRun, { cacheRoot });
    expect(a.dir).toBe(b.dir);
    expect(b.errors).toEqual([]);
  });

  it("does not leak .git into the returned payload (it is stripped)", async () => {
    const { repo, sha } = makeRepo();
    const src: GitSource = { kind: "git", spec: `x@${sha}`, remote: repo, ref: sha, refKind: "sha" };
    const r = await fetchSource(src, defaultGitRun, { cacheRoot: tmp("cache-") });
    expect(fs.existsSync(path.join(r.dir!, ".git"))).toBe(false);
  });

  it("re-verifies a cache hit and evicts a tampered payload (poisoned cache defense)", async () => {
    const { repo, sha } = makeRepo();
    const cacheRoot = tmp("cache-");
    const src: GitSource = { kind: "git", spec: `x@${sha}`, remote: repo, ref: sha, refKind: "sha" };
    const a = await fetchSource(src, defaultGitRun, { cacheRoot });
    // poison the cached payload after the fact
    fs.writeFileSync(path.join(a.dir!, "tachyon-plugin.json"), '{"name":"EVIL"}');
    const b = await fetchSource(src, defaultGitRun, { cacheRoot }); // must detect the hash mismatch → evict + refetch
    expect(b.errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(b.dir!, "tachyon-plugin.json"), "utf8")).name).toBe("root-plugin"); // re-fetched clean
  });

  it("errors when #path= points where there is no manifest", async () => {
    const { repo } = makeRepo();
    const src: GitSource = { kind: "git", spec: `x@v1#path=nope`, remote: repo, ref: "v1", refKind: "named", subdir: "nope" };
    const r = await fetchSource(src, defaultGitRun, { cacheRoot: tmp("cache-") });
    expect(r.errors.some((e) => /no tachyon-plugin.json/.test(e))).toBe(true);
  });
});
