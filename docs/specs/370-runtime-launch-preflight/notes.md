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
- 2026-07-13 catalog-growth fix: the raw 256 KiB buffer was replaced by a strict streaming JSON validator/projector.
  The probe processes at most 8 MiB, 64 JSON levels, 512 selectable entries, and 128 code units per retained slug;
  irrelevant strings are validated without being retained, and control/bidirectional formatting characters are not
  admitted into retained slugs. Malformed UTF-8/JSON, excessive depth/count/bytes, timeout, and non-zero exit remain
  fail-closed and terminate the probe process tree. No raw catalog field exists in the probe result type.
- Live bounded evidence after the fix: the authenticated `codex-cli 0.144.1` catalog was 271,154 bytes and projected
  seven selectable slugs; `gpt-5.6-terra` was present and exact generic `gpt-5.6` was absent. Only byte/count/boolean
  outcomes and selectable slugs were printed; raw metadata/base instructions were neither logged nor persisted.

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- None before T1 implementation; empirical adapter details may still refine the plan without weakening the ratified
  fail-closed/readiness invariants.

## Dogfood log

### 2026-07-13T21:08:15Z — pass (1/1) — source: tasks.md — commit: 23130cea1c1cf8046c1b09ac306de80d92c1bb0e
- `npm run dogfood:runtime-launch-preflight` — pass

### 2026-07-13T21:12:09Z — pass (1/1) — source: tasks.md — commit: 9ac4907217d689d8e2c14f058bcdf1b9dc8af30a
- `npm run dogfood:runtime-launch-preflight` — pass


### 2026-07-13T21:46:30Z — pass (1/1) — source: tasks.md — commit: adfc030fa32827deb8cb74c7b7edf8eaf2c5f174
- `npm run dogfood:runtime-launch-preflight` — pass
## Verification log

### 2026-07-13T21:46:09Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass
