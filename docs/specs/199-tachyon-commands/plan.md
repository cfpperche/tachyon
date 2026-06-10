# 199 — tachyon-commands — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Reuse the F2 crash infrastructure (remain-on-exit + `pane_dead_status`) but invert
its meaning: a dead pane is the RESULT, not a failure of supervision. A dedicated
`CommandRunner` owns the `tachyon-cmd-<hash>-<name>` session namespace — structurally
invisible to AgentManager/LifecycleMonitor/AttentionMonitor, so none of the agent
machinery (crash toasts, restart policies, maxAgents) ever sees a command. Completion
detection rides the existing 3s extension ticker; `run_command` blocks agents through
the existing Waiters registry under a `cmd:` key prefix (the same event-driven
long-poll shape as `wait_for_agent`, zero new polling). UI is a 4th sidebar view +
a third Agent Studio tab writing through the comment-preserving yml editor.

## Files to touch

**Create:**
- `src/commands/CommandRunner.ts` — run/tick/status/list/tail/history/killAll over the cmd namespace
- `test/unit/commands.test.ts` — config parsing + runner lifecycle (fake tmux)

**Modify:**
- `src/config/loadConfig.ts` — `CommandDef {cmd, cwd?, env?}` + `commands:` map parsing
- `src/config/tachyon.schema.json` — commands schema
- `src/bridge/tools.ts` — `run_command` (blocking, rerun param) + `list_commands`; `CMD_WAIT_PREFIX`
- `src/config/YamlConfigEditor.ts` — upsertCommand/deleteCommand/commandEntryLine
- `src/presentation/Sidebar.ts` — CommandsProvider (Commands group, state icons)
- `src/presentation/Terminals.ts` — optional title param (`$ name` tabs)
- `src/webview/AgentForm.ts` + `src/webview/formLogic.ts` — Command tab (name/cmd/cwd only)
- `src/extension.ts` — runner wiring, ticker, toasts, view, internal commands, stopAll
- `package.json` / nls / l10n bundles — view, commands, menus, 0.4.0
- `test/unit/{bridge,auth}.test.ts` — tool count 13→16
- `test/integration/extension.test.js` + fixture — live pass/fail scenario
- `test/e2e/bridge-host.ts` — harness gains the runner

## Alternatives considered

### VSCode Tasks API integration

Rejected: tasks run in VSCode's own terminal lifecycle — invisible to agents via the
Bridge, not preserved across editor restarts, and unobservable from tmux. The whole
point is one process model (tmux) shared by humans and agents.

### Reusing AgentManager with a "oneshot" kind

Rejected: the lifecycle is inverted (exit = success vs exit = crash); threading a
mode flag through LifecycleMonitor/AttentionMonitor/maxAgents would special-case
every consumer. A separate namespace + runner is smaller and structurally safe.

## Risks and unknowns

- Tick-based completion adds up to 3s of UI latency — acceptable; `run_command`
  resolution is event-driven through onFinished→waiters, so agents aren't delayed.
- In-memory run history (cap 20) is lost on reload — documented, same stance as lineage.

## Research / citations

- github.com/opus-domini/sentinel — services/runbooks concept that motivated F15/F21
- F2 (spec 190) remain-on-exit + pane_dead_status mechanics, reused verbatim
