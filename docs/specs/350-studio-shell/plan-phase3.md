# 350 Phase 3 (pilot) — Agent Studio → per-entity studio on the shell — plan (t-4c4de4)

_Drafted 2026-07-04. Maintainer decision: PILOT ONE entity (Agent) first (option A), proving the
dismemberment pattern; the other 4 (Terminal/Command/Runbook/Schedule) follow the mold in a second wave.
KEY FINDING from reading the code: the 5 "tabs" are ONE kind-conditional form; ALL validation/entry-build
is ALREADY extracted in formLogic.ts (spec 279, unit-tested). So this is NOT rewriting a form — it is
wrapping formLogic (the domain contract, this migration's TaskDetailStore-equivalent) in a shell adapter +
declarative per-kind field config._

## Approach

1. **`AgentStudioAdapter` (host)** implementing `StudioHostAdapter<AgentEntity, AgentFields, AgentPatch>`
   for the `agent` kind ONLY (pilot): load (existing entry or blank), save (build via formLogic +
   YamlConfigEditor upsertAgent), concurrency: {kind:"none"} (yaml config is not CAS-versioned like tasks —
   last-write is the existing behavior; do NOT invent CAS here), dirty hooks over the form state. WRAPS
   formLogic.ts — no change to its validated build/kind logic.
2. **AgentStudioPanel → thin over `StudioPanelManagerBase`** for the agent kind; the ~259-line AgentForm.ts
   host code collapses into the adapter + base. NEW entry point: openNewAgent(ws) opens the agent studio
   directly (no kind picker) — this is the contextual "+" from the AGENTS sidebar section + an
   `tachyon.newAgent` palette command.
3. **`agent-studio` webview → renders in StudioFrame** for the agent kind: the agent field set (quick-add
   CLI chips, name, command, role template, instructions, worktree section) into the frame's `fields`
   region; header actions (Cancel/Save) into the slots. The kind-conditional show/hide logic for agent
   fields becomes the agent config; the OTHER kinds' fields stay in the legacy AgentForm for now.
4. **Coexistence (the pilot's safety property)**: the legacy Agent Studio (5-tab AgentForm) STAYS for
   Terminal/Command/Runbook/Schedule creation; only the AGENT creation path routes to the new per-entity
   studio. extension.ts wires the AGENTS-section "+" / New Agent command to the new panel; the other
   sections' "+" still open the legacy form on their kind. No user loses a creation path.
5. **Tests**: formLogic.ts tests stay green UNCHANGED (its contract is untouched — the regression guard, same
   discipline as Phase 2's 339 tests). Adapter unit tests; panel test (agent create + edit) in the base
   pattern. The legacy form's tests for the other 4 kinds stay green.

## Key decisions

- Adapter WRAPS formLogic.ts, never rewrites it — formLogic is the validated domain contract (like
  TaskDetailStore was for Phase 2). Its unchanged tests are the no-regression proof.
- ConcurrencyContract {kind:"none"} for agent config — tachyon.yml is not CAS-versioned; last-write is the
  existing 215 behavior. Do NOT introduce CAS (that would change agent-creation semantics, out of scope).
- Coexistence over big-bang: only the agent path migrates; the 4 other kinds keep the legacy form until the
  second wave. Bounds blast radius on the most-used product flow (agent creation).
- If a shell gap surfaces (like Phase 2's 4 amendments), STOP and file an additive amendment — never hack
  the studio or weaken formLogic tests.

## Files touched

- src/webview/AgentStudioPanel.ts (new, thin over the base) + AgentStudioAdapter (new).
- src/webview/agent-studio/App.tsx (agent kind renders in StudioFrame; legacy multi-kind path stays until
  wave 2 — likely a NEW agent-only surface file, leaving the legacy App for the other kinds).
- src/extension.ts (route AGENTS "+" / New Agent command to the new panel; other kinds unchanged).
- NO changes to: formLogic.ts (the domain contract), the shell (Phase 1; amendment only w/ sign-off),
  TaskStore/other studios, the 4 non-agent kinds' paths.
- Tests: formLogic unchanged; AgentStudioAdapter + panel; legacy-form-for-other-kinds still green.

## Risks

- Agent creation is the most-used flow — coexistence + unchanged formLogic tests are the guard. If a
  formLogic test needs changing, STOP (regression, not plumbing).
- extension.ts entry-point wiring may brush the 356 spawnContract/tools work (journalImpl, codex) — disjoint
  (356 is tasks/bridge, this is agent-studio/extension entry) but git status before every commit.
- The kind picker (spec 279's tab row) is the piece being retired FOR AGENT ONLY — ensure the legacy form
  still defaults sensibly for the other 4 kinds when its agent tab is gone from the new path (or keep the
  legacy form's agent tab too during coexistence — decide in T1, lean: legacy keeps all 5 tabs, new studio
  is an ADDITIONAL agent-only entry, retire the legacy agent tab only in wave 2's cleanup).

## Sources consulted

spec 350 Phase 1 shell + Phase 2 amendments (the proven pattern) · AgentForm.ts (259 host lines) ·
agent-studio/App.tsx (kind-conditional form) · formLogic.ts (the extracted validated domain contract, spec
279) · YamlConfigEditor (upsertAgent) · extension.ts (entry points) · spec 352 (declaredOwner — agent
studio may later surface it, NOT this pilot).
