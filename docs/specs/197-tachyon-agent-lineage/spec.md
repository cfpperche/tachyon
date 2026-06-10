# 197 — tachyon-agent-lineage

_Created 2026-06-10._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F18** (user observation from the HiveTerm demo video: spawned agents nest under their spawner in the sidebar). Tachyon could already spawn agents from agents (spawn_agent, since v1) but lost the genealogy — everything rendered flat. F18 adds **lineage**: `spawn_agent` gains `parent` (self-declared by the caller — the Bridge is stateless and does not authenticate per-call identity, same honest limitation as pin authorship; the tool description instructs agents to ALWAYS pass it) and `instructions` (role prompt for ad-hoc spawns, reusing F16's composeCommand delivery — spawn a reviewer with its role in one call instead of spawn+write_input). The AgentManager records child→parent in session-local memory (like ad-hoc defs: tmux sessions survive an extension restart, genealogy does not — documented); `list_agents` and the sidebar expose it: **children nest under their parent** (regardless of kind — lineage wins inside the tree), with a "spawned by X" description; a dead parent's children are **promoted to the root** (kill never cascades — sessions are independent, explicit decision); killing a child clears its entry.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: agent spawns with lineage**
  - **Given** an orchestrating agent connected to the Bridge
  - **When** it calls `spawn_agent` with name/cmd/`parent=<itself>`
  - **Then** the child runs, nests under the parent in the sidebar with "spawned by X", and `list_agents` carries `parent`

- [x] **Scenario: instructions in one call**
  - **When** `spawn_agent` includes `instructions`
  - **Then** the ad-hoc child's command carries the POSIX-quoted role prompt (composeCommand path, known CLIs)

- [x] **Scenario: orphan promotion, never cascade**
  - **Given** a parent with running children
  - **When** the parent is killed
  - **Then** children keep running and are promoted to the root of their group; killing a child clears its lineage entry

- [x] Lineage is session-local memory (documented like ad-hoc defs); self-declared parent recorded only when ≠ own name
- [x] Unit coverage: lineage record/expose/promote/clear, instructions delivery on ad-hoc spawn; Bridge MCP round-trip of parent
- [x] Live host integration: `_spawn` with parent → `_agents` carries it (real tmux child)
- [x] Live E2E: real `claude -p` as 'orchestrator' spawned `morning` with parent, read it back via `list_agents`, killed it

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Authenticated caller identity (per-call) — would require per-agent tokens; parent stays self-declared like pin authorship.
- Cascade kill / supervision trees — children are independent sessions by design; the parent's death promotes, never kills.
- Persisting genealogy across extension restarts.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design closed in the F18 discussion._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F18). Brief: HiveTerm demo video (bee spawned, nested under spawner).
