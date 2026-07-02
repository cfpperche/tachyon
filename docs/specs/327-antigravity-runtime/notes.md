# 327 — antigravity-runtime — notes

_Created 2026-07-02._

## Design decisions

- 2026-07-02: Web/local confirmation: Google moved the consumer Gemini CLI path to Antigravity CLI;
  local `agy 1.0.10 --help` exposes `--conversation`, `--continue`, `--prompt-interactive`,
  `--print`, `--model`, and `--sandbox`, but no `--session-id` or `--resume`. Adapter therefore uses
  capture/continue semantics, not Gemini's mint-runtime behavior.
- 2026-07-02: Antigravity local state observed under `~/.gemini/antigravity-cli/`; the stable-enough
  v1 resume source is `cache/last_conversations.json` mapping cwd to conversation id. Full SQLite
  conversation parsing remains out of scope.
- 2026-07-02: Bridge/MCP injection deliberately deferred. Current `agy --help` lacks a
  per-invocation MCP config override, and writing shared `~/.gemini/config/mcp_config.json` at spawn
  would be security-significant.

## Deviations

- 2026-07-02: Initial dogfood command referenced `./out/resume/adapters.js`, but this repo typechecks
  with `tsc --noEmit` and builds bundles under `dist/`; corrected dogfood to a focused Vitest command.

## Verification log

- 2026-07-02: PASS `npm test -- --run test/unit/resume.test.ts test/unit/config.test.ts test/unit/agentStudio.test.ts`
  — 3 files, 150 tests.
- 2026-07-02: PASS `npm run typecheck`.
- 2026-07-02: PASS `npm run build`.

## Dogfood log

- 2026-07-02: FAIL `node -e "import('./out/resume/adapters.js')..."`
  — invalid project assumption; `out/` is not emitted in this repo.
- 2026-07-02: PASS `npm test -- --run test/unit/resume.test.ts -t antigravity`
  — 2 Antigravity-focused tests passed.

### 2026-07-02T17:49:14Z — pass (1/1) — source: tasks.md — commit: fcb09881c5f36548a9eb349367a6736861166800
- `npm test -- --run test/unit/resume.test.ts -t antigravity` — pass
