# 384 — notes

## Decisions (locked with maintainer)

- Live HEAD badge on every agent row
- Always **first** badge in the list
- Shared cwd: quiet badge, no worktree actions
- Isolated: green `--ds-ok` chip (prototype-like soft fill)
- Drift: `⚠` + tooltip; chip stays green (not full-warn yellow)
- v1: no VS Code status bar, no folder identity branch chip
- Agent-block vertical rhythm + hairlines between top-level agents
- Work in isolated git worktree: `grok/t-c64647-agent-live-branch`

## Worktree

- Path: `/home/goat/tachyon-worktrees/t-c64647-agent-live-branch`
- Branch: `grok/t-c64647-agent-live-branch`
- Base: `76806196` (main)

## Verification log

- 2026-07-14 — `vitest` subset (agentModel, liveBranch badge/dogfood, sidebarRowAlignment, sidebarActions) → 79 passed
- 2026-07-14 — `tsc --noEmit` + `tsc -p tsconfig.webview.json --noEmit` exit 0
- 2026-07-14 — headless EDH S1 via lane → PASS
- 2026-07-14 — maintainer EDH dogfood: green chip OK; spacing refinement OK; **approved to land**

## Dogfood log

- Real git: `test/unit/agentLiveBranch.dogfood.test.ts` (shared / aligned / drift / detached)
- Preview SAMPLE: `evidence/sidebar-sample-live-branch.png`, `evidence/sidebar-ux-after.png`
- Headless EDH S1: `evidence/edh-fail-visible.png`
- Human EDH: fixture `live-branch-384`; see `DOGFOOD.md`

## Visual QA

- Evidence: `evidence/sidebar-ux-after.png`, `evidence/sidebar-sample-live-branch.png`
- Verdict: first-badge order, green isolated chip, shared quiet, drift ⚠, agent-block hairlines; no status bar changes
