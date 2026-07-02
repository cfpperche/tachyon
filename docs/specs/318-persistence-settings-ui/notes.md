# 318 — persistence-settings-ui — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-07-01 — Chosen surface is workspace-level: sidebar Agents/Terminals header action plus hook-health badge routing
  into a VS Code QuickPick. This keeps a two-state setting discoverable without creating a new settings panel.
- 2026-07-01 — Re-enable removes `settings.persistence.silentHooks` instead of writing `true`; default behavior remains
  canonical and existing config stays small.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Per-agent override was deferred. It may be useful later, but mixing workspace and agent policy in one pass would make
  health badges harder to interpret and risks hidden partial support.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T01:50:57Z — pass (2/2) — source: tasks.md
- `npm test -- test/unit/yamlEditor.test.ts` — pass
- `npm run typecheck` — pass
