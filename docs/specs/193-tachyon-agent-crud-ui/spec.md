# 193 — tachyon-agent-crud-ui

_Created 2026-06-10._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F13** (new row; user-requested 2026-06-10, decided implement+validated+dogfood before F9). Users shouldn't need to hand-edit `tachyon.yml` to manage agents — and the session surfaced a mental-model gap the UI can fix: agent names are free labels (call your claude `frontend`), and the same CLI can back many agents (2 claude, 5 codex). F13 makes the extension a manager of the yml: **✚ New Agent** (name+cmd quick inputs), and per-agent context actions **Clone / Rename / Delete / Edit in tachyon.yml** (cursor on the entry; the schema-validated editor is the advanced form). Non-negotiable principle: **the UI edits the file, never a parallel state** — mutations go through yaml's Document API (`parseDocument`), preserving user comments and formatting outside the touched entry; hand-editing and UI editing stay equivalent (the existing config watcher keeps both coherent). Guardrails: rename requires the agent stopped (sessions carry the old name); delete cleans layout references (a layout losing its last agent is removed, with a warning) and offers to kill a live session; deleting the last agent is refused (a valid config needs one).

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: create from the UI**
  - **Given** the Agents view
  - **When** the user clicks ✚ and answers name+cmd
  - **Then** the entry lands in tachyon.yml (created if missing), the agent appears stopped in the sidebar, and ▶ starts it

- [x] **Scenario: clone — the "5 codex reviewers" flow**
  - **Given** an agent with a full definition (cwd/env/attention/restart)
  - **When** the user clones it under new names repeatedly
  - **Then** each clone carries the complete definition and the config stays valid

- [x] **Scenario: comments survive**
  - **Given** a tachyon.yml full of user comments
  - **When** any UI mutation runs (add/clone/rename/delete)
  - **Then** comments outside the touched entry are preserved byte-for-byte

- [x] **Scenario: delete is consistent**
  - **Given** an agent referenced by layouts and running
  - **When** the user deletes it (modal confirm; force arg for automation)
  - **Then** the session is killed, layout references are cleaned (empty layouts dropped with a warning), and the yml stays valid

- [x] **Scenario: rename safety**
  - **Given** a running agent
  - **When** the user tries to rename it
  - **Then** Tachyon refuses with guidance (stop first); renaming a stopped agent updates layout references

- [x] **Scenario: Edit opens the right place**
  - **When** the user picks "Edit in tachyon.yml"
  - **Then** the file opens with the cursor on that agent's entry

- [x] Deleting the last agent is refused with an actionable message
- [x] Unit coverage: all mutations incl. comment preservation, layout cleanup, error paths, the clone-x5 flow; broken yml is refused, never overwritten
- [x] Live host integration: create → clone → rename → delete through the real commands, asserting yml content and declared agents (fixture restored)

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- A webview form for every field — "Edit in tachyon.yml" with schema validation is the advanced form by design (zero drift with new fields).
- Replicas/templates (`replicas: 5`) — explicitly discussed and replaced by the clone flow; revisit only on real demand.
- Editing layouts/settings from the UI — agents only in v1 of this feature.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design closed in session discussion (file-as-truth, comment preservation, guardrails)._ 

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F13, added 2026-06-10). Origin: user question \"como renomear / como ter 2 claude 5 codex 10 gemini\" + decision to manage the yml from the UI. Sequenced before F9 so per-folder grouping multiplies these actions for free.
