# 482 — unified-agent-instance — tasks

_Generated from `plan.md` on 2026-07-28._

**Ratified 2026-07-29** (`t-5e1113`, journal `j-f7fc20368177`). Implementation is authorised and
proceeds in verifiable slices, each landing green on its own tree.

## Gate

- [x] Measure the current code and record it with citations (`notes.md`).
- [x] Produce the ratifiable architecture (`spec.md`, `plan.md`).
- [x] Adversarial review by `claude-reviewer` — returned BLOCKER on two measured claims; both
      confirmed against the code and corrected (see `notes.md`, which keeps the errors visible).
- [x] Second adversarial pass on the corrected scope and the creation-door threat model — no new
      blocker; one residue of the first correction and two threat-model gaps, all three closed.
- [x] Present only the real decisions to the human and ratify — five approved, recorded in
      `spec.md` § Ratified decisions.
- [x] Decompose into verifiable slices (below).

## Slice 0 — symmetric durable lineage (ratified decision 5)

_First because it is small, self-contained, and the only ratified decision that changes measured
behaviour today. It also removes a strip that the fork work would otherwise have to reason around._

- [x] `stripDeclaredParent` stops discarding a declared instance's parent — the function is gone.
- [x] A Saved instance's parent survives a restart, exactly as a Temporary one's does. Needed BOTH
      halves: the write stopped stripping AND `rehydrateFromLedger` stopped skipping config-owned rows.
- [x] `declaredOwner` is untouched, and neither edge is derived from the other (asserted).
- [x] Lineage is bounded by the INSTANCE — `startedHere`, admitted in one place (`ledgerParentOf`).
      Caught by the existing suite, not by me: my first cut re-nested a top-level agent from a stale row.
- [x] A self-parent is refused on WRITE (`withoutSelfParent`), with a defensive read for older rows.
      Landed in `main` as 6882b2dc / tree 6a5131f0e085.

## Phase 1 — converge fork onto the spawn implementation

_Replaces the first draft's "durable lineage" phase, which adversarial review showed was aimed at a
non-problem (`notes.md`)._

- [x] `commitFork` stops building its own session — `createOwnedSession` is the one door, carrying the
      execution-env ordering, the memory scope and Pi admission. Identity is minted by the caller and
      passed in, because both callers need the provenance in their DIFFERENT failure paths (an
      ordinary launch must never kill an ambiguous same-named pane; a fork preserves its Git-locked
      checkout as recovery state). Pinned by `test/unit/ownedSessionCreationShared.test.ts`.
- [x] Equivalence proof. Two layers, because they catch different failures:
      `test/unit/ownedSessionCreationShared.test.ts` proves there is ONE door (a behavioural test
      cannot see a second `newSession` appearing), and `agentManager.test.ts`
      "spawn and fork both refuse an agent-forged execution identity" proves the door BEHAVES the same
      through both callers — a hostile agent declaring `TACHYON_EXECUTION_ID` is overridden on both
      paths, and the fork gets a distinct identity. Fork's transcript sharing, `--fork-session`,
      per-runtime refusals (`adapter.forkCommand`) and every gate stayed in `commitFork`; the existing
      fork suite covers them unchanged.
- [~] Forking a Saved agent and `declared: false` — **moved to phase 2, deliberately.** Measurement:
      there are TWO `declared: false` in `commitFork` with DIFFERENT meanings, which is itself the
      clearest illustration of invariant 5. (a) `withSessionOwnership(..., {declared: false})` sets
      `ownershipOnly` — it withholds the declared-agent lifecycle hooks, and that is a correct
      authority boundary: a fork has no profile authority to inherit. (b) the ledger row's
      `declared: false` means "config does not own this definition", which is TRUE — a fork has no
      `tachyon.yml` entry. Flipping (b) to `true` would make `rehydrateFromLedger` treat the fork as
      config-owned and NOT adopt its definition, so the fork would lose its definition on reload. The
      conflation is real but the fix is the `identity`/`lifetime` split, not a boolean flip.

## Phase 2 — identity and lifetime as declared fields

- [x] `instance: { identity, lifetime }` on the session record, written by both real paths.
      TWO fields rather than one enum, and the fork is what proves it: no durable Profile
      (`temporary`) but it owns a resume block (`restartable`). One value would have to lie about one
      of the two, most likely about whether the fork survives.
- [x] No inference. Both are declared from what the operation WAS: `adhoc = !!opts.cmd ||
      forced.ephemeral` is the caller's declaration, never the name, the tmux session or
      `tachyon.yml`. Verified before writing this, because deriving from YAML presence is exactly the
      forbidden move.
- [x] Pre-split rows keep an ABSENT policy — synthesising one from `declared` at read time would
      re-create the inference this replaces. An unrecognised value is dropped, not coerced.
- [x] `declared` untouched as a storage fact; no reader moved. Phase 3 owns that, deliberately apart
      so the write side is proven before anything depends on it.

## Phase 3 — converge the readers (IN PROGRESS — foundation + first group landed)

- [x] The resolver: `src/agents/agentInstancePolicy.ts` answers the QUESTIONS readers ask
      (`isTemporaryInstance`, `mayRestartInstance`) instead of exposing the fields. The legacy path
      lives in exactly one place, and `legacyFallbackUsed` makes it observable so removing it later is
      an observation rather than a hope.
- [x] Legacy rows stay honest: no policy is invented for a pre-phase-2 row. The helper answers such a
      row the way the reader always did — which is exactly as right, and as wrong, as it has been.
- [x] The declared policy is exposed on the `AgentManager.list()` row so readers need not touch the ledger.
- [x] Equivalence proof, enumerating row shapes rather than sampling: policy agrees with `declared`
      on every shape this build writes, with ONE deliberate divergence — a fork is not `declared`, so
      the old answer said it could not be restarted, while it owns a resume block and always could.
      A contradictory row is pinned too, so no reader may depend on the two agreeing.
- [x] Converged: handoff distill (`isTemporaryInstance`) and handoff distill service
      (`mayRestartInstance`) — a coherent group that asks both questions.
- [x] Fleet/sidebar, converted per-read rather than per-file: `adhoc` (agent + terminal) and
      `canDismiss` (both sites) are identity questions and are converted. `persistenceHooks` and
      `continuity` are NOT — they ask a THIRD question (were lifecycle hooks injected?) that the
      ratified model has no field for. See `notes.md` § the third axis; it needs a human decision, not
      an invented field.
- [ ] Remaining readers: Activity, Attention, Execution Graph, worktree, cleanup.
- [ ] No duplicate removed yet — deletion waits until every reader is converged, per the plan.

## Phase 4 — the governed creation door (severable)

- [ ] Capability in the proposer's Profile; absence refuses by name.
- [ ] A committed agent never carries the creation capability — refused at commit, tested directly.
- [ ] Per-proposer pending ceiling; identical re-proposals collapse on digest instead of queueing.
- [ ] Typed, immutable, digest-bound proposal; agent writes nothing durable.
- [ ] Host validation through the Agent Studio schemas/projections/policies/transaction.
- [ ] Human Inbox review: effective config, runtime/model, dangerous permissions, requested ownership,
      affected files/authorities, diff without secrets.
- [ ] Approval bound to the digest; A2A cannot simulate it.
- [ ] Atomic commit of profile + authority + roster; compensation on failure.
- [ ] Receipt: proposer, approver, digest, transaction/operation id, outcome.
- [ ] Revocation, expiry, cancellation, idempotent retry, post-restart behaviour.
- [ ] Saving does not start the agent.

## Phase 5 — terminology and removal

- [ ] `Saved Agent` / `Temporary Agent` / `Probe` with compatibility aliases.
- [ ] Remove duplicate mechanisms only against the equivalence proofs from phase 3.

## Verification

- [ ] Each phase green under `npm run verify:full:quiet` on the tree it delivers.
- [ ] Every threat-model control has a test that fails without the control.
- [ ] No regression for Claude, Codex and Grok first; OpenCode/Pi/Hermes secondary.

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** architecture only; nothing executable ships until a ratified slice does.

## Visual QA

**Visual QA Opt-Out:** no surface changes in this deliverable. Phase 4's Human Inbox review surface
needs it when that phase is authored, and agents do not open a Dev Host here (`t-ce83a2`).

## Cookbook

**Cookbook-Opt-Out:** no operator surface ships in this deliverable. Phase 4 adds a proposal/approval
flow and should carry one when authored.
