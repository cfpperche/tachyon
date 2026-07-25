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
import { execFileSync } from "node:child_process";

const DIR_NAME = "tachyon-verify";
/** Records are ~300 bytes; this only stops unbounded growth over a long-lived clone. */
const KEEP = 50;

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
export function recordVerification({ cwd = process.cwd(), command, summary, now = () => new Date() } = {}) {
  const tree = verifiableTree(cwd);
  if (!tree) return { recorded: false, reason: "working tree is dirty or not a git repo — no commit can claim this run" };
  let commit = null;
  try { commit = git(["rev-parse", "HEAD"], cwd); } catch { /* detached/empty repo — the tree still identifies it */ }

  const dir = recordDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    schema: 1,
    tree,
    commit,
    at: now().toISOString(),
    ...(command ? { command } : {}),
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
    return rec && rec.schema === 1 && rec.tree === tree ? rec : undefined;
  } catch {
    return undefined;
  }
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
