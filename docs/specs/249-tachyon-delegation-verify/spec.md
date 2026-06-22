# Spec 249 — delegation-verify: the verify-side of a delegated child (close the gate-spawn → verify-deliver loop)

**Status:** BLOCKED by codex dueto 2026-06-22 → **RESOLVED as "does not migrate"** (see `notes.md`). Full delegation-verify needs a real `SubagentStop` + contract-prose judging + a continuable process — none of which Tachyon has; and the shared-worktree attribution problem makes the verdict unsound for the common delegated child. The verify-side is already met by **246 + 214 + the 248 doc** (`wait_for_agent(until=dead)` → `verify_agent`). At most a thin `wait_for_agent(..., thenVerify: true)` convenience wrapper, **deferred** behind rule-of-three demand + telemetry that worktree-isolated delegated agents are real. The draft below is kept for the record; the dueto's corrections live in `notes.md`. · **Original status:** DRAFT (pre-codex dueto) · **Date:** 2026-06-22 · **Follows:** spec 246 (spawn-contract gate — the request-side; persists the contract), 214 (verify-gate — the mechanical check + badge + `verify_agent`), 248 (idle≠done lesson; doc-side verify-before-handoff), AttentionMonitor/Waiters (the completion signal) · **Surface:** `src/bridge/Waiters.ts` (the `dead` completion already tracked), `src/agents/AgentManager.ts` / `SessionLedger` (the persisted 246 contract), `src/worktree/verify.ts` / `runVerify` (reused), a thin "on delegated-child completion → auto-verify → attach result" wire · **Review:** codex design debate PENDING · **UI impact:** flow (a delegated child's completion now carries a verify verdict; the parent's `wait_for_agent` / the delegation surface shows ✓/✗ — verified by driving a real delegated child to exit with a passing then failing gate)

> **Origin:** fifth step of the "migrate Agent0's harness into Tachyon" thesis, and the explicitly-deferred **other half of spec 246**. 246 migrated Agent0's `delegation-gate` (gate the *request* — a child must carry a contract). The migrated mechanism here is Agent0's **`delegation-verify`** (`SubagentStop` hook, spec 111): at a delegated task's **close**, run the project's done-gate once — pass → advisory; fail → give the sub-agent **one** focused continuation to fix; fail-again → accept a partial close + escalate. Classification = **adapt** (see the crux — the *check* is project-domain; the *completion-trigger + verified-handoff + fix-loop* is what migrates).

## Problem

246 closes the front door: a delegated child is born with a structured contract (`task/context/constraints/done_when|deliverable`, persisted on its `SessionLedger` row). Nothing closes the **back door**: when the child finishes, **no one mechanically checks whether it delivered**. The parent must remember to call `verify_agent` by hand (248 added a doc nudge for exactly this, conceding it was only guidance). So "the child finished" and "the child's work is green" are still two separate facts a human/parent has to bridge manually — the precise gap Agent0's `delegation-verify` closes by running the done-gate automatically at sub-agent stop.

### Why this is migratable now, where 248's idle-auto-verify was deferred (the decisive difference)
The 248 dueto deferred general idle-auto-verify because **idle ≠ done** — an interactive agent goes quiet mid-task, so idle is an unsound completion signal. **A delegated child does not have that problem:**
- **A one-shot delegated child has a REAL terminal signal — process/pane exit.** `Waiters` already tracks `until: "dead"` (`met: entry.until === "dead"`, `src/bridge/Waiters.ts`) — a genuine "the CLI finished," not an idle inference. This is the Tachyon-synthesized equivalent of Claude's `SubagentStop` event.
- **It carries a 246 contract + a waiting parent.** The delegation is explicit (spawned via `spawn_agent`, contract persisted), so we know it IS a delegated task with a declared intent — unlike a free-running interactive agent.

So delegation-verify keys on **completion (`dead`), not quiescence (`idle`)** — sidestepping the 248 objection by construction.

### What actually migrates vs what stays project-domain (verified 2026-06-22)
- **The check is project-domain** — Agent0's hook runs `.agent0/validators/run.sh`; the Tachyon analog is the child's **declared 214 `verify:` gate** (`runVerify`, in the child's worktree). The project owns the command (same conclusion as 248). We do NOT port the validator.
- **What migrates is the wiring:** (1) **trigger** the verify on delegated-child completion, (2) **attach the verdict to the handoff** (the parent's `wait_for_agent` result + a delegation-audit row carry `{passed, atCommit, ranAt}`), (3) optionally the **one-continuation fix-loop**. Advisory, never blocks the parent.

## Goal

When a **delegated** child (spawned via `spawn_agent`, carrying a 246 contract) **completes** (`dead`), if it has a declared 214 `verify:` gate, **automatically run that gate and make the verdict part of its completion handoff** — so a parent reading `wait_for_agent` / the delegation surface sees "child exited **AND** verify passed/failed" as one evidenced signal, no manual `verify_agent` call. Advisory, opt-in via the existing `verify:` declaration, never blocking the parent or the child's exit.

## Proposed design (pre-dueto — to be pressure-tested)

- **Trigger = delegated-child reaches `dead`** (the existing Waiters terminal signal), NOT idle. Only for children with a persisted 246 contract (a real delegation) AND a declared 214 `verify:` gate; otherwise a no-op (honest gap, not a fake pass).
- **Run the child's `verify:` gate via the existing `runVerify`** in its worktree, at the commit it died on; record `{passed, atCommit, ranAt}` (reuse 214's state) and **attach it to the completion** — the `wait_for_agent` result gains a `verify` field, and a `delegation-audit` row records the verdict (closing the 246 audit trail).
- **Fix-loop = OPEN QUESTION (OQ3).** Agent0 gives the sub-agent one continuation via `exit 2`. A `dead` child has no process to continue — so for one-shot children the verdict is *evidence for the parent to act on* (re-spawn/continue itself), not an in-place retry. For still-alive children the continuation could be fed via `write_input` — but that reintroduces the idle-vs-done ambiguity. v1 likely: verdict-as-evidence only; fix-loop deferred.
- **Advisory + non-blocking, always.** Never delays the child's exit, never blocks the parent's `wait_for_agent` (the verify runs as the completion resolves; a slow/failing gate degrades to "verify: unknown", never a hang). Mirrors 214/246's human-at-gate posture.

## Open questions for the codex dueto

- **OQ1 — completion-signal scope: `dead` only, or also `idle`/`needs-input`?** `dead` is sound (real exit). But many delegated children are long-lived interactive agents that finish a task and sit `idle` without exiting — for those, `dead` never fires, so they get no auto-verify (back to the 248 idle problem). Is `dead`-only honest-but-narrow acceptable for v1, or does it cover too few real delegations to be worth building?
- **OQ2 — what to verify: the 214 `verify:` gate (mechanical) vs the 246 contract's `done_when`/`deliverable` (prose).** The mechanical gate is cheap + deterministic but is NOT "did it satisfy the contract" — a child can pass `npm test` and still not have done the task. Judging `done_when` prose needs an LLM judge (expensive, non-deterministic, out of the harness's deterministic spirit). Is mechanical-gate-only the right v1, and is it honestly "delegation-verify" or just "auto-verify scoped to delegated children"?
- **OQ3 — the fix-loop.** Is the one-continuation-to-fix (Agent0's `exit 2`) in scope, given a `dead` child has no process to continue? Options: (a) verdict-as-evidence only (parent decides); (b) `write_input` a continuation to a still-alive child (idle, not dead — reintroduces OQ1's ambiguity); (c) out of scope v1.
- **OQ4 — worktree dependency.** 214's gate is worktree-scoped, but a delegated **sub-agent shares its parent's worktree** (`spawn_agent` docs: a sub-agent isn't given its own). So most delegated children have NO own verify-gate → no-op. Does delegation-verify only make sense for **top-level worktree-isolated** delegated agents? If so, say the honest scope loudly.
- **OQ5 — is this just 246 + 248-manual + a doc?** Today a parent can `wait_for_agent(until=dead)` then `verify_agent` (and 248 already nudges it to). What does auto-attaching the verdict buy over the documented manual call — enough to justify the wire, or is this another "document it" case?

## Non-goals

- Porting `.agent0/validators/run.sh` or its stack detection — project-domain (the child's `verify:` owns it). Same trap as 248.
- LLM-judging the contract's `done_when`/`deliverable` prose — out of scope (non-deterministic; a separate, harder mechanism).
- Blocking the child's exit or the parent's wait — strictly advisory (214/246 posture).
- Auto-verify for non-delegated or idle-only agents — that is 248 (deferred); this is delegation + completion only.

## Risks

- **R1 — narrow coverage** (`dead` + own-worktree) makes it apply to few real delegations → marginal value (OQ1/OQ4). Mitigation: confirm the real delegation shape before building; if most children are shared-cwd interactive, this is a doc, not a feature.
- **R2 — false confidence** — a green mechanical gate reads as "delivered" when it only means "checks pass" (OQ2). Mitigation: label the verdict as the gate's result, never "contract satisfied"; carry the gate command in the verdict.
- **R3 — scope creep into an LLM judge / a blocking gate.** Mitigation: mechanical-only + advisory locked.
- **R4 — re-deriving 248's deferral** if it drifts toward idle-triggering. Mitigation: `dead`-keyed by construction; idle is explicitly OQ1, not assumed.

## Acceptance

- [ ] A top-level worktree delegated child (246 contract + 214 `verify:`) that reaches `dead` auto-runs its gate; the verdict `{passed, atCommit, ranAt}` is attached to the parent's `wait_for_agent` result AND a `delegation-audit` row — no manual `verify_agent`.
- [ ] Keyed on `dead` (real completion), never idle; a child with no contract, no `verify:`, or no own worktree is a clean no-op (no fake pass, surfaced as "verify: none/unknown").
- [ ] Reuses `runVerify` (no second executor) + 214's verify-state shape; never blocks the child's exit or the parent's wait (slow/failing gate → "unknown", never a hang).
- [ ] OQ1/OQ2/OQ4 resolved + recorded in `notes.md` (completion scope, mechanical-vs-prose, worktree scope) — and an explicit honest call on OQ5 (build vs document).
- [ ] Pure parts (verdict shape, "is this a verifiable delegated completion?" predicate) unit-tested; the dead→verify wire is integration/smoke-tested against a real exiting child in a real worktree.
