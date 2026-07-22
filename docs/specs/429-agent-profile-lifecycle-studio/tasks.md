# 429 — Agent profile lifecycle and Studio — tasks

_Generated from `plan.md` on 2026-07-22._

## Decomposition

- [x] Inventory current profile, lifecycle, authority and Studio mutation paths.
- [x] Obtain an independent Codex architecture review.
- [x] Create lifecycle-kernel follow-up `t-f447c4`.
- [x] Create rename/forget follow-up `t-c111e4`.
- [x] Create import/export/clone follow-up `t-999e4f`.
- [x] Create Agent Studio integration follow-up `t-149877`.

## Delivery

- [ ] `t-f447c4` is done with recovery/CAS evidence.
- [ ] `t-c111e4` and `t-999e4f` are done with authority-preservation evidence.
- [ ] `t-149877` is done with accessibility, localization, Visual QA and installed dogfood evidence.
- [ ] The end-to-end lifecycle round-trip and plugin/legacy non-interference gates pass.

## Verification

- [ ] `npm run test:invariants` passes with PI-001 unchanged.
- [ ] Config, lifecycle, Agent Studio, engine and workspace focused suites pass.
- [ ] Full configured verification and typecheck pass.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileLifecycle.test.ts test/unit/agentStudioDomain.test.ts test/unit/agentStudioAdapter.test.ts`

**Human dogfood:** final follow-up runs the installed create/edit/disable-enable/clone-export-import/rename/forget flow.

## Visual QA

- [ ] Evidence: final Agent Studio follow-up captures dark, light and high-contrast states.
- [ ] Verdict: provenance, conflicts, focus and destructive-action hierarchy match the design intent.

## Cookbook

**Cookbook-Opt-Out:** lifecycle is exposed through Agent Studio and existing commands; no new operator CLI or Bridge tool is introduced by the umbrella.
