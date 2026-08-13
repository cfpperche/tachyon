# 503 — notify-agent-stranded-composer — plan

_Drafted from `spec.md` on 2026-08-13. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a fail-before workspace test for the exhausted idle edge. Expose fresh composer text alongside the existing occupancy probe. In the queued drain, compare the live composer with the retained queue head; when they match exactly, retry Enter on that existing line without pasting it again. All other occupied composer content remains human-owned and held.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Use exact queue-head equality as ownership** — chosen because the queue is an existing out-of-band mark; rejected provenance-text-only matching because a human can paste arbitrary text.
- **Retry the staged line without retyping** — chosen because the composer already contains the payload; rejected routing through `submitNoticeLine` because it would duplicate the notice.

## Files touched

- `src/attention/AttentionMonitor.ts` — fresh composer-text probe.
- `src/tmux/TmuxService.ts` — confirmed submit of an already-staged exact line.
- `src/workspace/Workspace.ts` — queue-head ownership recovery.
- `test/unit/notifyDoorbellDelivery.test.ts` — deadlock and human-draft regression.

## Risks & unknowns

A loose matcher could submit human text. Exact equality and the retained queue item keep the change narrow; any divergence remains fail-closed.

## Visual impact

None; no layout or rendered-output change.

_Prototypes and durable evidence are opt-in. When this spec needs them, keep them inside `docs/specs/503-notify-agent-stranded-composer/` (for example `prototypes/` or `evidence/`) unless a non-empty `**Artifact-Location-Opt-Out:** <reason>` documents why the artifact has a different owner._

## Sources consulted

`src/workspace/Workspace.ts`, `src/attention/AttentionMonitor.ts`, `src/tmux/TmuxService.ts`, `test/unit/notifyDoorbellDelivery.test.ts`, `test/unit/humanDraftHoldsNotice.test.ts`, task `t-e169e4`, and the 2026-08-13 doorbell/activity ledgers.
