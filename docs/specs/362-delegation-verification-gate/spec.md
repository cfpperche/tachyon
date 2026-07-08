# 362 — delegation-verification-gate (verify_task)

_Created 2026-07-06._

**Status:** shipped — Phase 1 live and dogfooded (0.55.58–0.55.64); Phase 2 backlog in notes.md

_Ratified 2026-07-07 — all 6 maintainer decisions resolved (see the ratified section at the end)._

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

A verification gate that fires when a delegated sub-agent signals completion (`notify_agent("done")`)
**instead of trusting it**, and returns `{ accept } | { blockers[] }`. The sub-agent can only ever reach
`READY_FOR_VERIFICATION`; **the container decides done.** Every verification result is **bound to an immutable
commit SHA** (+ tree SHA, BASE_SHA, task id, verifier version, command set, timestamp); acceptance requires the
accepted SHA to equal the verified SHA — any later commit **invalidates** the result (closes time-of-check /
time-of-use). _(dueto blocker/major: TOCTOU)_

### Soundness prerequisite (dueto blocker #1) — per-agent isolation is Tier 0, not optional
`HEAD != BASE_SHA` proves only that *someone* moved the branch — not that THIS sub-agent produced THIS commit.
In a shared branch the gate is **not sound** (another agent, the coordinator, or a trivial path-touching
commit satisfies it). So **worktree-per-agent + an isolated task ref/branch is mandatory Tier 1, not a Tier-2
default**: `spawn_agent` allocates a unique worktree + task ref, records `BASE_SHA`/task-id/declared-paths, and
`verify_task` evaluates ONLY the commits reachable from that task ref (not from an unrelated moving HEAD),
merging to the integration branch only after verification.

### Tier 1 — deterministic, per-agent-isolated (kills F1/F2/F4)
- **(a) commit-or-fail, attributable** — a new commit on THIS agent's task ref exists, touches the contract's
  declared paths, message carries the task id. Path-touching proves *scope*, not correctness — see (d). *(F1)*
- **(b) tiered test signal** — static checks + **affected tests** (changed-file dependency graph) on every
  landing; the **canonical FULL suite before merge to the protected integration ref**, periodically, and for
  high-risk/shared modules. The sub-agent's own/focused run is advisory only. (Revised from "full suite every
  landing" — dueto major #3: that collapses throughput at N delegations and pressures bypass.) *(F2)*
- **(c) suppression scan — tripwire + semantic** — a cheap regex pass (`.skip`/`.only`/`xit`/`xfail`/deleted
  tests/snapshot churn) as a TRIPWIRE, backed by semantic signal it can't fake: **coverage delta on changed
  code**, AST-aware test-diffing, and fail-before/pass-after for contract tests. A legit test deletion (its
  production symbol was also deleted — happened for real deleting `AgentForm.ts`) is classified, not blocked.
  Hits need an **explicit coordinator waiver citing the deleted/changed production artifact**, bound to the
  SHA; the sub-agent **cannot self-waive**. *(F4)*

### The core requirement (dueto blocker #2/#3) — behavior verifier, not shape
A commit can be attributable + scoped + green + suppression-clean and still implement the **wrong behavior**
(the suite only helps if it already covers the intended change — often exactly what the task adds). So every
delegation contract MUST carry **≥1 behavior-level verifier**: a named test that **fails on BASE_SHA and passes
on HEAD** (fail-before/pass-after for bug fixes), or a command/assertion tied to user-visible behavior (smoke/
e2e for UI, request/response for API, equivalence/unchanged-public-tests for refactors). `path_exists` /
`path_changed` / `contains` are **supplemental, never sufficient** — they prove shape, not satisfaction.

### Tier 2 — structured contract, larger delegations (kills F3)
- **(d) machine-checkable `done_when`** — `deliverables[]` each with a verifier, **at least one of which is a
  behavior verifier** per the requirement above; the rest (`path_exists`/`test_name_exists`/`command_passes`)
  are shape guards. The gate checks every deliverable id. *(F3)*
- **(f) verifier-agent — advisory NEGATIVE signal ONLY** — a second model reviews diff + contract + logs and
  may only ADD blockers bound to concrete artifact refs + reproducible commands. It is **never the reason a
  task passes** (a "no blockers" verdict is itself just another self-report); its absence never downgrades a
  deterministic requirement. High-risk tasks escalate to human/CI-owned review, not another model layer.
  _(dueto major: verifier reintroduces trust)_

## Integration points

- **spec 246 (delegation contract)** — today `done_when` is validated for *presence/substance* at spawn, never
  *verified at landing*. verify_task is the missing landing-side half. Tier-2 (d) upgrades `done_when` from
  prose to a machine-checkable schema (backward compatible: prose `done_when` → Tier-1-only gate).
- **`spawn_agent`** — records `BASE_SHA` (+ declared OWNS paths) at delegation time so (a) has a baseline.
- **`notify_agent("done")` / completion envelope** — the trigger. The gate runs, and the coordinator is woken
  with `accept` or `blockers[]` (a precise, sendable fix list) instead of the raw claim.
- **Waivers** — a small typed record (`{reason, approved_by:"coordinator", expires}`) the coordinator issues to
  pass a suppression-scan hit; surfaced to the human, never agent-issued.

## Phasing (proposed, post-dueto)

- **Phase 1** — the sound minimum: per-agent worktree/task-ref isolation + (a) attributable commit + (b) tiered
  test signal + **one behavior verifier per contract** + (c) tripwire suppression scan, as a coordinator-
  requested Bridge tool that emits a **SHA-bound signed verification record** (locus model A, B-ready). This
  kills F1/F2/F4 AND the green-but-wrong gap, and converts "coordinator re-verifies by hand (if it remembers)"
  into "the container verifies, identically, every time." (Isolation + the behavior verifier moved UP from the
  draft's Tier-2 — the dueto showed the gate is unsound and hygiene-only without them.)
- **Phase 2** — (d) full structured `done_when` deliverables[] + semantic suppression signal (coverage delta,
  AST test-diff).
- **Phase 3** — (f) advisory verifier-agent; and, if the maintainer picks locus B, the protected-ref merge gate
  that rejects unverified SHAs.

## Non-goals
- Not a replacement for the sub-agent doing its own tests during development (fast inner loop stays).
- Not correctness proof — the gate proves *scoped, committed, suite-green, non-suppressed*, not *bug-free*
  (Tier-2 (f) adds a semantic critic, still advisory).
- Not per-turn friction on trivial one-line delegations — Tier-1 is cheap; Tier-2 is opt-in by contract size.

## The enforcement fork (dueto major #7 — the big architectural decision)

The draft said "coordinator-owned gate." The dueto's sharpest point: **the same orchestration layer that wants
progress can skip its own gate, waive too freely, or accept on a stale check.** A coordinator-invoked gate is
*policy*, not *enforcement*. Two models:

- **A — Coordinator-requested, advisory:** `verify_task` is a Bridge tool the coordinator calls; it returns
  `accept|blockers`; the coordinator is trusted to honor it. Simple, testable, ships fast. Weak for high-stakes
  repos — the constrained party owns the constraint.
- **B — Protected-ref enforcement the coordinator cannot bypass:** a merge/pre-receive gate on the protected
  integration ref REJECTS any merge lacking a **signed verification record** for the exact commit SHA + task
  id. The coordinator may *request* verification but cannot *skip* it; waivers are durable, auditable, SHA-bound.
  Sound, but heavier (needs the signed-record store + a merge chokepoint).

Recommendation: **build A first as the mechanism, design the record to be B-ready** (every verification already
emits a SHA-bound signed record) so flipping to protected-ref enforcement is a config change, not a rewrite.

## MAINTAINER DECISIONS — RATIFIED (2026-07-07, all six)
1. **Enforcement locus: A-now / B-ready.** verify_task ships as a coordinator-requested Bridge tool
   (advisory), but every verification emits a SHA-bound signed record from day one so protected-ref
   enforcement (B) becomes a config flip, not a rewrite.
2. **Per-agent isolation: MANDATORY for gated work.** Any delegation verify_task will gate is spawned into
   its own worktree + task ref; the gate evaluates only commits reachable from that ref. Shared-tree
   delegations remain possible but are un-gated (and say so).
3. **Behavior verifier: REQUIRED.** Every gated contract carries ≥1 fail-before/pass-after behavior verifier
   (named test failing on BASE_SHA, passing on HEAD — or an equivalent behavior assertion). Shape checks are
   supplemental, never sufficient. The coordinator absorbs the contract-writing cost.
4. **Test signal: TIERED.** Static checks + affected tests on every landing; canonical FULL suite before
   merge to the integration ref, periodically, and for high-risk/shared modules.
5. **Phase-1 scope: Tier-1 only.** Prove the sound minimum against real delegations (dogfood on upcoming
   codex ad-hocs) before Tier-2 (structured deliverables[], semantic suppression signal) or the verifier-agent.
6. **Waivers: coordinator signs, human sees everything.** The agent can never self-waive; every waiver is
   durable, SHA-bound, cites the deleted/changed production artifact, and is surfaced to the maintainer in the
   landing report.
