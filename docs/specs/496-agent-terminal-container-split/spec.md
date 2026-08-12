# 496 — agent-terminal-container-split

_Created 2026-08-07._

**Status:** shipped
**Closure:** Five independently gated slices shipped the typed collection accessors, converted 26
real agent/terminal dispatch sites (and reclassified two `agent | change` worktree sites), moved
terminal declarations to `.tachyon/terminals/<name>.yml`, split the parsers, and gave Terminal Studio
its own validator/serializer. Slice 5 visual evidence is attached as `ev-2026-08-12T23:40:12.270Z-13`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The owner's sentence is the contract: *"terminal é terminal, algum comando rodando como bun run dev;
agente é um bloco que utilizamos em algum runtime de llm."* `t-91564a` records the defect as **"agent
and terminal are one type with a `kind` field, so 19 files have to ask."** That framing is now half
wrong, and the correction is the whole reason this spec exists rather than a re-run of SDD 478.

**The ENTRY type is already split, and it shipped.** SDD 478 M2 landed
`ManagedEntryDef = AgentEntry | TerminalEntry` (`src/config/loadConfig.ts:214-236`) with every
agent-only capability structurally ABSENT from the terminal arm and one narrowing, `asAgent()`
(`:240`), replacing the ad-hoc `kind === "agent"`-then-reach-for-a-field pattern. The design the
`t-91564a` body proposes for whoever plans this — *"uma base de 'coisa que roda num painel' e dois
tipos em cima dela — não um tipo com um discriminador"* — is a description of the code as it stands
today: `ManagedEntryBase` is that base (`:132-141`), and the two arms sit on it.

**What was never split is the CONTAINER**, and that is where the asking comes from. Five separate
representations each re-flatten the two arms back into one row carrying a `kind` field:

1. `TachyonConfig.agents: Record<string, AgentDef>` (`loadConfig.ts:471`) — one map, both arms. Its
   own doc comment apologises for the name.
2. `AgentManager.list(): ManagedEntryInfo[]` (`AgentManager.ts:347,1969`) — one roster row type, one
   merged name set, `kind` as a field.
3. The persisted and wire records — `SessionLedger` def (`:491`), `configLkg` (`:118`),
   `configFailure` (`:87`), `workspaceProjection` (`:204`).
4. The sidebar view-model — `AgentVM.kind`, with `isAgentRow` (`sidebar/types.ts:142`) as its
   mirror of `asAgent`.
5. The Studio form state — `FormState.kind: StudioKind` (`formLogic.ts:117,122`), where agent and
   terminal share one serializer.

A consumer that wants "the agents" is handed a mixed list and has no choice but to filter it. That
is what the counted branches actually are: **the majority are `kind === "agent"` filters selecting
agents out of a mixed collection**, not agent-vs-terminal behavioral forks. The type answers; the
collection does not.

Done looks like: **the collection answers too.** A caller that wants agents asks for agents and is
handed only agents; a caller that wants terminals asks for terminals. The remaining kind tests are
the ones that are supposed to exist — constructing a typed value from untrusted bytes, refusing a
name the caller supplied, and rendering one screen that deliberately shows both. And `terminals:`
leaves `tachyon.yml` for a directory of its own, which is the same cut in the same files and must
not be a second pass over them.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a consumer that wants agents is handed agents**
  - **Given** a workspace declaring both agents and terminals
  - **When** a consumer that acts only on AI agents (the attention sweep, the delegation monitors,
    the handoff distiller, the runtime-ops snapshot) asks the roster for its input
  - **Then** it receives a collection whose element type is the Agent arm, and it contains no
    `kind === "agent"` filter of its own.
- [x] **Scenario: a terminal named where an agent is required is still refused BY NAME**
  - **Given** a declared terminal `dev`
  - **When** a caller passes `dev` to a door that requires an agent (`continue-task` destination,
    `agentInputService`, handoff distillation)
  - **Then** the refusal still says *that name is a terminal*, not *that name does not exist* — the
    split must not degrade a precise refusal into a lookup miss.
- [x] **Scenario: a terminal is declared outside `tachyon.yml`**
  - **Given** a workspace with no `terminals:` block in `tachyon.yml`
  - **When** a terminal is created through Terminal Studio and the workspace is reloaded
  - **Then** the terminal is in the roster, its declaration lives under its own directory, and
    `tachyon.yml` was not written.
- [x] **Scenario: a legacy `terminals:` block still loads**
  - **Given** an existing `tachyon.yml` that still carries a `terminals:` block
  - **When** the workspace loads
  - **Then** the terminals load, a warning names the new location, and the config is not refused
    (the `t-48dd8d` rule: warn, do not block).
- [x] Every kind test in the § *Branch classification* table of `plan.md` is resolved as the table
      says: the `dispatch` rows are gone, the `dead` rows are gone, and the `legitimate` rows are
      still there, each with the reason the table gives written where it stands.
- [x] `parseAgentEntry`'s `forceTerminal` parameter no longer exists: agent projection and terminal
      declaration are parsed by two functions that share only the `ManagedEntryBase` fields.
- [x] No agent-only key is refused at runtime by name in the terminal parser. A terminal
      declaration file has no place to put `soul`, `instructions`, `selfEvolution`, `role`,
      `worktree`, `branch`, `worktreeSetup`, `verify`, `harness`, `isolate` or `subagents`; each is
      an unknown key with a message naming Agent Studio.
- [x] `TachyonConfig.agents` still exists, still holds both arms, and none of its 77 read sites in
      `src/` changed. Splitting or renaming it is proposed in `plan.md` § *Compatibility cost* and
      is explicitly **not** performed here.
- [x] Each slice in `plan.md` § *Slices* landed as its own commit on a tree its own
      `npm run verify:full:quiet` recorded green.

## Non-goals

- **Re-splitting the entry type.** SDD 478 M2 did it and it is correct. This spec touches
  `AgentEntry`/`TerminalEntry` only where the parser split forces it.
- **Splitting or renaming `TachyonConfig.agents`.** Measured at 77 read sites in `src/` and 199 in
  `test/`; the cost and a proposal are recorded, the change is not made. Owner decision.
- **A generic entity/type-hierarchy framework.** There are two things. The deliverable is that the
  two collections are two collections, not a taxonomy that a third thing could join.
- **The roster-from-directory change for AGENTS.** That is `t-ae221c`, in flight with `rosterdir`.
  This spec starts after it and does the terminal half.
- **Re-litigating which capability belongs to which arm.** The `t-b9d4b1` inventory settled that;
  the three Ambiguous rows were decided by the owner and are being executed elsewhere.
- Changing what an LLM runtime is, or which runtimes are attested.
- Any release, tag, or Marketplace action.

## Open questions

Questions 1–2 were resolved by slice 3: declarations are flat files at
`.tachyon/terminals/<name>.yml`, and legacy blocks remain warned-and-loaded. Questions 3–5 remain
explicit non-goals/follow-up design choices and do not block this closure.

Each of these is the owner's, and each is answerable in one sentence. Nothing below was left open
because it was hard to measure — each is a preference the code cannot supply.

1. **Where does a terminal declaration live?** `.tachyon/terminals/<name>.yml` (one flat file per
   terminal — a terminal has no companion documents, unlike an agent's `SOUL.md`), or
   `.tachyon/terminals/<name>/terminal.yml` (symmetric with `.tachyon/agents/<name>/agent.yml`)?
2. **Is a legacy `terminals:` block in `tachyon.yml` warned-and-loaded forever, or warned now and
   refused at a named later version?**
3. **Does `TachyonConfig.agents` get renamed or split, and if so when?** The plan proposes: not
   now; keep the map, add `configAgents()` / `configTerminals()` derived accessors, and revisit
   once the accessors have absorbed the readers that care.
4. **Does the roster row type split (`AgentInfo` / `TerminalInfo`), or does `list()` keep one row
   type and gain two accessors returning narrowed views?** The plan proposes the accessors, because
   the sidebar renders both from the same fields and a genuine row split would fork the renderer.
5. **When a persisted record carries no `kind` at all, is it an agent or is it refused?** Two live
   sites read a missing kind as *agent* (`webview/ide-browser-bridge/manager.ts:339`,
   `validations/validationCloseNotify.ts:125`) while `SessionLedger.ts:491` refuses it. That is a
   contradiction today, independent of this spec.
