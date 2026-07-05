# 358 — runtime-profiles — notes

_Created 2026-07-05._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dueto disposition (probe 525ea0c8) — codex profiling codex
10 findings, 3 blockers, ALL accepted. Central: I conflated delivery-integrity (Bridge-verifiable) with
correctness (not). Folded: (1) integrity≠correctness reframe; (2) contract MODES not monolith + artifact_policy
(no blind commit-hash); (3) profile_fingerprint + drift detection + profile-smoke (no silent rot);
(4) onboard = interview(hypothesis)+probes(measured), source-tagged fields; (5) isolation measured
(none|unknown|mint|private-home + verified), Bridge fail-closed on unknown/none (don't blindly kill the
checkbox); (6) risk-tied structured smoke_evidence; (7) profile governance (versioned/owned/reviewed) + typed
sections. The reviewer BEING a codex made its self-report critiques (5) especially credible — it flagged its
own interview answers as untrustworthy without empirical validation.
