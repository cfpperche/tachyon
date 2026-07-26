# 475 — probes-effective-model-column — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

The ledger already carries `requestedModel` and the `modelProof` verdict (SDD 473) but not the
effective identifier, because nothing needed to render it. Add `effectiveModel` to the run record,
sourced from the run's own metadata: the provider-native identifiers first
(`reportedNativeModels` — `claude-haiku-4-5-20251001`, `grok-4.5-build`), falling back to the
canonical family (`reportedModels`) for older Claude runs stored before native keys were kept.
Nothing reads an agent's declared model; the fact comes from the run.

The view model then derives one presentational cell per row rather than leaking four raw fields into
the renderer. `buildProbeView` already exists as the pure, unit-tested place where render-ready rows
are shaped, so the decision of what a cell says lives there and the webview stays a thin renderer.

The cell has four shapes, keyed off the verdict:

| verdict | cell |
|---|---|
| `proven` | the effective identifier |
| `mismatch` | the effective identifier, marked as differing, plus the requested one named |
| `unproven` | the literal word `unproven` — never the requested identifier |
| `not-requested` | the effective identifier when the runtime reported one, else `—` |

`not-requested` deliberately still shows an identifier when there is one: the runtime told us what
it ran, we simply did not ask for anything, and that is genuinely useful. Treating it as "—" would
throw away a fact the artifact holds.

## Key decisions

- **One model column, not two** — chosen because the spec's whole risk is conflating requested with
  effective, and two adjacent columns of similar-looking identifiers invites exactly that misread at
  a glance. One cell that only ever prints an *effective* identifier makes the invariant visual, and
  keeps a 9th column out of an already-eight-column table. Rejected a separate "requested" column
  for that reason; the requested value still appears, but only as labelled context on the mismatch
  row and in the cell's title attribute.
- **The cell text is derived in `probeView`, not the TSX** — chosen so "what does this cell say" is
  covered by pure unit tests rather than requiring a rendered DOM. Rejected computing it in
  `App.tsx`, which would put the one piece of real logic in the least testable layer.
- **A distinct `state` field drives styling, not string-sniffing the label** — the renderer switches
  on an explicit state rather than testing whether the text equals `unproven`, so copy changes never
  silently change colour.
- **Running rows assert nothing** — a run with no result yet has no verdict, and printing `unproven`
  there would read as a finished judgement. It renders `—`.

## Files touched

- `src/probe/ProbeStore.ts` — `effectiveModel` on the run record, from the run's own metadata.
- `src/probe/probeView.ts` — derive the cell (`model`, `modelState`, `modelTitle`).
- `src/engine-service/protocol.ts` — carry the three fields across the wire + validator.
- `src/webview/probes/App.tsx` — the column.
- `src/webview/probes/probes.css` — width/wrap treatment for long identifiers.
- `scripts/webview-preview/fixtures/probes.ts` — rows covering every state for Visual QA.
- Tests: `probeView` derivation, protocol round-trip, ledger sourcing.
- `scripts/dogfood/probes-model-column.ts` + npm script.

## Risks & unknowns

- **Table width is the real risk.** Nine columns with a long mono identifier can push horizontal
  overflow in a narrow Control panel. The mitigation is a bounded, wrapping model cell rather than
  `white-space: nowrap`, and the Visual QA pass at a deliberately narrow width is what confirms it —
  this is the part most likely to look wrong and least likely to fail a unit test.
- The wire validator is strict (`hasOnlyKeys`) and shared with the engine; new fields must be added
  to both the type and the validator or the payload is rejected at runtime.
- `modelState` must stay a closed set so the renderer's switch is exhaustive.

## Visual impact

The Probes table gains a **model** column between `runtime` and `archetype` — near the other
run-identity facts rather than at the far right where it would compete with the excerpt. Ways it
could look wrong: horizontal overflow at narrow widths; a long identifier crushing the excerpt
column; `unproven` reading as an error rather than an absence; a mismatch not standing out; or the
column looking empty for the common `not-requested` case. Proof will be preview screenshots at a
normal and a deliberately narrow width, covering proven / mismatch / unproven / not-requested /
running in one table.

## Sources consulted

- `src/webview/probes/App.tsx`, `probes.css` — the current eight-column table and its styling.
- `src/probe/probeView.ts:48-77` — the pure row builder this extends.
- `src/probe/ProbeStore.ts:40-60,144-160` — the ledger record and where metadata becomes a row.
- `src/engine-service/protocol.ts:422-440,1538-1560` — the wire row type and its strict validator.
- `docs/specs/473-probe-effective-model-proof/`, `474-probe-provenance-parity/` — the provenance
  semantics this must not erode.
