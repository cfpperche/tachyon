# 370 — runtime-launch-preflight — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-10 incident: coordinator requested `codex --model gpt-5.6`; Bridge returned spawn success and task
  `t-79dee5` was assigned, but Codex immediately emitted `invalid_request_error` because that model is not supported
  with the effective ChatGPT account. The agent was killed and the task returned to triaged.
- Live `codex-cli 0.144.1` evidence: `codex debug models` lists `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`; generic `gpt-5.6` is absent. The catalog is dynamic runtime evidence, not product data.
- Root cause: `spawn_agent` validates contract/isolation/limits, while `AgentManager.spawnCore` treats successful tmux
  creation as successful launch. `RuntimeProfile.model` explicitly contains labels/aliases only.
- Prior decision preserved: spec 328 correctly rejected Tachyon-owned dated model catalogs. This design adds a
  runtime-native dynamic preflight instead.
- 2026-07-10 maintainer ratification: delegated explicit-model launches fail closed when authoritative verification is
  unavailable; `spawn_agent` waits for bounded readiness; five seconds without ready/rejected yields
  `starting/pending`; Tasks cannot be assigned to non-ready agents.

## Deviations

- 2026-07-13 lane pilot: `npm run dogfood:runtime-launch-preflight` is now executable and deterministic. It exercises
  bounded supported/absent/malformed/timeout/non-zero/oversized fixtures plus lease cleanup; it deliberately does not
  claim T1/T2 product integration or perform a live catalog/inference request (preserving SDD 369's T0 boundary).
- Live follow-up remains coordinator-owned: explicit-model spawn currently fails when the Codex catalog exceeds the
  preflight raw-output limit. The lane exposes the oversized failure safely and never persists the raw catalog.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- None before T1 implementation; empirical adapter details may still refine the plan without weakening the ratified
  fail-closed/readiness invariants.

## Dogfood log

### 2026-07-13T21:08:15Z — pass (1/1) — source: tasks.md — commit: 23130cea1c1cf8046c1b09ac306de80d92c1bb0e
- `npm run dogfood:runtime-launch-preflight` — pass
