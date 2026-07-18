# 402 — pi-interaction-profile — tasks

_Generated from `plan.md` on 2026-07-18._

## Implementation

- [x] Add additive framed composer/ready metadata to runtime profiles.
- [x] Generalize Attention occupancy and composer-only diff detection without changing prompt-glyph runtimes.
- [x] Teach generic launch readiness the framed Pi editor + footer shape.
- [x] Add measured Pi composer and graceful-stop profile sections.
- [x] Add isolated real-tmux Pi dogfood for idle, draft and active-turn stop.
- [x] Update Pi and parity documentation.

## Verification

- [x] Pure tests cover empty, single/multi-line occupied, output-above-frame, missing-border and oversized-frame cases.
- [x] Existing Claude/Codex composer regression suites remain byte-equivalent.
- [x] Readiness tests distinguish Pi editor from trust/modal frames.
- [x] AgentManager stop tests execute the Pi key/delay sequence.
- [x] Build, engine boundary and product invariants pass; inherited baseline failures remain isolated.

**Verify:** `npx vitest run test/unit/runtimeProfile.test.ts test/unit/attention.test.ts test/unit/cxComposerFixBehavior.gen.test.ts test/unit/cxManifestsBehavior.gen.test.ts test/unit/launchReadinessRecovery.test.ts test/unit/agentManager.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-interaction-profile.mjs`

**Human dogfood:** In the pointed Dev Host, confirm Pi settles idle with no occupied-draft warning, type but do not submit a draft and confirm delivery is protected, clear it, run a slow turn, then Stop and confirm a clean resumable exit.

## Visual QA

- [x] Evidence: Dev Host sidebar/terminal inspection at commit `27c1f433` for idle, draft and active-turn Stop states.
- [x] Verdict: approved — Pi stayed correctly idle with a human draft, exited cleanly without `stop-failed`, and resumed after both drafted and active-turn stops.

## Cookbook

**Cookbook-Opt-Out:** internal runtime profile; no new operator surface.
