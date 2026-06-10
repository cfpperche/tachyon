# 192 — tachyon-pins-notes — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. PinStore (CRUD, notes, lazy dir, precise errors) + unit tests
- [x] 2. 5 Bridge tools (create/list/complete pin, get/set notes) + MCP round-trip tests; 12-tool expectations updated
- [x] 3. Sidebar Pins section (checkboxes, Notes item, corrupt-file warning) + package.json contributions
- [x] 4. extension wiring (checkbox sync, watcher, addPin command w/ automation arg, _pins internal)
- [x] 5. Host integration (addPin -> _pins -> file, cleanup) + views assertion
- [x] 6. Live E2E (claude -p via authed Bridge: pin + notes; file door verified)
- [x] 7. README + dogfood

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 192 acceptance boxes verified
- [x] Full suite green: typecheck, build, 106/106 vitest, 13-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
