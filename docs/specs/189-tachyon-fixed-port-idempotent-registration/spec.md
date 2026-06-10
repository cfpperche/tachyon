# 189 — tachyon-fixed-port-idempotent-registration

_Created 2026-06-09._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-09 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F12** (user-reported friction, 2026-06-09, decided implement+validate). Two defects from first real use: (1) the Bridge binds an ephemeral port, so every editor reboot invalidates registered MCP configs — agents must be re-connected "toda hora"; (2) registration must be **idempotent and respectful of pre-existing MCP config files** — projects commonly already have `.mcp.json`/`opencode.json` with other servers. Fix: the Bridge gets a **stable port by default** — derived deterministically from the workspace hash into 41000–42999 (no config needed; same workspace ⇒ same port forever), overridable via `settings.bridgePort` in `tachyon.yml`; if the preferred port is busy, fall back to an ephemeral one with a warning. Registration becomes idempotent: when the target file already carries the exact tachyon entry, the connect command is a **no-op** ("already registered"); otherwise it merges only the `tachyon` key (never touching other servers), without a modal, and reports what changed.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: stable port across reboots**
  - **Given** a workspace without `settings.bridgePort`
  - **When** the extension activates twice (editor restart)
  - **Then** the Bridge binds the same derived port (41000–42999) both times, so an existing registration keeps working

- [x] **Scenario: explicit port override**
  - **Given** `settings: {bridgePort: 45123}` in tachyon.yml
  - **When** the extension activates
  - **Then** the Bridge binds 45123

- [x] **Scenario: preferred port busy**
  - **Given** another process holds the preferred port
  - **When** the Bridge starts
  - **Then** it falls back to an ephemeral port and the user is warned (no crash)

- [x] **Scenario: idempotent connect**
  - **Given** `.mcp.json` already carrying the exact tachyon entry
  - **When** the user runs Connect Agent Runtime → Claude Code again
  - **Then** nothing is written and the user is told it is already registered

- [x] **Scenario: merge preserves foreign servers**
  - **Given** a project `.mcp.json`/`opencode.json` with other MCP servers
  - **When** the tachyon entry is added or its port updated
  - **Then** all other entries survive byte-identically and no confirmation modal blocks the flow

- [x] `settings.bridgePort` validated in loader + JSON Schema (1024–65535)
- [x] Unit coverage: port derivation determinism/range, busy-port fallback, alreadyRegistered detection for both file formats
- [x] Live integration: in the VSCode host, the Bridge port equals the derived port for the fixture workspace

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Bridge authentication (umbrella F3 — separate child).
- Auto-restarting the Bridge when bridgePort changes mid-session — a notification asks for a window reload instead.
- Registering runtimes whose config Tachyon doesn't know — the generic-URL path remains.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design agreed in session._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F12). Friction report: first live demo session 2026-06-09.
