# 298 — codex-isolated-harness — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Generalize `ResumeAdapter.harness` so a runtime can materialize MCP by CLI flag (Claude) or home config (Codex).
- [x] Add Codex harness metadata (`CODEX_HOME`, `auth.json`, `sessions`, config-home MCP mode).
- [x] Add Codex `config.toml` materialization with declared/workspace MCP merge and Bridge injection.
- [x] Add Codex isolated-home auth seeding and `isolate: transcript` home-only materialization.
- [x] Make config validation accept `harness:` / `isolate: transcript` for Codex and reject `env.CODEX_HOME`.
- [x] Make resume/capture/activity resolution scan redirected Codex homes.
- [x] Preserve existing Claude harness behavior and tests.
- [x] Update docs/spec notes with resolved open questions and dogfood evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests cover Codex harness materializing `CODEX_HOME`, private `config.toml`, no MCP args, and symlinked auth.
- [x] Unit tests cover Codex `isolate: transcript` with private home-only wiring and config copy.
- [x] Unit tests cover config validation accepting Codex harness/isolate and rejecting user-owned `CODEX_HOME`.
- [x] Unit tests cover redirected Codex session resolver root.
- [x] Unit tests cover Claude harness env/args behavior unchanged.
- [x] SDD verify and dogfood are run and recorded.

**Verify:** `npm test && npx tsc --noEmit`

**Dogfood:** `npm test -- --run test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts`

**Headless check:** `npm test && npx tsc --noEmit`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Human approval:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     things to eyeball). Name the steps here when human sign-off matters. -->
