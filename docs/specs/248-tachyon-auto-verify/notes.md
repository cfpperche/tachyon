# Spec 248 — notes

## Codex dueto (2026-06-22) — NEEDS-REVISION
Transcript: `Agent0/.agent0/.runtime-state/codex-exec/20260622T225234Z-dueto-248-auto-verify/`.

### Premise challenge (the headline)
**This is NOT a faithful migration of Agent0's per-edit `PostToolUse` validator.** Agent0's validator fires inside the tool loop after each edit (multi-check, tight-feedback, catches breakage *while* the agent is still changing code). Tachyon has no tool-loop hook — a `working→idle` edge observed from tmux is "the process became quiet," not "post-edit." Calling it "the Tachyon-native post-edit validator" is **dishonest framing**. Honest name: **"auto-verify on agent quiescence" / "idle-triggered verify freshness for declared worktree gates."**

### Migration-thesis finding (important for the roadmap)
The per-edit validator **does not migrate** to Tachyon (no per-edit/tool-event hook exists). Decompose what the validator actually delivers:
- **done-gate / validated handoff** → ALREADY shipped by spec 214 (manual Verify + `verify_agent` MCP + `list_agents` state). The cheap high-value move is to **document the "call `verify_agent` before handoff" orchestration pattern**, not new code.
- **per-edit tight-loop advisory** → **unmigratable** without a tool-loop hook; stays **project-domain** (the project's own `PostToolUse`/CI keeps it). Tachyon should NOT pretend to replicate it.
- **idle-triggered freshness** (keep badges truthful when an agent forgets to verify) → the only genuinely NEW Tachyon-native increment here, and it is **marginal + cost-heavy**, not the validator.

### Folded OQ answers
- **OQ1** — different feature; not the validator. Reframe.
- **OQ2** — idle is an unsound *done* signal; use it only for opportunistic **freshness**. "finished AND verified" requires explicit intent (`verify_agent` / done-marker). UI must never imply "finished" from idle.
- **OQ3** — stale-gate is NOT enough. Need per-agent min-interval, per-workspace concurrency cap (default 1 at a time), queue/drop policy, max runtime, failure backoff.
- **OQ4** — worktree-only v1 (shared-cwd has concurrent-write + attribution hazards).
- **OQ5** — per-agent opt-in (`verify.auto: true`) is the activation point; a global setting may only define caps/policy, never blanket-enable a fleet.
- **OQ6** — project-composed `verify` runbook is enough for v1; auto-verify does NOT understand sub-checks — but then stop claiming it migrates the multi-check advisory validator.

### Other crux fixes (if built)
- **Dirty-worktree identity:** auto-verify often runs pre-commit against uncommitted changes; "green at HEAD" is meaningless when dirty. Either verify clean-only, OR record a worktree fingerprint beside `atCommit` and badge "verified dirty snapshot," not "verified at HEAD."
- **Reducer event model must expand** beyond arm→fire→latch: `idleDebounceElapsed, verifyStarted, verifyCompleted, verifyFailedToStart, attentionChanged, configChanged, headChanged, dirtyFingerprintChanged, manualVerifyStarted` (races: attention flips mid-verify, HEAD moves, config changes, manual verify concurrent).
- **Trigger metadata / traceability:** "no new advisory channel" hides background CPU + badge flips. Add `trigger: manual|auto-idle|mcp`, `reason`, `startedAt`, `finishedAt`, output/log link — else a user can't tell a manual fail from an auto-idle fail.
- **217 is only a SHAPE precedent** (pure reducer + thin IO + latch/debounce), NOT a cost/safety precedent — 217's probe is cheap; a `verify` suite is expensive, project-defined, side-effect-prone.
- **"Non-blocking ≠ non-invasive":** a background heavy suite still burns CPU/battery, can mutate a test DB, grab ports, surface flaky-test noise. The advisory claim doesn't excuse the side effects.

### The strong simpler alternative (the dueto's parting shot)
214 already gives manual Verify + `verify_agent` + `list_agents` state. For most users, **documenting "agents/orchestrators call `verify_agent` before handoff"** gives better signal at lower cost and less surprise. Auto-trigger only pulls its weight as *opportunistic freshness, per-agent opt-in, rate-limited, traceable, no "finished" language, no Agent0-validator branding.*

## Decision pending (maintainer)
**D-PATH** — three options:
- **(A) Document-only.** Treat the validator as "done-gate covered by 214 + a new orchestration doc on `verify_agent`-before-handoff"; declare the per-edit half project-domain/unmigratable; ship NO new code. Cheapest, honest, demand-gated.
- **(B) Narrow freshness v1.** Build the dueto's revised v1: worktree-only, per-agent `verify.auto`, idle-triggered FRESHNESS (no "finished" claim), conservative rate-limits + concurrency cap, dirty-snapshot fingerprint, trigger metadata. Real but marginal value, non-trivial build.
- **(C) Hybrid.** (A) now (cheap, immediate) + (B) deferred behind rule-of-three demand.
