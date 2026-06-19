# 236 — every Tachyon-spawned agent reaches the Bridge (deterministic inline injection) — PLAN (for review)

_Created 2026-06-19; **revised** after the maintainer surfaced that runtimes accept ADDITIVE inline MCP.
Pin `p-c3ff9a`. Plan only — codex re-reviews this revised plan. (v1 of this plan used a "Configure" nudge;
dropped — see below.)_

## codex v2 re-review folds (PLAN-NEEDS-CHANGES; v2 confirmed directionally better)
- **BLOCKER — resume isn't covered.** `maybeCodexBridge` runs at spawn + restart only; `resume()` builds
  `adapter.resumeCommand` and skips it (`AgentManager.ts:473/733/846`). **Fix:** factor ONE shared
  bridge-injection step applied at spawn + restart + resume (for codex AND claude non-harness).
- **MAJOR — flag placement.** Insert the runtime flag (`--mcp-config` / `-c`) **after the binary, before the
  prompt positional** (`composeCommand` appends the prompt last, `loadConfig.ts:153`). Test with
  `instructions`, `--resume`, `--continue`, and a user-supplied `--mcp-config`/`--strict-mcp-config`.
- **MAJOR — claude file lifecycle + gitignore.** Deliver via a temp file under
  `.tachyon/bridge-mcp/<agent>.json`; add it to the init gitignore (`initLogic.ts:112` only ignores
  `sessions.json` + `harness/`) and GC it like harness homes.
- **MAJOR — codex injection must be idempotent.** `codexBridgeCmd` (`loadConfig.ts:142`) blindly splices;
  no-op/replace if the cmd already carries `mcp_servers.tachyon_bridge`.
- **MAJOR — update the pipeline preflight.** `nodeCanSignal` (`preflight.ts:29`, `Workspace.ts:756/795`)
  treats claude as wired only if the project `.mcp.json` has `tachyon` — now contradicted by deterministic
  injection. **Fix:** a Tachyon-spawned claude/codex node is "ok" when the Bridge URL is live (it gets injected).
- **MINOR — reserved-name consistency.** Use `tachyon_bridge` for ALL injected entries (codex + claude); the
  Bridge owns that name. Reserve `harness.mcp.tachyon_bridge` (and `tachyon`) in `parseHarness` (`loadConfig.ts:304`).
- **Decisions from the open-Qs:** (Q2) **use the temp FILE** for claude (`${VAR}` string interpolation is
  NOT proven on the installed claude 2.1.183 — file always env-interpolates → no token on argv). (Q3) distinct
  `tachyon_bridge`; optionally skip injection if the project's `tachyon` already points at this exact Bridge
  URL. (Q6) detect a user-supplied `--strict-mcp-config` → our `--mcp-config` is still honored (Bridge works)
  but the additive-over-project claim is false → warn / treat as user-owned isolation. Detect `--safe-mode`
  (disables MCP) → warn (injection won't help). (Q7) **scope to claude + codex**; opencode/others have no
  additive inline flag → `connectRuntime` on demand. (Q4) **trust/approval is UNRESOLVED** → a mandatory EDH
  dogfood of an unattended `--mcp-config` spawn before claiming it works (does claude prompt to trust the
  injected server?). (Q1/Q8) the `--mcp-config`-additive claim is help-text-level → dogfood-gated; codex token
  via `bearer_token_env_var` (clean); the pre-existing tmux `-e` argv token exposure is unchanged (tracked separately).

## Headless probe results (2026-06-19, claude 2.1.183 — resolves codex's open risks)
Driven headless (not deferred to the EDH):
- **`--mcp-config` servers are TRUSTED, not pending-approval.** Tachyon's harness agents already spawn with
  `--mcp-config <file>` and NO `--dangerously-skip-permissions` (none exists anywhere in the spawn path) and
  their MCP works → an explicitly-passed `--mcp-config` server bypasses the project-`.mcp.json` approval gate.
  (codex Q4 "trust/approval unresolved" → RESOLVED for the injection path. Final EDH sanity still in step 5.)
- **`${VAR}` IS interpolated in the `--mcp-config` FILE** (`adapters.ts:171`: "verified live: claude expands
  ${VAR} in that file from the process env"). → **use a FILE**, token only as `${TACHYON_BRIDGE_TOKEN}`, no
  token on argv. (Resolves Q1/Q2 → file, not string.)
- **Bonus finding:** a project `.mcp.json` server shows `⏸ Pending approval (run claude to approve)` — so the
  OLD nudge/registration path carried an approval-friction that `--mcp-config` injection ELIMINATES. The
  deterministic-injection design is strictly BETTER than the dropped nudge, not just more convenient.

## The insight (verified) — inline MCP is additive
- **claude:** `--mcp-config <file|json-string>` ADDS MCP servers; `--strict-mcp-config` is what makes it
  ignore the project `.mcp.json`/global (`claude --help`). So WITHOUT `--strict`, `--mcp-config <bridge>`
  loads the Bridge **on top of** the project + user config — additive.
- **codex:** `-c mcp_servers.tachyon_bridge={…}` merges into the user's `mcp_servers` (spec-232-proven).
- So Tachyon can **deterministically inject the Bridge at spawn for every agent it spawns** — zero
  workspace-file edits, zero user memory, idempotent, nothing committed to the repo.

## Design — inject, don't nudge (the v1 nudge is dropped)
Every Tachyon-spawned agent gets the `tachyon` Bridge MCP injected at spawn, by runtime/harness:

1. **codex (all agents):** generalize spec-232's `maybeCodexBridge` — **drop the `isPipelineNode` gate**
   (`AgentManager.ts:473/547`) so the `-c mcp_servers.tachyon_bridge={url, bearer_token_env_var}` injection
   runs for EVERY codex spawn/restart (when the Bridge URL is present). Already additive + collision-safe
   (distinct name `tachyon_bridge`); token stays in env. (Pipeline nodes keep working — same path.)
2. **claude — non-harness:** append `--mcp-config <bridge>` **without** `--strict` → additive over the
   project `.mcp.json` + user config. Entry = `expectedClaudeEntry(url, auth)` (adapters.ts). Token must NOT
   land on argv (see open Q1).
3. **claude — isolated harness:** the materialized file is passed with `--strict-mcp-config`
   (`adapters.ts:177`), so the Bridge MUST be folded INTO it — `mergeServers(def, workspaceServers,
   bridgeEntry)` always includes `tachyon` regardless of `inherit` (the original "Case 3" bug fix).

**Lifecycle:** injection runs at spawn + restart + resume (each rebuilds the command/materialized file), so
it **self-heals** if the Bridge URL was momentarily absent (an agent that started while the Bridge was down
re-wires on its next (re)start; document that a still-running one stays muted until restarted).

**Reserve the name** at validation: reject a declared `harness.mcp.tachyon` (`loadConfig.ts parseHarness`);
the Bridge owns it. A distinct injected name (`tachyon_bridge`, as in 232) avoids colliding with a user's
own `tachyon` server in the project `.mcp.json`.

## What's dropped / kept
- **DROPPED: the "Configure" nudge** (v1 Cases 1/2). Deterministic injection makes it unnecessary for
  Tachyon-spawned agents — and it sidesteps the engine-boundary + autostart-race + restart-needed problems
  codex flagged in the v1 review.
- **KEPT: `connectRuntime`** (the existing on-demand command) for **external/manual** sessions — a
  claude/codex the user runs themselves in the project, outside Tachyon, still wants a durable
  `.mcp.json`/`.codex/config.toml`. That's a separate, opt-in concern; this pin is about Tachyon-spawned agents.

## Plan (incremental, suite-green each step)
1. **Reserve** `harness.mcp.tachyon_bridge` (+ `tachyon`) in `parseHarness` (config error).
2. **Harness always-Bridge** (mechanism 3, the original bug, highest value): `mergeServers(def, ws,
   bridgeEntry?)` always folds the `tachyon_bridge` entry; materialize computes it from the spawn-env Bridge
   URL + auth. Pure tests (inherit none/workspace, rules-only, no-url-omitted).
3. **One shared injection step (fixes the BLOCKER):** `withRuntimeBridge(cmd, env)` — codex → idempotent
   `-c mcp_servers.tachyon_bridge={…}` (generalize `maybeCodexBridge`, drop the pipeline gate, no-op if
   already present); claude non-harness → `--mcp-config <.tachyon/bridge-mcp/<agent>.json>` (no `--strict`,
   flag inserted before the prompt positional), the file written from `expectedClaudeEntry` (token only as
   `${TACHYON_BRIDGE_TOKEN}`). Apply it at **spawn + restart + resume**. Detect a user-supplied
   `--strict-mcp-config`/`--safe-mode` and warn. gitignore + GC the bridge-mcp file.
4. **Update the pipeline preflight:** `nodeCanSignal` treats a Tachyon-spawned claude/codex node as wired
   when the Bridge URL is live (injection guarantees it) — no longer requires a project `.mcp.json`.
5. **Re-dogfood (EDH) — includes the unresolved-risk gates:** a normal claude + a normal codex in a project
   with NO `.mcp.json`/`.codex/config.toml` each call a Bridge tool with zero manual config (proves the
   `--mcp-config`-additive claim + **that claude doesn't block on a trust/approval prompt** for the injected
   server); a claude harness (inherit:none) too; a project that already has `tachyon` still works.

## Acceptance
- Every Tachyon-spawned agent (claude normal, claude harness inherit:none, codex normal, codex pipeline node)
  reaches the Bridge with NO workspace-file config — proven by unit tests (the composed command / materialized
  file contains the Bridge) + an EDH dogfood (a real Bridge tool call).
- No token on argv (regression test on the composed commands).
- `npm run typecheck && env -u TMUX npx vitest run` green; `check:engine-boundary` green; production behavior
  for already-wired projects unchanged (additive, idempotent).

## Closure (implemented 2026-06-19)
All five plan steps shipped; `npm run typecheck && env -u TMUX npx vitest run` green (722, +12),
`check:engine-boundary` + `build` green.
1. **Reserve** — `parseHarness` rejects `harness.mcp.tachyon` / `.tachyon_bridge` (`loadConfig.ts`); `codexBridgeCmd`
   is now idempotent (no-op if `mcp_servers.tachyon_bridge` already present).
2. **Harness always-Bridge** — `mergeServers(def, ws, bridgeEntry?)` folds `tachyon_bridge` last (always wins);
   `materialize(…, bridgeEntry?)` threads it; `Workspace.bridgeEntry()` computes `expectedClaudeEntry(url, !!token)`
   and the `materializeHarness` callback passes it. Fixes the `inherit:none` drop bug.
3. **One shared injection** — `AgentManager.withRuntimeBridge(name, def, cmd)` replaces `maybeCodexBridge`, applied
   to the FINAL command at **spawn + restart + resume** (the BLOCKER): harness → no-op (folded file); codex →
   idempotent `-c`; claude non-harness → `--mcp-config <file>` appended at the END (additive, no `--strict`; the
   trailing flag dodges claude's variadic-positional swallow). `--strict-mcp-config`/`--safe-mode` in the user cmd
   → `host.notify` advisory. File written by `HarnessManager.materializeBridgeMcp` (token stays `${VAR}`), GC'd on
   `remove`. New `AgentManager` opts `materializeBridgeMcp` + `notify`, wired in `Workspace`.
4. **Preflight** — `nodeCanSignal` now returns `ok` for claude when the Bridge is up (always injected); the
   `claudeMcpConfigured` evidence + `Workspace.claudeBridgeConfigured()` are dropped.
5. **gitignore** — `.tachyon/bridge-mcp/` added to `TACHYON_GITIGNORE_ENTRIES`.

**Tests:** mergeServers bridge-fold (+omit), materialize bridge-fold, materializeBridgeMcp+GC, bridgeMcpPath,
codexBridgeCmd idempotency, parseHarness reserved-name, preflight claude→ok, and a `withRuntimeBridge` block
(codex `-c`, claude append-at-end, harness no-append, Bridge-down no-op, **resume re-inject**, `--strict` warn).

**Remaining proof (EDH, human-run):** the headless probe already established `--mcp-config` is additive + trusted
+ `${VAR}`-interpolated; step-5's live dogfood (a normal claude + normal codex + a claude harness in a
`.mcp.json`-less project each calling a Bridge tool with zero manual config) is the final runtime sanity.

## Open questions for codex
1. **claude non-harness Bridge delivery (the key one):** `--mcp-config '<json-string with
   ${TACHYON_BRIDGE_TOKEN}>'` (no file, but only safe if claude interpolates `${VAR}` in a STRING config —
   verify) vs `--mcp-config <temp file>` (always env-interpolates, guaranteed no token on argv, but needs a
   per-agent file write + lifecycle). Which is cleaner/safer? Lean: file if string-interpolation is
   unconfirmed.
2. **Name collision (claude non-harness):** project `.mcp.json` may already have `tachyon`. Inject under a
   distinct `tachyon_bridge` (no dup, but agent sees two Bridge entries — harmless redundancy) vs `tachyon`
   (dedup/last-wins — confirm claude's behavior)? Lean: distinct `tachyon_bridge`, consistent with codex.
3. **claude MCP trust/approval:** does claude prompt to trust a `--mcp-config` server (would break unattended
   spawn)? If so, what flag/setting avoids it?
4. **Subsumes spec 232?** Generalizing `maybeCodexBridge` (drop the pipeline gate) — does the pipeline-node
   path then double-inject, or is it the same single call? Confirm clean.
5. **opencode / other runtimes:** do they have an additive inline-MCP flag? If not, they're not covered by
   injection — fall back to `connectRuntime` on demand, or just unsupported? (generic/unknown → skip.)
6. **Token-on-argv** per mechanism (codex uses `bearer_token_env_var` ✓; claude must avoid the literal token);
   and the "Bridge down at first spawn → re-injects on restart, running agent stays muted" caveat — coherent?
7. Anything that makes mechanism 2 (claude non-harness `--mcp-config`) riskier than it looks (flag ordering
   vs the instructions positional; interaction with `--continue`/`--resume`; a user already passing their own
   `--mcp-config`/`--strict-mcp-config` in the agent `cmd`).
