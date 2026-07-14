# 380 — reload-safe-agent-rebind — plan

_Drafted from `spec.md` on 2026-07-14. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a read-only resume-eligibility port to `BridgeClientRebindCoordinator` and invoke it in preflight,
before the coordinator marks an expected death or sends a stop.  Workspace supplies the existing
`AgentManager.resumeReadiness()` check, which already rejects Delivery markers/snapshot-denied agents
and validates the transcript under the persisted config home.

Make `AgentManager.resume()` bind legacy private-home Claude sessions to the durable
`resume.configHome` after ordinary harness materialization.  The persisted value is already the
transcript lookup authority under spec 240; using the same value for `CLAUDE_CONFIG_DIR` closes the
split-brain where Tachyon proves a file in one home and starts Claude against another.

After `resume()` returns, keep the rebind in `rebinding` state for one short, bounded liveness window.
Only a replacement that remains present through that window may be stamped/current and audited as
`resume_ok`.  An early exit follows the existing failure path and leaves no healthy stamp.

The installed 0.56.3 dogfood exposed a separate activation race: the first tmux inventory omitted a
live Codex survivor, so it never entered the rebind queue and kept a half-open MCP client.  Keep
`graceMs: 0` semantics for client healing, but allow 100 ms for host inventory settlement and take one
authoritative second scan before enqueueing the union.  Decisions already made for agents seen in the
first scan are not reset by the second.

## Key decisions

- **Reuse `resumeReadiness()` for destructive preflight** — it is the existing generic-resume policy
  boundary and checks Delivery denial before its cache.  A second Delivery predicate inside the
  coordinator would duplicate authority and drift.
- **Persisted config home wins at process launch** — spec 240 already makes it authoritative for
  transcript lookup and GC.  Inferring isolation again from today's ad-hoc definition is rejected
  because reload rehydration can legitimately lack the transient `isolate` flag.
- **Bounded process-liveness proof, not Claude UI parsing** — the defect is an immediate exit and all
  runtimes expose tmux liveness.  Adding a proprietary Claude prompt classifier is broader and still
  would not protect Delivery agents before stop.
- **No automatic recovery of Delivery executions** — a generic host rebind has no lease authority.
  It must leave them alive/suspect for a Delivery-owned future path rather than broaden spec 368.
- **Inventory settlement is not client grace** — the fixed 100 ms wait exists only to make restored
  tmux discovery stable.  It neither lets an MCP call self-clear suspicion nor changes the configured
  `graceMs` policy.

## Files touched

- `src/bridge/clientRebind.ts` — post-settle inventory rescan, pre-stop eligibility, and post-resume stability proof.
- `src/workspace/Workspace.ts` — wire the eligibility port to AgentManager's canonical read-only check.
- `src/agents/AgentManager.ts` — apply the persisted config-home environment on resume.
- `test/unit/bridgeClientRebind.test.ts` — force late-visible survivor, no-stop Delivery refusal, and early-exit audit behavior.
- `test/unit/agentManager.test.ts` — force legacy private Claude config-home resume wiring.
- `docs/specs/380-reload-safe-agent-rebind/*` — contract and evidence.

## Risks & unknowns

- A preflight result may become stale between check and stop.  The actual `resume()` retains its own
  fail-closed guard; this change removes the known deterministic destructive case but does not claim
  a new cross-store transaction.
- The stability wait adds bounded time to each serial rebind.  Keep it short and deterministic in
  tests; do not add a configurable policy surface for this defect correction.
- Other runtimes keep their existing private-home materialization unchanged.  This correction is
  deliberately limited to the reproduced Claude split-brain and does not generalize an environment
  contract without equivalent evidence.

## Visual impact

No UI rendering changes.  Sidebar state becomes more honest because an early-dead replacement is no
longer stamped healthy.

## Sources consulted

- `docs/specs/240-tachyon-transcript-isolation/{spec,plan,tasks}.md` — persisted config-home invariant.
- `docs/specs/364-bridge-client-rebind/{spec,plan,tasks,notes}.md` — generation/rebind contract.
- `docs/specs/368-delivery-worktree-leases/{spec,plan,tasks,notes}.md` — generic lifecycle denial.
- `src/bridge/clientRebind.ts`, `src/agents/AgentManager.ts`, `src/workspace/Workspace.ts`.
- Production audit `~/.vscode-server/data/User/globalStorage/cfpperche.tachyon/bridge-client-rebind/audit.jsonl` and `.tachyon/sessions.json` captured 2026-07-14.
