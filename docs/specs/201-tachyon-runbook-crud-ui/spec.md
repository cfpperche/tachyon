# 201 — tachyon-runbook-crud-ui

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — shipped same-day (dogfood gap of spec 200); unit 160/160, xvfb integration 21 passing incl. the Studio-pipeline runbook CRUD scenario; no Bridge change (0.4.1 patch); residual: none

**UI impact:** render
<!-- Runbook tab + context menus exercised through the _upsertAgent/deleteRunbookItem seams in the xvfb host; visual walkthrough in the dogfood. -->

## Intent

Dogfooding F15+F21 surfaced the gap immediately: runbooks could only be
created/edited/deleted by hand-editing tachyon.yml — commands had full UI CRUD,
runbooks only had ▶. Close the asymmetry: same context-menu affordances as
commands, a fourth Agent Studio tab (a runbook is just name + ordered steps),
and a + button on the Commands view. Runbooks stay in the Commands view: they
are compositions of commands — same mental space, one view, two groups.

## Acceptance criteria

- [x] **Scenario: create via the Studio Runbook tab**
  - **Given** the Studio opened on the Runbook tab (4th tab, or via the Commands view + button then switching)
  - **When** a name and steps (textarea, one per line) are submitted
  - **Then** the entry lands under `runbooks:` via the comment-preserving editor; blank lines dropped; a live hint shows how each line resolves (command reference vs inline shell — same semantics as the runner)

- [x] **Scenario: edit and delete from the context menu**
  - **Given** a runbook item in the Commands view
  - **When** right-clicked
  - **Then** Edit Runbook… (Studio prefilled), Edit in tachyon.yml (cursor at the entry), Delete Runbook… (confirmation modal) are available — parity with commands

- [x] **Scenario: guardrails**
  - **Given** a runbook currently running
  - **When** Delete Runbook… is invoked
  - **Then** it refuses with a warning; empty steps block submit (`steps-required`); duplicate names block unless editing in place

- [x] + button on the Commands view title opens the Studio directly on the Command tab
- [x] No Bridge/tool-schema change — version 0.4.1 (patch), no upgrade-notice churn
