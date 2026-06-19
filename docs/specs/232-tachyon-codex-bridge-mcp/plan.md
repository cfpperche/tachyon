# 232 — tachyon-codex-bridge-mcp — plan

Phase 1: give a codex `agent:` pipeline node the Tachyon Bridge MCP so it can call `complete_node`, +
an evidence-based pipeline-start preflight so a non-signalable node fails closed instead of hanging.
Pure-core-first; the vscode-bound wiring is proven by the re-dogfood.

## Seams (real, in `~/tachyon`)
- `src/config/loadConfig.ts` — `composeCommand`/`shellQuote`/`binaryOf` (the command builders). New pure
  `codexBridgeCmd(cmd, url)` lives here (reuses `shellQuote`).
- `src/agents/AgentManager.ts:468/474` (spawn) + `:713/715` (restart) — both do
  `injectResumeId(name,def) → effectiveCmd(def) → applyHarness`. Inject the codex-bridge rewrite right
  after `injectResumeId`, gated by pipeline-node-ness. `getExtraEnv()[TACHYON_BRIDGE_URL]` is the URL.
  resume (`:828`)/fork (`:1006`) are NOT pipeline-node paths (planResume skips pipeline nodes; fork is
  user-initiated on running agents) → documented N/A.
- `src/bridge/token.ts` — `URL_ENV_VAR = "TACHYON_BRIDGE_URL"`.
- `src/resume/SessionLedger.ts` — `SessionDef.pipeline?` (spec 230) → restart reads it to detect a node.
- `src/workspace/Workspace.ts:712 startPipeline` — add the preflight before `pipelines.start`.

## Steps
1. **`codexBridgeCmd(cmd, url): string` (pure, loadConfig.ts) + test.** Inserts
   `-c '<inline-table>'` right after the `codex` binary token (sees through `env X=1`/`npx`/`bunx`
   launchers via the same binary detection). Inline table uses the **collision-safe** name:
   `mcp_servers.tachyon_bridge={url="<url>", bearer_token_env_var="TACHYON_BRIDGE_TOKEN"}`, shell-quoted.
   No-op when the cmd's binary isn't codex. Tests: bare `codex`; `codex --model x`; `codex exec`;
   `env A=1 codex`; non-codex → unchanged; the token never appears (only `bearer_token_env_var`).
2. **`AgentManager.maybeCodexBridge(def, isPipelineNode): AgentDef`** — returns def unchanged unless
   (isPipelineNode && binaryOf(cmd)==="codex" && a `TACHYON_BRIDGE_URL` is in `getExtraEnv()`); else
   rewrites `def.cmd` via `codexBridgeCmd`. Apply in spawn (gate `!!opts?.pipeline`) + restart (gate
   `!!ledger.get(name)?.def?.pipeline`).
3. **`nodeCanSignal` pure module (src/pipeline/preflight.ts) + test.** `(done, runtime, bridgeUp,
   claudeMcpConfigured) → "ok" | "cannot" | "unprovable"`: exit-based done → ok (no signal); !bridgeUp →
   cannot; codex → ok (we inject); claude → claudeMcpConfigured ? ok : unprovable; other → unprovable.
4. **Workspace preflight in `startPipeline`** — probe `.mcp.json` for an `mcpServers.tachyon` entry
   (claude evidence); for each signal-based node run `nodeCanSignal`; any **cannot** → notify error +
   refuse to start (fail closed); **unprovable** → notify a warning naming the fix, then proceed.
5. **Re-dogfood** `feature-issue` (codex `reviewer`) → `complete_node` fires → parks at the approval gate
   → approve → completes. If MCP calls DON'T fire unattended (B2), fall back to a `cmd: codex exec` /
   `done: exit` review node (documented).

## Acceptance
- `npm run typecheck && env -u TMUX npx vitest run` green; existing suite unchanged.
- `codexBridgeCmd` proven by unit tests (incl. the no-token assertion + launcher cases).
- A signal-based node whose runtime can't reach the Bridge fails the run closed at start (no silent hang).
- EDH: the codex `reviewer` node calls `complete_node`, the run reaches the approval gate, completes.

## Risks (carried from spec.md)
- Approval-mode (B2): proven only by the dogfood; fallback documented.
- `-c` inline-table quoting through tmux: covered by the helper's test + the dogfood.
- Token argv via tmux `-e` (M2): pre-existing, tracked separately; the codex command carries no token.
