# Tasks 243 — activity survives `/clear` on a shared cwd

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** none (host-side resolver + spawn wiring; the Activity feed is fed by it, no UI surface changed)

## Increment A — pure ownership module ✅
- [x] `src/activity/sessionOwners.ts`: `OwnerRow`, ledger/recorder/settings path helpers, `parseOwnerRows` (skip bad lines), `latestOwnerFor` (newest per-agent, REQUIRED canonical cwd match), `readSessionOwners`, `buildOwnershipSettings` (shell-quoted SessionStart command hook), `SESSION_OWNER_RECORDER_SOURCE` (self-contained recorder).
- [x] `test/unit/sessionOwners.test.ts` (7): parse, latest-per-agent, no-sibling-leak, cwd guard, settings shape, recorder-valid-JS, path canonicalization.

## Increment B — materialize the per-spawn hook (atomic) ✅
- [x] `HarnessManager.materializeOwnershipSettings(agent)`: writes the shared recorder + per-agent `--settings` JSON via `atomicWrite` (temp + renameSync — codex HIGH: concurrent spawns must not truncate a recorder a sibling hook is reading).
- [x] `test/unit/harness.test.ts` (+1): settings shape + recorder on disk + valid JS + no `.tmp-` left + idempotent.

## Increment C — inject + resolve in AgentManager ✅
- [x] `withSessionOwnership`: append `--settings <file>` for claude only; skip self-managed + a user `--settings` (advisory); applied at spawn/restart/resume (mirrors `withRuntimeBridge`).
- [x] `transcriptPathOf`: consult `ownedSession` FIRST for claude, live-only, authoritative when the transcript exists; else fall through (no regression to spec-238/240).
- [x] opts `materializeOwnershipSettings` + `ownedSession`; wired in `Workspace.ts` (harness materializer + ledger read via `latestOwnerFor`/`readSessionOwners`).
- [x] `test/unit/agentManager.test.ts` (+9): follow-/clear-past-captured-uuid on shared cwd, authoritative-only-if-exists, not-consulted-non-live; injection for claude/resume, skip codex/self-managed/user-settings/no-materializer.

## Increment D — codex review + publish ✅
- [x] Codex impl review SHIP-WITH-CHANGES: HIGH (atomic write) + MEDIUM (cwd guard) folded; LOW (`--settings` regex) left consistent with the established idiom.
- [x] 903 tests green; tsc + build + engine-boundary clean.
- [x] Published 0.31.1 — package.json + CHANGELOG; `.vsix` packaged for dogfood.

## Closure
**Closure:** see `spec.md` § Closure. Option B shipped in 0.31.1; live `/clear` dogfood is the user's gate.
