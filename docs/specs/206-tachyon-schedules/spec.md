# 206 — tachyon-schedules

_Created 2026-06-11._

**Status:** shipped

**Closure:** 2026-06-11 — unit 207/207 (schedule 10 new), xvfb 22 single-root (active + propose→approve→active + reject) + 6 multi-root; live claude E2E proposed a schedule that stayed pending until approved; residual: none

**UI impact:** render
<!-- New Schedules sidebar view (active + pending proposals); exercised via the _schedules/_proposals/_approveProposal seams + dogfood. -->

## Intent

F23: runtime-neutral scheduling. Claude has /schedule; codex/gemini/opencode have
nothing. A `schedules:` map in tachyon.yml gives any runtime cron-like timers over
the executors we already have (run_command / run_runbook / spawn_agent). Honest
scope: schedules fire ONLY while the workspace is open (the extension isn't a
daemon — same semantics as watch-restart; you also don't want unsupervised AI
agents waking at 3am). Agents may PROPOSE a schedule via the Bridge, but a proposal
is inert until the human approves it — approval writes it into tachyon.yml.

## Acceptance criteria

- [x] **Scenario: declared schedule fires while open**
  - **Given** `schedules: {hourly: {every: 1h, run: test}}`
  - **When** the workspace is open and an hour elapses
  - **Then** the action fires; `every` re-anchors from the last fire; `at: "09:00"` fires once per day when the clock crosses it (optional `catchUp` fires a missed time on activation)

- [x] **Scenario: agent proposes, human approves**
  - **Given** an agent calls `propose_schedule`
  - **When** the proposal is recorded
  - **Then** it lands in `.tachyon/schedules-pending.json` **inert** (never fires), shows in the Schedules view under "Pending approval"; approving writes it into `tachyon.yml` (config-as-code) and drops it from pending; rejecting discards it

- [x] **Scenario: validation parity**
  - **Given** a schedule (config or proposal)
  - **Then** exactly one of `every`/`at`, exactly one of `run`/`spawn`; `every` like 30m/1h; `at` HH:MM; `run` references a declared command/runbook; `spawn` a declared agent; `instructions` only with `spawn`

- [x] `list_schedules` exposes active + pending to agents; the view badges the pending count
- [x] Tool schema grew 16→18 (propose_schedule, list_schedules) → 0.6.0 with the upgrade notice

## Non-goals

- Firing while the editor is closed (would need a daemon — explicitly out; documented as the honest scope).
- Full cron expressions (every/at cover the cases; revisit on demand).
- Agents approving their own proposals (the human gate is the whole point).
