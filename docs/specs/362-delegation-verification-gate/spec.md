# 362 — delegation-verification-gate (verify_task)

_Created 2026-07-06._

**Status:** draft

## Intent

Tachyon's moat is **governed delegation** — a coordinator hands work to sub-agents and the container keeps it
safe and attributable. Today one seam is ungoverned: when a sub-agent reports **"done"**, the coordinator
must **trust that claim** or re-verify it **by hand**. Hand-verification works only while a human-grade
coordinator remembers to do it every single time — the exact bottleneck the moat is supposed to remove.

This spec makes the container **prove** a delegation is done against **observable artifacts** instead of
trusting the sub-agent's self-report. The principle (converged from a web-research pass + an adversarial codex
dueto, probe-3b1d1638): *a sub-agent's final message is a CLAIM, not evidence.* A programmatic verifier that
judges outcomes from git + the test runner + the diff is immune to the model's optimism.

**This is not theoretical.** In the single session that motivated this spec (the 350 Phase-4 dismemberment,
8 codex delegations), the coordinator caught, by hand, on landing: green-but-uncommitted work **twice**,
focused-tests-passed-while-full-suite-RED **twice**, a silently-dropped deliverable, and a genuinely-failing
test rationalized as "stale." Every one was invisible to the sub-agent's "done" and to a focused test run.

## Observed failure taxonomy (name them; they recur)

| | Failure | Seen |
|---|---|---|
| **F1** | `green ≠ committed` — reports done, never `git commit`ed (or cites no hash) | Runbook, cutover |
| **F2** | focused-not-full — runs a single-file test, declares green while `npm test` is RED | Terminal, studioPreview, interruptTone |
| **F3** | partial delivery — N deliverables asked, fewer shipped (e.g. forgot a fixture) | interruptTone |
| **F4** | rationalizes a genuinely-failing test as "stale"/skips-excludes instead of fixing | interruptTone |
| **F5** | shared-tree contamination across parallel sub-agents | (mitigated by sequential; latent) |

## The gate — `verify_task`

A **coordinator-owned** verification gate that fires when a delegated sub-agent signals completion
(`notify_agent("done")`) **instead of the coordinator trusting it**, and returns `{ accept } | { blockers[] }`.
The sub-agent can only ever reach `READY_FOR_VERIFICATION`; **the container decides done.**

### Tier 1 — deterministic, always-on, cheap (kills F1/F2/F4)
Run from a clean checkout of the sub-agent's branch/worktree; the sub-agent's own test run **never** satisfies
acceptance:
- **(a) commit-or-fail** — a new commit exists (`HEAD != BASE_SHA`, where `BASE_SHA` is recorded by
  `spawn_agent` at delegation time), it touches the contract's declared paths, and its message carries the
  task id. *(F1)*
- **(b) harness-owned full suite** — the canonical project test command (e.g. `npm test`) run by the gate,
  from clean, green. Agent-run/focused results are advisory only. *(F2)*
- **(c) suppression diff-scan** — scan `BASE_SHA..HEAD` for `.skip`/`.only`/`xit`/`xfail`/deleted-or-renamed
  test files/relaxed assertions/snapshot churn/test-config changes. Any hit requires an **explicit coordinator
  waiver** — the sub-agent **cannot self-waive**. *(F4)*

### Tier 2 — structured contract, larger delegations (kills F3/F5)
Return decays after the first rounds, so escalate only when the contract is big:
- **(d) machine-checkable `done_when`** — the delegation contract's `done_when` becomes structured
  `deliverables[]`, each with a programmatic verifier: `path_exists` / `path_changed` / `symbol_exists` /
  `test_name_exists` / `command_passes` / `contains|not_contains`. The gate checks every deliverable id. *(F3)*
- **(e) worktree-per-agent default** for INDEPENDENT delegations (Tachyon already has `worktree:true` +
  `settings.worktree`) — makes failures attributable and removes shared-tree contention. *(F5)*
- **(f) independent verifier-agent AFTER the deterministic gates** — a second model reviews diff + contract +
  logs against a **constrained schema**; it can only ADD blockers, never override a failed deterministic gate.
  This is our `probe_agent(adversarial-review)` discipline made a routine post-landing step, not just for
  security diffs.

## Integration points

- **spec 246 (delegation contract)** — today `done_when` is validated for *presence/substance* at spawn, never
  *verified at landing*. verify_task is the missing landing-side half. Tier-2 (d) upgrades `done_when` from
  prose to a machine-checkable schema (backward compatible: prose `done_when` → Tier-1-only gate).
- **`spawn_agent`** — records `BASE_SHA` (+ declared OWNS paths) at delegation time so (a) has a baseline.
- **`notify_agent("done")` / completion envelope** — the trigger. The gate runs, and the coordinator is woken
  with `accept` or `blockers[]` (a precise, sendable fix list) instead of the raw claim.
- **Waivers** — a small typed record (`{reason, approved_by:"coordinator", expires}`) the coordinator issues to
  pass a suppression-scan hit; surfaced to the human, never agent-issued.

## Phasing (proposed)

- **Phase 1** — Tier-1 (a)+(b)+(c) as a coordinator-invocable gate. Highest ROI; kills F1/F2/F4 — the three
  that actually recurred. This alone converts "coordinator re-verifies by hand (if it remembers)" into "the
  container verifies, identically, every time."
- **Phase 2** — Tier-2 (d) structured `done_when` + (e) worktree-default.
- **Phase 3** — (f) routine post-gate verifier-agent.

## Non-goals
- Not a replacement for the sub-agent doing its own tests during development (fast inner loop stays).
- Not correctness proof — the gate proves *scoped, committed, suite-green, non-suppressed*, not *bug-free*
  (Tier-2 (f) adds a semantic critic, still advisory).
- Not per-turn friction on trivial one-line delegations — Tier-1 is cheap; Tier-2 is opt-in by contract size.

## MAINTAINER DECISIONS NEEDED
1. **Enforcement stance** — is a failed Tier-1 gate a HARD block (coordinator may not mark the task done until
   green), or advisory (surfaced, coordinator overrides)? (Recommendation: hard for (a)/(b), waiver-gated for
   (c).)
2. **Where the gate runs** — a new Bridge tool (`verify_task`) the coordinator calls, vs. an automatic hook on
   the completion envelope, vs. a coordinator-side skill. (Recommendation: Bridge tool first — explicit,
   testable; auto-hook later.)
3. **Canonical commands per repo** — read from `tachyon.yml` (a `verify:` block: full-suite/typecheck/lint), or
   inferred? (Recommendation: declared in `tachyon.yml`, default `npm test`.)
4. **Scope of Phase 1** — Tier-1 only, or include (d) structured `done_when` from the start? (Recommendation:
   Tier-1 only — it kills the three real recurring failures; prove it before expanding.)
5. **Waiver authority** — coordinator-only, or does the human ratify suppression waivers above a threshold?
