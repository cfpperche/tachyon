# 316 — persistence-hook-health-diagnostics

_Created 2026-07-01._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Silent persistence hooks are currently invisible by design. That is correct for the human terminal, but it creates a new
operator problem: when continuity/handoff behavior is missing, the sidebar does not clearly say whether hooks are active,
skipped, failed, or merely unknown.

Done means Tachyon exposes per-agent persistence hook health based on current-spawn injection and hook-script evidence,
without typing diagnostics into the agent pane. This spec should consume the durable failure records from spec 317 and
bounded ledgers from spec 319; it should not invent a parallel health ledger.

## Acceptance criteria

- [ ] **Scenario: active hook health**
  - **Given** a persisted agent's current spawn received the silent persistence hook bundle and hook scripts have emitted
    recent evidence
  - **When** the user inspects that agent
  - **Then** Tachyon reports persistence hooks as `active`
- [ ] **Scenario: skipped hook health**
  - **Given** a persisted agent should have silent hooks but injection was skipped, for example by a conflicting Claude
    `--settings`
  - **When** the user inspects that agent
  - **Then** Tachyon reports `skipped` with a reason
- [ ] **Scenario: failed hook health**
  - **Given** a hook script records a failure
  - **When** the user inspects that agent
  - **Then** Tachyon reports `failed` and points to the failure log
- [ ] **Scenario: unknown hook health**
  - **Given** Tachyon cannot prove active/skipped/failed state for the current spawn
  - **When** the user inspects that agent
  - **Then** Tachyon reports `unknown` rather than claiming success
- [ ] Health state is exposed in a low-noise UI surface, likely Inspector first and Sidebar only if compact enough.
- [ ] The model distinguishes desired config from actual current-spawn injection.
- [ ] The health surface links to the settings/control surface designed in spec 318 when user action is available.

## Non-goals

- Change the persistence hook policy.
- Store semantic continuity/handoff content.
- Add retention/rotation; that belongs to spec 319.
- Add a settings editor; that belongs to spec 318.

## Open questions

- **OQ1 — UI placement.** Inspector is the safer first surface; Sidebar badges need design care to avoid adding noise.
- **OQ2 — Dependency.** This spec should not ship before spec 317 has defined failure records; otherwise `failed` becomes
  an unreliable or duplicated signal.
