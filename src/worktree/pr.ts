/**
 * spec 223 — open a GitHub PR from a worktree agent's branch, carrying the verify verdict into the
 * body. Mirrors src/resume & WorktreeManager: PURE helpers (readiness decision, github-url detection,
 * title/body composition) here, with the git/gh process calls behind an injectable `CliExec` seam so
 * tests never touch the network. The human stays at the publish gate (the command layer confirms
 * before calling this). No `--base`: baseRef is a fork-point SHA, not a branch, so let `gh` default to
 * the repo's default branch — passing a SHA to `--base` would fail.
 */
import { execFile } from "node:child_process";
import { defaultGitExec, type GitExec } from "./WorktreeManager.js";
import type { VerifyBadge } from "./verify.js";

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a CLI in a cwd; resolves (never rejects) on non-zero so callers branch on `code`; rejects only when the binary can't spawn. */
export type CliExec = (cmd: string, args: string[], cwd: string) => Promise<CliResult>;

export function defaultCliExec(cmd: string, args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`${cmd} binary not found`));
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

/** A GitHub origin — ssh (`git@github.com:owner/repo`), https (`https://github.com/owner/repo`), or `ssh://`. */
export function isGitHubRemote(url: string): boolean {
  return /(^|@|\/\/)github\.com[:/]/i.test(url.trim());
}

export interface PrReadiness {
  ready: boolean;
  reason?: string;
}

/** Pure decision from probed facts — same order the human would hit the blockers. */
export function prReadiness(f: { inWorktree: boolean; remoteUrl: string | null; ghAvailable: boolean; ghAuthed: boolean }): PrReadiness {
  if (!f.inWorktree) return { ready: false, reason: "this agent is not running in a worktree" };
  if (!f.remoteUrl) return { ready: false, reason: "no git remote 'origin' in the worktree" };
  if (!isGitHubRemote(f.remoteUrl)) return { ready: false, reason: "origin is not a GitHub remote" };
  if (!f.ghAvailable) return { ready: false, reason: "the GitHub CLI 'gh' was not found on PATH" };
  if (!f.ghAuthed) return { ready: false, reason: "'gh' is not authenticated — run 'gh auth login'" };
  return { ready: true };
}

export interface VerifySummary {
  badge: VerifyBadge;
  command?: string;
}

/** Humanize the branch leaf into a PR title: `tachyon/fix-resume` → `Fix resume`. */
export function composePrTitle(branch: string): string {
  const leaf = branch.split("/").pop() ?? branch;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

/** PR body carrying the verify verdict (the headline value) + branch context + a Tachyon footer. Takes
 *  the resolved base BRANCH (not the fork-point SHA) so the line is true for both forked and attached
 *  branches — never claims a false "forked from <sha>" provenance (codex MINOR). */
export function composePrBody(opts: { branch: string; base?: string; verify?: VerifySummary }): string {
  const lines: string[] = [];
  const v = opts.verify;
  if (v?.badge === "verified") lines.push(`✓ **Verify passed**${v.command ? `: \`${v.command}\`` : ""}`);
  else if (v?.badge === "failing") lines.push(`✗ **Verify FAILED**${v.command ? `: \`${v.command}\`` : ""} — review before merge`);
  else if (v) lines.push(`⊘ **Not verified**${v.command ? ` (\`${v.command}\` is stale)` : ""}`);
  if (lines.length) lines.push("");
  lines.push(opts.base ? `Branch \`${opts.branch}\` → \`${opts.base}\`.` : `Branch \`${opts.branch}\`.`);
  lines.push("");
  lines.push("🤖 Opened from a Tachyon worktree.");
  return lines.join("\n");
}

/** origin url, or null when absent/unreadable. Cheap (one git call). */
export async function originUrl(cwd: string, git: GitExec = defaultGitExec): Promise<string | null> {
  const r = await git(["remote", "get-url", "origin"], cwd);
  const url = r.stdout.trim();
  return r.code === 0 && url ? url : null;
}

/** True when the worktree has uncommitted changes — those are NOT pushed, so the PR would silently
 * omit them (codex MAJOR). The caller warns the human in the confirm. */
export async function isWorktreeDirty(cwd: string, git: GitExec = defaultGitExec): Promise<boolean> {
  const r = await git(["status", "--porcelain"], cwd);
  // A failed status probe is unknown, not clean. Warn before either a PR or fork rather than silently
  // claiming its uncommitted work is absent.
  return r.code !== 0 || r.stdout.trim().length > 0;
}

/**
 * Probe full PR readiness (origin url + `gh` present + authed). Called at CLICK time, never per
 * tree-refresh (the spec-221 perf lesson — no `gh auth` spawn on every render). A missing `gh` binary
 * makes the exec reject → caught → ghAvailable:false.
 */
export async function probePrReadiness(cwd: string, inWorktree: boolean, git: GitExec = defaultGitExec, gh: CliExec = defaultCliExec): Promise<PrReadiness> {
  if (!inWorktree) return prReadiness({ inWorktree, remoteUrl: null, ghAvailable: false, ghAuthed: false });
  // Fully defensive: a stale/missing worktree cwd makes git reject (mislabeled "binary not found");
  // catch it here so the command shows a readiness reason instead of an unhandled throw (codex MINOR).
  let remoteUrl: string | null;
  try {
    remoteUrl = await originUrl(cwd, git);
  } catch {
    return { ready: false, reason: "the worktree path is unavailable (or git failed there)" };
  }
  let ghAvailable = false;
  let ghAuthed = false;
  try {
    const ver = await gh("gh", ["--version"], cwd);
    ghAvailable = ver.code === 0;
    if (ghAvailable) {
      const auth = await gh("gh", ["auth", "status"], cwd); // exit 0 = authed
      ghAuthed = auth.code === 0;
    }
  } catch {
    ghAvailable = false; // gh binary absent
  }
  return prReadiness({ inWorktree, remoteUrl, ghAvailable, ghAuthed });
}

export type CreatePrResult = { url: string; existing?: boolean } | { error: string };

const PR_URL_RE = /https:\/\/github\.com\/\S+\/pull\/\d+/;

/**
 * Push the branch and open (or find the already-existing) PR. No `--base` (let gh default to the
 * repo's default branch). git/gh injectable for tests; never touches the network in unit tests.
 */
export async function createWorktreePr(
  wt: { path: string; branch: string; baseRef: string },
  opts: { title: string; body: string; base?: string },
  git: GitExec = defaultGitExec,
  gh: CliExec = defaultCliExec,
): Promise<CreatePrResult> {
  // Fully-qualify the refspec (`refs/heads/X:refs/heads/X`) so a branch whose name starts with `+`
  // (e.g. a custom branch template) is NOT parsed as a force-push refspec (codex MAJOR).
  const refspec = `refs/heads/${wt.branch}:refs/heads/${wt.branch}`;
  const push = await git(["push", "-u", "origin", refspec], wt.path);
  if (push.code !== 0) return { error: `git push failed: ${push.stderr.trim() || push.stdout.trim() || `exit ${push.code}`}` };
  // --base only when we resolved a real base BRANCH (never a SHA); otherwise let gh default.
  const createArgs = ["pr", "create", "--head", wt.branch, "--title", opts.title, "--body", opts.body];
  if (opts.base) createArgs.push("--base", opts.base);
  const create = await gh("gh", createArgs, wt.path);
  if (create.code === 0) {
    const m = create.stdout.match(PR_URL_RE);
    return { url: m ? m[0] : create.stdout.trim() };
  }
  // a PR already exists for this branch → surface the existing one instead of erroring. Look it up by
  // `--head <branch>` (a branch FILTER), NOT `pr view <branch>` (a positional selector that would read
  // a numeric branch name like "123" as PR #123 — codex MINOR).
  if (/already exists|a pull request for branch/i.test(`${create.stderr}\n${create.stdout}`)) {
    const list = await gh("gh", ["pr", "list", "--head", wt.branch, "--state", "open", "--json", "url", "-q", ".[0].url"], wt.path);
    if (list.code === 0 && list.stdout.trim()) return { url: list.stdout.trim(), existing: true };
  }
  return { error: `gh pr create failed: ${create.stderr.trim() || create.stdout.trim() || `exit ${create.code}`}` };
}
