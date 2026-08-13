# 504 — truthful sidebar boot state — implementation tasks

_Proposed work for a separate implementation task. Nothing below is implemented by t-bb152a._

## Implementation

- [ ] Add fail-before protocol/render tests for unknown, configured-starting, confirmed-unconfigured,
  delayed, failed, ready, and mixed multi-root states.
- [ ] Project folder discovery and registry attach lifecycle through the sidebar host message.
- [ ] Render and localize the new states; preserve the existing welcome only for confirmed absence.
- [ ] Wire per-folder Retry and existing Output diagnostics without duplicating attaches.
- [ ] Cover every actor × trigger row from `plan.md`, including folder removal during attach and
  crash/reconnect with last-known-good data.
- [ ] Capture cold/reload/absent timing samples and choose the delayed threshold from the sample.

## Verification

- [ ] Focused sidebar protocol, host, and render tests fail before and pass after.
- [ ] Browser checks prove 880 px and 360 px layout for starting, delayed, failed, and mixed multi-root.
- [ ] Live reload with a configured workspace never exposes Initialize Tachyon while attach is pending.
- [ ] Live absent workspace reaches the existing Initialize Tachyon welcome promptly and does not remain starting.
- [ ] Final full gate attests the implementation tree.

**Headless check:** to be declared by the implementation task after test file names exist.

**Dogfood-Opt-Out:** this planning artifact ships no executable behavior; the implementation task must declare a live reload dogfood.

## Visual QA

- [ ] Evidence: implementation screenshots at 880 px and 360 px.
- [ ] Verdict: starting/delayed/failure copy is legible and the confirmed-empty action remains reachable.

**Cookbook-Opt-Out:** no new operator surface; this is an internal sidebar lifecycle contract.
