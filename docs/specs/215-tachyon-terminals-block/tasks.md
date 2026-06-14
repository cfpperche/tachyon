# 215 — tachyon-terminals-block — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [ ] 1. **Parse + schema**: factor per-agent-entry field parsing into a shared helper; parse a
      top-level `terminals:` mapping reusing it with kind forced to `terminal`; reject a `kind`
      or `instructions` key inside `terminals:`; merge into `config.agents`; reject an
      agents↔terminals name collision; add `terminals` to allowed top-level keys + JSON schema.
      Unit-tested (round-trip, collision, rejections, backward compat with `agents:`+kind).
- [ ] 2. **YamlConfigEditor section-awareness**: `sectionOf(doc, name)`; section-aware
      `upsertAgent` (new entries → kind-implied section; edits → existing section; rename +
      layout refs); `deleteAgent`/`renameAgent`/`agentEntryLine` resolve across both blocks.
      Unit-tested (create terminal → `terminals:`; edit legacy `agents:` terminal → stays;
      edit `terminals:` entry → stays; rename; refuse name taken in either block).
- [ ] 3. **Workspace.studioSubmit**: route a `kind: terminal` submit through the
      terminals-aware upsert; the agent path is unchanged. (Covered via the editor tests + a
      studio submit test if feasible.)
- [ ] 4. **Init**: `buildStarterYaml` emits stack terminals under `terminals:` (AI agent stays
      under `agents:`); refreshed teaching comments. Round-trip test
      (`parseConfig(buildStarterYaml(...))` valid, terminals present as kind:terminal).
- [ ] 5. **Docs**: README "kind taxonomy" shows the `terminals:` block as the recommended form
      (legacy `agents:`+kind still documented as valid).
- [ ] 6. **codex dueto** review rounds until SHIP; then ship a release.

## Notes
- Pure surface change — NO engine/runtime code touched (AgentManager/Sidebar/MCP/worktree all
  key off `config.agents` + kind, which is unchanged).
- Backward compatible; no auto-migration. TDD + codex dueto, like 210/212/213/214.
