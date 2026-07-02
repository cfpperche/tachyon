# 325 — task-queue-entity — plan

_Drafted from `spec.md` on 2026-07-02._

## Approach

Mirror the pins architecture where it's good, fix it where it bit us:

1. **`src/tasks/TaskStore.ts`** — one JSON file PER TASK in `.tachyon/tasks/` (`t-<6hex>.json`), atomic tmp+rename writes (the `PinStore.writeDetailFile` discipline). No whole-list index file: `list()` scans the dir (same pattern as `ProbeStore.list()`, fine at this scale) — this is what makes concurrent writers of different tasks lose nothing, unlike `pins.json`'s whole-list rewrite (`PinStore.write`, non-atomic, live lost-update observed).
2. **Types** — `Task {id, title, body?, status: "inbox"|"triaged"|"active"|"done"|"dropped", priority?: 0|1|2|3, rank?: string, kind?: string, author: string, assignee?: string, artifact_refs?: ArtifactRef[], deps?: string[], createdAt, updatedAt}` and `ArtifactRef {type: string, ref: string}`. `type` is an open string, not an enum; Tachyon enriches known types without rejecting project-specific ones. `priority` sorts `0=urgent`, `1=high`, `2=normal`, `3=low`, absent last. `rank` is an optional human/board-controlled tie-breaker within the same priority (fallback: `createdAt`, then id). `kind` is an open work-type label for filtering/grouping only, not routing. `assignee` is an open non-empty string, including `"human"` when the maintainer owns the work. `artifact_refs` is capped at 10 unique `(type, ref)` pairs. `status:"active"` is the coarse "delegated to execution" state; when an `artifact_refs` entry with `type:"sdd"` points at an existing local spec, the fine-grained stage is DERIVED from that spec's `**Status:**` (read via the same convention `/sdd list` uses), never stored. No SDD plugin/spec directory is required for core task behavior.
3. **Bridge tools** (`src/bridge/tools.ts`, following the pin block conventions): `create_task` (title ≤300, body ≤4000, author from AGENT_NAME/`"human"`), `update_task` (partial: title/body/status/priority/kind/assignee/artifact_refs/deps; fail-closed on unknown id, on contradicting a recognized SDD delegation, and on no-op calls), `list_tasks` (full JSON), `next_task(agent)` (pure selection function, unit-tested separately).
4. **`nextTask()` pure function** (`src/tasks/nextTask.ts`) — REVISED per dueto B1: candidates = (assigned-to-caller `triaged`/`active`) else (unassigned `triaged`). Existing unresolved deps exclude a task from BOTH tiers; dangling dep ids count as resolved but add an attention flag. Tasks assigned to `"human"` are reserved for `next_task("human")`/UI views, not for agents. Active SDD-backed tasks stay eligible for their assignee while the derived spec status is actionable (`draft`/`in-progress`/`shipped-partial`), are excluded once the spec is `shipped` (returned by list/get as `ready_to_close` attention), and surface retriage attention instead of normal execution for `superseded`/`abandoned`/`deferred`. Order by priority (0 first, absent last) then optional `rank` then `createdAt` then id; returns `{task}` or `{empty: true, reason: "no-tasks" | "all-blocked" | "all-assigned-elsewhere"}` — never throws. next_task is ADVISORY: it never mutates; claiming is the caller's explicit CAS update.
5. **Claim semantics (dueto B2)**: `update_task` accepts optional `expect: {assignee?, status?, updatedAt?}` preconditions checked-and-applied under a per-store in-process mutex (all mutations flow through the single extension-host Bridge, so an async-interleaving lock closes the read-modify-write race — the same class that bit pins.json). Claim = `update_task(id, {assignee: me}, expect: {assignee: null})`; exactly one concurrent claimer wins, losers get a structured `precondition-failed`.
6. **Sidebar/board feed** — expose `Workspace.tasks` + an `onViewsChanged("tasks")` hook so the follow-up panel spec has its data source ready; no UI in this spec beyond wiring the store into `Workspace` (mirrors `pins`).

## Key decisions

- **Per-task files over a single tasks.json** — the observed pins race (done-flag reverted by concurrent claude×codex writes) is structural to whole-list rewrites; per-item files + rename make different-task writes conflict-free and same-task writes last-writer-wins at file granularity. Rejected: file locks (portable locking pain the project already avoids elsewhere).
- **Coarse entity status + optional artifact enrichment** — the anti-drift rule applies only to recognized SDD artifact refs whose local spec exists: `**Status:**` in that spec is already the versioned truth with verify/dogfood gates; duplicating it invites dual-write drift. Tasks without SDD refs, projects without SDD, and unknown artifact ref types stay fully functional from the task's own status. Rejected: making the SDD plugin/runtime a dependency of the task queue; v1 reads local spec files by convention only when `type:"sdd"` is explicitly present.
- **`next_task` as a pure exported function** — decision logic out of the vscode/bridge layer (spec 240 discipline), unit-tested like `sortRows`/`groupByParent`/`buildProbeView`.
- **No index file** — dir scan keeps writes independent. If listing ever gets hot, an index is a cache to add later, not a source of truth.
- **Author defaulting mirrors pins** (`agent ?? "human"` at the tool boundary; the human path sets "human" explicitly) — one convention, no new identity concept.
- **Field/tool/reference naming ratified by maintainer** — task uses `author` (clearer than pins' `by` next to mutable `assignee`); Bridge tools stay literal (`create_task`, `get_task`, `update_task`, `list_tasks`, `next_task`); empty queues return structured `{empty, reason}` results, not errors; external/local work links use plural `artifact_refs` with open `type` strings, not `spec_ref`.
- **Attention is read-model metadata, not stored status** — dangling deps, missing local SDD specs, and deferred/superseded/abandoned SDD refs surface to list/get/next consumers, but do not mutate the persisted task or introduce a stored `blocked`/`needs-retriage` status.
- **Custom workflow is deferred to the board/studio layer** — the task store keeps a fixed operational status enum for selection, deps, and claims. Non-SDD projects should later configure visual kanban columns/lane mappings without requiring a custom persisted status enum in this v1 entity.
- **Persisted vs derived split** — task files store only raw task fields. Read APIs may add derived metadata/attention (`dangling_dep`, missing SDD spec, SDD lifecycle, `ready_to_close`), but those fields are never written back to disk.
- **`rank` comparison pinned (claude review nit #1)** — codepoint-lexicographic string compare (no locale/collation), so ordering is deterministic across machines; the MINTING strategy (e.g. fractional-indexing "a0"/"a1" for drag-reorder) is the board/studio layer's concern, not the entity's — the entity only compares.
- **`nextTask()` purity vs SDD derivation (claude review nit #2)** — the pure function never touches disk: the derived SDD stage enters as an INPUT (a `taskId → derivedStage` map computed by the caller from the per-`list()` cache), keeping selection unit-testable exactly like `sortRows`/`buildProbeView`.

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
- **m10 (folded)** — validation semantics pinned: trim, non-empty title, code-point bounds, integer priority 0–3 (`0=urgent`, absent last), optional rank/kind strings, enum-only status, deps may dangle but surface attention, `assignee` is an open non-empty string, and `artifact_refs` are capped/deduped open references.
- **m11 (folded)** — store ops trigger `onViewsChanged("tasks")` so the follow-up panel spec consumes the standard invalidation path, no polling.

## Risks & unknowns

- **R1 — id collisions** across concurrent creators: same mint-and-retry discipline as pins (`p-<6hex>`), but per-file creation makes collision = file-exists, detectable atomically with `wx` flag.
- **R2 — optional artifact reading cost**: deriving stage reads spec.md files only for recognized `artifact_refs` with `type:"sdd"`; cache per list() call, not across calls; no SDD plugin APIs are invoked.
- **R3 — naming collision** ("task" vs SDD tasks.md vs harness task tools) — dueto input; the Bridge namespace (`mcp__tachyon_bridge__create_task`) keeps agents unambiguous in practice.

## Sources consulted

- `src/pins/PinStore.ts` (`write` non-atomic vs `writeDetailFile` atomic — the pattern to keep/fix), `src/pins/types.ts`, `src/bridge/tools.ts:490-600` (pin tool conventions: zod bounds, ok/fail, onPinsChanged).
- `src/probe/ProbeStore.ts` (dir-scan list pattern), `src/workspace/Workspace.ts` (store construction/wiring).
- Pin `p-96da7e` (the co-designed v1 model, incl. decisions AGAINST capability field and pin relation).
- Live race evidence: p-00ca60 done-flag reverted 2026-07-01 (concurrent pins.json writes).
