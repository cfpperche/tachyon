# 388 — engine-rebind-transient-readiness — plan

_Drafted from `spec.md` on 2026-07-16. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep the existing cached `AgentManager.resumeReadiness()` API unchanged for sidebar callers.  Add one
rebind-only, uncached probe that returns `ready`, retryable unavailability, or permanent denial with a
bounded reason.  It shares the existing resume-target evaluation but checks Delivery/snapshot denial
before and after asynchronous resolution.

Wire that probe into `BridgeClientRebindCoordinator`.  On retryable unavailability, poll every 100 ms
for at most 5 seconds.  Before accepting each result, re-read the ledger and revalidate tracked state,
process liveness, durable generation, and generic-resume authority.  Audit the first wait and its
resolution/timeout.  Only a positive result may cross the existing expected-death -> stop -> resume
boundary.

Prove the behavior at three levels: AgentManager cache isolation, coordinator state/audit behavior,
and the existing persistent-engine dogfood's shell detach/reattach invariant.  The dogfood will compare
the durable Bridge generation and rebind audit before/after shell reattachment; it will not invent a
fake Codex runtime.

## Key decisions

- **Dedicated uncached rebind probe** — preserves the sidebar cache that prevents repeated transcript
  scans while allowing recovery to observe a target that appears under the same ledger `sessionId`.
  Globally disabling negative caching would revive the scan/performance regression.
- **Three outcomes (`ready`, `retry`, `denied`)** — prevents a Delivery/snapshot denial or malformed
  record from consuming the retry budget.  Retrying every boolean `false` would stall the serial fleet
  and erase actionable diagnostics.
- **Internal 5-second/100-ms budget** — the policy is small and recovery-specific.  No new user setting
  is added; `graceMs` governs self-heal before queueing and `stopTimeoutMs` governs teardown, so reusing
  either would conflate different lifecycle phases.
- **Fresh ledger and authority checks around async work** — a user stop, manual heal, or Delivery denial
  that appears during resolution must prevent teardown.  A new locking protocol is unnecessary for this
  bounded preflight.
- **No fake-runtime engine dogfood** — the focused tests own the transient transcript behavior.  The
  existing real process dogfood already exercises shell detach/reattach and engine upgrades/crashes;
  adding durable generation/audit comparisons proves the relevant shell boundary without simulating
  Codex auth/TUI behavior.

## Files touched

- `src/agents/AgentManager.ts` — add the typed uncached rebind readiness probe and share target evaluation.
- `src/bridge/clientRebind.ts` — bounded retry, safety revalidation, and audit transitions.
- `src/workspace/Workspace.ts` — wire the rebind-only probe and correct lifecycle terminology.
- `test/unit/agentManager.test.ts` — cache isolation and permanent-denial coverage.
- `test/unit/bridgeClientRebind.test.ts` — transient success, timeout, same-session, and no-teardown proof.
- `scripts/dogfood/persistent-engine-runner.ts` — assert shell detach/reattach does not change generation
  or the rebind audit.
- `docs/specs/388-engine-rebind-transient-readiness/*` — contract, plan, tasks, and evidence.

## Risks & unknowns

- The queue is serial by default, so one permanently missing but structurally retryable transcript can
  delay later suspects by five seconds.  The delay is bounded; changing queue concurrency is out of scope.
- A resolver exception is not known to be transient.  It must fail immediately and preserve the process
  rather than spin until timeout.
- A positive probe is advisory until the existing resume path executes.  Resume failures remain governed
  by the existing fail-closed/no-cold-spawn behavior.
- Virtual-clock tests must cap attempts so a no-op sleep cannot create a busy loop.

## Visual impact

None.  This is an engine lifecycle change with audit/notification output only.

## Sources consulted

- `src/bridge/clientRebind.ts` preflight, queue, teardown, and audit implementation.
- `src/agents/AgentManager.ts` cached `resumeReadiness()` and canonical `resume()` target resolution.
- `src/workspace/Workspace.ts` persistent-engine construction and rebind wiring.
- `docs/specs/364-bridge-client-rebind` and `docs/specs/380-reload-safe-agent-rebind`.
- `docs/specs/382-persistent-engine-shell-boundary/spec.md` shell reload and engine-incarnation boundaries.
- Installed generation 50-56 rebind audits under VS Code legacy storage and daemon engine state.
