# 207 — tachyon-schedule-studio — plan

_Built in ~/tachyon; SDD by hand._

Extend the Studio (same pattern as the Command/Runbook tabs): formLogic gains the
`schedule` StudioKind with dedicated fields (schedTiming/schedEvery/schedAt,
schedAction/schedTarget, catchUp), validateForm rules (timing-invalid,
target-required), toEntry → the ScheduleDef shape, and fromScheduleDef for edit
prefill. The webview adds a fifth tab with When/Action sub-toggles. Workspace's
studioSubmit routes schedule → upsertSchedule (already used by proposal approval);
extension adds tachyon.scheduleStudio (+ button) and editScheduleStudioItem.

**Files:** formLogic.ts, AgentForm.ts, Workspace.ts (studioSubmit), extension.ts
(2 commands + menus), package.json/nls/l10n (0.6.4), test/unit/agentStudio.test.ts,
README + landing (4→5 tabs), docs/screenshots (schedule tab + montage).

## Risks
- Two `.checks` blocks in the webview after adding the catchUp checkbox — target the lifecycle block by id, not querySelector(".checks"). (Hit + fixed.)
