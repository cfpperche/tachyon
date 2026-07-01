# 307 — adhoc-nudge-policy — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-06-30: Claude probe `probe-36c17d66-72a1-4349-aaca-b93004d10b38` reviewed the plan and returned `NEEDS-REVISION`. Findings accepted:
  - Do not treat fork/worktree ad-hoc rows as automatically eligible; those fields mean isolation/durability mechanics, not user intent to receive persistence nudges.
  - Do not let a generic `transition:"manual"` bypass the policy. Only UI-origin manual reinjection should bypass suppression for ad-hoc rows.
  - Use one shared runtime-neutral eligibility helper, not separate ad-hoc checks in each nudge path.
- 2026-06-30: V1 policy is intentionally strict: automatic persistence nudges are allowed only for declared agents in `tachyon.yml`. Every ad-hoc row is default-off, including forks and worktree-backed rows.
- 2026-06-30: Re-anchor remains out of this spec. It is role anchoring, not continuity/project-handoff persistence nudging. If re-anchor is noisy for ad-hoc sessions, it should get a separate policy decision instead of being silently bundled into this fix.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The original draft tentatively allowed fork/worktree ad-hoc rows. Claude review rejected that heuristic; spec and plan were updated before implementation.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Chose no public schema/config field in this slice. A future opt-in should be explicit, but adding the field now would widen the scope beyond the observed bug.
- Chose a UI-origin option for `injectContinuity(..., "manual")` rather than changing the pure continuity classifier. The classifier still describes transition semantics; Workspace decides whether an ad-hoc session is allowed to receive that side effect.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Future opt-in shape remains open: possible names include `persistenceNudges`, `continuityNudges`, or a broader ad-hoc durability policy. It should be explicit and tested before enabling any ad-hoc class by default.

## Verification log

- 2026-06-30: `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts` passed: 2 files, 23 tests.
- 2026-06-30: `npm run typecheck` passed.

## Dogfood log

### 2026-07-01T02:46:46Z — pass (1/1) — source: tasks.md — commit: 1f16c12d6b2f1fe2d79b53588854ca418cce1a07
- `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts` — pass

### 2026-07-01T02:46:46Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/continuityWiring.test.ts test/unit/projectHandoff.test.ts` — pass
- `npm run typecheck` — pass
