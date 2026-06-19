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
- [x] 5. **Re-dogfood (EDH) — PASS (run `5d939a55`, 2026-06-18).** The codex `reviewer` node got the
        `tachyon_bridge` MCP (coexisted with the user's own codex MCP servers), **called `complete_node`
        UNATTENDED** (B2 resolved live — "Full Access" fires MCP calls with no per-call approval) with a
        handoff `summary`; nonce accepted ("node 'review' completion accepted"); parked at `awaiting-approval`;
        human approved → run completed → worktree/branch removed. The `codex exec`/`done:exit` fallback was
        NOT needed. Bonus: spec-231 input+handoff re-validated (the reviewer prompt carried `## Upstream
        context` with plan+implement summaries).

## Phase 2 — follow (not this spec)
- [ ] 6. codex isolated harness via `CODEX_HOME` (skills/rules/own MCPs) — the spec-228 analog.
- [ ] 7. Broader codex Bridge access (per-agent opt-in beyond pipeline nodes).
- [ ] 8. (Tracked separately) tmux `-e KEY=VALUE` argv token exposure — workspace-wide threat-model item.

## Acceptance
- [x] `npm run typecheck && env -u TMUX npx vitest run` green (720).
- [x] `codexBridgeCmd` proven by unit tests (launchers + no-token + collision-safe name).
- [x] A signal-based node whose runtime can't reach the Bridge fails the run closed at start.
- [x] EDH: the codex `reviewer` node calls `complete_node`, run reaches the approval gate, completes (run `5d939a55`).

**Closure:** Phase 1 DONE + validated live (run `5d939a55`). A codex `agent:` pipeline node now reaches the
Tachyon Bridge `complete_node` via a per-spawn `-c` override under the collision-safe name `tachyon_bridge`
(token stays in env); the evidence-based start preflight fails closed / warns instead of hanging. codex
calls the MCP tool unattended in Full Access — the `codex exec`/`done:exit` fallback was unneeded. Phase 2
(codex isolated harness via CODEX_HOME; broader codex Bridge opt-in; the pre-existing tmux `-e` argv token
exposure) deferred. Minor housekeeping follow: a finalized run's `.tachyon/runs/<id>.input.md` (+ the run
JSON) is swept lazily on the next activation, not at finalize — local/gitignored, non-blocking.
