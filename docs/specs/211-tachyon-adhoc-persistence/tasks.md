# 211 — tachyon-adhoc-persistence — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Ledger schema split** (`src/resume/SessionLedger.ts`): `SessionRecord` =
      `{ def?: {cmd,kind,instructions?,parent?,cwdInput?}, resume?: {runtime,sessionId},
      declared, updatedAt }`. Tolerant load: migrate old flat records on read. Export
      `isResumable(record)`. Unit-test round-trip + pre-211 migration + isResumable
      (AI w/ + w/o sessionId = true; def-only = false).
- [x] 2. **Record every ad-hoc on spawn, after success** (`AgentManager.spawn`): write
      a `def` for ALL ad-hoc (not gated on `adapterFor`); add `resume` only when an
      adapter matches; **only after the spawn succeeds** (no phantom rows). Unit-test:
      AI ad-hoc (def+resume), `sh` ad-hoc (def only), spawn-failure (no row).
- [x] 3. **`rehydrateFromLedger()`** (`AgentManager`): repopulate `adhoc` from records
      with a `def` whose name is **not currently declared** and not already live;
      `lineage` from `def.parent` (reject self-parent); idempotent. Unit-test
      reconstruction + declared-name skipped + idempotency + self-parent rejected.
- [x] 4. **Activation wiring** (`Workspace`): `rehydrateFromLedger()` before
      `planResume(...)`; restart of a re-discovered ad-hoc succeeds (AgentManager test).
- [x] 4b. **Filter resume on `isResumable`** — `planResume` offers, the Sidebar
      "resumable" badge, `resumeAll`, and the per-agent ↻ exclude def-only rows.
      Unit-test: a `sh` def-only row is NOT offered/badged/in resumeAll.
- [x] 4c. **Lifecycle honesty**: kill/dismiss of an ad-hoc **removes its ledger row**;
      adapter-backed `restart` **refreshes the `resume` block**; `rename` rewrites the
      moved record + every child whose `def.parent === oldName`. Unit-test each.
- [x] 5. **Promote** (`tachyon.promoteAgentItem`): **extend `YamlConfigEditor.addAgent`
      to write `instructions`** (today cmd+kind only); write **no absolute cwd**; refuse
      on name collision; comments preserved; after write, transition the ledger row
      (adapter-backed → `declared:true`; def-only → remove). nls (en+pt-br). Unit-test
      the yaml edit (instructions, no cwd) + collision + ledger transition.
- [x] 6. **Sidebar/menu**: a contextValue distinguishing ad-hoc from declared agents;
      "Save to tachyon.yml" (inline/context, palette-hidden) only on ad-hoc.
- [x] 7. **Docs**: README note on ad-hoc persistence + promotion; tool/MCP docs if
      `spawn_agent` wording needs it.
- [ ] 8. **Live smoke** (EDH, examples/orbit-api): spawn an AI ad-hoc + a `sh` ad-hoc
      with `parent=claude` → Reload Window → both restartable, nesting restored;
      promote the AI one → it appears under `agents:` in tachyon.yml and survives as
      declared.

## Notes
- Pure-first per spec 209: ledger round-trip, def/lineage reconstruction, and the
  promote yaml edit are unit-tested; one live reopen/restart smoke closes it.
- Builds on spec 209 (resume); closes its ad-hoc-offer + restartability residuals.
  Independent of spec 210 (worktrees).
