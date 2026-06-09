# 186 — tachyon-vscode-extension — notes

_Created 2026-06-09._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention. See `.agent0/context/rules/spec-driven.md` § The four artifacts for purpose, and `.agent0/context/rules/delegation.md` § The 5-field handoff for how sub-agents integrate._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body. `<author>` is `parent` for the orchestrating agent, or the `subagent_type` (e.g. `general-purpose`, `Explore`) for delegated work.

**Routing rubric:** decision made under ambiguity → §1 Design decisions. Intentional departure from `plan.md` → §2 Deviations. Alternative weighed and chosen mid-flight → §3 Tradeoffs. Question surfaced during build, no answer yet → §4 Open questions. Sections may stay empty; the rubric is a guide, not a quota.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision itself + why this option over others considered in the moment._

### 2026-06-09 — parent — tmux pane-target syntax: `=name` for sessions, `=name:` for panes

`-t =<session>` (exact-match prefix) works for session-target commands (`has-session`, `kill-session`, `attach-session`) but **fails for pane-target commands** (`capture-pane`, `send-keys`) with `can't find pane: =name`. The correct exact pane target is `=<session>:` (trailing colon = that session's active window/pane). Caught by the real-tmux test suite on first run; TmuxService now uses `=name` for session targets and `=name:` for pane targets, with unit tests pinning both shapes.

### 2026-06-09 — parent — task 5 spike findings: capture-pane vs a real Claude Code TUI

Ran `claude` headless in a tmux session (`tmux -L tachyon-spike new-session -d`), captured after render:

- **Visible-pane capture is clean and correct.** `capture-pane -p -t '=s:'` returned exactly what a human sees (Claude Code's trust prompt) as plain text, no escape garbage. The plan's `read_output` default (visible pane) is right for TUI agents.
- **Alt-screen has no scrollback.** `-S -200` returned the same 11 visible lines — full-screen TUIs keep no pane history, so the `lines` param of `read_output` silently degrades to the visible capture for TUI agents. It works as expected for plain CLI/server agents (verified in tmux.real.test.ts with 100 lines of history). Not an error; plan's semantics confirmed.
- **send-keys reaches the TUI.** Sending `Escape` at the trust prompt made Claude Code exit, which killed the tmux session — confirming input lands and that session liveness (`hasSession`) is a truthful process-liveness signal.

### 2026-06-09 — parent — environment facts

tmux 3.6 on WSL2 (Ubuntu), node 24, xvfb-run available. `-e` env injection on `new-session` verified end-to-end against real tmux (test asserts `$TACHYON_TEST_VAR` visible inside the session) — min tmux pinned at 3.2 for this flag.

## Deviations

_Places where implementation intentionally departed from `plan.md`. The departure + the reason it was necessary or better._

## Tradeoffs

_Alternatives weighed during implementation (not at plan time). The chosen path + what was given up + why the tradeoff was worth it._

## Open questions

_Questions surfaced during build that the implementer couldn't resolve alone. Owner (who decides) or path to resolution if known. Promote answered questions to `spec.md` § Open questions or as retroactive acceptance scenarios when the spec is updated._

## Verification log

### 2026-06-09T22:11:38Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'` — pass
