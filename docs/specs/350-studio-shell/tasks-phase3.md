# 350 Phase 3 pilot — Agent Studio dismemberment (Agent entity) — tasks (t-4c4de4)

_Generated 2026-07-04. PILOT = the AGENT kind only; the other 4 kinds keep the legacy form (coexistence).
THE GUARD: formLogic.ts tests stay green UNCHANGED (it is the validated domain contract; a test needing a
real change = regression, STOP). Commit per task by pathspec. journalImpl (codex, 356) works tasks/bridge in
parallel — disjoint from agent-studio/extension, but git status before every commit._

## Implementation

- [x] T1 AgentStudioAdapter (host): StudioHostAdapter<AgentEntity,AgentFields,AgentPatch> for the agent kind,
  WRAPPING formLogic.ts (build/validate) + YamlConfigEditor.upsertAgent; concurrency {kind:"none"} (yaml is
  not CAS — do not invent it); dirty hooks over form state. Decide coexistence shape (lean: legacy form keeps
  all 5 tabs; new studio is an additional agent-only entry). Adapter unit tests.
- [x] T2 AgentStudioPanel thin over StudioPanelManagerBase; NEW openNewAgent(ws) + openExistingAgent; panel
  test (create + edit) in the base pattern.
- [x] T3 agent-studio surface renders the agent field set in StudioFrame (quick-add chips, name, command,
  role, instructions, worktree) via the fields region; header Cancel/Save slots. Legacy multi-kind form
  untouched for the other 4 kinds.
- [ ] T4 extension.ts: route the AGENTS-section "+" and a `tachyon.newAgent` palette command to the new
  panel; other sections' "+" unchanged. i18n strings (en/pt-br).
- [ ] T5 Full suite + 3 typechecks green; formLogic tests UNCHANGED; agent visual pass (create + edit) vs
  "shell chrome, agent fields intact, one rhythm"; confirm no other studio / non-agent kind touched.

## Verification

- [ ] formLogic.ts contract intact — its tests green UNCHANGED (`git diff` shows no formLogic edits).
- [ ] Agent create/edit works via the new studio; the other 4 kinds still create via the legacy form.
- [ ] ConcurrencyContract none (no CAS invented for yaml) — adapter test.
- [ ] Entry points: AGENTS "+" / New Agent command → new studio; other sections unchanged.
- [ ] npm test + all typechecks green.

**Headless check:** `npm test -- --run test/unit/formLogic.test.ts test/unit/agentStudioPanel.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/formLogic.test.ts test/unit/agentStudioPanel.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/formLogic.test.ts`
<!-- formLogic unchanged + green over the new adapter IS the no-regression proof. Surfaces need the human pass. -->

**Human dogfood:** Install; the AGENTS section "+" opens the NEW agent studio (shell chrome) — create an
agent (quick-add chip → name → command → save), edit an existing one; confirm the OTHER sections' "+"
(Terminals/Commands/Runbooks/Schedules) still open the legacy form and create correctly. Same agent-creation
behavior, new shell frame.

## Visual QA

- [ ] Evidence: agent-browser captures of the new agent studio (create + edit) on the shell.
- [ ] Verdict:
