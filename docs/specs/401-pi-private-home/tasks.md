# 401 — pi-private-home — tasks

_Generated from `plan.md` on 2026-07-18. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add canonical Pi private-home/session paths under `.tachyon/harness/<agent>` with no-follow containment and mode enforcement.
- [x] Add Pi real-home resolution and first-materialization JSON snapshot seeding in `HarnessManager`, including mode-0600 regular auth copies and environment-auth support.
- [x] Route Pi through default private-home materialization for spawn, restart and resume while preserving Phase 2 exact-session resolution.
- [x] Reserve `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` in configured Pi environments.
- [x] Recognize native `--session-dir` as explicit Pi session ownership.
- [x] Declare Pi private-home isolation in the runtime profile and update canonical cleanup wording.
- [x] Update Pi/parity documentation with the exact isolation and credential/resource limitations.
- [x] Add real Pi RPC dogfood for private-home continuity, sibling isolation and real-home non-mutation.

## Verification

- [x] Unit tests prove distinct mode-0700 homes and sessions, regular mode-0600 auth copies, allowlisted JSON snapshots, environment-only auth, and no executable-tree inheritance.
- [x] Unit tests prove symlink/non-regular/malformed/escape sources and targets fail before tmux mutation.
- [x] Agent lifecycle tests prove the same Pi home/session env on spawn, restart and resume, including self-managed session opt-out behavior.
- [x] Config and runtime-profile tests prove Tachyon owns both env keys and Pi satisfies verified private-home delegation isolation.
- [x] Existing Pi Bridge and exact-session continuity suites remain green.
- [x] Build, engine-boundary checks and product invariants pass; inherited baseline defects, if unchanged, are recorded rather than mixed into this branch.

**Headless check:** focused unit suites, build, boundaries, invariants and real Pi dogfood.

**Verify:** `npx vitest run test/unit/piSession.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts test/unit/config.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-private-home.mjs`

**Human dogfood:** Launch the pointed Dev Host fixture, converse with Pi, ask it to report `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, confirm both are workspace-private, Stop → Resume, confirm prior conversation and `/tachyon-bridge-status`, and verify a second Pi agent reports a different home.

## Visual QA

**Visual QA Opt-Out:** no rendered UI changes; proof is runtime environment, filesystem metadata and exact-session behavior.

## Cookbook

**Cookbook-Opt-Out:** internal runtime isolation; operator behavior remains the documented Tachyon spawn/Stop/Resume flow.
