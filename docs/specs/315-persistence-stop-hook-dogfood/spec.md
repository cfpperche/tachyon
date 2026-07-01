# 315 — persistence-stop-hook-dogfood

_Created 2026-07-01._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Spec 312 added a deterministic `Stop` hook recorder for persisted Claude/Codex agents, but the current proof is mostly
unit/materialization plus local installation inspection. Before building UI or health layers on top of this path, Tachyon
needs real dogfood evidence that both runtimes fire the Stop hook after a real agent turn and append the expected ledger
row silently.

Done means a repeatable headless or semi-headless dogfood command proves the Stop hook path for Claude and Codex, records
the evidence in `notes.md`, and documents any runtime-specific limitation without weakening the silent-persistence
contract. Because the durable failure-log spec is separate, this dogfood must include explicit manual failure checks
rather than pretending a health system already exists.

## Acceptance criteria

- [ ] **Scenario: Claude Stop hook proof**
  - **Given** a persisted Claude agent is spawned with silent persistence hooks active
  - **When** it completes a real turn and the runtime fires `Stop`
  - **Then** `.tachyon/activity/persistence-stop.jsonl` receives a row for that agent without visible pane-typed Tachyon text
- [ ] **Scenario: Codex Stop hook proof**
  - **Given** a persisted Codex agent is spawned with silent persistence hooks active
  - **When** it completes a real turn and the runtime fires `Stop`
  - **Then** `.tachyon/activity/persistence-stop.jsonl` receives a row for that agent without visible pane-typed Tachyon text
- [ ] **Scenario: skipped hook remains explicit**
  - **Given** hook injection is skipped for a persisted agent
  - **When** the dogfood runs
  - **Then** the result reports the skip reason instead of claiming Stop hook success
- [ ] Dogfood evidence includes agent name, runtime, command/process evidence, and the appended ledger row shape.
- [ ] Dogfood explicitly checks the negative path: if the hook script is missing, non-executable, or not injected, the run
  reports that condition instead of passing silently.
- [ ] The proof path does not require publishing a VSIX.

## Non-goals

- Build a hook health UI.
- Change hook script behavior except for minimal instrumentation required to prove Stop fired.
- Generate semantic handoff notes.
- Exercise ad-hoc/fork/probe agents.

## Open questions

- **OQ1 — Dogfood shape.** RESOLVED: use maintainer-driven real persisted agents for the UI/TUI path plus narrow
  command-line probes for runtime-contract isolation. A headless-only script would miss the Codex TUI trust behavior found
  during dogfood.
- **OQ2 — Failure evidence before spec 317.** RESOLVED: spec 317 now exists; this dogfood uses both
  `.tachyon/activity/persistence-stop.jsonl` and `.tachyon/activity/persistence-hooks-failures.jsonl` as evidence.
- **OQ3 — Codex session-flag Stop trust.** OPEN: Codex 0.142.5 supports `hooks.Stop`, but a Tachyon-spawned TUI session
  with session-scoped `-c hooks.Stop=...` did not execute the Stop recorder unless hook trust was bypassed in an isolated
  `codex exec` probe. Tachyon must not solve this by adding `--dangerously-bypass-hook-trust` to normal agents because it
  would also bypass trust for unrelated user/project hooks.
