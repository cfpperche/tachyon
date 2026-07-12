# 373 — token-efficient-agent-fleet — plan

_Drafted from `spec.md` on 2026-07-11. The approach, not the steps (those go in `tasks.md`)._

## Approach

Land this only after spec 372 so the new cadence can name a real quiet full gate. First preflight the exact declared
commands against Tachyon's runtime model discovery: Sol xhigh for `codex`, Terra medium for `codex-executor`, Luna low
for a new `codex-mechanical`, and Claude Sonnet for `codex-reviewer`. Unsupported models are a visible launch error;
there is no fallback to Sol.

Update `tachyon.yml` as the single durable fleet policy. Its declared commands encode the runtime/model allocation,
`codex.subagents` exposes the three owned workers, and the coordinator/worker instructions encode routing,
verification cadence, batched audit, and context lifecycle. Keep contracts operational: define what makes a correction
mechanical, when an extra full run is justified, and how to distinguish restart (fresh conversation) from resume
(existing transcript).

Add focused config/primer/session tests that assert the exact commands and policy markers and protect the already
implemented restart semantics. Activate the changed fleet only at a task boundary: checkpoint continuity, allow the
current spec 372 executor to finish, reload the configuration, restart the affected declared agents, and confirm their
new session/model/readiness before assigning work. Dogfood one closed executor contract, one mechanical correction,
and one immutable review without using production work as an experiment.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Four explicit lanes** — Sol xhigh coordinates, Terra medium implements, Luna low applies mechanical corrections,
  and Claude Sonnet reviews; rejected one-model-for-all because it concentrates quota and makes independent review
  less independent.
- **Commands encode model choice** — launch preflight can reject an unavailable model before work is assigned;
  rejected prose-only model selection because it can silently drift from the actual runtime.
- **Luna gets a separate declared agent** — its narrow role and low effort remain mechanically visible; rejected
  mutating the Terra executor's model between rounds because config reload/restart overhead obscures provenance.
- **Two full gates per task by default** — the first reviewable candidate establishes a broad baseline and final
  closure proves the accepted head; rejected full verification after every correction because focused gates already
  localize those changes and repeated full output caused the rate-limit incident.
- **Audit before correction** — the coordinator folds executor diff inspection and reviewer findings into one durable
  closed contract; rejected per-finding bounce because it multiplies turns and rediscovery.
- **Restart at a completed task boundary** — Tachyon restart mints a fresh runtime conversation and preserves the
  worktree; rejected resume because it deliberately replays the old transcript, and rejected mid-task rotation because
  it risks losing live reasoning and state.
- **Approximate 35–40% threshold is a routing trigger, not quota telemetry** — use the runtime's visible context meter
  when available and err toward a boundary restart; rejected pretending Tachyon can derive provider billing/quota
  state from transcript size.

## Files touched

- `tachyon.yml` — declared runtime/model commands, owned subagent list, lane contracts, gate cadence, audit batching,
  and context lifecycle.
- `test/unit/config.test.ts` or the nearest existing config-focused test — parse and assert the exact declared fleet.
- `test/unit/primer.test.ts` or the nearest existing primer test — assert the durable coordinator/worker policy is
  composed and survives re-anchor/restart.
- `test/unit/agentManager.test.ts` — only if existing coverage does not already prove restart creates a fresh session
  while resume reuses context; do not change lifecycle production code without a demonstrated gap.
- `docs/specs/373-token-efficient-agent-fleet/*` — contract, evidence, decisions, and closure.

## Risks & unknowns

- The authenticated model catalog or Claude CLI may change; preflight each exact command and fail visibly.
- Editing `tachyon.yml` while spec 372 also owns it would create an overlapping delivery. Keep this spec dependent and
  do not delegate implementation until 372 lands cleanly.
- Restart keeps tmux pane/scrollback even though it creates a new model conversation. Tests and dogfood must compare
  runtime session identity, not the pane identifier or visible scrollback.
- A numeric context percentage may not be available from every runtime. The policy is human/coordinator-observed and
  task-boundary based; do not add an unreliable automatic kill loop.
- Claude reviewer permissions must stay read-only for production/tests while still allowing its scoped review artifact.
- Config changes only affect a running declared agent after an intentional task-boundary restart/reload.

## Visual impact

**Visual QA Opt-Out:** this changes declared commands and orchestration behavior; exact runtime/model/session evidence
is stronger than screenshot judgment.

## Sources consulted

- `tachyon.yml` current Sol xhigh/Sol medium declared fleet and persisted role instructions.
- `docs/specs/370-runtime-launch-preflight/{plan,notes}.md` authenticated catalog evidence for Sol, Terra, and Luna.
- `src/agents/AgentManager.ts` restart path: fresh runtime session, preserved worktree, instruction re-delivery.
- `src/resume/adapters.ts` resume contract: existing on-disk transcript replay.
- Existing unit coverage using `claude --model sonnet` and runtime launch preflight.
- `docs/specs/372-quiet-full-verification/*` quiet gate contract and dependency.
