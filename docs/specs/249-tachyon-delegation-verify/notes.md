# Spec 249 — notes

## Codex dueto (2026-06-22) — BLOCK
Transcript: `Agent0/.agent0/.runtime-state/codex-exec/20260622T230908Z-dueto-249-delegation-verify/`.

### Verdict: do NOT build as drafted. Full delegation-verify does not migrate.
The dueto BLOCKED it, and the reasoning holds:

1. **Fatal scope/attribution (OQ4).** A delegated sub-agent SHARES the parent worktree; 214 verify is worktree-scoped. So for the common delegated child the verdict is a no-op (no own gate) or **attribution-confused** — running the parent worktree's gate after a child dies includes parent/sibling edits + pre-existing dirt, and a fail may be unrelated to the dead child. `atCommit` is insufficient in a shared mutable worktree (need base commit, dirty-state, changed paths, actor attribution). Clean only for **top-level worktree-isolated** delegated agents — and there's no evidence that shape is common.
2. **Name overclaims (OQ2).** Mechanical 214 gate ≠ "the child delivered its contract." It borrows the validator's credibility for a weaker check. Don't call it delegation-verify.
3. **Timing contradiction.** Can't both attach the verdict to `wait_for_agent(until=dead)` AND "never block." Must pick: **sync** (`includeVerify=true`, bounded extra wait, `verify.status=passed|failed|timeout|unconfigured`) or **async** (`wait` returns `verify.status=pending`, a later audit event carries it).
4. **No fix-loop = not the Agent0 mechanism.** Agent0's strength is the ONE focused continuation on failure (exit 2). A `dead` Tachyon child has no process to continue → this is evidence capture, not enforcement. Drop the migration framing.

### Folded OQ answers
- **OQ1** — dead-only (never idle/needs-input — that's the 248 mistake). If dead-only coverage is too low, **don't ship**.
- **OQ2** — 214 mechanical only, but rename; it's "auto-verify evidence for delegated agents," not contract verification.
- **OQ3** — fix-loop OUT of v1; never `write_input` into idle children (reintroduces ambiguous completion).
- **OQ4** — fatal as drafted; only coherent for worktree-isolated delegated agents.
- **OQ5** — yes, mostly this is **246 + 248-manual + a doc**. Auto-attach only earns its keep IF worktree-isolated delegated agents are frequent AND missed verification is an observed failure — no such evidence today.

### Resolution (proposed)
Same shape as 248: **the full mechanism does NOT migrate** (needs a real SubagentStop + contract-prose judging + a continuable process — none of which Tachyon has). What's left is, at most, a **thin convenience**, deferred behind demand:
- **Cheapest:** the 248 doc already nudges parents to `wait_for_agent(until=dead)` → `verify_agent`. That IS the verify-side. No new code.
- **Optional thin wrapper (deferred):** `wait_for_agent(..., thenVerify: true)` — a sync convenience that, after `dead`, runs the gate IFF the child is worktree-isolated + has a `verify:`, returning `verify.status`. Explicit timing, no background audit subsystem, no race. Build only on rule-of-three demand + telemetry that the worktree-isolated delegated shape is real.

### Migration-thesis finding (the meta-point)
248 + 249 together establish that **the verify/validation family does not migrate to Tachyon**: no tool-loop hook (per-edit), no real SubagentStop (per-close), shared-worktree attribution (per-child), mechanical≠contract. The migratable surface = the chokepoints Tachyon OWNS (project state→245, spawn request→246, session brief→216, the manual done-gate→214). Those are shipped. The migration is **substantially complete**; the remainder is project-domain + thin documentation, not new gates.
