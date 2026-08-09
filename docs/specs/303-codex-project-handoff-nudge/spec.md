# 303 — codex-project-handoff-nudge

_Created 2026-06-30._

**Status:** shipped

**Closure:** Shipped 2026-06-30. Codex agents now get the same Tachyon SessionStart ownership + Project Handoff pointer as Claude via a session-scoped `-c hooks.SessionStart=...` override. The change preserves user `.codex/hooks.json`, keeps Claude `--settings` behavior unchanged, and records exact ownership through `TACHYON_AGENT_NAME`. Validation: Claude probe review folded, focused tests + `tsc`, SDD verify, SDD dogfood, and full `npm test && npx tsc --noEmit` passed.
**Verify:** `npm test -- --run test/unit/sessionOwners.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/codexBridge.test.ts && npx tsc --noEmit`
**Dogfood:** `tmp=$(mktemp -d /tmp/tachyon-codex-hook-dogfood-XXXXXX); mkdir -p "$tmp/.codex"; out="$tmp/out.txt"; agent_file="$tmp/agent.txt"; node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({hooks:{SessionStart:[{matcher:"startup|resume|clear|compact",hooks:[{type:"command",command:"printf PROJECT_HOOK_CONTEXT"},{type:"command",command:"printf \"$TACHYON_AGENT_NAME\" > \""+process.argv[2]+"\""}]}]}}));' "$tmp/.codex/hooks.json" "$agent_file"; (cd "$tmp" && TACHYON_AGENT_NAME=codex-dogfood codex exec --skip-git-repo-check --enable hooks --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[{matcher="startup|resume|clear|compact",hooks=[{type="command",command="printf FLAG_HOOK_CONTEXT",statusMessage="flag"}]}]' --output-last-message "$out" 'Reply BOTH if PROJECT_HOOK_CONTEXT and FLAG_HOOK_CONTEXT are visible, otherwise reply FAIL.') >/dev/null 2>&1; test "$(cat "$out")" = BOTH && test "$(cat "$agent_file")" = codex-dogfood; rc=$?; rm -rf "$tmp"; exit "$rc"`

## Intent

Pin `p-b26617` reports that Claude agents are nudged to read/update the shared Project Handoff, while Codex agents are not. The root cause is not the Bridge handoff tools themselves: `get_project_handoff` and friends are runtime-neutral. The missing piece is the spawn-time `SessionStart` hook that Tachyon injects for Claude via `--settings`; that hook materializes both the session-ownership recorder and the Project Handoff pointer. Codex was explicitly excluded because older work treated `--settings` as Claude-only and did not revisit Codex's native hooks.

Done means a Tachyon-spawned Codex agent gets the same startup nudge as Claude when a Project Handoff exists, without overwriting user `.codex/hooks.json`, without disabling user hooks, and while preserving the session-ownership ledger behavior needed after `/clear` or resume rotations in shared cwd.

## Acceptance criteria

- [x] **Scenario: Codex receives a Project Handoff SessionStart pointer**
  - **Given** a workspace has a non-empty Project Handoff
  - **When** Tachyon spawns or resumes a Codex agent
  - **Then** the Codex command includes a session-scoped `hooks.SessionStart` override that runs the Tachyon handoff pointer script
- [x] **Scenario: Codex session ownership is recorded positively**
  - **Given** a Tachyon-spawned Codex agent starts, resumes, or clears into a new session
  - **When** Codex runs the injected `SessionStart` hook
  - **Then** the existing `.tachyon/activity/session-owners.jsonl` recorder can append a row for the exact Tachyon agent via `TACHYON_AGENT_NAME`
- [x] **Scenario: User Codex hooks are preserved**
  - **Given** the workspace or user already has Codex hooks
  - **When** Tachyon injects its session-scoped hook
  - **Then** the injected hook is additive and does not require Tachyon to edit `.codex/hooks.json`
- [x] Claude `--settings` injection behavior remains unchanged.
- [x] Non-Codex/non-Claude runtimes remain unchanged.
- [x] The implementation is covered by unit tests and a headless Codex hook smoke.

## Non-goals

- Do not add general Codex rules/skills/hooks parity to `harness:`; spec 298 deliberately left that as a broader follow-up.
- Do not rewrite or merge user-managed `.codex/hooks.json`.
- Do not bypass Codex hook trust globally with `--dangerously-bypass-hook-trust` in normal Tachyon spawns.
- Do not change the Project Handoff MCP tool schema.

## Open questions

- Answered: Codex CLI `0.142.4` supports stable hooks and `SessionStart` hook stdout is model-visible.
- Answered: a `-c hooks.SessionStart=...` override merges with `.codex/hooks.json`; it does not replace user hooks.
- Answered: Codex accepts Claude-style `hookSpecificOutput.additionalContext` JSON, so the existing handoff pointer script can be reused.
