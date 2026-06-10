# 200 — tachyon-runbooks

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — shipped with spec 199 in the F15+F21 package; unit 153/153 (runbooks 6/6), integration 20 passing (xvfb) incl. the failure-gate scenario, live claude -p E2E ran run_runbook ship to a passed job; residual: none

**UI impact:** render
<!-- Runbooks group renders inside the Commands view; steps verified through the _runRunbook seam in the xvfb host + dogfood walkthrough. -->

## Intent

Runbooks (F21, sentinel-inspired): named step-by-step procedures in a `runbooks:` map —
each step is either a reference to a curated command (spec 199) or an inline shell
string. Steps run sequentially with an exit-code gate: the first failure stops the
procedure, keeps the failing pane for postmortem, and marks the rest skipped. This
turns multi-step project rituals (lint → test → deploy) into one button for humans
and one blocking tool call (`run_runbook`) for agents.

## Acceptance criteria

- [x] **Scenario: sequential pass**
  - **Given** `runbooks: {ship: {steps: [lint, test, "./deploy.sh"]}}`
  - **When** ▶ on the Runbooks item (or `run_runbook name=ship`)
  - **Then** steps run one at a time in `tachyon-rb-<hash>-ship-<n>` sessions; each successful pane is tidied; the job ends `passed` with per-step durations

- [x] **Scenario: failure gates the procedure**
  - **Given** a step exits non-zero
  - **When** the runner observes it
  - **Then** later steps are marked `skipped`, the failing pane is KEPT for inspection, the job ends `failed`, and the sidebar shows ✗ per-step states under the expanded item

- [x] **Scenario: step resolution**
  - **Given** a step string
  - **When** it matches a `commands:` name exactly
  - **Then** that command's cmd runs; otherwise the string runs as inline shell

- [x] **Scenario: run_runbook re-call semantics**
  - **Given** a runbook still running when the tool call times out
  - **When** the agent calls `run_runbook` again
  - **Then** it attaches to the in-flight job and reports progress (never starts a duplicate); a finished job is reported, not re-run, unless `rerun: true`; concurrent runs of the same runbook are refused

- [x] Job history kept in session memory (cap 10); Stop All kills leftover step panes
- [x] Deleting a referenced command (spec 199 editor) warns which runbooks fall back to inline shell
