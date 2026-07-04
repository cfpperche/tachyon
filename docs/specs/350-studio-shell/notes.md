# 350 — studio-shell — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-04, runId probe-8e5deca0)

13 findings (3 blockers), spec inline per [[probe-sandbox-no-fs]]. ALL ACCEPTED — no rebuttals; the review's
center of gravity (F1: "the Task migration must not be both the experiment and the casualty") inverted the
draft's pilot strategy and is plainly right:
- F1/F4: proof-by-fakes first — behaviorally-complete Pipeline skeleton (fake adapter, full lifecycle) is
  Phase 1, Task Studio migration is Phase 2 behind the gate.
- F3/F8: Agent Studio named as the studio that breaks the abstraction first — tabs become a first-class
  navigation contract proven by an Agent-shaped fixture + AgentForm compatibility spike BEFORE the shell is
  declared stable; the Agent migration task cannot even be queued before the fixture exists.
- F2: the extension slot gets discipline (versioned discriminated union, adapter-registered typed domain
  messages, fail-closed unknowns, no duplication of core semantics) — otherwise the three dialects just
  move inside the envelope.
- F5/F6: dirty tracking adapter-declared (computeDirty/serializePatch/canDiscard); ConcurrencyContract
  none|cas typed — "where domain has it" was too loose for a fail-closed house.
- F7: panel restore across window reloads enters the base contract (was missing entirely from the draft).
- F9: adapter surface budget — "thin configuration" becomes checkable (hook categories; bypass hooks
  forbidden without amendment).
- F10-F13: content regions (Pin's future), typed error taxonomy with shell-owned save gating, i18n labels
  contract + stable error codes, stateful preview scenarios so the visual pass can't mask behavior.
