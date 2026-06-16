# 223 — tachyon-worktree-pr

_Created 2026-06-16._

**Status:** SHIPPED v0.20.0 (2026-06-16). codex dueto 6 rounds (3+2+2 MAJOR, 2 MINOR, 1 MAJOR → SHIP),
494 tests + typecheck green. **Closure:** one-click human-triggered "Create PR" on a worktree agent,
verify verdict in the body, base ONLY from the persisted create-time branch (never guessed).

**UI impact:** ui (a "Create PR" inline action on a worktree agent + a confirm dialog).

## Intent

Close the last mile of the worktree loop (isolate→review→verify→**ship**): a **one-click, human-
triggered** "Create PR" on a worktree agent that opens a GitHub PR from the worktree's branch, with the
**verify verdict carried into the PR body** — using metadata Tachyon already has (branch, baseRef,
verify state). NOT auto-on-green; the human stays at the publish gate.

## Decisions (maintainer-confirmed 2026-06-16)
- **D1 — trigger:** an inline "Create PR" action on a worktree agent (human clicks). Never fires on its
  own.
- **D2 — human gate:** before calling `gh`, show the composed **title + body in a confirm** (title
  editable) — PR creation is outward-facing/irreversible, so the human reviews then confirms.
- **D3 — availability:** the action is shown for any worktree agent; the real readiness (origin is
  GitHub + `gh` present + authed) is checked **at click time** (NOT per tree-refresh — the spec-221
  perf lesson: no `gh auth` spawn on every render), with a clear reason if not ready. Verify-green is
  NOT required — the verify state is reflected honestly in the body (✓ / ✗ / ⊘).
- **D4 — scope v1:** one PR at a time. No "PR all verified" batch (defer to v2 — feel the friction
  first). No Bridge MCP tool (no agent firing a PR) in v1.

## Design
- **`src/worktree/pr.ts`** — pure: `isGitHubRemote(url)`, `prReadiness(facts)` → `{ready, reason?}`,
  `composePrTitle(branch)`, `composePrBody({branch, baseRef, verify})`. Impure (injectable git/gh
  execs, like `GitExec`): `probePrReadiness(wt, git, gh)` (origin url + `gh --version` + `gh auth
  status`), `createWorktreePr(wt, {title, body}, git, gh)` → push `-u origin <branch>` then
  `gh pr create --base <baseRef> --head <branch> --title --body`; parse the PR URL; on "already exists"
  → `gh pr view --json url` and return the existing URL instead of erroring.
- **Workspace** — a thin `createWorktreePr(agentName)` building block: read the worktree record from the
  ledger, pull verify state (`verifyInfo`), compose; returns the readiness/compose result for the
  command layer to confirm + execute.
- **extension.ts** — `tachyon.createWorktreePr` command: probe readiness (error toast w/ reason if not),
  show the confirm (editable title + body preview), create, notify with the URL + an "Open PR" action.
- **Sidebar/package.json** — inline action gated on `viewItem =~ /-worktree/` (icon git-pull-request);
  no new contextValue, no per-refresh probe.

## Non-goals
- No auto-on-green (D1). No batch (D4). No Bridge tool (D4). No PR templates / labels / reviewers in v1
  (gh's own defaults + the verify line). Not a replacement for the C2 diff-review (complementary).

## Acceptance
- A worktree agent with a GitHub origin + authed `gh`: "Create PR" → confirm (title editable, body
  shows the verify verdict) → PR opened, URL surfaced, "Open PR" works. A second click on the same
  branch surfaces the EXISTING PR's URL (no error).
- Non-GitHub origin / no `gh` / not authed / not a worktree → a clear reason toast, no PR attempt.
- `pr.ts` pure fns unit-tested (readiness matrix, github-url detection, body with ✓/✗/⊘ verify); the
  create flow tested behind fake git/gh execs (push+create, already-exists path). Suite + typecheck +
  i18n green.
- codex dueto → SHIP; ship 0.20.0.
