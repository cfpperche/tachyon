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
 * STORED AS A REF (`refs/tachyon/verify/<tree>`) pointing at the JSON blob. Refs live in the shared
 * git common dir, so the same name resolves from a linked worktree and from the primary checkout.
 * That is the whole point: the landing flow verifies INSIDE a change worktree and then moves the
 * trunk from the primary checkout, so a record written in one has to be readable from the other.
 * The ref also makes the proof publishable and fetchable with git alone.
 *
 * A RUN WITH UNCLAIMABLE INPUTS PRODUCES NO RECORD. A dirty working tree is not any committed tree;
 * a linked primary `node_modules` paired with divergent lockfiles is not the dependency set declared
 * by this tree. Writing HEAD's tree in either case would prove something that was never verified.
 * No proof beats a wrong one.
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dependencyLockfileValidity from "@tachyon/shared/dependency-lockfile-validity.cjs";
import validityContract from "@tachyon/shared/verify-record-validity.cjs";

const { fingerprintLockfiles, lockfileDivergenceReason } = dependencyLockfileValidity;
const { DEFAULT_MAX_RECORD_AGE_MS, verificationRecordValidity } = validityContract;
export { DEFAULT_MAX_RECORD_AGE_MS };

const REF_PREFIX = "refs/tachyon/verify";

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

function gitWithInput(args, cwd, input) {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
}

/** `git` for a query whose FAILURE is an answer — returns null instead of throwing. */
function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
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

function readLockfiles(dir) {
  return (name) => {
    try {
      return fs.readFileSync(path.join(dir, name));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
}

function missingDependencyDirIsNotApplicable(dependencyDir) {
  try {
    return fs.lstatSync(dependencyDir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Refuse only when this checkout is demonstrably running through the primary checkout's
 * `node_modules` and the two declared dependency sets disagree. An owned install, a foreign link,
 * matching lockfiles, or no lockfiles on either side makes no claim here.
 */
function sharedDependencyDivergenceReason(cwd) {
  try {
    const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const primary = path.dirname(commonDir);
    const checkout = git(["rev-parse", "--show-toplevel"], cwd);
    if (path.resolve(checkout) === path.resolve(primary)) return null;

    const dependencyDir = path.join(checkout, "node_modules");
    const dependencyDirStat = missingDependencyDirIsNotApplicable(dependencyDir);
    if (!dependencyDirStat || !dependencyDirStat.isSymbolicLink()) return null;
    const target = path.resolve(path.dirname(dependencyDir), fs.readlinkSync(dependencyDir));
    if (target !== path.resolve(primary, "node_modules")) return null;

    const primaryFingerprint = fingerprintLockfiles(readLockfiles(primary));
    const worktreeFingerprint = fingerprintLockfiles(readLockfiles(checkout));
    if (primaryFingerprint.files.length === 0 && worktreeFingerprint.files.length === 0) return null;
    if (primaryFingerprint.digest === worktreeFingerprint.digest) return null;
    return lockfileDivergenceReason(primaryFingerprint, worktreeFingerprint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `could not determine whether dependencies match this tree: ${detail}`;
  }
}

/**
 * Record that the content currently in `cwd` verified green. Returns the record, or null with a
 * reason when there is nothing honest to file (dirty tree, not a repo, or dependencies from a
 * different lockfile set).
 */
export function recordVerification({ cwd = process.cwd(), command, summary, fingerprint, now = () => new Date() } = {}) {
  const tree = verifiableTree(cwd);
  if (!tree) return { recorded: false, reason: "working tree is dirty or not a git repo — no commit can claim this run" };
  const divergenceReason = sharedDependencyDivergenceReason(cwd);
  if (divergenceReason) return { recorded: false, reason: divergenceReason };
  let commit = null;
  try { commit = git(["rev-parse", "HEAD"], cwd); } catch { /* detached/empty repo — the tree still identifies it */ }

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
  const json = `${JSON.stringify(record, null, 2)}\n`;
  const blob = gitWithInput(["hash-object", "-w", "--stdin"], cwd, json);
  const ref = `${REF_PREFIX}/${tree}`;
  git(["update-ref", ref, blob], cwd);
  return { recorded: true, record, ref, blob };
}

/** The record for `tree`, or undefined. An unreadable blob is absent — a proof that cannot be read is not a proof. */
export function readRecord(tree, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(tree)) return undefined;
  try {
    const raw = git(["cat-file", "blob", `${REF_PREFIX}/${tree}`], cwd);
    const rec = JSON.parse(raw);
    // A record must still name the tree it is filed under. A blob that disagrees with its own key has
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
  const validity = verificationRecordValidity(record, {
    expectedFingerprint: fingerprint,
    maxAgeMs,
    now,
  });
  if (!validity.valid) return { reuse: false, reason: validity.reason, record };
  return { reuse: true, reason: `tree ${tree.slice(0, 12)} already verified at ${record.at}`, record };
}

/**
 * t-884b48 — the question nobody could ask: which states did the trunk pass through UNPROVEN?
 *
 * `check` answers about one commit, and every caller of it asks about the tip. That is why the gap
 * this closes was invisible for a whole day: measured 2026-08-05, 70 merges landed on `main` and 42
 * produced a tree with no green on file — 31 of them content that neither parent had verified, so no
 * branch gate could have covered it even in principle. Each agent proved its own branch and the
 * combination was proved by nobody.
 *
 * The base is `origin/main..HEAD`: the set a push would publish. This is the same choice t-d858f5
 * argued for the browser gate and for the same reason — a stale `origin/main` widens the set rather
 * than narrowing it, which errs slow instead of blind, and no fetch happens, so the audit stays
 * offline.
 *
 * FIRST-PARENT, not every commit. The trunk's own states are what land; the commits on a branch were
 * never expected to carry individual greens, and reporting them would bury the real finding under
 * noise that trains a reader to skip the block. That is also why an unproven merge whose tree is NEW
 * is counted separately: a merge whose tree equals a parent's introduced no content, and a green
 * filed for that branch already covers it.
 */
/**
 * Only on `main`, because only there does "trunk state" mean anything. Asked from an agent's branch,
 * a first-parent walk of `origin/main..HEAD` returns that branch's own commits — which no one ever
 * expected to carry individual greens — and reporting them as unproven trunk states would be a false
 * statement dressed as a measurement. An explicit range still works from anywhere.
 */
export function defaultAuditRange(cwd = process.cwd()) {
  if (tryGit(["branch", "--show-current"], cwd) !== "main") return null;
  return tryGit(["rev-parse", "--verify", "origin/main"], cwd) ? "origin/main..HEAD" : null;
}

export function auditTrunk({ cwd = process.cwd(), range = defaultAuditRange(cwd) } = {}) {
  if (!range) return { available: false, reason: "not on main, or no origin/main to compare against" };
  const raw = tryGit(["log", "--first-parent", "--format=%H %T %P", range], cwd);
  if (raw === null) return { available: false, reason: `cannot resolve range '${range}'` };
  const subject = (commit) => tryGit(["log", "-1", "--format=%s", commit], cwd) ?? "";
  const commits = raw.split("\n").filter(Boolean).map((line) => {
    const [commit, tree, ...parents] = line.trim().split(/\s+/);
    const record = readRecord(tree, cwd);
    const merge = parents.length > 1;
    return {
      commit, tree, merge,
      // Content no branch gate could have covered: a merge whose tree matches neither parent's.
      newContent: merge && !parents.map((p) => treeOf(p, cwd)).includes(tree),
      recorded: Boolean(record),
      at: record?.at ?? null,
      subject: record ? "" : subject(commit),
    };
  });
  const unverified = commits.filter((c) => !c.recorded);
  return {
    available: true,
    range,
    commits,
    unverified,
    // The task's class, isolated: merged content that nothing has ever verified.
    unprovenMerges: unverified.filter((c) => c.newContent),
  };
}

/**
 * One block, or one line when there is nothing wrong. Returns null only when the audit could not run
 * — silence is reserved for "no answer", never for "the answer was bad".
 *
 * The clean case still prints. A warning that only ever appears when something is wrong cannot be
 * distinguished from a warning that is broken, and this one runs beside a gate whose whole job is to
 * be believed.
 */
export function formatTrunkAudit(audit, { limit = 10 } = {}) {
  if (!audit?.available) return null;
  const { commits, unverified, unprovenMerges, range } = audit;
  if (!commits.length) return `trunk audit: nothing in ${range} — this checkout adds no trunk state`;
  if (!unverified.length) return `trunk audit: all ${commits.length} trunk state(s) in ${range} have a green record`;
  const lines = [
    `trunk audit: ${unverified.length} of ${commits.length} trunk state(s) in ${range} have NO green record`
      + (unprovenMerges.length ? `, ${unprovenMerges.length} of them merged content nothing has verified` : ""),
  ];
  for (const c of unverified.slice(0, limit)) {
    const kind = c.newContent ? "merge, new content" : c.merge ? "merge, parent's content" : "direct commit";
    lines.push(`  ${c.commit.slice(0, 8)} [${kind}] ${c.subject.slice(0, 72)}`);
  }
  if (unverified.length > limit) lines.push(`  … ${unverified.length - limit} more`);
  lines.push("  advisory — nothing was blocked; `node scripts/verify-record.mjs audit` exits 1 on this");
  return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// `verify-record check [<commit-ish>]` — exit 0 when that commit's CONTENT has a green record.
// `verify-record audit [<range>]`      — exit 0 when every trunk state in the range has one.
// Anything unresolvable exits non-zero: "cannot tell" is not "verified".

function main(argv) {
  const [mode, arg] = argv;
  if (mode === "audit") {
    const audit = auditTrunk(arg ? { range: arg } : {});
    const text = formatTrunkAudit(audit);
    if (!text) {
      process.stderr.write(`verify-record: cannot audit — ${audit.reason}\n`);
      return 2;
    }
    process.stdout.write(`${text}\n`);
    return audit.unverified.length ? 1 : 0;
  }
  if (mode !== "check") {
    process.stderr.write("usage: verify-record check [<commit-ish>]   (default: HEAD)\n"
      + "       verify-record audit [<range>]        (default: origin/main..HEAD)\n");
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
