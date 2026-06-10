# 200 — tachyon-runbooks — notes

_Created 2026-06-10._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention. See `.agent0/context/rules/spec-driven.md` § The four artifacts for purpose, and `.agent0/context/rules/delegation.md` § The 5-field handoff for how sub-agents integrate._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body. `<author>` is `parent` for the orchestrating agent, or the `subagent_type` (e.g. `general-purpose`, `Explore`) for delegated work.

**Routing rubric:** decision made under ambiguity → §1 Design decisions. Intentional departure from `plan.md` → §2 Deviations. Alternative weighed and chosen mid-flight → §3 Tradeoffs. Question surfaced during build, no answer yet → §4 Open questions. Sections may stay empty; the rubric is a guide, not a quota.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision itself + why this option over others considered in the moment._

### 2026-06-10 — parent — externally-killed step = failure

A step whose session vanishes mid-poll (human killed the pane) resolves with
`exitCode: undefined` and state `failed` — the gate fires. Treating it as anything
else would let a half-run procedure look successful.

### 2026-06-10 — parent — UI run is fire-and-forget, agent run awaits

`tachyon.runRunbookItem` doesn't await the job (the tree + toast narrate progress);
`run_runbook` awaits up to its timeout because the agent's contract is a blocking
result. Same job object underneath, two consumption styles.

## Deviations

_Places where implementation intentionally departed from `plan.md`. The departure + the reason it was necessary or better._

### 2026-06-10 — parent — rerun semantics fixed pre-ship

The first cut of `run_runbook` re-ran a FINISHED job on re-call — wrong for agents
retrying tool calls (duplicate side effects). Fixed before ship: finished jobs are
reported, `rerun: true` is the explicit re-execution door. spec.md's acceptance
scenario was written against the corrected behavior.

## Tradeoffs

_Alternatives weighed during implementation (not at plan time). The chosen path + what was given up + why the tradeoff was worth it._

## Open questions

_Questions surfaced during build that the implementer couldn't resolve alone. Owner (who decides) or path to resolution if known. Promote answered questions to `spec.md` § Open questions or as retroactive acceptance scenarios when the spec is updated._

## Verification log

### 2026-06-10T20:40:11Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass
