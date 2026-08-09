# 298 — codex-isolated-harness

_Created 2026-06-30._

**Status:** shipped

**Closure:** Shipped 2026-06-30 (commit `30b59f0`, `feat(harness): support codex isolated homes`). `ResumeAdapter.harness` was generalized so a runtime can materialize MCP by CLI flag (Claude, unchanged) or by writing scoped config directly into a redirected home (Codex: `CODEX_HOME` + `config.toml`, no MCP args). Codex gained isolated-harness and `isolate: "transcript"` support, auth symlinking, config validation, and redirected session/resume/activity resolution — all acceptance criteria and tasks checked. Re-verified against current `HEAD` at close time (not just the original implementation commit): `npm test && npx tsc --noEmit` and the focused harness/agentManager/resume dogfood slice both pass (logged in `notes.md`). Real authenticated-Codex-TUI dogfood under a redirected home remains a noted open item (see `notes.md`'s Open questions), not a blocker — resolves pin `p-00ca60`.

**Verify:** `npm test && npx tsc --noEmit`
**Dogfood:** `npm test -- --run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts`

## Intent

The **isolated-harness** and **isolate-transcript** capabilities are claude-only today. Both are the same
underlying mechanism — a **per-agent redirected config home** — surfaced as two depths:

- **Isolated harness** (spec 226): scope an agent's MCP / skills / rules / hooks to a private config home so
  no sibling agent sees them. Claude wires this via `CLAUDE_CONFIG_DIR` + `--mcp-config <file> --strict-mcp-config`.
- **Isolate transcript** (spec 240): the lightweight subset — own transcript namespace, no MCP/skills isolation,
  project config + login still apply. Claude wires this via `CLAUDE_CONFIG_DIR` only (`materializeHomeOnly`).

The runtime is gated by a single capability slot: `ResumeAdapter.harness` (`src/resume/adapters.ts:64-73`). The
**claude** adapter fills it (`:173-178`); the **codex** adapter leaves it empty (`:187-192`), so `harnessable()`
returns false and any `harness:`/`isolate:` on a codex agent is a config-time error
(`src/config/loadConfig.ts:308`, `src/harness/HarnessManager.ts:222`). Spec 226 named codex (`CODEX_HOME`) a
deliberate follow pass once the primitive was proven; it is now proven and shipped for claude across the whole
plugin migration. This spec closes that follow pass: **fill the harness capability slot for codex** so a codex
agent can run with an isolated harness and/or an isolated transcript, exactly as a claude agent can.

"Done" = a codex agent declared with `harness:` (or `isolate: "transcript"`) spawns into a private `CODEX_HOME`
tree; its MCP servers / transcripts are scoped to that home; sibling codex (and claude) agents in the same
folder are unaffected; resume finds the agent's transcript under the redirected home.

### The codex wrinkle (why this is not a copy-paste of claude)

The `harness.mcpArgs(path)` field assumes the runtime scopes MCP by a **CLI flag** pointed at one config file
(claude's `--strict-mcp-config`). Codex has **no such flag** — it reads MCP from `[mcp_servers.*]` blocks in
`$CODEX_HOME/config.toml`. So for codex, **redirecting `CODEX_HOME` already scopes MCP** (the config.toml in the
private home is the only one read); there is no separate "strict" argument and no `--mcp-config` path to pass.
This means the current `harness` shape is claude-shaped and must be **generalized** (see Open questions) — the
materialization writes a `config.toml` into the home instead of an `mcp.json` + returning args.

## Acceptance criteria

- [x] **Scenario: codex agent with an isolated harness spawns into a private home**
  - **Given** a codex agent declared with a `harness:` block (mcp + at least one of rules/skills/hooks)
  - **When** it is spawned
  - **Then** it runs with `CODEX_HOME` pointed at `.tachyon/harness/<agent>/`, its `config.toml` carries the
    declared (+ inherited, if `inherit: workspace`) MCP servers, and the bridge MCP is injected
- [x] **Scenario: MCP isolation holds between siblings**
  - **Given** two codex agents in the same folder, one with a harness declaring server X and one without
  - **When** both are running
  - **Then** only the harness agent sees server X; the plain agent sees only the workspace MCP
- [x] **Scenario: isolate-transcript subset works for codex**
  - **Given** a codex agent declared with `isolate: "transcript"` (no harness)
  - **When** it is spawned
  - **Then** it gets a private `CODEX_HOME` for transcript attribution, but the workspace MCP/config still apply
    (no strict MCP scoping)
- [x] **Scenario: resume finds the redirected transcript**
  - **Given** a harness/isolate codex agent that has produced a session, then is resumed
  - **When** Tachyon resolves its transcript
  - **Then** it looks under the redirected `CODEX_HOME` (not `~/.codex`) and resumes the correct session
- [x] **Scenario: secrets resolve from ${VAR} / .env, fail-closed**
  - **Given** a codex harness whose MCP env references `${SOME_SECRET}`
  - **When** the secret is present in process env or the workspace `.env`
  - **Then** it is resolved into the spawned process env; **and when absent**, materialization fails closed with
    a clear error (no half-written home)
- [x] `harnessable(codexAdapter)` returns true; a `harness:` / `isolate:` on a codex agent is no longer a config error
- [x] The harness capability shape supports a runtime that scopes MCP **by config-file-in-home** (codex), not only
      **by CLI flag** (claude) — without regressing the claude path
- [x] **Verify:** `npm test && npx tsc --noEmit` (unit suite + typecheck green)

## Non-goals

- **Codex fork** (`--fork-session` equivalent) — codex has no native fork primitive; blocked upstream, not this spec.
- **Session-id minting / deterministic transcript path for codex** — codex stays capture-based; resume keeps its
  disk-scan path (only the scan ROOT changes to the redirected home).
- **Budget / cost / refusal observability in the probe** — separate codex gap, upstream-shaped, not here.
- **Gemini / other runtimes' harness** — still deferred; this spec proves the second (codex) harness only.
- **`inherit: global`** — followed claude's lead; out of scope unless trivially free.
- **product-foundation codex orchestration port** (spec 294 fast-follow) — depends on dispatch enforcement, not on
  the harness; a separate later spec.

## Open questions

- **OQ1 — generalize the `harness` adapter shape. RESOLVED** (see `plan.md`'s "Approach"/"Key decisions"): the
  claude-specific `mcpArgs` path stays flag-based; codex materializes `config.toml` directly into the redirected
  home and returns no MCP args — `HarnessManager` branches per adapter, not on a new discriminant field.
- **OQ2 — codex's real paths. RESOLVED** (`notes.md`): confirmed against the installed `codex-cli 0.142.4` —
  `$CODEX_HOME/config.toml`, `auth.json`, `sessions/`.
- **OQ3 — auth seeding. RESOLVED** (`plan.md`): `auth.json` is symlinked, mirroring Claude's `.credentials.json`
  approach. `notes.md` flags that this is proven by unit test + SDD dogfood but not yet a real authenticated
  Codex TUI session under a redirected home — left as a noted follow-up, not a blocker.
- **OQ4 — TOML merge fidelity. RESOLVED** (`plan.md`): reuses the existing tested `[mcp_servers.<name>]` TOML
  writer; `isolate: transcript` copies the current config into the private home instead of attempting a live merge.
- **OQ5 — hooks/skills/rules parity. RESOLVED** as a deliberate non-goal: codex harness support
  is MCP/config/transcript only. `rules`/`skills`/`hooks` on a codex harness fail validation until their native
  Codex materialization paths are specified and dogfooded in a follow pass.
