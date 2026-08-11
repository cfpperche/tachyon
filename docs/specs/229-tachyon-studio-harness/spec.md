# 229 — tachyon-studio-harness

_Created 2026-06-17._

**Status:** in-progress
**Status detail:** in-progress — IMPLEMENTED 2026-06-17 — 573 unit tests + typecheck + build green. NOT yet shipped.
Makes an isolated-harness agent **first-class to create** — via Agent Studio, not only by hand-editing
`tachyon.yml`. Surfaced in dogfood ("how do I create a harness agent?"): the Studio form already
supports `role`/`worktree`/`verify`, but not `harness`, so harness agents were yaml-only.

**UI impact:** ui (a new "Isolated harness" section in the Agent Studio form).

**Locked decision (maintainer):** add a Studio section (not a scaffold command) — consistent with
worktree/verify being editable in the form.

## Design
A new **"Isolated harness"** `<details>` section in the Studio form, mirroring the worktree section.
It is **claude-agent-gated**: shown only when the kind is `agent` AND the `cmd` is claude (a
`syncHarnessUI()` re-runs on every cmd change — type / CLI chip / flag toggle / prefill — and on tab
change; it sees through `env`/`npx`/flag tokens). Non-claude runtimes never see it; `validateForm`'s
`harness-claude-only` is the backstop. The LOGIC lives in `formLogic.ts` (pure, unit-tested);
`AgentForm.ts` (the webview) is a thin rendering (per `feedback_logic_in_vscode_layer_escapes_ci`).

- **`FormState`** gains `harness` (toggle), `harnessInherit` (`workspace`/`none` select), `harnessMcp`
  + `harnessHooks` (YAML textareas — structured config as text), `harnessRules` + `harnessSkills`
  (path-per-line textareas, like `worktreeSetup`).
- **`toEntry`** builds the `harness:` yaml entry (parses the YAML textareas via `parseYamlObject`,
  the path lists via `parseSteps`); omits empty sub-keys.
- **`validateForm`** catches the obvious mistakes early (claude-only, malformed mcp/hooks YAML, empty
  harness); the deep rules (`${VAR}`-only mcp env, reserved cmd flags) stay enforced by `loadConfig`
  on write (authoritative).
- **`fromDef`** round-trips an existing harness agent back into the form (mcp/hooks → YAML text for
  editing), so Edit works.

## Non-goals
- A repeating-row editor for the MCP server map / hooks object — YAML textareas are the pragmatic v1
  (structured config reads naturally as text; the same way the user would write it in `tachyon.yml`).
- A palette scaffold command (the rejected alternative).
- codex `CODEX_HOME` / `inherit: global` (still the harness follow passes).
