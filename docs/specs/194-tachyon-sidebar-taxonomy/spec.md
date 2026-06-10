# 194 — tachyon-sidebar-taxonomy

_Created 2026-06-10._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F14** (user-approved 2026-06-10, HiveTerm sidebar screenshot as brief). The Agents view mixed AI CLIs, shells and dev servers as identical nodes. F14 introduces a **kind taxonomy** — `kind: agent | terminal` per entry, inferred from the command (known-AI-CLI list: claude/codex/opencode/gemini/aider/…; launchers like npx seen through; explicit `kind:` wins) — and uses it three ways: (1) the sidebar groups entries under **Agents** (🤖 hubot icon) and **Terminals** (▣), each with running counts, state colors preserved; (2) **attention defaults become kind-based** (agents on, terminals off — supersedes the watch-based heuristic); (3) `list_agents` exposes `kind` so orchestrators can address only AI siblings. The F13 create flow gains a kind confirmation quick-pick (writes `kind:` only when it differs from inference, keeping ymls clean). Declared exclusions: per-agent token counts (requires traffic interception — fragile TUI parsing), brand logos (trademark; codicons suffice), commands one-shot (briefed separately as F15), filter box (native type-to-filter exists).

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: inference covers the common cases**
  - **Given** entries running `claude`, `npx codex --yolo`, `/usr/local/bin/gemini`, `npm run dev`, `bash`
  - **When** the config parses
  - **Then** the first three infer `agent`, the last two `terminal`, with no `kind:` written anywhere

- [x] **Scenario: explicit kind wins**
  - **Given** `{cmd: ./bot.sh, kind: agent}` and `{cmd: claude, kind: terminal}`
  - **Then** the declared kind overrides inference, and attention defaults follow the kind (on/off)

- [x] **Scenario: grouped sidebar**
  - **Given** a workspace mixing AI CLIs and terminals
  - **When** the Agents view renders
  - **Then** Bridge + an **Agents** group (hubot icon, running count) + a **Terminals** group (terminal icon, count); state icons (green/bell/idle/crashed red) preserved inside groups; empty groups are hidden

- [x] **Scenario: Bridge exposure**
  - **When** any MCP client calls `list_agents`
  - **Then** each entry carries its `kind`

- [x] kind validated in loader + JSON Schema; invalid values error with path
- [x] Attention default migrates from watch-based to kind-based (documented; npm-dev-server outcome unchanged)
- [x] Unit coverage: inference table (incl. npx/full-path/overrides), attention-by-kind; integration: kind exposure via _agents in the live host
- [x] F13 newAgent flow confirms kind (quick-pick, inferred first) and writes `kind:` only when it differs from inference

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Token counts per agent (needs traffic interception or TUI parsing — fragile, declared out).
- Third-party brand icons (trademark risk; codicons hubot/terminal carry the distinction).
- Commands (one-shot) — briefed as F15, separate decision.
- Sidebar filter box — VSCode TreeViews already type-to-filter natively.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design approved in session with declared exclusions._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F14). Brief: HiveTerm sidebar screenshot (AGENTS/TERMINALS/COMMANDS/SPLITS sections) 2026-06-10.
