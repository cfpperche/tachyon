# 305 — codex-activity-runtime — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `resolveCodexSession(cwd, env)` and keep `resolveCodexId()` as a wrapper.
- [x] Teach `AgentManager.transcriptPathOf()` to return Codex rollout paths safely.
- [x] Introduce a runtime normalizer factory used by `ActivityLogWriter`.
- [x] Implement `codexNormalizer.ts` for observed `response_item` / `event_msg` records.
- [x] Add resolver, manager, normalizer, and Activity integration tests.
- [x] Fold the Claude probe review into `notes.md` and the implementation if it finds real gaps.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused unit tests pass for resume, AgentManager transcript resolution, Codex normalizer, and Activity integration.
- [x] Full project typecheck passes.

**Headless check:** `npm test -- --run test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/codexNormalizer.test.ts test/unit/activityLog.integration.test.ts && npm run typecheck`
**Verify:** `npm test -- --run test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/codexNormalizer.test.ts test/unit/activityLog.integration.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `node scripts/dogfood-codex-activity.mjs`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** install the packaged VSIX, start a Codex agent, open Activity, and confirm recent user/assistant/tool events render as structured Codex activity with the raw transcript action pointing at the Codex rollout.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->
