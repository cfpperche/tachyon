# 199 — tachyon-commands — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. Config: `CommandDef` + `commands:` parsing + JSON schema
- [x] 2. `CommandRunner` (own namespace, inverted lifecycle, re-run semantics) + unit tests
- [x] 3. Bridge: `run_command` (waiters `cmd:` long-poll, rerun param) + `list_commands`
- [x] 4. YamlConfigEditor: upsertCommand / deleteCommand / commandEntryLine
- [x] 5. Sidebar CommandsProvider + Terminals title param + package.json contributions
- [x] 6. extension.ts wiring (ticker, toasts, internal `_runCommand`/`_commands`/`_commandTick` seams)
- [x] 7. Agent Studio Command tab (formLogic StudioKind + webview tab)
- [x] 8. l10n (en + pt-BR) + version 0.4.0
- [x] 9. Integration tests (fixture commands, pass/fail/postmortem) + live claude E2E

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [x] Unit 153/153 (commands 6/6 within)
- [x] xvfb integration 20 passing / 1 pending (spec-199 scenario: pass exit 0, fail exit 7, postmortem pane kept, absent from _agents)
- [x] Live claude -p E2E: list_commands, run_command hello (passed, exit 0, tail "e2e-hello"), run_command failer (failed, exit 7, tail "doomed")

## Notes

Tool count 13→16 broke two assertion suites as expected (auth.test.ts, bridge.test.ts) — updated alongside.
