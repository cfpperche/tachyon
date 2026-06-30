# 303 — codex-project-handoff-nudge — tasks

_Generated from `plan.md` on 2026-06-30._

## Implementation

- [x] Add a pure Codex SessionStart hook config builder that reuses the Tachyon ownership recorder and handoff pointer scripts.
- [x] Add a HarnessManager materializer that writes those scripts and returns the Codex `hooks.SessionStart` override.
- [x] Inject the Codex hook override at spawn/resume without touching `.codex/hooks.json`.
- [x] Set `TACHYON_AGENT_NAME` for spawned/resumed sessions so the Codex recorder can attribute rows.
- [x] Preserve Claude `--settings` behavior and existing user hook behavior.

## Verification

- [x] Unit tests cover config insertion, materialization, and spawn/env behavior.
- [x] Typecheck passes.
- [x] A headless Codex hook smoke proves local Codex sees SessionStart hook context and that `-c` hooks merge with `.codex/hooks.json`.

**Headless check:** `npm test -- --run test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/codexBridge.test.ts && npx tsc --noEmit`

**Verify:** `npm test -- --run test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/codexBridge.test.ts && npx tsc --noEmit`

## Dogfood

**Dogfood:** `tmp=$(mktemp -d /tmp/tachyon-codex-hook-dogfood-XXXXXX); mkdir -p "$tmp/.codex"; out="$tmp/out.txt"; agent_file="$tmp/agent.txt"; node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({hooks:{SessionStart:[{matcher:"startup|resume|clear|compact",hooks:[{type:"command",command:"printf PROJECT_HOOK_CONTEXT"},{type:"command",command:"printf \"$TACHYON_AGENT_NAME\" > \""+process.argv[2]+"\""}]}]}}));' "$tmp/.codex/hooks.json" "$agent_file"; (cd "$tmp" && TACHYON_AGENT_NAME=codex-dogfood codex exec --skip-git-repo-check --enable hooks --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command="printf FLAG_HOOK_CONTEXT",statusMessage="flag"}]}]' --output-last-message "$out" 'Reply BOTH if PROJECT_HOOK_CONTEXT and FLAG_HOOK_CONTEXT are visible, otherwise reply FAIL.') >/dev/null 2>&1; test "$(cat "$out")" = BOTH && test "$(cat "$agent_file")" = codex-dogfood; rc=$?; rm -rf "$tmp"; exit "$rc"`

**Human dogfood:** Install the packaged VSIX, reload the extension host, start/restart a Codex agent in a workspace with a non-empty Project Handoff, and confirm the startup context nudges it to read `get_project_handoff`.
