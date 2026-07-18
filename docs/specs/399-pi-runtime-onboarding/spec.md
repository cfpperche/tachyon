# 399 — pi-runtime-onboarding

_Created 2026-07-18._

**Status:** in-progress

## Intent

Tachyon already recognizes `pi` as an AI CLI and injects its agent identity, Bridge URL and per-agent bearer token, but Pi has no built-in MCP client. A Tachyon-spawned Pi therefore appears in the fleet while receiving neither the generated onboarding brief nor the Bridge tools needed to participate in orchestration.

Make Pi a first-class Tachyon runtime for onboarding: Tachyon delivers the same spawn/restart/re-anchor primer used by supported runtimes and additively loads a Tachyon-owned Pi extension that projects the authenticated MCP Bridge tool catalog into Pi's native tool API. The integration must not modify user-global Pi configuration and must keep bearer values out of argv and files.

**Affected Product Invariants: PI-001 — promise unchanged; Pi joins the existing explicit, source-labelled project-guidance transport without changing its oracle.**

## Acceptance criteria

- [x] **Scenario: Tachyon starts an onboarded Pi agent**
  - **Given** a declared or ad-hoc agent whose resolved runtime is `pi` and a live authenticated Bridge
  - **When** Tachyon composes and starts the process
  - **Then** the command additively loads the immutable Tachyon Pi Bridge extension and receives the generated opening brief without mutating user or project Pi configuration
- [x] **Scenario: Pi discovers and calls Bridge tools**
  - **Given** the injected extension, `TACHYON_BRIDGE_URL`, and `TACHYON_AGENT_BRIDGE_TOKEN`
  - **When** Pi initializes the extension
  - **Then** each Bridge MCP tool is exposed as a native Pi tool and calls preserve MCP text/error results and cancellation
- [x] **Scenario: credentials remain process-scoped**
  - **Given** an authenticated Pi spawn
  - **When** its final command and generated/staged files are inspected
  - **Then** neither the per-agent bearer nor the shared bearer appears in argv or Tachyon-written extension files
- [x] **Scenario: unavailable onboarding dependency is honest**
  - **Given** a missing extension asset or unavailable/misconfigured Bridge
  - **When** Tachyon starts Pi or Pi loads the extension
  - **Then** Tachyon does not claim successful Bridge wiring for a missing asset, and Pi surfaces a diagnostic without preventing ordinary local coding work
- [x] **Scenario: existing runtimes remain unchanged**
  - **Given** a non-Pi agent
  - **When** its spawn/restart/resume/fork command is composed
  - **Then** its existing prompt and Bridge injection behavior is unchanged
- [x] The persistent engine manifest authenticates and stages the Pi extension alongside the daemon.
- [x] Pi onboarding has focused tests plus headless dogfood through the real Pi extension loader.

## Non-goals

- Native Pi transcript capture/resume, fork semantics, Activity JSONL ingestion, model telemetry, composer detection, or Pi-specific lifecycle hooks.
- Adding MCP to Pi globally or changing Pi itself.
- Installing or editing `~/.pi`, `.pi/settings.json`, project extensions, or project context files.
- Making Pi a Tachyon plugin materialization target; this spec is runtime onboarding, not plugin-distribution expansion.
- Merging the implementation into `main` without explicit maintainer authorization.

## Open questions

None for this slice. Resume and Activity parity are explicit follow-up work after Bridge/primer dogfood proves the foundational runtime seam.
