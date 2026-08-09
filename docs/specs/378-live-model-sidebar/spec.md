# 378 — live-model-sidebar

_Created 2026-07-13._

**Status:** shipped

**Closure:** merged to main at 40ad921a (branch tachyon/livemodel2, delegated task t-832fa2).
**Verify:** `npx vitest run test/unit/livemodel2Behavior.gen.test.ts test/unit/agentModel.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npx vitest run test/unit/livemodel2Behavior.gen.test.ts`
Behavior gate manual-equivalent (canonical verify_task blocked by lease wedge t-19026b — no salvage
path exists); independent review ACCEPT; full suite green on branch and merged main; maintainer live
dogfood 2026-07-14: codex-budget flipped "Codex default · profile" → observed "GPT-5.6 Sol" within
seconds of a turn. Platform bugs surfaced and filed: t-88ef8c (AF_UNIX socket path kills activation),
t-19026b (lease salvage), t-1e733d (flaky probe test), t-9f2641 (ownership misses mid-run transcript
rotation). Follow-ups: sidebar preview fixture lacks the provenance fields; RuntimeOps panel model
column still declared-only; divergence-on-profile-default kept (informative semantics, maintainer-accepted).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The sidebar's per-agent model label is static: `modelFromCommand()` parses the *declared*
spawn command and falls back to the runtime-profile default. It is provably wrong on the
live fleet today — the `codex` pane footer shows `gpt-5.6-sol ultra` while `codex-budget`/
`codex-soul` (bare `codex` spawn, model resolved via harness `config.toml`) display
"Codex default", and an in-TUI `/model` switch never updates the label.

The runtimes' own on-disk stores carry the live model, and Tachyon already tails them:
claude stamps `message.model` on every assistant record, codex stamps
`turn_context.payload.model` (+ `effort`) once per turn, grok stamps `assistant.model_id`
per message (today smuggled into `runtimeVersion`). "Done" = the sidebar (and the
queryable projection behind it) shows the **observed** model with honest provenance
(`observed | declared | profile`), an `observedAt` timestamp, and a queryable
declared-vs-observed divergence signal — sourced from the transcripts through the
existing activity pipeline, never from pane scraping.

## Acceptance criteria

- [x] **Scenario: in-TUI model switch reaches the sidebar**
  - **Given** a running claude/codex/grok agent whose transcript the activity pipeline tails
  - **When** the operator switches models inside the TUI (e.g. `/model`) and the next
    assistant record / `turn_context` lands in the transcript
  - **Then** the agent's projected model (and the sidebar VM) updates to the new resolved
    id within one activity poll (~2s after the record is flushed), labeled via
    `modelLabelForRuntime`, with `source: observed` and a fresh `observedAt`
- [x] **Scenario: pre-first-turn honesty**
  - **Given** a freshly spawned agent whose session has no model-bearing record yet
  - **When** the sidebar gathers the fleet
  - **Then** the row shows the declared/profile label with `source: declared|profile` —
    never a fake `observed`
- [x] **Scenario: process rotation demotes stale observations**
  - **Given** an agent with an observed model from a previous session
  - **When** Tachyon restarts/starts/forks the process (lifecycle-labeled session boundary)
  - **Then** the observed value is demoted (declared/profile wins) until a new observation
    lands; for boundaries that keep the process alive (in-TUI `/clear`, resume) the
    observation is retained and flagged `stale: true` until re-observed
- [x] **Scenario: divergence is queryable, not swallowed**
  - **Given** a declared model X and an observed model Y with
    `normalize(X) != normalize(Y)` (same alias table on both sides)
  - **When** the model fact is projected
  - **Then** it carries `divergence: true`, the sidebar renders the observed label with a
    visible textual marker (not styling alone), and the fact is exposed in the RuntimeOps
    snapshot for agent consumers
- [x] **Scenario: subagent records never relabel the agent**
  - **Given** a claude transcript containing an assistant record with `isSidechain: true`
    and a different `message.model`
  - **When** the normalizer processes it
  - **Then** the sidechain model is NOT latched as the agent's model (fixture-tested);
    `"<synthetic>"` models are likewise filtered
- [x] **Scenario: sidebar updates with RuntimeOps closed**
  - **Given** the RuntimeOps panel is never opened
  - **When** a model-bearing record lands in an agent's durable activity log
  - **Then** the shared projection cursor still advances and the sidebar refresh fires
    (change detected on the `(label, source, stale, divergence)` tuple) — regression-tested
- [x] Observed ids missing from the alias table render as the raw/title-cased id — never
  "Unavailable" (open-fallback label policy; validated charset/length gate on observed ids)
- [x] The normalized vocabulary carries `{model, effort?}` (codex `turn_context` carries
  both); no durable-log `schemaVersion` bump (additive optional fields; no reader gates on
  the version)
- [x] grok/opencode stop smuggling the model id through `runtimeVersion` in the same
  change (Activity header + RuntimeOps version column keep working via the new field)
- [x] AgentVM keeps `model: string` and gains additive siblings
  (`modelSource`, `modelObservedAt`, `modelStale`, `modelDivergence`) — webview protocol
  stays backward-compatible

## Non-goals

- Pane scraping (footers are user-configurable/custom scripts/box borders; project doc
  prefers runtime-owned stores; closed-enum invariant on terminal-derived text stays).
- Rendering reasoning effort in the sidebar row (the *field* ships; the row UI decision is
  a follow-up).
- Runtimes beyond claude/codex/grok (+ the opencode `runtimeVersion` un-overload that
  rides along); gemini/qwen/etc. keep the static label.
- The RuntimeOps *panel's* model column switching to the live projection (stated follow-up;
  this spec only fixes its label fallback policy and exposes the projection).
- grok `summary.json` as an observed source (needs a live dogfood of grok's
  switch-forces-new-session behavior first; tracked as an open question).

## Open questions

- ~~codex 0.144 live `/model` switch~~ RESOLVED 2026-07-14: live dogfood confirmed the current
  CLI emits `turn_context` with the model per turn (observed flip on codex-budget within seconds).
- grok in-TUI switch semantics ("requires starting a new session" per binary strings):
  decides whether `summary.json.current_model_id` can ever earn `observed` provenance.
  Owner: follow-up spec.
