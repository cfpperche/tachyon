# 311 — codex-harness-instructions-skills-hooks — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `harness.instructions` parsing and validation for workspace-relative markdown files.
- [x] Allow Codex `harness.skills` and `harness.hooks`; keep Codex `harness.rules` rejected.
- [x] Materialize Codex `instructions` into private `CODEX_HOME/AGENTS.md`.
- [x] Materialize Codex `skills` into private `CODEX_HOME/skills/<basename>`.
- [x] Materialize Codex `hooks` into native `config.toml` top-level hooks config.
- [x] Update Agent Studio to show Codex instructions/skills/hooks fields and keep `rules` hidden.
- [x] Add regression tests for config, harness materialization, and Studio validation.

## Verification

- [x] Unit tests cover Codex instructions/skills/hooks accepted and rules rejected.
- [x] Unit tests cover materialized `AGENTS.md`, `skills/`, and `config.toml` hooks.
- [x] Agent Studio tests cover Codex expanded harness fields.
- [x] Typecheck passes.

**Headless check:** `npm test -- --run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentStudio.test.ts && npm run typecheck`
**Verify:** `npm test -- --run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentStudio.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- --run test/unit/harness.test.ts -t "spec 311"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** create a Codex agent in Agent Studio with harness instructions + skills + hooks, start it, and confirm `/skills` shows the isolated skill and `/hooks` sees the isolated hook config.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
