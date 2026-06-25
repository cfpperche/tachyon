/**
 * spec 264 — worktree-correct git introspection + `core.hooksPath` management for the git-hook target.
 *
 * Every path is resolved through Git itself (`git rev-parse --git-path/--git-common-dir/--show-toplevel`) so
 * the hook + config locations are correct for a LINKED WORKTREE (where `.git` is a file, hooks live in the
 * common dir, and the config scope may differ) — never a hardcoded `.git/hooks`. Built on the injectable
 * `GitRun` (argv array, no shell) shared with the fetcher, so it is testable without mocking child_process.
 *
 * `core.hooksPath` is single-owner, so this layer REFUSES to touch it when `extensions.worktreeConfig` is
 * enabled (the scope is then ambiguous): the engine surfaces that as a clear error instead of guessing.
 */

import path from "node:path";
import { defaultGitRun, type GitRun, type GitRunResult } from "./fetcher.js";

/** Raised for an unexpected git failure (a real error, not an "unset config" code-1). */
export class GitRepoError extends Error {}

export interface HooksPathValue {
  /** the value exactly as stored in git config (may be relative). */
  raw: string;
  /** absolute, resolved the way Git resolves a relative `core.hooksPath` — against the working-tree top level. */
  resolved: string;
}

export class GitRepo {
  constructor(
    private readonly cwd: string,
    private readonly git: GitRun = defaultGitRun,
  ) {}

  private async run(args: string[]): Promise<GitRunResult> {
    return this.git(args, this.cwd);
  }

  /** Run git, throwing GitRepoError on any non-zero exit (use for commands that must succeed). */
  private async runOk(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) throw new GitRepoError(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim();
  }

  /** True iff cwd is inside a git work tree (a non-throwing probe). */
  async isWorkTree(): Promise<boolean> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /** Throw a clear error if cwd is not a git work tree. */
  async assertWorkTree(): Promise<void> {
    if (!(await this.isWorkTree())) throw new GitRepoError(`${this.cwd} is not a git work tree`);
  }

  /** Absolute work-tree top level (`git rev-parse --show-toplevel`). */
  async topLevel(): Promise<string> {
    return path.resolve(this.cwd, await this.runOk(["rev-parse", "--show-toplevel"]));
  }

  /** Absolute shared `.git` common dir (`--git-common-dir`) — where a linked worktree's hooks actually live. */
  async commonDir(): Promise<string> {
    return path.resolve(this.cwd, await this.runOk(["rev-parse", "--git-common-dir"]));
  }

  /** Absolute path to `hooks/<event>` resolved by Git (worktree-correct), e.g. the common dir's `hooks/`. */
  async hookPath(event: string): Promise<string> {
    return path.resolve(this.cwd, await this.runOk(["rev-parse", "--git-path", `hooks/${event}`]));
  }

  /** Whether per-worktree config is enabled — when true, `core.hooksPath` scope is ambiguous and we refuse. */
  async worktreeConfigEnabled(): Promise<boolean> {
    const r = await this.run(["config", "--bool", "--get", "extensions.worktreeConfig"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /** The current `core.hooksPath` (raw + resolved), or undefined when unset. */
  async getHooksPath(): Promise<HooksPathValue | undefined> {
    const r = await this.run(["config", "--get", "core.hooksPath"]);
    if (r.code !== 0) return undefined; // unset → git exits non-zero
    const raw = r.stdout.trim();
    if (raw.length === 0) return undefined;
    const top = await this.topLevel();
    return { raw, resolved: path.isAbsolute(raw) ? raw : path.resolve(top, raw) };
  }

  /** Set `core.hooksPath` at the local repo scope. Refuses when per-worktree config is enabled. */
  async setHooksPath(value: string): Promise<void> {
    await this.assertNotWorktreeConfig();
    await this.runOk(["config", "core.hooksPath", value]);
  }

  /** Unset `core.hooksPath`. Refuses when per-worktree config is enabled. `--unset` on an already-unset key
   *  exits 5; treat that as a no-op. */
  async unsetHooksPath(): Promise<void> {
    await this.assertNotWorktreeConfig();
    const r = await this.run(["config", "--unset", "core.hooksPath"]);
    if (r.code !== 0 && r.code !== 5) throw new GitRepoError(`git config --unset core.hooksPath failed (${r.code}): ${r.stderr.trim()}`);
  }

  private async assertNotWorktreeConfig(): Promise<void> {
    if (await this.worktreeConfigEnabled()) {
      throw new GitRepoError("extensions.worktreeConfig is enabled — core.hooksPath scope is ambiguous; Tachyon refuses to manage git hooks here");
    }
  }
}
