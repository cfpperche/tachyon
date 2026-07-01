# 313 — claude-probe-review-reliability — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep the probe contract unchanged for callers, but harden the Claude adapter and service defaults:

1. Add Claude-native `--json-schema` for structured archetypes (`adversarial-review`, `factual-verify`), derived from Tachyon's existing validator contracts.
2. Leave `freeform` unchanged so prose probes do not become artificially structured.
3. Increase the default subprocess timeout for Claude adversarial reviews when the caller does not provide `timeoutSec`.
4. Keep explicit caller bounds authoritative: if a caller passes `timeoutSec: 120` or a low `budgetUsd`, Tachyon must not override it silently.
5. Validate with unit tests and one real Claude probe against the spec-312 review use case, using async polling and a realistic timeout/budget.

## Key decisions

- **Use Claude `--json-schema` for structured probes** — chosen because it moves schema compliance into the runtime's native structured-output path; rejected prompt-only enforcement because the observed failure already ignored the text contract.
- **Do not auto-raise user budgets** — chosen because probe calls spend real money; rejected hidden budget inflation because it violates caller cost control.
- **Do not add file reading to probes in this pass** — chosen because probes are intentionally bounded and headless; rejected runtime file access because it reintroduces the persistent-agent/tool-use behavior probes were designed to avoid.
- **Raise only omitted Claude review timeouts** — chosen because real review duets need more than a smoke-test envelope; rejected overriding explicit timeouts because existing callers use them as hard bounds.

## Files touched

- `src/probe/adapters/claude.ts` — emit native JSON schemas for structured archetypes.
- `src/probe/ProbeService.ts` — apply a larger default timeout for Claude adversarial reviews.
- `test/unit/probeAdapterClaude.test.ts` — prove schema flags are present/absent correctly.
- `test/unit/probeBridge.test.ts` or `test/unit/probeService.test.ts` — prove the review timeout default.
- `docs/specs/313-claude-probe-review-reliability/*` — capture intent, plan, tasks, notes, and evidence.

## Risks & unknowns

- Claude CLI schema behavior can still fail on provider budget/overload; the probe should surface that as `budget`/`model_error`, not fake success.
- If the review prompt asks Claude to read files but the context is not embedded, the best answer may be "insufficient context". This spec does not solve context assembly.
- The real validation costs money when run against Claude; run a single bounded dogfood with explicit budget.

## Sources consulted

- `src/probe/adapters/claude.ts` — current `claude -p --output-format json` invocation and budget mapping.
- `src/probe/ProbeService.ts` — default subprocess timeout and archetype validation path.
- `src/probe/archetypes.ts` — Tachyon's structured output contracts and validators.
- `src/bridge/tools.ts` — `probe_agent` input bounds and sync/async behavior.
- `claude -p --help` — native `--json-schema`, `--max-budget-usd`, and print-mode flags.
