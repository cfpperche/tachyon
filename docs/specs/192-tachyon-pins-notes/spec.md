# 192 — tachyon-pins-notes

_Created 2026-06-10._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F4**, decided "implement (lean), validated, dogfood prepared" (user, 2026-06-10) after the honest markdown-file critique was weighed — the 20% the feature buys over an agreed NOTES.md: a live sidebar checklist (no file open), structured tools that work for ANY MCP runtime with zero convention agreement, and human pinning from the UI. Design: shared human↔agent project memory as **plain workspace files** — `.tachyon/pins.json` (structured checklist: id, text, by, createdAt, done) and `.tachyon/notes.md` (free-form whiteboard) — so every consumer has a door: sidebar **Pins** section (TreeView checkboxes, ✚ add via input box, 🗑 delete, Notes shortcut), **5 new Bridge tools** (`create_pin`, `list_pins`, `complete_pin`, `get_notes`, `set_notes` — 12 total now), plain file reads for MCP-less agents, and git-trackability as the project's choice. A `.tachyon/*` watcher keeps the sidebar coherent with manual edits; tool mutations refresh it via callback.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: agent pins a finding**
  - **Given** an agent connected to the Bridge
  - **When** it calls `create_pin` with a discovery
  - **Then** the pin lands in `.tachyon/pins.json`, appears in the sidebar checklist with authorship, and any agent's `list_pins` returns it

- [x] **Scenario: human round-trip**
  - **Given** the Pins sidebar section
  - **When** the human adds a pin (✚/command), checks its checkbox, or deletes it
  - **Then** the file reflects each action (checkbox → done: true), and completed pins sink below open ones

- [x] **Scenario: notes as coordination whiteboard**
  - **Given** an orchestrating agent
  - **When** it calls `set_notes` with work-division state
  - **Then** `get_notes` (any agent) and `.tachyon/notes.md` (any reader) return it; the sidebar Notes item shows the first line and opens the file on click

- [x] **Scenario: doors stay coherent**
  - **Given** a manual edit to `.tachyon/pins.json` (or a corrupt one)
  - **When** the watcher fires
  - **Then** the sidebar refreshes (a corrupt file shows a warning item with the parse error, not a crash)

- [x] 12 Bridge tools total; pin tools validate input (id shape, text bounds) and return structured isError on unknown ids
- [x] Unit coverage: PinStore CRUD/persistence/corrupt-file errors/notes round-trip; MCP round-trip of all 5 tools onto real files
- [x] Live host integration: `tachyon.addPin` → `_pins` → file persisted (fixture cleaned after)
- [x] Live E2E: real `claude -p` through the authed Bridge created a pin, listed it, set and read notes — file door verified byte-level against the tool door

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Pin-from-terminal-selection (terminal selection API is uneven across VSCode versions) — pins come from the ✚ command or agents in v1.
- Pin metadata beyond the lean shape (tags, priorities, assignees, links) — YAGNI until dogfood demands.
- Cross-workspace pins; notes append semantics (set_notes replaces; tools are told to get-then-merge).

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design closed in the F4 discussion (storage location, file shapes, the four doors)._ 

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F4). HiveTerm parity: pins/list_pins/create_pin/set_notes. Decision context: the markdown-file critique and the four-doors rationale (session 2026-06-10).
