# 216 — tachyon-role-anchoring — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — see spec 218)

## Implementation

- [x] 1. **Roles core** (`src/roles/templates.ts` + `roles.test.ts`): `ROLES`, `isRole`,
      `roleTemplate`, `composeInstructions` (template→instructions), `bridgeGuidanceTail`,
      `withBridgeGuidance`, `roleReminder(role, docPath)`, `buildRoleDoc`. Behavior contracts in
      English, no persona language (a test asserts no persona regex).
- [x] 2. **Config**: `role` on `AgentDef` + `AGENT_KEYS` + validation (known role|custom; rejected
      under `terminals:` AND `agents:`+`kind:terminal`); `settings.anchor.auto` (default false) +
      `settings.bridgeGuidance` (default true); schema updated. Config tests.
- [x] 3. **Spawn compose** (`AgentManager.effectiveCmd`): role+instructions composed at spawn AND
      restart (NOT resume — transcript already has it); `bridgeGuidanceTail` only for Bridge-spawned
      children (parent set), suppressed by `bridgeGuidance:false`, dropped when cmd can't deliver.
      agentManager tests.
- [x] 4. **Studio**: role dropdown on the Agent tab (`AgentForm`/`formLogic` `FormState.role`,
      `toEntry`, `fromDef`); round-trips `role`. agentStudio tests.
- [x] 5. **Compaction detector** (`src/anchor/compaction.ts` + `anchor.test.ts`): claude+codex
      markers, `detectCompaction(cmd, paneTail)`; other runtimes inert (documented gap).
- [x] 6. **AttentionMonitor flag**: per-snapshot `wasCompacted` + `onCompaction` callback (once per
      banner episode), fed by `cmdOf`. attention tests.
- [x] 7. **Anchor policy + injection** (`Workspace`): re-anchor on idle-after-compaction, once per
      episode, gated by `settings.anchor.auto` (OFF default), AGENT-ONLY (`cmdOf`/`reanchor` kind
      guards), lifecycle-clean (onSpawned/onKilled/rename clear `pendingAnchor`); `reanchor` writes
      `.tachyon/roles/<agent>.md` + `sendKeys(reminder, true)`.
- [x] 8. **Manual path**: `reanchor_agent` Bridge tool (21 tools) + "Re-anchor Role" palette command
      + `^agent-running-ai` menu; shared `reanchor()`; i18n (en+pt-br).
- [x] 9. **Docs**: README "Instructions — agents as roles" expanded — role templates, Bridge
      guidance, the opt-in re-anchor + the claude/codex-only runtime gap.
- [x] 10. **codex dueto** — round 1 NO-SHIP (3 MAJOR Part-C safety: kind-gating of detection/reanchor,
      pendingAnchor lifecycle leak + 3 MINOR: `-ai` regex, role-kind-terminal, pt-br) → fixed; round 2
      NO-SHIP (1 MINOR: rename didn't transfer pendingAnchor) → fixed; round 3 **SHIP** (no findings,
      Part C gate verified idle-only/once/off-by-default/agent-only/lifecycle-clean).

## Notes
- Decisions D-A…D-D locked 2026-06-14 (see spec.md). Part C auto is OFF by default.
- Context-engineering framing throughout — NOT persona prompting (feedback_no_persona_role_prompting).
- Runtime-aware detection; non-claude/codex runtimes are a documented gap, not a silent no-op.
- 466 unit tests + typecheck green; full suite safe with `$TMUX` set (spec 218 guard).
