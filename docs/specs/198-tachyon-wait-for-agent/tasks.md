# 198 — tachyon-wait-for-agent — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Waiters registry (event-driven, terminal-release, timeout, dispose) + unit tests
- [x] 2. LifecycleMonitor.onGone + executeWait helper + wait_for_agent tool (13th) + deps wiring
- [x] 3. extension: monitor→waiters hookup, _wait internal seam, disposal flush
- [x] 4. bridge-host harness gains real monitors (standalone waits)
- [x] 5. E2E fix: kill/killAll clear ad-hoc defs (ghost listing)
- [x] 6. Suites updated (13 tools), live integration (real transition, ≥4s wait), full-cycle claude E2E
- [x] 7. Version 0.3.0 + README + dogfood; umbrella F19 implemented + F20 registered

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 198 acceptance boxes verified (unit + live integration + full-cycle E2E)
- [x] Full suite green: typecheck, build, 141/141 vitest, 18-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
