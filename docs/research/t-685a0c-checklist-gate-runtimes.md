# t-685a0c — the required-plan gate, measured live on all three runtimes

**Measured:** 2026-08-18 (America/Sao_Paulo)
**Runtimes:** claude 2.1.234, codex-cli 0.147.0, grok 1.0.5 (`5115b46bc9`)
**Cost:** live authenticated model calls (four headless turns) plus two grok probe turns
**Product code changed:** `packages/engine/src/runtime/checklistGateHook.ts` (new),
`Workspace.projectedSessionHooks`, `sessionInspection` hook-purpose list

`measured` here means a real authenticated session, with version and date, positive and negative
controls, and capture taken while the process was alive.

## What was being decided

`settings.checklist.requireIn` shipped as a setting that promised agents would be required to write a
plan, and `t-cb684f` measured that it reached nothing: the only consumer needed a `judgment.verdict ===
"absent"`, which needs a `persistence-stop.jsonl` row, which only a DECLARED agent writes — 1,461 rows,
zero from a Temporary agent. This card replaces the promise with a `PreToolUse` gate on the per-spawn
channel Tachyon already owns for each runtime.

Lock 6 of the card asked one question before any grok code was written: **does grok already write a
plan before it mutates?** If it always did, a grok hook would be pure cost.

## Probe 1 — does grok plan on its own? (lock 6)

Two headless turns, `grok -p … --yolo --output-format streaming-json`, in a scratch cwd holding one
two-line file, same model, same prompt shape.

| probe | prompt | plan events | mutating tool | file changed |
|---|---|---:|---|---|
| A (the question) | "Edit notes.txt: change beta to gamma. Then stop." | **0** | `search_replace` after `grep`/`read_file` | yes |
| B (positive control) | same edit, *plus* "first call todo_write to record a two-step plan" | **2** `plan` + 2 `TodosUpdated` | `search_replace` | yes |

Probe A emitted no `sessionUpdate: "plan"` and no `TodosUpdated`, in either the stream or the session's
`updates.jsonl`. Probe B emitted both, so the channel was alive and the absence in A is a measurement
rather than a dead capture. **Grok does not always plan before mutating; the hook is not pure cost.**

This agrees with `docs/research/poc-plano-interno-grok.md` (grok 1.0.4, 2026-08-16), which found a TUI
turn that ran ~7 minutes with no plan and wrote one only at the end, and "trivial turn emits a plan
anyway? No."

## Probe 2 — the gate itself, live, on each runtime

Each run is a scratch cwd with a two-line `notes.txt`, a materialized `checklist-gate.cjs`, and the hook
block the production planner emits for `requireIn: [feature]` / kind `feature`. **No
`docs/project-guidance.md` anywhere** — that file is this repository's convention and does not ship, and
mistaking it for the mechanism is the framing error this card corrects.

| runtime | channel | first change | what the agent did next | file |
|---|---|---|---|---|
| grok 1.0.5 | `$GROK_HOME/hooks/projected.json` | `search_replace` → `status: "failed"`, `Hook denied: [tachyon] settings.checklist requires a written plan … Call todo_write to write it.` | called `todo_write`, retried the SAME edit → completed | changed, after the plan |
| codex 0.147.0 | `-c hooks.PreToolUse=[…]` + `--dangerously-bypass-hook-trust` | refused; the agent reported *"the workspace hook requires `update_plan`, which you explicitly prohibited"* | it had been told not to plan, so it stopped | **unchanged** |
| claude 2.1.234 | `--settings` | `Bash` denied (`permission_denials` in the result JSON) | filed a task with `TaskCreate`, then edited | changed, after the plan |

Claude's own closing sentence is the clearest reading of lock 4 (*the refusal must teach the way out*):

> "(A pre-tool hook required a written plan before the first change, so I filed one as a task first.)"

Codex's positive control ran first: with no instruction against planning, codex 0.147.0 called
`update_plan` unprompted, the gate found the row in `codex-tool-hooks.jsonl` for that session, and the
edit passed untouched. So on codex the gate was observed on both verdicts.

Two facts fall out of these runs and are load-bearing for the implementation:

- **`$GROK_HOME` reaches the hook process.** The grok run baked no plan root; the script found
  `sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl` through the env var alone.
- **Grok's `Bash|Edit|Write|MultiEdit` matcher really does fire on `search_replace`**, through the
  runtime's own Claude-name alias table.

## The three plan ledgers, confirmed on disk

No new ledger was invented; each is the one the sidebar already reads.

| runtime | ledger | plan present looks like |
|---|---|---|
| claude | `{configHome}/tasks/<sessionId>/*.json` | a JSON item with a non-empty `subject` |
| codex | `.tachyon/activity/codex-tool-hooks.jsonl` | a row with `toolName: "update_plan"` and this `sessionId` |
| grok | `{GROK_HOME}/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl` | `sessionUpdate: "plan"`, a `todo_write` tool call, or `rawOutput.TodosUpdated` |

## The rule that decides whether this helps or destroys

**"Cannot read" is not "is not there."** Only `ENOENT` — the shape a runtime leaves when the agent never
wrote a plan — refuses. A permission error, malformed JSON, a session directory we cannot locate, an
unrecognized runtime, a payload we cannot parse, a missing session id, or a throw anywhere all answer
`unknown`, which ALLOWS. `test/unit/checklistGateHook.test.ts` executes both halves against the same
script: an unreadable root (parent is a file → `ENOTDIR`) exits 0 while a merely-empty root exits 2.

The gate is also never installed at all unless `requireIn` covers the assigned task's kind, which is why
the negative control can tell "no hook" apart from "a hook that allowed" — a gate that refused everyone
would pass the positive test just as well.

## Fail-before

Both halves were watched failing before they were trusted green (`test/unit/checklistGateHook.test.ts`,
22 cases):

| injected defect | result |
|---|---|
| `planChecklistGateHooks` always returns `undefined` (the pre-t-685a0c world) | 12 failed / 10 passed — the 10 are the negative and fail-open controls, which MUST pass in both worlds |
| the gate is installed but the script always exits 0 | 4 failed / 18 passed |

## What this does NOT reach

- **A retask of a LIVE session.** The argv and hook files are written at spawn; changing `tachyon.yml`
  or moving the agent onto a covered kind mid-session leaves that session ungated until the next door.
  That is the fail-open direction, and it is stated rather than hidden.
- **Runtimes with no measured per-spawn channel** (pi, opencode, hermes, …). They are refused by name,
  never silently claimed.
- **The end-of-turn reminder is untouched.** `INTERNAL_CHECKLIST_GIVE_UP_JOURNAL` still says delivery is
  not blocked, and it still is not: this gate is `PreToolUse` only.
