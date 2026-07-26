# 469 — runtime-config-dropdown — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Use the existing Radix-backed Kit dropdown so icon-bearing options do not trade away keyboard and
  focus behavior. Runtime Config supplies scoped CSS because its route does not load Agent Studio's
  or Plugins' Tailwind sheets.

## Deviations

- Visual QA could not render the inventory because the pre-existing preview fixture never injects
  `runtimeConfigSnapshot`. The defect is tracked as `t-80d367`; validation `v-45d903` carries the
  equivalent installed-VSIX check instead of claiming an unobserved visual pass.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-26T15:49:37Z — pass (3/3) — source: tasks.md
- `npx vitest run test/unit/runtimeConfigDropdown.test.ts` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
