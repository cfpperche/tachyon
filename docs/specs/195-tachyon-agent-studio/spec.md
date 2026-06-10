# 195 — tachyon-agent-studio

_Created 2026-06-10._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F16** (user-requested with HiveTerm's Add-agent modal as brief, 2026-06-10; decided before F9). The two-input ✚ flow is fine for quick adds but can't express what agent creation really is: defining a ROLE. F16 adds the **Agent Studio** — a webview form (the official UX guidance says quick-picks must not become wizards; the official webview-ui-toolkit was deprecated Jan/2025, so the form is hand-rolled HTML/CSS over --vscode-* theme variables, dependency-free). Fields: quick-add chips for AI CLIs **detected on the machine** (which over KNOWN_AI_CLIS), name with live validation, command with **per-runtime flag chips** (FLAG_SUGGESTIONS map), **Instructions** (new `instructions:` yml field — delivered as a startup positional prompt for claude/codex/gemini via a per-runtime arg map with POSIX-safe quoting; stored-but-not-delivered with an informational note otherwise), working dir with Browse, kind toggle (pre-set by F14 inference), autostart/restart/attention. Edit mode opens the same form pre-filled (right-click → Edit Agent…). Architecture discipline: ALL logic lives outside the HTML — formLogic.ts (validate/toEntry/flags/suggestName) and YamlConfigEditor.upsertAgent (comment-preserving full-def create/edit/rename-with-layout-updates); the webview renders and relays. toEntry writes only non-default fields, keeping ymls clean. The quick flow survives as the palette command.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: create a role from the form**
  - **Given** the Agent Studio opened from ✚
  - **When** the user picks a detected CLI chip, toggles flags, writes instructions and saves
  - **Then** a full entry lands in tachyon.yml (only non-default fields), comments elsewhere preserved, and the agent appears in the sidebar

- [x] **Scenario: instructions become a startup prompt**
  - **Given** an agent with `instructions:` and a known CLI (claude/codex/gemini)
  - **When** it spawns
  - **Then** the command carries the POSIX-quoted positional prompt (gemini via -i); unknown CLIs spawn unmodified and the form shows a non-blocking note

- [x] **Scenario: edit in place**
  - **Given** right-click → Edit Agent… on a declared agent
  - **When** the pre-filled form is changed and saved (including a rename)
  - **Then** the entry is rewritten in place; renames update layout references with warnings

- [x] **Scenario: validation blocks bad submits**
  - **Given** a duplicate or invalid name, or an empty command
  - **When** the user submits
  - **Then** blocking errors render in the form and nothing is written

- [x] Quick-add chips list only CLIs actually installed (injectable probe; cached)
- [x] Unit coverage: composeCommand delivery+quoting (incl. hostile input), formLogic (flags toggle, suggestName, validate/blocking, toEntry defaults-omission, fromDef round-trip), upsertAgent (create/edit/rename/comments), cliDetect
- [x] Live host integration: the _upsertAgent pipeline (create, duplicate-blocked, edit-in-place) + the Studio webview tab opens
- [x] Quick two-input flow retained as palette command; ✚ opens the Studio

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Component library dependency (vscode-elements) — 8 controls don't justify it; hand-rolled CSS over theme variables.
- Driving the webview HTML headlessly in CI — logic is extracted and unit-tested; the HTML is dogfood-verified.
- Instructions via post-spawn write_input for unknown CLIs — fragile readiness detection; explicitly not done.
- Editing layouts/settings in the Studio — agents only.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — both open decisions resolved in session (instructions in v1 with positional delivery; Studio coexists with the quick flow)._ 

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F16). Brief: HiveTerm Add-agent modal screenshot.
- Research: webview-ui-toolkit deprecated Jan/2025 (github.com/microsoft/vscode-webview-ui-toolkit/issues/561); UX guidance quick-picks-not-wizards (code.visualstudio.com/api/ux-guidelines/quick-picks).
