# 454 — codex-canonical-parity — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Codex graceful stop was already `measured` and `verified` in `runtimeProfile`; the summary matrix
  was stale. This slice does not fabricate a second stop implementation.
- Permission metadata is canonical-profile scoped: the private-home writer owns the generated policy;
  arbitrary legacy Codex commands remain outside this guarantee.

## Evidence

- `codex-cli 0.145.0` accepted all declared `approval_policy` values (`untrusted`, `on-failure`,
  `on-request`, `never`) and `sandbox_mode` values (`read-only`, `workspace-write`,
  `danger-full-access`) under `codex exec --strict-config … --help` on 2026-07-25.
- Focused unit run: `test/unit/runtimeProfile.test.ts` and `test/unit/agentManager.test.ts` — 421
  passing tests. The latter includes `t-1a3d50`, which drives the same canonical private-home writer
  through fresh spawn, restart, and resume.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
