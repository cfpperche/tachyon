# 451 — pi-canonical-exact-trust — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Exact mode skips validation/copying of the ambient trust source entirely. Canonical trust authority
  comes from the launch boundary, so malformed or unrelated ambient trust must not block or influence it.
- Workspace and cwd are canonicalized with `realpathSync` before deduplication, matching Pi's native
  canonical-path lookup and failing closed if a launch path does not exist.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

None.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- The existing same-directory atomic writer gained an optional creation mode so exact trust is staged
  as `0600` before rename. Other callers retain their prior mode behavior.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None.

## Dogfood evidence

- Runtime: Pi 0.80.10, offline mode, telemetry disabled.
- Fixture: disposable workspace plus child project containing `.pi/settings.json`.
- Materialization: the production `HarnessManager.materializePiHomeOnly` writer emitted exactly the
  canonical workspace and child cwd, both `true`.
- Result: Pi entered the normal authenticated TUI directly. No project-trust prompt appeared and no
  prompt was auto-answered. The session exited without model interaction.

## Verification log

- Focused: 5 passed (`harness.test.ts` + `agentManager.test.ts`).
- Typecheck: passed.
- Full pre-commit gate: 514 files passed; 5739 tests passed, 4 skipped.
