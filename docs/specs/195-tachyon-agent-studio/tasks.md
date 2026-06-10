# 195 — tachyon-agent-studio — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. instructions field + per-runtime delivery (composeCommand/shellQuote) wired into spawn/restart; schema
- [x] 2. upsertAgent (full-def create/edit/rename, comments preserved)
- [x] 3. formLogic (flags/suggest/validate/toEntry/fromDef) + cliDetect (injectable)
- [x] 4. AgentForm webview (CSP, theme vars, message protocol) — logic-free by design
- [x] 5. extension: shared studioSubmit (sync; also _upsertAgent), ✚ → Studio, Edit Agent… context item, quick flow on palette
- [x] 6. Tests: 11 unit (quoting incl. hostile input, defaults-omission, round-trip) + live integration (pipeline create/duplicate/edit + Studio tab opens)
- [x] 7. README + dogfood

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 195 acceptance boxes verified (unit + live integration; HTML via dogfood)
- [x] Full suite green: typecheck, build, 126/126 vitest, 15-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
