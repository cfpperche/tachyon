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
- [ ] `t-914f4e` · **M2 — the discriminated union.** Split `ManagedEntryDef` into `AgentEntry | TerminalEntry`;
      the twelve currently-unguarded agent-only fields leave the Terminal arm. Compiler output from
      this step is the true work list for M3.
- [ ] `t-a054f1` · **M3 — one narrowing.** Replace the 115 ad-hoc `kind === "agent"` conditionals with `asAgent()`
      narrowing. Mechanical once M2 lands.
- [ ] `t-18f6a5` · **M4 — stop inferring at persistence.** Remove `inferKind` from `SessionLedger` rehydrate
      (`:471`, `:499`); a kindless record is refused, not guessed. Rename the surviving authoring-time
      helper to say it is a suggestion.
- [ ] `t-6ebdc8` · **M5 — collapse the parallel UI encoding.** Retire `AgentVM.ai` and
      `isAgentKind = !isScheduleOrCommandOrRunbook` in favour of the union. Carries visual proof.
- [ ] `t-a7ae2d` · **M6 — fail closed at every door.** Terminal Studio refuses an attested-runtime command; the
      `terminals:` parser refuses all 16 agent-only keys, not 4; every refusal names the block to move
      to.
- [ ] `t-ddf054` · **M7 — remove the shim and its fixtures together.** Absorbs `t-315ce9`. Delete `allowLegacyAgentFixtures` and
      migrate the 15 inline-`agents:` fixtures in the same change. One task, so the suite is never red
      for an unbounded window.
- [ ] `t-a31844` · **M8 — make the ban self-enforcing.** A repository test asserting no fixture declares a
      non-attested command under `agents:`.
- [ ] `t-8f3f7d` · **M9 — enforce ad-hoc `spawn_agent`.** Accept only supported, attested LLM runtimes
      through the lighter Agent path; route generic commands to an explicit Terminal operation.

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

The counts in the inventory are re-derivable, which is what makes them checkable rather than asserted:

```sh
grep -rn 'kind === "agent"\|kind !== "agent"\|kind === "terminal"\|kind !== "terminal"' \
  --include=*.ts --include=*.tsx src/ | wc -l   # 115
grep -rl 'kind === "agent"\|kind !== "agent"\|kind === "terminal"\|kind !== "terminal"' \
  --include=*.ts --include=*.tsx src/ | wc -l   # 40
grep -rl "^agents:" test/fixtures/ | wc -l      # 15
grep -rl allowLegacyAgentFixtures test/ | wc -l # 0
```

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`
<!-- This spec changes no source. The gate is declared because the tree must stay green THROUGH the
     migration this spec orders: every M-step re-runs it, and a doc-only change that broke it would
     mean the base was already broken. -->

## Dogfood

**Dogfood-Opt-Out:** this increment ships an architectural contract and a backlog — documents only.
There is no runnable behavior to exercise end-to-end; the behavior appears in M1–M9, each of which
carries its own dogfood. Fabricating a command here would prove nothing about what shipped.

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
