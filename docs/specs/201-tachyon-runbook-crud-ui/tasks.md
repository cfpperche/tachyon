# 201 — tachyon-runbook-crud-ui — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. formLogic: runbook kind, steps parsing/validation/resolutions, fromRunbookDef
- [x] 2. YamlConfigEditor: upsertRunbook / deleteRunbook / runbookEntryLine
- [x] 3. Webview: 4th tab (steps textarea + live hint), commandNames at init, initialKind
- [x] 4. extension.ts: submit branch, context-menu commands, + button, delete-while-running guard
- [x] 5. package.json contributions + nls + l10n (en/pt-BR) + 0.4.1
- [x] 6. Unit tests (formLogic 4, yamlEditor 3) + integration CRUD scenario
- [x] 7. Dogfood walkthrough updated (~/tachyon-demo/DOGFOOD.md F15+F21 section)

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [x] Unit 160/160
- [x] xvfb integration 21 passing / 1 pending (runbook CRUD via the Studio pipeline: create, empty-steps block, edit-in-place, delete)
- [x] No Bridge change — live E2E from specs 199/200 remains the tool-level proof

## Notes

Delete-while-running refuses (parity with rename-while-running for agents) — the
runner's job would survive the config edit and confuse the view otherwise.
