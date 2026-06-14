# 215 — tachyon-terminals-block — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Parse + schema**: extracted `parseAgentEntry` shared helper; `terminals:` parsed with
      kind forced + `kind`/`instructions` rejected; merged into `config.agents`; agents↔terminals
      collision rejected; ≥1 entry across both blocks; `terminals` in top-level keys + schema
      (anyOf agents|terminals). 24 config tests (round-trip, collision, rejections, backward compat).
- [x] 2. **YamlConfigEditor section-awareness**: `sectionOf`/`mapOf`/`entryCount`/`sanitizeForSection`;
      section-aware `upsertAgent` (create→kind-implied section, strips kind/instructions for
      terminals:; edit→existing section, never moves); `deleteAgent` (cross-block + drops empty
      block), `renameAgent`, `cloneAgent`, `agentEntryLine` resolve both blocks. 19 yamlEditor tests.
- [x] 3. **Workspace.studioSubmit**: routes a `kind: terminal` submit with `section: "terminals"`;
      agent path unchanged.
- [x] 4. **Init**: `buildStarterYaml` emits a `terminals:` block (kind implied, no attention:false);
      AI agent stays under `agents:`. Existing init round-trip tests green.
- [x] 5. **Docs**: README "kind taxonomy" rewritten — `terminals:`/`agents:` as the form, one
      kind-tagged set under the hood, backward compat noted.
- [ ] 6. **codex dueto** review rounds until SHIP; then ship a release.

## Notes
- Pure surface change — NO engine/runtime code touched (AgentManager/Sidebar/MCP/worktree all
  key off `config.agents` + kind, which is unchanged).
- Backward compatible; no auto-migration. TDD + codex dueto, like 210/212/213/214.
