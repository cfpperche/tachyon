# 478 — agent-terminal-boundary — notes

_Created 2026-07-27._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **The union replaced "a stricter validator" mid-analysis, and one measurement caused it.** The
  starting assumption was that `parseAgentEntry` simply needed to reject more keys for terminals. Then
  counting the agent-only fields on `ManagedEntryDef` showed **sixteen** of them, of which only
  **four** are actually refused (`kind`, `instructions`, `soul`, `selfEvolution`, plus `role`
  separately). The remaining twelve — including `harness`, `worktree`, `verify` and `isolate` — are
  fully declarable on a terminal today and are simply never read. That is the signature of per-field
  validation drift: each guard was added with its field, and the ones added later were not. A longer
  list of guards reproduces the same failure mode in a year, so the field has to leave the type.

- **`inferKind` is not deleted, it is demoted and renamed.** Two of its uses are genuinely different.
  At authoring time, suggesting "this looks like a terminal" to a human who can see and override it is
  good UX and violates nothing. At persistence time (`SessionLedger.ts:471`) the same function silently
  re-derives an entity's identity from a string, with no human in the loop. Keeping one and killing the
  other requires them to stop sharing a name — `inferKind` reads as authoritative at every call site.

- **The migration is ordered by what makes the next step mechanical, not by risk.** M1 (one runtime
  list) before M2 (the union) because the Agent arm needs `AttestedRuntime` to exist. M2 before M3
  (narrowing) because the compiler's output after M2 *is* the work list for M3 — estimating M3 before
  that would be guessing at 115 grep hits that are not 1:1 with real narrowings.

## Deviations

- **`spec.md` was drafted rather than left empty**, against the skill's default that intent belongs to
  the human. Justified because the human ratified the intent in `t-9c7a5d` in unusual detail (the seven
  deliverables are quoted almost verbatim into the acceptance criteria). Flagged in-file with a comment
  block: it is a draft awaiting ratification, not a fait accompli.

- **Four cited line numbers were wrong on first write and were corrected before publication.**
  `ManagedEntryDef` ends at 162 (not 165); the terminal-key refusals are at 779-782 and 863-864 (not
  778-786/860-870); `Workspace` continuity and compaction gates are at 1500 and 1404 (not 1483/1403 —
  those were read in the primary checkout *before* SDD 477 landed and shifted the file). All 20
  citations were then spot-checked against the worktree at `2320c2be`. Recorded because the spec's
  first acceptance criterion is precisely that these citations be true, and because it is the concrete
  reason that criterion is worth having.

## Tradeoffs

- **Counted evidence over exhaustive evidence.** The inventory states 115 conditionals across 40 files
  and lists six representative ones rather than all 115. The full list would be unreadable and would
  rot within a week; the counts are re-derivable by the commands in `tasks.md` § Verification, which
  makes the claim checkable without freezing it.

- **`attention` recorded as shared, knowing it may be wrong.** It is the one row where the matrix could
  flip, and flipping it would strand the needs-input scenario that `t-9418ac` just re-based onto a
  terminal. Recorded as an open question rather than blocking, because the reversal is small and
  contained, whereas waiting on it would block the entire backlog.

## Open questions

- **Ad-hoc `spawn_agent` is the real fork** (carried into `spec.md` § Open questions). An ad-hoc spawn
  with a `cmd` has no profile and no host authority, so under the ratified rule it cannot be an Agent —
  but the delegation contract in `spawn_agent`'s own description (spec 246) only makes sense for agents,
  and ad-hoc AI children are in daily use. Either they get a lighter attested path or they become
  Terminals and the delegation contract moves. Blocks M9 only; everything before it can proceed. Owner:
  the human.

- **Is `kind:` under `agents:` retained at all?** A canonical `agents:` entry is a profile pointer, so
  `kind: terminal` under `agents:` is self-contradictory. Deleting the key is cleaner than validating
  it, but it is a config-surface break. Not urgent — it can ride M6.

- **How large is M3 really?** 115 grep hits is an upper bound on conditionals and a lower bound on
  narrowing sites: a place that reads `def.harness` without checking `kind` at all does not appear in
  the grep but will fail to compile after M2. The true number is knowable only after M2, which is why
  M3 is not estimated here.
