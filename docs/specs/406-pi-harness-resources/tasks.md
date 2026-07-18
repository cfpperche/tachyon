# 406 — pi-harness-resources — tasks

_Generated from `plan.md` on 2026-07-18. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Extend `HarnessDef`, parser and schema with Pi-only extensions/prompts/themes/local-packages resource lists while reusing skills.
- [x] Reject unsupported Pi harness capabilities, `inherit:none`, unsafe path shapes and conflicting native Pi resource flags with actionable diagnostics.
- [x] Add a no-follow resource-tree validator/copier and type-specific structural checks without changing other runtimes' harness semantics.
- [x] Add generation-based Pi resource materialization and exact `--no-*` plus additive private-path CLI args without mutating SDD 401 settings.
- [x] Add content-addressed generation reuse and abandoned-staging cleanup; retain published generations until canonical private-home cleanup so failed restart preparation cannot break a live pane.
- [x] Route Pi resource harnesses through the dedicated lifecycle materializer for spawn/restart/resume while retaining the immutable Bridge extension path; keep existing harness Fork fail-closed.
- [x] Update Pi/parity docs and schema descriptions with the local-only package and project-trust boundaries.
- [x] Add real-Pi headless dogfood for all resource types, sibling isolation, stale cleanup and ambient-global non-inheritance.

## Verification

- [x] Config tests prove accepted Pi resource lists and reject unsupported capability keys, native flag conflicts, absolute/traversing paths and remote package specs.
- [x] Harness tests prove each resource type is copied into a private generation, exact CLI args suppress automatic discovery, private settings remain byte-stable, sibling homes differ and no install command runs.
- [x] Harness tests prove missing/symlinked/special/escaping/duplicate/invalid inputs fail before publication and interrupted staging recovers fail-closed.
- [x] Lifecycle tests prove spawn/restart/resume receive the same private Pi home/resources and the Tachyon Bridge extension remains additive; existing harness Fork refusal remains green.
- [x] Removing declarations/harness stops returning old resource paths without deleting published files a live pane may still reference; canonical forget removes all generations with the private home and settings remain preserved.
- [x] Existing Pi onboarding, continuity, private-home, Activity, interaction, reviewer and Fork focused suites remain green.
- [x] Build, engine boundary, product invariants, typecheck and full verification pass; any unchanged baseline issue is recorded separately.

**Headless check:** focused Pi/config/harness/lifecycle suites, build, engine boundary and product invariants.

**Verify:** `npx vitest run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts test/unit/resume.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piNormalizer.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `npx tsx scripts/dogfood/pi-harness-resources.mjs`

**Human dogfood:** Point the Dev Host at this worktree; start two Pi agents with distinct harness resource lists; inspect Pi startup/commands and `/settings`; confirm extension, skill, prompt, theme and local-package resources appear only for the declared agent; Stop → Resume one agent and confirm the same private resources plus `/tachyon-bridge-status` remain available.

## Visual QA

**Visual QA Opt-Out:** no Tachyon UI layout changes; the optional Pi theme and native command catalog are covered by real-Pi dogfood and human runtime inspection.

## Cookbook

**Cookbook-Opt-Out:** configuration is documented in `tachyon.schema.json` and `docs/runtimes/pi.md`; no new Bridge/CLI operation or independent lifecycle command is introduced.
