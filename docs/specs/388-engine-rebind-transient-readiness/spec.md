# 388 — engine-rebind-transient-readiness

_Created 2026-07-16._

**Status:** shipped
**Closure:** Shipped 2026-07-16 — fresh typed rebind readiness, bounded non-destructive retry,
final lifecycle-authority guard, focused regressions, full verification, and persistent-engine dogfood.
**Affected Product Invariants:** none — engine-rebind readiness does not change the registered PI-001
project-guidance ownership promise or oracle.

## Intent

After a real persistent-engine incarnation change, a surviving Bridge-wired agent can be alive while
its generic-resume target is not yet discoverable.  The Bridge-client rebind coordinator currently
performs one cached readiness check, marks the attempt failed immediately, and leaves the old process
alive with its stale MCP client.  The user must then perform Stop -> Resume manually.

Done means recovery waits only for a bounded, explicitly retryable readiness condition, observes a
fresh result rather than the sidebar cache, and tears down the survivor only after a safe resume target
exists.  A permanent denial or expired wait remains fail-closed: the original process stays alive, no
cold spawn occurs, and the audit explains the outcome.  This recovery boundary is an engine
crash/upgrade, not an ordinary VS Code shell reload.

## Acceptance criteria

- [x] **Scenario: transient readiness recovers the same session**
  - **Given** a Bridge-wired survivor is stale after a real engine-incarnation change and its resume
    target is initially unavailable for a retryable reason
  - **When** that target becomes ready within the bounded preflight window
  - **Then** the coordinator records wait and ready transitions, stops the old process only after the
    positive probe, resumes the discovered session without a cold spawn, and finishes `resume_ok`
- [x] **Scenario: retry timeout preserves the survivor**
  - **Given** a running suspect whose retryable resume target remains unavailable
  - **When** the bounded preflight window expires
  - **Then** no expected-death mark, stop, hard kill, resume, or cold spawn occurs; the process remains
    alive and the audit records an actionable timeout
- [x] **Scenario: permanent generic-resume denial fails immediately and safely**
  - **Given** a suspect is Delivery-owned, snapshot-denied, structurally non-resumable, or otherwise
    permanently denied by the generic-resume boundary
  - **When** rebind preflight evaluates it
  - **Then** it is not retried or torn down, remains alive, and the audit records the permanent reason
- [x] **Scenario: recovery probes do not weaken the normal readiness cache**
  - **Given** normal sidebar readiness has cached a negative result for a session identifier
  - **When** engine recovery requests a fresh readiness probe after the target appears
  - **Then** recovery observes the new result while ordinary repeated sidebar probes retain their
    bounded cached behavior
- [x] **Scenario: shell reload remains operationally inert**
  - **Given** a healthy persistent engine and an attached VS Code shell
  - **When** the shell reloads or reattaches without an engine-incarnation change
  - **Then** no Bridge generation bump, client rebind, stop, or resume is introduced by this change
- [x] Existing queue ordering, circuit breaker, post-resume stability proof, no-cold-spawn rule, and
  ordinary human Resume behavior remain unchanged.

## Non-goals

- Adding hot MCP reconnect support to Codex or any other runtime.
- Reintroducing Bridge-client rebind on ordinary VS Code shell reload.
- Falling back to a fresh process/conversation when resume is unavailable.
- Fixing the separate tmux `can't find session` race observed after a successful preflight.
- Redesigning the sidebar, runtime adapters, Delivery recovery, or the full agent lifecycle.

## Open questions

- None.  The implementation plan will choose the smallest typed/fresh readiness seam that preserves the
  existing cached boolean API for ordinary callers.
