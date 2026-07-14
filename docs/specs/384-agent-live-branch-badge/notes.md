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
