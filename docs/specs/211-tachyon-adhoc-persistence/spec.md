# 211 — tachyon-adhoc-persistence

_Created 2026-06-13._

**Status:** shipped-partial

**Closure:** 2026-06-13 — implemented Tasks 1–7 (Opus 4.8). Ledger def/resume split
+ `isResumable` + pre-211 migration; every ad-hoc recorded after a successful spawn
(def for all, resume adapter-only); `rehydrateFromLedger()` wired before planResume;
all resume paths (planResume offers, sidebar badge) filter on `isResumable`;
kill removes an ad-hoc's row; rename rewrites children's persisted parent;
`addAgent` extended for `instructions`; "Save to tachyon.yml" (`promoteAgentItem`)
with ledger transition + ad-hoc `-adhoc` contextValue (state menus moved to prefix
regex so inline buttons still apply). 298 unit tests (8 new: isResumable, def-only
not offered, rehydrate restartable+re-nest, declared-shadow skip, kill-removes-row,
rename-children, addAgent-instructions). **Residual:** Task 8 live EDH smoke
(reopen→restart→re-nest→promote) — the maintainer's dogfood step.

**Verify:** `npm run typecheck && npm test`

**UI impact:** interaction
<!-- Restart works on a re-discovered ad-hoc agent; the tree re-nests sub-agents
under their parent after a restart; a "Save to tachyon.yml" action promotes an
ad-hoc agent to declared. Verified by driving a real reopen/restart in the EDH. -->

## Intent

**Close the ad-hoc-agent survival gaps surfaced while dogfooding C1's review.**

Ad-hoc agents (MCP `spawn_agent` with a `cmd`, e.g. a delegated sub-agent) are
**intentionally NOT written to `tachyon.yml`** — that stays the contract (a
transient delegation must not pollute/commit the shared config). And they are not
truly lost today: a VS Code window reopen re-attaches the live tmux session, and a
full restart **offers** them for resume because the ledger (`.tachyon/sessions.json`)
persists their `cmd` + `sessionId` (spec 209).

But the investigation found two real gaps + one missing affordance:

1. **A re-discovered ad-hoc agent is not restartable.** On activation the ledger
   has the `cmd`, but `AgentManager`'s in-memory `adhoc` map is NOT rehydrated, so
   `restart` fails with "no stored definition". The data exists; the wiring doesn't.
2. **Lineage is lost across a restart.** The ledger has no `parent` field, so a
   sub-agent re-appears as a top-level orphan (the tree nesting is gone).
3. **No way to keep a useful ad-hoc agent.** If a spawned sub-agent proves worth
   keeping, there's no one-click path to make it a declared (persistent, committable)
   agent.

This spec closes all three. It is a residual-closure of spec 209 (resume) plus a
small new affordance; it does NOT touch worktrees (spec 210).

## Decisions

1. **Rehydrate ad-hoc defs from the ledger on activation.** Reconstruct the
   `AgentDef` from the record's `def` block (`cmd`, `kind`, `instructions`, original
   `cwdInput`) and repopulate `AgentManager.adhoc`. **Guard (review fix):** rehydrate
   only entries that have a `def` AND whose name is **NOT currently declared in
   `tachyon.yml`** (config is authoritative — a name later added/promoted to yml must
   not spawn an ad-hoc shadow), AND that aren't already live in memory. Idempotent.
   Result: a re-discovered ad-hoc agent is **restartable**.
2. **Persist + rehydrate lineage.** Add `parent` to the ledger record; on activation
   rebuild the `lineage` map from it. Sub-agents re-nest under their parent (orphan-
   promotion at render still applies when the parent is truly gone).
3. **Record ALL ad-hoc agents, with an explicit def/resume schema split (review
   fix).** Today only adapter-backed (AI) ad-hoc agents get a ledger entry, so a
   non-AI ad-hoc (`cmd: sh`) loses its def + lineage. Decouple the two concerns in
   the record shape itself — no easy-to-misuse flat optionals:
   ```ts
   SessionRecord = {
     def?:    { cmd, kind, instructions?, parent?, cwdInput? },  // every ad-hoc; drives restart + lineage
     resume?: { runtime, sessionId },                            // adapter-backed only; drives resume
     declared: boolean, updatedAt
   }
   ```
   `isResumable(record) = !!record.resume?.runtime && adapterExists(runtime)` (an
   empty `sessionId` is fine for capture/qwen). **Every resume code path — `planResume`
   offers, the sidebar "resumable" badge, `resumeAll`, the per-agent ↻ — MUST filter
   on `isResumable`, not on "has a ledger row" (review fix: today they treat every
   row as resumable, so def-only `sh` rows would falsely show as resumable).**
   Records are written **only after a successful spawn** (no phantom rows on spawn
   failure).
4. **"Save to tachyon.yml" (promote).** A sidebar action on an ad-hoc agent writes
   it as a declared agent. **Review fixes:** (a) the existing `addAgent` only takes
   `cmd + kind` — **extend it to also write `instructions`** (fidelity); (b) **never
   write an absolute machine `cwd` into the committed yml** (portability/leak) — omit
   `cwd`, or relativize to the workspace; (c) after a successful yml write, transition
   the ledger entry: adapter-backed → flip `declared:true` (keep for resume); def-only
   → remove the row (it's now declared in yml). Name collision with an existing
   declared agent → refuse. Comments preserved. Promotion stays **explicit/manual**
   — the "ad-hoc never auto-writes yml" contract is unchanged.
5. **Cleanup + restart + rename keep the ledger honest (review fixes).** Kill/dismiss
   of an ad-hoc agent **removes its ledger row** (today kill only clears the in-memory
   `adhoc`/`lineage` maps, so def-only rows would resurrect as permanent stopped
   entries). `restart` of an adapter-backed agent **refreshes the resume metadata**
   (don't leave a stale `sessionId` pointing at the prior conversation). `rename`
   rewrites the moved record AND every child record whose `def.parent === oldName`;
   a `parent === self` link is rejected. (Multi-node lineage cycles are near-impossible
   to form via spawn-time `parent` and are **not** specially handled beyond the
   self-guard — a deliberate downscope; orphan-promotion at render already covers a
   missing parent.)

## Behavior

- **On activation** (before `planResume`): rehydrate `adhoc` + `lineage` from records
  with a `def` whose name isn't currently declared (Decision 1). `planResume` and the
  sidebar then run **filtered by `isResumable`** — def-only rows are restartable and
  shown, but never offered/badged as resumable.
- **Restart of a re-discovered ad-hoc** succeeds (def present); adapter-backed restarts
  refresh the resume metadata; instructions re-delivered on a fresh restart, omitted
  on `--resume`.
- **Kill / dismiss** of an ad-hoc agent removes its ledger row (no resurrection).
- **Promote**: `tachyon.promoteAgentItem` → extended `addAgent` (cmd + kind +
  instructions; no absolute cwd) → reload → ledger transition (Decision 4).
- **Non-AI ad-hoc** (`sh`): `def` persisted (restart + lineage), no `resume` block →
  never auto-resumed/offered, consistent with today.
- **Pre-211 live ad-hoc with no ledger row**: not retroactively recoverable
  (documented; only affects agents spawned before upgrading).

## Non-goals

- Changing the "ad-hoc is not auto-written to `tachyon.yml`" contract (promotion is
  explicit).
- New resume runtimes / adapters (spec 209 owns that).
- Worktrees (spec 210).
- Persisting `env` for ad-hoc (MCP `spawn_agent` takes no env today).

## Acceptance

- After a full restart, an ad-hoc agent's `restart` works (def rehydrated) and a
  sub-agent re-nests under its parent (lineage rehydrated).
- A **def-only (`sh`) row is NEVER shown as resumable** — not in the badge, the
  "N agents can be resumed" offer, `resumeAll`, or the per-agent ↻ (filtered by
  `isResumable`).
- An adapter-backed `restart` leaves no stale `sessionId` (resume metadata refreshed).
- Kill/dismiss of an ad-hoc removes its ledger row (it does not resurrect as a
  stopped entry on the next activation).
- A name present in `tachyon.yml` is never rehydrated as an ad-hoc shadow.
- `rename` of a parent updates its children's persisted `parent`; a self-parent is
  rejected.
- "Save to tachyon.yml" writes cmd + kind + **instructions**, **no absolute cwd**;
  name clash refused; comments survive; the ledger entry transitions (flip or remove).
- A spawn that fails writes no ledger row (no phantom agent).
- Pure pieces (def reconstruction, `isResumable`, lineage rebuild, promote yaml edit
  incl. instructions) are unit-tested; a live EDH reopen/restart smoke covers it.
