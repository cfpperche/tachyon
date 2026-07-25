# 457 — pi-canonical-parity — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Audit the existing Pi private-home lifecycle and OAuth admission tests before changing behavior.
Measure only non-billable CLI surfaces (`--version`, `--help`, offline/invalid local invocation) to
decide whether a probe adapter can have a truthful contract. Reuse the existing Soul startup-argument
delivery evidence where it applies; do not infer provider consumption. Update runtime profile/matrix
only for gaps proven by the audit.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Keep one-live-Pi admission until upstream changes** — private auth copies use separate lock paths;
  rejected concurrency because a test pass cannot reconcile divergent OAuth refreshes safely.
- **Do not add a synthetic headless probe from `--print` alone** — it still requests a model response;
  rejected a network/billable probe without explicit authorization.

## Files touched

_The modules/files this will create or change, with a one-line note on each._

## Risks & unknowns

_What could go wrong, what's not yet proven, what to verify early._

## Visual impact

_Optional for UI/interface/rendered-output work: what visible surface changes, what could look wrong, and what proof will be captured._

## Sources consulted

_Docs, code references, prior specs that informed this plan. Read the repo before proposing._
