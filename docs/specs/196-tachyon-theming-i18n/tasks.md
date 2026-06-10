# 196 — tachyon-theming-i18n — tasks

_Generated from `plan.md` on 2026-06-10. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. formLogic → stable issue codes + boundary mapping (issueMessage)
- [x] 2. l10n.t wrapping: extension.ts (~43 strings) + Sidebar.ts (22 strings)
- [x] 3. AgentForm: studioStrings payload, codicons (build copy + CSP), full token CSS
- [x] 4. l10n bundle pt-BR (116) + package.nls en/pt-BR + %key% contributions + vsix shipping
- [x] 5. Drift-guard tests (completeness, placeholders, %keys%) + mock l10n + live nls-resolution assert
- [x] 6. README + dogfood (display-language switch walkthrough)

## Verification

_Acceptance checks tied to `spec.md` acceptance criteria. Each one should map to a checklist item there._

- [x] All spec 196 acceptance boxes verified (unit guards + live integration; visual via dogfood)
- [x] Full suite green: typecheck, build, 129/129 vitest, 16-passing xvfb integration

**Verify:** `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'`

## Notes

_Anything that came up during execution that doesn't belong in plan.md but is useful for the PR description or future readers._
