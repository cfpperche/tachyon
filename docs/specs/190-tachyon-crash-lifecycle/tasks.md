# 190 — tachyon-crash-lifecycle — tasks

_Generated from `plan.md` on 2026-06-09. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. TmuxService: atomic remain-on-exit at session creation; sessionStates(); teardown-race retry; unit + real-tmux tests (instant-death exit 7)
- [x] 2. Config/schema: restart never|on-crash + tests
- [x] 3. AgentManager liveness rework (alive-only running, crashed listing, spawn-over-dead, killAll incl. dead, autostart skips postmortem) + tests
- [x] 4. LifecycleMonitor (transitions, backoff, give-up, reset) + tests
- [x] 5. Sidebar crashed state + menus; extension wiring (toasts, ticker, _agents, manual-restart resets backoff)
- [x] 6. Integration: live crash exit-code/postmortem + live on-crash auto-restart; fixture flaky agent
- [x] 7. Docs: README crash-lifecycle section + example

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 190 acceptance boxes verified (unit + live integration evidence)
- [x] Full suite green: typecheck, build, 92/92 vitest (3x stable), 11-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
