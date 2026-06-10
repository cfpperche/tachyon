# 190 — tachyon-crash-lifecycle

_Created 2026-06-09._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

**Closure:** 2026-06-09 — shipped at 6f3a053; 92/92 vitest (3x stable) + 11-passing host integration (live crash exit-code/postmortem + live on-crash auto-restart); spec-verify pass in notes.md; residual: none.

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F2**, decided "implement, validated, no open follow-ups" (user, 2026-06-09). Before this spec, an agent process dying was invisible: the tmux session vanished, the terminal closed, no exit code, no postmortem, no recovery. F2 makes death a first-class event. Mechanism: sessions run with `remain-on-exit` (set globally on the dedicated socket inside the same tmux invocation that creates the session — race-free even for instantly-dying commands), so a dying process leaves a **dead pane** carrying `pane_dead_status` (the exit code) and the last screen for postmortem. This makes crash vs intentional kill **structurally distinguishable**: a Tachyon kill removes the whole session; a crash leaves a dead pane. A LifecycleMonitor (vscode-free, ticked by the existing 3s poller) watches transitions: non-zero exit → red `crashed — exit N` sidebar state + error toast (Inspect/Restart); exit 0 → informational only; vanished session → silent. Per-agent `restart: on-crash` policy auto-restarts non-zero exits with backoff (2s/4s/8s) and a crash-loop guard (3 restarts/min → give up + notify; manual restart re-arms). Liveness semantics updated across the product: `running` now means alive process; crashed panes don't count toward maxAgents, aren't auto-replaced by autostart (postmortem preserved), and are exposed (`crashed`, `exitCode`) via the Bridge's `list_agents`.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: crash is visible with exit code + postmortem**
  - **Given** a running agent whose process dies with a non-zero exit
  - **When** the lifecycle poller ticks
  - **Then** the sidebar shows red `crashed — exit N`, a toast offers Inspect/Restart, the dead pane (last output) remains readable, and `list_agents` carries `crashed`/`exitCode`

- [x] **Scenario: clean exit is not a crash**
  - **Given** a running agent that exits with code 0
  - **When** the poller ticks
  - **Then** an informational notice only — no red state escalation to error, no auto-restart

- [x] **Scenario: intentional kills are silent**
  - **Given** an agent killed via Tachyon (■, Stop All, kill_agent, restart)
  - **When** the poller ticks
  - **Then** no crash/death notification fires (the session vanished; only crashes leave dead panes)

- [x] **Scenario: restart on-crash with backoff**
  - **Given** an agent declared `restart: on-crash` that dies with a non-zero exit
  - **When** the poller observes the death
  - **Then** it is restarted after backoff (2s, then 4s, then 8s on repeated crashes)

- [x] **Scenario: crash-loop guard**
  - **Given** an on-crash agent that keeps dying
  - **When** 3 restarts happen within a minute
  - **Then** Tachyon gives up, keeps the postmortem, and notifies; a manual restart clears the guard

- [x] Liveness semantics: `running` = alive process everywhere (sidebar, runningAgents, maxAgents count, attention monitor); spawning over a crashed agent replaces the dead pane; autostart never replaces a postmortem; Stop All dismisses dead panes too
- [x] `restart: never|on-crash` validated in loader + JSON Schema
- [x] Unit coverage: LifecycleMonitor transitions (clean/crash/silent-kill/backoff/give-up/window-expiry/reset), manager crashed-state semantics, config shapes; real-tmux: instantly-dying command leaves dead pane with exit code
- [x] Live integration: real agent killed with `exit 3` reports crashed+exitCode with surviving postmortem session; `restart: on-crash` agent auto-returns after `exit 5`

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Restart policies beyond never/on-crash (always/on-failure-with-max-retries config knobs) — backoff constants are code, not config, in v1.
- Crash-cause analysis (parsing the postmortem) — the pane is kept for the human/agents to read.
- Persisting crash history across editor restarts — a dead pane discovered at activation is reported once, that's it.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design agreed in the umbrella discussion (2026-06-09)._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F2). Prior art: HiveTerm crash recovery/auto-restart/exit-code visibility; tmux remain-on-exit + pane_dead_status.
