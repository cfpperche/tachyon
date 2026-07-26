# 461 — probe-model-provenance — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep requested model identity in run metadata from launch. Extend the Claude result parser only to
preserve model identities that Claude actually reports through `modelUsage`, then copy them into the
neutral result's opaque native record. The service writes both requested and reported values at
completion. No fallback turns request into report.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Keep reported model under `native`** — it is provider-shaped evidence, not a cross-runtime
  promise. Rejected a new neutral model field because supported runtimes do not report it uniformly.
- **Persist requested model separately** — it records intent even if a probe is interrupted. Rejected
  copying it into reported provenance, which would falsely attest provider behavior.

## Files touched

- `src/probe/adapters/claude.ts` — parse reported model identities from a valid Claude result.
- `src/probe/ProbeService.ts` — retain requested and reported provenance through persistence.
- `src/probe/ProbeStore.ts` — store typed requested/reported fields.
- `test/unit/{probeAdapterClaude,probeService,probeStore}.test.ts` — pin the distinction.
- `docs/specs/461-probe-model-provenance/*` — contract and evidence.

## Risks & unknowns

- Claude may report multiple model-usage records; preserve a deterministic array rather than choose
  one and accidentally invent a primary model.
- Older or failed results may omit usage; absence stays absent.

## Visual impact

No rendered surface changes in this slice; `t-3a3de1` owns the Probes-table presentation.

## Sources consulted

- `src/probe/{ProbeService,ProbeStore,taxonomy}.ts`
- `src/probe/adapters/claude.ts`
- `test/unit/{probeAdapterClaude,probeService,probeStore}.test.ts`
