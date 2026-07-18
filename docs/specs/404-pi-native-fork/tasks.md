# 404 — pi-native-fork — tasks

## Implementation

- [x] Record exact Pi `session_start` ownership through the bundled extension.
- [x] Add Pi native fork adapter shape and exact source-path resolution.
- [x] Materialize a distinct destination private home and UUID in `commitFork`.
- [x] Preserve Bridge, permission posture, identity, worktree and failure compensation semantics.
- [x] Add focused unit/integration coverage.
- [x] Add real Pi A→Fork B→independent Resume dogfood.
- [x] Update Pi and parity documentation.

## Verification

- [x] Adapter emits `--session-id B --fork <A-path>` without self-managed conflicts.
- [x] Source ownership/header/cwd/path failures refuse before worktree, token or tmux side effects.
- [x] B receives distinct home, session UUID and Bridge extension; A remains byte-stable.
- [x] A and B Resume resolve only their own transcripts.
- [x] Existing Claude/Grok/OpenCode Fork suites remain green.

**Verify:** `npx vitest run test/unit/adapters.test.ts test/unit/piBridgeExtension.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts test/unit/resume.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-native-fork.mjs`

**Human dogfood:** ✓ Isolated Dev Host at `397cea17`: Pi A stored `COBALT-404-FORK`; Tachyon Fork created B with inherited context and distinct home/UUID; Stop→Resume of both independently retained the codeword.

## Visual QA

**Visual QA Opt-Out:** existing Fork action and terminal surfaces only; no rendered UI change.

## Cookbook

**Cookbook-Opt-Out:** existing operator-facing Fork action; no new operational procedure.
