# 191 — tachyon-bridge-auth — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. token.ts (stable per-workspace, 0600, constant-time match) + unit tests
- [x] 2. Bridge bearer gate (401 before any MCP processing) + live-HTTP unit tests (no/wrong/right token, opt-out)
- [x] 3. settings.auth in loader/schema + tests
- [x] 4. AgentManager getExtraEnv injection (declared env wins) + tests
- [x] 5. Auth-aware adapters (env-var refs, no literal secrets, upToDate semantics) + tests
- [x] 6. extension wiring: early auth resolve, token from globalStorage, Copy Bridge Token, reload hint
- [x] 7. Host integration: 401 raw / clipboard-token pass
- [x] 8. Live E2E: claude -p via ${TACHYON_BRIDGE_TOKEN} expansion against tokened bridge-host
- [x] 9. Docs (README auth section, example) + dogfood prep

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 191 acceptance boxes verified (unit + integration + live E2E)
- [x] Full suite green: typecheck, build, 101/101 vitest, 12-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
