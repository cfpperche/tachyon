# 383 — primer-project-guidance-boundary — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom; update the plan before implementing any material deviation._

## Implementation

- [x] Add parser types and closed validation for `settings.projectGuidance.files`.
- [x] Add safe, bounded, all-or-nothing project-guidance loading and provenance rendering from the source workspace.
- [x] Reduce the primer/before-finishing renderer to universal protocol and explicitly configured verification facts.
- [x] Compose project guidance before long-brief diversion for spawn/restart, including guidance-only declared agents and existing Hermes delivery.
- [x] Preserve byte-exact self-managed/resume launches through direct and `env`-wrapped runtime commands.
- [x] Apply the same composition to re-anchor while preserving transcript-only resume and avoiding pane mutation on load failure.
- [x] Document the public config/precedence/failure contract and publish the schema.
- [x] Move Tachyon repository bootstrap, Git and localization conventions to `docs/project-guidance.md` and opt in from `tachyon.yml`.
- [x] Amend spec 363's superseded repository-policy wording and stale injection-moment claims.
- [x] Add parser/schema, loader/security, primer, AgentManager, long-brief, re-anchor and multi-workspace regression coverage.

## Verification

- [x] Unconfigured onboarding contains no project/package-manager/Git/l10n assumptions or default verification command.
- [x] Explicit verification commands are exact, sourced and preserved in primer and before-finishing output.
- [x] Valid project guidance is verbatim, ordered, provenance-labelled and isolated per workspace.
- [x] Invalid/missing/escaping/symlink/non-file/invalid-UTF-8/oversized guidance fails atomically before tmux mutation.
- [x] Spawn, restart and re-anchor share block ordering; long content is diverted to a brief file; resume stays unchanged.
- [x] Existing identity, gate, approval, continuity and real-target doorbell behavior remains green.
- [x] Terminal entries neither read nor receive project guidance.
- [x] Typecheck and the full repository verification command pass.

**Headless check:** `npm exec -- vitest run test/unit/projectGuidance.test.ts test/unit/primer.test.ts test/unit/ocPrimerShapeBehavior.gen.test.ts test/unit/briefFile.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts test/unit/workspaceHeadless.test.ts test/unit/resume.test.ts test/unit/config.test.ts test/unit/configSchema.test.ts`

**Verify:** `npm exec -- vitest run test/unit/projectGuidance.test.ts test/unit/primer.test.ts test/unit/ocPrimerShapeBehavior.gen.test.ts test/unit/briefFile.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts test/unit/workspaceHeadless.test.ts test/unit/resume.test.ts test/unit/config.test.ts test/unit/configSchema.test.ts`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm exec -- vite-node scripts/dogfood-project-guidance.mts`

**Human dogfood:** optional — in a disposable workspace, point `settings.projectGuidance.files` at a short marker document, spawn an agent, and confirm the marker appears under project-owned delimiters while the primer remains Tachyon protocol only.

## Visual QA

**Visual QA Opt-Out:** This changes generated terminal prompt text and has no graphical layout or design-intent surface; deterministic content/order tests provide stronger evidence.
