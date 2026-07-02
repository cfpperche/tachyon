# 321 — plugin-hook-absolute-root — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T01:01:40Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/pluginClaudeAdapter.test.ts test/unit/pluginCodexAdapter.test.ts test/unit/pluginEngine.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-02T01:01:46Z — pass (1/1) — source: tasks.md — commit: df76ab846d6d57ca30b794a174adfdb560d96fc7
- `env -u TMUX npx vitest run test/unit/pluginEngine.test.ts -t "hook"` — pass

## Human dogfood log

### 2026-07-01 — pass (maintainer, tachyon-0.54.33 + secrets-guard reinstalled)
Maintainer installed the 0.54.33 VSIX and re-installed secrets-guard (Remove + re-add — "Check" correctly
reported the PLUGIN up-to-date at v2.0.2, since the fix is engine-side rendering, not plugin content). Both
materialized files now carry the wrapped absolute command (`.claude/settings.json` + `.codex/hooks.json`
verified). Live evidence chain in the running claude session:
1. A Bash call whose PreToolUse hook executed FROM `.tachyon/activity` (the exact cwd that triggered the
   original silent 127s) produced NO `hook_non_blocking_error` — cwd-independence proven.
2. A compound `git add … && git commit` was BLOCKED by the guard with its own message, the error banner
   showing the NEW wrapped absolute command — enforcement active, running session picked up the new config.
   (It then blocked the very commit attempt recording this log — twice-proven.)
Last 127s in the transcript remain the original bug window (2026-07-02T00:12-00:13Z); none since.
