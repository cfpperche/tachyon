# 478 — agent-terminal-boundary

_Created 2026-07-27._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Closure:** Shipped 2026-07-27. The architecture deliverable (this spec, `plan.md`, and
**Verify:** `npm run verify:full:quiet`
`docs/architecture/agent-vs-terminal.md`) landed with the human's ratification, and the ordered
backlog M1–M9 it exists to direct is now fully executed and green: M1 `t-939a18`, M2 `t-914f4e`,
M3 `t-a054f1`, M4 `t-18f6a5`, M5 `t-6ebdc8` (`ba32fcc9`), M6 `t-a7ae2d`, M7 `t-ddf054` (`4aac0f37`,
absorbing `t-315ce9`), M8 `t-a31844` (`b386dc9f`), M9 `t-8f3f7d`. Each landed on a tree its own
`verify:full:quiet` had recorded green.

The boundary is now held by construction rather than by review: an agent-only field lives on the
Agent arm, so a conditional cannot be what grants a capability (M2/M3); a kindless persisted record
is refused rather than guessed (M4); the UI reads the arm instead of keeping a third, contradictory
copy of it (M5); every authoring door refuses an agent-only key on a terminal and names where to
move it (M6); the legacy fixture shim is gone along with the 86 tests that depended on it (M7); and
a fixture that reintroduces the shape fails in its own commit (M8).

Three surfaces were measured as unreachable while migrating, and are filed rather than papered over:
`t-d185e1` (`selfEvolution` has no writer for the selector the projection requires), `t-e81ec5`
(`createSoulProfile` writes an inline key onto what is now a pointer), and — recorded in the tests
themselves — `subagents`, which is no longer authorable in roster text. None blocks the boundary;
each is a capability that the canonical shape has not yet been given a way to express.

<!-- Ratified by the human on 2026-07-27, including the ad-hoc spawn_agent decision. -->

## Intent

A human decided, on 2026-07-27: **an Agent is exclusively an entity operated by an LLM runtime that
Tachyon supports and attests. A Terminal is exclusively a generic process — a shell, a server, a
build. A terminal has no identity, task, memory, model, provider authentication, or agent
lifecycle.** `cmd: sh`, echoers and prompt scripts may never be declared or treated as agents, not
even in fixtures.

The decision was forced by a concrete failure rather than by taste. `t-9418ac` spent three increments
discovering that the editor-host suite could not start, and the cause turned out to be that its
fixture declared three shell processes as agents. The product had already retired that shape — every
`agents:` entry must now be a canonical profile pointer backed by a host authority — so the fixture's
single invalid stanza invalidated the **whole** config, and commands, runbooks and schedules failed
for a reason none of them had anything to do with. Two of the three "agents" were not even agents by
the product's own inference: `sh` infers `terminal`, and only a hand-written `kind: agent` had forced
the third.

That is the shape of the defect: the distinction exists, is enforced in places, and is contradicted in
others. Today it is encoded at least five different ways, none authoritative, and one of them
recomputes an entry's kind from its command string every time it is read back from disk. So "is this
an agent?" has different answers in the config loader, the ledger, the attestation layer, the resume
adapters and the sidebar — and a wrong answer is not cosmetic. It decides whether Tachyon offers an
entity a task, a soul, a worktree, provider authentication and a restart policy.

Done looks like: one authoritative, typed boundary. An Agent and a Terminal are different types, not
one struct with a discriminator field and sixteen optional properties. Agent-only capabilities are
unrepresentable on a Terminal rather than merely rejected by a validator. No layer infers the
distinction from a command string or a name. Ambiguous declarations are refused with a diagnostic that
names the fix. And the test strategy stops needing a fake agent, because agent semantics are proven
against doubles in the domain rather than against a shell pretending to be a runtime.

This is an **architecture** spec. It defines the contract and the ordered migration; it deliberately
does not perform the migration.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

This spec ships **documents**, so its acceptance is about the documents being true of the code and
sufficient to execute from — not about the migration having happened.

Ticked on 2026-07-27 at closure. The mirrored checks in `tasks.md` § Verification carried the
evidence when the documents landed; what the closure adds is the strongest available proof of the
third scenario in particular — the backlog **was** executed, M1 through M9, by agents working from
these documents and not re-deriving the analysis. The one criterion that had drifted was the first:
its counts were re-derivable only against the anchor commit, and one of the published commands
under-reported because a bare `src/**/*.ts` pathspec skips depth-1 files. Both are corrected in
`tasks.md`; every command there now reproduces the number printed beside it.

- [x] **Scenario: the inventory is grounded, not asserted**
  - **Given** the inventory in `plan.md` § Inventory
  - **When** a reader checks any of its claims against the tree at the recorded commit
  - **Then** every claim names a file and symbol that exists and says what the inventory says it
    says, including the counts.
- [x] **Scenario: a rejected alternative is recoverable**
  - **Given** a reader who wants to know why the boundary is not simply a stricter validator
  - **When** they read `plan.md` § Rejected alternatives
  - **Then** they find that option, why it was rejected, and what evidence decided it.
- [x] **Scenario: the backlog is executable without re-deriving the analysis**
  - **Given** the follow-up tasks created by this spec
  - **When** an agent picks up any one of them
  - **Then** it states its own boundary, its verification and its ordering dependency, and does not
    require reading the whole inventory first.
- [x] The invariant matrix states, per capability, whether it is Agent-only, Terminal-only or shared,
      and for every Agent-only row names the code that grants it today.
- [x] Every invariant is written so it can be **mechanically checked** — each names either a type that
      makes the violation unrepresentable, or a test that would fail.
- [x] The typed boundary is specified concretely enough to implement: the discriminated union, what
      moves onto which arm, and what happens to the shared fields.
- [x] The fail-closed rules state, for each entry point that can create or import a managed entry,
      what is accepted, what is refused, and the diagnostic the refusal produces.
- [x] No layer is left deriving the Agent/Terminal distinction from a command string or a name; where
      that happens today it is listed with its replacement.
- [x] The migration plan is ordered, has no step requiring an artificial compatibility shim, and names
      the dead seams it removes.
- [x] Follow-up tasks exist in the queue for every migration step, with no duplicates of each other or
      of the already-open `t-05097f`, `t-8247ec`, `t-1e5ab8`.

## Non-goals

- Performing the migration. This spec produces the contract and the backlog; execution is the tasks it
  creates.
- Changing what an LLM runtime *is*, or which runtimes are attested. The attested set (`codex`, `pi`,
  `grok`, `claude`) is an input here, not a decision.
- Redesigning attention, resume, worktrees, delivery or Mission Control. Where those touch the
  boundary they are inventoried and constrained, not reshaped.
- Preserving inline `agents:` compatibility, for fixtures or for anything else.
- Changing the read-only branch the engine enters on an invalid config. It is correct, and `t-9418ac`
  confirmed it by measurement.
- Fixing the three defects the boundary work exposed but did not cause (`t-05097f`, `t-8247ec`,
  `t-1e5ab8`).
- Publishing a release or touching Marketplace state.

## Open questions

- **Resolved — ad-hoc `spawn_agent`.** `spawn_agent` remains an Agent operation and accepts only a
  supported, attested LLM runtime through a lighter path that does not require a canonical profile.
  Generic commands use an explicit Terminal operation instead. An ad-hoc child does not become a
  Terminal, because task, lineage, delegation and worktree are Agent semantics. Ratified by the human
  on 2026-07-27; implemented by M9 (`t-8f3f7d`).
- **Does `Terminal` keep `attention` at all?** Today it can opt in, and `t-9418ac` used exactly that to
  re-base the needs-input scenario. Attention is pane-shaped and runtime-agnostic, so "shared" is
  defensible — but it is also the one capability that makes a terminal look agent-like in the sidebar.
  Recorded as shared in the matrix, flagged here as the row most likely to be wrong.
- **Is `kind:` under `agents:` retained at all?** A canonical `agents:` entry is a profile pointer, so
  `kind: terminal` under `agents:` is already self-contradictory. Deleting the key is cleaner than
  validating it, but it is a config-surface break for anyone still writing it.
