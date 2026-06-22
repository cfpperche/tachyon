# Spec 248 — idle-triggered verify freshness for declared worktree gates

**Status:** PARTIALLY SHIPPED (path C) 2026-06-22 — codex dueto (NEEDS-REVISION; premise corrected: **not** the Agent0 validator migration). **D-PATH = C (hybrid) ratified.** Doc half DONE: `verify_agent` tool description + `bridgeGuidanceTail` now teach "run/gate the verify gate before handoff; idle is not proof of done" (`src/bridge/tools.ts`, `src/roles/templates.ts`, +1 roles test; typecheck green). Freshness-build half (B) DEFERRED behind rule-of-three demand. Per-edit validator declared **project-domain (does not migrate)**. · **Date:** 2026-06-22 · **Follows:** spec 214 (verify-gate — explicitly deferred "auto-run-on-idle"), 217 (wedge-watchdog — pure-reducer *shape* only, NOT a cost precedent), AttentionMonitor (idle signal) · **Surface (if built):** `src/attention/AttentionMonitor.ts` (idle-edge subscription), a new pure `autoVerifyStep` reducer, `src/worktree/verify.ts` / `runVerify` (existing executor, reused verbatim), `tachyon.yml` per-agent `verify.auto` + global caps · **Review:** codex design debate DONE → folded into notes.md · **UI impact:** flow (the 214 badge updates on its own after quiescence — IF built)

> **Premise correction (codex dueto 2026-06-22):** this began as "migrate Agent0's post-edit validator," but the dueto's central, accepted finding is that **the validator does not migrate**. Agent0's validator (`.agent0/validators/run.sh`) is a `PostToolUse` hook *inside the agent's tool loop* — multi-check, per-edit, tight-feedback. **Tachyon has no tool-loop hook** (an agent is a CLI process in a tmux pane, observed from outside), so "validate after each edit" is not portable; a `working→idle` edge is "the process went quiet," not "post-edit." Decomposing what the validator delivers:
>
> - **done-gate / validated handoff** → ALREADY shipped by spec 214 (manual Verify + `verify_agent` MCP + `list_agents` state). The honest, cheap move is to **document the "call `verify_agent` before handoff" pattern**, not new code.
> - **per-edit tight-loop advisory** → **unmigratable** without a tool-loop hook → stays **project-domain** (the project keeps its own `PostToolUse`/CI). Tachyon must not pretend to replicate it.
> - **idle-triggered freshness** (keep the 214 badge truthful when an agent forgets to verify) → the only genuinely NEW, Tachyon-native increment — and it is **marginal + cost-heavy**, NOT "the validator."
>
> So this spec is reframed to its honest scope: an **opt-in, idle-triggered FRESHNESS refresh of an already-declared 214 worktree gate** — never "post-edit validation," never an implied "finished" claim. Classification of the validator-as-a-whole = **project-domain (does not migrate)**; this freshness gate is a small Tachyon-native add, gated on the § Decision below.

## Decision pending (D-PATH — read before the rest)

The dueto's parting challenge: 214 already gives manual Verify + `verify_agent` + `list_agents` state, so for most users **documenting "agents/orchestrators call `verify_agent` before handoff"** is better signal at lower cost than any auto-trigger. Three paths:

- **(A) Document-only.** Validator = "done-gate covered by 214 + a new orchestration doc"; per-edit half declared project-domain/unmigratable; **no new code.** Cheapest, honest, demand-gated.
- **(B) Narrow freshness v1.** Build the revised design below (worktree-only, per-agent `verify.auto`, FRESHNESS not "done," rate-limited, dirty-snapshot fingerprint, trigger metadata). Real but marginal value; non-trivial build.
- **(C) Hybrid.** (A) now + (B) deferred behind rule-of-three demand.

**Author leans (C):** ship the doc now (the done-gate is the actual value and it already exists), defer the freshness auto-trigger until real demand — matches Tachyon/Agent0's own "speculative observability is harness-drift" discipline. The rest of this spec is the design for (B), kept ready but not started.

## Problem

Tachyon's verify-gate (214) already owns the right half of Agent0's validator: the **project declares the command** (`verify: <cmd/runbook>`), and **Tachyon owns execution/state/surface** (run in the worktree cwd → `{passed, atCommit, ranAt, stale}` → badge + `verify_agent` MCP). What it lacks is the validator's defining behavior: the gate is **manual** (214 D6: "auto-run-on-idle is a later opt-in"). So "is this work shippable?" is only ever answered when a human clicks Verify — the agent can finish, sit green-looking-but-unverified, and a parent orchestrator reading `list_agents` sees a stale/absent verify state until someone acts.

### The hard constraint that forces an *adaptation*, not a port (verified 2026-06-22)
- **Tachyon cannot see edits.** Agent0's validator fires on `PostToolUse` — it sits *inside* the agent's tool loop. A Tachyon agent is a **CLI process in a tmux pane**; Tachyon observes it from the outside (pane output, tmux state), with no per-edit hook. So "validate after each edit" is **not portable** — the nearest native signal is **`AttentionMonitor` going `working → idle`** (`src/attention/AttentionMonitor.ts`; states `"working" | "idle" | "needs-input"`, already surfaced via `attentionOf` and `list_agents`). Per-edit (tight loop) becomes per-quiescence (coarse). This is the crux the dueto must judge.
- **The executor, state, and surface already exist** (214): `runVerify` runs the declared gate in the worktree and writes the verify state + badge. Auto-verify adds only a **trigger**, not a new executor — mirroring 214's own "reuse commands/runbooks, no new executor" rule and 217's "reuse probeServer, add only a timer."
- **217 is the architectural precedent, not the mechanism.** 217 is a tmux-server health watchdog (background timer + a pure `watchdogStep(prev, probe) → {next, action}` reducer + thin IO). Auto-verify reuses that *shape* (pure reducer + thin IO subscription) but keys on agent idle, not server health.

## Goal (path B only — superseded framing kept for reference; folded revisions live in `notes.md`)

> **Retracted:** the original goal claimed idle auto-run evidences "finished AND verified." The dueto correctly rejected idle as a *done* signal — idle ⇒ **freshness opportunity only**, never "finished." A real "finished AND verified" still requires explicit intent (`verify_agent` / a done-marker). The sections below are the path-(B) design with this correction applied via `notes.md`; they are NOT started until D-PATH lands.

When an agent that has a declared `verify:` transitions `working → idle`, **opportunistically refresh its verify-gate** (debounced, rate-limited, skip-if-fresh) so the existing 214 badge stays truthful without a human click — strictly **freshness**, opt-in per agent (`verify.auto`), advisory, never blocking, never implying completion. Project owns the command; Tachyon owns the (now optionally self-triggering) execution/state/surface.

## Proposed design (pre-dueto — to be pressure-tested)

- **Trigger = the `working → idle` edge** from `AttentionMonitor`, not a poll. One subscription; the edge (not the level) arms a verify. `needs-input` is NOT idle (the agent is blocked on a human, mid-task) — explicitly excluded.
- **A pure reducer `autoVerifyStep(prev, event) → { next, action: "verify" | "none" }`** (217's pattern) encodes the gating so it's fully unit-testable: arm on the idle edge → fire `verify` only if **stale or never-verified at current HEAD** → **latch** (no re-fire until the next `working → idle` edge) → reset. Skips when no `verify:` is declared, when a verify is already running, or when the worktree HEAD/working-tree is unchanged since the last `ranAt` (reuse 214's stale computation — green-at-HEAD means nothing to re-prove).
- **Debounce the idle edge** (e.g. require idle to persist ~N s) so a momentary pause mid-stream doesn't fire a heavy suite. The IO layer (subscription + timer + `runVerify` + the existing badge update) stays thin; all decision logic is in the reducer.
- **Opt-in via a new setting** (off by default): `settings.worktree.autoVerify: true` (global) and/or a per-agent `verify.auto: true`. No declaration → 214's manual-only behavior is unchanged (zero new behavior for existing users).
- **Result is the existing 214 surface** — the badge flips `✓/✗`, `list_agents` exposes the fresh `{passed, atCommit, ranAt, stale}`. No new advisory channel; auto-verify is "the manual Verify, fired by idle."

## Open questions for the codex dueto

- **OQ1 — is per-idle a faithful adaptation, or a different feature wearing the validator's name?** Agent0's validator is per-edit + advisory; this is per-quiescence + a pass/fail gate. Pressure: is "auto-run the done-gate when an agent finishes" actually Agent0's validator, or is it closer to `/squad`'s done-gate (which Tachyon already half-has via 214)? If the latter, the honest framing changes — say so.
- **OQ2 — idle is noisy: an agent goes idle mid-task (thinking, waiting on a long tool, paused for input it didn't signal as `needs-input`).** Is the latch + stale-gate + debounce enough to avoid firing a heavy test suite on a false "done"? Or does auto-verify need an *explicit* done signal (e.g. the agent calling `verify_agent`, or a done-marker) rather than inferring from idle?
- **OQ3 — cost.** A full `verify` (test suite) per idle edge, per worktree agent, can be expensive (Agent0's per-edit validator is cheap; a Tachyon `verify` runbook may not be). Is the stale-gate sufficient, or is a min-interval / concurrency cap / "only N auto-verifies per minute across the fleet" needed? (217 leaned on cheapness; auto-verify cannot assume it.)
- **OQ4 — worktree-only?** 214's gate is worktree-scoped (runs in the agent's branch cwd). Agent0's validator runs in the main repo. Does auto-verify apply only to worktree agents (consistent with 214), or also to plain agents in the shared cwd (closer to the validator, but no isolation + concurrent-write hazards)? Recommend worktree-only for v1 — confirm or challenge.
- **OQ5 — opt-in granularity + default.** Global `settings.worktree.autoVerify` vs per-agent `verify.auto`? Off-by-default is locked (214 D6), but which knob, and do they compose (per-agent overrides global)?
- **OQ6 — multi-check shape (deferred or in-scope?).** Agent0's validator emits *separate* advisories per check (lint/typecheck/test/build). 214's gate is a single exit-0. Is mapping the project's multi-check into one `verify` runbook (project's job) sufficient, or should auto-verify understand sub-checks? Recommend: out of scope for v1 (project composes its own `verify`), but the dueto should confirm this isn't punting a core value.

## Non-goals

- A new executor or a new advisory channel — reuse 214's `runVerify` + badge + MCP verbatim.
- Per-edit validation — impossible without a tool-loop hook (Tachyon observes from outside the CLI).
- Blocking / auto-merge / auto-PR — auto-verify is a *signal*, exactly as 214 is (human-at-gate).
- Changing the manual Verify, or any behavior when `autoVerify` is unset (strict opt-in).
- Porting `.agent0/validators/run.sh` or its stack-detection — that logic is project-domain (the project's `verify:` command owns it). This is the "never migrate the validator as a blob" trap.

## Risks

- **R1 — false-done firing** a heavy suite on a mid-task idle. Mitigation: debounce + latch + stale-gate (OQ2/OQ3); escalate to an explicit done signal if the dueto deems idle too weak.
- **R2 — cost blowup** across a fleet of worktree agents. Mitigation: stale-gate + optional min-interval/concurrency cap (OQ3).
- **R3 — scope drift** — auto-verify quietly becoming a blocking gate or growing a parallel advisory surface. Mitigation: locked to 214's existing surface + advisory posture.
- **R4 — mis-sold as "the Agent0 validator"** when it's a coarser done-gate. Mitigation: OQ1 honesty — frame it as what it is.

## Acceptance

- [ ] A worktree agent with `verify:` declared AND `autoVerify` opted-in, on `working → idle`, auto-runs its gate **once** in the worktree cwd; the 214 badge flips `✓/✗` and `list_agents` shows fresh `{passed, atCommit, ranAt, stale}` — no human click.
- [ ] The pure `autoVerifyStep` reducer is unit-tested across the full sequence: idle-edge arms, stale/never-verified fires, green-at-HEAD skips, latch prevents re-fire until the next `working → idle`, `needs-input` never fires, no-`verify:` is a no-op.
- [ ] Debounce: a sub-threshold idle blip does not fire (test).
- [ ] Opt-in + default: with `autoVerify` unset, behavior is byte-identical to 214 (manual only) — no auto-run, no badge change (test).
- [ ] Reuses `runVerify` (no second executor); the idle-subscription IO is thin; the worktree-cwd auto-run is integration/smoke-tested against real git + real tmux + a real idle transition.
- [ ] OQ1/OQ2/OQ4 resolved and recorded in `notes.md` (faithful framing, idle-vs-explicit-done, worktree scope).
