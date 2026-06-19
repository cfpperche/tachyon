# 232 — tachyon-codex-bridge-mcp — tasks

**Verify:** `npm run typecheck && env -u TMUX npx vitest run`

## Design — codex-reviewed + folded
- [x] spec.md written; capability verified live (codex 0.141.0 streamable-HTTP MCP + `-c` override + unique-name fix).
- [x] codex adversarial review → CHANGES (2 BLOCKER + 4 MAJOR + 1 MINOR), all folded (`/tmp/codex-232-out.json`).
- [x] B1 verified live: same-name `-c` collides with a stdio `tachyon` → use a unique name `tachyon_bridge`.
- [x] plan.md written.
- [x] Maintainer sign-off (scope = pipeline codex nodes).

## Phase 1 — codex Bridge access
- [x] 1. **`codexBridgeCmd(cmd, url)` pure helper** (`loadConfig.ts`) — inserts a `-c` inline-table override
        after the codex binary token (sees through `env`/`npx` launchers), unique name `tachyon_bridge`,
        token via `bearer_token_env_var` (never on argv). `binaryIndex` exported from `resume/adapters.ts`.
        `codexBridge.test.ts` 8/8.
- [x] 2. **`AgentManager.maybeCodexBridge(def, isPipelineNode)`** — rewrites `def.cmd` for a codex pipeline
        node when a Bridge URL is injected; wired at spawn (gate `opts.pipeline`) + restart (gate ledger
        `def.pipeline`). resume N/A (planResume skips pipeline nodes); fork not a node path. typecheck green.
- [x] 3. **`nodeCanSignal` pure preflight** (`pipeline/preflight.ts`) — `ok|cannot|unprovable` from
        (done, runtime, bridgeUp, claudeMcpConfigured) + `nodeRuntimeOf`. `preflight.test.ts` 6/6.
- [x] 4. **Workspace preflight in `startPipeline`** — `.mcp.json` evidence probe (`claudeBridgeConfigured`);
        per signal-based node → `cannot` fails closed (notify), `unprovable` warns (names the fix) + proceeds.
        NLS pt-BR added (i18n green). **720 unit tests green, typecheck + build clean.**
- [ ] 5. **Re-dogfood (EDH)** — `feature-issue` with the codex `reviewer`: the node now has `complete_node`
        → signals → parks at the approval gate → human approves → run completes. (If MCP calls don't fire
        unattended → fall back to a `cmd: codex exec` / `done: exit` review node.)

## Phase 2 — follow (not this spec)
- [ ] 6. codex isolated harness via `CODEX_HOME` (skills/rules/own MCPs) — the spec-228 analog.
- [ ] 7. Broader codex Bridge access (per-agent opt-in beyond pipeline nodes).
- [ ] 8. (Tracked separately) tmux `-e KEY=VALUE` argv token exposure — workspace-wide threat-model item.

## Acceptance
- [ ] `npm run typecheck && env -u TMUX npx vitest run` green.  ✅ (720)
- [x] `codexBridgeCmd` proven by unit tests (launchers + no-token + collision-safe name).
- [x] A signal-based node whose runtime can't reach the Bridge fails the run closed at start.
- [ ] EDH: the codex `reviewer` node calls `complete_node`, run reaches the approval gate, completes.

**Closure:** _(open — Phase 1 code-complete + green; awaiting the EDH re-dogfood that proves the codex node signals)_
