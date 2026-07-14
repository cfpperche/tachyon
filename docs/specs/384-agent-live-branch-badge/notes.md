# 384 — notes

## Decisions (locked with maintainer)

- Live HEAD badge on every agent row
- Always **first** badge in the list
- Shared cwd: quiet badge, no worktree actions
- Drift: warn when live ≠ config/ledger branch
- v1: no VS Code status bar, no folder identity branch chip
- Work in isolated git worktree: `grok/t-c64647-agent-live-branch`

## Worktree

- Path: `/home/goat/tachyon-worktrees/t-c64647-agent-live-branch`
- Branch: `grok/t-c64647-agent-live-branch`
- Base: `76806196` (main)

## Verification log

- 2026-07-14 — `./node_modules/.bin/vitest run test/unit/agentModel.test.ts test/unit/agentLiveBranchBadge.test.ts test/unit/sidebarActions.test.ts` → 74 passed
- 2026-07-14 — `./node_modules/.bin/tsc --noEmit` exit 0
- 2026-07-14 — `./node_modules/.bin/tsc -p tsconfig.webview.json --noEmit` exit 0

## Dogfood log

- 2026-07-14 — **real git** `vitest run test/unit/agentLiveBranch.dogfood.test.ts` → PASS (shared main, worktree aligned, checkout drift, detached omit)
- 2026-07-14 — **webview preview** `?view=sidebar&fixture=default` after `npm run build` → screenshot `evidence/sidebar-sample-live-branch.png`
  - Verdict: branch badge is first on every row; shared `⎇ main` quiet; isolated green; `feature-billing` shows `⎇ feat/billing-wip ⚠` drift before other badges
- 2026-07-14 — **headless EDH S1** via `lane.mjs run --owner grok --target worktree -- npm run dogfood:dev-host -- headless` → PASS (SHA 8f3ab5b1); roster pilot/reviewer; evidence `evidence/edh-fail-visible.png`

## Visual QA

- Evidence: `docs/specs/384-agent-live-branch-badge/evidence/sidebar-sample-live-branch.png`
- Verdict: first-badge order and drift/shared tones match the locked UX; no status bar changes (v1 non-goal)
