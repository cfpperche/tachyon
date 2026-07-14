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

## Acceptance review — 2026-07-14

**Verdict:** ACCEPT for deliberate integration review; not yet shipped.

- Delivery authority: `BridgeClientRebindCoordinator.preflight()` calls Workspace's
  `AgentManager.resumeReadiness()` adapter before `markExpectedDeath` or either stop path.
  `resumeReadiness()` checks the record marker and reload deny set before its cache, so the reproduced
  Delivery-bound survivors remain running with their old generation stamp.
- Private Claude continuity: transcript lookup and launch both use the persisted
  `resume.configHome`; the override is limited to non-default Claude homes, and the global-home
  compatibility regression proves no new `CLAUDE_CONFIG_DIR` is exported for ordinary sessions.
- Honest lifecycle result: rebind passes `deferBridgeStamp`, proves 1.5 seconds of replacement
  liveness, and only then writes `resume_ok` plus the current generation.  The forced early-exit test
  proves `resume_fail`, no generation advance, and an operator notification.
- Main compatibility: the intervening resume-without-primer default remains unchanged; ordinary
  human resume still owns its immediate Bridge stamp, while only spec-380 rebind defers it.
- Scope audit: nine intended paths only; no Delivery recovery, ProcessFence, UI, configuration
  schema, or automatic integration changes.
- SDD review found and corrected one documentation defect: `tasks.md` used a non-executable
  `Headless check` label.  It now declares `Verify`, and both `sdd verify --run` and
  `sdd dogfood --run` pass with durable logs below.
- Non-blocking residuals remain explicit: the stability proof is process-liveness, not an MCP
  application handshake; a Delivery marker appearing after the read-only preflight is outside the
  known deterministic failure closure; installed Reload Window dogfood still requires the maintainer.

## Verification log

### 2026-07-14T16:23:57Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts && npm run typecheck` — pass

### 2026-07-14T18:44:56Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts && npm run typecheck` — pass

## Dogfood log

### 2026-07-14T16:24:17Z — pass (1/1) — source: tasks.md — commit: f49c56be7d53e3380dfc5a7710c2a22829804c33
- `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts -t "reload-safe"` — pass

### 2026-07-14T18:46:24Z — pass (1/1) — source: tasks.md — commit: b85da800ae32f61fecb21499a3e4f542d5492c0e
- `npx vitest run test/unit/agentManager.test.ts test/unit/bridgeClientRebind.test.ts -t "reload-safe"` — pass

## Installed 0.56.3 dogfood finding — 2026-07-14

- Reload activated installed 0.56.3 and started its persistent Bridge daemon; a fresh MCP initialize
  worked through both proxy and backend, and `codex-budget` completed ordinary `resume_ok`.
- The live `codex` tmux session was absent from the generation-46 rebind audit, retained durable bound
  generation 45, and its pre-reload MCP client hung on both `list_agents` and `get_task`.  A fresh MCP
  client against the same proxy returned immediately, isolating the failure to the missed survivor.
- Root cause class: `onListenerReady()` took exactly one running-session snapshot before enqueue and
  returned immediately when it was empty/incomplete.  A restored session omitted by that snapshot was
  never reconsidered.
- Follow-up `t-25cc1c` adds a bounded 100 ms host-inventory settle plus one rescan.  It does not change
  `graceMs`, Delivery authority, or the existing destructive preflight.  The new `reload-safe` regression
  starts with an empty inventory, reveals a wired survivor only during settlement, and forces its exact
  stop/resume/stamp path.
- The new regression failed against parent `ac6722e8` with `inventorySettled=false` and passed at
  `b85da800`.  The complete AgentManager + rebind focus passed 317/317; typecheck and diff-check passed.
