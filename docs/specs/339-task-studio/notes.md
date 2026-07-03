# 339 — task-studio — notes

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

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-8f6c9a57)

22 findings (5 blockers). Spec text was embedded inline in the probe prompt per [[probe-sandbox-no-fs]].
Disposition:

- **F1/F2/F15/F18 (BLOCKERS + majors, the "three writers" cluster)** — ACCEPTED via a SIMPLER mechanism
  than proposed: body-hash anchoring instead of conflict metadata/merge UI. The sidecar records the hash of
  the body it derived; a mismatched hash at load means an external (agent) edit happened and the doc is
  REIMPORTED from body — most-recent-writer-wins, body is the interchange format, no dual truth, no merge.
  No-op saves never rewrite body (round-trip preservation unit-tested). F15's limitation is now explicit in
  the spec + requires a follow-up queue task for read-only doc access via bridge tools.
- **F3 + F20 (BLOCKER, truncation)** — ACCEPTED merged: ≤4000 TOTAL incl. a stable non-localized ASCII
  marker, block/line-boundary cuts, no surrogate splits, fence-closing, exact-boundary tests.
- **F4 (BLOCKER, save shape)** — ACCEPTED: dirty-field patch only, never status/rank/untouched fields.
- **F5 + F11 (BLOCKER, sidecar CAS/atomicity)** — ACCEPTED reduced: with body-hash anchoring the sidecar is
  a derived companion, not independent truth, so full sidecar CAS is unnecessary; staged create transaction
  (temp sidecar → store create → atomic promote) + taskUpdatedAt echo cover the failure windows.
- **F6/F9/F13/F21 (lifecycle/namespace/size/schema)** — ACCEPTED as the consolidated lifecycle criterion.
- **F7 (create-mode contradiction)** — ACCEPTED with a 325-consistency correction the probe missed: full
  field set in create EXCEPT assignee, which 325's mutability table forbids outside triaged/active —
  disabled with an "assign during triage" hint (probe proposed enabling it; that would violate the table).
- **F8 (extraction boundary)** — ACCEPTED: entity-neutral modules + adapter seams, pin tests protect Pin
  Studio.
- **F10 (board race)** — ACCEPTED trimmed: dirty-patch exclusion of board-owned fields makes field-level
  CAS unnecessary; banner names changed fields.
- **F12 (quick-add migration)** — ACCEPTED: create semantics + tests preserved/updated.
- **F14/F16 (webview memory, import security)** — ACCEPTED as criteria.
- **F17 (validation via store parser)** — ACCEPTED.
- **F19 (create visibility)** — ACCEPTED: reveal-or-confirm after Save.
- **F22 (integration coverage)** — ACCEPTED: named integration list added.
- Nothing rebutted outright; F5 and F7 were accepted with corrections where the probe's concrete proposal
  conflicted with the shipped 325 contract (sidecar-as-derived-truth; assignee mutability).
