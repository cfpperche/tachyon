# 365 — orchestrator-delivery-hygiene — notes

_Created 2026-07-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **2026-07-09 — dualet via probe, not declared agents.** Claude probe
  `probe-ffbd1c93` and Codex probe `probe-60d641b0` reviewed the draft inlined
  in context. Both **REFINE**. Full write-ups:
  `.tachyon/reviews/365-orchestrator-delivery-hygiene-claude.md`,
  `.tachyon/reviews/365-orchestrator-delivery-hygiene-codex.md`.
- **2026-07-09 — fold into spec.md.** Renamed to GitDelivery / `git_delivery_*`;
  integration = ancestry **or** cherry/patch evidence + recorded integratedSha;
  prune always live-git; abandon keeps branch by default; integrated_unverified
  for unevidenced override; taskLinks required for landed_without_integrated;
  currentHeadSha vs reviewedHeadSha; actor policy defaults fail-closed for
  mutate main/prune; store gitignored; autoPrune out of Phase 1; concurrency
  version + unique branch/path; explicit phase transition table.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
