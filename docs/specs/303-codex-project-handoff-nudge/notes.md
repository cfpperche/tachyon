# 303 — codex-project-handoff-nudge — notes

- Pin `p-b26617` asks why Codex is not nudged to register project work in the Project Handoff while Claude is.
- Root cause found in code: `AgentManager.withSessionOwnership` skipped every non-Claude runtime, and the existing test asserted `codex: NOT injected`.
- Local Codex CLI facts checked on 2026-06-30:
  - `codex doctor` reports `Codex Doctor v0.142.4`.
  - `codex features list` reports `hooks stable true`.
  - Captured `SessionStart` stdin includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, and `source`.
- Local hook smokes:
  - `.codex/hooks.json` SessionStart stdout was visible to `codex exec`.
  - `-c hooks.SessionStart=[...]` SessionStart stdout was visible to `codex exec`.
  - `-c hooks.SessionStart=[...]` merged with project `.codex/hooks.json`; model saw both markers and replied `BOTH`.
  - Codex accepted Claude-style `{"hookSpecificOutput":{"additionalContext":"..."}}` and exposed the additional context to the model.
- Claude probe review `probe-393fb013-3cd7-4fd3-a82d-86c04f124ee0` flagged one material risk: `$TACHYON_AGENT_NAME` expansion had not been proven. Follow-up dogfood proved Codex hook commands run through a shell and wrote `agent:"codex-smoke"` rather than a literal `$TACHYON_AGENT_NAME`.
- Folded review improvement: `TACHYON_AGENT_NAME` now wins over user/caller env by being merged last in spawn/resume env, and unit coverage asserts the reserved value.

## Verification log

### 2026-06-30T23:40:34Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/codexBridge.test.ts && npx tsc --noEmit` — pass

## Dogfood log

### 2026-06-30T23:40:47Z — pass (1/1) — source: tasks.md — commit: 2c86adaa6680099b4aea762eb2b1eaab27cea7fe
- `tmp=$(mktemp -d /tmp/tachyon-codex-hook-dogfood-XXXXXX); mkdir -p "$tmp/.codex"; printf '%s\n' '{"hooks":{"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"printf PROJECT_HOOK_CONTEXT","statusMessage":"project"}]}]}}' > "$tmp/.codex/hooks.json"; out="$tmp/out.txt"; (cd "$tmp" && codex exec --skip-git-repo-check --enable hooks --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command="printf FLAG_HOOK_CONTEXT",statusMessage="flag"}]}]' --output-last-message "$out" 'Reply BOTH if PROJECT_HOOK_CONTEXT and FLAG_HOOK_CONTEXT are visible, otherwise reply FAIL.') >/dev/null 2>&1; test "$(cat "$out")" = BOTH; rc=$?; rm -rf "$tmp"; exit "$rc"` — pass

### 2026-06-30T23:44:14Z — fail (0/1) — source: tasks.md — commit: 2c86adaa6680099b4aea762eb2b1eaab27cea7fe
- `tmp=$(mktemp -d /tmp/tachyon-codex-hook-dogfood-XXXXXX); mkdir -p "$tmp/.codex"; printf '%s\n' '{"hooks":{"SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"printf PROJECT_HOOK_CONTEXT","statusMessage":"project"}]}]}}' > "$tmp/.codex/hooks.json"; out="$tmp/out.txt"; agent_file="$tmp/agent.txt"; (cd "$tmp" && TACHYON_AGENT_NAME=codex-dogfood codex exec --skip-git-repo-check --enable hooks --dangerously-bypass-hook-trust -c "hooks.SessionStart=[{matcher=\"startup|resume|clear|compact\",hooks=[{type=\"command\",command=\"printf \\\"\\$TACHYON_AGENT_NAME\\\" > \\\"$agent_file\\\"; printf FLAG_HOOK_CONTEXT\",statusMessage=\"flag\"}]}]" --output-last-message "$out" 'Reply BOTH if PROJECT_HOOK_CONTEXT and FLAG_HOOK_CONTEXT are visible, otherwise reply FAIL.') >/dev/null 2>&1; test "$(cat "$out")" = BOTH && test "$(cat "$agent_file")" = codex-dogfood; rc=$?; rm -rf "$tmp"; exit "$rc"` — fail

### 2026-06-30T23:45:34Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/codexBridge.test.ts && npx tsc --noEmit` — pass

### 2026-06-30T23:45:38Z — pass (1/1) — source: tasks.md — commit: 2c86adaa6680099b4aea762eb2b1eaab27cea7fe
- `tmp=$(mktemp -d /tmp/tachyon-codex-hook-dogfood-XXXXXX); mkdir -p "$tmp/.codex"; out="$tmp/out.txt"; agent_file="$tmp/agent.txt"; node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({hooks:{SessionStart:[{matcher:"startup|resume|clear|compact",hooks:[{type:"command",command:"printf PROJECT_HOOK_CONTEXT"},{type:"command",command:"printf \"$TACHYON_AGENT_NAME\" > \""+process.argv[2]+"\""}]}]}}));' "$tmp/.codex/hooks.json" "$agent_file"; (cd "$tmp" && TACHYON_AGENT_NAME=codex-dogfood codex exec --skip-git-repo-check --enable hooks --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command="printf FLAG_HOOK_CONTEXT",statusMessage="flag"}]}]' --output-last-message "$out" 'Reply BOTH if PROJECT_HOOK_CONTEXT and FLAG_HOOK_CONTEXT are visible, otherwise reply FAIL.') >/dev/null 2>&1; test "$(cat "$out")" = BOTH && test "$(cat "$agent_file")" = codex-dogfood; rc=$?; rm -rf "$tmp"; exit "$rc"` — pass
