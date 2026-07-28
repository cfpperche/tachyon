/**
 * t-47cc91 — durable answer to "was THIS content verified?"
 *
 * docs/project-guidance.md § Landing order states the rule this serves: **the tree you land must be
 * the tree you verified**. Until now nothing recorded which tree a green run covered, so the rule had
 * to be honoured from memory — you had to still know which commit you had verified. A record makes it
 * a lookup.
 *
 * KEYED BY TREE, NOT COMMIT. A rebase or an amended message produces a different commit id for
 * identical content, and it is the content that was verified. Two commits with the same tree are the
 * same verification.
 *
 * STORED IN THE SHARED GIT DIR (`git rev-parse --git-common-dir`), which resolves to the same path
 * from a linked worktree and from the primary checkout. That is the whole point: the landing flow
 * verifies INSIDE a change worktree and then moves the trunk from the primary checkout, so a record
 * written in one has to be readable from the other. A `.tachyon/` directory inside the worktree would
 * vanish with it, exactly when the trunk needs the proof. Living under `.git` also means it dies with
 * the clone and is never a tracked file.
 *
 * A DIRTY WORKING TREE PRODUCES NO RECORD. What ran then was the working tree, which is not any
 * committed tree, so no commit can honestly claim it. Writing HEAD's tree anyway would be a proof of
 * something that was never verified — the exact failure this exists to prevent. No proof beats a
 * wrong one.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const DIR_NAME = "tachyon-verify";
/** Records are ~300 bytes; this only stops unbounded growth over a long-lived clone. */
const KEEP = 50;

/**
 * t-5d0e9d — how long a green stays reusable.
 *
 * Age is a backstop, not the real control. The things that decide whether a green still means
 * something are the tree (which keys the record) and the verifier fingerprint (which is compared
 * below); both are exact. Age only bounds the blast radius of something neither of those can see —
 * an upgraded system library, a rotated credential, a machine that drifted. Seven days is long
 * enough that ordinary landing traffic always hits, and short enough that nothing reuses a green
 * from a materially different machine-week.
 */
export const DEFAULT_MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * t-5d0e9d — the out-of-tree inputs a green depends on.
 *
 * Deliberately NOT a hash of the verifier's source. `scripts/verify-full.mjs`, `vitest.config.*` and
 * `package.json` all live IN the tree, and the record is keyed BY the tree — change any of them and
 * the key changes, so hashing them again would be a second lock on the same door.
 *
 * What the tree cannot see is the environment the suite ran in. A green produced under a different
 * Node major, a different platform, or a different verification command is not evidence about this
 * one, and none of those leave a mark on the tree. That is exactly the gap this closes.
 */
export function verifierFingerprint({ command = "verify:full", gates = [], env = process, extra = {} } = {}) {
  const material = {
    command,
    gates: [...gates],
    // Major only: a patch bump of Node is not a reason to re-run a whole suite, and treating it as
    // one would make the cache miss constantly for no gain in truth.
    node: String(env.version ?? "").split(".")[0],
    platform: String(env.platform ?? ""),
    arch: String(env.arch ?? ""),
    ...extra,
  };
  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return { fingerprint: crypto.createHash("sha256").update(canonical).digest("hex"), material };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Absolute path of the record directory, shared by every worktree of this clone. */
export function recordDir(cwd = process.cwd()) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  return path.join(common, DIR_NAME);
}

/**
 * The tree a verification in `cwd` can honestly claim, or null when the working tree is dirty.
 * Returns null (not a throw) outside a git repo: a verification is still valid, it just has no
 * durable identity to file it under.
 */
export function verifiableTree(cwd = process.cwd()) {
  try {
    if (git(["status", "--porcelain"], cwd).length > 0) return null; // dirty → not any committed tree
    return git(["rev-parse", "HEAD^{tree}"], cwd);
  } catch {
    return null;
  }
}

/** The tree of an arbitrary commit-ish, or null when it cannot be resolved. */
export function treeOf(commitish, cwd = process.cwd()) {
  try {
    return git(["rev-parse", `${commitish}^{tree}`], cwd);
  } catch {
    return null;
  }
}

function prune(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  if (entries.length <= KEEP) return;
  const byAge = entries
    .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of byAge.slice(KEEP)) fs.rmSync(path.join(dir, f), { force: true });
}

/**
 * Record that the content currently in `cwd` verified green. Returns the record, or null with a
 * reason when there is nothing honest to file (dirty tree, not a repo).
 */
export function recordVerification({ cwd = process.cwd(), command, summary, fingerprint, now = () => new Date() } = {}) {
  const tree = verifiableTree(cwd);
  if (!tree) return { recorded: false, reason: "working tree is dirty or not a git repo — no commit can claim this run" };
  let commit = null;
  try { commit = git(["rev-parse", "HEAD"], cwd); } catch { /* detached/empty repo — the tree still identifies it */ }

  const dir = recordDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    // schema 2 adds `fingerprint`. A schema-1 record is read as UNUSABLE for reuse rather than
    // upgraded in place: it was written before anything recorded which environment produced it, so
    // there is no honest way to claim it matches this one. It still reads fine for `check`.
    schema: 2,
    tree,
    commit,
    at: now().toISOString(),
    ...(command ? { command } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(summary ? { summary } : {}),
  };
  const file = path.join(dir, `${tree}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  prune(dir);
  return { recorded: true, record, file };
}

/** The record for `tree`, or undefined. A malformed file is treated as absent — a proof that cannot be read is not a proof. */
export function readRecord(tree, cwd = process.cwd()) {
  try {
    const raw = fs.readFileSync(path.join(recordDir(cwd), `${tree}.json`), "utf8");
    const rec = JSON.parse(raw);
    // A record must still name the tree it is filed under. A file that disagrees with its own key has
    // been tampered with or corrupted, and either way it is not proof of anything.
    if (!rec || rec.tree !== tree) return undefined;
    return rec.schema === 1 || rec.schema === 2 ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * t-5d0e9d — may a green already on file stand in for running the suite again?
 *
 * FAIL-CLOSED IN EVERY DIRECTION. Every branch that is not an exact, fresh, same-environment match on
 * the same tree returns `reuse: false` with a reason. "Cannot tell" is never "verified" — that is the
 * same rule `check` already followed, applied to a decision that now SKIPS work rather than reporting
 * on it, which is precisely when the rule earns its keep.
 *
 * What is deliberately NOT consulted: the commit sha, the commit message, and anything an agent says
 * about what it ran. Only the content hash of the tree, the recorded environment, and the clock.
 */
export function reuseDecision({
  tree,
  fingerprint,
  cwd = process.cwd(),
  maxAgeMs = DEFAULT_MAX_RECORD_AGE_MS,
  now = () => Date.now(),
  force = false,
} = {}) {
  if (force) return { reuse: false, reason: "force-reverify requested" };
  if (!tree) return { reuse: false, reason: "no committed tree to attest (dirty working tree or not a git repo)" };
  const record = readRecord(tree, cwd);
  if (!record) return { reuse: false, reason: `no record for tree ${tree.slice(0, 12)}` };
  // A pre-fingerprint record cannot say which environment produced it. Reusing it would be assuming
  // the answer to the exact question the fingerprint was added to ask.
  if (record.schema !== 2 || !record.fingerprint) {
    return { reuse: false, reason: "record predates verifier fingerprinting", record };
  }
  if (record.fingerprint !== fingerprint) {
    return { reuse: false, reason: "verifier or environment changed since that run", record };
  }
  const at = Date.parse(record.at ?? "");
  if (!Number.isFinite(at)) return { reuse: false, reason: "record has no usable timestamp", record };
  const ageMs = now() - at;
  // A record from the future is a clock that moved, not a fresher proof. Treat it as unusable rather
  // than letting it outrank every honest record.
  if (ageMs < 0) return { reuse: false, reason: "record is dated in the future", record };
  if (ageMs > maxAgeMs) return { reuse: false, reason: `record is stale (${Math.floor(ageMs / 86_400_000)}d old)`, record };
  return { reuse: true, reason: `tree ${tree.slice(0, 12)} already verified at ${record.at}`, record };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// `verify-record check [<commit-ish>]` — exit 0 when that commit's CONTENT has a green record.
// Anything unresolvable exits non-zero: "cannot tell" is not "verified".

function main(argv) {
  const [mode, arg] = argv;
  if (mode !== "check") {
    process.stderr.write("usage: verify-record check [<commit-ish>]   (default: HEAD)\n");
    return 2;
  }
  const tree = treeOf(arg || "HEAD");
  if (!tree) {
    process.stderr.write(`verify-record: cannot resolve a tree for '${arg || "HEAD"}'\n`);
    return 2;
  }
  const rec = readRecord(tree);
  if (!rec) {
    process.stderr.write(`verify-record: NO record for tree ${tree.slice(0, 12)} — this content has not been verified here.\n`);
    return 1;
  }
  process.stdout.write(`verify-record: tree ${tree.slice(0, 12)} verified at ${rec.at}${rec.summary ? ` (${rec.summary})` : ""}\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("verify-record.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
