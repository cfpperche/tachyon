# 299 — managed-entry-taxonomy — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Capture Claude ad-hoc review of the naming decision and fold accepted feedback into `spec.md` / `plan.md`.
- [x] Add canonical neutral internal types for the unified entry concept in `src/config/loadConfig.ts`, with `AgentDef` preserved as a compatibility alias and parser output unchanged.
- [x] Add neutral aliases or local naming in `AgentManager` for list/info/definition concepts while preserving existing class and method compatibility.
- [x] Update Bridge tool descriptions so existing `*_agent` tools accurately explain compatibility and kind behavior; do not add neutral alias tools in v1.
- [x] Update sidebar/webview comments and type docs that describe terminals as non-AI agents.
- [x] Update README/system-design conceptual docs to use Agent = LLM, Terminal = non-AI, Managed Entry = umbrella, tmux session = lifecycle substrate.
- [x] Add or update unit tests that lock behavior for config parsing, Bridge tool compatibility, sidebar actions, and AI-only terminal rejection.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Existing `agents:` / `terminals:` config tests pass unchanged.
- [x] Existing Bridge tool tests pass, proving no breaking MCP removal.
- [x] No new MCP tool names are added for the managed-entry rename in this spec.
- [x] `rg` review shows no new broad use of `agent` as the umbrella term in touched docs/comments.
- [x] Typecheck and targeted unit tests pass.

**Headless check:** `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/bridge.test.ts && npm run -s typecheck`
**Verify:** `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/bridge.test.ts && npm run -s typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Human approval:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     things to eyeball). Name the steps here when human sign-off matters. -->
