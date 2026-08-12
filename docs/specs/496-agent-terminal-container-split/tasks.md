# 496 — agent-terminal-container-split — tasks

_Generated from `plan.md` on 2026-08-07. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

Each slice is one board task and one commit, deliverable alone on a green `main`. Board ids are
filled in as they are created; the ordering below is the contract, not the ids.

**Do not start slice 3 while `t-ae221c` is active.** Both rewrite block handling in `loadConfig.ts`
and `YamlConfigEditor.ts`.

## Implementation

### Slice 0 — owner decisions (blocking for slice 3 only)

- [ ] Answer § *Open questions* 1 and 2 in `spec.md` (where a terminal declaration lives; whether a
      legacy `terminals:` block is warned forever or refused at a named version). Slices 1, 2 and 5
      do not wait on these.
- [ ] Record the answers in `notes.md` with the date and who decided.

### Slice 1 — the accessors (additive)

- [ ] Add `agentsOf(config): Record<string, AgentEntry>` and `terminalsOf(config): Record<string,
      TerminalEntry>` beside `asAgent` in `src/config/loadConfig.ts`.
- [ ] Add `AgentManager.listAgents()` / `listTerminals()` beside `list()`, resolving kind by the SAME
      expression `list()` uses (`config?.agents[name]?.kind ?? rows?.get(name)?.def?.kind ??
      "agent"`, `AgentManager.ts:2053`).
- [ ] **Fail-before**: a test asserting a REFUSED agent (declared, no definition, no ledger row —
      `t-0ad300`) appears in `listAgents()`. Watch it fail against an accessor that narrows strictly,
      then make it pass. A green test written after the fact proves nothing here.
- [ ] Nothing removed in this slice. No call site changes.

### Slice 2 — convert the 28 selection sites

- [ ] Work the § *Dispatch* table of `plan.md` top to bottom; each row is done when the `kind` test
      is gone and the consumer names its collection.
- [ ] **Fail-before**: a fixture declaring one agent and one terminal, asserting each converted
      consumer sees the same MEMBERSHIP as before (assert membership, not absence — the failure mode
      is silent under-inclusion).
- [ ] `runtimeOps/snapshotService.ts:150` needs both halves: the roster entry AND the ledger def. Do
      not convert only the entry side.
- [ ] Re-run the population grep from `plan.md` § *What the measurement changed*: 76 → 48.

### Slice 3 — terminal declarations leave `tachyon.yml` — the risky one

- [ ] Reader for the new terminal-declaration location (owner question 1).
- [ ] Legacy `terminals:` in `tachyon.yml` keeps loading, with a warning naming the new location.
      Warn, never refuse (`t-48dd8d`).
- [ ] Terminal Studio writes the new location; `Workspace.studioSubmit` stops calling
      `upsertAgent(..., "terminals")`.
- [ ] Promote-instance-to-yml (`extensionOperationService.ts:1070`) writes the new location.
- [ ] `YamlConfigEditor.sectionOf` (`:36`) loses its terminal arm; the 7 call sites follow.
- [ ] `agentStanzaSection` (`:49`) and its reader `soulProfileTransactions.ts:366` — decide and test
      what the Soul gate sees once terminals are not in the file. This is the mechanism that produced
      `t-359469`; it gets its own fail-before, not a type check.
- [ ] Migrate the 16 fixtures declaring `terminals:` in the SAME commit
      (`grep -rl 'terminals:' test/fixtures --include=tachyon.yml`).
- [ ] **Actor × trigger test list**, named the same way: Terminal Studio create · Terminal Studio edit ·
      promote instance to yml · hand-edited legacy block · clone · rename · delete.
- [ ] **Fail-before**: a workspace with terminals in the old block and a workspace with terminals in
      the new location produce the same roster.

### Slice 4 — split the parser (after slice 3)

- [x] `parseAgentEntry` → `parseAgentProjection` (kind always agent) + `parseTerminalDeclaration`
      (kind always terminal), sharing only the `ManagedEntryBase` fields.
- [x] Delete `forceTerminal` and its 8 branches (`loadConfig.ts:1003, 1074, 1088, 1097, 1106, 1164,
      1174, 1187`).
- [x] The 11 agent-only keys become unknown keys in the terminal parser, and the unknown-key message
      keeps the `MOVE_TO_AN_AGENT` text (`:977`) — the diagnostic SDD 478 M6 bought is not given back.
- [x] Attention default per parser (agent on, terminal off), not a branch.

### Slice 5 — split the Studio form serializer

- [ ] `toTerminalEntry` / `validateTerminalForm` for Terminal Studio; the 12 dead branches go
      (`formLogic.ts:281, 292, 355, 356, 357, 358, 359, 365, 377` and `Workspace.ts:7530, 7540, 7583`).
- [ ] `formLogic.ts:273` stays — refusing an attested LLM runtime as a terminal command is a check
      about the COMMAND.
- [ ] `StudioKind` loses its `"agent"` member.
- [ ] Visual QA at 880 and 360 with the anchor written BEFORE the work (see § *Visual QA*).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] A consumer that wants agents receives an Agent-arm collection and contains no `kind === "agent"`
      filter of its own (spec criterion 1).
- [ ] A terminal named where an agent is required is still refused BY NAME, not as a lookup miss
      (spec criterion 2) — the 11 § *Legitimate (b)* sites still say "that is a terminal".
- [ ] A terminal declared outside `tachyon.yml` loads, and `tachyon.yml` was not written
      (spec criterion 3).
- [ ] A legacy `terminals:` block loads with a warning and is not refused (spec criterion 4).
- [ ] Every row of the § *Branch classification* table resolved as the table says: 28 dispatch gone,
      20 dead gone, 28 legitimate still present with their reason written where they stand.
- [x] `forceTerminal` no longer exists.
- [x] No agent-only key is refused at runtime by name in the terminal parser.
- [ ] `TachyonConfig.agents` unchanged, and its 77 `src/` read sites unchanged.
- [ ] Each slice landed on a tree its own `npm run verify:full:quiet` recorded green.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** planning artifact — this spec ships `spec.md`, `plan.md` and `tasks.md` plus the
board tasks they direct. Each implementing slice declares its own dogfood; slice 3 in particular must
dogfood the legacy-block and new-location rosters side by side before it is called done.

**Human dogfood:** optional — after slice 3, open a workspace whose terminals still live in the old
block, confirm the sidebar's terminal section is unchanged and that the warning names the new location.

## Visual QA

Slices 3 and 5 have a visual surface; slices 1, 2 and 4 do not.

**Anchor (written before the work, from the problem statement, not from the screen):** *"Terminal
Studio offers only what a terminal can hold, and saving it round-trips; the sidebar's terminal section
lists the same terminals before and after the move."* Measure at 880 and 360.

- [ ] Evidence: _(slice 3 and slice 5 tasks; not this planning spec)_
- [ ] Verdict:

**Visual QA Opt-Out:** for THIS spec only — it delivers documents and board tasks, and has no rendered
surface of its own. The anchor above is handed to the implementing slices.

## Cookbook

**Cookbook-Opt-Out:** internal container refactor plus a declaration-location move; no new operator
surface. The terminal-declaration location is user-visible and belongs in the user documentation the
slice-3 task updates, not in a cookbook.
