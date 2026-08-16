# PoC plano interno — grok 1.0.4: ausência, `plan.json` e `TodosUpdated`

**Task:** `t-339e47` (fatia de `t-07ba11`)
**Measured:** 2026-08-16
**Runtime:** grok 1.0.4 (`d846eb93d9`) `[stable]`
**Cost:** live authenticated model calls (headless `--single` + this Tachyon TUI session)
**Product code changed:** none

`measured` here means a real authenticated session, with version and date, positive and
negative controls, and capture taken **while the process was alive**. A post-dismiss
read of a Grok session is not evidence (`t-23ee99`).

## Verdict

| Question | Answer |
|---|---|
| Is plan **absence** detectable on grok 1.0.4? | **Yes, after the turn ends.** Not mid-turn. |
| Signal | `_x.ai/session/update` / `sessionUpdate: "turn_completed"` (also `events.jsonl` `turn_ended`, and headless `streaming-json` `type:"end"`) **and** that turn has no `sessionUpdate:"plan"` and no `TodosUpdated`. |
| Does `plan.json` exist from session start? | **No.** |
| Does `plan.json` appear when the first todo is written? | **No.** It stayed absent across every measured `todo_write`, including a 50 ms poll on this live TUI session. Treating a missing `plan.json` as “no plan” is a **false negative**. |
| First plan event latency | **2373 ms** and **3086 ms** after `turnStartMs` on two induced `--single` turns. |
| Trivial turn emits a plan anyway? | **No.** |
| Empty list vs mute vs missing file | Three different things. See below. |

The deciding question from `t-07ba11` measure 3: when a turn ends **without** a plan, is
there a signal, or only silence? **There is a signal.** `turn_completed` / `turn_ended` /
`type:"end"` fire whether or not a plan was written. A gate that waits for that event
and then inspects the turn window does not have to guess via timeout. A gate that
watches only while the turn is still running still sees silence, and silence is not
absence — this TUI turn ran ~7 minutes with no plan, then wrote one.

No reader was wired. Tachyon's Activity path still tails `chat_history.jsonl`, not
`updates.jsonl` / `resources_state.json` (`docs/research/runtime-internal-checklist-capabilities.md`).

## Controls (declared before the probes)

**Positive.** A turn instructed to call `todo_write` must emit, while still alive:

- `todo_write` tool call
- `rawOutput.type == "Todo"` with `TodosUpdated`
- `sessionUpdate: "plan"` (and headless `type:"plan"`)
- the canary token (`PLAN_OK` / `LIVE2_PLAN`)

That happened on `m1-induce`, `live2/induce`, and this TUI session.

**Negative.** Invented names `TodosInvented` and `ChecklistTelemetry` must not appear as
`sessionUpdate` values or as stdout `type`s. They did not, in any probe `updates.jsonl`.
String hits inside *this* TUI transcript are contamination from the probe source that
named them — not runtime events.

**Channel-alive.** A trivial no-tool turn must still emit `turn_completed` / `type:"end"`.
If it did not, a mute plan channel would be indistinguishable from a dead session. It
did emit. That is the control four earlier probes in this repo burned by skipping.

**Orientation, not evidence.** Leftover `t-a68138` sessions under `~/.grok/sessions/%2Ftmp/`
were listed only to learn file names. One interactive leftover had `plan.json` =
`{"todos":{}}` plus `plan_mode.json`, and **never** emitted `sessionUpdate:"plan"`. That
file is compact / plan-mode residue, not the `todo_write` store. It is not this PoC's
measurement.

## Three measures

### 1 — Task that induces a plan

Headless, authenticated, `--output-format streaming-json`, `--permission-mode dontAsk`,
`--no-subagents`, `--disable-web-search`, isolated `/tmp` cwd, caller-minted `--session-id`.

Prompt required `todo_write` of three (then two) pending items, then a canary token.

| Run | Wall | First `sessionUpdate:"plan"` after `turnStartMs` | `turn_completed` after `turnStartMs` | `plan.json` |
|---|---|---|---|---|
| `m1-induce` 15:36:46Z | 4579 ms | **2373 ms** (`agentTimestampMs` 1786894609040 − 1786894606667) | 3855 ms, `stop_reason: end_turn` | absent |
| `live2/induce` 15:40:38Z | 6131 ms | **3086 ms** (1786894841886 − 1786894838800) | 4219 ms, `end_turn` | absent |

Exact first plan event (`m1-induce`):

```json
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "plan",
      "entries": [
        {"content": "step one", "priority": "medium", "status": "pending"},
        {"content": "step two", "priority": "medium", "status": "pending"},
        {"content": "step three", "priority": "medium", "status": "pending"}
      ],
      "_meta": {
        "updateType": "Plan",
        "updateParams": {"planSteps": 3}
      }
    }
  }
}
```

The tool result that preceded it by 1 ms of `agentTimestampMs`:

```json
{
  "sessionUpdate": "tool_call_update",
  "status": "completed",
  "rawOutput": {
    "type": "Todo",
    "TodosUpdated": {
      "summary_for_prompt": "- [pending] alpha: step one\n- [pending] beta: step two\n- [pending] gamma: step three\n",
      "todos": [
        {"content": "step one", "priority": "medium", "status": "pending"},
        {"content": "step two", "priority": "medium", "status": "pending"},
        {"content": "step three", "priority": "medium", "status": "pending"}
      ],
      "state": {
        "todos": {
          "alpha": {"content": "step one", "priority": "medium", "status": "pending"},
          "beta": {"content": "step two", "priority": "medium", "status": "pending"},
          "gamma": {"content": "step three", "priority": "medium", "status": "pending"}
        }
      }
    }
  }
}
```

Headless stdout emits the same snapshot as `{"type":"plan","entries":[...]}` and ends
with `{"type":"end","stopReason":"end_turn",...}`. `events.jsonl` records
`tool_started` / `tool_completed` for `todo_write` and a final `turn_ended`. It does
not carry the plan body.

`todo_write` input shape on this version: `{ "todos": [{id, content, status}], "merge": false }`.
Replace is `todos: []` + `merge: false`.

### 2 — Trivial task

Prompt: output only `TRIVIAL_OK` / `LIVE2_TRIVIAL`. Do not call tools. Do not create a
task list.

| Run | Wall | `sessionUpdate:"plan"` | `TodosUpdated` | `type:"end"` / `turn_completed` | `plan.json` | `resources_state.json` |
|---|---|---|---|---|---|---|
| `m2-trivial` | 2635 ms | none | none | yes, `end_turn` (1779 ms after `user_message_chunk`) | absent | absent |
| `m3-noplan` | 2290 ms | none | none | yes, `end_turn` (1518 ms) | absent | absent |
| `live2/trivial` | 3695 ms | none | none | yes, `end_turn` (2078 ms) | absent | absent |

The runtime does **not** emit a plan for a trivial turn. The end-of-turn event still
fires. That pair is the absence signal.

### 3 — Whole turn without a plan (the one that decides)

`m2` / `m3` / `live2/trivial` are completed turns with no plan events. The correlation
is:

```
turn_completed.stop_reason == "end_turn"
AND no sessionUpdate:"plan" with that turn's turnStartMs / promptId
AND no TodosUpdated in that window
```

That is an assertion, not a timeout.

Mid-turn is the opposite. This Tachyon-managed TUI session
(`55b7dc65-7de2-48ad-bd85-977b5521063a` under `$GROK_HOME/sessions`) had, at
15:38:28Z, after several minutes of tool use and **before** any `todo_write`:

- `plan.json` absent
- `sessionUpdate:"plan"` count **0**
- no `turn_completed` yet (the spawn brief is still this turn)

Then `todo_write` ran at `agentTimestampMs` 1786894758040 and `sessionUpdate:"plan"`
arrived at 1786894758041. A watcher polling every 50 ms never saw `plan.json`. So a
live TUI turn can go from “no plan yet” to “plan exists” without a file ever appearing,
and without `turn_completed`. Waiting N seconds mid-turn and declaring absence would
have been wrong.

## `plan.json` birth — the question that changes absence detection

Documented layout (`~/.grok/docs/user-guide/17-sessions.md`) still lists
`plan.json` as “TODO/task list state”. On 1.0.4 that file is **not** the live store
for `todo_write`.

Live 20 ms watch on `live2/induce` (correct `$GROK_HOME/sessions`, not `~/.grok`):

| elapsed | first seen |
|---|---|
| 243 ms | `summary.json` |
| 283 ms | `events.jsonl` |
| 1849 ms | `updates.jsonl` |
| 3780 ms | `resources_state.json`, **already** `{one, two}` |
| never | `plan.json` |

The same absence held on four earlier `--single` sessions and on this TUI session
before, during, and after `todo_write`. Sessions **persisted** after `--single` exit
in this private `GROK_HOME`, so “absent after” is not the dismiss-wipe trap. The
50 ms TUI poll also rules out create-then-delete during the write.

### Where the list actually lives

`resources_state.json` → `state["grok_build.Todo"].todos`.

- Trivial `--single`: file **absent** (not empty).
- First `todo_write`: file is **born** with the non-empty map. It is not created empty
  at session start.
- Replace with `todos: []`: file remains, value becomes `{"todos": {}}`.

That is the on-disk snapshot. The authoritative **event** is still
`updates.jsonl` `sessionUpdate:"plan"` (and the `TodosUpdated` tool result).

`plan.md` / `plan_mode.json` are Plan Mode, a different door. Not measured here
beyond noting they were absent from every `todo_write` session.

## Empty list vs absent file vs mute channel

Measured, not inferred:

| State | `plan.json` | `resources_state.json` `grok_build.Todo` | `sessionUpdate:"plan"` | `TodosUpdated` | `turn_completed` |
|---|---|---|---|---|---|
| Mute (trivial turn) | absent | file absent | never | never | yes |
| Non-empty plan | absent | `{id: {content, status, priority}, ...}` | `entries: [...]`, `planSteps: N` | `todos: [...]` | yes (when the turn ends) |
| Empty list (after replace) | absent | `{ "todos": {} }` | `entries: []`, `planSteps: 0` | `todos: []`, summary `"No tasks currently tracked."` | yes (when the turn ends) |

Kandev / synara discarding an empty list is the right instinct: **empty list is a
write**. Mute is the lack of a write. Missing `plan.json` is the default on this
version and must not be folded into either.

Headless stdout matches: mute has no `type:"plan"`; empty list emits
`{"type":"plan","entries":[]}`.

## Store path

Session files are `$GROK_HOME/sessions/<urlencoded-cwd>/<session-id>/`.
`GROK_HOME` defaults to `~/.grok` for a stock CLI. A Tachyon-managed grok agent
uses the private home (`$TACHYON` bridge-mcp `<agent>.grok`). The first probe
batch watched `~/.grok/sessions` and saw nothing; the sessions were in the
private home the whole time. That miss is why this report does not treat a
wrong-path empty as absence.

`--single` in this home left the session directory in place after exit. The
`t-23ee99` wipe is a Tachyon **dismiss** fact, not a `--single` fact. Capture was
still live, as required.

## What a gate can and cannot do

**Can**, on grok 1.0.4, without a timeout:

1. Tail `$GROK_HOME/sessions/<cwd>/<id>/updates.jsonl` (or headless `streaming-json`).
2. Wait for `turn_completed` / `type:"end"` / `events.jsonl` `turn_ended`.
3. If that turn's `promptId` / `turnStartMs` window has no `sessionUpdate:"plan"`
   and no `TodosUpdated`, assert **this turn ended without a plan**.
4. If it has `sessionUpdate:"plan"` with `entries: []`, assert **empty list**
   (agent cleared or wrote nothing), which is not mute.

**Cannot:**

- Treat missing `plan.json` as “no plan”.
- Treat mid-turn silence as “no plan will arrive”.
- Treat `events.jsonl` alone as a plan channel (it names `todo_write` but not the
  list).
- Infer anything from a session read after Tachyon dismiss.

Negative result that is still a result: **`plan.json` is not a usable absence
signal on 1.0.4.** The usable signal is the turn-end event plus a mute plan
channel.

## Reproduction

```text
grok --version    # grok 1.0.4 (d846eb93d9) [stable]
# Disposable probes lived in /tmp/t-339e47-grok-plan/ (not committed).
# Headless shape:
grok --single '<prompt>' --session-id <uuid> --cwd <isolated> \
  --permission-mode dontAsk --no-subagents --disable-web-search \
  --no-auto-update --output-format streaming-json
# Watch $GROK_HOME/sessions/<urlencoded-cwd>/<uuid>/ at ≤50 ms, copy on first seen.
```

No `src/`, `packages/`, or `test/` changes. No production reader.
