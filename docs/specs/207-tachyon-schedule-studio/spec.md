# 207 — tachyon-schedule-studio

_Created 2026-06-11._

**Status:** shipped

**Closure:** 2026-06-11 — unit 211/211 (schedule form logic 3 new), studio parse-guard green, Studio Schedule tab captured live; 0.6.4; residual: none

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

**UI impact:** render
<!-- Fifth Agent Studio tab + a + button on the Schedules view; captured into the studio montage. -->

## Intent

Close the F23 gap: agents/terminals/commands/runbooks all had an Agent Studio tab
and a creation path, but schedules were create-by-hand-editing-yml only (the UI
could pause/edit-in-yml/delete and approve proposals, but not author one from
scratch). Add a fifth Studio tab so a human can create/edit a schedule visually.

## Acceptance criteria

- [x] **Scenario: create a schedule from the UI**
  - **Given** the Schedules view
  - **When** the `+` button is clicked
  - **Then** the Agent Studio opens on a "Schedule" tab — When (Every/Daily at + value), Action (Run command/runbook | Spawn agent + target), Catch up (daily only); Save writes a `schedules:` entry via the comment-preserving editor and it goes active

- [x] **Scenario: edit a schedule from the UI**
  - **Given** an active schedule
  - **When** right-click → Edit Schedule…
  - **Then** the Studio opens pre-filled (timing/action/target/catchUp) and Save rewrites it in place

- [x] **Scenario: validation**
  - **Then** timing must be a valid `every` (30m/1h) or `at` (HH:MM); target required; name rules as elsewhere

- [x] Schedule tab hides the agent lifecycle checkboxes; instructions field shows only for Spawn
- [x] No tool-schema change (UI only) — 0.6.4 patch

## Non-goals

- A dropdown of command/runbook/agent names for the target (text input + hint in v1; a bad ref fails on config reload with a clear error).
