/**
 * t-5e9bf8 — read the per-tree verification record that `scripts/verify-full.mjs` writes.
 *
 * Why the host can read a record an AGENT's worktree produced: the record directory resolves through
 * `git rev-parse --git-common-dir`, which is SHARED by every worktree of a repository. The gate runs
 * in the agent's own checkout and files the record under the common dir; the host, running in the
 * primary checkout, reads the same file. Without that property this whole signal would be invisible
 * to the host and the feature would need a second channel.
 *
 * This is a READER only. It never writes, never prunes, and never decides environment-relative reuse
 * — `verify-record.mjs` still owns fingerprint equality (t-5d0e9d). It does enforce the shared,
 * environment-independent validity contract before returning a record: schema 2, a present
 * fingerprint, and a usable timestamp from no more than seven days ago and no later than now.
 *
 * ASYNC git, deliberately. A first cut shelled out synchronously and the wedge invariant in
 * `cxWedgeBehavior.gen.test.ts` caught it, correctly: this runs on the workspace's 3s tick inside the
 * extension host, which is exactly where a blocking subprocess wedges the UI. It takes the same
 * injected `GitExec` the worktree layer already uses, so it also needs no real repository to test.
 *
 * Fail-closed everywhere. A missing record, an unreadable one, a record whose `tree` disagrees with
 * its own filename, an unparseable/stale/future timestamp, an unattributable schema, or any git
 * failure all answer `false`. "Cannot tell" is never "verified" — which matters more here than in
 * `check`, because this answer arms an automatic message to a coordinator or a land command.
 */
import fs from "node:fs";
import path from "node:path";
import type { GitExec } from "../worktree/WorktreeManager.js";
import validityContract from "../../scripts/verify-record-validity.cjs";

const { verificationRecordValidity } = validityContract;

/** Must match `DIR_NAME` in `scripts/verify-record.mjs`, which owns the record layout. */
const RECORD_DIR_NAME = "tachyon-verify";

export interface VerificationRecord {
  tree: string;
  commit?: string | null;
  at: string;
  fingerprint: string;
  command?: string;
  summary?: string;
}

async function gitLine(git: GitExec, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const result = await git(args, cwd);
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The record for the tree of `commitish` in `worktreePath`, or undefined. */
export async function readVerificationRecord(
  worktreePath: string,
  commitish: string,
  git: GitExec,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
  now: () => number = () => Date.now(),
): Promise<VerificationRecord | undefined> {
  const tree = await gitLine(git, ["rev-parse", `${commitish}^{tree}`], worktreePath);
  if (!tree || !/^[0-9a-f]{40}$/.test(tree)) return undefined;
  const common = await gitLine(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath);
  if (!common) return undefined;
  try {
    const record = JSON.parse(readFile(path.join(common, RECORD_DIR_NAME, `${tree}.json`))) as
      Partial<VerificationRecord> & { schema?: number };
    // A record that does not name the tree it is filed under proves nothing about that tree.
    if (!record || record.tree !== tree || typeof record.at !== "string") return undefined;
    const validity = verificationRecordValidity(record, { now });
    if (!validity.valid) return undefined;
    return {
      tree,
      commit: record.commit ?? null,
      at: record.at,
      fingerprint: record.fingerprint as string,
      ...(record.command ? { command: record.command } : {}),
      ...(record.summary ? { summary: record.summary } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Whether the tree at `commitish` is recorded as verified at or after `sinceIso`.
 *
 * The `since` comparison is what keeps an OLD green from standing in as evidence for a task assigned
 * later: a persistent agent's HEAD may already have been verified days ago for entirely different
 * work, and that says nothing about the task it was handed this morning.
 */
export async function isVerifiedSince(
  worktreePath: string,
  commitish: string,
  sinceIso: string,
  git: GitExec,
  readFile?: (file: string) => string,
  now?: () => number,
): Promise<boolean> {
  const record = await readVerificationRecord(worktreePath, commitish, git, readFile, now);
  if (!record) return false;
  const at = Date.parse(record.at);
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(at) || !Number.isFinite(since)) return false;
  return at >= since;
}
