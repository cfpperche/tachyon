# 228 — tachyon-harness-skills-rules-hooks — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Step 1 — capability research — DONE (2026-06-16, live)
- [x] hooks → `<home>/settings.json` fires; rules → `<home>/CLAUDE.md` loads; skills → `<home>/skills/<n>/SKILL.md` resolves.
- [x] All auto-loaded from CLAUDE_CONFIG_DIR → no new spawn args.

## Step 2 — implementation — DONE 2026-06-16
- [x] `loadConfig` — `HarnessDef` gained `hooks?`/`rules?`/`skills?`; `mcp` now optional; at-least-one
      required; `global` still rejected. Mirrored in `tachyon.schema.json`.
- [x] `HarnessManager.materialize` — `<home>/CLAUDE.md` (concat rules, headered, fail-closed on missing),
      skill dirs copied → `<home>/skills/<basename>/` (rebuilt each spawn), `hooks` merged into
      `<home>/settings.json`. `--mcp-config`/`--strict` args added only when `mcp` is declared.
- [x] Example: `researcher` gains `rules: ["rules/researcher.md"]` (+ the file); README/schema updated.

## Tests — DONE (567 unit + typecheck + build green)
- [x] `loadConfig` — hooks/rules/skills parse; mcp optional; rules-only accepted; empty harness rejected;
      bad shapes rejected; `global` still rejected (removed the obsolete 226 "not-yet-built" test).
- [x] materialize — CLAUDE.md (concat+headers); skill dir copied; hooks into settings.json; rules-only
      (no mcp.json, no mcp args); missing rules/skill path fails closed.

**Decision:** at least one of mcp/skills/rules/hooks (mcp no longer required).

## Follow pass
- `inherit: global` (seed personal skills/hooks/settings from ~/.claude); plugin-dir.
