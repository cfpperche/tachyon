# 478 — agent-terminal-boundary — tasks

_Generated from `plan.md` on 2026-07-27. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

This is an **architecture** spec: its own implementation is the documents plus the ordered backlog.
The migration steps below are deliberately NOT executed here — each is filed as its own queue task.

## Implementation

### The architecture deliverable (this spec)

- [x] Inventory every place the Agent/Terminal distinction is encoded, decided or enforced, grounded
      in the tree at `2320c2be` — `plan.md` § Inventory (A–H).
- [x] Verify every cited file/symbol/line in the inventory actually says what is claimed (20 citations
      spot-checked; four drifted line numbers corrected before publication).
- [x] Build the invariant/capability matrix: Agent-only vs Terminal-only vs shared, each Agent-only row
      naming the code that grants it today and the mechanism that will make it unrepresentable —
      `plan.md` § Invariant matrix.
- [x] Specify the typed boundary (discriminated union, field placement, the single narrowing) —
      `plan.md` § Typed boundary.
- [x] Specify the fail-closed rules per creation/import door, including the refusal diagnostic —
      `plan.md` § Fail-closed rules.
- [x] Record the test strategy that removes the need for a fake agent — `plan.md` § Test strategy.
- [x] Record the key decisions with their rejected alternatives — `plan.md` § Key decisions.
- [x] Write the durable architectural statement outside the spec directory —
      `docs/architecture/agent-vs-terminal.md`.
- [x] Human ratified `spec.md` § Intent and § Acceptance criteria on 2026-07-27 and chose the lighter
      attested Agent path for ad-hoc `spawn_agent`; generic commands use an explicit Terminal operation.

### The migration backlog (filed as queue tasks, executed elsewhere)

Ordered. Each step must leave the tree green on `npm run verify:full:quiet`; none requires a
compatibility shim.

- [x] `t-939a18` · **M1 — one runtime list.** Collapse `KNOWN_AI_CLIS` / `ResumeRuntime` / the attested literal set
      into `AttestedRuntime` plus explicit subset assertions. Blocks M2 (the Agent arm needs the type).
      Landed as `src/runtime/attestedRuntimes.ts`: `ResumeRuntime` splices the attested list in (subset
      by construction), the private-home inspector registry is exhaustive over it, `KNOWN_AI_CLIS` is
      composed from it, and `test/unit/attestedRuntime.test.ts` fails if one list moves without the
      others. `inferKind` still runs at the persistence and ad-hoc doors — that is M4/M9, not M1.
- [x] `t-914f4e` · **M2 — the discriminated union.** Split `ManagedEntryDef` into `AgentEntry | TerminalEntry`;
      the twelve currently-unguarded agent-only fields leave the Terminal arm. Compiler output from
      this step is the true work list for M3.
      Landed with `asAgent()` as the single narrowing and `test/unit/managedEntryUnion.test.ts` as the
      build-level proof (`@ts-expect-error` per agent-only field). **The compiler reported 325 errors
      across 30 files** — the risk in § Risks & unknowns was real: the true M3 surface is ~2.8× the
      115-conditional grep. `runtime`/`profile` are NOT yet required on the Agent arm: every ad-hoc
      spawn and legacy fixture would need a shim, so they land with M6/M7/M9.
- [x] `t-a054f1` · **M3 — one narrowing.** Replace the 115 ad-hoc `kind === "agent"` conditionals with `asAgent()`
      narrowing. Mechanical once M2 lands.
      The 115 turned out to be **three different questions sharing a word** (§ Inventory E). Of the 118
      matches at `834732dc`, only 15 were an entry's kind gating an Agent capability; those are now
      `asAgent()` and `AgentManager` has **zero** entity-kind conditionals left. The other 103 are the
      principal axis (`caller.kind`, 38), the worktree axis (`kind ∈ agent|change`, 5), Studio
      `FormState.kind` (9), the parallel UI/ledger/projection encoding M5 owns (~30), terminal-side and
      parser refusals M6 owns (~17), and the ledger rehydrate M4 owns (1). The grep count is therefore
      the wrong meter: after M2 the compiler already forbids a conditional from being what grants a
      capability, because the field lives on the arm.
- [x] `t-18f6a5` · **M4 — stop inferring at persistence.** Remove `inferKind` from `SessionLedger` rehydrate
      (`:471`, `:499`); a kindless record is refused, not guessed. Rename the surviving authoring-time
      helper to say it is a suggestion.
      `parseDef` refuses a def whose kind was not stored (the row survives if it holds anything else,
      e.g. resume state); the pre-211 flat-record migration is DELETED rather than kept, because that
      shape never carried a kind and migrating it *was* the inference. `inferKind` →
      `suggestKindForCommand` at every call site, which leaves the two remaining inferring doors
      (`AgentManager` ad-hoc spawn → M9, the inline `agents:` kind default → M6) reading as the
      suggestions they are. `test/unit/ledgerStoredKind.test.ts` pins both halves, including a stored
      kind that contradicts what the command would suggest.
- [x] `t-6ebdc8` · **M5 — collapse the parallel UI encoding.** Retire `AgentVM.ai` and
      `isAgentKind = !isScheduleOrCommandOrRunbook` in favour of the union. Carries visual proof.
      `AgentVM.ai` was worse than duplicated, it was *contradictory*: the bit was optional and its
      ABSENCE meant opposite things depending on the reader — `agentModel`/`agentFocus` read
      `ai === false` (undefined ⇒ agent) while the action gate read `!!a.ai` (undefined ⇒ terminal).
      The row now carries a REQUIRED `kind`, with `isAgentRow()` mirroring `asAgent()` on the UI side,
      and the icon derives from the arm through a `Record<EntryKind, string>` so a new arm fails to
      compile instead of inheriting the robot. The third derivation is gone from `Workspace.ts`.
      The last failures were a rejection, not an omission: `sidebarProjection.ts` validates the wire
      contract with a `.strict()` zod object, so a row carrying a field the schema did not declare was
      dropped ENTIRELY — which is why rows vanished from the fleet and `contextValue` lost its suffix
      at the same time. `kind` is now declared required there too. Visual proof: the Agents and
      Terminals captures are byte-identical before and after (sha256 `8d62216c5ca7` / `903a5dc253b0`
      across all three measurements).
- [x] `t-a7ae2d` · **M6 — fail closed at every door.** Terminal Studio refuses an attested-runtime command; the
      `terminals:` parser refuses all 16 agent-only keys, not 4; every refusal names the block to move
      to.
      All eleven authorable agent-only keys are refused for a terminal (the other five are internal
      `profile*` projections, never accepted from YAML), through one `agentOnlyKeyRefusal()` so the
      ending cannot drift. That ending had to CHANGE, not just spread: it used to read "declare it
      under agents: with kind: agent", which points at a shape the product refuses — advice that would
      have reproduced the `t-9418ac` incident rather than prevented it. **The `tachyon.init` door was
      broken outright**: it emitted an inline `agents:` entry, so the first config Tachyon ever wrote
      could not be loaded by the canonical loader. It now emits `terminals:` plus a pointer to Agent
      Studio. `kind:` under `agents:` is deliberately NOT removed — the open question stays open, since
      nothing measured here requires the config-surface break.
- [x] `t-ddf054` · **M7 — remove the shim and its fixtures together.** Absorbs `t-315ce9`. Delete `allowLegacyAgentFixtures` and
      migrate the 15 inline-`agents:` fixtures in the same change. One task, so the suite is never red
      for an unbounded window.
      The shim was never about the fixtures: removing it turned **86 tests red across 12 files**, because
      it protected every headless Workspace test that declared an agent inline — the majority. Migrated by
      judgement per case, not mechanically: agent-capability cases declare a canonical profile plus the
      host-custodied authority (`test/helpers/canonicalAgentFixture.ts`); supervised processes move to
      `terminals:`; and argv-carrying Claude cases become ad-hoc agents, the only arm where a command line
      is authorable after this step. Three surfaces turned out to have NO canonical expression, so the
      cases resting on them were rebased onto what they actually assert, each with the reason recorded
      inline: `selfEvolution` (filed as `t-d185e1` — the projected evolution-selector has no writer in
      `src/`), `createSoulProfile` (filed as `t-e81ec5` — it adds an inline `soul:` to an entry that is now
      a pointer), and `subagents`, which is no longer authorable in roster text at all. Fixtures: 13 of the
      16 declared inline agents a real workspace refuses; shells became terminals and runtime agents were
      removed in favour of an Agent Studio pointer, because no checked-in fixture can ship host-custodied
      authority. Their READMEs were corrected in the same closure, since instructing a dogfooder to confirm
      rows that no longer exist just moves the `t-9418ac` wall one step later.
- [x] `t-a31844` · **M8 — make the ban self-enforcing.** A repository test asserting no fixture declares a
      non-attested command under `agents:`.
      `test/unit/fixtureAgentDeclarations.test.ts`. The rule is stricter than "non-attested" and that is
      deliberate: post-M6 an `agents:` entry is a POINTER, so `cmd: claude` is refused for the same reason
      as `cmd: sh` — the banned thing is the shape, not the binary. Two families, because either alone
      would rot: the detector is run against a fixture tree built to be wrong (a sweep that reports nothing
      is indistinguishable from a sweep that cannot see), and a third case pins the walk so the real sweep
      cannot pass by descending into nothing. Proven in both directions on the real tree — reintroducing a
      `cmd: sh` fixture fails naming the file, the entry and the fix; removing it returns 6/6 green.
      Scope is fixture FILES on purpose: inline YAML in test sources is not swept, because much of it is
      negative cases that must stay free to write the refused shape.
- [x] `t-8f3f7d` · **M9 — enforce ad-hoc `spawn_agent`.** Accept only supported LLM runtimes through the
      lighter Agent path; route generic commands to `spawn_terminal`. The admitted set is its own
      declared capability (`SUPPORTED_ADHOC_AGENT_RUNTIMES`), separate from canonical attestation in
      both directions, because the canonical bar would have deleted OpenCode/Hermes/Gemini/Qwen as
      agents as a side effect. `SpawnOptions.kind` is now declared by the door, not inferred by the
      manager; an omitted kind takes the strict arm.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Every inventory claim names a file and symbol that exists and says what is claimed.
- [x] The rejected alternatives are recorded with the evidence that decided them.
- [x] The matrix marks each capability A/T/S and names the granting code for every Agent-only row.
- [x] Each invariant names a type that makes the violation unrepresentable, or a test that would fail.
- [x] The typed boundary is concrete enough to implement without re-deriving the analysis.
- [x] Every layer that infers the distinction from a command string is listed with its replacement
      (encoding 2 → M1/M4; `SessionLedger` → M4; `spawn_agent` → M9).
- [x] The migration is ordered and shim-free, and names the dead seam it removes (M7).
- [x] Follow-up tasks exist for M1–M9 with no duplicates of each other or of `t-05097f`, `t-8247ec`,
      `t-1e5ab8`. Two pre-existing tasks overlap and are RELATED rather than duplicated: `t-315ce9`
      (one inline fixture) is absorbed by M7, since migrating it alone would leave the other 14 on the
      shim; `t-e787dc` (ad-hoc `parent`/`cwd` parameters) is a different question from M9, which asks
      what the resulting entity IS.

The counts in the inventory are re-derivable, which is what makes them checkable rather than asserted.
They are measurements of the tree at `2320c2be`, so they are pinned to it — run against today's tree
they no longer reproduce, and that is the migration having happened, not the spec having rotted:

```sh
# As inventoried, at the anchor commit. These still reproduce exactly.
# `:(glob)` matters: a bare 'src/**/*.ts' pathspec silently misses depth-1 files and reports 113/39.
git grep -h 'kind === "agent"\|kind !== "agent"\|kind === "terminal"\|kind !== "terminal"' \
  2320c2be -- ':(glob)src/**/*.ts' ':(glob)src/**/*.tsx' | wc -l   # 115
git grep -l 'kind === "agent"\|kind !== "agent"\|kind === "terminal"\|kind !== "terminal"' \
  2320c2be -- ':(glob)src/**/*.ts' ':(glob)src/**/*.tsx' | wc -l   # 40
git grep -l "^agents:" 2320c2be -- 'test/fixtures/**' | wc -l      # 15
```

What those same measurements say after M1–M9, and why each moved:

```sh
grep -rn 'kind === "agent"\|kind !== "agent"\|kind === "terminal"\|kind !== "terminal"' \
  --include=*.ts --include=*.tsx src/ | wc -l   # 113 — see M3: the raw grep was always the wrong
                                                #       meter, and what remains is dominated by the
                                                #       principal/worktree/Studio axes, not entity kind
grep -rl "^agents:" test/fixtures/ | wc -l      # 2  — both are correct: one empty roster, one pointer
                                                #      fixture. INLINE declarations are 0, and that is
                                                #      what M8's guard enforces, not this grep
grep -rn allowLegacyAgentFixtures src/ | wc -l  # 0  — the seam is gone. Remaining matches in test/ and
                                                #      plan.md are comments RECORDING its removal
```

The load-bearing check is no longer any of these greps — it is `test/unit/fixtureAgentDeclarations.test.ts`,
which fails in the commit that reintroduces the shape.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`
<!-- This spec changes no source. The gate is declared because the tree must stay green THROUGH the
     migration this spec orders: every M-step re-runs it, and a doc-only change that broke it would
     mean the base was already broken. -->

## Dogfood

**Dogfood-Opt-Out:** this increment ships an architectural contract and a backlog — documents only.
There is no runnable behavior to exercise end-to-end; the behavior appears in M1–M9, each of which
carries its own dogfood. Fabricating a command here would prove nothing about what shipped.

**M9 dogfood:** `npm run dogfood -- adhoc-agent-boundary` — drives the installed CLIs to check that the
declaration has not rotted: every declared runtime present on the machine answers `--version` and is
admitted, every declared argv brief channel still appears in that CLI's own help, real generic commands
are refused naming `spawn_terminal`, and a runtime reached through an `env`/`npx` launcher still
resolves. Absent runtimes are reported, never passed — a machine without `gemini` is not evidence about
`gemini`. It found one real defect on its first run: `opencode --help` writes its usage to **stderr**
and exits 0, so a stdout-only probe would have reported a flag missing that is still there.

**Human dogfood:** completed 2026-07-27 — the human confirmed the boundary and ratified the lighter
attested Agent path for ad-hoc `spawn_agent`; generic commands use an explicit Terminal operation.

## Visual QA

**Visual QA Opt-Out:** documentation only; no rendered surface changes in this increment. The sidebar's
`ai` flag and the `hubot`/`terminal` icon are boundary encodings, but they change in M5, which carries
its own evidence.

## Cookbook

**Cookbook-Opt-Out:** no operator surface. This spec changes what Tachyon *is*, not how anyone invokes
it; the config-authoring rules it implies are documented in `docs/architecture/agent-vs-terminal.md`
and reach operators through the refusal diagnostics in M6.
