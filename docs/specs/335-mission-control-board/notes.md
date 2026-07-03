# 335 — mission-control-board — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-97f2d13a)

First probe attempt failed usefully: the probe sandbox cannot read files, so the spec text must be embedded
inline in the task prompt (remember for future duetos). Re-run returned 12 findings; disposition:

- **F1 (BLOCKER, rank rebalance needs multi-task writes)** — ACCEPTED. Rebalance execution is store-owned
  (atomic under the mutation lock), midpoint minting stays pure. Whole reorder feature moved to a gated v1.1
  criterion; drag-to-reorder is inert until its gate is green.
- **F2 (BLOCKER, concurrent mints across windows)** — ACCEPTED. CAS expect on the dragged task + collision
  check in the lane; stale reorders fail closed with a retry toast. Non-goal reworded: collisions are
  rejected, never last-write merged.
- **F3 (MAJOR, stale neighbors mid-drag)** — ACCEPTED, generalized to ALL drags (status drags too): pushes
  arriving mid-drag are queued, drop validates against the latest snapshot.
- **F4 (MAJOR, next_task spotlight perf/consistency)** — ACCEPTED via the new "board snapshot" contract:
  one engine-side pass builds TaskView[] + allowedDropStatuses + per-chip next_task results; chip clicks do
  zero disk reads. (Rebutted only the scale framing — real fleets have ~6 chips, not 25 — but the
  consistency argument stands regardless.)
- **F5 (MAJOR, priority edit invalidates rank)** — ACCEPTED with a lighter mechanism than proposed: the
  board's priority quick-edit composes `{priority, rank:null}` in one update. No store change needed (the
  probe proposed store-side clearing; board-side composition keeps 325 untouched).
- **F6 (MAJOR, snap-back-only UX)** — ACCEPTED. Snapshot carries store-computed allowedDropStatuses;
  illegal columns are non-targets at drag-start. Webview still embeds no rules — affordances are data.
- **F7 (MAJOR, mid-edit refresh loses input)** — ACCEPTED. Edit sessions keyed by (task, field), input
  preserved across pushes, CAS expect{updatedAt} from session start, stale editors require explicit retry.
- **F8 (MAJOR, detail panel lifecycle)** — ACCEPTED. Panels subscribe by task id independent of board
  filters; tombstone state for missing/corrupt tasks; never auto-closed.
- **F9 (MAJOR, CSP + markdown)** — ACCEPTED. Sanitizer requirements + malicious-markdown unit tests are now
  an explicit criterion.
- **F10 (MAJOR, 500-task envelope)** — ACCEPTED. 500-task fixture in model tests + keyed card updates +
  responsiveness dogfood.
- **F11 (MINOR, unknown-name chip colors)** — ACCEPTED. Deterministic hash into a categorical palette for
  unknown assignee/kind strings.
- **F12 (MINOR, scope overload)** — PARTIALLY ACCEPTED. Rank reorder split into the gated v1.1 section as
  proposed. REBUTTED for the detail tab: it stays in v1 — maintainer decision (card click → detail webview),
  and without it `body` is invisible on the board, which guts the surface's usefulness.
