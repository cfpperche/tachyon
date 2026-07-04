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
- [x] T4 extension.ts: route the AGENTS-section "+" and a `tachyon.newAgent` palette command to the new
  panel; other sections' "+" unchanged. i18n strings (en/pt-br).
- [x] T5 Full suite + 3 typechecks green; formLogic tests UNCHANGED; agent visual pass (create + edit) vs
  "shell chrome, agent fields intact, one rhythm"; confirm no other studio / non-agent kind touched.

## Verification

- [x] formLogic.ts contract intact — its tests green UNCHANGED (`git diff` shows no formLogic edits). Note:
  formLogic's actual test file is `test/unit/agentStudio.test.ts` (this doc's `formLogic.test.ts` name doesn't
  exist in the repo) — 38 tests, all green, file untouched (`git diff c6efcd6..HEAD -- src/webview/formLogic.ts
  src/webview/agent-studio/ src/webview/AgentForm.ts` is empty).
- [x] Agent create/edit works via the new studio (proven by agentStudioPanel.test.ts's full-lifecycle suite +
  the T5 visual pass); the other 4 kinds still create via the legacy form (untouched — AgentForm.ts/agent-
  studio/App.tsx/messages.ts have zero diff since this phase started).
- [x] ConcurrencyContract none (no CAS invented for yaml) — adapter test (agentStudioAdapter.test.ts) + panel
  test both assert `concurrency: { kind: "none" }`.
- [x] Entry points: AGENTS "+" (SidebarPrototype's STUDIO map) + the new `tachyon.newAgentStudio` palette
  command → new studio; other sections' "+" unchanged (still legacy `tachyon.*Studio` commands).
- [x] npm test (2619 tests, 188 files) + all 3 typechecks green.

**Headless check:** `npm test -- --run test/unit/agentStudio.test.ts test/unit/agentStudioPanel.test.ts test/unit/agentStudioAdapter.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/agentStudio.test.ts test/unit/agentStudioPanel.test.ts test/unit/agentStudioAdapter.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/agentStudio.test.ts`
<!-- formLogic unchanged + green over the new adapter IS the no-regression proof. Surfaces need the human pass. -->

**Human dogfood:** Install; the AGENTS section "+" opens the NEW agent studio (shell chrome) — create an
agent (quick-add chip → name → command → save), edit an existing one; confirm the OTHER sections' "+"
(Terminals/Commands/Runbooks/Schedules) still open the legacy form and create correctly. Same agent-creation
behavior, new shell frame. NOT yet done as a real human/install pass — the T5 visual pass below substitutes an
agent-browser capture of the dev preview harness (create + dense edit-mode fixtures) since no VS Code Extension
Host was available in this session; the panel test suite covers the create+edit LIFECYCLE mechanics headlessly.

## Visual QA

- [x] Evidence: agent-browser captures of the new agent studio on the shell (dev preview harness,
  `scripts/webview-preview`, view `agent-studio-shell`) — `.vqa/visual-qa/agent-studio-shell-new-1000x900.png`
  (new/create mode: shell header, quick-add chips, name/command/role/instructions, checks, working dir +
  Browse) and `.vqa/visual-qa/agent-studio-shell-dense-edit-1000x900.png` (edit mode, every agent field
  populated: flag chips, worktree section, isolated harness).
- [x] Verdict: PASS, with one fix applied during the pass. The shell chrome (title/dirty-dot/Cancel/Save/error
  banner) renders correctly and matches Task/Pipeline Studio's rhythm; the full agent-kind field set is intact
  and none of the 4 other kinds' fields leaked in. Caught + fixed: a label+input pair nested inside a
  `<details>` (worktree/harness sections) collapsed onto the same line — grid spacing only reached direct
  children, so content inside `<details>` fell back to inline flow. Fixed in agent-studio-shell.css (`.ash-label`
  now block-level, inputs/selects explicitly full-width) — verified fixed in the re-captured dense-edit
  screenshot.
