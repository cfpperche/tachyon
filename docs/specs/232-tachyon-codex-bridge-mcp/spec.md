# 232 — tachyon-codex-bridge-mcp (DESIGN — debate before code)

_Created 2026-06-18._

**Status:** draft
handoff + persona all validated) but the **`review` node hung** — its declared agent is `reviewer:
cmd: codex`, and the codex session had **no `complete_node` MCP tool**, so it could not signal completion
and the node would sit until its 15m timeout. Root cause (confirmed): the example repo's `.codex/
config.toml` is **empty** while `.mcp.json` registers the Tachyon Bridge for claude — so claude pipeline
nodes (`planner`/`builder`, both `cmd: claude`) signalled fine, but the codex node had no Bridge. Goal:
make a **codex `agent:` node a first-class pipeline node** by provisioning the Tachyon Bridge MCP to codex
agents Tachyon spawns, so `complete_node` is reachable.

> **codex adversarial review (gpt-5.5 high, read-only) — 2026-06-18 → CHANGES → all folded** (transcript
> `/tmp/codex-232-out.json`). Two findings I then verified LIVE against codex 0.141.0, which CHANGED the
> mechanism:
> - **B1 (the `-c` collision) — confirmed AND codex's own fix disproven.** With a pre-existing stdio
>   `[mcp_servers.tachyon]` in the user config, BOTH dotted overrides AND an inline-table override under
>   the SAME name fail: `Error: url is not supported for stdio` (the `-c` merges, never replaces). **Fix:
>   use a collision-resistant Tachyon-owned server name** — verified: `-c 'mcp_servers.tachyon_bridge=
>   {url="…", bearer_token_env_var="TACHYON_BRIDGE_TOKEN"}'` adds a clean `streamable_http` server even
>   alongside a user's stdio `tachyon`.
> - **B2 (approval) — promoted into the contract.** codex's approval flags (`--ask-for-approval`, sandbox)
>   govern model-generated SHELL commands, not MCP tool calls; the dogfood codex (Full Access) was
>   tool-call-ready (it only lacked the tool). Phase 1 now MANDATES + PROVES the unattended-MCP-call mode
>   (the re-dogfood is the gate) with a documented fallback if it can't.
>
> Also folded: M1 evidence-based preflight; M2 narrowed token claim + pre-existing tmux-argv note; M3
> scope = pipeline codex nodes first (NOT all codex agents); M4 inject in the SHARED final command path
> (spawn/restart/resume/fork); MINOR `withCodexBridge` as a tested pure helper.

Next: `plan` → build → re-dogfood.

## Capability research — VERIFIED LIVE (codex 0.141.0, `feedback_verify_runtime_capabilities`)

Not assumed — checked against the installed CLI:
- **codex supports streamable-HTTP MCP servers with a bearer token from env.** `codex mcp add <name>
  --url <URL> --bearer-token-env-var <ENV>` writes, and `codex mcp get` reports `transport:
  streamable_http`, `enabled: true`. The generated `~/.codex/config.toml` block is exactly:
  ```toml
  [mcp_servers.tachyon]
  url = "http://127.0.0.1:<port>/mcp"
  bearer_token_env_var = "TACHYON_BRIDGE_TOKEN"
  ```
  This is the SAME shape Tachyon already generates for its copy-paste recipe (`adapters.ts:110`
  `codexTachyonBlock`).
- **Per-spawn config override exists:** `codex -c '<dotted.key>=<toml-value>'` overrides any config key
  (nested merge), e.g. `-c 'mcp_servers.tachyon.url="…"'`. No file mutation.
- **`CODEX_HOME` selects the config dir** (+ `-p <name>` layers `$CODEX_HOME/<name>.config.toml`) — the
  codex analog of the spec-226 `CLAUDE_CONFIG_DIR` redirect (`configHome`, `AgentManager.ts:112`).
- **Tachyon already injects `TACHYON_BRIDGE_URL` + `TACHYON_BRIDGE_TOKEN` into every spawned session**
  (`AgentManager.ts:100`) — so a codex agent ALREADY has the token in its env; it just lacks the MCP
  server registration that would USE it.

So the gap is narrow: register the Bridge MCP server for codex sessions Tachyon spawns. All the inputs
(URL, token-env, the TOML shape) already exist in the codebase.

## Options (evaluated)

**A. Per-spawn `-c` override, UNIQUE server name (RECOMMENDED — revised per codex B1).** When Tachyon
spawns a **codex** agent that needs the Bridge and the Bridge is running, append ONE inline-table override
under a **Tachyon-owned name** that won't collide with a user's `mcp_servers.tachyon`:
```sh
codex -c 'mcp_servers.tachyon_bridge={url="<bridgeUrl>", bearer_token_env_var="TACHYON_BRIDGE_TOKEN"}' …
```
URL is known at spawn (`bridgeUrl()`); the token stays in env (already injected, `AgentManager.ts:100`) and
is referenced indirectly via `bearer_token_env_var` — **never on the command line**. Ephemeral, no file
written, no user config touched. **Verified live (codex 0.141.0):** this adds a clean `streamable_http`
server even when the user already has a stdio `[mcp_servers.tachyon]` (the same-name override fails with
`url is not supported for stdio` — hence the distinct name). The exposed tool may be namespaced under the
server (e.g. `tachyon_bridge`/`complete_node`); the node guidance already names `complete_node`, which the
model resolves (the dogfood codex reasoned about "Tachyon/complete_node").

**B. `CODEX_HOME`-redirected managed `config.toml`.** Materialize a managed config dir (like claude's
`configHome`) with the `[mcp_servers.tachyon]` block (reuse `codexTachyonBlock`). Heavier (manage a dir,
inherit the user's base config, materialize per agent). This is the **codex isolated-harness analog** and
the natural home for the FULL codex harness (own skills/rules/MCPs) — the documented "codex CODEX_HOME
support is a follow pass." Out of scope here except as the Phase-2 direction.

**C. Auto-write the project `.codex/config.toml`** via the existing adapter. Rejected for auto use: it
mutates a user-owned file (the recipe is deliberately copy-paste/opt-in), and a project-shared file is the
wrong granularity. Stays the MANUAL recipe for external/standalone codex sessions.

**Recommendation:** **A** for the engine (auto, per-spawn, fail-closed), scoped to codex agents Tachyon
spawns while the Bridge is up; keep **C** as the manual recipe; reserve **B** for the codex-harness follow.

## Companion — a Bridge-reachability preflight (the real fix for "silent hang")

Even with A, a signal-based node whose agent can't reach the Bridge must NOT hang to timeout silently. Add
a **pipeline-start preflight** — but it must be **evidence-based, not optimistic** (codex M1: a naive
"claude is fine" check lies, because Tachyon injects env globally but never proves the project `.mcp.json`
exists or points at THIS Bridge). For each `done: signal | signal_then_verify` node, `nodeCanSignal(def)`
returns one of three verdicts:
- **codex** → **provable yes** (Tachyon injects `tachyon_bridge` via A).
- **claude** → inspect the actual project `.mcp.json` for a `tachyon` server entry pointing at this
  Bridge. Present → yes. Absent/mismatched → **unprovable**.
- **other / unprovable** → unprovable.

A node that is **provably unable** to signal (e.g. a runtime with no Bridge path) **fails the run closed at
start** with a precise reason. An **unprovable** node (claude with no detectable `.mcp.json`) emits a
**blocking warning with a fix** ("register the Bridge: `Tachyon: …` / add `.mcp.json`") rather than a false
"it's fine" — the human decides to proceed or wire it. No more doomed silent runs.

## Design — phased

### Phase 1 — codex Bridge access (this spec)
1. **`withCodexBridge(cmd, url): string` — a pure, tested helper** (kept OUT of the vscode layer,
   `feedback_logic_in_vscode_layer_escapes_ci`): given a codex command string + the Bridge URL, returns the
   command with the unique-name inline-table `-c` override inserted, using `shellQuote` for the value.
   No-op for a non-codex `cmd` or when the URL is absent. Test matrix (codex MINOR): plain `codex`, `codex
   exec`, a prompt arg containing quotes, and a user config with a pre-existing stdio `tachyon` (the
   collision case — proven safe by the distinct name).
2. **Wire it into the SHARED final command-building path** used by EVERY lifecycle entry — spawn, restart,
   resume, fork (codex M4: `AgentManager` has separate paths at ~474/715/827/1006; injecting only at spawn
   would let a restarted/resumed codex node lose the Bridge). Gated by runtime==codex && Bridge up.
3. **Scope = signal-based pipeline codex nodes (codex M3).** Default injection to codex agents spawned AS a
   `done: signal|signal_then_verify` pipeline node — NOT every codex agent (the full Bridge surface
   includes `spawn_agent`/`kill_agent`/`write_input`; handing that to every codex agent by default is too
   broad). A per-agent/config opt-in for broader codex Bridge access is a follow.
4. **Approval-mode contract (codex B2).** Phase 1 spawns the codex pipeline node in a mode where MCP tool
   calls fire **unattended** (the dogfood codex ran "Full Access" and was tool-call-ready). Acceptance =
   the re-dogfood actually observing `complete_node` fire. **Fallback if it can't:** model the codex review
   node as a headless **`cmd: codex exec … ; done: exit`** node (exit-based, no signal needed) — documented
   so the feature degrades instead of hanging.
5. **Evidence-based preflight** (§ above) at `startPipeline`: pure `nodeCanSignal(def, runtimeOf, bridgeUp,
   mcpJsonProbe)`; fail-closed on provably-can't, blocking-warn on unprovable.
6. **Re-dogfood** `feature-issue` with the codex `reviewer` → `complete_node` fires → parks at the approval
   gate → human approves → run completes. (The exact scenario that hung today.)

### Phase 2 — follow (not this spec)
7. **codex isolated harness via `CODEX_HOME`** (the spec-228 analog): own MCPs/skills/rules for a codex
   agent through a managed config home. Reuses `codexTachyonBlock` + the option-B materialization.
8. **Broader codex Bridge access** — a per-agent/config opt-in to give a non-pipeline codex agent the
   Bridge (the full surface), once there's a demand for it.

## Risks / to verify in `plan`/build
- **Approval-mode (codex B2) — the one to PROVE.** Resolved in design as a Phase-1 contract (§ Design 4)
  with the re-dogfood as the gate + a `codex exec`/`done: exit` fallback; the BUILD must observe
  `complete_node` actually fire from the codex node before claiming done. codex's `-a`/sandbox flags govern
  shell commands, not MCP calls — confirm empirically that the chosen spawn mode lets MCP tools fire
  unattended.
- **`-c` inline-table quoting through tmux** — the value is a TOML inline table with nested `"`; it must
  survive `shellQuote` + the single tmux command string. Covered by `withCodexBridge`'s test matrix; the
  dogfood confirms end-to-end.
- **Collision — RESOLVED by the distinct name** (verified: a same-name override errors on a stdio
  pre-existing entry; `tachyon_bridge` is clean). Watch: if the user ALSO has a working `tachyon` server,
  codex now connects to both — redundant, harmless (tools exposed twice; the node guidance names the tool).
- **Token exposure (codex M2).** The codex `-c` overlay carries the URL but NOT the token (indirect via
  `bearer_token_env_var`) — add a regression test that the composed codex command contains no token. SEPARATE
  PRE-EXISTING issue (out of scope, track it): Tachyon delivers env via `tmux new-session -e KEY=VALUE`
  (`TmuxService.ts:484`), so `TACHYON_BRIDGE_TOKEN` can appear briefly in the `tmux` process argv — a
  workspace-wide threat-model item, not introduced here.
- **Start ordering** — the preflight gates on `bridgeUp`; confirm a codex node spawns only after the Bridge
  is listening (it does today for the orchestrator).

## Non-goals
- The full codex isolated harness (skills/rules/own MCPs) — Phase 2 via `CODEX_HOME` (option B).
- Per-tool Bridge scoping (give codex ONLY `complete_node`) — the Bridge is one server exposing all tools.
- Giving EVERY codex agent the Bridge by default — Phase 1 is scoped to signal-based pipeline nodes (M3).
- OAuth MCP login (`codex mcp login`) — the Bridge uses a static bearer token from env, no OAuth.
- Auto-writing the user's project `.codex/config.toml` (option C stays the manual recipe).
- Fixing the pre-existing tmux `-e` argv token exposure (tracked separately).

## Decision gate (most folded by the codex review)
1. **Mechanism = Option A with a unique server name** (`tachyon_bridge`, inline-table `-c`) — locked by the
   live B1 finding (same-name `-c` is unsafe). `CODEX_HOME` (B) stays the harness follow.
2. **Scope = signal-based pipeline codex nodes only** (revised per M3; not all codex agents). — confirm.
3. **Preflight ships with Phase 1** (evidence-based, M1) — recommend yes.
4. **Approval-mode** proven by the re-dogfood, with the `codex exec`/`done: exit` fallback (B2). — confirm.
After maintainer sign-off → `plan` → build → re-dogfood.
