# Plano interno fatia 2 — como cada runtime delimita a janela do turno

**Task:** `t-011136` · **Measured:** 2026-08-16 (PoCs) · **Product:**
`packages/engine/src/runtime/{claude,codex,grok}InternalPlanTurn.ts`

The readers (fatia 1) project a plan snapshot. This fatia answers a different
question: **this turn ended with a plan, without one, or without a channel.**
There is no "plan absent" event. The verdict is the conjunction *turn ended*
and *plan event in that window* (or not). Silence mid-turn is not absence.

Verdicts live in `internalPlanTurn.ts`, not in `internalPlan.ts`.

## Shared rule

A verdict is emitted only after a **successful** turn-end.

| Judgment | When |
|---|---|
| `pending` / `turn-open` | The window is still open. Evaluating now would be wrong. |
| `pending` / `turn-not-completed` | The turn ended as a failure (auth, interrupt). Not `sem-plano`. |
| `com-plano` | At least one plan event in the window. |
| `sem-plano` | Successful end, channel existed, nothing came. |
| `sem-canal` | Successful end, the runtime could not write a plan (or we were not on the plan channel). |

Priority after a closed window: a seen plan event wins (`com-plano`) even if
inventory said the channel was absent. Then failure ≠ `sem-plano`. Then
channel absence is `sem-canal`, not mute.

## Claude — hook + stream

**Identity:** the stretch from `UserPromptSubmit` to the next `Stop` /
`StopFailure` / print-mode `result`.

| Edge | Signal |
|---|---|
| Start | hook `UserPromptSubmit` |
| Success | hook `Stop`, or stream `type: result` with `stop_reason: end_turn` / `terminal_reason: completed` |
| Failure | hook `StopFailure` (auth emits this, **not** `Stop`), or `result` with `is_error` / `terminal_reason: api_error` |
| Plan event | `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, hook `TaskCreated` |
| Not a plan | subagent `Task` / `TaskOutput` / `TaskStop` |
| Channel | any of those plan tools in `init.tools`. Opus 5 has none unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (fatia 1 sets this at launch). |

Treating `StopFailure` as `Stop` counts a dead turn as `sem-plano`. The store
under `~/.claude/tasks/<session>/` is session-scoped — it cannot close this
window. Correlation is reliable on the hook stream (the portable door for a
PTY agent). Print-mode `result` is the same end, a different envelope.

If a Claude agent born after fatia 1 measures `sem-canal`, that is a finding,
not the normal case.

## Codex — `turnId` on the app-server stream

**Identity:** `params.turnId` / `params.turn.id`.

| Edge | Signal |
|---|---|
| Start | `turn/started` |
| Success | `turn/completed` with `turn.status === "completed"` |
| Failure | `turn.status` `failed` or `interrupted` (401-before-model is `failed`) |
| Plan event | `turn/plan/updated` with the same `turnId` |
| Not a plan | `item/plan/delta` (EXPERIMENTAL, did not fire); `turn.completed.items` (summary) |
| Channel | `turn/plan/updated` is in the 0.147.0 `ServerNotification` enum. `sem-canal` needs positive evidence the session's protocol omits it. |

A previous turn's plan is not restated. Turn 2 mute is `sem-plano` for turn 2
even if turn 1 planned.

**TUI (what Tachyon actually runs), measured 2026-08-16 on `codex-cli
0.147.0` (`docs/research/poc-plano-interno-codex-tui.md`):** `hooks.Stop`
stdin **does** carry `turn_id`. It does **not** carry the plan. Window
close is Stop `turn_id` (or rollout `event_msg.task_complete` /
`turn_aborted`, or `thread_history_1.sqlite` `thread_turns.status`). Plan
event on the same `turn_id` is `PreToolUse` / `PostToolUse`
`tool_name: "update_plan"`, or a wrapped `custom_tool_call` `name: "exec"`
whose input is `tools.update_plan({plan:[…]})` in the rollout Activity
already tails. The product Stop recorder currently keeps only
`session_id` / `cwd` and drops `turn_id`. Fatia 4 does not have to move
Codex agents onto app-server to compute the verdict; picking the door is
the owner's.

## Grok — `promptId` / `turnStartMs` on live `updates.jsonl`

**Identity:** `_meta.promptId` + `_meta.turnStartMs` (and
`turn_completed.prompt_id`).

| Edge | Signal |
|---|---|
| Start | `sessionUpdate: "user_message_chunk"`, or the first event with a new `promptId` / `turnStartMs` |
| Success | `sessionUpdate: "turn_completed"` with `stop_reason: end_turn`. Also headless `type: "end"`. |
| Also an end, not the plan channel | `events.jsonl` `turn_ended` |
| Plan event | `sessionUpdate: "plan"`, `TodosUpdated`, `todo_write` |
| Not a plan | `plan.json` (absent on 1.0.4 for `todo_write`); `events.jsonl` alone |
| Channel | live `updates.jsonl`. A turn-end seen only on `events.jsonl` is `sem-canal`. |

A measured TUI turn ran ~7 minutes with no plan and then wrote one. Mid-turn
silence is `turn-open`. Capture has to be live: Tachyon dismiss wipes the
session directory (`t-23ee99`). A missing session is `turn-open`, not
`sem-plano`.

On 1.0.4 `todo_write` is in-protocol. A live `sem-canal` is the wrong-door
case (watching `events.jsonl` / `plan.json` instead of `updates.jsonl`), not
a missing flag.

## What this does not decide

Reprompt, which `kind`s require a plan, and UI are fatia 4 / fatia 3. This
fatia only emits the three verdicts once the runtime has closed its window.
