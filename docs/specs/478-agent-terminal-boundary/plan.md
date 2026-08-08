# 478 — agent-terminal-boundary — plan

_Drafted from `spec.md` on 2026-07-27. The approach, not the steps (those go in `tasks.md`)._

All line numbers and counts below were read at **`2320c2be`**, the base of this spec's worktree.
They are deliberately NOT updated as the migration proceeds: this document is the measurement that
justified the plan, and rewriting it to today's tree would destroy the record of what was true when
the decisions were made. For what actually happened, see `tasks.md` (per-step outcomes) and the
**Closure** in `spec.md`. Two estimates here were measurably wrong, and both are called out where
they appear — the size of the M3 surface, and what removing the shim would turn red.

## Inventory

### A. The distinction is encoded five ways, none authoritative

| # | Encoding | Where | What it answers |
|---|---|---|---|
| 1 | `EntryKind = "agent" \| "terminal"` on `ManagedEntryDef.kind` | `src/config/loadConfig.ts:37,118` | the nominal answer |
| 2 | `inferKind(cmd)` over `KNOWN_AI_CLIS` (15 binaries) | `src/config/loadConfig.ts:40-62` | "does the command look like an AI CLI" |
| 3 | Canonical attestation: `adapter ∈ {codex,pi,grok,claude}` **and** `executable === adapter` | `src/config/agentProfileProjection.ts:258` | "may this be a canonical agent" |
| 4 | `ResumeRuntime` (10 runtimes) | `src/resume/adapters.ts:17` | "can this be resumed" |
| 5 | `AgentVM.ai?: boolean`, plus `isAgentKind = !isScheduleOrCommandOrRunbook` | `src/sidebar/types.ts:100`, `src/workspace/Workspace.ts:5891` | "does the UI treat this as an agent" |

The three runtime lists **disagree by construction**: `KNOWN_AI_CLIS` has 15 entries, `ResumeRuntime`
has 10, the attested set has 4. `opencode`, `gemini` and `qwen` are agents to (2), resumable to (4),
and cannot be canonical agents to (3). So an entry can simultaneously be "an agent" and "not
attestable as an agent", which is exactly the state `t-9418ac` hit when it tried to create one.

<!-- Corrected while executing M1 (t-939a18): the count was published as 16; `KNOWN_AI_CLIS` held 15
     binaries at 2320c2be, and still does. The disagreement the row describes is unaffected. -->

**Closed by M1 (`t-939a18`).** `src/runtime/attestedRuntimes.ts` now holds the one list; `ResumeRuntime`
is defined as `AttestedRuntime | <non-attested resumable>` so (4) cannot contradict (3); `KNOWN_AI_CLIS`
is composed from it, so (2) can no longer omit or contradict an attested runtime — it remains an
authoring *suggestion*, and removing it from the persistence and ad-hoc doors is M4/M9, not M1.

Encoding (5) is a second, independent copy of the same fact living in the view model, and its
`isAgentKind` form derives agent-ness by *negation of unrelated studio kinds* — a shape that silently
becomes wrong the moment a sixth studio kind is added.

### B. One flat struct; sixteen agent-only fields are representable on a terminal

`ManagedEntryDef` (`src/config/loadConfig.ts:110-162`) is a single record for both kinds. Shared:
`cmd`, `cwd`, `env`, `autostart`, `watch`, `attention`, `restart`, `kind`. Agent-only, yet
structurally present on every terminal:

`instructions`, `role`, `soul`, `selfEvolution`, `profileEvolution`, `profileCapabilities`,
`profileNativeConfig`, `profileLifecycle`, `profileFork`, `profilePointer`, `worktree`, `branch`,
`worktreeSetup`, `verify`, `harness`, `isolate`, `subagents`.

Only **four** of those are actually refused for a terminal, imperatively, in `parseAgentEntry`
(`loadConfig.ts:779-782` for `kind`/`instructions`/`soul`/`selfEvolution`, `:863-864` for `role`). The
remaining twelve are unguarded at the type level and unguarded in the parser: nothing structural stops
a terminal from carrying a `harness`, a `worktree`, a `verify` gate or a `profileLifecycle`.

### C. Identity is recomputed from a string at the persistence boundary

`src/resume/SessionLedger.ts:471` rehydrates as `def: { cmd: o.cmd, kind: inferKind(o.cmd) }`, and
`:499` falls back to `inferKind(o.cmd)` whenever the stored `kind` is absent or not one of the two
literals. So a persisted entry's kind is **not** read back — it is re-derived from its command string.
Editing `KNOWN_AI_CLIS` silently reclassifies existing persisted entries on the next load. This is the
single clearest violation of the ratified rule "no inference by name or cmd alone", and it sits at the
one boundary where the answer should be a stored fact.

### D. The boundary is enforced by 115 scattered conditionals across 40 files

`grep -rn 'kind === "agent"|kind !== "agent"|kind === "terminal"|kind !== "terminal"' src/` → **115
matches in 40 files**, spanning config, AgentManager, Workspace, Bridge, ledger, worktree, delivery,
presentation, sidebar, cockpit, handoff, evolution, runtime-api and host-action policy. Representative
grants, all gated only by a conditional:

- resume adapter selection — `src/agents/AgentManager.ts:918`
- instruction/brief delivery — `:1244`, `:1269`, `:1296`
- delivery join — `:1500` (throws when the bound entry is not `kind: agent`)
- Bridge child-spawn wiring — `:2008`, `:2068`
- task-assignee readiness — `src/bridge/tools.ts:3735`
- icon selection (`hubot` vs `terminal`) — `src/presentation/Terminals.ts:18`

Each conditional is individually correct. Collectively they mean the invariant "a terminal has no
agent lifecycle" is asserted 115 times and guaranteed zero times.

### E. `kind` is an overloaded word across two unrelated unions

Bridge caller identity uses `caller.kind ∈ {agent, human, external, master}`
(`src/bridge/tools.ts:638,869,879`) — a *principal* axis. `ManagedEntryDef.kind ∈ {agent, terminal}` is
an *entity* axis. `ManagedWorktreeService` adds a third (`kind ∈ {agent, change}`,
`src/worktree/managedWorktree.ts:148`). Reading `kind === "agent"` in isolation does not tell you which
question is being asked.

### F. The artificial compatibility is a single seam, and it is on by default in tests

`Workspace.createForTest` sets `allowLegacyAgentFixtures: true` **unconditionally**
(`src/workspace/Workspace.ts:2961`). That flag makes two sites (`:726-729`, `:4944-4948`) fall back to
`parseConfig` whenever the canonical loader reports "inline agent definitions are no longer supported".
Net effect: **every headless Workspace test runs against a config shape the product refuses.** No test
opts in — `grep -rl allowLegacyAgentFixtures test/` returns 0 files — so this is invisible at the call
sites that benefit from it.

### G. Fixtures still declare processes as agents

15 fixtures under `test/fixtures/` declare an inline `agents:` block. At least five declare an
outright generic shell under it: `multiroot/alpha`, `multiroot/beta`, `t-0d0152-mem-dogfood`
(`sh -c "echo …; exec sleep 3600"`), `sidebar-agent-status-filter-dogfood` (six `bash` entries),
`prompt-templates-dogfood` (two `bash` entries). These are only viable because of (F).

### H. The Bridge names the entity it cannot guarantee

`spawn_agent` accepts an arbitrary `cmd` for "an ad-hoc sub-agent" (`src/bridge/tools.ts:1436-1450`);
the resulting entity's kind is then inferred by (2). The tool is named for agents, documents a
delegation contract that only makes sense for agents, and cannot enforce that it produced one.

## Approach

Make the distinction a **type**, make it **stored**, and make it **granted in one place** — in that
order, because each step makes the next mechanical rather than judgemental.

1. **Type it.** Replace the flat `ManagedEntryDef` with a discriminated union over a `kind` literal.
   Agent-only fields move onto the Agent arm and cease to exist on the Terminal arm. The compiler then
   reports every one of the 115 conditionals that is really a narrowing, and every place that reads an
   agent-only field without narrowing first — which is the inventory of real work, produced by the
   compiler instead of by grep.
2. **Store it.** Delete `inferKind` from the persistence path. A persisted entry carries its kind; a
   record that lacks one is refused, not guessed. `inferKind` survives only as a *suggestion* in
   authoring surfaces, where a human can see and override it, and is renamed to say so.
3. **Grant in one place.** Every agent-only capability is granted through a single narrowing —
   `asAgent(entry)` — rather than 115 independent conditionals. A capability is agent-only because the
   Terminal arm has no field for it, not because a conditional remembered to check.
4. **Fail closed at the doors.** Enumerate every entry point that can create or import a managed entry
   and give each the same rule: a generic command goes to `terminals:`, an attested runtime goes to a
   profile, anything ambiguous is refused with a diagnostic naming the fix.
5. **Remove the shim.** `allowLegacyAgentFixtures` and the fixtures depending on it go together, in
   one step, so the tree is never in a state where the shim exists with no consumer (dead code) or the
   fixtures exist with no shim (red suite).

The migration is ordered so that **no step requires an artificial compatibility layer**: the union is
introduced with both arms present from the start, so there is never a window where a terminal must
pretend to be an agent to compile.

## Invariant matrix

`A` = Agent-only · `T` = Terminal-only · `S` = shared. "Granted today by" names the code that hands
the capability out now; "made unrepresentable by" is the target mechanism.

| Capability | | Granted today by | Made unrepresentable by |
|---|---|---|---|
| Runtime adapter / resume | A | `AgentManager.ts:918` (`kind === "agent" ? adapterFor(cmd) : undefined`) | `runtime` lives on the Agent arm only |
| Canonical profile + host authority | A | `agentProfileConfigLoader.ts:88-97` | `profile` on the Agent arm only |
| Model identity & observed model | A | `sidebar/agentModel.ts:275` (`x.ai === false` → no model) | `model` on the Agent arm only |
| Provider authentication (SDD 477) | A | `runtime/authRequired.ts` via `ResumeRuntime` | `authRequired` keyed by `runtime`, Agent-only |
| Soul | A | `ManagedEntryDef.soul`, rejected for terminals at `loadConfig.ts:781` | field absent from Terminal arm |
| Self-evolution | A | `ManagedEntryDef.selfEvolution`, rejected at `:782`; authorable per agent since `t-f96b2f` (pinned `evolution-selector.json`, host writer existed unused since `t-d185e1`) | field absent from Terminal arm |
| Role / instructions / brief | A | `:780`, `:860-870`; delivery at `AgentManager.ts:1244,1269,1296` | fields absent from Terminal arm |
| Task assignment | A | `bridge/tools.ts:3735` | assignee type accepts an Agent ref only |
| Lineage / parent / delegator | A | `AgentManager.ts:2008`; lineage map `:789` | lineage keyed by Agent ref |
| Worktree / branch / worktreeSetup | A | `ManagedEntryDef` fields; `worktreeSetup` authorable per agent since `t-afc86e` (pinned `workspace-setup` document) | fields absent from Terminal arm |
| Verify gate | A | `ManagedEntryDef.verify`; authorable per agent since `t-afc86e` (pinned `workspace-verify` document) | field absent from Terminal arm |
| Harness (private config home, MCP) | A | `ManagedEntryDef.harness` — **unguarded today** | field absent from Terminal arm |
| Transcript isolation (`isolate`) | A | `ManagedEntryDef.isolate` — **unguarded today** | field absent from Terminal arm |
| Delivery join | A | `AgentManager.ts:1500` (throws) | delivery binds an Agent ref |
| Continuity / memory / handoff | A | `Workspace.ts:1500` (`kindOf(agent) === "agent"`) | continuity keyed by Agent ref |
| Compaction / re-anchor | A | `Workspace.ts:1404` (`cmdOf` returns null for terminals) | anchor keyed by Agent ref |
| Process lifecycle: spawn / kill / restart policy | S | `AgentManager` + `LifecycleMonitor` | — stays shared, by design |
| `autostart` | S | `parseAgentEntry` accepts it under either block | — stays shared |
| `watch` (file-watch restart) | ~~S~~ **T** | `parseAgentEntry` accepts it under either block; `Workspace.rebuildWatches` skips agents | **decision revised 2026-08-07 (`t-bd14d8`)** — Terminal only |
| Attention (pane polling, needs-input) | S | `AttentionMonitor`; terminals default off, can opt in | — stays shared (**open question**) |
| Pane presentation / editor terminal | S | `Terminals.ts:18` (icon differs, surface does not) | — stays shared |
| Crash exit code / postmortem pane | S | `LifecycleMonitor` | — stays shared |
| Editor-terminal-only restore state | T | `TerminalPresentation.ts:195` | — |

Two rows are the load-bearing findings: **five Agent-only capabilities are unguarded today**
(`worktree`, `branch`/`worktreeSetup`, `verify`, `harness`, `isolate`). Nothing prevents a terminal
declaring them; they are simply never read for a terminal, which is a silent no-op rather than a
refusal.

## Typed boundary

```ts
// The discriminant is a stored literal, never inferred.
type ManagedEntry = AgentEntry | TerminalEntry;

interface ManagedEntryBase {              // genuinely shared process facts
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  autostart: boolean;
  restart: RestartPolicy;
  attention: AttentionDef;                // shared — see open question
}

interface AgentEntry extends ManagedEntryBase {
  kind: "agent";
  runtime: AttestedRuntime;               // 'codex' | 'pi' | 'grok' | 'claude' — ONE list
  profile: CanonicalProfileRef;           // pointer + authority; required, not optional
  instructions?: string; role?: Role; soul?: boolean; selfEvolution?: SelfEvolutionDef;
  worktree?: boolean; branch?: string; worktreeSetup?: string[]; verify?: string;
  harness?: HarnessDef; isolate?: "transcript"; subagents?: string[];
  // …the remaining profile* projections
}

interface TerminalEntry extends ManagedEntryBase {
  kind: "terminal";
  watch: string[];                        // t-bd14d8 — Terminal only; a watch hit is force + new session
  // deliberately nothing else — every agent-only field is ABSENT, not optional
}
```

Three properties follow, and each is mechanically checkable:

- **`terminal.harness` does not type-check.** The violation is a compile error, not a lint or a test.
- **`AttestedRuntime` is the only runtime list on the Agent arm**, so encodings (2), (3) and (4) can no
  longer disagree: `KNOWN_AI_CLIS` stops deciding anything, and `ResumeRuntime` becomes a *subset
  assertion* checked once rather than a parallel truth.
- **Narrowing is the only way in.** `asAgent(entry): AgentEntry | undefined` replaces the 115 ad-hoc
  conditionals; a caller that wants an agent capability must narrow, and a caller that forgets does not
  compile.

## Fail-closed rules

Every door gets the same rule — *generic command → `terminals:`; attested runtime → profile;
ambiguous → refuse with the fix in the message.*

| Door | Accepts | Refuses with |
|---|---|---|
| `agents:` in `tachyon.yml` | a profile pointer only | already correct (`agentProfileConfigLoader.ts:48,90`); keep verbatim |
| `terminals:` in `tachyon.yml` | any command; no agent-only key | `terminals.<n>: '<key>' applies only to agents` — extend from 4 keys to all 16 |
| Agent Studio commit | attested runtime, `executable === adapter` | already correct (`agentProfileProjection.ts:258`) |
| Terminal Studio commit | generic command | must refuse an attested-runtime command with "declare this as an agent in Agent Studio" |
| Bridge `spawn_agent` (`cmd`) | a runtime declared in `SUPPORTED_ADHOC_AGENT_RUNTIMES` | generic and unresolvable commands are refused naming `spawn_terminal`; kind is never inferred (`t-8f3f7d`) |
| Bridge `spawn_terminal` (`cmd`) | any command, verbatim | nothing — there is no agent parameter to refuse; the arm has no field for one (`t-8f3f7d`) |
| Session ledger rehydrate | a record carrying an explicit `kind` | drop the `inferKind` fallback; a kindless record is refused, not guessed |
| `tachyon.init` scaffold | emits `terminals:` for generic commands | — |

The refusal text is part of the contract: it must name the block to move to, because the whole cost of
the `t-9418ac` incident was three increments spent discovering *which* block the entry belonged in.

## Test strategy

Ratified rule: agent semantics against doubles/headless in the domain; `terminals:` for terminal
scenarios; real-runtime E2E only where the native integration *is* the object of the test.

- **Agent semantics → headless doubles.** Drive the real `AgentManager` with a fake tmux and declare
  `cmd: codex` — an attested runtime name, so no fake agent and no API cost. `t-9418ac` already
  re-based lineage this way (`test/unit/agentManager.test.ts`, "lineage (spec 197)").
- **Terminal scenarios → `terminals:`.** Autostart, watch-restart, crash/postmortem and restart-on-crash
  are process supervision; `terminals:` supports all of them, so filing them correctly is not a
  downgrade.
- **Real-runtime E2E → only for native integration.** Auth, resume, native config and model
  observation. Everything else stays headless.
- **The `cmd: sh`-as-agent ban becomes a test.** A repository-level test asserts no fixture declares a
  non-attested command under `agents:` — the rule enforces itself instead of relying on review.
- **Removing `allowLegacyAgentFixtures` is what makes the above true.** While it exists, headless tests
  are permitted a config shape the product refuses, so no fixture rule can be trusted.

## Key decisions

- **A discriminated union, not a stricter validator** — chosen because the five unguarded capabilities
  (`worktree`, `branch`, `verify`, `harness`, `isolate`) show that validators are added per-field and
  therefore drift per-field; a union removes the field, so there is nothing to remember. Rejected
  "extend `parseAgentEntry` to reject all 16 agent-only keys for terminals" because it produces exactly
  today's architecture with a longer list, and leaves the 115 runtime conditionals untouched.
- **Kind is stored, never inferred, at every persistence boundary** — chosen because
  `SessionLedger.ts:471` proves inference at that boundary is silently retroactive: a change to a
  16-element array reclassifies data already on disk. Rejected "keep inference but pin the list"
  because pinning does not make the derivation legitimate, it only makes it stable.
- **`inferKind` survives as an authoring *suggestion*, renamed** — chosen because the UX value is real
  (a human typing `npm run dev` should not have to pick a kind) and it is safe where a human confirms.
  Rejected outright deletion because it would degrade Studio authoring for no invariant gain; rejected
  keeping the name because `inferKind` reads as authoritative at every call site.
- **One runtime list on the Agent arm** — chosen because three lists that disagree is what let an entry
  be "an agent" and "not attestable" at once. Rejected reconciling the three lists in place: they answer
  different questions today only because the type does not force them to answer the same one.
- **Remove the shim and its fixtures in one step** — chosen so the tree is never dead-code-with-no-
  consumer or red-suite-with-no-shim. Rejected a deprecation window because the human explicitly
  excluded artificial compatibility, and there is no external consumer: 0 test files reference the flag.
- **This spec does not migrate** — chosen because the contract says so, and because the compiler
  produces the true work list only after step 1; estimating the other steps before that would be guessing.

## Files touched

This spec ships documents only:

- `docs/specs/478-agent-terminal-boundary/{spec,plan,tasks,notes}.md` — the contract and backlog.
- `docs/architecture/agent-vs-terminal.md` — the durable architectural statement, so the boundary is
  findable outside a spec directory (the contract asks for an architectural document).

The modules the *migration* will touch are inventoried above; no source file is changed by this spec.

## Risks & unknowns

- **The union's blast radius is 115 call sites in 40 files.** Mitigated by ordering: the union lands
  first and the compiler enumerates the rest, so the work is discovered rather than estimated. The risk
  is that it is discovered to be much larger than 115 — narrowing failures are not 1:1 with the grep.
- **Ad-hoc `spawn_agent` stays Agent-only.** The human chose a lighter attested Agent path without a
  canonical profile. Only supported LLM runtimes are accepted; generic commands use an explicit
  Terminal operation. Rejected turning ad-hoc children into Terminals because task, lineage,
  delegation and worktree are Agent semantics.
  - _Settled by M9 (`t-8f3f7d`): "supported" is NOT `ATTESTED_RUNTIMES`. Reading it that way would have
    removed OpenCode, Hermes, Gemini and Qwen as agents everywhere, since `agents:` already admits only
    attested executables and the ad-hoc path is their only door — orphaning measured resume adapters,
    private homes, activity readers, attention manifests and OpenCode's credential preflight as a side
    effect of a migration whose non-goals disclaim changing which runtimes are attested. The door gets
    its own declared capability instead, and each entry records the mechanism that earns it a place plus
    any shortfall against the delegation contract (`t-59f67c` owns Gemini's and Qwen's)._
- **`attention` on terminals may be the wrong call.** If it turns out Agent-only, the `t-9418ac`
  needs-input scenario loses its home and must go headless — a small, contained reversal, which is why
  it is recorded as an open question rather than blocking.
- **Removing `allowLegacyAgentFixtures` turns 15 fixtures red at once.** This is the intended cost, but
  it must be one task, not spread across others, or the suite is red for an unbounded window.
  _Outcome (M7, `t-ddf054`): the estimate was low by an order of magnitude — it turned **86 tests
  across 12 files** red, because the shim was never really about the fixtures. It protected every
  headless Workspace test that declared an agent inline, which was the majority of them; the fixtures
  were merely its most visible users. The "one task" judgement is what held: the suite went red and
  green inside a single change, and the alternative would have left it red across an unbounded window
  that no one had sized correctly._
- **`t-05097f` (declared entries never reach tmux) is intermittent and unexplained.** It is not caused by
  this work, but it will make any editor-gate evidence for the migration flaky until it is fixed.

## Visual impact

None. This spec ships Markdown. The migration it plans has visual consequences (the sidebar's `ai`
flag and the `hubot`/`terminal` icon are both boundary encodings), and the task that changes them
carries the visual proof.

**Visual QA Opt-Out:** this spec produces documentation only; no rendered surface changes. The sidebar
work is a separate task and carries its own evidence.

## Sources consulted

Read at `2320c2be` unless noted:

- `src/config/loadConfig.ts` — `EntryKind`, `KNOWN_AI_CLIS`, `inferKind`, `ManagedEntryDef`, `parseAgentEntry`
- `src/config/agentProfileConfigLoader.ts` — inline-agent refusal, authority requirement
- `src/config/agentProfileProjection.ts` — the attested-runtime literal check
- `src/resume/adapters.ts` — `ResumeRuntime`
- `src/resume/SessionLedger.ts` — rehydrate-time `inferKind`
- `src/agents/AgentManager.ts` — adapter selection, instruction delivery, delivery join, lineage
- `src/workspace/Workspace.ts` — `allowLegacyAgentFixtures`, `createForTest`, autostart, studio submit
- `src/bridge/tools.ts` — `spawn_agent`, caller-identity `kind`, task-assignee readiness
- `src/sidebar/{types,agentModel,sidebarFleetService,actions}.ts` — the `ai` encoding
- `src/presentation/Terminals.ts`, `src/workspace/TerminalPresentation.ts` — presentation split
- `test/fixtures/**/tachyon.yml` — the 15 inline-`agents:` fixtures
- Task history: `t-9418ac` (journal, five entries — the measured discovery), `t-9c7a5d` (this contract),
  `docs/specs/477-multiruntime-auth-required/spec.md` (auth is runtime-keyed, i.e. Agent-only)
