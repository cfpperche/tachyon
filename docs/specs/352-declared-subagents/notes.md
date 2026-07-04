# 352 — declared-subagents — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-48e0b09a) + coordinator adjustments

The spec was drafted by claude-3 OUTSIDE the coordinator's context, before spec 351 (per-agent caller
identity) shipped. The coordinator (claude) read it against current code and found 5 adjustments; the codex
dueto validated all 5 and found 10 more. 15 findings, 3 blockers — all fold into ONE principle:

**`subagents:` = OWNERSHIP (config edge, roster/UI) ≠ runtime lineage `parent` (actor edge, 351/332,
lifecycle). One `parent` concept must never carry both.**

Coordinator adjustments, as validated:
- A1 (invert-at-load) — CONFIRMED but CORRECTED by dueto blocker 2: invert into a DERIVED child-side
  `declaredOwner` map, NOT into `AgentDef.parent` (which now feeds 351 actor lineage). The child-list is
  normalized, but the sink is ownership metadata, never runtime parent.
- A2 (owner-vs-actor) — CONFIRMED as the central blocker (dueto blocker 1/finding 4/6). Kept separate;
  semantics table added; death-poke/liveDescendants keep actor lineage.
- A3 (no AgentForm) — CONFIRMED (finding 12); now a hard out-of-scope, roster-only criterion.
- A4 (AGENT_KEYS) — CONFIRMED as a release blocker (finding 11), not an anchor nit; line numbers marked
  approximate.
- A5 (rehydrate skips declared) — CONFIRMED + extended by finding 13: restart ordering (config ownership
  before ledger rehydrate; rehydrate never invents ownership).

Dueto-only findings folded: multi-owner rejection (9), kind-check as criterion (10), YAML writes only the
canonical parent-side field (7), deep-tree rejection makes direct-cycle sufficient (15), subagents stays on
AgentDef for display/round-trip only (14), criterion-3 split into config-ownership-exists + spawn-provenance
-is-actor (5). Nothing rebutted — in a schema/identity spec the probe's strictness is the deliverable, and
it caught the exact "planned outside context" collision the maintainer flagged.
