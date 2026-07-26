# 461 — probe-model-provenance — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Inspection corrected the original task premise: Claude's adapter already sends `--model`; the
  missing capability was persistent requested-versus-reported provenance.
- `modelUsage` can contain more than one provider model record, so the adapter preserves a sorted,
  de-duplicated `reportedModels` array under opaque native evidence instead of electing one model.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- `reportedModels` remains under `ProbeResult.native`: it is auditable provider evidence but not a
  portable cross-runtime promise. The display layer can show it honestly without collapsing it into
  the requested model.

## Verification log

- `npx vitest run test/unit/probeAdapterClaude.test.ts test/unit/probeService.test.ts test/unit/probeStore.test.ts` — 37 passed.
- `npm run typecheck` and `npm run verify:full:quiet` passed.

## Open questions

None for the provenance boundary. The separate Probes-table display remains `t-3a3de1`.
