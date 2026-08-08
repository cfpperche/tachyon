# 496 — agent-terminal-container-split — plan

_Drafted from `spec.md` on 2026-08-07. The approach, not the steps (those go in `tasks.md`)._

Every count below is reproducible from the tree at `d7c6e141`. The command that produces it is
printed beside it. Where a number in `t-91564a` disagrees with a number here, the disagreement is
named and the command is given so a reader can settle it without trusting either of us.

## What the measurement changed about the task

`t-91564a` states the defect as *"agente e terminal são um tipo só com um campo `kind`"* and sizes it
at *"43 ramos perguntando `kind === "terminal"` em 19 arquivos"*. Three corrections, each measured:

**1. The entry type is already split, and it shipped.** `ManagedEntryDef = AgentEntry | TerminalEntry`
(`src/config/loadConfig.ts:229`), `ManagedEntryBase` is the shared pane-and-process base (`:133-141`),
`TerminalEntry` adds nothing but the discriminant (`:214-216`), and `asAgent()` (`:240`) is the single
narrowing. SDD 478 is `shipped` with M1–M9 executed. The design the task body proposes for the
planner — a base plus two arms rather than one struct with a discriminator — is a description of the
current code. **This spec therefore does not touch the entry type**, except where the parser split
forces it.

**2. The branch count is low, and two of the nineteen files are false positives.** The published
figure came from grepping only `kind === "terminal"`, which misses the positive form
`kind === "agent"` — and the positive form is the majority. And `pipeline/PipelineManager.ts` and
`workspace/TerminalPresentation.ts`, both named in the file list, contain no agent-vs-terminal test
at all: their matches are `isTerminal(s: NodeState["status"])` (`PipelineManager.ts:51`) and
`isTerminalRestoreEntry` (`TerminalPresentation.ts:195`) — a pipeline node's terminal STATUS and a
tmux pane-restore record. This is the exact failure `docs/project-guidance.md` records for
`surface:` on 2026-08-05: two matches of the same word, neither of them the thing.

```
grep -rnE '\.kind (===|!==) "(agent|terminal)"|\bkind (===|!==) "(agent|terminal)"' \
  src/ --include=*.ts --include=*.tsx | wc -l        # 136 raw matches
```

Of the 136, most test a **different union** that happens to spell one of its members `"agent"`:
`BridgeCaller.kind` (`agent | human | external | master | legacy` — ~40 sites), the worktree registry's
`kind` (`agent | change` — 12 sites), the sidebar tree's `context.kind`, and the runtime-observability
fact kind. After removing those, four comment lines, and the worktree-registry rows, **76 live sites
test a managed entry's kind**. They are classified one by one in § *Branch classification*.

**3. The asking is a CONTAINER problem, not a type problem.** Of the 76, twenty-eight are
`filter(x => x.kind === "agent")` over a mixed collection — a consumer selecting agents out of a list
that holds both. The type answers perfectly; it is the collection that does not. That is the defect
this spec fixes, and it is why the deliverable is two collections rather than two types.

### The five containers

| # | Container | Where | What it flattens |
|---|---|---|---|
| C1 | `TachyonConfig.agents: Record<string, AgentDef>` | `loadConfig.ts:471` | the declarations |
| C2 | `AgentManager.list(): ManagedEntryInfo[]` | `AgentManager.ts:281,1969` | the live roster |
| C3 | persisted + wire records | `SessionLedger.ts:491`, `configLkg.ts:118`, `configFailure.ts:87`, `runtime-api/workspaceProjection.ts:204` | what survives a reload |
| C4 | the sidebar view-model `AgentVM.kind` | `sidebar/types.ts:142` | what a human sees |
| C5 | the Studio form state `FormState.kind: StudioKind` | `formLogic.ts:117,122` | what a human authors |

C1's own doc comment apologises for its name: *"the property name is compatibility surface, not a
statement that every entry is an AI agent."* C4 already carries the mirror of `asAgent` (`isAgentRow`),
which is the tell — the sidebar had to re-derive a narrowing the config layer already had, because the
list it was handed had lost it.

## Approach

**The cut: split the collections, keep the types.** Two arms already exist; give each a collection,
and let a consumer name which one it wants.

Concretely, and in this order:

1. **Accessors before anything else.** `agentsOf(config)` / `terminalsOf(config)` over C1, and
   `AgentManager.listAgents()` / `listTerminals()` over C2. Additive. Nothing is removed, nothing
   changes shape, and every later slice converts through this one seam.
2. **Convert the 28 selection sites** to the accessors. This is where the branches actually go.
3. **Move terminal declarations out of `tachyon.yml`** into their own directory, per the owner's
   decision — the same cut in the same files, so it is not a second pass.
4. **Split the parser** once the two declarations come from two places: `forceTerminal` dies, and an
   agent-only key on a terminal stops being a per-key runtime refusal and becomes an unknown key.
5. **Split the Studio form serializer**, which removes twelve branches that are already unreachable.

**Why not split `TachyonConfig.agents` into two maps.** Measured: 77 read sites in `src/` across 13
files, 199 in `test/`.

```
grep -rnE '\b(config|cfg)\??\.agents\b' src/ --include=*.ts --include=*.tsx | wc -l   # 77
grep -rnE '\b(config|cfg)\??\.agents\b' src/ --include=*.ts --include=*.tsx \
  | awk -F: '{print $1}' | sort -u | wc -l                                            # 13
grep -rnE '\b(config|cfg)\??\.agents\b' test/ --include=*.ts --include=*.tsx | wc -l  # 199
```

276 touch points, and `t-ae221c` states the constraint that decides it: *"Nenhuma delas deve mudar. Se
alguma mudar, a fatia está errada."* A map split would put a mechanical 276-site rename in the same
change as a semantic one, and reviewers would have no way to see the semantics through the rename.
The accessors deliver the same benefit at the call site (`agentsOf(config)` returns
`Record<string, AgentEntry>`) while the map stays exactly where 276 readers expect it. **Proposed, not
done** — § *Compatibility cost* records what the eventual split would cost and what has to be true
first.

**Why not split the roster row type** (`AgentInfo` / `TerminalInfo`). The sidebar renders both from
the same fields — `sidebar/types.ts:136-140` says so, and `isAgentRow` exists precisely because rows are
not a union of shapes. A row split would fork the renderer to gain nothing the accessors do not
already give. Recorded as owner question 4.

## Branch classification

76 live sites. **28 become dispatch by collection** (the branch disappears because the caller asks
for the collection it wanted), **20 are dead** (unreachable today, or unreachable after the slice
that owns them), **28 are legitimate and stay**. The third category is not a rounding error: it is
37% of the population, and every row in it has a reason that survives the split.

### Dispatch — 28 sites. The consumer asks for a collection instead of filtering one.

| Site | What it selects | Becomes |
|---|---|---|
| `sidebar/sidebarFleetService.ts:129` | agents, for the per-agent enrichment pass | `listAgents()` |
| `sidebar/sidebarFleetService.ts:145` | live agents | `listAgents()` |
| `sidebar/sidebarFleetService.ts:181` | agents, for the agent section | `listAgents()` |
| `sidebar/sidebarFleetService.ts:255` | terminals, for the terminal section | `listTerminals()` |
| `runtimeOps/snapshotService.ts:146` | agent names for the snapshot | `listAgents()` |
| `runtimeOps/snapshotService.ts:150` | skips terminals by entry AND by ledger def | `listAgents()` + a ledger-side agent view |
| `runtime-api/activityProjection.ts:75` | other running agents | `listAgents()` |
| `prompts/injectFlow.ts:22` | running agents, as inject targets | `listAgents()` |
| `cockpit/missionVm.ts:92` | live agents for the mission tile | `listAgents()` |
| `workspace/RuntimeSlackMonitor.ts:157` | top-level running agents | `listAgents()` |
| `workspace/GatedCompletionMonitor.ts:199` | non-delegated agents | `listAgents()` |
| `workspace/TemporaryBackstopMonitor.ts:187` | running child agents | `listAgents()` |
| `workspace/Workspace.ts:3507` | running agents | `listAgents()` |
| `workspace/Workspace.ts:6732` | delegated agents | `listAgents()` |
| `workspace/Workspace.ts:6937` | `if (def.kind === "agent") continue` — iterates terminals | `terminalsOf(config)` |
| `agents/legacyFleetGate.ts:162` | agents | `listAgents()` |
| `agents/legacyFleetGate.ts:193` | agents | `listAgents()` |
| `handoff/distill.ts:121` | agents | `listAgents()` |
| `handoff/handoffDistillService.ts:132` | a live agent by name | `listAgents()` |
| `shell/WorkspacePresentation.ts:182` | agents | `listAgents()` |
| `engine-service/extensionOperationService.ts:528` | orphaned-worktree agents | `listAgents()` |
| `engine-service/extensionOperationService.ts:530` | studio-owned agents | `listAgents()` |
| `config/agentProfileStudio.ts:620` | agents declaring this child | `agentsOf(config)` |
| `config/agentProfileStudio.ts:630` | this entry's subagents | `agentsOf(config)` |
| `config/agentProfileStudio.ts:632` | self must be an agent | `agentsOf(config)` |
| `config/agentProfileStudio.ts:634` | ownership candidates | `agentsOf(config)` |
| `plugins/engine.ts:314` | agents with a command | `agentsOf(config)` |
| `webview/TerminalStudioAdapter.ts:42` | load must find a terminal | `terminalsOf(config)[id]` |

`TerminalStudioAdapter.ts:42` is the one dispatch row whose refusal quality could degrade, and it
does not: it already answers `{ status: "not-found" }` for a non-terminal, so a lookup miss in the
terminals collection is the identical answer.

### Dead — 20 sites. Nothing reaches them, or nothing will after their slice.

**Eight in the parser** (`config/loadConfig.ts`), and six of them are dead **today**:

`parseAgentEntry` (`:983`) takes `section: "agents" | "terminals"` and derives
`forceTerminal = section === "terminals"` (`:984`). Six sites then ask
`forceTerminal || agent.kind === "terminal"` (`:1088, 1097, 1106, 1164, 1174, 1187`). The second
disjunct is unreachable in production: **no live path can produce an `agents:` entry whose kind is
`terminal`.** Both callers of `parseConfig` strip inline agents first —
`agentProfileConfigLoader.ts:80` and `:138` refuse a pointer-less `agents:` entry with *"inline agent
definitions are no longer supported"*, `:76-84` replaces each pointer with `{cmd: "codex"}`, and
`:187-197` re-serializes the projected definitions, which carry an explicit `kind: "agent"`
(`agentProfileProjection.ts:751`). `Workspace.parseTrustedConfigText` (`:5509`) is the only
production entry and it calls `loadProfileAwareConfig`. The disjunct is reachable only from a test
calling `parseConfig` directly.

| Site | Why dead | Killed by |
|---|---|---|
| `loadConfig.ts:1088` (`role`) | `agent.kind === "terminal"` unreachable under `agents:`; `forceTerminal` goes with the parser split | slice 4 |
| `loadConfig.ts:1097` (`soul`) | same | slice 4 |
| `loadConfig.ts:1106` (`selfEvolution`) | same | slice 4 |
| `loadConfig.ts:1164` (`harness`) | same | slice 4 |
| `loadConfig.ts:1174` (`isolate`) | same | slice 4 |
| `loadConfig.ts:1187` (`subagents`) | same | slice 4 |
| `loadConfig.ts:1003` (`kind:` must be agent\|terminal) | `kind:` stops being an authorable key when neither block is hand-written | slice 4 |
| `loadConfig.ts:1074` (attention defaults off for terminals) | becomes each parser's own default, not a branch | slice 4 |

**Twelve in the authoring form.** `toEntry` (`formLogic.ts:333`) and `validateForm` (`:250`) have
**exactly one caller each** — `Workspace.studioSubmit` at `:7546` and `:7535` — and that function
returns at `:7530` for `kind === "agent"` with *"inline agent editing is retired"*. So every
`state.kind === "agent"` branch downstream of it is unreachable from any live door.

| Site | Why dead | Killed by |
|---|---|---|
| `webview/formLogic.ts:281` (`soul` runtime check) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:292` (`harness`) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:355` (`instructions`) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:356` (`role`) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:357` (`soul`) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:358` (`selfEvolution`) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:365` (attention default) | constant `false` in a terminal-only form | slice 5 |
| `webview/formLogic.ts:377` (`harness` serialization) | agent arm unreachable | slice 5 |
| `webview/formLogic.ts:359` (`watch`) | unconditional in a terminal-only serializer | slice 5 |
| `workspace/Workspace.ts:7530` (refuse agent submits) | exists only because both arms share `studioSubmit` | slice 5 |
| `workspace/Workspace.ts:7540` (can't flip agent↔terminal) | one form per type — nothing to flip | slice 5 |
| `workspace/Workspace.ts:7583` (`isManagedEntry`) | constant `true` in a terminal-only path | slice 5 |

### Legitimate — 28 sites. These stay, and each has a reason that outlives the split.

**Four reasons, not one.** A branch on kind is a defect only when the type could have answered
instead. In these four shapes it could not.

**(a) Constructing a typed value from bytes that carry no type — 6 sites.** At a trust boundary the
union does not exist yet; the branch *is* the constructor. Deleting it would mean trusting the disk.

| Site | Boundary |
|---|---|
| `resume/SessionLedger.ts:491` | a persisted session def; refuses a kindless record outright (SDD 478 M4) |
| `config/configLkg.ts:118` | the last-known-good config snapshot |
| `config/configFailure.ts:87` | the degraded roster rebuilt from the ledger |
| `runtime-api/workspaceProjection.ts:204` | the workspace wire projection |
| `webview/ide-browser-bridge/manager.ts:339` | a webview-side roster row |
| `validations/validationCloseNotify.ts:125` | a roster row inside the notify path |

The last three, plus `configLkg:118` and `configFailure:87`, read a **missing** kind as *agent*, while
`SessionLedger:491` refuses it. That contradiction is real, predates this spec, and is owner question 5.

**(b) Refusing a name the caller supplied — 11 sites.** The caller named `dev`; `dev` is a terminal;
the correct answer is *"that is a terminal"*, not *"that does not exist"*. `bridge/tools/fleet.ts:585`
already states this doctrine in its own comment: the ownership roster includes terminals because
*"the spec 352 contract refuses them as ownership targets by NAME — omitting them would turn 'that is
a terminal' into the less useful 'that does not exist'."* Splitting the collection makes the miss
easy and the good message hard, so these branches must survive the split deliberately.

`config/loadConfig.ts:1240` (dangling `subagents` target) · `config/agentProfileStudio.ts:669` ·
`config/agentProfileStudio.ts:726` · `engine-service/extensionOperationService.ts:370` (clone) ·
`:992` (delete) · `:1061` (promote to yml requires a terminal) · `:334` (live agent required) ·
`workspace/Workspace.ts:6308` (task assignee must be an agent) · `agents/agentInputService.ts:40` ·
`handoff/handoffDistillService.ts:113` · `extension.ts:1705` (continue-task destination).

**(c) Reading a persisted record's own arm — 1 site.** `workspace/Workspace.ts:6498` narrows
`record.def`, which came off the ledger and is a C3 value, not a C1 one.

**(d) One surface that deliberately shows both — 10 sites.** A sidebar row, a roster projection and
a Studio launcher each serve agents and terminals from one code path on purpose. Splitting the
collection does not split the screen.

`sidebar/types.ts:142` (`isAgentRow` — the sidebar's single narrowing, the C4 mirror of `asAgent`;
keep exactly one) · `sidebar/agentModel.ts:313` (a terminal runs a process, not a model) · `:318`
(a terminal has no runtime) · `sidebar/agentFocus.ts:114` (a terminal has no focus) ·
`sidebar/sidebarFleetService.ts:112` (badge eligibility) · `:282` (degraded-roster extras routed to
the right section) · `bridge/tools/fleet.ts:585` (the ownership roster, deliberately mixed) ·
`webview/chat-bridge/ops.ts:48` (prefers agents but **falls back to terminals** when there are none —
splitting the list would delete the fallback) · `extension.ts:3515` (one command, two Studio panels) ·
`config/loadConfig.ts:241` (`asAgent` itself — the narrowing everything else should be using).

## Slices

Five, in order. Each is one commit, deliverable alone, and leaves `main` green. **Slice 3 carries the
risk.**

**Ordering dependency on `t-ae221c`.** `rosterdir` is moving the AGENT roster out of `tachyon.yml`
right now. Slices 1 and 2 are additive and independent of it. **Slice 3 must land after `t-ae221c`**:
both rewrite block handling in `loadConfig.ts` and `YamlConfigEditor.ts`, and running them
concurrently produces a conflict in exactly the file whose correctness matters most.

### Slice 1 — the accessors (additive, no behavior change)

`agentsOf(config)` / `terminalsOf(config)` beside `asAgent` in `loadConfig.ts`;
`AgentManager.listAgents()` / `listTerminals()` beside `list()`.

`listAgents()` must reproduce `list()`'s kind resolution exactly — `config?.agents[name]?.kind ??
rows?.get(name)?.def?.kind ?? "agent"` (`AgentManager.ts:2053`). That trailing `?? "agent"` is not
sloppiness: it is what keeps a **refused** agent (declared in the file, no definition, no ledger row —
`t-0ad300`) in the agent collection. An accessor that narrows by a stricter test would silently drop
refused rows from the sidebar. Fail-before test: a refused agent must appear in `listAgents()`.

Risk: lowest. Two files, pure additions.

### Slice 2 — convert the 28 selection sites

Mechanical, file by file, using the § *Dispatch* table as the checklist. No type changes, no format
changes. Splittable into per-file commits if review wants it.

Fail-before for the whole slice: a workspace declaring one agent and one terminal, asserting each
converted consumer sees exactly the rows it saw before. The failure mode is silent under-inclusion,
so the test asserts membership, not absence.

Risk: low per site, broad in surface. Twenty-eight branches gone; `main` green at every step.

### Slice 3 — terminal declarations leave `tachyon.yml` — **THE RISKY ONE**

A reader for `.tachyon/terminals/` (layout is owner question 1), Terminal Studio writing there,
`YamlConfigEditor.sectionOf` (`:36`) losing its terminal arm along with the seven call sites that use
it, and a legacy `terminals:` block warned-and-loaded rather than refused (`t-48dd8d`'s rule).

Why this one carries the risk:
- It is the only slice that changes an on-disk format a human already wrote.
- **16 test fixtures declare `terminals:`** (`grep -rl 'terminals:' test/fixtures --include=tachyon.yml
  | wc -l`), and every one of them is a live harness.
- The failure mode is a user's terminals vanishing from the roster after an update, which is not
  detectable by a type check.
- `agentStanzaSection` (`YamlConfigEditor.ts:49`) is read by `soulProfileTransactions.ts:366` — the
  Soul gate that produced `t-359469`. Moving the terminal block changes what that function can answer.

Mitigations that belong in the slice, not after it: the legacy block keeps loading with a warning;
the fixtures migrate in the same commit; and the fail-before is *"a workspace whose terminals live in
the old block AND a workspace whose terminals live in the new directory both produce the same
roster."*

### Slice 4 — split the parser

`parseAgentEntry` becomes two functions sharing only the `ManagedEntryBase` fields:
`parseAgentProjection` (input: the canonical projection, kind always agent) and
`parseTerminalDeclaration` (input: the new terminal file, kind always terminal). `forceTerminal` is
deleted with its eight branches. The eleven agent-only keys stop being per-key runtime refusals and
become unknown keys — the refusal text (`MOVE_TO_AN_AGENT`, `:977`) is preserved as the unknown-key
message so the diagnostic quality SDD 478 M6 bought is not given back.

Depends on slice 3 (the terminal parser's input is the new file).

Risk: medium. Contained in one file, but it is the file every config test exercises.

### Slice 5 — split the Studio form serializer

Terminal Studio gets its own `toTerminalEntry` / `validateTerminalForm`; the twelve dead branches go;
`StudioKind` loses its `"agent"` member. `formLogic.ts:273` stays — refusing an attested LLM runtime
as a terminal command is a check about the COMMAND, and it belongs in the terminal form.

UI-visible → visual QA at 880 and 360, anchored before the work on *"Terminal Studio offers only what
a terminal can hold, and saving it round-trips."*

Risk: low. Nothing reached the deleted branches.

## Compatibility cost — the 77 reads of `config.agents`

**Measured, at `d7c6e141`:**

| Scope | Sites | Files |
|---|---|---|
| `src/` | 77 | 13 |
| `test/` | 199 | — |

Distribution in `src/`: `workspace/Workspace.ts` 49, `agents/AgentManager.ts` 6,
`engine-service/extensionOperationService.ts` 5, `shell/TaskStudioTarget.ts` 3,
`config/agentProfileConfigLoader.ts` 3, `shell/MissionControlTarget.ts` 2,
`shell/ClientWorkspaceStudioTarget.ts` 2, `extension.ts` 2, and one each in
`webview/TerminalStudioAdapter.ts`, `webview/ScheduleStudioAdapter.ts`, `webview/AgentStudioAdapter.ts`,
`engine-service/engineService.ts`, `config/configLkg.ts`.

`t-91564a` cites 51 in 7 files; that count came from a narrower pattern. Either number leads to the
same conclusion, and this one is the larger.

**What a split or rename would cost.** 276 edits, 64% of them in one file. The mechanical part is
cheap and the review is not: a 276-site rename in the same change as a semantic split gives a
reviewer no way to see the semantics. It also breaks the constraint `t-ae221c` is currently working
under — *none of these reads may change* — which means it cannot happen while that task is in flight.

**What is proposed instead, in three steps, none of them in this spec:**

1. The accessors from slice 1 absorb the readers that actually care which arm they hold. Measure
   again afterwards: the residual count is the real cost of the rename, and it will be smaller than 77.
2. If the residual is small enough, rename `TachyonConfig.agents` → `entries` in one commit that does
   **nothing else**, so the diff is a rename and reads as one.
3. Only then consider two maps. Two maps mean a name can be declared in both, and today exactly one
   place resolves that collision (`loadConfig.ts:1399-1410`, which drops **both** entries rather than
   guessing). Two maps would need that rule re-implemented at every merge point, which is a worse
   trade than the name.

**Recommendation: do not touch the map in this spec.** It is owner question 3.

## Key decisions

- **Split the collections, not the types** — chosen because the types are already split and shipped
  (SDD 478 M2), and because 28 of the 76 live kind tests are selections over a mixed collection while
  zero are a capability granted by a conditional. Rejected *re-cutting the entry type into a base plus
  two arms* because that is what `loadConfig.ts:133-229` already is.
- **Accessors over two maps** — chosen because it gives the call site the narrowed type at 0 of the
  276 compatibility sites. Rejected *splitting `TachyonConfig.agents`* on measured cost and on the
  namespace-collision rule it would force every merge point to re-implement.
- **`terminals:` moves in the same spec, not a follow-up** — chosen because it is the same cut in the
  same files; `t-ae221c` already halved itself for this reason. Rejected *doing it after* because it
  would touch `loadConfig.ts` and `YamlConfigEditor.ts` a second time.
- **Keep the three no-branch categories honest** — chosen to classify all 76 rather than assume every
  kind test is a defect. 28 of them are legitimate, and the largest legitimate group exists to keep a
  refusal saying *"that is a terminal"* instead of *"that does not exist"* — a message quality
  `fleet.ts:585` already defends in a comment.
- **The parser split preserves the M6 diagnostic text** — chosen because the entire cost of the
  `t-9418ac` incident was three increments spent discovering which block an entry belonged in.
  Rejected *letting agent-only keys become bare "unknown key" errors*.

## Files touched

Planning only; nothing in `src/` or `test/` is written by this spec. The list is what the slices
would touch, so a reader can see the blast radius before agreeing to it.

- `src/config/loadConfig.ts` — accessors (S1); parser split, `forceTerminal` removal (S4).
- `src/agents/AgentManager.ts` — `listAgents()` / `listTerminals()` (S1).
- The 28 dispatch sites in § *Branch classification* — mechanical conversion (S2).
- `src/config/YamlConfigEditor.ts` — `sectionOf` loses its terminal arm; 7 call sites (S3).
- A new terminal-declaration reader/writer, location per owner question 1 (S3).
- `src/workspace/Workspace.ts` — `studioSubmit` terminal-only path (S3, S5).
- `src/webview/formLogic.ts`, `src/webview/TerminalStudioAdapter.ts` — terminal-only form (S5).
- `test/fixtures/**/tachyon.yml` — 16 fixtures carrying `terminals:` (S3).

## Risks & unknowns

- **The refused-agent default.** `list()` resolves an unknown kind to `"agent"`
  (`AgentManager.ts:2053`), which is what keeps a refused agent visible. Any accessor that forgets it
  drops rows silently. Fail-before test named in slice 1.
- **The kindless-record contradiction.** Five sites default a missing kind to *agent*, one refuses it.
  Slice 2 must not quietly pick a side; the contradiction is owner question 5 and is older than this
  spec.
- **The Soul gate reads the block, not the kind.** `soulProfileTransactions.ts:366` depends on
  `agentStanzaSection` answering `"terminals"`. Slice 3 changes what that function can see. This is
  the same mechanism that produced `t-359469`; it needs its own fail-before, not a type check.
- **Actor × trigger for the terminal declaration.** Creating a terminal is reachable from Terminal
  Studio (`studioSubmit`), from the promote-instance-to-yml door
  (`extensionOperationService.ts:1070`), from a hand-edited `tachyon.yml`, and from clone/rename/delete
  in `YamlConfigEditor`. Slice 3's test list is those four doors, named the same way.
- **`main` moves under slice 3.** It is the slice most likely to conflict; it should be the shortest
  time between integrate and deliver.

## Visual impact

Slice 5 changes Terminal Studio: sections that today render a shared form disappear or become
terminal-shaped. Slice 3 can change what the sidebar's terminal section shows if the new reader
disagrees with the old block. Both need the repository's pair of widths (880 and 360), with the anchor
written before the work: *"Terminal Studio offers only what a terminal can hold; the sidebar's terminal
section lists the same terminals before and after the move."* Slices 1, 2 and 4 have no visual surface.

**Artifact-Location-Opt-Out:** planning-only spec; visual evidence is produced by the implementing
slices and belongs to their tasks, not to this directory.

## Sources consulted

- `docs/specs/478-agent-terminal-boundary/spec.md` — status `shipped`, M1–M9 closure.
- `docs/project-guidance.md` — "a written Task is not an accepted Task"; verify at the point of use;
  smallest coherent reversible change; the actor × trigger habit.
- `src/config/loadConfig.ts` (`:133-241`, `:471`, `:694`, `:961-1200`, `:1284`, `:1328-1412`).
- `src/config/agentProfileConfigLoader.ts` (`:60-232`) — the two `parseConfig` callers.
- `src/agents/AgentManager.ts` (`:281-354`, `:1969-2060`).
- `src/config/YamlConfigEditor.ts` (`:27-51`, `:115-145`, `:398-510`).
- `src/webview/formLogic.ts` (`:117-150`, `:250-303`, `:333-380`); `src/workspace/Workspace.ts`
  (`:5509`, `:7520-7600`).
- Task journals: `t-b9d4b1` (15 notes, the field inventory), `t-ae221c`, `t-91564a`.
