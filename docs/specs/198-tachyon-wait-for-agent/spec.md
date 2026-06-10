# 198 — tachyon-wait-for-agent

_Created 2026-06-10._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F19** (user's delegation scenario + sentinel's websocket insight, 2026-06-10; ordered F19→F20 after the seam discussion). The delegation cycle (spawn → give task → know when done → read result → kill) had every primitive except an efficient "know when done" — parents had to poll list_agents, burning turns. MCP's request/response shape rules out server push to agents, so the event-driven translation is a **long-poll tool**: `wait_for_agent(name, until: idle|needs-input|dead, timeoutSec≤240 default 45)` holds the HTTP call open until a monitor transition wakes it. Internally a **Waiters registry** (vscode-free) hangs off the EXISTING monitor events (AttentionMonitor.onChange, LifecycleMonitor onCrash/onCleanExit/+new onGone) — zero added polling, and detection-engine agnostic: F20 (tmux control mode) will make waiters faster without touching them. Semantics: immediate resolution when the condition already holds; terminal events (dead/gone) resolve ANY waiter (met only for until=dead); timeout returns met:false with the LIVE state ("call again to keep waiting" — also the answer to MCP clients' own call timeouts). Bonus fix from the E2E: killed ad-hoc agents now leave the listing entirely (def+lineage cleared). Version 0.3.0 (tool-schema discipline).

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: the delegation cycle in single calls**
  - **Given** an orchestrator agent
  - **When** it runs spawn_agent → write_input → wait_for_agent(until=idle) → read_output → kill_agent
  - **Then** the wait resolves on the child's real working→idle transition (no parent-side polling) and the cycle completes

- [x] **Scenario: immediate resolution**
  - **When** the awaited condition already holds (or the agent is dead/gone) at call time
  - **Then** the tool returns instantly with the truthful state (gone satisfies until=dead)

- [x] **Scenario: terminal events release every waiter**
  - **Given** waiters on idle/needs-input for an agent
  - **When** the agent dies or its session is killed
  - **Then** all its waiters resolve (met=false, state dead/gone + exitCode) — nothing hangs

- [x] **Scenario: timeout is informative**
  - **When** timeoutSec elapses first
  - **Then** met:false with the agent's LIVE state — callers re-call to continue (documented for MCP client-side timeouts)

- [x] Waiters are event-driven off existing monitor transitions (no new polling); extension disposal flushes pending waiters
- [x] Unit coverage: Waiters (resolution/terminal/gone/timeout/dispose/multi-condition), executeWait branches, MCP round-trip (13 tools)
- [x] Live host integration: real working→idle transition resolves _wait (≥4s actual wait asserted); ghost agent → gone
- [x] Live E2E: real claude ran the FULL cycle — spawn(parent) → write_input → wait (met=true in ~2.6s) → read (`RESULT: 6*7=42`) → kill → confirmed gone

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Server-push to agents (MCP clients are request/response; the long-poll IS the event-driven shape).
- tmux control mode as the detection engine — that's F20, registered separately; waiters benefit automatically.
- Waiting on multiple agents in one call (compose with parallel calls if ever needed).

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design closed in the F19/F20 ordering discussion (the monitor-event seam isolates the layers)._ 

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F19). Inspiration: sentinel /ws/events (event push) translated to MCP long-poll; seam argument recorded in session.
