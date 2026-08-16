# PoC plano interno — Claude Code 2.1.233

**Task:** `t-b3dd69` (fatia de `t-07ba11`) · **Measured:** 2026-08-16 · **Runtime:** Claude Code 2.1.233 · **Default model this install:** `claude-opus-5[1m]` · **Auth:** real `claude.ai` Max session (`claude auth status` → `loggedIn: true`) · **No product wiring.**

Method follows `docs/research/t-a68138-system-prompt-compact.md`: authenticated session, version and date, positive and negative controls. Channels named as Synara already reads them (`docs/research/competitor-internal-checklist-lote-d.md`).

## Verdict

Absence of a plan **is detectable** on Claude 2.1.233. There is no `plan_absent` event. The signal is a correlatable **end of turn** plus **no plan-shaped event on that turn**.

| Question | Answer |
|---|---|
| Is absence detectable? | **Yes.** Hook `Stop` (every successful turn) and, on `-p --output-format stream-json`, `type: result` with `stop_reason: end_turn` / `terminal_reason: completed`. Auth failure emits `StopFailure` instead of `Stop`. |
| Dedicated "no plan" event? | **No.** Invented names `PlanAbsent`, `ChecklistTelemetry`, `TodoInvented`, `TaskInvented`, `RequirePlanGate`, `plan_absent` are absent from the 2.1.233 ELF (count 0) and from every probe stream and hook log. |
| Empty list vs mute? | **Different.** Mute = `Stop` and no plan tool/hook. Empty list = the channel *spoke* with an empty payload (`TodoWrite` `{todos:[]}` → `{oldTodos:[], newTodos:[]}`; `TaskList` → `{tasks:[]}`). |
| Default channel on a common task? | **Neither.** On this install's default model the plan tools are **not in `init.tools`**. With them opted in, two multi-step file tasks still used only `Write` and ended on `Stop` with no plan event. |
| Both channels at once? | **No.** Mutually exclusive at inventory time. `CLAUDE_CODE_ENABLE_TASKS=0` yields `TodoWrite` and filters `Task*`. Default (unset) plus `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` yields `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` and filters `TodoWrite`. `--tools` listing both does not override the filter. |
| First plan event latency | **A `TodoWrite`:** 4.364 s from `UserPromptSubmit` hook to the `tool_use` (stream `timestamp`). **B `TaskCreate`:** 5.803 s. Both after a preceding `ToolSearch select:…` (deferred tools). Version 2.1.233, 2026-08-16. |

The deciding question from `t-07ba11` measure 3: a turn that ends without a plan is **not silence**. `Stop` fires whether or not a plan appeared. A gate that waits for a plan can close on `Stop` (or the `-p` `result`) instead of timing out. That is a detection fact, not a product recommendation.

## Controls

**Positive (must appear when the channel is forced):**

- Canary `PLAN_A_7KQ2M9` only via `TodoWrite` (`CLAUDE_CODE_ENABLE_TASKS=0` + `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`). Returned in `tool_use.input.todos[].content` and in `PostToolUse.tool_response.newTodos`. Reply token `TODOWRITE_POS_OK`.
- Canary `PLAN_B_4VJ8P2` only via `TaskCreate` (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_ENABLE_TASKS` unset). Item ids `"1"` / `"2"` in the `tool_result`, hook `TaskCreated` (`task_id`, `task_subject`, `task_description`), and store `~/.claude/tasks/<session>/1.json` + `2.json`. Reply token `TASKCREATE_POS_OK`.

**Negative (must not appear):**

- Invented identifiers above: ELF count 0; `rg` over every probe `stdout.jsonl` and `hooks.jsonl` empty.
- Cross-channel: the `TodoWrite` session produced no `TaskCreated` and no `~/.claude/tasks/<that-session>/`. The `TaskCreate` session produced no `TodoWrite` `tool_use`.
- Mute sessions (01, 02, 06, 06b) produced `Stop` + `result` and zero plan-shaped events. Canaries from other probes do not leak into them.

**Declared, not a plan event:** `Task` / `TaskOutput` / `TaskStop` in `init.tools` are the subagent family, not the checklist. Probe 01 lists them and still has no plan channel.

## Inventory (what the model can even call)

`system.subtype=init.tools` on `-p --output-format stream-json --verbose`, model `claude-opus-5[1m]`, Claude Code 2.1.233.

| Env | `--tools` | `TodoWrite` | `TaskCreate` family |
|---|---|---|---|
| (none) | default | **absent** | **absent** |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | default | absent | **present** |
| `CLAUDE_CODE_ENABLE_TASKS=0` + `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | default | **present** | absent |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | both names listed | **absent** (filtered) | present |
| `CLAUDE_CODE_ENABLE_TASKS=0` + `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | both names listed | present | **absent** (filtered) |

This matches vendor docs: on Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 and later families the task-tracking tools are off unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; on other models `TodoWrite` is only for `CLAUDE_CODE_ENABLE_TASKS=0`. Opus 5 is in that later set. Without the opt-in, **both channels are mute because they do not exist**, which is stronger than "the model chose not to write a plan."

When present, the tools are still **deferred**: the model called `ToolSearch` with `query: "select:TodoWrite"` / `"select:TaskCreate"` / `"select:TaskList"` first (`total_deferred_tools` 16 or 19). The first *plan* event is the later `TodoWrite` / `TaskCreate` / `TaskList`, not `ToolSearch`.

## Channel A — `TodoWrite`

Input measured: `{ todos: [{ content, status, activeForm }] }`. `PostToolUse.tool_response` is `{ oldTodos, newTodos }` with the same item shape. No item id. No `owner`. No `blocks` / `blockedBy`. No `TaskCreated` hook. No `~/.claude/tasks/<session>/`.

Observation doors that fired:

- stream `assistant` → `tool_use` name `TodoWrite`
- `--include-hook-events` → `hook_started` / `hook_response` for `PreToolUse:TodoWrite` and `PostToolUse:TodoWrite`
- command hook `PreToolUse` / `PostToolUse` (matcher `TodoWrite\|TaskCreate\|…`)

Empty list (probe 05): `input.todos = []`, `tool_response = {oldTodos:[], newTodos:[]}`, same success string as a non-empty write. That is a **spoken empty snapshot**, not mute.

## Channel B — `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`

The only of the three runtimes that carries item identity and dependency. Measured:

- `TaskCreate` input `{ subject, description, activeForm }`. Id is **not** in the input. `tool_result` / `tool_use_result`: `{ task: { id: "1", subject: "…" } }`. Hook `TaskCreated` with `task_id`, `task_subject`, `task_description`.
- `TaskUpdate` input `{ taskId: "2", addBlockedBy: ["1"] }` → `{ success: true, taskId: "2", updatedFields: ["blockedBy"] }`. No `TaskCreated` (and no `TaskUpdated` hook). `PreToolUse` / `PostToolUse` only.
- `TaskList` on a fresh session: `{ tasks: [] }`. Does **not** create `~/.claude/tasks/<session>/`.

Store after two creates + one dependency update, session `11111111-b3dd-4969-a001-000000000041`:

```text
~/.claude/tasks/11111111-b3dd-4969-a001-000000000041/
  .lock          (0 bytes)
  1.json
  2.json
```

`1.json` (verbatim):

```json
{
  "id": "1",
  "subject": "PLAN_B_4VJ8P2 root",
  "description": "root item",
  "activeForm": "doing root",
  "status": "pending",
  "blocks": ["2"],
  "blockedBy": []
}
```

`2.json` has `blockedBy: ["1"]` and `blocks: []`. The `addBlockedBy` write is bidirectional in the store. `owner` was not set and is absent from the files. No high-water file was created; numbering is the item id.

ACP flatteners that drop `id` / `blockedBy` (Synara's `claudeTrackedTasksPayload`) lose exactly this. The store and `TaskCreated` still have it.

## The three measures

### 1. Task that induces a plan

Forced positives (canaries above) prove each channel's format and first-event latency.

Spontaneous use on a common task: **not observed.**

- Probe 02, default inventory: four `Write` attempts + `Bash`. No plan tools in `init.tools`. `Stop` at end. (`dontAsk` denied the writes; the plan question does not depend on the write succeeding.)
- Probe 06, Task tools opted in, `--effort low`, four files: four `Write`, files landed, `INDUCE_TASKS_OK`. No `TaskCreate`. No store. `Stop`.
- Probe 06b, Task tools opted in, default effort, prompt said "Track your work", three files: three `Write`, `INDUCE_TRACK_OK`. No `TaskCreate`. No store. `Stop`.

Vendor text says Claude "creates todos for most multi-step work" of three or more actions. These two opted-in multi-step turns did not. Result: **do not treat "tools are present" as "a plan will arrive."** Absence detection still holds — the turn ended on `Stop` without a plan event.

### 2. Trivial task

Probe 01: "Reply with only `ABSENCE_CANARY_7KQ2`. Do not call any tools."

- `init.tools` has no `TodoWrite` / `TaskCreate` family.
- Assistant text: `ABSENCE_CANARY_7KQ2`. No `tool_use`.
- Hooks: `SessionStart` → `UserPromptSubmit` → `Stop` → `SessionEnd`.
- `result`: `stop_reason=end_turn`, `terminal_reason=completed`, `duration_ms=1995`, `ttft_ms=1883`.
- `~/.claude/tasks/` did not exist yet.

The runtime does **not** emit a plan on a one-token reply.

### 3. Whole turn without a plan — the deciding signal

Every successful probe, with or without a plan, ended with:

1. stream `system` / `hook_started` / `hook_event: Stop`
2. command hook `Stop` (stdin JSON includes `last_assistant_message`)
3. stream `type: result`, `subtype: success`, `stop_reason: end_turn`, `terminal_reason: completed`

The failed-auth probe (wrong `HOME`, before the real-home rerun) ended with `StopFailure` (`error: authentication_failed`) and a `result` with `is_error: true`, `terminal_reason: api_error`. That is still an end-of-turn signal, not a hang.

There is no third event that means "this turn had no plan." Detection is:

```text
end_of_turn ∈ {Stop, StopFailure, result}
AND no TodoWrite / TaskCreate / TaskUpdate / TaskCreated on that turn
```

`TaskList` with `{tasks:[]}` and `TodoWrite` with `todos:[]` are **not** this case. They are empty snapshots. Synara already drops empty lists (`nonEmptyRuntimeTaskListPayload`); that is the right split.

`-p` `result` is print-mode. Tachyon's live agents are PTY. `Stop` is documented as once-per-turn on every Claude Code surface (terminal, IDE, desktop, web) and was measured here under `-p`. PTY was not re-driven in this PoC; the portable door is the hook, not the print envelope.

## Latency

Clock: hook `ts` is the probe logger's `date -u` when the hook script ran. Stream `timestamp` is Claude's event time. Deltas below use `UserPromptSubmit` hook `ts` → first plan `tool_use` stream `timestamp` (same second-resolution wall, sub-second from different clocks — treat as ±50 ms).

| Probe | Channel | `UserPromptSubmit` → first plan `tool_use` | Preceding `ToolSearch` | Turn `duration_ms` |
|---|---|---|---|---|
| 03 | A `TodoWrite` | **4.364 s** (20.109 → 24.473) | 2.140 s | 5801 |
| 04 | B `TaskCreate` | **5.803 s** (58.130 → 03.933) | 3.040 s | 16565 |
| 05 | A empty `todos:[]` | 3.857 s | 2.388 s | 5745 |
| 05b | B empty `TaskList` | 3.479 s (`TaskList`, not create) | 2.190 s | 4832 |
| 01 | mute trivial | no plan event; `Stop` 1.875 s after `UserPromptSubmit` | — | 1995 |

First `TaskCreated` follows the first `TaskCreate` `tool_use` immediately (stream order: `tool_use` → `PreToolUse` → `TaskCreated` → `PostToolUse`).

## How the probes were run

Isolated cwd `/tmp/t-b3dd69-claude-poc/scratch`. Extra `--settings` registered command hooks for `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, and `PreToolUse`/`PostToolUse`/`PostToolUseFailure` matching the five plan tool names. `--include-hook-events --output-format stream-json --verbose --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --no-chrome --session-id <uuid>`.

This agent pane remaps `HOME` to `GROK_HOME`, which has no Claude login. Probes ran with `HOME=/home/goat` so they used the existing login. Credentials were not copied. `--permission-mode` was `dontAsk` on 01–02 (writes denied) and `bypassPermissions` after that (scratch is `/tmp`). Probes 01–06 used `--effort low` except 06b (default effort).

Disposable runner and streams lived under `/tmp/t-b3dd69-claude-poc/` and are not product. Session ids used the prefix `11111111-b3dd-4969-a001-`.

## Out of scope (kept)

No reader. No gate. No UI. Compaction survival, fork copy of `~/.claude/tasks/`, and a PTY-only Stop remeasure were not in this fatia.

## Reproduction (inventory + mute, no canary)

```sh
claude --version    # 2.1.233 (Claude Code)
HOME="$HOME" claude -p --output-format stream-json --verbose --include-hook-events \
  --permission-mode bypassPermissions --no-chrome --disable-slash-commands \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  'Reply with only the token ABSENCE_CANARY_7KQ2. Do not call any tools.'
# init.tools on opus-5[1m] contains neither TodoWrite nor TaskCreate.
# Stream ends with hook Stop then type=result stop_reason=end_turn.
```
