# 329 — bridge-dismiss-agent — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Added a dedicated `dismiss_agent` Bridge tool instead of changing `kill_agent` semantics. `kill_agent` remains the live-session operation; `dismiss_agent` is explicitly for stopped ad-hoc rows.
- `dismiss_agent` checks `manager.list()` before cleanup so it can reject unknown names, declared agents, and still-running ad-hoc sessions with state-specific guidance.
- `AgentManager.dismissAdhoc` now emits the existing lifecycle callback after cleanup. This lets Bridge-initiated dismisses refresh the sidebar/listing through the same path as other lifecycle changes.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- No deviations from the folded plan.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Rejecting running ad-hoc dismisses requires a two-step cleanup (`kill_agent`, then `dismiss_agent` if the row remains listed), but avoids orphaning a live tmux session from Tachyon state.
- The UI dismiss path may now receive an extra refresh callback in addition to its explicit refresh. That is acceptable because refresh is idempotent and Bridge needs a manager-level signal.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- None for v1.

## Probe log

- Claude/Fable probe `probe-779d7a4e-aa61-4596-8fc0-4d9b308b1ae6` completed with cost `$0.237697`. Folded findings: reject running ad-hoc dismiss, refresh sidebar after Bridge dismiss, preserve `kill_agent` as the live-session primitive, and document destructive cleanup semantics for stopped ephemeral rows.

## Verification log

- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts` passed.
- `npm run typecheck` passed.
- `npm test -- --run test/unit/bridge.test.ts -t dismiss_agent` passed.
- `npm run build` passed.

## Dogfood log

### 2026-07-02T18:46:37Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts` — pass

### 2026-07-02T18:46:42Z — pass (1/1) — source: tasks.md — commit: fa6e79432b09ea25e0f0adba92a426d9ad1f3e69
- `npm test -- --run test/unit/bridge.test.ts -t dismiss_agent` — pass
