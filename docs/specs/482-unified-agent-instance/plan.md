# 482 — unified-agent-instance — plan

_Drafted from `spec.md` on 2026-07-28. The approach, not the steps._

## Approach

The measurement moved the starting line. The proposal's steps 1–4 ("define types", "create one
internal spawn/start port", "adapt Temporary to it", "adapt Saved to it") are three-quarters done in
the code already, so the plan starts where the duplication actually is.

1. **Durable lineage** — the one measured defect with user-visible consequence. Parent survives an
   engine restart the way identity already does; a Saved agent's parent stays stripped.
2. **Split the overloaded boolean** — `identity` and `lifetime` become declared fields on the instance
   record. `declared` remains as a storage detail nobody reads for policy, then stops being read at all.
3. **Converge the readers** — Fleet, Activity, Attention, Execution Graph, worktree, cleanup branch on
   declared policy instead of on provenance. No renderer or store is added.
4. **The creation door** — capability, typed proposal, host validation through the existing Studio
   transaction, Human Inbox review, digest-bound approval, atomic commit, receipt.
5. **Terminology** — rename last, with aliases, once behaviour is settled.
6. **Remove duplicates** — only against an equivalence proof.

Phases 1–3 are reversible and independently valuable. Phase 4 is the one that adds new authority and
is the natural place to stop if the human wants less.

## Key decisions

- **Start at lineage, not at naming.** It is the only thing measurement showed to be broken rather
  than merely duplicated. Rejected: renaming first, which is visible but empty.
- **Two fields, not one enum.** `identity` (Profile-backed or not) and `lifetime` (restartable or
  collected) vary independently — a Profile-backed agent may still be meant to be collected. One enum
  would re-create the overloaded boolean with more values.
- **The creation door reuses the Studio transaction rather than adding one.** Verified rather than
  assumed: that transaction is a journaled phase machine with compensation and crash recovery on
  re-read (`notes.md`), so the door's hardest requirement is already satisfied by existing machinery.
  A second write path to authority would be strictly worse and is exactly the class of thing this SDD
  is trying to reduce.
- **Proposal is data, approval is a host action.** The agent's output is inert and digest-bound, so
  every control is preventive rather than forensic.
- **Phase 4 is severable.** If the human declines the creation door, phases 1–3 still deliver the
  unification and nothing is stranded.

## Files this will touch (survey, not a promise)

- `src/agents/AgentManager.ts` — `definitionOf`, the `adhoc` map, `lineage`/`delegators`, `rehydrateFromLedger`.
- `src/resume/SessionLedger.ts` — the record shape; `declared`; `stripDeclaredParent`.
- `src/config/loadConfig.ts` — `declaredOwner` derivation stays as-is; guarded by an invariant test.
- `src/config/agentProfileStudio.ts` + the authority/roster transaction — reused by the creation door.
- Bridge tools — a new proposal tool; `spawn_agent` untouched.
- Human Inbox / approvals surface — proposal review.
- Fleet, Activity, Attention, Execution Graph, cleanup readers — policy instead of provenance.
- `docs/runtimes/parity.md` — one `Agent Instance infrastructure` dimension per runtime.

## Risks

- **Rehydration is load-bearing.** Lineage durability touches the path that restores agents after a
  restart; a regression there loses agents, not just edges. Needs its own tests before anything else
  moves.
- **`declared` has readers beyond policy.** Removing it must be staged: stop reading it for policy,
  prove equivalence, then remove.
- **The creation door is new authority.** Its threat model is in `spec.md` and each control needs a
  test that fails without it, not a comment.
- **Parity matrix churn.** Collapsing dimensions can hide a real per-runtime gap; the collapse must
  keep `saved`/`temporary` split wherever behaviour legitimately differs.

## Sources consulted

Measured, with citations, in `notes.md`: `AgentManager.spawn` as the single door (`:1675`),
`definitionOf` (`:959`), the `adhoc` map (`:888`), `rehydrateFromLedger` (`:1206`), `SessionLedger`
`declared`/`def` (`:136-145`), `stripDeclaredParent` (`:485`), `declaredOwner`
(`loadConfig.ts:448`, `:1127-1166`), `adhocAdmission` (`:130`), `ProbeService` (`:91`).
Plus `docs/proposals/unified-agent-instance.md`, SDD 352, SDD 478.
