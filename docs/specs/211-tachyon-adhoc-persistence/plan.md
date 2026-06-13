# 211 — tachyon-adhoc-persistence — plan

## Architecture

Small, surgical — it extends existing seams (the spec-209 ledger + AgentManager's
`adhoc`/`lineage` maps + YamlConfigEditor), no new subsystem.

### SessionLedger (`src/resume/SessionLedger.ts`)
- **Restructure `SessionRecord` into a def/resume split** (not flat optionals):
  `def?: { cmd, kind, instructions?, parent?, cwdInput? }` (every ad-hoc; drives
  restart + lineage) and `resume?: { runtime, sessionId }` (adapter-backed only).
  Tolerant load: migrate old flat records (`{runtime,sessionId,cmd,cwd,...}`) into
  the new shape on read; back-compat unit-tested.
- Export `isResumable(record)` = `!!record.resume?.runtime && adapterExists(...)`
  (empty `sessionId` allowed for capture/qwen).
- Record-on-spawn (`AgentManager.spawn`), **only after a successful spawn**: write a
  `def` for **every** ad-hoc agent (not gated on `adapterFor`); add `resume` only when
  an adapter matches. Declared agents: recorded as today for resume; never rehydrated.
- **Remove the row on kill/dismiss** of an ad-hoc (today this does NOT happen — see
  the corrected risk below). Promote transitions the row (flip `declared:true` for
  adapter-backed, remove for def-only).

### AgentManager (`src/agents/AgentManager.ts`)
- New `rehydrateFromLedger()` (called once on construction/activation): for each
  `declared:false` record → `this.adhoc.set(name, {cmd, kind, instructions, …})`;
  for each record with `parent` → `this.lineage.set(name, parent)`. Idempotent;
  never overwrites a live spawn.
- `definitionOf` already prefers config then `adhoc` → restart "just works" once
  `adhoc` is rehydrated. No change to restart itself.

### Workspace (`src/workspace/Workspace.ts`)
- On activation, call `manager.rehydrateFromLedger()` **before** the existing
  `planResume(...)` so reattach/offer act over fully-defined ad-hoc agents +
  restored lineage.

### Promote (`src/extension.ts` + `src/config/YamlConfigEditor.ts`)
- `tachyon.promoteAgentItem` (item context/inline on an ad-hoc agent; palette-hidden)
  → resolve the ad-hoc def → `addAgent(text, name, cmd, kind, instructions)` (reuse
  the existing editor; comments preserved) → `mutateConfig` reload. Refuse if the
  name already exists in `agents:`. After reload the agent is declared (drop from
  `adhoc`/ledger-as-adhoc; the ledger entry can flip `declared:true` or be left —
  decide in tasks).
- Sidebar: show "Save to tachyon.yml" only when `viewItem` marks an ad-hoc agent
  (need a contextValue that distinguishes ad-hoc from declared — today the item
  knows `declared`; expose it as `agent-adhoc*` or a `when` on a tracked context).

## Sequencing
1. Ledger schema (+kind/instructions/parent) + record-all-ad-hoc on spawn + tests.
2. `rehydrateFromLedger()` + Workspace activation wiring + tests (def + lineage
   reconstruction; declared untouched).
3. Restart-of-rehydrated-ad-hoc covered by an AgentManager test (def present).
4. Promote command + YamlConfigEditor reuse + collision refusal + nls; Sidebar
   affordance + contextValue for ad-hoc.
5. Live EDH smoke: spawn ad-hoc (AI + `sh`) with a parent → reload window → restart
   works, nesting restored; promote → appears in tachyon.yml.

## Risks / edges
- **Instructions not previously persisted** → rehydrated restart re-delivers them;
  fine. Ledger grows slightly; bounded by agent count.
- **Stale ledger entries** (review-corrected): kill today clears only the in-memory
  `adhoc`/`lineage` maps — it does **NOT** remove the ledger row (`AgentManager.kill`
  ~215-222; `Workspace` ~162-165). So def-only rows would resurrect as permanent
  stopped sidebar entries. **Fix: kill/dismiss of an ad-hoc must remove its ledger
  row.** (My earlier "already removes the entry" was wrong.)
- **Resume UI must filter on `isResumable`** — `planResume` (~35-44) and Sidebar
  (~201-214) treat every ledger row as resumable today; def-only rows must be excluded
  from offers/badge/resumeAll/↻.
- **`restart` bypasses resume bookkeeping** (`AgentManager` ~260-281) → refresh the
  `resume` block on an adapter-backed restart, or it points at the stale conversation.
- **`addAgent` lacks `instructions`/`cwd`** (`YamlConfigEditor` ~37-54) → extend for
  `instructions`; never write an absolute `cwd`.
- **Rename + lineage** → update the moved record AND every child record whose
  `def.parent === oldName`; reject `parent === self`. Multi-node cycles: not specially
  handled (near-impossible via spawn-time parent) — orphan-promotion covers a missing
  parent.
- **kind inference** on rehydrate uses `inferKind(cmd)` unless the record stored an
  explicit kind — store it to be faithful to the original spawn.
- **Promote of an agent currently in a worktree (spec 210)** — out of scope here;
  promotion writes cmd/kind/instructions only.
