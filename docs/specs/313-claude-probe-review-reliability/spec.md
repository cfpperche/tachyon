# 313 — claude-probe-review-reliability

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped Claude probe hardening: structured Claude probes now receive native `--json-schema`, Claude adversarial-review probes get a 10 minute default subprocess timeout when no explicit timeout is supplied, and dogfood proved a real Claude schema-backed review returned valid JSON without `parse_error`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Claude probes are currently brittle for review duets: large review prompts can hit short caller-provided timeouts, low manual budgets can terminate before a useful answer, and structured archetypes can return prose that Tachyon has to downgrade to `parse_error`.

This spec makes Claude-backed review probes more reliable without turning them into persistent agents: Tachyon should keep probes headless and bounded, use native structured-output support when available, and make the default review envelope large enough for real spec/code review.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Claude structured review output**
  - **Given** a Claude probe for `adversarial-review`
  - **When** Tachyon builds the headless invocation
  - **Then** the invocation includes a native JSON schema matching Tachyon's `findings[]` contract
- [x] **Scenario: Claude factual verification output**
  - **Given** a Claude probe for `factual-verify`
  - **When** Tachyon builds the headless invocation
  - **Then** the invocation includes a native JSON schema matching Tachyon's `claims[]` contract
- [x] **Scenario: Larger default review envelope**
  - **Given** a Claude `adversarial-review` probe without an explicit timeout
  - **When** Tachyon launches it
  - **Then** the subprocess timeout is long enough for a real spec/code review duet
- [x] Freeform probes stay prose-only and do not receive a JSON schema.
- [x] Existing explicit `timeoutSec` and `budgetUsd` remain caller-controlled bounds; Tachyon does not silently spend more money than requested.

## Non-goals

- Build file-ingestion into `probe_agent`; callers must still provide enough context in `task`/`context`.
- Add a Claude max-turns control; the current Claude CLI exposes budget and wall-clock controls for this path, not a probe-owned turns limit.
- Replace `spawn_agent`; probes remain captured, headless, and non-persistent.

## Open questions

- Should Tachyon reject obviously too-low Claude review budgets? Initial answer: no for this pass, because budgets are user cost policy. We will improve diagnostics and use native schema first.
