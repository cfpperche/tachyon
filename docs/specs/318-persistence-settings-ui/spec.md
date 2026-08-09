# 318 — persistence-settings-ui

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped in this workspace as spec 318 implementation; final commit/VSIX recorded after validation. Evidence: `npm test -- test/unit/yamlEditor.test.ts` and `npm run typecheck`. Human dogfood route: sidebar Agents/Terminals > Persistence hooks settings.
**Verify:** `npm test -- test/unit/yamlEditor.test.ts`
**Verify:** `npm run typecheck`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

> **t-7bcba6 (2026-07-12):** The `settings.persistence.silentHooks` kill switch and the `tachyon.persistenceSettings` / “Visible legacy reminders” UI were **removed**. Silent hooks remain the only supported path for eligible declared Claude/Codex agents. This shipped history is not rewritten; the kill switch is obsolete product surface, not current behavior.


## Intent

Spec 312 added `settings.persistence.silentHooks: false` as a config-file kill switch. That is sufficient for a power
user editing `tachyon.yml`, but not discoverable from the Tachyon UI. Users need a clear way to see and change the
workspace persistence-hook mode without guessing the YAML shape.

Done means the UI exposes the silent persistence hook setting, writes the existing config shape safely, and explains the
tradeoff without adding new pane nudges.

## Acceptance criteria

- [x] **Scenario: workspace kill switch is visible**
  - **Given** a workspace has Tachyon active
  - **When** the user opens the relevant settings/config UI
  - **Then** the current `settings.persistence.silentHooks` effective value is visible
- [x] **Scenario: disable silent hooks from UI**
  - **Given** silent hooks are enabled by default
  - **When** the user disables them in the UI
  - **Then** Tachyon writes `settings.persistence.silentHooks: false` preserving unrelated YAML content
- [x] **Scenario: re-enable default behavior from UI**
  - **Given** `settings.persistence.silentHooks: false` exists
  - **When** the user re-enables silent hooks
  - **Then** Tachyon removes or sets the config in the canonical way selected by the plan
- [x] UI copy makes clear that disabling silent hooks restores legacy visible persistence reminders.
- [x] UI links or routes the user to hook health diagnostics from spec 316 when hooks are skipped or failed.
- [x] Any per-agent override is either explicitly designed here or deferred; no hidden partial support.

## Non-goals

- Redesign the Agent Studio harness UI.
- Add health diagnostics; spec 316 owns state display.
- Change default policy for ad-hoc/fork/probe agents.
- Implement new hook events or scripts.

## Open questions

- **OQ1 — Surface.** Resolved in `plan.md`: expose a workspace-level command from the sidebar Agents/Terminals header,
  plus route hook-health badges to the same command.
- **OQ2 — Per-agent override.** Deferred. This pass intentionally edits only the workspace-level kill switch.
