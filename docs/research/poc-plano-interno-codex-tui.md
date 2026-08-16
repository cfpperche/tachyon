# PoC plano interno — Codex TUI 0.147.0 (`hooks.Stop.turn_id`)

**Task:** `t-620a0b` (bloqueio da fatia 4, depois de `t-011136`) · **Measured:**
2026-08-16 · **Runtime:** `codex-cli 0.147.0` · **Model:** `gpt-5.6-sol` ·
**Originator:** `codex-tui` · **Account:** ChatGPT via symlink of
`/home/goat/.codex/auth.json` into a private `CODEX_HOME`

Study only. No product reader. No change to how a Tachyon Codex agent is
born. Disposable probe: `scripts/research/poc-tui-canal-codex.mjs`.

The question that decides fatia 4 for this runtime: **does a real Codex TUI
session leave a readable channel that can close the turn window and detect
plan events**, or does the verdict stay app-server-only?

**Exists.** The TUI does not need to become an app-server client for the
conjunction. `hooks.Stop` already carries `turn_id`. The plan is not on
Stop; it is on `PreToolUse` / `PostToolUse` (`tool_name: "update_plan"`)
and, more weakly, inside the rollout file Activity already tails.

## Verdict

| Measure | Result |
|---|---|
| Does TUI `hooks.Stop` carry `turn_id`? | **Yes.** Same field on induce and trivial. |
| Does Stop carry the plan? | **No.** Keys are `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `stop_hook_active`, `last_assistant_message`. |
| Can the turn window close without app-server? | **Yes.** Stop `turn_id`, or rollout `event_msg.task_complete` / `task_started` / `turn_aborted` with `payload.turn_id`, or `thread_history_1.sqlite` `thread_turns.status`. |
| Can a plan event be seen on the same `turn_id`? | **Yes.** `PreToolUse` / `PostToolUse` `tool_name: "update_plan"` with the complete `tool_input.plan`. Also a wrapped `custom_tool_call` `name: "exec"` whose `input` is `tools.update_plan({plan:[…]})`. |
| Trivial turn still closes? | **Yes.** Stop fired. `task_complete` wrote the same `turn_id`. Zero plan hooks. |
| `turn/plan/updated` on disk as a payload? | **No.** `logs_2.sqlite` records only the name (`app-server event: turn/plan/updated targeted_connections=1`). No `turnId`, no `plan[]`. |

What Tachyon already injects today is `hooks.SessionStart` + `hooks.Stop`
(`packages/engine/src/activity/sessionOwners.ts` `buildCodexSessionStartHookConfig`).
Stop is enough to **close** the window. It is not enough to **see** the plan.
The product Stop recorder then throws `turn_id` away: it keeps
`session_id` / `cwd` only (`PERSISTENCE_STOP_RECORDER_SOURCE`, same file,
the object that writes `persistence-stop.jsonl`).

That discard is why fatia 2 could not compute a Codex TUI verdict. The
runtime was already sending the field.

## Controls

**Positive (must see a plan).** Same induce prompt as
`docs/research/poc-plano-interno-codex.md`. The model called `update_plan`
with three pending tea steps and replied `PLANNED`. Without that event this
file would be a failed probe.

**Negative, invented names (no model — search of the private home).**
`tachyonInventedTurnClose_ZZ9`, `turn/checklist/updated`, `TodosInvented`,
`ChecklistTelemetry` are absent from every file under both private homes,
including sqlite bodies. Hits for the string `update_plan` in
`state_5.sqlite` / `thread_items` are the **user prompt text**, not a plan
store.

**Negative, behavioral (must stay mute).** A second TUI session: “Reply
with only the word PONG. Do not use any tools. Do not call `update_plan`.”
It replied `PONG`. Hooks seen: `SessionStart`, `UserPromptSubmit`, `Stop`.
Zero `PreToolUse` / `PostToolUse`. Rollout `task_complete` still arrived
for that `turn_id`. `logs_2.sqlite` had zero `turn/plan/updated` lines.

**Not the leftover home.** `.tachyon/harness/codex` (0.146.0 TUI,
`originator: codex-tui`) was listed only to learn file names. It already
had `task_started` / `task_complete` / `turn_aborted` with `turn_id`, and
no `update_plan` because those sessions never wrote a plan. It is
orientation, not this measurement.

## Method

Private `CODEX_HOME` under `/tmp/poc-tui-canal-codex-<ms>/codex-home`.
Auth is a symlink to `/home/goat/.codex/auth.json`, the same shape
`HarnessManager` uses. Isolated cwd. Directory trust written into
`config.toml` for the **exact** cwd (argv `-c` cannot grant trust —
`scripts/dogfood/runtime-remeasure.ts`). Spawn shape matches Tachyon's
overlay: TUI (no `exec`), `--dangerously-bypass-hook-trust`,
`-c hooks.Stop=…` plus extra dump hooks for `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse` so the stdin of each
event could be measured. Those extra events are **not** what Tachyon
injects today; they are the search, not a proposed spawn change.

The TUI ran in a **private** tmux server (`TMUX_TMPDIR` under the run
dir; `TMUX` / `TMUX_PANE` cleared) so this could not reach the fleet
socket (`t-9713ff`). First prompt rode `codex [OPTIONS] [PROMPT]`. No
bare Enter.

Human `~/.codex` `config.toml` / `auth.json` digests were unchanged
after both runs.

| Run | Clock (UTC) | `turn_id` | Wall | Plan? |
|---|---|---|---|---|
| induce `/tmp/poc-tui-canal-codex-1786902119308` | 17:42:00–17:42:07 | `01a00baa-876c-7ba3-9d81-4ee053a4c062` | 7067 ms | yes |
| trivial `/tmp/poc-tui-canal-codex-1786902180279` | 17:43:01–17:43:04 | `01a00bab-7564-79b0-885b-db0441571cdb` | 3078 ms | no |

Host weekly window on the induce rollout `token_count.rate_limits.primary`:
**66%** used, `resets_at` 1787226082. Two ChatGPT turns. This agent's
`$HOME` is remapped; `CODEX_HOME` was set explicitly (same trap as the
app-server PoC).

Reproduction:

```sh
node scripts/research/poc-tui-canal-codex.mjs --turns induce
node scripts/research/poc-tui-canal-codex.mjs --turns trivial
```

The `/tmp` homes are ephemeral. Payloads below are copied here.

## Measure 1 — induce (plan + close)

Stop stdin (unedited parsed object):

```json
{
  "session_id": "01a00baa-8671-7ae1-9d9d-b87709782468",
  "turn_id": "01a00baa-876c-7ba3-9d81-4ee053a4c062",
  "transcript_path": "/tmp/poc-tui-canal-codex-1786902119308/codex-home/sessions/2026/08/16/rollout-2026-08-16T14-42-00-01a00baa-8671-7ae1-9d9d-b87709782468.jsonl",
  "cwd": "/tmp/poc-tui-canal-codex-1786902119308/cwd",
  "hook_event_name": "Stop",
  "model": "gpt-5.6-sol",
  "permission_mode": "bypassPermissions",
  "stop_hook_active": false,
  "last_assistant_message": "PLANNED"
}
```

`UserPromptSubmit` opened the same `turn_id` 5.5 s earlier. `SessionStart`
has `session_id` and `transcript_path` and **no** `turn_id`.

Plan event on the hook stream, same `turn_id` (PostToolUse; PreToolUse
was the same `tool_input` without `tool_response`):

```json
{
  "hook_event_name": "PostToolUse",
  "turn_id": "01a00baa-876c-7ba3-9d81-4ee053a4c062",
  "tool_name": "update_plan",
  "tool_input": {
    "plan": [
      { "step": "Boil water", "status": "pending" },
      { "step": "Steep the tea", "status": "pending" },
      { "step": "Pour and serve", "status": "pending" }
    ]
  },
  "tool_response": "Plan updated",
  "tool_use_id": "exec-3d620a4e-7b3d-4261-b4ad-b70727f5de47"
}
```

Same turn on the rollout (the file Stop names as `transcript_path`):

| Clock (UTC) | Record |
|---|---|
| 17:42:00.304 | `event_msg.task_started` `turn_id=01a00baa-876c-7ba3-9d81-4ee053a4c062` |
| 17:42:01.782 | `turn_context.payload.turn_id` same |
| 17:42:05.224 | `response_item.custom_tool_call` `name: "exec"` `input` = `tools.update_plan({plan:[…]})` |
| 17:42:07.370 | `event_msg.task_complete` same `turn_id`, `last_agent_message: "PLANNED"`, `duration_ms: 7067` |

There is no rollout record whose `type` or `payload.type` is `plan` or
`turn/plan/updated`. Treating `payload.name === "update_plan"` as the
plan event would have missed this turn: the tool is filed as `exec`.

`thread_history_1.sqlite` `thread_turns` row for the same ids:
`status=completed`, `duration_ms=7067`. `thread_items` are
`userMessage`, `reasoning`, `agentMessage` only — no plan item.

`logs_2.sqlite` line (name only):
`app-server event: turn/plan/updated targeted_connections=1`.

## Measure 2 — trivial (close without a plan)

Stop stdin (unedited parsed object):

```json
{
  "session_id": "01a00bab-74ab-7183-bed0-534bba7c5a4d",
  "turn_id": "01a00bab-7564-79b0-885b-db0441571cdb",
  "transcript_path": "/tmp/poc-tui-canal-codex-1786902180279/codex-home/sessions/2026/08/16/rollout-2026-08-16T14-43-01-01a00bab-74ab-7183-bed0-534bba7c5a4d.jsonl",
  "cwd": "/tmp/poc-tui-canal-codex-1786902180279/cwd",
  "hook_event_name": "Stop",
  "model": "gpt-5.6-sol",
  "permission_mode": "bypassPermissions",
  "stop_hook_active": false,
  "last_assistant_message": "PONG"
}
```

Rollout `task_complete` for that `turn_id` at 17:43:04.301,
`duration_ms: 3078`, `last_agent_message: "PONG"`. No tool records.
`thread_turns.status=completed`. Zero `turn/plan/updated` log lines.

Absence of a plan on TUI is therefore the same conjunction as on
app-server: the turn ended, and no plan event arrived for that
`turn_id`. It is not a timeout.

## What a gate can and cannot say from the TUI

At the moment Stop fires for `turn_id` T (or `task_complete` is appended
for T):

- **This turn had a plan** if a `PreToolUse` / `PostToolUse` with
  `tool_name === "update_plan"` and `turn_id === T` was seen, or if the
  rollout for that T contains the wrapped `tools.update_plan` exec. The
  hook form is the complete list. The rollout form is a script string.
- **This turn finished without a plan** if none of those arrived. Mute,
  not `plan: []`.
- **This turn is still running** only while Stop / `task_complete` /
  `turn_aborted` has not arrived for T.

It cannot treat Stop as the plan channel. It cannot treat
`logs_2.sqlite` `turn/plan/updated` as the plan channel (no payload).
It cannot treat `thread_items` as the plan channel (the induce plan
never became an item). It cannot treat `state_5.sqlite` `threads` as
the plan channel (`update_plan` there is the prompt text). It cannot
infer “no plan” from `task_complete.last_agent_message` — both turns
were a single word.

The product already tails the rollout (`createCodexNormalizer`). It
already injects Stop. It does not persist Stop's `turn_id`, and it
does not classify the wrapped `exec`/`update_plan` call as a plan
event. Those are reader decisions, not missing runtime doors.

## What is not a channel (looked at, empty or name-only)

| Surface | Why it is not the conjunction |
|---|---|
| `logs_2.sqlite` | Event **names** (`turn/started`, `turn/plan/updated`, `hook/started`). No `turnId`, no `plan[]`. |
| `state_5.sqlite` `threads` | Thread metadata. `update_plan` hit is the user prompt. |
| `goals_1.sqlite` `thread_goals` | 0 rows. Different object (token-budget goals). |
| `queue_1.sqlite` | 0 queued items. |
| `memories_1.sqlite` | 0 rows. |
| `thread_history_1.sqlite` `thread_turns` | Closes the window (`status=completed`). No plan. |
| `thread_history_1.sqlite` `thread_items` | `userMessage` / `reasoning` / `agentMessage`. The induce plan is absent. |
| Stop stdin | Closes the window. No plan field. |

The grok-shaped miss here is not a third file nobody tailed. It is a
**field on the hook Tachyon already runs**, plus a wrapped tool call in
the rollout it already tails.

## Gotchas (measured)

1. **Codex `update_plan` is filed as `exec` on the TUI rollout.**
   `payload.name` is `"exec"`; the plan is inside `payload.input` as
   `await tools.update_plan({plan:[…]})`. The hook side is honest:
   `tool_name: "update_plan"`. A reader that only matches the tool name
   on the rollout will call a planned turn `sem-plano`.
2. **The product Stop recorder discards `turn_id`.** Measured stdin has
   it; `persistence-stop.jsonl` rows for historical Codex agents do not.
   Those six leftover rows are not evidence that the runtime omitted the
   field.
3. **`codex exec` still does not fire Stop** (already measured 2026-08-15
   in SDD 508 notes). This measurement is TUI. Do not re-use an exec
   canary as the Stop channel.
4. **This agent's `$HOME` is remapped.** A child `codex` without
   `CODEX_HOME` pointing at a home that has the real `auth.json` 401s.
   Same trap as the app-server PoC.
5. **Private tmux only.** Spreading `process.env` keeps `TMUX` and
   talks to the fleet server (`t-9713ff`).
6. **Internal app-server is not a readable TUI channel.** The TUI
   process logs `codex_app_server::outgoing_message` for
   `turn/started` and `turn/plan/updated`, but the log line is a
   counter, not the notification. Subscribing to app-server is a
   different spawn, and changing spawn is out of scope here.

## Out of scope (held)

No production reader. No extra `-c hooks.PreToolUse=` on Tachyon spawn.
No change to `PERSISTENCE_STOP_RECORDER_SOURCE`. No claim that fatia 4
must use Stop versus the rollout — both doors exist; picking one is the
owner's. App-server remains the cleaner payload (`turn/plan/updated`
with `plan[]`); it is no longer the only payload.
