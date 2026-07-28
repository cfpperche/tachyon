/**
 * t-5e9bf8 — read the per-tree verification record that `scripts/verify-full.mjs` writes.
 *
 * Why the host can read a record an AGENT's worktree produced: the record directory resolves through
 * `git rev-parse --git-common-dir`, which is SHARED by every worktree of a repository. The gate runs
 * in the agent's own checkout and files the record under the common dir; the host, running in the
 * primary checkout, reads the same file. Without that property this whole signal would be invisible
 * to the host and the feature would need a second channel.
 *
 * This is a READER only. It never writes, never prunes, and never decides reuse — `verify-record.mjs`
 * owns all of that (t-5d0e9d). It answers exactly one question: is the tree at this commit recorded
 * as verified, at or after a given moment?
 *
 * Fail-closed everywhere. A missing record, an unreadable one, a record whose `tree` disagrees with
 * its own filename, an unparseable timestamp, or any git failure all answer `false`. "Cannot tell" is
 * never "verified" — which matters more here than in `check`, because this answer arms an automatic
 * message to a coordinator.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Must match `DIR_NAME` in `scripts/verify-record.mjs`, which owns the record layout. */
const RECORD_DIR_NAME = "tachyon-verify";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args as string[], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export interface VerificationRecord {
  tree: string;
  commit?: string | null;
  at: string;
  command?: string;
  summary?: string;
}

/** The record for the tree of `commitish` in `worktreePath`, or undefined. */
export function readVerificationRecord(worktreePath: string, commitish: string): VerificationRecord | undefined {
  try {
    const tree = git(["rev-parse", `${commitish}^{tree}`], worktreePath);
    if (!/^[0-9a-f]{40}$/.test(tree)) return undefined;
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreePath);
    const raw = fs.readFileSync(path.join(common, RECORD_DIR_NAME, `${tree}.json`), "utf8");
    const record = JSON.parse(raw) as Partial<VerificationRecord> & { schema?: number };
    // A record that does not name the tree it is filed under proves nothing about that tree.
    if (!record || record.tree !== tree || typeof record.at !== "string") return undefined;
    if (record.schema !== 1 && record.schema !== 2) return undefined;
    return { tree, commit: record.commit ?? null, at: record.at, ...(record.command ? { command: record.command } : {}), ...(record.summary ? { summary: record.summary } : {}) };
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
export function isVerifiedSince(worktreePath: string, commitish: string, sinceIso: string): boolean {
  const record = readVerificationRecord(worktreePath, commitish);
  if (!record) return false;
  const at = Date.parse(record.at);
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(at) || !Number.isFinite(since)) return false;
  return at >= since;
}
