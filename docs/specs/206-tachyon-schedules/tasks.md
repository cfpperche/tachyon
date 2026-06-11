# 206 — tachyon-schedules — tasks

## Implementation
- [x] 1. Config: ScheduleDef + parseEvery/parseAt + schedules parsing (exclusivity rules)
- [x] 2. Scheduler engine (every/at/catchUp, activate/tick/list/nextRun) + 10 unit tests
- [x] 3. ProposalStore (.tachyon/schedules-pending.json, dedupe by name, cap)
- [x] 4. YamlConfigEditor upsert/delete/entryLine schedule
- [x] 5. Bridge: propose_schedule + list_schedules (16->18) + validateProposedSchedule
- [x] 6. Workspace wiring: scheduler tick on heartbeat, runSchedule routing, approve/reject, proposal toast
- [x] 7. Sidebar tachyonSchedules view (active + pending, inline approve/reject, pending badge) + extension commands
- [x] 8. package.json view/commands/menus + nls + l10n + 0.6.0
- [x] 9. Integration scenario + examples/orbit-api schedule + live claude E2E

## Verification
**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`
- [x] Unit 207/207
- [x] xvfb 22 single-root / 6 multi-root
- [x] Live: propose_schedule -> pending -> approve -> active

## Notes
Proposal author is "agent" — the Bridge can't authenticate which agent called (shared HTTP); honest over a guessed name.
