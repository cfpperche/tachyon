# 494 — saved-agent-state-ownership — notes

_Created 2026-08-06._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Deviations

The task `t-f353bc` asked for a clone experiment with a stated falsifiable prediction. The
experiment ran first, as asked. It refuted the prediction's premise, so the spec was designed
against the measurement instead of against the task body. Full record in
`evidence/measurement-2026-08-06.md`. Four refutations, in the order they change the design:

1. **`tachyon.yml` is ignored by Git** (`.gitignore:32`). The roster is not versioned. A fresh
   clone gets no roster at all, so no Saved Agent is born anywhere. The prediction cannot be
   tested by cloning. The roster travels by copy, and a path change alone is enough, because
   `workspaceHash` is `sha256(path)`.
2. **The consequence is worse than predicted.** A roster with no authority does not produce
   refused agents. It produces no config at all. `agentProfileConfigLoader.ts:174` returns
   early when nothing projected, so the workspace loses `verify`, `projectGuidance`,
   `maxAgents` and `auth` along with the fleet.
3. **`claude23` is not refused for lack of authority.** It has an authority. The live
   `list_agents` door reports a spec 471 `native-config-value` refusal, caused by
   `~/.claude/settings.json`. That file is a fifth place, on the host, owned by the machine.
   The task listed three places and this one was not among them.
4. **`claude-prosa` does not exist.** The fleet is `claude`, `claude-cowntdown`, `claude23`.

The task's confirmed premises: `locks/` and `lifecycle/` hold zero entries, and no forget
journal names `claude23`. The transaction did not fail. It was never reached.

The owner's decision still holds, and the spec is built on it. The supporting argument
changed. The roster is not local because Git would otherwise share it. The roster is local
because its authority is keyed to a machine and a path, and no copy of the roster can carry
that authority with it.

## Tradeoffs

**Moving the roster fixes nothing on its own, and the spec says so.** `t-f353bc` already named
this risk. The measurement confirmed it: three places become two plus one, and the `claude23`
failure would survive the move untouched, because that failure is a coupling inside
`config.agents` and not a count of files. Part 1 of the plan is therefore independent of
Parts 2 to 4, and ships first. If only one part ships, the p0 is still gone.

**The migration keeps the old copy.** The cost is visible residue in `tachyon.yml` until a
human deletes it. The alternative loses the fleet when a write goes wrong. The constraint in
`t-f353bc` is explicit that migration must not lose an agent, so the residue wins.

## Open questions

Three are recorded in `spec.md` and are the ones that block the plan. One more surfaced here
and does not block anything:

- **`tachyon.yml.example` and `~/.local/share/tachyon-backups/tachyon.yml.latest` both fail to
  load.** Both declare retired inline `cmd:` agents. Measured: `config` is `undefined`, not a
  partial roster. So the documented onboarding path for a new checkout does not work today.
  This is out of scope here and needs its own task.

## Status of the work that produced this spec

Spec, plan and tasks are written. No product code changed. The implementation is Parts 0 to 4
in `tasks.md` and is a separate task. `claude23` is intact and is the acceptance fixture for
the first scenario.

## Parts 0 and 1 implementation

The removal test list uses these actor and trigger names:

1. `Human, Agent Studio x planAgentProfileForget`
2. `Human, Agent Studio x forgetAgentProfileAgentCascade`
3. `Agent, Bridge x propose_saved_agent_removal`
4. `Human, sidebar x config.agent.delete`
5. `Agent or Human x dismiss_agent`
6. `Human, text editor x edit tachyon.yml`

The sidebar door was absent from the measurement table. Source inspection found it before
production changes. It used `isAgentProfileAgent` through `deleteConfiguredAgent`.

The first focused run failed at the plan, cascade, and Bridge doors. The expanded run also
failed at the sidebar door. The dismiss refusal and raw text edit behaved as documented.

`isSavedAgentMember` now reads only `agentSources`. It accepts `profile` and `refused`.
The plan, cascade, Bridge inspection, sidebar deletion, direct transaction, and locator fact
use membership. The focused suite passes all six cases.

The acceptance fixture uses the name `claude23` in a temporary workspace. It reproduces the
spec 471 refusal from a private fake home. The live `claude23` remains unchanged.
