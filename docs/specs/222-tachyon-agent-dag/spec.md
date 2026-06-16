# 222 — tachyon-agent-dag (DESIGN — debate before code)

_Created 2026-06-15._

**Status:** PARKED (2026-06-15; reasoning corrected 2026-06-16) — adversarial design debate (codex,
gpt-5.5 xhigh) recommended PARK; no implementation. The PARK rests on Q1 (idle≠done) + Q4 (worktree
tension) + no demand — NOT on the withdrawn Q6 (which wrongly counted Agent0's `/squad` + `/routine` as
Tachyon features; see Q6 below). Reopen trigger = a real, repeated pipeline need that Tachyon's own
Bridge `wait_for_agent`/`verify_agent` (parent pulls) genuinely can't express. Decision record below.

## Debate outcome (codex, 2026-06-15) — RECOMMENDATION: PARK
> "No repeated demand; existing primitives already cover this without making heuristic 'done' a contract."

Per-question verdicts:
- **Q1 (done-detection) — BLOCKER for interactive agents:** `idle` is an ATTENTION signal, not
  completion. `needs:` would only be sound for process-exit one-shots (`codex exec`, `sh`, runbooks),
  or after adding an explicit done-signal first. Making idle a contract is the core mistake to avoid.
- **Q2 (failure):** hold downstream VISIBLY blocked with the upstream reason — no silent wedge, no
  retry/timeout-launch, no auto-override.
- **Q3 (cycles):** reject unknown refs / self-deps / cycles at config-load; fan-in waits for all.
- **Q4 (worktree) — design tension:** solvable ONLY by NOT running a top-level B in A's worktree (it
  collides with one-agent-per-worktree); B would have to be A's child / shared-task or a separate
  branch. That constraint removes much of the apparent value.
- **Q5 (re-runs):** no auto-refire; dependency runs are one-shot; manual ▶ on B is an explicit human
  bypass; reopen only RESTORES state, never re-evaluates the graph.
- **Q6 (overlap) — WITHDRAWN (layering error).** The debate prompt wrongly told codex to weigh
  `/squad` and `/routine` — but those are **Agent0 HARNESS** capabilities (`.agent0/…` rules/skills),
  NOT Tachyon product features. A Tachyon DAG is not a "third orchestration primitive" competing with
  them; they live in a different layer (the harness an agent may run *inside* a Tachyon-spawned shell).
  This reason is void. The PARK does NOT rest on it — it rests on Q1 + Q4 + no demand. (Maintainer
  caught this 2026-06-16.) Note Tachyon DOES have a Bridge `wait_for_agent`/`verify_agent` (parent
  pulls) that already covers simple sequencing — that, not squad/routine, is the real in-product overlap.
- **Q7 (MVP):** the smallest sound version = `after-verify` only + upstream worktree agent + downstream
  NON-interactive command/runbook in that worktree + acyclic fan-in + no artifacts + no rerun magic.
  Even that is narrow enough that PARK-until-demand wins.

**Maintainer-discipline alignment (corrected 2026-06-16):** this is the rule-of-three case — build
orchestration only on a real, repeated pipeline need, not on a plausible-sounding design. The PARK
rests on **Q1 (idle≠done: Tachyon has no reliable task-completion signal for interactive agents) + Q4
(worktree tension) + no demonstrated demand** — NOT on the withdrawn Q6 overlap claim. Within Tachyon
today, simple sequencing is already expressible via the Bridge's `wait_for_agent`/`verify_agent` (a
parent agent pulls). **Reopen path is narrower than "general DAG":** the `after-verify` + non-interactive
downstream MVP (Q7) sidesteps Q1 and is the defensible first slice IF a real pipeline need appears.
The original (pre-debate) design sketch is preserved below as the reopen seed.

---
_(original speculative design below — kept as the reopen seed)_

**UI impact:** ui (eventually) — a "pending (blocked on X)" agent state.

## Intent

Let `tachyon.yml` declare **dependencies between agents** so Tachyon orchestrates start order from
completion/verify signals, instead of the human sequencing a multi-step pipeline by hand. Two edge
types:
- **`needs: [A]`** — start when A's process finishes / goes idle (loose).
- **`after-verify: [A]`** — start ONLY when A's verify-gate (spec 214: tests/build/validator green)
  passes (strict — the differentiated bit; ties the fleet to the worktree→verify loop nobody else has).

```yaml
agents:
  build: { cmd: claude }
  test:  { cmd: codex, needs: [build] }
  deploy:{ cmd: claude, after-verify: [test] }
```

## Why it could be worth it
The isolate→review→verify loop already exists (specs 210/213/214). A verify-gated DAG turns the fleet
into a real pipeline — VS Code native multi-agent and Hive have no worktree+verify orchestration. It
extends the moat rather than chasing a competitor feature.

## Why this is debate-first (the hard questions — each must get an answer)
1. **"Done" detection per runtime.** `needs:` fires when A is "done" — but Tachyon only has heuristic
   idle detection (AttentionMonitor) + process-exit. An AI agent that goes idle isn't necessarily
   "done with its task." Is `needs:` even well-defined for an interactive AI agent, or only for
   one-shot commands (`codex exec`, `sh`)? Maybe `needs:` is restricted to non-interactive steps.
2. **Failure semantics.** A fails / verify is red → does B never start? Notify and hold? Timeout? A
   crash-loop upstream must not wedge the whole graph silently.
3. **Cycles & validation.** Reject cyclic graphs at config-load (where? loadConfig + schema). Partial
   fan-in/out (B needs [A,C]) — wait for all.
4. **Worktree interaction.** Does B run in A's worktree (to see A's output) or its own? `after-verify`
   implies B consumes A's verified work — so B likely needs A's worktree/branch, which collides with
   "one agent per worktree." Big open question.
5. **Re-runs / idempotency.** Re-run A → does B auto-re-fire? Manual ▶ on B mid-graph — does it ignore
   deps? How does resume (spec 209) interact — on reopen, does the graph re-evaluate?
6. **Overlap with `/squad` and `/routine`.** `/squad` is a turn-locked two-runtime loop to a done-gate;
   `/routine` is cron-enqueued recurring work. Does a DAG overlap/conflict? Is this a THIRD
   orchestration primitive, or should it compose with squad's done-gate?
7. **Scope creep.** This risks becoming a CI/workflow engine inside an editor extension. What is the
   MINIMUM that delivers value (maybe: `after-verify` only, non-interactive downstream, no cycles, no
   re-run magic) vs the maximal version that's a maintenance trap?

## Provisional non-goals (to contain scope)
- Not a general CI engine; not parallel matrix builds; not artifact passing beyond the shared worktree.
- Not replacing `/squad` (turn-locked loop) or `/routine` (cron).

## Decision gate
After the debate: either (a) a contained MVP spec (likely `after-verify` + non-interactive downstream
only) with the 7 questions answered, or (b) PARK as speculative until a real pipeline need appears
(honoring the rule-of-three discipline). The debate decides which.
