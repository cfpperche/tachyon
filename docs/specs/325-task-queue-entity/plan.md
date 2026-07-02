# 325 — task-queue-entity — plan

_Drafted from `spec.md` on 2026-07-02._

## Approach

Mirror the pins architecture where it's good, fix it where it bit us:

1. **`src/tasks/TaskStore.ts`** — one JSON file PER TASK in `.tachyon/tasks/` (`t-<6hex>.json`), atomic tmp+rename writes (the `PinStore.writeDetailFile` discipline). No whole-list index file: `list()` scans the dir (same pattern as `ProbeStore.list()`, fine at this scale) — this is what makes concurrent writers of different tasks lose nothing, unlike `pins.json`'s whole-list rewrite (`PinStore.write`, non-atomic, live lost-update observed).
2. **Types** — `Task {id, title, body?, status: "inbox"|"triaged"|"active"|"done"|"dropped", priority?: 0|1|2|3, kind?: string, author: string, assignee?: string, spec_ref?: string, deps?: string[], createdAt, updatedAt}`. `status:"active"` is the coarse "delegated to execution" state; when `spec_ref` is set the fine-grained stage is DERIVED from the spec's `**Status:**` (read via the same convention `/sdd list` uses), never stored.
3. **Bridge tools** (`src/bridge/tools.ts`, following the pin block conventions): `create_task` (title ≤300, body ≤4000, author from AGENT_NAME/`"human"`), `update_task` (partial: title/body/status/priority/kind/assignee/spec_ref/deps; fail-closed on unknown id, on contradicting a spec_ref delegation, and on no-op calls), `list_tasks` (full JSON), `next_task(agent)` (pure selection function, unit-tested separately).
4. **`nextTask()` pure function** (`src/tasks/nextTask.ts`) — REVISED per dueto B1: candidates = (assigned-to-caller `triaged`/`active`-without-spec) else (unassigned `triaged`); a task with any UNRESOLVED dep (dep exists and is not `done`/`dropped`; dangling ids count as resolved) is excluded from BOTH tiers; order by priority (0 first, absent last) then `createdAt` then id; returns `{task}` or `{empty: true, reason: "no-tasks" | "all-blocked" | "all-assigned-elsewhere"}` — never throws. next_task is ADVISORY: it never mutates; claiming is the caller's explicit CAS update.
5. **Claim semantics (dueto B2)**: `update_task` accepts optional `expect: {assignee?, status?, updatedAt?}` preconditions checked-and-applied under a per-store in-process mutex (all mutations flow through the single extension-host Bridge, so an async-interleaving lock closes the read-modify-write race — the same class that bit pins.json). Claim = `update_task(id, {assignee: me}, expect: {assignee: null})`; exactly one concurrent claimer wins, losers get a structured `precondition-failed`.
6. **Sidebar/board feed** — expose `Workspace.tasks` + an `onViewsChanged("tasks")` hook so the follow-up panel spec has its data source ready; no UI in this spec beyond wiring the store into `Workspace` (mirrors `pins`).

## Key decisions

- **Per-task files over a single tasks.json** — the observed pins race (done-flag reverted by concurrent claude×codex writes) is structural to whole-list rewrites; per-item files + rename make different-task writes conflict-free and same-task writes last-writer-wins at file granularity. Rejected: file locks (portable locking pain the project already avoids elsewhere).
- **Coarse entity status + derived execution stage** — the anti-drift rule from the pin: `**Status:**` in the spec is already the versioned truth with verify/dogfood gates; duplicating it invites dual-write drift. Rejected: storing the column on the task and syncing — that's the drift.
- **`next_task` as a pure exported function** — decision logic out of the vscode/bridge layer (spec 240 discipline), unit-tested like `sortRows`/`groupByParent`/`buildProbeView`.
- **No index file** — dir scan keeps writes independent. If listing ever gets hot, an index is a cache to add later, not a source of truth.
- **Author defaulting mirrors pins** (`agent ?? "human"` at the tool boundary; the human path sets "human" explicitly) — one convention, no new identity concept.

## Files touched

- `src/tasks/types.ts`, `src/tasks/TaskStore.ts`, `src/tasks/nextTask.ts` (new).
- `src/bridge/tools.ts` — the four tools, after the pin block.
- `src/workspace/Workspace.ts` — construct the store (`.tachyon/tasks`), expose it, wire `onViewsChanged("tasks")`.
- `test/unit/taskStore.test.ts`, `test/unit/nextTask.test.ts` (new); `test/unit/bridgeTools`-adjacent coverage if a harness exists for pin tools (mirror it).

## Design dueto (VIA PROBE, runtime codex) — folded

`probe-0c59238c`, verdict **NEEDS-REVISION**, 11 findings — both blockers were genuine design gaps, all folded:

- **B1 (blocker, folded)** — deps existed but `next_task` ignored them, surfacing blocked work as actionable. Fixed: dependency-aware exclusion in both tiers + structured blocked reasons; dangling deps count as resolved (can't block on nothing).
- **B2 (blocker, folded)** — pure `next_task` + plain `update_task` let two agents claim the same task. Fixed: `next_task` documented as advisory; claims go through CAS preconditions (`expect`) under an in-process mutex — honest because ALL Bridge mutations serialize through one extension host; external hand-edits stay out of scope.
- **M3 (folded)** — status model vs spec lifecycle: compatibility matrix added to spec.md (superseded/abandoned/deferred surface as attention flags + explicit `active→triaged` reopen; "blocked" is derived from deps, never stored).
- **M4 (folded)** — field-mutability × transition table promoted into the acceptance criteria (the contract, not code-accident policy).
- **M5 (folded)** — create exclusivity: mint id → write tmp → `linkSync(tmp, final)` (EEXIST ⇒ re-mint) → unlink tmp; rename-over only for updates. No create path can overwrite.
- **M6 (folded)** — dir-scan hygiene: ensure dir on init; ignore `*.tmp.*`; corrupt JSON is skipped with a structured warning (quarantine-in-place), never parsed as a task.
- **M7 (folded)** — `list_tasks` bounded (no body, default limit 100) + new `get_task(id)` for full payloads.
- **M8 (folded)** — same-task coordination races closed by the same CAS+mutex as B2; non-coordination fields stay last-writer-wins (documented).
- **m9 (folded as documented policy)** — assigned-to-me-first can outrank a hotter unassigned task: intentional (an assignment is a commitment); revisit with evidence, not speculation.
- **m10 (folded)** — validation semantics pinned: trim, non-empty title, code-point bounds, integer priority 0–3, enum-only status, deps may dangle.
- **m11 (folded)** — store ops trigger `onViewsChanged("tasks")` so the follow-up panel spec consumes the standard invalidation path, no polling.

## Risks & unknowns

- **R1 — id collisions** across concurrent creators: same mint-and-retry discipline as pins (`p-<6hex>`), but per-file creation makes collision = file-exists, detectable atomically with `wx` flag.
- **R2 — spec_ref reading cost**: deriving stage reads spec.md files; cache per list() call, not across calls.
- **R3 — naming collision** ("task" vs SDD tasks.md vs harness task tools) — dueto input; the Bridge namespace (`mcp__tachyon_bridge__create_task`) keeps agents unambiguous in practice.

## Sources consulted

- `src/pins/PinStore.ts` (`write` non-atomic vs `writeDetailFile` atomic — the pattern to keep/fix), `src/pins/types.ts`, `src/bridge/tools.ts:490-600` (pin tool conventions: zod bounds, ok/fail, onPinsChanged).
- `src/probe/ProbeStore.ts` (dir-scan list pattern), `src/workspace/Workspace.ts` (store construction/wiring).
- Pin `p-96da7e` (the co-designed v1 model, incl. decisions AGAINST capability field and pin relation).
- Live race evidence: p-00ca60 done-flag reverted 2026-07-01 (concurrent pins.json writes).
