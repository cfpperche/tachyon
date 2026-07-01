# 318 — persistence-settings-ui

_Created 2026-07-01._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 added `settings.persistence.silentHooks: false` as a config-file kill switch. That is sufficient for a power
user editing `tachyon.yml`, but not discoverable from the Tachyon UI. Users need a clear way to see and change the
workspace persistence-hook mode without guessing the YAML shape.

Done means the UI exposes the silent persistence hook setting, writes the existing config shape safely, and explains the
tradeoff without adding new pane nudges.

## Acceptance criteria

- [ ] **Scenario: workspace kill switch is visible**
  - **Given** a workspace has Tachyon active
  - **When** the user opens the relevant settings/config UI
  - **Then** the current `settings.persistence.silentHooks` effective value is visible
- [ ] **Scenario: disable silent hooks from UI**
  - **Given** silent hooks are enabled by default
  - **When** the user disables them in the UI
  - **Then** Tachyon writes `settings.persistence.silentHooks: false` preserving unrelated YAML content
- [ ] **Scenario: re-enable default behavior from UI**
  - **Given** `settings.persistence.silentHooks: false` exists
  - **When** the user re-enables silent hooks
  - **Then** Tachyon removes or sets the config in the canonical way selected by the plan
- [ ] UI copy makes clear that disabling silent hooks restores legacy visible persistence reminders.
- [ ] UI links or routes the user to hook health diagnostics from spec 316 when hooks are skipped or failed.
- [ ] Any per-agent override is either explicitly designed here or deferred; no hidden partial support.

## Non-goals

- Redesign the Agent Studio harness UI.
- Add health diagnostics; spec 316 owns state display.
- Change default policy for ad-hoc/fork/probe agents.
- Implement new hook events or scripts.

## Open questions

- **OQ1 — Surface.** Candidate surfaces are a Tachyon settings panel or Agent Studio advanced settings; choose after
  reading existing config-editing patterns.
- **OQ2 — Per-agent override.** Useful but potentially confusing; start workspace-level unless a concrete user flow needs it.
