# 201 — tachyon-runbook-crud-ui — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Pure extension of the spec 199 CRUD machinery — no new concepts. formLogic grows
the `runbook` StudioKind (steps textarea parsed one-per-line; validation requires
name + ≥1 step; `toEntry` emits `{steps}` only). YamlConfigEditor grows
upsertRunbook/deleteRunbook/runbookEntryLine (comment-preserving Document API,
same shape as the command functions). The webview gains a fourth tab that hides
cmd/cwd/lifecycle fields and shows the steps textarea with a live resolution hint
fed by `commandNames` (sent at init). All submits flow through the one studioSubmit
pipeline (`_upsertAgent` seam), keeping the integration-test path identical.

## Files to touch

**Modify:**
- `src/webview/formLogic.ts` — StudioKind+="runbook", steps field, parseSteps/stepResolutions/fromRunbookDef, steps-required issue
- `src/webview/AgentForm.ts` — 4th tab, steps block, commandNames in init, initialKind param
- `src/config/YamlConfigEditor.ts` — upsertRunbook/deleteRunbook/runbookEntryLine (+shared entryLineIn)
- `src/extension.ts` — studioSubmit runbook branch, commandStudio/editRunbookStudioItem/editRunbookItem/deleteRunbookItem
- `package.json` + nls + l10n bundle — commands, menus, + button, 0.4.1
- `test/unit/{agentStudio,yamlEditor}.test.ts` — runbook form logic + editor CRUD
- `test/integration/extension.test.js` — Studio-pipeline runbook CRUD scenario

## Alternatives considered

### Separate "Runbooks" sidebar view

Rejected (user asked): runbooks reference commands — same mental space; a second
view adds sidebar noise for a dependent concept. One view, two groups stands.

### Structured step editor (rows + dropdown + reorder buttons)

Rejected for v1: a textarea with one step per line plus a live resolution hint
delivers the same clarity with a fraction of the webview complexity; plain text
also matches what the yml looks like, keeping hand-editing equivalent.

## Risks and unknowns

- Webview i18n strings use the `t` alias the drift guard can't see — pt-BR keys
  added by hand (known guard limitation, recorded in spec 199 notes).

## Research / citations

- spec 199/200 — the CRUD and runner semantics this extends; no external research needed.
