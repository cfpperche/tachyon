# 207 — tachyon-schedule-studio — tasks

## Implementation
- [x] 1. formLogic: schedule kind, fields, validate (timing/target), toEntry, fromScheduleDef
- [x] 2. AgentForm: fifth tab (When/Action sub-toggles, catchUp), submit state, prefill; id the lifecycle checks
- [x] 3. Workspace.studioSubmit schedule branch -> upsertSchedule (+activate)
- [x] 4. extension: tachyon.scheduleStudio (+ button) + editScheduleStudioItem + menus
- [x] 5. package.json/nls/l10n 0.6.4; agentStudio unit tests
- [x] 6. README/landing 4->5 tabs + "where humans create"; studio montage with 5 tabs

## Verification
**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`
- [x] Unit 211/211 (+ studio parse guard)
- [x] Schedule tab renders clean (no lifecycle checkboxes); captured

## Notes
The lifecycle-checks-by-class bug: adding catchUp gave a 2nd `.checks`; querySelector picked the wrong one. Fixed with an id.
