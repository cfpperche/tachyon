# 313 — claude-probe-review-reliability — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Use Claude's native `--json-schema` for structured probe archetypes instead of only strengthening text instructions. The observed failure mode was non-compliant prose, so native schema enforcement is the closest boundary to the runtime.
- Keep explicit `timeoutSec` and `budgetUsd` authoritative. Tachyon can choose better defaults when the caller omits them, but should not silently spend more or run longer than the caller requested.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Did not add file ingestion to `probe_agent`. A probe still only receives TASK/CONTEXT/CONSTRAINTS; callers that want file-aware review need to embed the relevant excerpts or use a persistent/read-capable agent.
- Did not add a Claude max-turns setting. The local `claude -p --help` surface exposes `--max-budget-usd` and process timeout for this path, not a probe-owned max-turns flag.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-01T15:20:48Z — pass (1/1) — source: tasks.md
- `npm test -- test/unit/probeAdapterClaude.test.ts test/unit/probeBridge.test.ts test/unit/probeArchetypes.test.ts` — pass

### 2026-07-01T15:18:56Z — pass — direct focused tests
- `npm test -- test/unit/probeAdapterClaude.test.ts test/unit/probeBridge.test.ts test/unit/probeArchetypes.test.ts` — pass, 30 tests.

### 2026-07-01T15:19:00Z — pass — static build checks
- `npm run typecheck` — pass.
- `npm run build` — pass.

## Dogfood log

### 2026-07-01T15:20:00Z — pass — real Claude structured review
- `node scripts/dogfood-claude-probe-review.mjs` — pass.
- Result summary: `{"ok":true,"findings":9,"costUsd":0.158345}`.
- Evidence: Claude returned a schema-backed JSON object with `findings[]`; no `parse_error` occurred.

### 2026-07-01T15:24:00Z — interrupted — duplicate wrapper run
- `bash .agents/skills/sdd/scripts/sdd-dogfood.sh docs/specs/313-claude-probe-review-reliability --run` started a second paid Claude dogfood after the direct pass. It was interrupted after several minutes with no output to avoid unnecessary extra cost. No leftover `claude` process remained.
