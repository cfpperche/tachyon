# 236 — runtime ⇄ Bridge wiring (no silently-muted agents) — PLAN (for review)

_Created 2026-06-19. Plan only — no code yet. **codex reviewed → PLAN-NEEDS-CHANGES (0 blocker; 2 MAJOR + 2
MINOR), all folded below** (`/tmp/codex-236-plan-out.json`). Pin `p-c3ff9a`._

## codex folds
- **MAJOR — engine-boundary (the structural one).** `connectRuntime` is SHELL code (`vscode.window` +
  fs writes, `extension.ts:269`). The nudge fires through `EngineHost.notify(..., actions)` (engine) — so
  the `Configure` action's `run` must NOT reach into `extension.ts` or it breaks the spec-233 boundary
  (and `check:engine-boundary` would fail). **Fix:** extract an engine-safe `registration/` helper —
  `readRuntimeRegistrationState(workspaceRoot, url, auth)` + `writeRegistrationOffer(workspaceRoot,
  runtime, url, auth)` (pure fs + the existing adapters, no vscode) — and have BOTH `connectRuntime` and
  the nudge reuse it.
- **MAJOR — autostart races the nudge.** A UI-created **autostart** agent spawns immediately
  (`Workspace.ts:1420`) — and a registration write needs a runtime **restart** to take effect — so it can
  start MUTED before the user clicks Configure. **Fix:** for a UI-created autostart agent, run the wired
  check BEFORE spawn and (a) prompt to configure first, or (b) make `Configure` **restart the
  just-created agent**. And frame the nudge honestly: it's a durable *registration* prompt, not a
  "this spawn is guaranteed wired" guarantee.
- **MINOR — reserve the key at validation.** `parseHarness` (`loadConfig.ts:298`) currently accepts a
  declared `harness.mcp.tachyon`. **Fix:** reject `harness.mcp.tachyon` as a config error (it's reserved
  for the Bridge). An inherited workspace `.mcp.json` `tachyon` is silently replaced by the live Bridge
  (same control plane — fine).
- **MINOR — Bridge-down self-heal boundary.** Case-3 injection re-runs on spawn/restart/resume
  (materialize rewrites the mcp file each time), so it self-heals on the next spawn — but an
  already-running agent spawned while `ws.bridge.url` was absent stays muted until restart. **Fix:**
  document "re-injects on next spawn/restart/resume" + add the "Bridge absent first, present on restart"
  test.

## Design confirmations (codex)
- Case-3 analysis **correct**; `expectedClaudeEntry(url, auth)` is the right shape; URL/token already in
  spawn env. Keep the EDH dogfood (claude MCP transport is external).
- **No `harness.bridge:false` opt-out** (YAGNI — a Bridge-less Tachyon agent IS the failure class).
- **No conflict with spec 232** (codex pipeline nodes use the scoped `tachyon_bridge` `-c`). Cleanest
  design = **deterministic injection for Tachyon-owned isolated harnesses + registration nudge for normal
  project runtimes + keep 232's codex-pipeline `-c`** — the nudge (durable project-file registration) is
  better than broad `-c` rewriting for normal agents because it also helps external/manual sessions.
- Per-runtime-per-workspace debounce is the right granularity; config writes don't trip the `tachyon.yml`
  watcher.

## Problem
A Tachyon-spawned agent can only use Tachyon's tools (`write_input`, `complete_node`, `list_agents`, …)
if its runtime is wired to the **Bridge** (claude via project `.mcp.json`, codex via `.codex/config.toml`).
When it isn't, the agent spawns but is **silently muted** to Tachyon (the spec-232 dogfood hang). The
registration machinery already exists (detect + generate + write) — it's just not triggered at the right
time, and one path is actively broken.

The theme is **"a Tachyon-spawned agent always reaches the Bridge"** — THREE cases:

## Case 3 (the bug, deterministic fix) — isolated-harness agents
A harness agent is spawned with `--mcp-config <private file> --strict-mcp-config`, so claude **ignores the
project `.mcp.json`**. The private file = `mergeServers(def, workspaceServers)` (`HarnessManager.ts:57`):
`inherit: workspace` folds the project snapshot (which has `tachyon` *if registered*); **`inherit: none`
(the default) yields ONLY the declared servers → the Bridge is absent → the agent cannot reach Tachyon.**
- **Fix:** ALWAYS fold the `tachyon` Bridge server into the materialized mcp-config, regardless of
  `inherit`. The Bridge is Tachyon's OWN control plane, not a project MCP the user opts into — just like
  `TACHYON_BRIDGE_TOKEN` is always injected into the spawn env. The Bridge URL/token are already in the
  spawn `env` at `applyHarness` (`AgentManager.ts:477` passes `getExtraEnv()` which has `TACHYON_BRIDGE_URL`).
- **Shape:** pass a `bridgeEntry?` into the pure `mergeServers(def, workspaceServers, bridgeEntry)`; the
  `tachyon` key is **reserved** (Bridge wins over a declared `tachyon`; warn on collision). Entry =
  `expectedClaudeEntry(url, auth)` (reuse adapters.ts). When the Bridge URL is absent (Bridge down) or
  `settings.auth:false`, degrade correctly (no token → `auth:false` entry; no url → skip + warn).
- This case needs **no notification** — it's automatic. (Harness is claude-only today; codex CODEX_HOME is
  a follow — its pipeline nodes already get the Bridge via the spec-232 `-c` injection.)

## Cases 1 & 2 (the nudge) — normal claude / codex agents
On **agent creation via the UI** (`studioSubmit`, `tachyon.newAgent`), detect the runtime
(`binaryOf(cmd)` → claude/codex/opencode) and check whether it's already wired (reuse
`claudeAlreadyRegistered`/`codexAlreadyRegistered`/`opencodeAlreadyRegistered` + `buildOffers`, reading the
workspace config like `connectRuntime` does). If NOT wired → a **non-blocking notice** (fits the spec-233
model — engine emits the fact + a `Configure` action; the shell renders the toast):
*"Agent 'x' uses codex, which isn't connected to Tachyon in this project — [Configure] [Later]"*. Configure
= the scoped, idempotent registration write `connectRuntime` already does (only the `tachyon` key).

## Plan (incremental)
1. **Reserve `harness.mcp.tachyon`** in `parseHarness` (config error) — the key belongs to the Bridge. (MINOR.)
2. **Harness always-Bridge (Case 3) — highest value, deterministic, no UI.** Pure
   `mergeServers(def, workspaceServers, bridgeEntry?)`; materialize computes `bridgeEntry` from the
   spawn-env Bridge URL + auth (`expectedClaudeEntry`) and passes it (Bridge wins; inherited `tachyon`
   replaced). No-url (Bridge down) → omitted, **re-injected on the next spawn/restart/resume**. Unit tests:
   inherit:none gains `tachyon`; inherit:workspace = project + `tachyon`; rules-only harness gains
   `tachyon`; workspace `tachyon` replaced by the live Bridge; no-url omitted; on spawn AND restart AND
   resume; Bridge-absent-first-present-on-restart.
3. **Engine-safe registration helper (MAJOR).** Extract `readRuntimeRegistrationState(root, url, auth)` +
   `writeRegistrationOffer(root, runtime, url, auth)` into `registration/` (pure fs + adapters, NO vscode);
   refactor `connectRuntime` to use them — so the nudge's `Configure` action stays engine-safe (no
   `extension.ts` reach-back; `check:engine-boundary` stays green).
4. **The nudge (Cases 1 & 2).** After a successful UI create (`studioSubmit`/`newAgent`), if the runtime is
   `needs-config` → `host.notify(fact, "warn", [{label:"Configure", run: () => writeRegistrationOffer(...)}])`,
   debounced once per runtime/workspace (`host.getState`/`setState`). Skips generic/unknown runtimes,
   ad-hoc `_spawn`, autostart-from-live-edit, and a down Bridge.
5. **Autostart race (MAJOR).** For a UI-created **autostart** agent on an unwired runtime, run the wired
   check BEFORE spawn; `Configure` then **restarts the just-created agent** so it comes up wired (or the
   prompt offers to configure-then-start). Frame the nudge as a durable registration prompt, not a
   per-spawn guarantee.
6. **Re-dogfood (EDH):** a claude **harness** agent (inherit:none) calls a Bridge tool with NO manual
   config; a normal codex agent in an unconfigured project → Configure writes `.codex/config.toml` → after
   restart it reaches the Bridge; dismiss → no re-nag.

## Decisions (codex-resolved)
1. **Reserved key / opt-out:** Bridge always wins; reject a declared `harness.mcp.tachyon`; **no
   `harness.bridge:false`** (YAGNI).
2. **Nudge surface:** Studio + `newAgent` only; per-runtime-per-workspace debounce.
3. **Bridge down / auth off:** auth-off → no-header Bridge entry; no-url → skip injection + nudge, re-inject
   on next spawn (document that an already-running agent stays muted until restart).
4. **Design (the #5 call):** deterministic injection for Tachyon-owned harnesses + registration nudge for
   normal project runtimes + keep spec-232's codex-pipeline `-c`. No overlap/conflict.
5. **Engine boundary:** the `Configure` write goes through an engine-safe `registration/` helper, never
   `extension.ts`.

## Acceptance
- A claude **harness** agent with `inherit: none` reaches the Bridge (a unit test asserts the materialized
  mcp-config contains `tachyon`; an EDH dogfood confirms a Bridge tool call works).
- Creating a normal claude/codex agent in an unconfigured project shows a one-click Configure nudge; once
  configured (or dismissed), it doesn't nag again.
- `npm run typecheck && env -u TMUX npx vitest run` green; `check:engine-boundary` green; production
  unchanged for already-wired projects.

## Open questions for codex
1. **Harness `tachyon` collision / opt-out:** reserve the `tachyon` key (Bridge always wins) — and is an
   opt-out (`harness.bridge:false`) worth it, or is "a Tachyon agent that can't reach Tachyon" never a real
   want (so always-inject, no flag)? Lean: always-inject, no opt-out (YAGNI).
2. **Nudge trigger surface:** Studio + newAgent only (not ad-hoc `_spawn`, not autostart-from-live-edit)?
   Lean: yes — only deliberate UI creation.
3. **Debounce store:** per-runtime-per-workspace dismissal in `host.getState` — right granularity, or
   per-agent? Lean: per-runtime-per-workspace (a runtime is wired once for the whole project).
4. **Bridge down / auth disabled** at creation: skip the nudge (can't build a real entry) — and for Case 3,
   skip the injection (no url) — confirm that's coherent (the agent just won't reach a non-running Bridge anyway).
5. **opencode / other runtimes:** the nudge covers claude/codex/opencode (adapters exist); generic → skip.
   Harness always-Bridge is claude-only (harness is claude-only). Confirm scoping.
6. Anything that makes Case 3 riskier than it looks (does `--strict-mcp-config` + an injected http/SSE
   `tachyon` entry actually connect under a redirected `CLAUDE_CONFIG_DIR`? the token env is injected — confirm).
