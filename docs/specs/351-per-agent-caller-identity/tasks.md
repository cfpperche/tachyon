# 351 — per-agent-caller-identity — tasks

_Generated 2026-07-04. GATE: T1-T3 land before any tool semantics change (T4+). Commit per task, ALWAYS by
pathspec. Existing bridge tests must stay green under the legacy path at every commit (parity invariant)._

## Implementation

- [ ] T1 `src/bridge/callerIdentity.ts`: digest-only registry (HMAC via SecretStorage key), mint/resolve/
  revoke/TTL, CallerSnapshot, reason codes, constant-time discipline + tests (incl. two-workspace scoping,
  no-plaintext-persisted proof).
- [ ] T2 AgentManager: mint on spawn/resume (TACHYON_AGENT_BRIDGE_TOKEN), revoke on kill/dismiss, restart
  revoke-before-mint ordering; MCP config prefers the new var (fallback legacy var) + tests.
- [ ] T3 Bridge.ts: Bearer → snapshot resolution (agent/master→external/legacy-gated), compat setting,
  legacy per-call logging, 401 reason codes; threads caller into registerTools deps + tests.
- [ ] T4 tools.ts: resolveActor helper (omitted/equal/mismatch/master_claim_denied) wired into spawn
  parent, notify sender, create_task/create_pin agent, attach_evidence producer, continuity/handoff agent;
  update_task self-assign suppression via snapshot; legacy snapshot bypass parity + per-tool tests.
- [ ] T5 ProbeService per-run tokens (parent-attributed, run-scoped expiry) + tests.
- [ ] T6 Resume env integration proof in the tmux harness (fresh token observed post-resume; stale-pane
  case); implement the 0600 handoff-file fallback ONLY if the proof fails, recording the decision.
- [ ] T7 Redaction audit of Tachyon-generated diagnostics (+ tests with fake tokens), docs truth pass, full
  suite + both typechecks.

## Verification

- [ ] Registry lifecycle + scoping + digest-only persistence — T1 tests.
- [ ] Mint/revoke/restart ordering — T2 tests.
- [ ] Resolution kinds + legacy fence + reason codes — T3 tests.
- [ ] Per-tool actor resolution + mismatch + self-assign suppression + legacy parity — T4 tests.
- [ ] Probe token expiry/attribution — T5 tests.
- [ ] Resume proof — T6 integration test.
- [ ] Redaction — T7 tests.
- [ ] Full `npm test` + both typechecks green.

**Headless check:** `npm test -- --run test/unit/callerIdentity.test.ts test/unit/bridge.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/callerIdentity.test.ts test/unit/bridge.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/callerIdentity.test.ts -t "mismatch"`
<!-- Headless proxy. The live pass below needs an installed build. -->

**Human dogfood:** After install: spawn an ad-hoc; from its session call notify_agent with NO agent param
(delivers, sender resolved), the RIGHT param (ok) and a WRONG param (caller_mismatch + reason code); claim
a task as yourself and confirm NO self-assign poke arrives; check the log for a legacy_unvalidated entry
from any pre-reload session; stop/resume an agent and confirm its first bridge call authenticates.

## Visual QA

**Visual QA Opt-Out:** Bridge/auth work with no rendered surface; the observable outcomes are tool results,
reason codes and log entries, covered by the live dogfood above.
