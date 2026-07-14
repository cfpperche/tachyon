# 380 — reload-safe-agent-rebind — notes

_Created 2026-07-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-14 production evidence distinguishes two failures: Delivery agents were stopped before a
  known generic-resume refusal; ordinary private-home Claude reviewers were restarted without
  `CLAUDE_CONFIG_DIR` and exited 1.  Both belong in one reload-safety correction because the same
  spec-364 transaction caused them and one live dogfood event proves the combined contract.

## Deviations

None yet.

## Tradeoffs

- Leave Delivery-bound clients half-open rather than stop them generically.  This preserves the
  authoritative live execution; a Delivery-owned reconnect path remains future work.

## Open questions

None.

## Verification — 2026-07-14

- Red baseline: the three new core regressions failed independently on base `4cdf8f91` (Delivery
  teardown occurred, early-dead replacement was stamped healthy, and private Claude home was absent).
- Focused candidate: `test/unit/agentManager.test.ts` plus `test/unit/bridgeClientRebind.test.ts`,
  315/315 passed.
- Headless dogfood: five `reload-safe` regressions passed, including default-home compatibility and
  deferred Bridge stamping.
- `npm run typecheck` passed.
- `npm run verify:full:quiet` passed: 325 files; 3903 passed, 3 skipped.
- Complete delta audit found no Delivery authority expansion: rebind delegates eligibility to the
  existing generic-resume denial boundary and leaves denied live processes untouched.
- Human installed-build reload dogfood remains intentionally pending until review and explicit merge;
  this candidate does not manipulate the VS Code window.
- The attempt to create the board bug task hung on this session's stale pre-reload MCP transport and
  was terminated without claiming success.  Track the candidate under `t-c5c204` and spec 380 until
  the Codex session itself is reconnected and the dedicated board item can be created.

## Production reproduction — 2026-07-14

- Installed/active build: Tachyon 0.56.2, host generation 45.
- `ownrot4` and `sockfix3`: `preflight_ok -> stop -> dead -> resume_fail` with
  `Delivery-bound execution requires Delivery recovery, not generic resume`.
- `ownrot4-review` and `sockfix3-review`: audit said `resume_ok`, but both tmux panes died exit 1
  with `No conversation found with session ID`.
- Both reviewer transcripts exist (455267 and 545442 bytes) under their persisted private homes.
- Their replacement tmux environments had `TACHYON_AGENT_NAME` but no `CLAUDE_CONFIG_DIR`.
- `grokauthfix` remained alive and was not touched during diagnosis.

## Current-main reconciliation — 2026-07-14

- The original immutable candidate remains preserved at `031e72eb` on
  `codex/reload-safe-agent-rebind`.
- Board bug `t-9240f4` was created after Stop/Resume restored this Codex session's MCP transport;
  it relates the narrower `t-ed03b3` symptom and the original `t-c5c204` reload dogfood.
- A fresh reconciliation branch, `codex/t-9240f4-reload-safe-rebind-r2`, was created from current
  `main` at `8c68700e`.  Applying `031e72eb` required no textual conflict resolution.
- The intervening main change makes resume omit primer by default.  The reconciled delta preserves
  that contract: rebind still passes `injectPrimer:false` explicitly, and the new internal
  `deferBridgeStamp` option changes only stamp ownership.
- Reconciled focused suites passed 316/316; `npm run typecheck` and both diff checks passed.
- Reconciled `npm run verify:full:quiet` passed: 328 files; 3952 passed, 3 skipped.
- Human installed-build dogfood remains pending; no merge, package, install, Bridge restart, or VS
  Code window action was performed by the agent.
