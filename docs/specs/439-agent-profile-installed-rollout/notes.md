# 439 — agent-profile-installed-rollout — notes

_Created 2026-07-23._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## 2026-07-23 — installed inventory and scope ratification

The production workspace has six inline agents: `claude`, `claude-orca`, `codex`, `grok`,
`grok-workflow` and `grok-x`. The current planner accepts only literal `codex` and rejects
`selfEvolution`, while the
canonical Studio patch exposes only display name, runtime and role. The user confirmed the objective
is to return to the main trail and migrate all installed agents, not stop at a Codex-only rollout.

Task `t-be11d9` records the immediately visible Studio gap. Quick Add task `t-cd5e58` preserved
unsupported runtimes through the legacy writer instead of minting partial authority; this rollout must
replace that temporary compatibility with measured adapters before removing legacy paths.

## Installed agent inventory

| Agent | Inline source | Runtime observed 2026-07-23 | cwd/trust | governed state | expected pointer |
|---|---|---|---|---|---|
| `claude` | `cmd: claude` | Claude Code 2.1.218 | workspace root | none inline | `.tachyon/agents/claude/agent.yml` |
| `claude-orca` | `cmd: claude` | Claude Code 2.1.218 | workspace root | none inline | `.tachyon/agents/claude-orca/agent.yml` |
| `codex` | `cmd: codex` | codex-cli 0.145.0 | workspace root | `selfEvolution.enabled: true`; existing Evolution head | `.tachyon/agents/codex/agent.yml` |
| `grok` | `cmd: grok` | grok 0.2.103 (89c3d36fb6) | workspace root | none inline | `.tachyon/agents/grok/agent.yml` |
| `grok-workflow` | `cmd: grok` | grok 0.2.103 (89c3d36fb6) | workspace root | none inline | `.tachyon/agents/grok-workflow/agent.yml` |
| `grok-x` | `cmd: grok` | grok 0.2.103 (89c3d36fb6) | `/home/goat/monetizacao-x`; external trust must be proven | none inline | `.tachyon/agents/grok-x/agent.yml` |

No inline agent declares environment values, Soul or selected memory. Workspace guidance and plugins
remain external shared dependencies. Adapter-specific native files, flags, auth and capability inputs
are deliberately not inferred from this table; `t-7e7464` must inventory them from the installed
runtime versions and turn unknowns into refusal.

## 2026-07-23 — architecture review corrections

Read-only review `rollout-arch-review` rejected implementing the first draft because it mixed runtime
adapter expansion, Evolution authority, Studio ownership and fleet cutover without concrete handoffs.
The SDD now uses six named Tasks: `t-7e7464`, `t-1f35d4`, `t-be11d9`, `t-2d4d87`, `t-673096` and
`t-088d08`. The cutover is six sequential recoverable transactions with barriers and a checkpoint,
not a new atomic fleet protocol. Studio follows an explicit writable/read-only/deferred matrix, and
legacy retirement requires a concrete compatibility allowlist plus a no-new-writer oracle.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-23 — six-agent planner and recovery slice

Task `t-2d4d87` updated the installed inventory after `grok-workflow` was added. The planner now derives
the canonical runtime and host inspector from the measured exact literal command (`codex`, `claude` or
`grok`) instead of always minting Codex authority. One six-stanza oracle proves normalized
before/after equivalence, including Codex Evolution and the external `grok-x` cwd.

The single-agent transaction boundary is unchanged. Added evidence covers compensation at every
pre-commit durable phase, deterministic reconcile of partial/complete tuples, rollback CAS,
symlink refusal, unclassified environment refusal and byte-identical workspace plugin lock data.
No live agent was paused or migrated in this slice.

Verification:

- focused SDD set: 188/188 passed;
- PI-001: 2/2 passed;
- `npm run typecheck`: passed;
- `npm run verify:full:quiet`: 487 files, 5538 passed, 3 skipped.

## Dogfood log

### 2026-07-23T20:06:58Z — pass (1/1) — source: tasks.md — commit: ac90293f3de5ead73db5ab0d65f124f29dc94d5e
- `npm test -- test/unit/agentProfileInstalledRollout.dogfood.test.ts` — pass

## 2026-07-23 — isolated six-agent rollout mirror

The mirror migrated `claude`, `claude-orca` and `codex`, wrote a durable completed/next checkpoint,
simulated restart reconciliation, then resumed with `grok`, `grok-workflow` and `grok-x`. It rolled
`grok-workflow` back and migrated it again, ending with six canonical pointers and byte-identical
workspace plugin lock data.

The first run exposed a real sequential-resume gap: planning and prospective reload treated canonical
siblings from earlier transactions as legacy or lacked their host authorities. The planner now accepts
the already-published authority set, and commit reload gathers every canonical sibling authority from
the authority port. Missing sibling authority fails closed.

Evidence:

- SDD dogfood: 1/1 passed;
- focused migration/Workspace set: 94/94 passed;
- PI-001: 2/2 passed;
- isolated Dev Host `TACHYON_DEV_HOST_ID=t-673096`: 8/8 checks passed;
- `npm run typecheck`: passed;
- `npm run verify:full:quiet`: 488 files, 5539 passed, 3 skipped.

No installed agent was modified. Live cutover remains the next barrier and requires the selected target
to be stopped and unoccupied.

## 2026-07-23 — installed rollout superseded

Live dogfood exposed that migration also changes runtime-native configuration inheritance and session
home semantics. The user chose not to spend further effort migrating short-lived existing agents.
All six installed agents were returned to their legacy `tachyon.yml` declarations. Existing sessions
will finish in that format; new agents are created directly as canonical profiles.

The migration/rollback implementation is now temporary machinery, not a supported rollout path.
Task `t-088d08` owns removal of the legacy format and all migration, journal, recovery and rollback
paths after the last old agent is retired. It also owns cleanup of the host authority left behind by
the manual Claude rollback (`22609f0b-885a-48a2-a429-18544d1b3669`).
