# 305 — codex-activity-runtime — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
## 2026-06-30 - implementation notes

- Added `resolveCodexSession(cwd, env, id?)` so Activity can resolve the Codex rollout path directly. `resolveCodexId()` now wraps it for existing callers.
- `AgentManager.transcriptPathOf()` now supports Codex with the same attribution policy as Claude: live ownership rows win when their transcript exists; stored ids are safe; bare newest-by-cwd is only allowed when the cwd/config-home namespace is not shared.
- `ActivityLogWriter` now uses a runtime-specific normalizer. Unknown runtime keys use a no-op normalizer instead of silently falling back to Claude.
- `codexNormalizer.ts` maps the current Codex rollout records observed locally: `response_item` messages, reasoning summaries, function calls/results, tool-search, web-search, MCP completion, `event_msg` user/agent messages, errors, and token counts. Unknown/malformed records are dropped, not persisted as raw rows.

## Claude probe fold

Probe `probe-4610aa1c-0f26-4387-842f-e3190c483c75` returned `SHIP-WITH-CHANGES`-style findings. Folded items:

- Ambiguous Codex sessions: preserved the no-guess shared-cwd policy and added tests for ownership-first shared cwd and no-ownership gap.
- Non-live Codex path: added stored-id path resolution test for `transcriptPathOf("codex")`.
- Registry fallback: changed unknown runtime handling from implicit Claude fallback to no-op and added a regression test.
- Codex tool coverage: dogfood scanned a real local rollout and found `tool_search_*`, `web_search_*`, and `mcp_tool_call_end`; these are now mapped.
- Fixture-only risk: added `scripts/dogfood-codex-activity.mjs`, which runs the Codex Activity integration and validates a real local Codex rollout schema proof under `CODEX_HOME` / `~/.codex`.

Residual accepted boundary: a stale ownership row whose transcript still exists remains authoritative until the SessionStart hook writes the newer Codex row. That matches the existing positive-attribution model; Tachyon should prefer an owned row over a newest-by-cwd guess.

## 2026-06-30 - manual dogfood follow-up

Manual VSIX dogfood of `0.54.6` showed the Activity panel stuck at `history unavailable — agent shares this folder with no distinct session` for the running `codex` agent. Local state confirmed the root cause: the existing `.tachyon/sessions.json` row had `resume.runtime:"codex"`, `sessionId:""`, but `configHome:"/home/goat/.claude"`. Since `claude` shared the same cwd and `.claude` config home, the shared-cwd guard correctly refused newest-by-cwd attribution before Codex resolution.

Fold: `AgentManager` now treats a known default home for the wrong runtime as stale compatibility data, rehydrates Codex rows from `~/.claude` to `~/.codex`, and `effectiveHome()` ignores that invalid persisted value even before rewrite. Regression test: `spec 305 follow-up: legacy Codex rows stamped with ~/.claude are re-homed to ~/.codex for Activity`.

## Dogfood log

### 2026-07-01T00:25:12Z — pass (1/1) — source: tasks.md — commit: d3d14c9d2c202bdb6a225a810bd5cc77a9f8ba70
- `node scripts/dogfood-codex-activity.mjs` — pass

## Verification log

### 2026-07-01T00:25:12Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/codexNormalizer.test.ts test/unit/activityLog.integration.test.ts && npm run typecheck` — pass
