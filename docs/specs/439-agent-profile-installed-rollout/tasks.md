# 439 — agent-profile-installed-rollout — tasks

_Generated from `plan.md` on 2026-07-23. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Create six named follow-up Tasks with dependencies, owned paths, oracle and exit evidence.
- [x] Complete `t-7e7464`: Claude/Grok inventories, measured adapters and external-cwd trust proof.
- [x] Complete `t-1f35d4`: Evolution selector/authority handoff for the installed Codex.
- [x] Complete `t-be11d9`: canonical operational field matrix and Agent Studio round-trip.
- [x] Complete `t-2d4d87`: six-agent planner coverage and single-agent recovery extension.
- [x] Supersede `t-673096`: abort installed migration and return all six agents to legacy declarations.
- [ ] Complete `t-088d08`: legacy production path retirement plus explicit compatibility allowlist.
- [x] Record the ratified replacement strategy in this superseded SDD.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Runtime adapter fixtures prove native-input inventory and override refusal.
- [ ] Migration fixtures prove semantic equivalence, rollback and adversarial path/authority behavior.
- [ ] Studio tests prove every exposed authored field round-trips through canonical CAS.
- [ ] Fresh/reload/resume/fork, LKG and projection-rematerialization tests pass.
- [ ] PI-001, plugin non-interference, typecheck and full verification pass.

**Headless check:** `npm test -- test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileResolver.test.ts test/unit/agentProfileMigration.test.ts test/unit/agentProfileLifecycle.test.ts test/unit/agentStudioAdapter.test.ts test/unit/agentStudioDomain.test.ts test/unit/workspaceHeadless.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npm test -- test/unit/agentProfileConfigLoader.test.ts test/unit/agentProfileResolver.test.ts test/unit/agentProfileMigration.test.ts test/unit/agentProfileLifecycle.test.ts test/unit/agentStudioAdapter.test.ts test/unit/agentStudioDomain.test.ts test/unit/workspaceHeadless.test.ts`

**Verify:** `npm run test:invariants`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm test -- test/unit/agentProfileInstalledRollout.dogfood.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** From an installed Dev Host, create and edit one Codex, Claude and Grok agent; inspect
canonical operational fields; stop/migrate/rollback the isolated mirror; then verify the installed
fleet after final cutover.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence: dark, light and high-contrast captures of New Agent and canonical Edit.
- [ ] Verdict: no missing authored fields, ownership ambiguity, clipped sections or save/reload drift.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <439>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook:** yes
