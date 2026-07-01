# 310 — codex-harness-studio-ui — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Replace the Claude-only Agent Studio harness render gate with a Claude/Codex support check.
- [x] Hide rules/skills/hooks controls when the current agent runtime is Codex.
- [x] Add Studio validation for Codex harness rules/skills/hooks as unsupported in this pass.
- [x] Add/update the displayed validation message for unsupported Codex harness capabilities.
- [x] Update tests for Codex harness Studio behavior.

## Verification

- [x] Unit tests cover Codex MCP harness accepted and Codex rules/skills/hooks rejected at Studio validation.
- [x] Build/typecheck passes.

**Headless check:** `npm test -- --run test/unit/agentStudio.test.ts && npm run typecheck`
**Verify:** `npm test -- --run test/unit/agentStudio.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- --run test/unit/agentStudio.test.ts -t "codex"`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Open Agent Studio, choose OpenAI Codex, confirm `Isolate transcript` and `Isolated harness` are visible; enable harness with an MCP YAML block and save.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
