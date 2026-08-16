# Runtime-internal checklist capabilities

**Task:** `t-c2209d` · **Measured:** 2026-07-28 · **Remeasured (claude/codex/grok only):** 2026-08-16 · **Scope:** Claude Code, Codex, Grok,
OpenCode, Pi and Hermes

The 2026-08-16 addendum at the bottom answers the rewritten card: dimension 18 stays
narrative. Native surfaces were remeasured on today's versions; no Tachyon product
function decides checklist support. OpenCode, Pi and Hermes were not remeasured.

## Executive finding

A runtime's **internal checklist** is ephemeral execution telemetry. It is never a Tachyon
Board Task, never proof that work happened, and never an authority for Assignment or Delivery
state.

The six runtimes do not expose one uniform abstraction. Claude Code has the richest checklist
model (individual records, ownership and dependency edges); Codex has the cleanest public
structured observation surface through app-server events and thread items; Grok sits between
them with stable item IDs, merge/replace semantics and a per-session store. OpenCode and
Hermes have runtime-owned mechanisms with different stores and public surfaces. Pi has no
built-in checklist in the measured default toolset; an extension can add one, but extension
behavior is not native parity.

No model call was made for this research. Therefore lifecycle cells that could not be proved
from a public protocol, a synthetic store fixture, or installed source remain `unproven`.

## Evidence method and vocabulary

Evidence is deliberately split:

- **Documented:** vendor documentation or a runtime's own shipped documentation/help.
- **Static:** installed version's schemas, source, tool definitions, or binary strings.
- **Measured:** a command or store/protocol experiment executed locally with synthetic data.

`verified` means the exact installed version and surface were directly established.
`limited` means a native capability exists but the relevant control or lifecycle guarantee is
partial. `unsupported` means the measured built-in runtime has no such capability.
`unproven` means absence or lifecycle behavior was not established strongly enough to infer.

The investigation did not read ambient human transcripts, session databases, checklist
contents, or private runtime homes. Help/version/schema generation and installed package
source were sufficient; no paid inference was used.

## Capability matrix

| Runtime (measured version) | Native existence | Structured read | External write/control | Change events | Lifecycle beyond turn | Overall |
|---|---|---|---|---|---|---|
| Claude Code 2.1.220 | `verified` | `verified` in-runtime | `limited` externally | `limited` | `limited` | `verified` native / `limited` external |
| Codex CLI 0.145.0 | `verified` | `verified` | `limited` | `verified` | `limited` | `verified` read / `limited` control |
| Grok 0.2.112 | `verified` | `verified` | `limited` externally | `verified` | `limited` | `verified` read / `limited` control |
| OpenCode 1.18.5 | `verified` | `verified` | `limited` externally | `verified` | `verified` except fork resets | `verified` read / `limited` control |
| Pi 0.80.10 | `unsupported` built-in | `unsupported` | `unsupported` | `unsupported` | `unsupported` | `unsupported` built-in |
| Hermes 0.18.2 | `verified` | `verified` in-process/ACP | `limited` externally | `verified` | `verified` resume/restart/compact | `verified` read / `limited` control |

“External write/control” asks whether a Tachyon-side client can authoritatively mutate the
runtime-owned checklist. A model-callable native tool alone is not a general external write
API, so it is never more than `limited` here.

## Runtime findings

### Claude Code 2.1.220

Claude Code ships a native task/checklist family: `TaskCreate`, `TaskGet`, `TaskList` and
`TaskUpdate` (with legacy/related `TodoWrite` also present). Records contain `id`, `subject`,
`description`, optional `activeForm`, `owner`, `status`, `blocks`, `blockedBy` and metadata.
Creation starts pending and unowned. Update supports ownership, status and dependency edges;
the runtime prevents claiming a blocked item and coordinates an owner's active item. This is
individual-record CRUD with a dependency DAG, not rendered markdown.

Observed bounds:

- The installed store is session-scoped under
  `~/.claude/tasks/<session-uuid>/`, with numbered item JSON, a lock and high-water mark.
  Layout plus locking is strong static evidence for process/restart/resume survival.
- `TaskCreated` hook support and stream JSON make mutation observation possible, but this pass
  did not prove a complete event for every update or an authoritative full snapshot stream.
- The public CLI has no standalone operator CRUD command. Agent tool access is not external
  Tachyon control.
- Compaction preservation is probable because the store is outside the transcript, but was not
  behaviorally measured. Fork inheritance/copy is `unproven`.

Evidence: `claude --version`; `claude --help` (stream JSON, hook events, resume, fork and
session persistence controls); static strings/tool schemas in installed native CLI 2.1.220;
synthetic-safe inspection of store names/layout only, never item contents. No model call.

### Codex CLI 0.145.0

Codex provides the native `update_plan` tool with ordered steps and
`pending | in_progress | completed` states. The installed app-server protocol is the strongest
runtime-neutral candidate in this set:

- `turn/plan/updated` is a structured notification containing `turnId`, optional explanation
  and the complete ordered plan;
- plan updates are represented as thread items, so thread read/list/resume/fork responses can
  carry the history;
- experimental `item/plan/delta` is explicitly non-authoritative; clients must prefer the
  completed plan item/update;
- no app-server client method directly mutates the plan. Mutation remains model/tool-owned.

The protocol correlates the plan to a turn, but plan steps have no stable per-item identifier
and no `toolCallId`, Assignment, Delivery or idempotency key. Ordering is array order; authorship
is attributable to the runtime turn, not independently signed per step.

Evidence measured without inference:

```text
codex-cli 0.145.0
codex app-server generate-json-schema --experimental --out <isolated-temp>
```

Generated schemas: `v2/TurnPlanUpdatedNotification.json`, thread/turn/item read responses and
`v2/PlanDeltaNotification.json`. The generator is shipped by the installed CLI; generated
temporary files were not retained.

### Grok 0.2.112

Grok has a runtime-owned `todo_write` checklist, distinct from its separate Plan Mode
(`plan.md` and edit gate). The checklist supports stable IDs, statuses and merge/replace
updates; duplicate IDs are rejected. It renders in scrollback and a dedicated Ctrl+T TODO
panel.

The checklist snapshot lives at
`~/.grok/sessions/<encoded-cwd>/<session-id>/plan.json`; `updates.jsonl` is the authoritative
ACP update stream and includes `TodosUpdated`. This documents persistence and resume plus
structured observation. No ownership or dependency DAG was found, and direct editing of
`plan.json` is not a supported external mutation API.

Compaction requires special honesty: shipped skills state that the harness no longer surfaces
a pre-compaction todo snapshot and may need to reseed it. That is weaker than Plan Mode's own
documented compact/restart persistence. Forks carry conversation ancestry, but copying
`plan.json` was not established.

Evidence: `grok 0.2.112`; `grok --help`; shipped
`~/.grok/docs/user-guide/{01-getting-started,16-subagents,17-sessions,22-permissions-and-safety}.md`;
installed binary schemas/strings for `CursorTodo*`, `TodosUpdated` and duplicate-ID handling.
No model call.

### OpenCode 1.18.5

OpenCode's native `todowrite` replaces the complete ordered list. Items have `content`,
`status` and `priority`; the shipped prompt defines
`pending | in_progress | completed | cancelled` and recommends exactly one active item.
There is no item ID: SQLite keys rows by `(session_id, position)`.

The SQLite transaction deletes/reinserts the session list, then publishes `todo.updated` with
`sessionID` and the full list. A public HTTP/SDK GET reads it and the event subscription
observes updates; no supported external write route was found. Restart, resume and compaction
preserve the independent SQLite rows. Fork code copies messages/parts but not the todo table,
so the fork checklist starts empty.

Evidence: `opencode 1.18.5`; official source at exact tag `v1.18.5`,
`packages/opencode/src/tool/{todo.ts,todowrite.txt}`,
`packages/{schema/src/session-todo.ts,opencode/src/session/{todo.ts,session.ts},core/src/session/sql.ts}`
and the session HTTP handler; installed binary strings. No model call.

### Pi 0.80.10

The default Pi coding-agent toolset deliberately has no built-in checklist/todo tool. Its
README says built-in todos confuse models and recommends a `TODO.md` or an extension. Pi's
extension API can implement stateful tools and session entries; the shipped *example*
extension implements `list/add/toggle/clear`, `/todos`, and reconstructs its store by replaying
tool results on session start/tree changes. That demonstrates extension ceiling, not native
parity.

Evidence: `pi 0.80.10`; CLI help; installed README, `docs/extensions.md`, and
`examples/extensions/{todo.ts,plan-mode}`. No model call.

### Hermes 0.18.2

Hermes ships native `todo` plus an in-process `TodoStore`. Items have `id`, `content` and
`pending | in_progress | completed | cancelled`; calls can read, replace the full list, or
merge by ID. The runtime enforces shape, limits and duplicate protection, but “exactly one
in_progress” is prompt guidance rather than a code invariant.

Resume/restart rehydrate from the latest history result only when paired with the assistant's
tool call, preventing an unpaired forged result from becoming state. Compression reinjects
pending/in-progress items and intentionally omits completed/cancelled ones. ACP converts the
result to a native `sessionUpdate: plan`, providing structured external observation; it does
not offer client-side mutation. Fork preservation is a static inference from copied history,
not behaviorally verified. Hermes Kanban is a separate durable system and is not this
checklist.

Evidence: `Hermes Agent v0.18.2`; installed `tools/todo_tool.py`, hydration in
`run_agent.py`, `agent/conversation_compression.py`, `acp_adapter/events.py` and ACP tests.
A local no-model TodoStore experiment verified replace, merge, summary and active-only
compression injection. Cost: USD 0.00.

## State and control comparison

| Runtime | Create/update model | Remove/cancel | Stable item ID | Human direct edit | Correlation ceiling |
|---|---|---|---|---|---|
| Claude | individual create/get/list/update | runtime update semantics | yes | no public operator API | session, item, owner and dependency edges |
| Codex | whole plan via `update_plan` | replace list; no cancel state | no | no public API | `turnId` |
| Grok | `todo_write`, merge or replace | runtime-specific | yes | no public operator API | session + `TodosUpdated` |
| OpenCode | full-list `todowrite` replacement | `cancelled` state | no (position only) | GET/event yes; no public write route | session |
| Pi | none built-in | none | none | none | none |
| Hermes | read, replace, merge by ID | `cancelled` state | yes | ACP read/event; no public write API | conversation/session + item |

No runtime measured here exposes a native approval gate specifically for checklist mutation.
Generic tool permission or hook mechanisms must not be described as checklist approval until
their exact interception behavior is measured.

## Minimum runtime-neutral telemetry contract

Tachyon should ingest immutable observations, not mirror a pretend universal mutable list:

```ts
type InternalChecklistObservation = {
  runtime: "claude" | "codex" | "grok" | "opencode" | "pi" | "hermes" | string;
  runtimeVersion: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  observedAt: string;
  source: "protocol" | "event-stream" | "transcript" | "screen";
  provenance: "native" | "extension" | "textual";
  evidence: "verified" | "limited" | "unproven";
  revision?: string;
  items: Array<{
    runtimeItemId?: string;
    position: number;
    text: string;
    status: "pending" | "in_progress" | "completed" | "cancelled" | "unknown";
  }>;
};
```

Contract rules:

1. Observations are append-only telemetry; the latest observation is a view, not Board state.
2. Missing events, parse failures and screen-only evidence yield `unproven`, never inferred
   completion.
3. Runtime item IDs stay namespaced by runtime/session and never become Tachyon Task IDs.
4. Writes require a separately measured runtime-specific control adapter. Read support never
   implies write support.
5. Checklist completion cannot close a Task, Assignment, Delivery or verification gate.
6. Raw checklist text should follow transcript privacy/redaction policy; the minimal product
   can expose counts/statuses before exposing content.
7. Deltas are accepted only with a runtime revision/order guarantee; otherwise ingest a full
   snapshot and label concurrent order `unproven`.

## Decisions still open

- Whether the first product surface shows item text or only counts/status telemetry.
- Whether Codex app-server becomes the reference read adapter while other runtimes remain
  transcript/event adapters, rather than forcing one lowest-common-denominator transport.
- Retention and redaction policy for ephemeral checklist text.
- Whether a runtime-specific write adapter is desirable at all; none is required to deliver
  honest observation.

## Reproduction notes

Safe commands used:

```text
claude --version; claude --help
codex --version; codex app-server --help
codex app-server generate-json-schema --experimental --out <isolated-temp>
grok --version; grok --help
opencode --version; opencode --help
pi --version; pi --help
hermes --version; hermes --help
```

Static inspection was restricted to installed runtime packages and shipped documentation. No
ambient session file or user checklist was opened. Cost: **USD 0.00**.

## 2026-08-16 addendum — dimension 18 stays narrative

**Task:** `t-c2209d` · **Agent:** checkgrok · **Scope:** Claude, Codex, Grok only.
No integration was implemented. OpenCode, Pi and Hermes were not remeasured.

### What the 2026-07-28 research already covers

The original pass established, without a model call, that the three in-scope runtimes
have a native structured checklist and documented how it differs:

| Runtime (then) | Native mechanism | Structured observation surface | What stayed `unproven` |
|---|---|---|---|
| Claude Code 2.1.220 | `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` (+ `TodoWrite`); item IDs, owner, `blocks`/`blockedBy` | session store under `~/.claude/tasks/<session-uuid>/`; `TaskCreated` hook; stream JSON | fork inheritance; compaction survival; complete update-event coverage |
| Codex CLI 0.145.0 | `update_plan`; ordered steps `pending \| in_progress \| completed`; no stable per-step id | app-server `turn/plan/updated` (authoritative); experimental `item/plan/delta` (non-authoritative) | whether Tachyon could subscribe; write/control (none in protocol) |
| Grok 0.2.112 | `todo_write` with stable IDs, merge/replace; distinct from Plan Mode | per-session `plan.json`; ACP `updates.jsonl` including `TodosUpdated`; Ctrl+T pane | `plan.json` copy on fork; todo snapshot through compact |

It also proposed a Tachyon-side observation type and the old vocabulary
`verified | limited | unsupported | unproven`. That vocabulary is **not** a second
matrix. Map it; do not reintroduce it in `parity.ts`.

### What needed remeasurement, and why

Version drift against the 2026-07-28 install, on 2026-08-16, same machine:

| Runtime | 2026-07-28 | 2026-08-16 PATH | Why remeasure |
|---|---|---|---|
| Claude Code | 2.1.220 | 2.1.233 | patch; same baseline `RUNTIME_PARITY` already cites |
| Codex CLI | 0.145.0 | 0.147.0 | two minors; same baseline the table already cites |
| Grok | 0.2.112 | 1.0.4 (`d846eb93d9`) | **major**. Remeasure was mandatory |

No other remeasure was justified. Lifecycle cells that the original left `unproven`
(fork copy, compact survival, full Claude update stream) were **never** measured, so
they are not “already measured.” They also cannot become a table cell without a
product reader. The 508 canary method (`docs/research/t-a68138-system-prompt-compact.md`)
applies to a **product channel** (an instruction flag, a hook overlay). There is no
such channel for checklist observation, so a live authenticated todo-turn would
remeasure the CLI writing its own store — the existence half already covered
statically — and would still not prove Tachyon correlates it.

Method this pass (same class as 2026-07-28, plus an explicit negative control):

- `claude --version` / `--help`; strings on the installed 2.1.233 ELF
- `codex --version`; `codex app-server generate-json-schema --experimental --out <isolated-temp>`
- `grok --version` / `--help`; shipped `~/.grok/docs/user-guide/{01,03,16,17,22}-*.md`; strings on `grok-1.0.4-linux-x86_64`
- No ambient session, `plan.json`, or `~/.claude/tasks/` item was opened
- No model call. Cost: **USD 0.00**

**Positive control (must be present):**

- Claude 2.1.233 binary still contains `TaskCreate` (47), `TaskGet`, `TaskList`,
  `TaskUpdate`, `TodoWrite`, `TaskCreated`, `blockedBy`, `activeForm`, and
  `executeTaskCreatedHooks`
- Codex 0.147.0 still emits `v2/TurnPlanUpdatedNotification.json` (`plan[]` of
  `{status, step}`, `threadId`, `turnId`, optional `explanation`; statuses
  `pending | inProgress | completed`) and still names the notification
  `turn/plan/updated`. `v2/PlanDeltaNotification.json` is still marked
  **EXPERIMENTAL** — clients must not treat concatenated deltas as the completed
  plan. `item/plan/delta` is still in the server notification enum
- Grok 1.0.4 shipped docs still list `todo_write`, `plan.json` as TODO/task-list
  state, `updates.jsonl` as the ACP stream, and **Ctrl+T on the agent screen** as
  “Toggle the todos pane” (dashboard `Ctrl+T` is a different binding: pin/unpin).
  Binary strings still contain `todo_write` (10), `TodosUpdated` (5), `plan.json`
  (4), `CursorTodoWriteInput`, `CursorTodoItem`

**Negative control (invented names must be absent):**

- Claude: `TaskInvented`, `ChecklistTelemetry` — absent
- Codex generated schema: `turn/checklist/updated`, `turn/todo/updated`,
  `ChecklistTelemetry` — absent
- Grok: `TodosInvented`, `ChecklistTelemetry` — absent

Native surfaces persist across the version jump. Schema status spelling on Codex
moved to camelCase `inProgress` in the generated JSON Schema; that is a schema
token, not a new product door.

### Callable-port hunt — why it stays narrative

Row 18 asserts two things: the runtime has a native structured checklist, **and**
Tachyon observes it through a measured structured path with correlation and
provenance. Fatia 2 classified the row `measured` / narrative because
“nenhuma função de produto decide suporte; nomes como `plan`/`todo` não provam
que o CLI emite nem correlaciona a estrutura.”

The 2026-08-16 hunt looked for a function the parity test could call the way
`runtimeUsesSilentPersistenceHooks` or `activityNormalizerForRuntime` is called.
None exists.

| Candidate | What it actually decides | Why it is not row 18 |
|---|---|---|
| `activityNormalizerForRuntime` | which transcript reader Activity uses | `ActivityEventType` has no checklist/plan/todo event. Unmapped records are dropped. Grok's reader tails `chat_history.jsonl`, not `updates.jsonl` / `plan.json` |
| `CodexAppServerObservationSource` | quota via `account/rateLimits/read` | same transport as `turn/plan/updated`, different method. Treating “app-server is wired” as checklist support is the name-similarity false positive fatia 2 named |
| `TaskStore` / Board `TaskCreate` | Tachyon Board Tasks | the research's first sentence: a runtime checklist is never a Board Task |
| `PinStore` | human↔agent project checklist | different store, different actor |
| Tiptap `TaskList` | rich-doc editor widget | UI chrome, not runtime telemetry |
| `nativeMemoryCapability` | per-axis memory evidence | different dimension; deriving it against itself is the row-15 tautology |

Inventing `runtimeSupportsChecklistTelemetry()` that returns false, then deriving
`projection: cannot` from it, would **implement** a door the product does not
have and would treat “unwired” as “cannot.” `cannot` is for a missing native
lever (Codex fork, discovery root), not for work nobody built. The card forbids
integration.

Therefore dimension 18 does **not** enter `PARITY_DIMENSIONS`. The fatia-2 motive
still holds, now with this hunt dated.

### Vocabulary — map, do not fork

The 2026-07-28 card proposed `verified | limited | unsupported | unproven`.
The typed table uses two independent halves:

```text
projection   wired | cannot (with reason)
runtime      measured (version + YYYY-MM-DD) | cannot (with reason) | unmeasured (with needed)
```

| Old word | Table word | Where it applies here |
|---|---|---|
| `verified` (this install, this surface, directly established) | `runtime: measured` + `runtimeVersion` + `measuredAt` | Native **existence** on 2026-08-16 is this kind of evidence — but it is research about the CLI, not a cell, because there is no projection door |
| `limited` (native exists; observation or control is partial) | not a table verdict | “partial native” is prose about the CLI. A cell cannot say this without a second dialect |
| `unsupported` (no built-in) | `runtime: cannot` + reason | none of the three in-scope runtimes; Pi was this in 2026-07-28 and is out of scope |
| `unproven` (do not infer) | `runtime: unmeasured` + `needed` | the same rule, eighteen days later. Fork copy, compact survival of todos, and “Tachyon correlates the structure” remain here |

`runtime: wired` stays illegal. `unmeasured` without `needed` stays illegal.

### Axis that does not fit

The 2026-07-28 matrix had five columns (existence, structured read, external
write/control, change events, lifecycle). One typed cell carries one projection
fact and one runtime fact. Forcing those five columns into `RUNTIME_PARITY` would
invent dialect. Write that down rather than squeeze.

If a later task **wires** observation, the honest first cell is:

- `projection: wired` derived from the new callable door, with a red-proof that
  removing the door turns the test red
- `runtime: unmeasured` + `needed` until an authenticated session shows the CLI
  still emits the event/file **and** that the product reader correlates it; an
  invented event name must not be treated as a checklist. Or `runtime: measured`
  with version and date once that probe exists

External **write** is a second product door. Read support never implies it.
That remains out of scope.

### Reproduction (2026-08-16)

```text
claude --version          # 2.1.233 (Claude Code)
codex --version           # codex-cli 0.147.0
grok --version            # grok 1.0.4 (d846eb93d9)
codex app-server generate-json-schema --experimental --out <isolated-temp>
# then: v2/TurnPlanUpdatedNotification.json and v2/PlanDeltaNotification.json
```

Temporary schema directory was not retained. No session home was read.
