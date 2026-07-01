# 305 — codex-activity-runtime — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build the change in two layers: first make Codex's current rollout file resolvable, then add a Codex event
normalizer behind the existing durable Activity writer.

`resume/resolvers.ts` gains a path-returning Codex resolver. `resolveCodexId()` stays as a compatibility wrapper,
but callers that need the transcript can ask for `{ id, path }` directly. `AgentManager.transcriptPathOf()` then
handles Codex without requiring `adapter.transcriptPath`: for live reads it trusts an ownership row when the
recorded transcript exists, otherwise it uses a stored id or a cwd scan only when the cwd/config-home namespace is
unambiguous. This preserves the shared-cwd safety rule from the Claude Activity work.

`activity/logWriter.ts` stops constructing a Claude normalizer directly. It creates a runtime-specific normalizer
for the active session. Claude keeps the current normalizer untouched; Codex gets a new stateful normalizer for the
observed rollout schema (`session_meta`, `turn_context`, `event_msg`, `response_item`). The Codex normalizer maps
renderable records to the existing `NormalizedEvent` vocabulary and ignores unknown records safely.

The headless dogfood uses a temporary `CODEX_HOME` fixture and an Activity writer/manager flow to prove the actual
materialized durable log can render Codex messages/tools with `runtime:"codex"`.

## Key decisions

- **Path-returning Codex resolver** — chosen because Activity needs the rollout path, not only the id; rejected
  reconstructing a path from the id because Codex rollout filenames include timestamp/date layout.
- **Ownership-first live resolution** — chosen because shared cwd is common in Tachyon and newest-by-cwd can point
  at a sibling; rejected a global "newest matching cwd" fallback for shared namespaces.
- **Runtime normalizer registry** — chosen because the writer already owns offsets, boundaries, and persistence;
  rejected a separate Codex writer because it would duplicate crash/idempotency behavior.
- **Conservative Codex parser** — chosen because Codex transcript schemas can drift; rejected logging every unknown
  record as durable `raw` because it would bloat `.tachyon/activity` without improving the primary view.

## Files touched

- `src/resume/resolvers.ts` — add `resolveCodexSession()` and route existing Codex id resolution through it.
- `src/agents/AgentManager.ts` — resolve Codex transcript paths safely in `transcriptPathOf()` and mirror
  ownership-first readiness/resume where needed.
- `src/activity/codexNormalizer.ts` — new Codex JSONL to `NormalizedEvent` normalizer.
- `src/activity/logWriter.ts` — runtime-specific normalizer factory.
- `test/unit/resume.test.ts` — Codex path resolver and redirected `codexHome` coverage.
- `test/unit/agentManager.test.ts` — Codex `transcriptPathOf()` ownership/shared-cwd coverage.
- `test/unit/activityLog.integration.test.ts` — Codex durable log/view integration.
- `test/unit/codexNormalizer.test.ts` — focused Codex record mapping tests.

## Risks & unknowns

- Codex JSONL can drift. The normalizer must be no-throw and fixture-backed.
- Shared-cwd attribution can silently show the wrong agent if the fallback is too eager. Tests must cover the
  ambiguous no-ownership case.
- Tool output pairing depends on `call_id`; missing starts/results must still render useful standalone chips.
- The writer must reset the normalizer on both session id and runtime change.

## Sources consulted

- `src/webview/ActivityLogManager.ts` — always-on writer asks `transcriptPathOf(name, { live: true })`.
- `src/activity/logWriter.ts` — current writer state, offset, boundary, and Claude normalizer coupling.
- `src/activity/claudeNormalizer.ts` — existing normalizer contract and no-throw behavior.
- `src/resume/resolvers.ts` — current `resolveCodexId()` and redirected `codexHome`.
- `src/agents/AgentManager.ts` — shared-cwd and ownership-first transcript resolution.
- `docs/specs/239-tachyon-agent-activity-log/` — durable Activity log safety constraints.
- Local Codex rollouts under `~/.codex/sessions/2026/06/30/` — observed current Codex JSONL shapes.
