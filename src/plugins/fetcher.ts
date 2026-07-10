/**
 * spec 250 Step 5b — the plugin FETCHER (I/O). Given a resolved `GitSource`, materialize it into a global,
 * content-addressed, VERIFIED cache and return the plugin DIR for `loadPlugin`. v1 is git-based + remote-only.
 *
 * Supply-chain safety (codex-reviewed contract):
 *  - git runs through an injectable `GitRun` using an argv ARRAY (never a shell) + a wall-clock timeout; the
 *    resolver already rejected leading-dash refs, so no argument injection.
 *  - the resolved commit SHA is VERIFIED: after checkout, `HEAD` must equal the SHA the cache is keyed by
 *    (annotated tags are peeled to their commit first), else fail-closed — the cache/lockfile can never pin
 *    SHA-A while the tree is SHA-B.
 *  - cache entry layout `<cacheRoot>/git/<remoteHash>/<sha>/{payload/, marker.json}`: the clean worktree
 *    (`.git` stripped) lives in `payload/`, the verification marker beside it. The workspace repo stays 100%
 *    clean; `.git`/the marker never leak into the copied payload.
 *  - a cache HIT is re-verified (marker SHA + a recomputed content hash); a mismatch evicts + refetches once,
 *    else fails closed. Written via a staging entry + atomic rename (concurrency-safe).
 *  - submodules/gitlinks rejected (fail-closed on a git error); LFS pointer files fail closed (no `lfs pull`);
 *    an unreadable payload file fails closed. The install engine then runs `preflightPayload` (no symlinks,
 *    bounded) + `loadPlugin` on the returned dir.
 *  - auth never prompts inside the hidden process: an auth failure surfaces as `AUTH_REQUIRED: <host>`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { parseSemverTag, compareSemver, type GitSource } from "./source.js";
import { resolveGitBinary, gitNotFoundError } from "../worktree/gitBinary.js";

const CLONE_TIMEOUT_MS = 120_000;
const MARKER_NAME = "marker.json";
const PAYLOAD_NAME = "payload";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** Runs git with an argv ARRAY (no shell). Resolves (never rejects) on non-zero exit; rejects only when git
 *  can't spawn. Injectable so the fetcher is testable without a network or a git binary. */
export type GitRun = (args: string[], cwd?: string) => Promise<GitRunResult>;

/** git with interactive auth disabled (fail fast → AUTH_REQUIRED, never hang) + a wall-clock timeout. */
export function defaultGitRun(args: string[], cwd?: string): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveGitBinary(),
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: CLONE_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes", GCM_INTERACTIVE: "never" },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(gitNotFoundError());
        const e = err as (Error & { killed?: boolean; signal?: string; code?: unknown }) | null;
        if (e?.killed || e?.signal) return resolve({ stdout: stdout ?? "", stderr: `${stderr ?? ""}\ngit timed out after ${CLONE_TIMEOUT_MS}ms`, code: 124 });
        const code = typeof e?.code === "number" ? e.code : err ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

export function defaultCacheRoot(): string {
  return path.join(os.homedir(), ".tachyon", "plugin-cache", "git");
}

function entryDirFor(cacheRoot: string, remote: string, sha: string): string {
  const remoteHash = crypto.createHash("sha256").update(remote).digest("hex").slice(0, 16);
  return path.join(cacheRoot, remoteHash, sha);
}

function looksLikeAuthFailure(stderr: string): boolean {
  return /Authentication failed|could not read Username|terminal prompts disabled|fatal: could not read|Permission denied|access denied|403/i.test(stderr);
}

function hostOf(remote: string): string {
  try { return new URL(remote).host; } catch { return remote; }
}

interface MarkerV1 {
  schema: 1;
  remote: string;
  sha: string;
  payloadHash: string;
}

/** Deterministic content hash of a payload tree (excludes `.git`; symlinks/special files marked so the hash
 *  is stable but the later preflight rejects them). */
function hashTree(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string, rel: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ent.name === ".git") continue;
      const p = path.join(d, ent.name);
      const r = path.posix.join(rel, ent.name);
      if (ent.isDirectory()) { h.update(`D:${r}\n`); walk(p, r); }
      else if (ent.isFile()) { h.update(`F:${r}:`); h.update(fs.readFileSync(p)); h.update("\n"); }
      else h.update(`X:${r}\n`);
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

export interface FetchResult {
  /** the plugin dir (the subdir within the payload, when `#path=`) — the input to loadPlugin. */
  dir?: string;
  /** the verified concrete commit (pinned into the lockfile for reproducible reinstall). */
  resolvedCommit?: string;
  /** the verified payload content hash (the lockfile `integrity`). */
  payloadHash?: string;
  errors: string[];
}

interface Resolved {
  /** the commit SHA the cache is keyed by + the install pins (peeled, for an annotated tag). */
  sha?: string;
  /** what to `git fetch` — a ref NAME for a tag/branch (universally supported) or the SHA for a sha-source. */
  fetchRef?: string;
  errors: string[];
}

/** Resolve a source's ref to a concrete commit SHA via `ls-remote` (peeling annotated tags), or use a
 *  40-hex `sha` ref verbatim. */
async function resolveCommit(source: GitSource, git: GitRun): Promise<Resolved> {
  if (source.refKind === "sha") return { sha: source.ref, fetchRef: source.ref, errors: [] };
  const refArg = source.ref === "HEAD" ? "HEAD" : source.ref;
  // Query the ref AND its peeled `^{}` form together: a FILTERED `ls-remote <remote> <ref>` returns only the
  // tag-OBJECT line for an annotated tag — the peeled-commit line is emitted only when its own pattern is
  // requested. Without it we'd pin the tag object, fail the HEAD==sha integrity check, and a user pinning
  // `@<annotated-tag>` could never install. (Branches/HEAD have no peeled line → the extra pattern is a no-op.)
  const r = await git(["ls-remote", source.remote, refArg, `${refArg}^{}`]);
  if (r.code !== 0) {
    if (looksLikeAuthFailure(r.stderr)) return { errors: [`AUTH_REQUIRED: ${hostOf(source.remote)}`] };
    return { errors: [`could not resolve ref '${source.ref}' on ${source.remote}: ${r.stderr.trim() || `git exited ${r.code}`}`] };
  }
  // lines: "<sha>\t<ref>"; an annotated tag also emits "<commit>\t<ref>^{}" — prefer the peeled commit.
  const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0).map((l) => ({ sha: l.split(/\s+/)[0], ref: l.split(/\s+/)[1] ?? "" }));
  const peeled = lines.find((l) => l.ref.endsWith("^{}"));
  const sha = (peeled ?? lines[0])?.sha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return { errors: [`ref '${source.ref}' did not resolve to a commit on ${source.remote}`] };
  // fetch the ref NAME (all hosts allow it); we'll then VERIFY the checked-out HEAD equals this peeled sha.
  return { sha, fetchRef: refArg, errors: [] };
}

export interface LatestTagResult {
  /** the highest semver tag NAME, verbatim (e.g. `v0.6.0` — the author's `v`-convention preserved); absent when
   *  the repo has no semver tag or the lookup failed. */
  tag?: string;
  /** ALL tag names the repo exposed (semver or not), so the caller can prove the current pin is a real TAG (not a
   *  branch that merely looks like a version) before offering a bump. Empty on a lookup failure. */
  tags: string[];
  errors: string[];
}

/**
 * Resolve the source repo's HIGHEST semver tag via `ls-remote --tags --refs` (spec 266 — latest-version
 * detection). Returns the verbatim tag name so a later normal fetch peels/verifies it like any pin, plus the full
 * tag-name list (so the caller can confirm the current pin is itself a tag). Fail-closed and NON-FATAL: a git
 * error / auth failure / no-semver-tag yields `{ errors }` / `{ tag: undefined }` — the caller falls back to the
 * exact pin so a probe blip never regresses the update check. Never throws (except git-binary-absent, via
 * GitRun). `--refs` drops the `^{}` peeled duplicates; only the tag NAME is needed here.
 */
export async function resolveLatestSemverTag(source: GitSource, git: GitRun = defaultGitRun): Promise<LatestTagResult> {
  const r = await git(["ls-remote", "--tags", "--refs", source.remote]);
  if (r.code !== 0) {
    if (looksLikeAuthFailure(r.stderr)) return { tags: [], errors: [`AUTH_REQUIRED: ${hostOf(source.remote)}`] };
    return { tags: [], errors: [`could not list tags on ${source.remote}: ${r.stderr.trim() || `git exited ${r.code}`}`] };
  }
  const tags: string[] = [];
  let best: string | undefined;
  for (const line of r.stdout.split("\n")) {
    const ref = line.split(/\s+/)[1] ?? "";
    if (!ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length);
    tags.push(name);
    if (!parseSemverTag(name)) continue; // non-semver tag → not a version, never ordered/offered
    if (best === undefined || compareSemver(name, best) > 0) best = name;
  }
  return { ...(best ? { tag: best } : {}), tags, errors: [] };
}

/** Reject submodules/gitlinks. Fail-CLOSED: a git error here returns true (treat as unsafe), never silently false. */
async function usesSubmodules(checkoutDir: string, git: GitRun): Promise<boolean> {
  if (fs.existsSync(path.join(checkoutDir, ".gitmodules"))) return true;
  const r = await git(["-C", checkoutDir, "ls-files", "-s"]);
  if (r.code !== 0) return true; // can't prove it's clean → refuse
  return r.stdout.split("\n").some((l) => l.startsWith("160000"));
}

/** Detect a git-LFS pointer file anywhere in the payload. Fail-CLOSED on an unreadable file. Returns an error
 *  string or null. */
function lfsError(dir: string): string | null {
  const walk = (d: string): string | null => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === ".git") continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { const e = walk(p); if (e) return e; }
      else if (ent.isFile()) {
        let head: string;
        try { head = fs.statSync(p).size < 1024 ? fs.readFileSync(p, "utf8").slice(0, 80) : ""; }
        catch { return `unreadable payload file: ${ent.name}`; }
        if (head.startsWith("version https://git-lfs.github.com/spec")) return "plugin payload contains git-LFS pointer files — not supported in v1 (commit real files, not LFS)";
      }
    }
    return null;
  };
  return walk(dir);
}

function finish(entryDir: string, source: GitSource, sha: string): FetchResult {
  const payloadDir = path.join(entryDir, PAYLOAD_NAME);
  const dir = source.subdir ? path.join(payloadDir, source.subdir) : payloadDir;
  if (!fs.existsSync(path.join(dir, "tachyon-plugin.json"))) {
    return { errors: [`no tachyon-plugin.json at ${source.subdir ? `#path=${source.subdir}` : "the repo root"} of ${source.remote}@${sha}`] };
  }
  const lfs = lfsError(dir);
  if (lfs) return { errors: [lfs] };
  return { dir, resolvedCommit: sha, payloadHash: hashTree(payloadDir), errors: [] };
}

/**
 * Fetch a plugin source into the verified global cache and return its plugin dir. Idempotent: a present,
 * integrity-OK cache entry is reused (offline-capable); a corrupt/mismatched entry is evicted + refetched
 * once. Never throws (except git-binary-absent). The caller (install engine) then runs `preflightPayload` +
 * `loadPlugin` on the returned dir.
 */
export async function fetchSource(source: GitSource, git: GitRun = defaultGitRun, opts: { cacheRoot?: string } = {}): Promise<FetchResult> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const resolved = await resolveCommit(source, git);
  if (!resolved.sha || !resolved.fetchRef) return { errors: resolved.errors };
  const { sha, fetchRef } = resolved;

  const entryDir = entryDirFor(cacheRoot, source.remote, sha);
  const payloadDir = path.join(entryDir, PAYLOAD_NAME);
  const markerPath = path.join(entryDir, MARKER_NAME);

  // cache HIT → re-verify the marker SHA + a recomputed content hash before trusting it.
  if (fs.existsSync(markerPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, "utf8")) as MarkerV1;
      if (m.schema === 1 && m.sha === sha && fs.existsSync(payloadDir) && hashTree(payloadDir) === m.payloadHash) {
        return finish(entryDir, source, sha);
      }
    } catch { /* fall through to evict + refetch */ }
    fs.rmSync(entryDir, { recursive: true, force: true }); // poisoned/stale → evict
  }

  // cache MISS → build the whole entry in a staging dir, then atomic-rename it into place.
  const staging = `${entryDir}.staging-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const co = path.join(staging, PAYLOAD_NAME);

  try {
    const clone = await git(["clone", "--no-checkout", "--depth", "1", "--no-tags", "--no-recurse-submodules", source.remote, co]);
    if (clone.code !== 0) {
      if (looksLikeAuthFailure(clone.stderr)) return { errors: [`AUTH_REQUIRED: ${hostOf(source.remote)}`] };
      return { errors: [`clone failed for ${source.remote}: ${clone.stderr.trim() || `git exited ${clone.code}`}`] };
    }
    // fetch the ref by NAME (hosts allow this) — or the SHA for a sha-source (host may reject by-SHA → clear error).
    const fetch = await git(["-C", co, "fetch", "--depth", "1", "--no-tags", "origin", fetchRef]);
    if (fetch.code !== 0 && source.refKind === "sha") {
      return { errors: [`could not fetch commit ${sha} from ${source.remote} (the host may not allow fetching by SHA — pin a tag or branch instead): ${fetch.stderr.trim()}`] };
    }
    const checkout = await git(["-C", co, "checkout", "--detach", fetch.code === 0 ? "FETCH_HEAD" : sha]);
    if (checkout.code !== 0) return { errors: [`could not check out ${sha} from ${source.remote}: ${checkout.stderr.trim() || `git exited ${checkout.code}`}`] };

    // VERIFY: the checked-out commit must equal the SHA we keyed/pinned (supply-chain integrity).
    const head = await git(["-C", co, "rev-parse", "--verify", "HEAD^{commit}"]);
    const headSha = head.stdout.trim().toLowerCase();
    if (head.code !== 0 || headSha !== sha) {
      return { errors: [`integrity check failed: ${source.remote}@${source.ref} resolved to ${sha} but checked out ${headSha || "?"}`] };
    }
    if (await usesSubmodules(co, git)) {
      return { errors: ["plugin source uses git submodules — not supported (submodules are remote-code indirection, not plugin content)"] };
    }

    // strip .git (the payload must not carry VCS metadata into the workspace), write the marker, publish atomically.
    fs.rmSync(path.join(co, ".git"), { recursive: true, force: true });
    const marker: MarkerV1 = { schema: 1, remote: source.remote, sha, payloadHash: hashTree(co) };
    fs.writeFileSync(path.join(staging, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`);

    fs.mkdirSync(path.dirname(entryDir), { recursive: true });
    try {
      fs.renameSync(staging, entryDir);
    } catch {
      // a concurrent fetch of the same key won the race → use the existing entry if it's now valid.
      if (!fs.existsSync(markerPath)) return { errors: [`could not finalize cache for ${source.remote}@${sha}`] };
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return finish(entryDir, source, sha);
}
