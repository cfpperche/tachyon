/**
 * Verify-gate (spec 214 / C3) — pure helpers. A worktree's work is "shippable" only after a
 * declared check (lint/test/build) exits 0 IN the worktree. This module owns the pure parts:
 * the persisted verify-state shape, the effective-verify resolution (per-agent > global), the
 * stale computation, the badge mapping, and the stack→suggestion list the Agent Studio offers
 * (the human always has the final word). The side-effecting run lives in Workspace.runVerify
 * (reusing RunbookRunner with a worktree cwd); the badge lives in the Sidebar; the validated
 * handoff lives in the MCP bridge. Unit-tested with no git, no runner.
 */

import type { TachyonConfig, AgentDef } from "../config/loadConfig.js";

/** Recorded outcome of the last verify run, keyed to the commit it ran against. */
export interface VerifyState {
  /** the verify string that ran (command/runbook name or inline) — for the tooltip */
  command: string;
  /** the gate exited 0 */
  passed: boolean;
  /** worktree HEAD sha at run time — staleness is measured against this */
  atCommit: string;
  /** ISO timestamp of the run */
  ranAt: string;
}

/** Badge state surfaced on a worktree agent (only when a verify is declared). */
export type VerifyBadge = "verified" | "failing" | "stale";

/**
 * The verify gate that applies to an agent: per-agent `verify:` wins over the global
 * `settings.worktree.verify` (OQ1 → both, per-agent wins). undefined → no gate, no badge.
 */
export function effectiveVerify(
  agentDef: Pick<AgentDef, "verify">,
  settings: TachyonConfig["settings"],
): string | undefined {
  const a = agentDef.verify?.trim();
  if (a) return a;
  const g = settings.worktree?.verify?.trim();
  return g && g.length > 0 ? g : undefined;
}

/**
 * A recorded verdict is stale when the worktree moved past the verified commit: HEAD advanced
 * (more commits) OR the working tree is dirty now (uncommitted changes since). Verify proves a
 * *commit* shippable; once work moves on, the badge reads ⊘ (re-verify is one click). No state
 * (never run) is also "stale" — there's no green to trust yet.
 */
export function verifyStale(state: VerifyState | undefined, headRef: string, dirty: boolean): boolean {
  if (!state) return true;
  if (!state.atCommit || state.atCommit !== headRef) return true;
  return dirty;
}

/**
 * Map state + staleness to a badge. Callers compute this ONLY for worktree agents with a
 * declared verify (opt-in): never run → `stale` (⊘ not verified); fresh → `verified`/`failing`.
 */
export function verifyBadge(state: VerifyState | undefined, stale: boolean): VerifyBadge {
  if (!state || stale) return "stale";
  return state.passed ? "verified" : "failing";
}

/**
 * Stack-derived verify candidates the Studio offers as pick-or-edit chips — the human always
 * has the final word. Returns inline command strings, most-likely-first, deduped. Degrades to
 * `[]` (human types their own) when the stack is unknown or nothing is detected. The Studio
 * lists already-declared command/runbook NAMES separately; this is the stack-guess lane.
 *
 * `stackLabel` is the `detectStack` label ("Node.js", "Node.js (Next.js)", "Rust", "Go",
 * "Python", "PHP", "PHP (Laravel)", "Ruby", "Ruby (Rails)", "generic"). `pkgScripts` is the
 * Node package.json `scripts` map (names only matter).
 */
export function suggestVerify(stackLabel: string, pkgScripts: Record<string, string> = {}): string[] {
  const label = stackLabel.toLowerCase();

  if (label.startsWith("node")) {
    // Real package.json scripts, in verify-likelihood order. `test` is the canonical `npm test`;
    // the rest are `npm run <name>`. Only scripts that actually exist are offered.
    const order = ["test", "lint", "typecheck", "check", "build", "ci", "verify"];
    const present = order.filter((s) => typeof pkgScripts[s] === "string" && pkgScripts[s].trim().length > 0);
    return dedupe(present.map((s) => (s === "test" ? "npm test" : `npm run ${s}`)));
  }
  if (label.startsWith("rust")) {
    return ["cargo test", "cargo clippy -- -D warnings", "cargo check"];
  }
  if (label.startsWith("go")) {
    return ["go test ./...", "go vet ./..."];
  }
  if (label.startsWith("python")) {
    return ["pytest", "python -m pytest", "ruff check ."];
  }
  if (label.startsWith("php")) {
    return label.includes("laravel") ? ["php artisan test", "vendor/bin/phpunit"] : ["vendor/bin/phpunit"];
  }
  if (label.startsWith("ruby")) {
    return label.includes("rails") ? ["bin/rails test", "bundle exec rspec"] : ["bundle exec rspec", "rake test"];
  }
  return [];
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Resolve a verify string to the step list the runner executes — exactly the runbook-step
 * semantics: a declared RUNBOOK name → its steps; otherwise a single step `[verify]` (which
 * RunbookRunner.resolveStep turns into a declared command's cmd, or runs as inline shell). Pure
 * so the run-vs-command-vs-inline branch is unit-tested without the runner.
 */
export function verifySteps(verify: string, runbooks: Record<string, { steps: string[] }>): string[] {
  return runbooks[verify]?.steps ?? [verify];
}
