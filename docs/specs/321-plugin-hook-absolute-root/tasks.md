# 321 — plugin-hook-absolute-root — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `src/plugins/paths.ts`: add `isSafeAbsolutePluginRoot(raw)` — absolute, no `..`, same no-whitespace/no-shell-metacharacter class as `isSafePluginRoot`.
- [x] `src/plugins/adapters/hooks.ts`: add `FAIL_CLOSED_HOOK_EVENTS` (= `{PreToolUse}`); `mergeHooks` validates the root with the new absolute validator (new error text); placeholder-using commands render through the gate/observational wrapper around the resolved command; placeholder-free commands stay verbatim; header comment gains the spec-321 note.
- [x] `src/plugins/engine.ts:899`: pass `path.join(workspaceRoot, rootRel)` into `mergeHooks`.
- [x] Update `test/unit/pluginClaudeAdapter.test.ts`, `test/unit/pluginCodexAdapter.test.ts`, `test/unit/pluginEngine.test.ts` expectations to the absolute-root wrapped forms.

## Verification

- [x] Rendered PreToolUse command embeds the absolute root, dir-check → exit 2, 127 remap → exit 2, `exit "$rc"` passthrough (maps to the three gate scenarios).
- [x] Rendered observational command embeds the absolute root, dir-check → exit 0, no rc remap (maps to the fail-open scenario).
- [x] Placeholder-free command written verbatim.
- [x] Relative root and absolute-with-whitespace/metacharacter root both fail the merge closed.
- [x] Idempotent re-apply + uninstall round-trip + codex `statusMessage` preservation still pass.
- [x] Behavioral sh check: the generated gate wrapper actually blocks (exit 2) with the root dir removed and passes through inner exit codes with it present (unit test executes the rendered string via `sh -c`).
- [x] Full unit suite + typecheck green.

**Headless check:** `env -u TMUX npx vitest run test/unit/pluginClaudeAdapter.test.ts test/unit/pluginCodexAdapter.test.ts test/unit/pluginEngine.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

**Verify:** `env -u TMUX npx vitest run test/unit/pluginClaudeAdapter.test.ts test/unit/pluginCodexAdapter.test.ts test/unit/pluginEngine.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

## Dogfood

**Dogfood:** `env -u TMUX npx vitest run test/unit/pluginEngine.test.ts -t "hook"`

**Human dogfood:** In the Plugins view, re-apply/re-install secrets-guard so this workspace's `.claude/settings.json` + `.codex/hooks.json` pick up the new absolute wrapped command (expect a consent re-prompt — the command text changed). Then in a claude agent: `cd .tachyon/activity`, run any Bash command, and confirm the guard still executes (no `hook_non_blocking_error` 127 in the transcript); optionally remove the plugin dir and confirm Bash is BLOCKED with the `[tachyon]` fail-closed message instead of passing silently.
