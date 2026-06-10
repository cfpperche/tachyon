# 199 — tachyon-commands

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — shipped with spec 200 in the F15+F21 package; unit 153/153, integration 20 passing (xvfb), live claude -p E2E drove list_commands + run_command pass/fail; residual: none

**UI impact:** render
<!-- Commands view + Studio tab exercised in the xvfb host through the _commands/_runCommand seams; webview internals are covered by the dogfood walkthrough (agent-browser cannot drive VSCode UI). -->

## Intent

Curated one-shot commands (F15, sentinel-inspired): a `commands:` map in `tachyon.yml`
declares named project commands (`test`, `lint`, `build`…) that run once and exit —
the INVERSE lifecycle of agents/terminals, where exiting is the expected outcome
(exit 0 = passed, non-zero = failed). Humans run them from a new sidebar view;
agents run them through the Bridge (`run_command`, blocking until exit) — a vetted,
observable way for agents to execute project procedures instead of typing arbitrary
shell into a terminal pane.

## Acceptance criteria

- [x] **Scenario: declared command runs in its own namespace**
  - **Given** `commands: {test: {cmd: npm test}}` in tachyon.yml
  - **When** the human presses ▶ on the Commands view item (or an agent calls `run_command name=test`)
  - **Then** a `tachyon-cmd-<hash>-test` tmux session runs it — invisible to the AgentManager (no crash toast, no maxAgents slot, absent from list_agents)

- [x] **Scenario: inverted lifecycle — exit is the result**
  - **Given** a running command
  - **When** it exits 0 / non-zero
  - **Then** the sidebar item shows ✓ "exit 0 · Ns" / ✗ "exit N", a pass/fail notification fires (fail carries Inspect), and the dead pane is kept for inspection

- [x] **Scenario: run_command blocks an agent until the result**
  - **Given** a connected MCP agent
  - **When** it calls `run_command name=test`
  - **Then** the call long-polls via the waiters registry (`cmd:` namespace, no agent-side polling) and returns `{passed, exitCode, durationMs, tail}`; a finished result is reported, not re-run, unless `rerun: true`

- [x] **Scenario: re-run semantics**
  - **Given** a finished command pane
  - **When** ▶ is pressed again
  - **Then** the old pane is replaced by a fresh run; a still-running command refuses a concurrent start

- [x] **Scenario: Studio Command tab**
  - **Given** the Agent Studio
  - **When** the third tab (Command) is used with name/cmd/cwd
  - **Then** the entry is written to `commands:` via the comment-preserving yml editor; edit/delete available from the view's context menu (delete warns about runbooks referencing it)

- [x] `list_commands` Bridge tool reports declared commands + states; Stop All also kills command sessions
- [x] i18n complete (en + pt-BR, drift guards green); version bumped to 0.4.0 (tool schema changed)
