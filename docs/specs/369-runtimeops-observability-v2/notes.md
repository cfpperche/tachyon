# 369 — runtimeops-observability-v2 — notes

_Created 2026-07-10._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-10 maintainer clarification: "vendor CodexBar" means reuse/evolve its collection engine, never its visual
  interface. Runtime Ops remains the sole product surface.
- 2026-07-10 initial boundary: treat CodexBar as a mature acquisition implementation and reference architecture, not
  as Tachyon's canonical domain. Preserve upstream provenance while mapping into a versioned Tachyon envelope.
- T0 ADR pending: fork, extract, or port is deliberately unresolved until reproducible platform/source/maintenance
  evidence exists.
- Mission Control context: parent design task `t-ed03b3`; vendor-strategy research task `t-79dee5`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- Does host-initiated periodic execution of a consented provisioned tool fit the current plugin authority model, or is
  a new read-only plugin observation-source port required? T0 must answer from code and a minimal spike.
- Should bounded local Codex/Claude cost totals ship with quota windows or immediately after them? Maintainer decides
  after T0 shows source reliability and payload/maintenance cost.
