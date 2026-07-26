# 475 — probes-effective-model-column — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **`not-requested` still shows an identifier when one was reported.** The obvious reading of "no
  model requested" is an empty cell, but the runtime often told us what it ran anyway (every Grok
  probe since SDD 474). Discarding that would throw away a fact the artifact holds, so the cell shows
  it in a neutral state and reserves `—` for genuinely knowing nothing.
- **A `proven` verdict with no stored identifier still renders `—`.** Defensive, and covered by a
  test: the cell can only print what it has, so a corrupt or partial artifact degrades to an absence
  rather than to a confident-looking blank claim.
- **`modelState` is a closed set separate from the text.** The renderer switches on state, never on
  the label, so changing the copy can never silently change a colour — and `unproven` is styled as a
  muted absence rather than an error, because not knowing is not the same as failing.

## Visual QA found three real defects that no unit test would have caught

Captured against a baseline of the pre-change table so the regressions were attributable rather than
assumed:

1. **The model cell's `16ch` cap was far too tight.** Every identifier wrapped to two or three lines
   and rows grew tall, destroying scannability, while the right-hand side of the table sat empty.
   Widened to `24ch`.
2. **The ninth column squeezed two neighbours into wrapping.** `✓ completed` broke under its tick and
   `adversarial-review` split across lines — confirmed against the baseline as caused by this change,
   not pre-existing. Both are short closed-vocabulary labels, so `white-space: nowrap` restores the
   row rhythm at no cost; the excerpt remains the flexible column.
3. **`overflow-wrap: anywhere` broke words mid-token.** At a narrow width `unproven` rendered as
   `unprove` / `n`, which reads as corruption rather than a value, and identifiers split as
   `…2026010` / `1`. Changed to `break-word` so the browser prefers the identifier's own hyphens,
   and pinned the two short states to `nowrap`.

## Deviations

None material. The plan's file list held.

## Tradeoffs

- At a deliberately narrow width the longest dated identifiers still occupy two or three lines. That
  is the accepted cost of showing the full provider-native identity rather than truncating it: a
  truncated model id is exactly the kind of half-fact this column exists to eliminate. No horizontal
  overflow at any width tested.

## Open questions

None. Codex rows read `unproven` because Codex genuinely cannot prove its model (`t-a10d31`), which
is the honest rendering of that state rather than a gap in this column.

## Verification log

<!-- appended by `/sdd verify --run` -->

## Dogfood log

<!-- appended by `/sdd dogfood --run` -->

### 2026-07-26T20:32:26Z — pass (1/1) — source: tasks.md — commit: 8c9eaf4d3a66843d15a384fecf2403b3aa993b34
- `npm run dogfood:probes-model-column` — pass
